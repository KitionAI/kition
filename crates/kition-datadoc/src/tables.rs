//! Table, field, and view handlers.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch, post};
use kition_core::coerce::{as_bool, as_i64, as_str, nullable};
use kition_core::{AppError, AppResult};
use kition_http::{CurrentUser, JsonBody, ok};
use kition_kitable::{
    FieldPatch, FieldSpec, KitableError, TablePatch, TableSpec, ViewPatch, ViewSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::DataDocState;
use crate::respond;
use crate::source::parse_id;

pub fn routes() -> Router<DataDocState> {
    Router::new()
        .route(
            "/data-documents/{documentId}/tables",
            get(list_tables).post(create_table),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}",
            patch(update_table).delete(delete_table),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/fields",
            get(list_fields).post(create_field),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/fields/{fieldId}",
            patch(update_field).delete(delete_field),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/fields/{fieldId}/duplicate",
            post(duplicate_field),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/views",
            get(list_views).post(create_view),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/views/{viewId}",
            patch(update_view).delete(delete_view),
        )
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TableSeed {
    #[serde(default, deserialize_with = "nullable")]
    pub title: String,
    #[serde(default, deserialize_with = "nullable")]
    pub name: String,
    #[serde(default, deserialize_with = "nullable")]
    pub description: String,
    #[serde(default, deserialize_with = "nullable")]
    pub fields: Vec<FieldSeed>,
    #[serde(default, deserialize_with = "nullable")]
    pub views: Vec<ViewSeed>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FieldSeed {
    #[serde(default, deserialize_with = "nullable")]
    pub title: String,
    #[serde(default, deserialize_with = "nullable")]
    pub name: String,
    #[serde(default, rename = "type", deserialize_with = "nullable")]
    pub field_type: String,
    #[serde(default, deserialize_with = "nullable")]
    pub primary: bool,
    #[serde(default, deserialize_with = "nullable")]
    pub required: bool,
    #[serde(default, deserialize_with = "nullable")]
    pub readonly: bool,
    #[serde(default)]
    pub options: Value,
    #[serde(default, deserialize_with = "nullable")]
    pub formula: String,
    #[serde(default, deserialize_with = "nullable")]
    pub ai_prompt: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ViewSeed {
    #[serde(default, deserialize_with = "nullable")]
    pub title: String,
    #[serde(default, rename = "type", deserialize_with = "nullable")]
    pub view_type: String,
    #[serde(default)]
    pub config: Value,
}

/// The table every new document starts with.
pub fn default_table_seed(title: &str) -> TableSeed {
    let field = |title: &str, field_type: &str, primary: bool, options: Value| FieldSeed {
        title: title.into(),
        field_type: field_type.into(),
        primary,
        required: primary,
        options,
        ..FieldSeed::default()
    };
    TableSeed {
        title: title.into(),
        fields: vec![
            field("Title", "text", true, Value::Null),
            field(
                "Status",
                "single_select",
                false,
                json!({"choices": ["To do", "In progress", "Done"]}),
            ),
            field("Notes", "long_text", false, Value::Null),
        ],
        views: vec![ViewSeed {
            title: "All".into(),
            view_type: "grid".into(),
            config: Value::Null,
        }],
        ..TableSeed::default()
    }
}

pub fn seed_to_spec(seed: &TableSeed) -> TableSpec {
    TableSpec {
        name: seed.name.trim().to_owned(),
        title: seed.title.trim().to_owned(),
        description: seed.description.trim().to_owned(),
        fields: seed
            .fields
            .iter()
            .map(|f| FieldSpec {
                name: f.name.clone(),
                title: f.title.clone(),
                field_type: f.field_type.clone(),
                primary: f.primary,
                required: f.required,
                readonly: f.readonly,
                options: f.options.clone(),
                formula: f.formula.clone(),
                ai_prompt: f.ai_prompt.clone(),
                meta: Value::Null,
                order: None,
            })
            .collect(),
        views: seed
            .views
            .iter()
            .map(|v| ViewSpec {
                title: v.title.clone(),
                view_type: v.view_type.clone(),
                config: v.config.clone(),
            })
            .collect(),
        meta: Value::Null,
    }
}

fn parse_body(body: &[u8]) -> AppResult<Map<String, Value>> {
    kition_http::decode_object(body)
}

fn bad(err: KitableError) -> AppError {
    AppError::bad_request(err.to_string())
}

async fn list_tables(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path(document_id): Path<String>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let file = state.open_or_500(&doc)?;
            let tables = file
                .list_tables()
                .map_err(|_| AppError::internal("Failed to query table"))?;
            let items: Vec<Value> = tables
                .iter()
                .map(|t| respond::table(&doc, t, true))
                .collect();
            Ok(json!({ "total": items.len(), "items": items }))
        })
        .await?;
    Ok(ok(body))
}

async fn create_table(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path(document_id): Path<String>,
    JsonBody(request): JsonBody<TableSeed>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let mut file = state.open_or_500(&doc)?;
            let table = file
                .create_table(&seed_to_spec(&request))
                .map_err(|_| AppError::internal("Failed to create table"))?;
            Ok(respond::table(&doc, &table, true))
        })
        .await?;
    Ok(ok(body))
}

