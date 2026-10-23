//! `/kit-tables`: the renderer's view of the workspace's table files for Kition's own features
//! (the workflow editor's table and field pickers, form and email sync targets, the workspace
//! tree's table leaves, search, templates, and the design handoff). Every answer comes from the
//! Table kit through the host table client; `contracts/runtime/kit-tables.schema.json`.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Query, State};
use axum::response::Response;
use axum::routing::{get, post};
use base64::Engine as _;
use kition_core::{AppError, AppResult};
use kition_http::{AuthConfig, CurrentUser, JsonBody, ok};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::{FileInfo, TableClient, TableError, TableInfo, is_table_path};

/// Follows a renamed table file (or a folder of them) in the host features that name it:
/// answers how many bindings changed.
pub type RenameHook = Arc<dyn Fn(&str, &str) -> Result<usize, String> + Send + Sync>;

/// Follows a deleted table file (or a folder of them) in the host features bound to it, which
/// it removes: answers how many bindings went.
pub type DeleteHook = Arc<dyn Fn(&str) -> Result<usize, String> + Send + Sync>;

#[derive(Clone)]
pub struct KitTablesState {
    pub auth: AuthConfig,
    pub tables: TableClient,
    pub renamed: Option<RenameHook>,
    pub deleted: Option<DeleteHook>,
}

impl axum::extract::FromRef<KitTablesState> for AuthConfig {
    fn from_ref(state: &KitTablesState) -> Self {
        state.auth.clone()
    }
}

pub fn router(state: KitTablesState) -> Router {
    Router::new()
        .route("/kit-tables", get(list))
        .route("/kit-tables/files", post(create_file))
        .route("/kit-tables/tables", post(create_table))
        .route("/kit-tables/tables/update", post(update_table))
        .route("/kit-tables/fields", get(fields))
        .route("/kit-tables/records", get(records).post(write_record))
        .route("/kit-tables/attachments", post(put_attachment))
        .route("/kit-tables/renamed", post(renamed))
        .route("/kit-tables/deleted", post(deleted))
        .with_state(state)
}

fn refusal(error: TableError) -> AppError {
    let reason = if error.unavailable {
        "unavailable"
    } else if error.not_found {
        "not-found"
    } else {
        "failed"
    };
    let status = match reason {
        "unavailable" => 503,
        "not-found" => 404,
        _ => 400,
    };
    AppError::new(status, i64::from(status) * 100, error.message)
        .with_data(json!({ "reason": reason }))
}

fn checked(path: &str) -> AppResult<String> {
    let path = path.trim().trim_start_matches("./").to_owned();
    if is_table_path(&path) {
        Ok(path)
    } else {
        Err(AppError::bad_request(format!(
            "`{path}` is not a table file in the workspace"
        )))
    }
}

/// A `system:<feature>` origin from the renderer's feature name.
fn origin(feature: &str) -> AppResult<String> {
    let feature = if feature.trim().is_empty() {
        "host"
    } else {
        feature.trim()
    };
    if feature.len() > 32 || !feature.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
        return Err(AppError::bad_request(
            "`feature` names a host feature: lowercase letters and `-`",
        ));
    }
    Ok(format!("system:{feature}"))
}

fn table_json(table: &TableInfo) -> Value {
    json!({
        "id": table.id,
        "name": table.name,
        "title": table.title,
        "meta": if table.meta.is_object() { table.meta.clone() } else { json!({}) },
        "fields": table.fields.iter().map(|field| json!({
            "id": field.id,
            "name": field.name,
            "title": field.title,
            "type": field.field_type,
            "primary": field.primary,
        })).collect::<Vec<_>>(),
    })
}

fn file_json(file: &FileInfo) -> Value {
    json!({
        "path": file.path,
        "documentId": file.document_id,
        "tables": file.tables.iter().map(table_json).collect::<Vec<_>>(),
        "dashboards": file.dashboards.iter().map(|dashboard| json!({ "id": dashboard.id, "name": dashboard.name })).collect::<Vec<_>>(),
    })
}

