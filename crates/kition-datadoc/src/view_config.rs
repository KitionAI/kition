//! View configuration routes (filter trees, sorts, groups, grid settings, per-view field
//! layout, and bulk record operations): adapters over `kition_table_api::view_config`.

use axum::Router;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch, post};
use kition_core::AppResult;
use kition_http::{CurrentUser, JsonBody, ok};
use kition_table_api::view_config::{
    self as api, BulkRequest, ConfigPatch, ItemsRequest, TreeRequest, ViewFieldRequest,
};

use crate::source::parse_id;
use crate::table_documents::TableHandle;
use crate::{DataDocState, api_error};

pub fn routes() -> Router<DataDocState> {
    let view = "/data-documents/{documentId}/tables/{tableId}/views/{viewId}";
    Router::new()
        .route(
            &format!("{view}/filter-tree"),
            get(get_filter_tree).put(put_filter_tree),
        )
        .route(&format!("{view}/sorts"), get(get_sorts).put(put_sorts))
        .route(&format!("{view}/groups"), get(get_groups).put(put_groups))
        .route(&format!("{view}/config"), patch(patch_config))
        .route(&format!("{view}/view-fields"), get(list_view_fields))
        .route(
            &format!("{view}/view-fields/{{fieldId}}"),
            patch(patch_view_field),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/records/bulk-delete",
            post(bulk_delete),
        )
        .route(
            "/data-documents/{documentId}/tables/{tableId}/records/bulk-copy",
            post(bulk_copy),
        )
}

type ViewPath = Path<(String, String, String)>;

impl DataDocState {
    fn open_view(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
        view_id: &str,
    ) -> AppResult<(TableHandle, i64, i64)> {
        let doc = self.load_document(user_id, document_id)?;
        let table_id = parse_id(table_id)?;
        let view_id = parse_id(view_id)?;
        Ok((self.open_or_500(&doc)?, view_id, table_id))
    }

    fn open_table(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
    ) -> AppResult<(TableHandle, i64)> {
        let doc = self.load_document(user_id, document_id)?;
        let table_id = parse_id(table_id)?;
        Ok((self.open_or_500(&doc)?, table_id))
    }
}

async fn get_filter_tree(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((d, t, v)): ViewPath,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let (file, view_id, _) = state.open_view(user_id, &d, &t, &v)?;
            api::get_filter_tree(&file, view_id).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}

async fn put_filter_tree(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((d, t, v)): ViewPath,
    JsonBody(request): JsonBody<TreeRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let (mut file, view_id, _) = state.open_view(user_id, &d, &t, &v)?;
            api::put_filter_tree(&mut file, view_id, request).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}

async fn get_sorts(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((d, t, v)): ViewPath,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let (file, view_id, _) = state.open_view(user_id, &d, &t, &v)?;
            api::get_sorts(&file, view_id).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}

async fn put_sorts(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((d, t, v)): ViewPath,
    JsonBody(request): JsonBody<ItemsRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let (mut file, view_id, _) = state.open_view(user_id, &d, &t, &v)?;
            api::put_sorts(&mut file, view_id, request).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}

async fn get_groups(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((d, t, v)): ViewPath,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let (file, view_id, _) = state.open_view(user_id, &d, &t, &v)?;
            api::get_groups(&file, view_id).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}

async fn put_groups(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((d, t, v)): ViewPath,
    JsonBody(request): JsonBody<ItemsRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let (mut file, view_id, _) = state.open_view(user_id, &d, &t, &v)?;
            api::put_groups(&mut file, view_id, request).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}

async fn patch_config(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((d, t, v)): ViewPath,
    JsonBody(request): JsonBody<ConfigPatch>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let (mut file, view_id, table_id) = state.open_view(user_id, &d, &t, &v)?;
            api::patch_config(&mut file, table_id, view_id, request).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}

async fn list_view_fields(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((d, t, v)): ViewPath,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let (file, view_id, _) = state.open_view(user_id, &d, &t, &v)?;
            api::list_view_fields(&file, view_id).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}

async fn patch_view_field(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((d, t, v, field_id)): Path<(String, String, String, String)>,
    JsonBody(request): JsonBody<ViewFieldRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let (mut file, view_id, _) = state.open_view(user_id, &d, &t, &v)?;
            let field_id = parse_id(&field_id)?;
            api::patch_view_field(&mut file, view_id, field_id, request).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}

async fn bulk_delete(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((d, t)): Path<(String, String)>,
    JsonBody(request): JsonBody<BulkRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let (mut file, table_id) = state.open_table(user_id, &d, &t)?;
            api::bulk_delete(&mut file, table_id, request).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}

async fn bulk_copy(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path((d, t)): Path<(String, String)>,
    JsonBody(request): JsonBody<BulkRequest>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let (mut file, table_id) = state.open_table(user_id, &d, &t)?;
            api::bulk_copy(&mut file, table_id, request).map_err(api_error)
        })
        .await?;
    Ok(ok(body))
}
