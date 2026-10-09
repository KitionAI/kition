//! `/workflows` and `/tables/{tableId}/workflows`. Responses are plain JSON
//! objects (no envelope), errors are `{"error": ...}`.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use kition_core::{AppError, AppResult};
use kition_http::{AuthConfig, CurrentUser};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::engine::Engine;
use crate::store::{ActionPatch, TriggerPatch, UpdateError, WorkflowPatch, apply_patch};
use crate::template::{field_refs, normalize_field_key, render, stringify_trigger_value};
use crate::types::*;
use crate::{cron, expr, validate};

/// The JSON schema of the `emit_workflow` tool the model must call.
pub fn emit_workflow_schema() -> Value {
    serde_json::from_str(include_str!("emit_workflow.schema.json")).unwrap_or(Value::Null)
}

/// What a build reports when the model answered without the tool.
pub const TOOL_NOT_INVOKED: &str = "workflow: model did not invoke emit_workflow tool";

/// Generates a workflow from a prompt (AI-backed).
pub trait WorkflowAi: Send + Sync {
    fn emit_workflow<'a>(
        &'a self,
        prompt: String,
        model: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<WorkflowDefinition, String>> + Send + 'a>,
    >;
}

#[derive(Clone)]
pub struct WorkflowState {
    pub auth: AuthConfig,
    pub engine: Arc<Engine>,
    /// Whether a signed-in cloud account allows AI features.
    pub ai_gate: Arc<dyn Fn() -> bool + Send + Sync>,
    pub ai: Option<Arc<dyn WorkflowAi>>,
}

impl axum::extract::FromRef<WorkflowState> for AuthConfig {
    fn from_ref(state: &WorkflowState) -> Self {
        state.auth.clone()
    }
}

pub fn router(state: WorkflowState) -> Router {
    Router::new()
        .route("/workflows", get(list).post(create))
        .route("/workflows/build", post(build))
        .route("/workflows/_preview/schedule", get(schedule_preview))
        .route(
            "/workflows/{id}",
            get(get_one).patch(patch_one).delete(delete_one),
        )
        .route("/workflows/{id}/dry-run", post(dry_run))
        .route("/workflows/{id}/send-test", post(send_test))
        .route("/workflows/{id}/enabled", patch(set_enabled))
        .route("/workflows/{id}/runs", get(list_runs))
        .route("/workflows/{id}/runs/{run_id}/retry", post(retry_run))
        .route("/workflows/{id}/validate", post(validate_one))
        .route("/workflows/{id}/nodes/{node_id}/test", post(node_test))
        .route("/workflows/{id}/filters/dry-run", post(filter_dry_run))
        .route("/tables/{table_id}/workflows", get(table_workflows))
        .with_state(state)
}

fn reply(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    reply(status, json!({"error": message.into()}))
}

fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "not found")
}

/// Decodes a required JSON object body; failures carry the legacy decoder's
/// wording for the common cases.
fn bind<T: DeserializeOwned>(bytes: &[u8], type_name: &str) -> Result<T, Box<Response>> {
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Err(Box::new(error(StatusCode::BAD_REQUEST, "EOF")));
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|e| Box::new(error(StatusCode::BAD_REQUEST, e.to_string())))?;
    let kind = match &value {
        Value::Array(_) => Some("array"),
        Value::String(_) => Some("string"),
        Value::Number(_) => Some("number"),
        Value::Bool(_) => Some("bool"),
        _ => None,
    };
    if let Some(kind) = kind {
        return Err(Box::new(error(
            StatusCode::BAD_REQUEST,
            format!("json: cannot unmarshal {kind} into Go value of type workflow.{type_name}"),
        )));
    }
    let value = if value.is_null() {
        Value::Object(Map::new())
    } else {
        value
    };
    serde_json::from_value(value)
        .map_err(|e| Box::new(error(StatusCode::BAD_REQUEST, e.to_string())))
}

/// Decodes an optional body, ignoring failures.
fn bind_lenient<T: DeserializeOwned + Default>(bytes: &[u8]) -> T {
    serde_json::from_slice(bytes).unwrap_or_default()
}

async fn list(State(state): State<WorkflowState>, _user: CurrentUser) -> Response {
    reply(StatusCode::OK, json!({"items": state.engine.store.list()}))
}