async fn update_table(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id)): Path<(String, String)>,
    body: Bytes,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let request = parse_body(&body)?;
            let table_id = parse_id(&table_id)?;
            let mut file = state.open_or_500(&doc)?;
            let patch = TablePatch {
                title: request.get("title").map(|v| as_str(v).to_owned()),
                description: request.get("description").map(|v| as_str(v).to_owned()),
                meta: request.get("meta").cloned(),
                primary_field_id: request
                    .get("primary_field_id")
                    .map(as_i64)
                    .filter(|id| *id > 0),
            };
            let table = file
                .update_table(table_id, &patch)
                .map_err(|_| AppError::internal("Failed to update table"))?;
            Ok(respond::table(&doc, &table, true))
        })
        .await?;
    Ok(ok(body))
}

async fn delete_table(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id)): Path<(String, String)>,
) -> AppResult<Response> {
    let user_id = user.id;
    state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let mut file = state.open_or_500(&doc)?;
            file.delete_table(table_id)
                .map_err(|_| AppError::not_found("Table does not exist"))
        })
        .await?;
    Ok(ok(json!({ "message": "Table deleted" })))
}

async fn list_fields(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id)): Path<(String, String)>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let file = state.open_or_500(&doc)?;
            let table = file
                .get_table(table_id)
                .map_err(|_| AppError::not_found("Table does not exist"))?;
            let items: Vec<Value> = table
                .fields
                .iter()
                .map(|f| respond::field(&doc, f))
                .collect();
            Ok(json!({ "total": items.len(), "items": items }))
        })
        .await?;
    Ok(ok(body))
}

#[derive(Debug, Default, Deserialize)]
struct CreateFieldRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "type")]
    field_type: Option<String>,
    #[serde(default)]
    required: Option<bool>,
    #[serde(default)]
    readonly: Option<bool>,
    #[serde(default)]
    is_primary: Option<bool>,
    #[serde(default)]
    options: Value,
    #[serde(default)]
    formula: Option<String>,
    #[serde(default)]
    ai_prompt: Option<String>,
    #[serde(default)]
    meta: Value,
    #[serde(default)]
    order: Option<i64>,
}

async fn create_field(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id)): Path<(String, String)>,
    JsonBody(request): JsonBody<CreateFieldRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let mut file = state.open_or_500(&doc)?;
            let spec = FieldSpec {
                name: request.name.unwrap_or_default(),
                title: request.title.unwrap_or_default(),
                field_type: request.field_type.unwrap_or_default(),
                primary: request.is_primary.unwrap_or_default(),
                required: request.required.unwrap_or_default(),
                readonly: request.readonly.unwrap_or_default(),
                options: request.options,
                formula: request.formula.unwrap_or_default(),
                ai_prompt: request.ai_prompt.unwrap_or_default(),
                meta: request.meta,
                order: request.order,
            };
            let field = file
                .create_field(table_id, &spec)
                .map_err(|_| AppError::internal("Failed to create field"))?;
            Ok(respond::field(&doc, &field))
        })
        .await?;
    Ok(ok(body))
}

