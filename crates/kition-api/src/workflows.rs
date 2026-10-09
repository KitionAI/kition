//! Workflow runtime wiring: storage in the workspace, data document table
//! access, saved connections, the record-event runner, and time dispatchers.

use std::path::PathBuf;
use std::sync::Arc;

use kition_datadoc::DataDocState;
use kition_workflow::store::{Dedup, RunHistory, Store};
use kition_workflow::types::{FieldSchema, TableSchema};
use kition_workflow::{Connections, Engine, LegacySmtp, RecordView, Tables, WorkflowState};
use serde_json::{Map, Value};

use crate::app::Deps;

/// Builds workflows with the client's model through the `emit_workflow`
/// tool.
struct EngineWorkflowAi(kition_ai::engine::Engine);

impl kition_workflow::WorkflowAi for EngineWorkflowAi {
    fn emit_workflow<'a>(
        &'a self,
        prompt: String,
        model: Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<kition_workflow::types::WorkflowDefinition, String>,
                > + Send
                + 'a,
        >,
    > {
        use kition_ai::engine::{Message, RuntimeModel, ToolSpec};
        Box::pin(async move {
            let model: RuntimeModel =
                serde_json::from_value(model).map_err(|err| format!("invalid model: {err}"))?;
            let tool = ToolSpec {
                name: "emit_workflow".into(),
                description: "Emit the WorkflowDefinition matching the user's intent. Always invoke this tool; do not respond with text.".into(),
                input_schema: Some(kition_workflow::emit_workflow_schema()),
            };
            let result = self
                .0
                .chat_with_tools(
                    &[Message::new("user", prompt)],
                    &[tool],
                    "emit_workflow",
                    &model,
                    None,
                )
                .await
                .map_err(|err| err.to_string())?;
            let call = result
                .tool_calls
                .iter()
                .find(|call| call.name == "emit_workflow")
                .ok_or_else(|| kition_workflow::TOOL_NOT_INVOKED.to_owned())?;
            serde_json::from_str(&call.input)
                .map_err(|err| format!("workflow: tool input invalid: {err}"))
        })
    }
}

/// Workflows read and write tables through the data document API.
struct DataDocTables(DataDocState);

impl Tables for DataDocTables {
    fn schema(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
    ) -> Result<TableSchema, String> {
        let (name, fields) = self
            .0
            .fetch_table_schema(user_id, document_id, table_id)
            .map_err(|e| e.message.clone())?;
        Ok(TableSchema {
            id: table_id.to_owned(),
            name,
            fields: fields
                .into_iter()
                .map(|f| FieldSchema {
                    id: f.id,
                    name: f.name,
                    field_type: f.field_type,
                })
                .collect(),
        })
    }

    fn records(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
    ) -> Result<Vec<RecordView>, String> {
        let records = self
            .0
            .fetch_table_records(user_id, document_id, table_id)
            .map_err(|e| e.message.clone())?;
        Ok(records
            .into_iter()
            .map(|r| RecordView {
                id: r.id,
                fields: r.fields,
                created_at: r.created_at,
            })
            .collect())
    }

    fn create_record(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
        values: &Map<String, Value>,
    ) -> Result<String, String> {
        self.0
            .create_record_for_workflow(user_id, document_id, table_id, values)
            .map_err(|e| e.message.clone())
    }

    fn update_record(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
        record_id: &str,
        values: &Map<String, Value>,
    ) -> Result<Map<String, Value>, String> {
        self.0
            .update_record_for_workflow(user_id, document_id, table_id, record_id, values)
            .map_err(|e| e.message.clone())
    }
}

/// Deleting a data document removes the workflows bound to it.
struct Cleaner(Arc<Store>);

impl kition_datadoc::WorkflowCleaner for Cleaner {
    fn delete_by_document_id(&self, document_id: &str) -> kition_core::AppResult<usize> {
        self.0
            .delete_by_document_id(document_id)
            .map_err(kition_core::AppError::internal)
    }
}

pub struct Workflows {
    pub state: WorkflowState,
    /// Data documents, when a workspace is configured.
    pub datadoc: Option<DataDocState>,
}

fn workspace_file(deps: &Deps, name: &str) -> PathBuf {
    deps.workspace_dir
        .as_ref()
        .map(|dir| dir.join(name))
        .unwrap_or_default()
}

fn legacy_smtp(deps: &Deps) -> LegacySmtp {
    let c = &deps.config;
    LegacySmtp {
        host: c.smtp_host.clone(),
        port: c.smtp_port,
        username: c.smtp_username.clone(),
        password: c.smtp_password.clone(),
        from: c.smtp_from.clone(),
        from_name: c.smtp_from_name.clone(),
        tls_mode: c.smtp_tls_mode.clone(),
        proxy: c.smtp_proxy.clone(),
    }
}