async fn get_one(
    State(state): State<WorkflowState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> Response {
    match state.engine.store.get(&id) {
        Some(def) => reply(StatusCode::OK, json!(def)),
        None => not_found(),
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CreateTrigger {
    #[serde(rename = "type")]
    trigger_type: String,
    #[serde(rename = "documentId")]
    document_id: String,
    #[serde(rename = "tableId")]
    table_id: String,
    schedule: Option<ScheduleConfig>,
    #[serde(rename = "dateField")]
    date_field: Option<DateFieldConfig>,
    #[serde(rename = "requiredFields")]
    required_fields: Option<Vec<String>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CreateAction {
    #[serde(rename = "type")]
    action_type: String,
    #[serde(rename = "connectionId")]
    connection_id: String,
    to: String,
    #[serde(deserialize_with = "deserialize_subject")]
    subject: BodyTemplate,
    title: String,
    body: BodyTemplate,
    #[serde(rename = "addRecord")]
    add_record: Option<AddRecordConfig>,
    #[serde(rename = "updateRecord")]
    update_record: Option<UpdateRecordConfig>,
    #[serde(rename = "lookupRecord")]
    lookup_record: Option<LookupRecordConfig>,
    #[serde(rename = "transformRecord")]
    transform_record: Option<TransformRecordConfig>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct CreateRequest {
    name: String,
    description: String,
    enabled: bool,
    trigger: CreateTrigger,
    action: CreateAction,
}

async fn create(State(state): State<WorkflowState>, _user: CurrentUser, body: Bytes) -> Response {
    let req: CreateRequest = match bind(&body, "createWorkflowRequest") {
        Ok(req) => req,
        Err(response) => return *response,
    };
    if req.enabled
        && req.trigger.trigger_type != "scheduled_time"
        && req.trigger.table_id.is_empty()
    {
        return error(StatusCode::BAD_REQUEST, "trigger.tableId required");
    }
    if !is_trigger_type(&req.trigger.trigger_type) {
        return error(StatusCode::BAD_REQUEST, "unsupported trigger type");
    }
    if !is_action_type(&req.action.action_type) {
        return error(StatusCode::BAD_REQUEST, "unsupported action type");
    }
    let def = WorkflowDefinition {
        id: format!("auto_{}", uuid::Uuid::new_v4()),
        name: if req.name.is_empty() {
            "Untitled workflow".into()
        } else {
            req.name
        },
        description: req.description,
        enabled: req.enabled,
        trigger: TriggerConfig {
            node_id: "trigger_1".into(),
            trigger_type: req.trigger.trigger_type,
            document_id: req.trigger.document_id,
            table_id: req.trigger.table_id,
            schedule: req.trigger.schedule,
            date_field: req.trigger.date_field,
            required_fields: crate::govec::GoVec(req.trigger.required_fields),
        },
        action: ActionConfig {
            node_id: "action_1".into(),
            action_type: req.action.action_type,
            connection_id: req.action.connection_id,
            to: req.action.to,
            subject: req.action.subject,
            title: req.action.title,
            body: req.action.body,
            add_record: req.action.add_record,
            update_record: req.action.update_record,
            lookup_record: req.action.lookup_record,
            transform_record: req.action.transform_record,
        },
        extra_nodes: Vec::new(),
        extra_edges: Vec::new(),
    };
    if let Err(err) = def.validate() {
        return error(StatusCode::BAD_REQUEST, err);
    }
    if let Err(err) = state.engine.store.put(def.clone()) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err);
    }
    reply(StatusCode::OK, json!({"workflow": def}))
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct PatchTrigger {
    #[serde(rename = "nodeId")]
    node_id: Option<String>,
    #[serde(rename = "type")]
    trigger_type: Option<String>,
    #[serde(rename = "documentId")]
    document_id: Option<String>,
    #[serde(rename = "tableId")]
    table_id: Option<String>,
    schedule: Option<ScheduleConfig>,
    #[serde(rename = "dateField")]
    date_field: Option<DateFieldConfig>,
    #[serde(rename = "requiredFields")]
    required_fields: Option<Vec<String>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct PatchAction {
    #[serde(rename = "type")]
    action_type: Option<String>,
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
    to: Option<String>,
    #[serde(deserialize_with = "optional_subject")]
    subject: Option<BodyTemplate>,
    body: Option<BodyTemplate>,
    #[serde(rename = "addRecord")]
    add_record: Option<AddRecordConfig>,
    #[serde(rename = "updateRecord")]
    update_record: Option<UpdateRecordConfig>,
    #[serde(rename = "lookupRecord")]
    lookup_record: Option<LookupRecordConfig>,
    #[serde(rename = "transformRecord")]
    transform_record: Option<TransformRecordConfig>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct PatchRequest {
    name: Option<String>,
    description: Option<String>,
    enabled: Option<bool>,
    trigger: Option<PatchTrigger>,
    action: Option<PatchAction>,
    nodes: Option<Vec<NodeConfig>>,
    edges: Option<Vec<EdgeConfig>>,
}

impl From<PatchRequest> for WorkflowPatch {
    fn from(req: PatchRequest) -> Self {
        WorkflowPatch {
            name: req.name,
            description: req.description,
            enabled: req.enabled,
            trigger: req.trigger.map(|t| TriggerPatch {
                node_id: t.node_id,
                trigger_type: t.trigger_type,
                document_id: t.document_id,
                table_id: t.table_id,
                schedule: t.schedule,
                date_field: t.date_field,
                required_fields: t.required_fields,
            }),
            action: req.action.map(|a| ActionPatch {
                action_type: a.action_type,
                connection_id: a.connection_id,
                to: a.to,
                subject: a.subject,
                body: a.body,
                add_record: a.add_record,
                update_record: a.update_record,
                lookup_record: a.lookup_record,
                transform_record: a.transform_record,
            }),
            nodes: req.nodes,
            edges: req.edges,
        }
    }
}

fn update_response(
    result: Result<WorkflowDefinition, UpdateError>,
    invalid_status: StatusCode,
) -> Response {
    match result {
        Ok(def) => reply(StatusCode::OK, json!({"ok": true, "workflow": def})),
        Err(UpdateError::NotFound) => not_found(),
        Err(UpdateError::Invalid(err)) => error(invalid_status, err),
        Err(UpdateError::Write(err)) => error(invalid_status, err),
    }
}

async fn patch_one(
    State(state): State<WorkflowState>,
    _user: CurrentUser,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let req: PatchRequest = match bind(&body, "patchWorkflowRequest") {
        Ok(req) => req,
        Err(response) => return *response,
    };
    update_response(
        state.engine.store.update(&id, req.into()),
        StatusCode::BAD_REQUEST,
    )
}

async fn delete_one(
    State(state): State<WorkflowState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> Response {
    match state.engine.store.delete(&id) {
        Ok(true) => reply(StatusCode::OK, json!({"ok": true})),
        Ok(false) => not_found(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct EnabledRequest {
    enabled: bool,
}

async fn set_enabled(
    State(state): State<WorkflowState>,
    _user: CurrentUser,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let req: EnabledRequest = match bind(&body, "setEnabledRequest") {
        Ok(req) => req,
        Err(response) => return *response,
    };
    let patch = WorkflowPatch {
        enabled: Some(req.enabled),
        ..Default::default()
    };
    update_response(
        state.engine.store.update(&id, patch),
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

async fn list_runs(
    State(state): State<WorkflowState>,
    _user: CurrentUser,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let limit = query
        .get("limit")
        .map_or(50, |raw| raw.parse().unwrap_or(0));
    let status = query.get("status").map(|s| s.trim()).unwrap_or_default();
    let mut runs = state.engine.runs.list(&id, limit);
    if !status.is_empty() && status != "all" {
        runs.retain(|run| run.status == status);
    }
    reply(StatusCode::OK, json!({"runs": runs}))
}

async fn retry_run(
    State(state): State<WorkflowState>,
    _user: CurrentUser,
    Path((id, run_id)): Path<(String, String)>,
) -> Response {
    let Some(def) = state.engine.store.get(&id) else {
        return error(StatusCode::NOT_FOUND, "workflow not found");
    };
    let Some(original) = state.engine.runs.get(&id, &run_id) else {
        return error(StatusCode::NOT_FOUND, "run not found");
    };
    let run = state
        .engine
        .execute(
            &def,
            &original.trigger_event,
            original.user_id,
            &original.record_id,
            &original.document_id,
            &original.table_id,
            original.trigger_fields.clone(),
        )
        .await;
    if let Err(err) = state.engine.runs.append(run.clone()) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, err);
    }
    reply(StatusCode::OK, json!({"run": run}))
}

async fn validate_one(
    State(state): State<WorkflowState>,
    user: CurrentUser,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let Some(mut def) = state.engine.store.get(&id) else {
        return not_found();
    };
    if !body.is_empty()
        && let Ok(req) = serde_json::from_slice::<PatchRequest>(&body)
    {
        def = apply_patch(def, req.into());
    }
    let connection = match (&state.engine.connections, def.action.connection_id.trim()) {
        (Some(connections), id) if !id.is_empty() => {
            let (store, user_id, id) = (connections.store.clone(), user.user.id, id.to_owned());
            Some(
                connections
                    .db
                    .run(move |conn| {
                        Ok(store
                            .get(conn, user_id, &id)
                            .ok()
                            .flatten()
                            .map(|c| c.view(0)))
                    })
                    .await
                    .ok()
                    .flatten(),
            )
        }
        _ => None,
    };
    let lookup = |_: &str| connection.clone().flatten();
    let issues = validate::node_issues(
        &def,
        state
            .engine
            .connections
            .as_ref()
            .map(|_| &lookup as validate::ConnectionLookup<'_>),
    );
    reply(StatusCode::OK, json!({"issues": issues}))
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct TestRequest {
    to: String,
    #[serde(rename = "triggerFields")]
    trigger_fields: Option<Map<String, Value>>,
    #[serde(rename = "recordId")]
    record_id: String,
}

/// A schema built from the body's field references, for tables that
/// cannot be read.
fn fallback_schema(def: &WorkflowDefinition) -> TableSchema {
    let mut seen = std::collections::HashSet::new();
    let fields = field_refs(&def.action.body)
        .into_iter()
        .filter(|r| !r.field_id.is_empty() && seen.insert(r.field_id.clone()))
        .map(|r| FieldSchema {
            name: format!("Field {}", r.field_id),
            id: r.field_id,
            field_type: "text".into(),
        })
        .collect();
    TableSchema {
        id: def.trigger.table_id.clone(),
        name: def.trigger.table_id.clone(),
        fields,
    }
}

fn sample_value(field: &FieldSchema) -> String {
    match field.field_type.as_str() {
        "email" => "bieber@example.com".into(),
        "phone" => "+1 555 0100".into(),
        "number" | "rating" => "42".into(),
        "date" | "datetime" | "created_time" | "last_modified_time" => "2026-06-11".into(),
        _ => match normalize_field_key(&field.name).as_str() {
            "firstname" | "name" | "title" => "Bieber".into(),
            "company" => "Kition Labs".into(),
            "email" => "bieber@example.com".into(),
            _ if !field.name.is_empty() => format!("Sample {}", field.name),
            _ => "Sample value".into(),
        },
    }
}

/// Sample values for every field the body references.
fn sample_row(def: &WorkflowDefinition, schema: &TableSchema) -> HashMap<String, String> {
    let by_id: HashMap<&str, &FieldSchema> =
        schema.fields.iter().map(|f| (f.id.as_str(), f)).collect();
    let mut out = HashMap::new();
    for r in field_refs(&def.action.body) {
        let field = by_id
            .get(r.field_id.as_str())
            .map(|f| (*f).clone())
            .unwrap_or_default();
        out.entry(r.field_id)
            .or_insert_with(|| sample_value(&field));
    }
    out
}

async fn preview_values(
    state: &WorkflowState,
    user_id: i64,
    def: &WorkflowDefinition,
    fields: Option<&Map<String, Value>>,
) -> HashMap<String, String> {
    let schema = state
        .engine
        .schema(user_id, &def.trigger.document_id, &def.trigger.table_id)
        .await
        .unwrap_or_else(|_| fallback_schema(def));
    match fields.filter(|f| !f.is_empty()) {
        Some(fields) => fields
            .iter()
            .map(|(k, v)| (k.clone(), stringify_trigger_value(v)))
            .collect(),
        None => sample_row(def, &schema),
    }
}

async fn dry_run(
    State(state): State<WorkflowState>,
    user: CurrentUser,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let req: TestRequest = bind_lenient(&body);
    let Some(def) = state.engine.store.get(&id) else {
        return reply(
            StatusCode::NOT_FOUND,
            json!({"ok": false, "input": {"to": "", "subject": "", "body": ""}, "error": "workflow not found"}),
        );
    };
    let values = preview_values(&state, user.user.id, &def, req.trigger_fields.as_ref()).await;
    let (subject, _) = render(&def.action.subject, &values);
    let (rendered, _) = render(&def.action.body, &values);
    reply(
        StatusCode::OK,
        json!({"ok": true, "input": {"to": def.action.to, "subject": subject, "body": rendered}}),
    )
}

fn test_reply(status: StatusCode, ok: bool, input: (&str, &str, &str), err: &str) -> Response {
    let mut body = json!({"ok": ok, "input": {"to": input.0, "subject": input.1, "body": input.2}});
    if !err.is_empty() {
        body["error"] = Value::String(err.into());
    }
    reply(status, body)
}

async fn send_test(
    State(state): State<WorkflowState>,
    user: CurrentUser,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    run_send_test(&state, user.user.id, &id, &body, "manual.run_test").await
}

async fn run_send_test(
    state: &WorkflowState,
    user_id: i64,
    id: &str,
    body: &[u8],
    trigger_event: &str,
) -> Response {
    let req: TestRequest = bind_lenient(body);
    let blank = ("", "", "");
    let Some(def) = state.engine.store.get(id) else {
        return test_reply(StatusCode::NOT_FOUND, false, blank, "workflow not found");
    };
    if def.action.action_type != "send_email" {
        return test_reply(
            StatusCode::BAD_REQUEST,
            false,
            blank,
            &format!("unsupported action type: {}", def.action.action_type),
        );
    }
    let values = preview_values(state, user_id, &def, req.trigger_fields.as_ref()).await;
    let (body_text, _) = render(&def.action.body, &values);
    let to = if req.to.trim().is_empty() {
        def.action.to.clone()
    } else {
        req.to.trim().to_owned()
    };
    let (mut subject, _) = render(&def.action.subject, &values);
    if !subject.starts_with("[TEST]") {
        subject = format!("[TEST] {subject}");
    }
    let mut run = RunRecord {
        id: uuid::Uuid::new_v4().to_string(),
        workflow_id: def.id.clone(),
        trigger_event: trigger_event.into(),
        started_at: kition_core::now_millis(),
        connection_id: def.action.connection_id.clone(),
        to: to.clone(),
        subject: subject.clone(),
        body: body_text.clone(),
        ..Default::default()
    };
    let engine = &state.engine;
    let finish = |mut run: RunRecord, code: &str, err: Option<&str>| {
        run.finished_at = kition_core::now_millis();
        match err {
            Some(err) => {
                run.status = "error".into();
                run.error_code = code.into();
                run.error = err.into();
            }
            None => run.status = "ok".into(),
        }
        if let Err(append) = engine.runs.append(run) {
            tracing::error!(workflow_id = %def.id, error = %append, "workflow send-test history append failed");
        }
    };
    let input = (to.as_str(), subject.as_str(), body_text.as_str());
    if let Some(connections) = engine
        .connections
        .as_ref()
        .filter(|_| !def.action.connection_id.trim().is_empty())
    {
        let (store, conn_id) = (connections.store.clone(), def.action.connection_id.clone());
        let found = connections
            .db
            .run(move |conn| store.get(conn, user_id, &conn_id))
            .await;
        let connection = match found {
            Ok(Some(connection)) => connection,
            Ok(None) => {
                finish(run, "connection_missing", Some("connection not found"));
                return test_reply(
                    StatusCode::BAD_GATEWAY,
                    false,
                    blank,
                    "connection not found",
                );
            }
            Err(err) => {
                let message = err.to_string();
                finish(run, "connection_missing", Some(&message));
                return test_reply(StatusCode::BAD_GATEWAY, false, blank, &message);
            }
        };
        let secrets = match connections.store.open_secrets(&connection) {
            Ok(secrets) => secrets,
            Err(err) => {
                finish(run, "secret_unavailable", Some(&err));
                return test_reply(StatusCode::BAD_GATEWAY, false, blank, &err);
            }
        };
        let message = kition_connections::smtp::Message {
            to: to.clone(),
            subject: subject.clone(),
            body: body_text.clone(),
        };
        return match kition_connections::channel::deliver(&connection, &secrets, &message).await {
            Ok(()) => {
                finish(run, "", None);
                test_reply(StatusCode::OK, true, input, "")
            }
            Err(err) => {
                let message = err.to_string();
                finish(run, "delivery_failed", Some(&message));
                test_reply(StatusCode::BAD_GATEWAY, false, blank, &message)
            }
        };
    }
    run.connection_id = def.action.connection_id.clone();
    match engine.legacy_smtp.send(&to, &subject, &body_text).await {
        Ok(()) => {
            finish(run, "", None);
            test_reply(StatusCode::OK, true, input, "")
        }
        Err(err) => {
            finish(run, "", Some(&err));
            test_reply(StatusCode::BAD_GATEWAY, false, blank, &err)
        }
    }
}

async fn node_test(
    State(state): State<WorkflowState>,
    user: CurrentUser,
    Path((id, node_id)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let Some(def) = state.engine.store.get(&id) else {
        return error(StatusCode::NOT_FOUND, "workflow not found");
    };
    if node_id == def.action.node_id {
        if def.action.action_type == "send_email" || def.action.action_type == "send_notification" {
            return run_send_test(&state, user.user.id, &id, &body, "manual.test").await;
        }
        let req: TestRequest = bind_lenient(&body);
        let mut fields = req.trigger_fields.filter(|f| !f.is_empty());
        if fields.is_none() && def.trigger.trigger_type != "scheduled_time" {
            let schema = state
                .engine
                .schema(
                    user.user.id,
                    &def.trigger.document_id,
                    &def.trigger.table_id,
                )
                .await
                .unwrap_or_else(|_| fallback_schema(&def));
            fields = Some(
                sample_row(&def, &schema)
                    .into_iter()
                    .map(|(k, v)| (k, Value::String(v)))
                    .collect(),
            );
        }
        let run = state
            .engine
            .execute(
                &def,
                "manual.test",
                user.user.id,
                &req.record_id,
                &def.trigger.document_id,
                &def.trigger.table_id,
                fields,
            )
            .await;
        if let Err(err) = state.engine.runs.append(run.clone()) {
            return reply(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"ok": false, "error": err}),
            );
        }
        let output: Value = run
            .node_outcomes
            .iter()
            .find(|o| o.node_id == node_id && !o.detail.is_empty())
            .and_then(|o| serde_json::from_str(&o.detail).ok())
            .unwrap_or(Value::Null);
        if run.status != "ok" {
            return reply(
                StatusCode::OK,
                json!({"ok": false, "error": run.error, "run": run}),
            );
        }
        return reply(
            StatusCode::OK,
            json!({"ok": true, "run": run, "output": output}),
        );
    }
    if node_id == def.trigger.node_id {
        return reply(
            StatusCode::OK,
            json!({"ok": true, "nodeId": node_id, "skipped": "trigger has no side effects"}),
        );
    }
    reply(
        StatusCode::NOT_FOUND,
        json!({"error": "unknown nodeId", "nodeId": node_id}),
    )
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct FilterDryRun {
    expression: String,
    #[serde(rename = "triggerNode")]
    trigger_node: String,
    sample: Option<Map<String, Value>>,
}

async fn filter_dry_run(
    State(_state): State<WorkflowState>,
    _user: CurrentUser,
    Path(_id): Path<String>,
    body: Bytes,
) -> Response {
    let req: FilterDryRun = match bind(&body, "filterDryRunRequest") {
        Ok(req) => req,
        Err(response) => return *response,
    };
    let parsed = match expr::parse(req.expression.trim()) {
        Ok(parsed) => parsed,
        Err(err) => {
            return reply(
                StatusCode::OK,
                json!({"ok": false, "parseError": err.to_string()}),
            );
        }
    };
    let node = if req.trigger_node.is_empty() {
        "trigger_1".to_owned()
    } else {
        req.trigger_node
    };
    let mut env = Map::new();
    env.insert(node, req.sample.map_or(Value::Null, Value::Object));
    match expr::eval_bool(&parsed, &env) {
        Ok(matched) => reply(
            StatusCode::OK,
            json!({"ok": true, "matched": matched, "expression": req.expression}),
        ),
        Err(err) => reply(
            StatusCode::OK,
            json!({"ok": false, "evalError": err.to_string()}),
        ),
    }
}

async fn schedule_preview(
    _user: CurrentUser,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let spec = query.get("cron").map(|s| s.trim()).unwrap_or_default();
    if spec.is_empty() {
        return error(StatusCode::BAD_REQUEST, "cron query parameter required");
    }
    let tz = query.get("tz").map(|s| s.trim()).unwrap_or_default();
    if !tz.is_empty() && cron::load_location(tz).is_err() {
        return error(StatusCode::BAD_REQUEST, format!("unknown timezone {tz}"));
    }
    let key = if tz.is_empty() {
        spec.to_owned()
    } else {
        format!("CRON_TZ={tz} {spec}")
    };
    let schedule = match cron::parse(&key) {
        Ok(schedule) => schedule,
        Err(err) => {
            return error(
                StatusCode::BAD_REQUEST,
                format!("invalid cron expression: {err}"),
            );
        }
    };
    let mut runs = Vec::new();
    let mut cursor = chrono::Utc::now();
    for _ in 0..3 {
        let Some(next) = schedule.next(cursor) else {
            break;
        };
        runs.push(next.timestamp_millis());
        cursor = next;
    }
    reply(StatusCode::OK, json!({"nextRuns": runs, "timezone": tz}))
}

async fn table_workflows(
    State(state): State<WorkflowState>,
    _user: CurrentUser,
    Path(table_id): Path<String>,
) -> Response {
    let table_id = table_id.trim();
    if table_id.is_empty() {
        return error(StatusCode::BAD_REQUEST, "tableId required");
    }
    let items: Vec<WorkflowDefinition> = state
        .engine
        .store
        .list()
        .into_iter()
        .filter(|d| d.trigger.table_id == table_id)
        .collect();
    reply(StatusCode::OK, json!({"items": items}))
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct BuildRequest {
    prompt: String,
    #[serde(rename = "documentId")]
    document_id: String,
    #[serde(rename = "tableId")]
    table_id: String,
    model: Value,
}

fn build_prompt(user_prompt: &str, schema: &TableSchema) -> String {
    let mut out = String::from("You are an workflow designer for the kition app.\n\n");
    out.push_str(&format!(
        "The user is working on table \"{}\" (tableId: {}) and wrote:\n",
        schema.name, schema.id
    ));
    out.push_str(&format!("  \"{user_prompt}\"\n\n"));
    out.push_str("Available fields on this table:\n");
    for field in &schema.fields {
        out.push_str(&format!(
            "  - id={}  name={}  type={}\n",
            field.id, field.name, field.field_type
        ));
    }
    out.push('\n');
    out.push_str("Constraints:\n");
    out.push_str("  - trigger.type must be \"record_created\"\n");
    out.push_str(&format!(
        "  - trigger.tableId must equal \"{}\"\n",
        schema.id
    ));
    out.push_str("  - action.type must be \"send_email\"\n");
    out.push_str("  - action.to is the recipient email address extracted from the user prompt\n");
    out.push_str("  - action.subject is a short descriptive title\n");
    out.push_str("  - action.body is { parts: [...] } where each part is one of:\n");
    out.push_str("      { kind: \"text\", text: \"...\" }\n");
    out.push_str("      { kind: \"newline\" }\n");
    out.push_str(
        "      { kind: \"field_ref\", fieldRef: { fieldId: \"<one of the field ids above>\" } }\n",
    );
    out.push_str("  - Reference at least 3 distinct fields in the body so the recipient gets useful context.\n");
    out.push('\n');
    out.push_str("Invoke the emit_workflow tool with the matching WorkflowDefinition.");
    out
}

/// Server-sent events from building a workflow with the configured model.
async fn build(
    State(state): State<WorkflowState>,
    user: CurrentUser,
    body: Bytes,
) -> AppResult<Response> {
    if !(state.ai_gate)() {
        return Err(AppError::localized(
            401,
            4015,
            "auth.ai_login_required",
            Vec::new(),
        ));
    }
    let req: BuildRequest = match bind(&body, "buildRequest") {
        Ok(req) => req,
        Err(response) => return Ok(*response),
    };
    let model_field = |key: &str| {
        req.model
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    if model_field("provider_type").is_empty() || model_field("model_name").is_empty() {
        return Ok(error(StatusCode::BAD_REQUEST, "model not configured"));
    }
    for (value, message) in [
        (&req.prompt, "prompt required"),
        (&req.document_id, "documentId required"),
        (&req.table_id, "tableId required"),
    ] {
        if value.is_empty() {
            return Ok(error(StatusCode::BAD_REQUEST, message));
        }
    }
    let user_id = user.user.id;
    let schema = match state
        .engine
        .schema(user_id, &req.document_id, &req.table_id)
        .await
    {
        Ok(schema) => schema,
        Err(err) => return Ok(error(StatusCode::BAD_GATEWAY, err)),
    };
    let default_connection = match &state.engine.connections {
        Some(connections) => {
            let store = connections.store.clone();
            connections
                .db
                .run(move |conn| {
                    Ok(store
                        .first_by_channel(
                            conn,
                            user_id,
                            kition_connections::store::CHANNEL_EMAIL_SMTP,
                        )
                        .ok()
                        .flatten())
                })
                .await
                .ok()
                .flatten()
                .map(|c| c.id)
                .unwrap_or_default()
        }
        None => String::new(),
    };
    let mut events: Vec<Value> = Vec::new();
    let error_event =
        |code: &str, message: String| json!({"kind": "error", "code": code, "message": message});
    let generated = match &state.ai {
        None => Err((
            "model_failed",
            "workflow generation is not available in this runtime yet".to_owned(),
        )),
        Some(ai) => {
            let call = ai.emit_workflow(build_prompt(&req.prompt, &schema), req.model.clone());
            match tokio::time::timeout(std::time::Duration::from_secs(45), call).await {
                Ok(Ok(def)) => Ok(def),
                Ok(Err(err)) if err == TOOL_NOT_INVOKED => Err(("tool_not_invoked", err)),
                Ok(Err(err)) => Err(("model_failed", err)),
                Err(_) => Err(("model_failed", "context deadline exceeded".to_owned())),
            }
        }
    };
    match generated {
        Err((code, message)) => events.push(error_event(code, message)),
        Ok(mut def) => {
            if def.id.is_empty() {
                def.id = format!("auto_{}", uuid::Uuid::new_v4());
            }
            if def.trigger.node_id.is_empty() {
                def.trigger.node_id = "trigger_1".into();
            }
            if def.action.node_id.is_empty() {
                def.action.node_id = "action_1".into();
            }
            if let Some(parts) = def.action.body.parts.0.as_mut() {
                for part in parts.iter_mut().filter(|p| p.kind == "field_ref") {
                    if let Some(r) = part.field_ref.as_mut().filter(|r| r.node_id.is_empty()) {
                        r.node_id = def.trigger.node_id.clone();
                    }
                }
            }
            def.trigger.document_id = req.document_id.clone();
            if def.action.connection_id.is_empty() {
                def.action.connection_id = default_connection;
            }
            if let Err(err) = def.validate_for_activation() {
                events.push(error_event("invalid_definition", err));
            } else if let Err(err) = def.validate_against_schema(&schema) {
                events.push(error_event("schema_invalid", err));
            } else if let Err(err) = state.engine.store.put(def.clone()) {
                events.push(error_event("persist_failed", err));
            } else {
                events.push(json!({"kind": "workflow.generated", "workflowId": def.id, "name": def.name, "description": def.description}));
                events.push(json!({"kind": "trigger.generated", "nodeId": def.trigger.node_id, "triggerType": def.trigger.trigger_type,
                    "tableId": def.trigger.table_id, "config": {"tableId": def.trigger.table_id}}));
                events.push(json!({"kind": "action.generated", "nodeId": def.action.node_id, "actionType": def.action.action_type,
                    "config": {"connectionId": def.action.connection_id, "to": def.action.to, "subject": def.action.subject, "body": def.action.body}}));
                events.push(json!({"kind": "workflow.created", "workflowId": def.id}));
                events.push(json!({"kind": "done"}));
            }
        }
    }
    let stream: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
    Ok((
        StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, "text/event-stream"),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
            (axum::http::header::CONNECTION, "keep-alive"),
            (
                axum::http::HeaderName::from_static("x-accel-buffering"),
                "no",
            ),
        ],
        stream,
    )
        .into_response())
}
