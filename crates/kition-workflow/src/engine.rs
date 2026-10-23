//! Running workflows: the graph executor, per-type action runners, email
//! delivery (through a saved connection or the configured SMTP account), and
//! the record-event runner.

use std::collections::HashMap;
use std::sync::Arc;

use kition_connections::smtp::{self, Message, SmtpConfig};
use kition_core::events::{DomainEvent, EventBus};
use kition_core::{Millis, now_millis};
use kition_store::Db;
use serde_json::{Map, Value, json};

use crate::expr;
use crate::gofmt::{go_json, stringify_value};
use crate::store::{Dedup, RunHistory, Store, record_dedup_key};
use crate::template::{
    self, by_field_id, equal_lookup_value, record_field_value, render, stringify_record_values,
};
use crate::types::*;
use crate::validate::topo_sort;

pub const RECORD_CREATED_TOPIC: &str = "record.created";
pub const RECORD_UPDATED_TOPIC: &str = "record.updated";

/// A table row as seen by workflows.
#[derive(Debug, Clone, Default)]
pub struct RecordView {
    pub id: String,
    pub fields: Map<String, Value>,
    pub created_at: Millis,
}

/// Table access backed by data documents. Calls block.
pub trait Tables: Send + Sync + 'static {
    fn schema(
        &self,
        user_id: i64,
        document_path: &str,
        table_id: &str,
    ) -> Result<TableSchema, String>;
    fn records(
        &self,
        user_id: i64,
        document_path: &str,
        table_id: &str,
    ) -> Result<Vec<RecordView>, String>;
    fn create_record(
        &self,
        user_id: i64,
        document_path: &str,
        table_id: &str,
        values: &Map<String, Value>,
    ) -> Result<String, String>;
    fn update_record(
        &self,
        user_id: i64,
        document_path: &str,
        table_id: &str,
        record_id: &str,
        values: &Map<String, Value>,
    ) -> Result<Map<String, Value>, String>;
}

/// The configured SMTP account used when an email action has no connection.
#[derive(Debug, Clone, Default)]
pub struct LegacySmtp {
    pub host: String,
    pub port: i64,
    pub username: String,
    pub password: String,
    pub from: String,
    pub from_name: String,
    pub tls_mode: String,
    pub proxy: String,
}

impl LegacySmtp {
    /// Sends one message; errors are user-facing text.
    pub async fn send(&self, to: &str, subject: &str, body: &str) -> Result<(), String> {
        if self.host.trim().is_empty() {
            return Err("smtp host not configured".into());
        }
        let from = self.from.trim();
        if from.is_empty() {
            return Err("smtp from not configured".into());
        }
        if to.trim().is_empty() {
            return Err("email recipient not configured".into());
        }
        let from_address =
            crate::mail::parse_address(from).map_err(|e| format!("smtp from invalid: {e}"))?;
        let to_address =
            crate::mail::parse_address(to).map_err(|e| format!("email recipient invalid: {e}"))?;
        let mode = match self.tls_mode.trim().to_lowercase().as_str() {
            "" | "starttls" => "starttls",
            "tls" | "ssl" | "implicit" => "tls",
            "none" | "plain" => "plain",
            _ => {
                return Err(format!(
                    "unsupported smtp tlsMode {}",
                    crate::gofmt::quote(&self.tls_mode)
                ));
            }
        };
        let config = SmtpConfig {
            host: self.host.clone(),
            port: u16::try_from(if self.port == 0 { 587 } else { self.port }).unwrap_or(587),
            username: self.username.clone(),
            password: self.password.clone(),
            from: from_address,
            from_name: self.from_name.clone(),
            tls_mode: mode.into(),
            proxy: self.proxy.clone(),
        };
        let message = Message {
            to: to_address,
            subject: subject.into(),
            body: body.into(),
        };
        smtp::send(&config, &message)
            .await
            .map_err(|e| e.to_string())
    }
}

/// Saved connections, for email actions that name one.
#[derive(Clone)]
pub struct Connections {
    pub db: Db,
    pub store: kition_connections::Store,
}

/// Per-run state: node outputs keyed by node ID.
#[derive(Debug, Clone, Default)]
pub struct RunContext {
    pub user_id: i64,
    pub record_id: String,
    pub document_path: String,
    pub table_id: String,
    pub outputs: Map<String, Value>,
}