/// Creates a "Default SMTP" connection from configured SMTP settings when the
/// local user has none yet, and verifies it.
fn import_legacy_connection(deps: &Deps) {
    let c = &deps.config;
    if c.smtp_host.trim().is_empty()
        || c.smtp_from.trim().is_empty()
        || c.smtp_password.trim().is_empty()
    {
        return;
    }
    let store = deps.connections.clone();
    let db = deps.db.clone();
    let settings: Map<String, Value> = serde_json::json!({
        "host": c.smtp_host, "port": c.smtp_port, "username": c.smtp_username,
        "tlsMode": c.smtp_tls_mode, "from": c.smtp_from, "fromName": c.smtp_from_name,
    })
    .as_object()
    .cloned()
    .unwrap_or_default();
    let secrets: kition_connections::SecretBag = [("password".to_owned(), c.smtp_password.clone())]
        .into_iter()
        .collect();
    tokio::spawn(async move {
        let result: Result<(), String> = async {
            if kition_connections::channel::validate(&settings, &secrets).is_err() {
                return Ok(());
            }
            let (store_c, settings_c, secrets_c) =
                (store.clone(), settings.clone(), secrets.clone());
            let created = db
                .run(move |conn| {
                    if store_c.count_by_channel(
                        conn,
                        1,
                        kition_connections::store::CHANNEL_EMAIL_SMTP,
                    )? > 0
                    {
                        return Ok(None);
                    }
                    let input = kition_connections::store::UpsertInput {
                        channel: kition_connections::store::CHANNEL_EMAIL_SMTP.into(),
                        name: "Default SMTP".into(),
                        settings: Some(settings_c),
                        secrets: secrets_c,
                    };
                    store_c
                        .create(conn, 1, input)
                        .map(Some)
                        .map_err(kition_core::AppError::internal)
                })
                .await
                .map_err(|e| e.to_string())?;
            let Some(mut row) = created else {
                return Ok(());
            };
            let bag = store.open_secrets(&row)?;
            let tested = kition_connections::channel::test(&row, &bag).await;
            db.run(move |conn| store.mark_test_result(conn, &mut row, &tested))
                .await
                .map_err(|e| e.to_string())
        }
        .await;
        if let Err(err) = result {
            tracing::warn!(error = %err, "workflow: legacy SMTP connection import failed");
        }
    });
}

/// Builds the workflow runtime and starts its background work.
pub fn start(deps: &Deps) -> Workflows {
    let store = Arc::new(Store::new(workspace_file(deps, "workflow.json")));
    if let Err(err) = store.load() {
        tracing::warn!(error = %err, "workflow definitions could not be loaded");
    }
    let runs = Arc::new(RunHistory::new(workspace_file(deps, "workflow_runs.json")));
    if let Err(err) = runs.load() {
        tracing::warn!(error = %err, "workflow run history could not be loaded");
    }
    let record_dedup = Arc::new(Dedup::new(workspace_file(
        deps,
        "workflow_record_dedup.json",
    )));
    if let Err(err) = record_dedup.load() {
        tracing::warn!(error = %err, "workflow record dedup could not be loaded");
    }
    let time_dedup = Arc::new(Dedup::new(workspace_file(deps, "workflow_dedup.json")));
    if let Err(err) = time_dedup.load() {
        tracing::warn!(error = %err, "workflow dedup could not be loaded");
    }
    let datadoc = crate::app::datadoc_state(deps, Some(Arc::new(Cleaner(store.clone()))));
    let engine = Arc::new(Engine {
        store,
        runs,
        tables: datadoc
            .clone()
            .map(|s| Arc::new(DataDocTables(s)) as Arc<dyn Tables>),
        connections: Some(Connections {
            db: deps.db.clone(),
            store: deps.connections.clone(),
        }),
        legacy_smtp: legacy_smtp(deps),
        record_dedup: Some(record_dedup),
    });
    import_legacy_connection(deps);
    engine.start_runner(&deps.events);
    kition_workflow::dispatch::start(engine.clone(), time_dedup);
    let portal = deps.portal.clone();
    Workflows {
        state: WorkflowState {
            auth: deps.auth(),
            engine,
            ai_gate: Arc::new(move || portal.signed_in()),
            ai: Some(Arc::new(EngineWorkflowAi(deps.ai.clone()))),
        },
        datadoc,
    }
}
