//! Table, field, and view routes: adapters over `kition_table_api::tables`.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch, post};
use kition_core::AppResult;
use kition_http::{CurrentUser, JsonBody, ok};
use kition_table_api::tables::{self as api, CreateFieldRequest};
pub use kition_table_api::tables::{
    FieldSeed, TableSeed, ViewSeed, default_table_seed, seed_to_spec,
};
use serde_json::{Map, Value};

use crate::source::parse_id;
use crate::{DataDocState, api_error};

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

fn parse_body(body: &[u8]) -> AppResult<Map<String, Value>> {
    kition_http::decode_object(body)
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
            api::list_tables(&file, &doc.doc_ref()).map_err(api_error)
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
            api::create_table(&mut file, &doc.doc_ref(), &request).map_err(api_error)
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
            api::update_table(&mut file, &doc.doc_ref(), table_id, &request).map_err(api_error)
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
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let mut file = state.open_or_500(&doc)?;
            api::delete_table(&mut file, table_id).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
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
            api::list_fields(&file, &doc.doc_ref(), table_id).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
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
            api::create_field(&mut file, &doc.doc_ref(), table_id, request).map_err(api_error)
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
            api::update_field(&mut file, &doc.doc_ref(), table_id, field_id, &request)
                .map_err(api_error)
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
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let field_id = parse_id(&field_id)?;
            let mut file = state.open_or_500(&doc)?;
            api::delete_field(&mut file, table_id, field_id).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
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
            api::duplicate_field(&mut file, &doc.doc_ref(), table_id, field_id).map_err(api_error)
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
            api::list_views(&file, &doc.doc_ref(), table_id).map_err(api_error)
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
            api::create_view(&mut file, &doc.doc_ref(), table_id, request).map_err(api_error)
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
            api::update_view(&mut file, &doc.doc_ref(), table_id, view_id, &request)
                .map_err(api_error)
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
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let table_id = parse_id(&table_id)?;
            let view_id = parse_id(&view_id)?;
            let mut file = state.open_or_500(&doc)?;
            api::delete_view(&mut file, table_id, view_id).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}