impl RunContext {
    fn effective_user(&self) -> i64 {
        if self.user_id != 0 { self.user_id } else { 1 }
    }

    fn trigger_values(&self, def: &WorkflowDefinition) -> HashMap<String, String> {
        self.outputs
            .get(&def.trigger.node_id)
            .and_then(Value::as_object)
            .map(|out| {
                out.iter()
                    .map(|(k, v)| (k.clone(), stringify_value(v)))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Default)]
pub struct ActionResult {
    pub status: String,
    pub to: String,
    pub subject: String,
    pub body: String,
    pub error_code: String,
    pub error: String,
    pub output: Option<Map<String, Value>>,
    pub connection_id: String,
}

fn action_error(message: impl Into<String>) -> ActionResult {
    ActionResult {
        status: "error".into(),
        error: message.into(),
        ..Default::default()
    }
}

fn ok_output(output: Value) -> ActionResult {
    ActionResult {
        status: "ok".into(),
        output: output.as_object().cloned(),
        ..Default::default()
    }
}

/// Shared runtime: storage, tables, and delivery.
pub struct Engine {
    pub store: Arc<Store>,
    pub runs: Arc<RunHistory>,
    pub tables: Option<Arc<dyn Tables>>,
    pub connections: Option<Connections>,
    pub legacy_smtp: LegacySmtp,
    /// When set, `record_created` triggers with required fields fire once
    /// per record (on the first update that fills them).
    pub record_dedup: Option<Arc<Dedup>>,
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Engine {
    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(&dyn Tables) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let Some(tables) = self.tables.clone() else {
            return Err("workflow: record operations not configured".into());
        };
        tokio::task::spawn_blocking(move || work(tables.as_ref()))
            .await
            .map_err(|e| e.to_string())?
    }

    pub async fn schema(
        &self,
        user_id: i64,
        document_path: &str,
        table_id: &str,
    ) -> Result<TableSchema, String> {
        let (doc, table) = (document_path.to_owned(), table_id.to_owned());
        self.blocking(move |t| t.schema(user_id, &doc, &table))
            .await
    }

    /// Every record of a table.
    pub async fn records(
        &self,
        user_id: i64,
        document_path: &str,
        table_id: &str,
    ) -> Result<Vec<RecordView>, String> {
        let (doc, table) = (document_path.to_owned(), table_id.to_owned());
        self.blocking(move |t| t.records(user_id, &doc, &table))
            .await
    }

    /// Runs the workflow graph and summarizes it as a run record.
    #[allow(clippy::too_many_arguments)]
    pub async fn execute(
        &self,
        def: &WorkflowDefinition,
        trigger_event: &str,
        user_id: i64,
        record_id: &str,
        document_path: &str,
        table_id: &str,
        trigger_fields: Option<Map<String, Value>>,
    ) -> RunRecord {
        let mut rt = RunContext {
            user_id,
            record_id: record_id.into(),
            document_path: document_path.into(),
            table_id: table_id.into(),
            outputs: Map::new(),
        };
        let schema = if !document_path.is_empty() && !table_id.is_empty() {
            self.schema(user_id, document_path, table_id)
                .await
                .unwrap_or_default()
        } else {
            TableSchema::default()
        };
        let raw = trigger_fields.clone().unwrap_or_default();
        let mut trigger_out = raw.clone();
        let resolved = by_field_id(&raw, &schema.fields);
        for field in &schema.fields {
            if let Some(value) = resolved.get(&field.id) {
                trigger_out.insert(field.id.clone(), value.clone());
                trigger_out.insert(field.name.clone(), value.clone());
            }
        }
        let (nodes, edges) = def.nodes_and_edges();
        for node in nodes.iter().filter(|n| n.kind == KIND_TRIGGER) {
            rt.outputs
                .insert(node.node_id.clone(), Value::Object(trigger_out.clone()));
        }
        let order = match topo_sort(&nodes, &edges) {
            Ok(order) => order,
            Err(err) => {
                let now = now_millis();
                return RunRecord {
                    id: new_id(),
                    workflow_id: def.id.clone(),
                    trigger_event: trigger_event.into(),
                    record_id: record_id.into(),
                    started_at: now,
                    finished_at: now,
                    status: "error".into(),
                    error: err,
                    ..Default::default()
                };
            }
        };
        let mut run = RunRecord {
            id: new_id(),
            workflow_id: def.id.clone(),
            trigger_event: trigger_event.into(),
            record_id: record_id.into(),
            document_path: document_path.into(),
            table_id: table_id.into(),
            user_id,
            trigger_fields,
            started_at: now_millis(),
            ..Default::default()
        };
        let mut outcomes: Vec<NodeOutcome> = Vec::with_capacity(order.len());
        let pending = |done: &[NodeOutcome], rest: &[NodeConfig]| -> Vec<NodeOutcome> {
            let mut out = done.to_vec();
            out.extend(rest.iter().map(|n| NodeOutcome {
                node_id: n.node_id.clone(),
                kind: n.kind.clone(),
                status: "pending".into(),
                ..Default::default()
            }));
            out
        };
        for (index, node) in order.iter().enumerate() {
            let mut outcome = NodeOutcome {
                node_id: node.node_id.clone(),
                kind: node.kind.clone(),
                started_at: now_millis(),
                ..Default::default()
            };
            match node.kind.as_str() {
                KIND_TRIGGER => outcome.status = "ok".into(),
                KIND_FILTER => match eval_filter(node, &rt) {
                    Err((detail, err)) => {
                        outcome.status = "error".into();
                        outcome.detail = detail;
                        outcome.error = err.clone();
                        outcome.finished_at = now_millis();
                        outcomes.push(outcome);
                        run.node_outcomes = pending(&outcomes, &order[index + 1..]);
                        return fail_run(run, &node.node_id, &err);
                    }
                    Ok((false, detail)) => {
                        outcome.status = "skipped".into();
                        outcome.detail = detail;
                        outcome.finished_at = now_millis();
                        outcomes.push(outcome);
                        run.node_outcomes = pending(&outcomes, &order[index + 1..]);
                        run.status = "skipped".into();
                        run.skip_reason = format!("Filter {} evaluated to false", node.node_id);
                        run.finished_at = now_millis();
                        return run;
                    }
                    Ok((true, detail)) => {
                        outcome.status = "ok".into();
                        outcome.detail = detail;
                    }
                },
                KIND_ACTION => {
                    let mut action: ActionConfig = match config_of(node) {
                        Ok(action) => action,
                        Err(err) => {
                            outcome.status = "error".into();
                            outcome.error = err.to_string();
                            outcome.finished_at = now_millis();
                            outcomes.push(outcome);
                            run.node_outcomes = pending(&outcomes, &order[index + 1..]);
                            return fail_run(run, &node.node_id, &err.to_string());
                        }
                    };
                    if action.node_id.is_empty() {
                        action.node_id = node.node_id.clone();
                    }
                    let result = self.run_action(def, &action, &rt).await;
                    outcome.status = result.status.clone();
                    outcome.error = result.error.clone();
                    outcome.finished_at = now_millis();
                    if result.status != "ok" {
                        outcomes.push(outcome);
                        run.node_outcomes = pending(&outcomes, &order[index + 1..]);
                        run.status = "error".into();
                        run.error = result.error;
                        run.error_code = result.error_code;
                        run.failing_node_id = node.node_id.clone();
                        for (field, value) in [
                            (&mut run.to, result.to),
                            (&mut run.subject, result.subject),
                            (&mut run.body, result.body),
                            (&mut run.connection_id, result.connection_id),
                        ] {
                            if !value.is_empty() {
                                *field = value;
                            }
                        }
                        run.finished_at = now_millis();
                        return run;
                    }
                    if let Some(output) = &result.output {
                        let output = Value::Object(output.clone());
                        outcome.detail = go_json(&output);
                        rt.outputs.insert(node.node_id.clone(), output);
                    }
                    if run.to.is_empty() && !result.to.is_empty() {
                        run.to = result.to;
                        run.subject = result.subject;
                        run.body = result.body;
                        run.connection_id = result.connection_id;
                    }
                    outcomes.push(outcome);
                    continue;
                }
                _ => {}
            }
            if outcome.finished_at == 0 {
                outcome.finished_at = now_millis();
                outcomes.push(outcome);
            }
        }
        run.status = "ok".into();
        run.node_outcomes = outcomes;
        run.finished_at = now_millis();
        run
    }

    /// Dispatches one action node by type.
    pub async fn run_action(
        &self,
        def: &WorkflowDefinition,
        action: &ActionConfig,
        rt: &RunContext,
    ) -> ActionResult {
        match action.action_type.as_str() {
            "add_record" => self.add_record(def, action, rt).await,
            "update_record" => self.update_record_action(def, action, rt).await,
            "lookup_record" => self.lookup_record(def, action, rt).await,
            "transform_record" => self.transform_record(def, action, rt).await,
            _ => {
                let mut legacy = def.clone();
                legacy.action = action.clone();
                let fields = rt
                    .outputs
                    .get(&def.trigger.node_id)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let delivered = self
                    .deliver(
                        &legacy,
                        &DeliveryEvent {
                            user_id: rt.user_id,
                            document_path: rt.document_path.clone(),
                            table_id: rt.table_id.clone(),
                            record_id: rt.record_id.clone(),
                            fields,
                        },
                    )
                    .await;
                let mut result = ActionResult {
                    status: delivered.status.clone(),
                    to: delivered.to.clone(),
                    subject: delivered.subject.clone(),
                    body: delivered.body.clone(),
                    error_code: delivered.error_code.clone(),
                    error: delivered.error.clone(),
                    connection_id: delivered.connection_id.clone(),
                    output: None,
                };
                if delivered.status == "ok" {
                    result.output = json!({"messageId": delivered.id, "to": delivered.to, "subject": delivered.subject}).as_object().cloned();
                }
                result
            }
        }
    }

    async fn add_record(
        &self,
        def: &WorkflowDefinition,
        action: &ActionConfig,
        rt: &RunContext,
    ) -> ActionResult {
        let Some(cfg) = &action.add_record else {
            return action_error("add_record action missing addRecord config");
        };
        if self.tables.is_none() {
            return action_error("add_record runner: RecordWriter not configured");
        }
        let table_id = cfg.target_table_id.trim().to_owned();
        if table_id.is_empty() {
            return action_error("add_record action missing targetTableId");
        }
        let trigger_table = def.trigger.table_id.trim();
        if !trigger_table.is_empty() && trigger_table == table_id {
            return action_error(
                "add_record refused: target table equals trigger table (would loop)",
            );
        }
        let values = rt.trigger_values(def);
        let mut rendered = Map::new();
        for field in cfg.fields.iter() {
            let (text, missing) = render(&field.value, &values);
            if !missing.is_empty() {
                tracing::warn!(workflow = %def.id, ?missing, "workflow: add_record missing template fields");
            }
            rendered.insert(field.field_id.clone(), Value::String(text));
        }
        let document_path = match cfg.target_document_path.trim() {
            "" => def.trigger.document_path.trim().to_owned(),
            doc => doc.to_owned(),
        };
        let user_id = rt.effective_user();
        let (doc, table, values) = (document_path.clone(), table_id.clone(), rendered.clone());
        match self
            .blocking(move |t| t.create_record(user_id, &doc, &table, &values))
            .await
        {
            Err(err) => action_error(err),
            Ok(record_id) => ok_output(
                json!({"recordId": record_id, "tableId": table_id, "documentPath": document_path, "values": rendered}),
            ),
        }
    }

    async fn update_trigger_record(
        &self,
        def: &WorkflowDefinition,
        rt: &RunContext,
        values: Map<String, Value>,
        action_type: &str,
    ) -> ActionResult {
        if values.is_empty() {
            return ok_output(json!({"changed": false, "values": values}));
        }
        let current = rt
            .outputs
            .get(&def.trigger.node_id)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let changed: Map<String, Value> = values
            .iter()
            .filter(|(field, value)| {
                current
                    .get(*field)
                    .is_none_or(|existing| !equal_lookup_value(existing, value))
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if changed.is_empty() {
            return ok_output(json!({"changed": false, "values": values}));
        }
        let user_id = rt.effective_user();
        let (doc, table, record, update) = (
            def.trigger.document_path.clone(),
            def.trigger.table_id.clone(),
            rt.record_id.clone(),
            changed.clone(),
        );
        match self
            .blocking(move |t| t.update_record(user_id, &doc, &table, &record, &update))
            .await
        {
            Err(err) => action_error(err),
            Ok(updated) => ok_output(json!({
                "actionType": action_type,
                "recordId": rt.record_id,
                "tableId": def.trigger.table_id,
                "documentPath": def.trigger.document_path,
                "changed": true,
                "values": changed,
                "record": updated,
            })),
        }
    }

    async fn update_record_action(
        &self,
        def: &WorkflowDefinition,
        action: &ActionConfig,
        rt: &RunContext,
    ) -> ActionResult {
        let Some(cfg) = &action.update_record else {
            return action_error("update_record action missing updateRecord config");
        };
        if rt.record_id.trim().is_empty() {
            return action_error("update_record requires a trigger record");
        }
        if self.tables.is_none() {
            return action_error("update_record runner: RecordUpdater not configured");
        }
        let values = rt.trigger_values(def);
        let rendered = cfg
            .fields
            .iter()
            .map(|f| {
                (
                    f.field_id.clone(),
                    Value::String(render(&f.value, &values).0),
                )
            })
            .collect();
        self.update_trigger_record(def, rt, rendered, "update_record")
            .await
    }

    async fn lookup_record(
        &self,
        def: &WorkflowDefinition,
        action: &ActionConfig,
        rt: &RunContext,
    ) -> ActionResult {
        let Some(cfg) = &action.lookup_record else {
            return action_error("lookup_record action missing lookupRecord config");
        };
        if rt.record_id.trim().is_empty() {
            return action_error("lookup_record requires a trigger record");
        }
        if self.tables.is_none() {
            return action_error("lookup_record runner: record operations not configured");
        }
        let document_path = match cfg.target_document_path.trim() {
            "" => def.trigger.document_path.clone(),
            doc => doc.to_owned(),
        };
        let table_id = cfg.target_table_id.trim().to_owned();
        if table_id.is_empty() || cfg.match_field_id.trim().is_empty() {
            return action_error("lookup_record requires targetTableId and matchFieldId");
        }
        let match_value = render(&cfg.match_value, &rt.trigger_values(def)).0;
        let user_id = rt.effective_user();
        let (doc, table) = (document_path.clone(), table_id.clone());
        let records = match self
            .blocking(move |t| t.records(user_id, &doc, &table))
            .await
        {
            Ok(records) => records,
            Err(err) => return action_error(err),
        };
        let schema = self
            .schema(user_id, &document_path, &table_id)
            .await
            .unwrap_or_default();
        let wanted = Value::String(match_value.clone());
        let matched = records.iter().find(|record| {
            record_field_value(&record.fields, &schema.fields, &cfg.match_field_id)
                .is_some_and(|v| equal_lookup_value(&v, &wanted))
        });
        let Some(matched) = matched else {
            return ok_output(
                json!({"matched": false, "matchValue": match_value, "tableId": table_id}),
            );
        };
        let mut write_back = Map::new();
        for mapping in cfg.write_back.iter() {
            if let Some(value) =
                record_field_value(&matched.fields, &schema.fields, &mapping.source_field_id)
            {
                write_back.insert(mapping.target_field_id.clone(), value);
            }
        }
        let mut result = self
            .update_trigger_record(def, rt, write_back, "lookup_record")
            .await;
        if result.status == "ok"
            && let Some(output) = result.output.as_mut()
        {
            output.insert("matched".into(), Value::Bool(true));
            output.insert("matchedRecordId".into(), Value::String(matched.id.clone()));
            output.insert("matchValue".into(), Value::String(match_value));
        }
        result
    }

    async fn transform_record(
        &self,
        def: &WorkflowDefinition,
        action: &ActionConfig,
        rt: &RunContext,
    ) -> ActionResult {
        let Some(cfg) = &action.transform_record else {
            return action_error("transform_record action missing transformRecord config");
        };
        if rt.record_id.trim().is_empty() {
            return action_error("transform_record requires a trigger record");
        }
        let values = rt.trigger_values(def);
        let mut out = Map::new();
        for operation in cfg.operations.iter() {
            let source = render(&operation.source, &values).0;
            match template::apply_transform(&operation.operation, &source, &operation.argument) {
                Ok(value) => {
                    out.insert(operation.target_field_id.clone(), value);
                }
                Err(err) => return action_error(err),
            }
        }
        self.update_trigger_record(def, rt, out, "transform_record")
            .await
    }

    /// Delivers the email action for one record, through the named
    /// connection or the configured SMTP account.
    pub async fn deliver(&self, def: &WorkflowDefinition, event: &DeliveryEvent) -> RunRecord {
        let schema = self
            .schema(event.user_id, &event.document_path, &event.table_id)
            .await
            .unwrap_or_default();
        let values = stringify_record_values(&event.fields, &schema.fields);
        let (subject, subject_missing) = render(&def.action.subject, &values);
        let (body, body_missing) = render(&def.action.body, &values);
        if !subject_missing.is_empty() || !body_missing.is_empty() {
            tracing::warn!(workflow = %def.id, ?subject_missing, ?body_missing, "workflow: dispatch missing template fields");
        }
        let action_id = def.action.node_id.clone();
        let use_connection =
            !def.action.connection_id.trim().is_empty() && self.connections.is_some();
        let mut run = RunRecord {
            id: new_id(),
            workflow_id: def.id.clone(),
            trigger_event: RECORD_CREATED_TOPIC.into(),
            record_id: event.record_id.clone(),
            connection_id: if use_connection {
                def.action.connection_id.clone()
            } else {
                String::new()
            },
            started_at: now_millis(),
            to: def.action.to.clone(),
            subject: subject.clone(),
            body: body.clone(),
            ..Default::default()
        };
        let finish = |mut run: RunRecord, code: &str, error: Option<String>| {
            match error {
                Some(error) => {
                    run.status = "error".into();
                    run.error_code = code.into();
                    run.error = error;
                    run.failing_node_id = action_id.clone();
                }
                None => run.status = "ok".into(),
            }
            run.finished_at = now_millis();
            run
        };
        if def.action.action_type != "send_email" {
            let code = if use_connection {
                "channel_unsupported"
            } else {
                ""
            };
            return finish(
                run,
                code,
                Some(format!(
                    "unsupported action type: {}",
                    def.action.action_type
                )),
            );
        }
        let Some(connections) = self.connections.as_ref().filter(|_| use_connection) else {
            let result = self.legacy_smtp.send(&def.action.to, &subject, &body).await;
            return finish(run, "", result.err());
        };
        let (db, store, user_id, id) = (
            connections.db.clone(),
            connections.store.clone(),
            event.user_id,
            def.action.connection_id.clone(),
        );
        let found = db.run(move |conn| store.get(conn, user_id, &id)).await;
        let connection = match found {
            Err(err) => return finish(run, "connection_missing", Some(err.to_string())),
            Ok(None) => {
                return finish(
                    run,
                    "connection_missing",
                    Some("connection not found".into()),
                );
            }
            Ok(Some(connection)) => connection,
        };
        if connection.channel != kition_connections::store::CHANNEL_EMAIL_SMTP {
            return finish(
                run,
                "channel_unsupported",
                Some("connection channel does not support email".into()),
            );
        }
        let mark_invalid = |code: &'static str, message: String| {
            let (db, store, id) = (
                connections.db.clone(),
                connections.store.clone(),
                connection.id.clone(),
            );
            async move {
                let _ = db
                    .run(move |conn| {
                        store.mark_invalid(conn, user_id, &id, code, &message);
                        Ok(())
                    })
                    .await;
            }
        };
        let secrets = match connections.store.open_secrets(&connection) {
            Ok(secrets) => secrets,
            Err(err) => {
                mark_invalid("secret_unavailable", err.clone()).await;
                return finish(run, "secret_unavailable", Some(err));
            }
        };
        let message = Message {
            to: def.action.to.clone(),
            subject,
            body,
        };
        match kition_connections::channel::deliver(&connection, &secrets, &message).await {
            Ok(()) => finish(run, "", None),
            Err(err) => {
                if !kition_connections::channel::is_transient(err.code) {
                    mark_invalid(err.code, err.to_string()).await;
                }
                run.connection_id = def.action.connection_id.clone();
                finish(run, err.code, Some(err.to_string()))
            }
        }
    }

    /// Handles one record event: matching enabled workflows run in the
    /// background.
    pub async fn handle_event(self: &Arc<Self>, topic: &'static str, event: DeliveryEvent) {
        for def in self.store.list_enabled() {
            let has_required = !def.trigger.required_fields.is_empty();
            if !trigger_subscribes(&def.trigger.trigger_type, topic, has_required) {
                continue;
            }
            if def.trigger.table_id != event.table_id {
                continue;
            }
            if !def.trigger.document_path.is_empty()
                && def.trigger.document_path != event.document_path
            {
                continue;
            }
            if has_required {
                let fields = match self
                    .schema(event.user_id, &event.document_path, &event.table_id)
                    .await
                {
                    Ok(schema) => by_field_id(&event.fields, &schema.fields),
                    Err(_) => event.fields.clone(),
                };
                let missing = missing_required_field(&def.trigger.required_fields, &fields);
                if !missing.is_empty() {
                    tracing::info!(workflow_id = %def.id, field_id = %missing, record_id = %event.record_id, "workflow runner: required field empty, skipping");
                    continue;
                }
            }
            if let Some(dedup) = &self.record_dedup
                && def.trigger.trigger_type == "record_created"
                && has_required
                && !event.record_id.is_empty()
            {
                let key = record_dedup_key(&def.id, &event.record_id);
                if dedup.seen(&key) {
                    continue;
                }
                if let Err(err) = dedup.mark(&key) {
                    tracing::error!(workflow_id = %def.id, error = %err, "workflow runner: dedup mark failed");
                }
            }
            let engine = Arc::clone(self);
            let event = event.clone();
            tokio::spawn(async move {
                let run = engine
                    .execute(
                        &def,
                        topic,
                        event.user_id,
                        &event.record_id,
                        &event.document_path,
                        &event.table_id,
                        Some(event.fields.clone()),
                    )
                    .await;
                if let Err(err) = engine.runs.append(run) {
                    tracing::error!(workflow_id = %def.id, error = %err, "workflow run history append failed");
                }
            });
        }
    }

    /// Subscribes to record events for the life of the process.
    pub fn start_runner(self: &Arc<Self>, bus: &EventBus) {
        let mut events = bus.subscribe();
        let engine = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "workflow runner fell behind record events");
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                };
                let (topic, delivery) = match event {
                    DomainEvent::RecordCreated(e) => (
                        RECORD_CREATED_TOPIC,
                        DeliveryEvent {
                            user_id: e.user_id,
                            document_path: e.document_path,
                            table_id: e.table_id,
                            record_id: e.record_id,
                            fields: e.fields,
                        },
                    ),
                    DomainEvent::RecordUpdated(e) => (
                        RECORD_UPDATED_TOPIC,
                        DeliveryEvent {
                            user_id: e.user_id,
                            document_path: e.document_path,
                            table_id: e.table_id,
                            record_id: e.record_id,
                            fields: e.fields,
                        },
                    ),
                };
                engine.handle_event(topic, delivery).await;
            }
        });
    }
}