async fn list(State(state): State<KitTablesState>, _user: CurrentUser) -> AppResult<Response> {
    let mut files = Vec::new();
    let mut unreadable = Vec::new();
    for path in state.tables.table_files() {
        match state.tables.describe_cached(&path).await {
            Ok(file) => files.push(file_json(&file)),
            Err(error) if error.unavailable => return Err(refusal(error)),
            Err(error) => unreadable.push(json!({ "path": path, "error": error.message })),
        }
    }
    Ok(ok(json!({ "files": files, "unreadable": unreadable })))
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct CreateFile {
    path: String,
    title: Option<String>,
}

async fn create_file(
    State(state): State<KitTablesState>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<CreateFile>,
) -> AppResult<Response> {
    let path = checked(&body.path)?;
    let tables = state
        .tables
        .create_file(&path, body.title.as_deref())
        .await
        .map_err(refusal)?;
    Ok(ok(
        json!({ "path": path, "tables": tables.iter().map(table_json).collect::<Vec<_>>() }),
    ))
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct CreateTable {
    path: String,
    title: String,
    fields: Vec<Value>,
    feature: String,
}

async fn create_table(
    State(state): State<KitTablesState>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<CreateTable>,
) -> AppResult<Response> {
    let path = checked(&body.path)?;
    if body.title.trim().is_empty() {
        return Err(AppError::bad_request("`title` required"));
    }
    let table = state
        .tables
        .create_table(
            &path,
            body.title.trim(),
            body.fields,
            &origin(&body.feature)?,
        )
        .await
        .map_err(refusal)?;
    Ok(ok(table_json(&table)))
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct UpdateTable {
    path: String,
    table_id: String,
    title: Option<String>,
    meta: Option<Map<String, Value>>,
    feature: String,
}

async fn update_table(
    State(state): State<KitTablesState>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<UpdateTable>,
) -> AppResult<Response> {
    let path = checked(&body.path)?;
    let table = state
        .tables
        .update_table(
            &path,
            &body.table_id,
            body.title
                .as_deref()
                .map(str::trim)
                .filter(|title| !title.is_empty()),
            body.meta.map(Value::Object),
            &origin(&body.feature)?,
        )
        .await
        .map_err(refusal)?;
    Ok(ok(table_json(&table)))
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct TableQuery {
    path: String,
    table_id: String,
    limit: u64,
    offset: u64,
}

async fn fields(
    State(state): State<KitTablesState>,
    _user: CurrentUser,
    Query(query): Query<TableQuery>,
) -> AppResult<Response> {
    let path = checked(&query.path)?;
    let table = state
        .tables
        .table(&path, &query.table_id)
        .await
        .map_err(refusal)?;
    Ok(ok(json!({
        "items": table.fields.iter().map(|field| field.raw.clone()).collect::<Vec<_>>(),
        "table": table_json(&table),
    })))
}

async fn records(
    State(state): State<KitTablesState>,
    _user: CurrentUser,
    Query(query): Query<TableQuery>,
) -> AppResult<Response> {
    let path = checked(&query.path)?;
    let page = state
        .tables
        .records_page(
            &path,
            &query.table_id,
            query.limit.min(10_000),
            query.offset,
        )
        .await
        .map_err(refusal)?;
    Ok(ok(page))
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct WriteRecord {
    path: String,
    table_id: String,
    /// Absent: a new record.
    record_id: Option<String>,
    values: Map<String, Value>,
    feature: String,
}

async fn write_record(
    State(state): State<KitTablesState>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<WriteRecord>,
) -> AppResult<Response> {
    let path = checked(&body.path)?;
    let origin = origin(&body.feature)?;
    match body.record_id.filter(|id| !id.trim().is_empty()) {
        Some(record_id) => {
            let values = state
                .tables
                .update_record(&path, &body.table_id, &record_id, &body.values, &origin)
                .await
                .map_err(refusal)?;
            Ok(ok(json!({ "id": record_id, "values": values })))
        }
        None => {
            let record = state
                .tables
                .create_record(&path, &body.table_id, &body.values, &origin)
                .await
                .map_err(refusal)?;
            Ok(ok(json!({ "id": record.id, "values": record.values })))
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct PutAttachment {
    path: String,
    table_id: String,
    name: String,
    mime: String,
    /// The file's bytes, base64.
    data: String,
    feature: String,
}

async fn put_attachment(
    State(state): State<KitTablesState>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<PutAttachment>,
) -> AppResult<Response> {
    let path = checked(&body.path)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body.data.trim())
        .map_err(|_| AppError::bad_request("`data` must be base64"))?;
    let attachment = state
        .tables
        .put_attachment(
            &path,
            &body.table_id,
            &body.name,
            &body.mime,
            &bytes,
            &origin(&body.feature)?,
        )
        .await
        .map_err(refusal)?;
    Ok(ok(attachment))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Renamed {
    from: String,
    to: String,
}

async fn renamed(
    State(state): State<KitTablesState>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<Renamed>,
) -> AppResult<Response> {
    let (from, to) = (body.from.trim(), body.to.trim());
    if from.is_empty() || to.is_empty() {
        return Err(AppError::bad_request("`from` and `to` required"));
    }
    state.tables.moved(from, to);
    let updated = match &state.renamed {
        Some(hook) => hook(from, to).map_err(AppError::internal)?,
        None => 0,
    };
    Ok(ok(json!({ "updated": updated })))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Deleted {
    path: String,
}

async fn deleted(
    State(state): State<KitTablesState>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<Deleted>,
) -> AppResult<Response> {
    let path = body.path.trim().trim_start_matches("./");
    if path.is_empty() {
        return Err(AppError::bad_request("`path` required"));
    }
    state.tables.forget(path);
    let removed = match &state.deleted {
        Some(hook) => hook(path).map_err(AppError::internal)?,
        None => 0,
    };
    Ok(ok(json!({ "removed": removed })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_name_a_host_feature() {
        assert_eq!(origin("").ok().as_deref(), Some("system:host"));
        assert_eq!(origin("design").ok().as_deref(), Some("system:design"));
        assert!(origin("Design").is_err());
        assert!(origin("a b").is_err());
    }

    #[test]
    fn only_table_files_in_the_workspace() {
        assert_eq!(
            checked("./crm/Leads.ktable").ok().as_deref(),
            Some("crm/Leads.ktable")
        );
        assert!(checked("../Leads.ktable").is_err());
        assert!(checked("notes.md").is_err());
    }
}