async fn update_field(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, field_id)): Path<(String, String, String)>,
    body: Bytes,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let request = parse_body(&body)?;
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let field_id = parse_id(&field_id)?;
            let mut file = state.open_or_500(&doc)?;
            let text = |key: &str| request.get(key).map(|v| as_str(v).to_owned());
            let flag = |key: &str| request.get(key).map(as_bool);
            let patch = FieldPatch {
                title: text("title"),
                field_type: text("type"),
                required: flag("required"),
                readonly: flag("readonly"),
                is_primary: flag("is_primary"),
                options: request.get("options").cloned(),
                formula: text("formula"),
                ai_prompt: text("ai_prompt"),
                meta: request.get("meta").cloned(),
            };
            let field = file.update_field(table_id, field_id, &patch).map_err(bad)?;
            Ok(respond::field(&doc, &field))
        })
        .await?;
    Ok(ok(body))
}

async fn delete_field(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, field_id)): Path<(String, String, String)>,
) -> AppResult<Response> {
    let user_id = user.id;
    state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let field_id = parse_id(&field_id)?;
            let mut file = state.open_or_500(&doc)?;
            file.delete_field(table_id, field_id).map_err(bad)
        })
        .await?;
    Ok(ok(json!({ "message": "Field deleted" })))
}

async fn duplicate_field(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, field_id)): Path<(String, String, String)>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let field_id = parse_id(&field_id)?;
            let mut file = state.open_or_500(&doc)?;
            let field = file.duplicate_field(table_id, field_id).map_err(bad)?;
            Ok(respond::field(&doc, &field))
        })
        .await?;
    Ok(ok(body))
}

async fn list_views(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id)): Path<(String, String)>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let file = state.open_or_500(&doc)?;
            let table = file
                .get_table(table_id)
                .map_err(|_| AppError::not_found("Table does not exist"))?;
            let items: Vec<Value> = table.views.iter().map(|v| respond::view(&doc, v)).collect();
            Ok(json!({ "total": items.len(), "items": items }))
        })
        .await?;
    Ok(ok(body))
}

async fn create_view(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id)): Path<(String, String)>,
    JsonBody(request): JsonBody<ViewSeed>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let mut file = state.open_or_500(&doc)?;
            let spec = ViewSpec {
                title: request.title,
                view_type: request.view_type,
                config: request.config,
            };
            let view = file
                .create_view(table_id, &spec)
                .map_err(|_| AppError::internal("Failed to create view"))?;
            Ok(respond::view(&doc, &view))
        })
        .await?;
    Ok(ok(body))
}

async fn update_view(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, view_id)): Path<(String, String, String)>,
    body: Bytes,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let request = parse_body(&body)?;
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let view_id = parse_id(&view_id)?;
            let mut file = state.open_or_500(&doc)?;
            let patch = ViewPatch {
                title: request.get("title").map(|v| as_str(v).to_owned()),
                view_type: request.get("type").map(|v| as_str(v).to_owned()),
                config: request.get("config").cloned(),
            };
            let view = file.update_view(table_id, view_id, &patch).map_err(bad)?;
            Ok(respond::view(&doc, &view))
        })
        .await?;
    Ok(ok(body))
}

async fn delete_view(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((document_id, table_id, view_id)): Path<(String, String, String)>,
) -> AppResult<Response> {
    let user_id = user.id;
    state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let view_id = parse_id(&view_id)?;
            let mut file = state.open_or_500(&doc)?;
            file.delete_view(table_id, view_id)
                .map_err(|_| AppError::not_found("View does not exist"))
        })
        .await?;
    Ok(ok(json!({ "message": "View deleted" })))
}