/// The record an email delivery renders against.
#[derive(Debug, Clone, Default)]
pub struct DeliveryEvent {
    pub user_id: i64,
    pub document_path: String,
    pub table_id: String,
    pub record_id: String,
    pub fields: Map<String, Value>,
}

/// Which trigger types listen to an event topic. A `record_created`
/// trigger with required fields also listens to updates, so a row created
/// empty and then filled in still fires (once).
pub fn trigger_subscribes(trigger_type: &str, topic: &str, has_required_fields: bool) -> bool {
    match topic {
        RECORD_CREATED_TOPIC => {
            matches!(trigger_type, "record_created" | "record_created_or_updated")
        }
        RECORD_UPDATED_TOPIC => {
            matches!(trigger_type, "record_updated" | "record_created_or_updated")
                || (trigger_type == "record_created" && has_required_fields)
        }
        _ => false,
    }
}

fn eval_filter(node: &NodeConfig, rt: &RunContext) -> Result<(bool, String), (String, String)> {
    let filter: FilterConfig = config_of(node)
        .map_err(|err| (String::new(), format!("filter {}: {err}", node.node_id)))?;
    let parsed = expr::parse(&filter.expression)
        .map_err(|err| (filter.expression.clone(), err.to_string()))?;
    let matched = expr::eval_bool(&parsed, &rt.outputs)
        .map_err(|err| (filter.expression.clone(), err.to_string()))?;
    Ok((matched, format!("{} → {matched}", filter.expression)))
}

fn fail_run(mut run: RunRecord, failing: &str, message: &str) -> RunRecord {
    run.status = "error".into();
    run.error = message.into();
    run.failing_node_id = failing.into();
    run.finished_at = now_millis();
    run
}
