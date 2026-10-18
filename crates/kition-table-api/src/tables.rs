//! Tables, fields, and views.

use kition_kitable::{
    FieldPatch, FieldSpec, KitableError, KitableFile, TablePatch, TableSpec, ViewPatch, ViewSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::coerce::{as_bool, as_i64, as_str, nullable};
use crate::{ApiError, ApiResult, DocRef, respond};

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

#[derive(Debug, Default, Deserialize)]
pub struct CreateFieldRequest {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, rename = "type")]
    pub field_type: Option<String>,
    #[serde(default)]
    pub required: Option<bool>,
    #[serde(default)]
    pub readonly: Option<bool>,
    #[serde(default)]
    pub is_primary: Option<bool>,
    #[serde(default)]
    pub options: Value,
    #[serde(default)]
    pub formula: Option<String>,
    #[serde(default)]
    pub ai_prompt: Option<String>,
    #[serde(default)]
    pub meta: Value,
    #[serde(default)]
    pub order: Option<i64>,
}

fn bad(err: KitableError) -> ApiError {
    ApiError::bad_request(err.to_string())
}

fn not_found_table(_: KitableError) -> ApiError {
    ApiError::not_found("Table does not exist")
}

/// `GET /tables`: every table with its schema.
pub fn list_tables(file: &KitableFile, doc: &DocRef) -> ApiResult<Value> {
    let tables = file
        .list_tables()
        .map_err(|_| ApiError::internal("Failed to query table"))?;
    let items: Vec<Value> = tables
        .iter()
        .map(|t| respond::table(doc, t, true))
        .collect();
    Ok(json!({ "total": items.len(), "items": items }))
}

/// `POST /tables`.
pub fn create_table(file: &mut KitableFile, doc: &DocRef, request: &TableSeed) -> ApiResult<Value> {
    let table = file
        .create_table(&seed_to_spec(request))
        .map_err(|_| ApiError::internal("Failed to create table"))?;
    Ok(respond::table(doc, &table, true))
}

/// `PATCH /tables/{tableId}`.
pub fn update_table(
    file: &mut KitableFile,
    doc: &DocRef,
    table_id: i64,
    request: &Map<String, Value>,
) -> ApiResult<Value> {
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
        .map_err(|_| ApiError::internal("Failed to update table"))?;
    Ok(respond::table(doc, &table, true))
}

/// `DELETE /tables/{tableId}`.
pub fn delete_table(file: &mut KitableFile, table_id: i64) -> ApiResult<Value> {
    file.delete_table(table_id).map_err(not_found_table)?;
    Ok(json!({ "message": "Table deleted" }))
}

/// `GET /tables/{tableId}/fields`.
pub fn list_fields(file: &KitableFile, doc: &DocRef, table_id: i64) -> ApiResult<Value> {
    let table = file.get_table(table_id).map_err(not_found_table)?;
    let items: Vec<Value> = table
        .fields
        .iter()
        .map(|f| respond::field(doc, f))
        .collect();
    Ok(json!({ "total": items.len(), "items": items }))
}

/// `POST /tables/{tableId}/fields`.
pub fn create_field(
    file: &mut KitableFile,
    doc: &DocRef,
    table_id: i64,
    request: CreateFieldRequest,
) -> ApiResult<Value> {
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
        .map_err(|_| ApiError::internal("Failed to create field"))?;
    Ok(respond::field(doc, &field))
}

/// `PATCH /tables/{tableId}/fields/{fieldId}`.
pub fn update_field(
    file: &mut KitableFile,
    doc: &DocRef,
    table_id: i64,
    field_id: i64,
    request: &Map<String, Value>,
) -> ApiResult<Value> {
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
    Ok(respond::field(doc, &field))
}

/// `DELETE /tables/{tableId}/fields/{fieldId}`.
pub fn delete_field(file: &mut KitableFile, table_id: i64, field_id: i64) -> ApiResult<Value> {
    file.delete_field(table_id, field_id).map_err(bad)?;
    Ok(json!({ "message": "Field deleted" }))
}

/// `POST /tables/{tableId}/fields/{fieldId}/duplicate`.
pub fn duplicate_field(
    file: &mut KitableFile,
    doc: &DocRef,
    table_id: i64,
    field_id: i64,
) -> ApiResult<Value> {
    let field = file.duplicate_field(table_id, field_id).map_err(bad)?;
    Ok(respond::field(doc, &field))
}

/// `GET /tables/{tableId}/views`.
pub fn list_views(file: &KitableFile, doc: &DocRef, table_id: i64) -> ApiResult<Value> {
    let table = file.get_table(table_id).map_err(not_found_table)?;
    let items: Vec<Value> = table.views.iter().map(|v| respond::view(doc, v)).collect();
    Ok(json!({ "total": items.len(), "items": items }))
}

/// `POST /tables/{tableId}/views`.
pub fn create_view(
    file: &mut KitableFile,
    doc: &DocRef,
    table_id: i64,
    request: ViewSeed,
) -> ApiResult<Value> {
    let spec = ViewSpec {
        title: request.title,
        view_type: request.view_type,
        config: request.config,
    };
    let view = file
        .create_view(table_id, &spec)
        .map_err(|_| ApiError::internal("Failed to create view"))?;
    Ok(respond::view(doc, &view))
}

/// `PATCH /tables/{tableId}/views/{viewId}`.
pub fn update_view(
    file: &mut KitableFile,
    doc: &DocRef,
    table_id: i64,
    view_id: i64,
    request: &Map<String, Value>,
) -> ApiResult<Value> {
    let patch = ViewPatch {
        title: request.get("title").map(|v| as_str(v).to_owned()),
        view_type: request.get("type").map(|v| as_str(v).to_owned()),
        config: request.get("config").cloned(),
    };
    let view = file.update_view(table_id, view_id, &patch).map_err(bad)?;
    Ok(respond::view(doc, &view))
}

/// `DELETE /tables/{tableId}/views/{viewId}`.
pub fn delete_view(file: &mut KitableFile, table_id: i64, view_id: i64) -> ApiResult<Value> {
    file.delete_view(table_id, view_id)
        .map_err(|_| ApiError::not_found("View does not exist"))?;
    Ok(json!({ "message": "View deleted" }))
}
