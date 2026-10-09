//! View configuration handlers: filter trees, sorts, groups, grid settings,
//! per-view field layout, and bulk record operations.

use axum::Router;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch, post};
use kition_core::coerce::nullable;
use kition_core::{AppError, AppResult};
use kition_http::{CurrentUser, JsonBody, ok};
use kition_kitable::{
    FilterRule, FilterTree, FilterTreeChild, KitableError, KitableFile, ViewFieldPatch, ViewPatch,
    ViewSort,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::DataDocState;
use crate::source::parse_id;

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

/// Not-found becomes `<Resource> not found`; anything else a 500.
fn view_config_error(resource: &str) -> impl Fn(KitableError) -> AppError + '_ {
    move |err| match err {
        KitableError::NotFound => {
            let title = resource
                .split(' ')
                .map(|word| {
                    let mut chars = word.chars();
                    chars
                        .next()
                        .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join(" ");
            AppError::not_found(format!("{title} not found"))
        }
        _ => AppError::internal(format!("Failed to access {resource}")),
    }
}

impl DataDocState {
    fn open_view(
        &self,
        user_id: i64,
        document_id: &str,
        table_id: &str,
        view_id: &str,
    ) -> AppResult<(KitableFile, i64, i64)> {
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
    ) -> AppResult<(KitableFile, i64)> {
        let doc = self.load_document(user_id, document_id)?;
        let table_id = parse_id(table_id)?;
        Ok((self.open_or_500(&doc)?, table_id))
    }
}

fn tree_response(tree: Option<&FilterTree>) -> Value {
    let Some(tree) = tree else { return Value::Null };
    let children: Vec<Value> = tree
        .children
        .iter()
        .filter_map(|child| match (&child.group, &child.condition) {
            (Some(group), _) => Some(json!({ "group": tree_response(Some(group)) })),
            (None, Some(c)) => Some(json!({ "condition": { "field_id": c.field_id, "operator": c.operator, "value": c.value } })),
            _ => None,
        })
        .collect();
    json!({ "conjunction": tree.conjunction, "children": children })
}

#[derive(Debug, Default, Deserialize)]
struct TreePayload {
    #[serde(default, deserialize_with = "nullable")]
    conjunction: String,
    #[serde(default, deserialize_with = "nullable")]
    children: Vec<ChildPayload>,
}

#[derive(Debug, Default, Deserialize)]
struct ChildPayload {
    #[serde(default)]
    group: Option<TreePayload>,
    #[serde(default)]
    condition: Option<ConditionPayload>,
}

#[derive(Debug, Default, Deserialize)]
struct ConditionPayload {
    #[serde(default, deserialize_with = "nullable")]
    field_id: i64,
    #[serde(default, deserialize_with = "nullable")]
    operator: String,
    #[serde(default)]
    value: Value,
}

#[derive(Debug, Default, Deserialize)]
struct TreeRequest {
    #[serde(default)]
    tree: Option<TreePayload>,
}

fn payload_to_tree(payload: TreePayload) -> FilterTree {
    FilterTree {
        conjunction: payload.conjunction.trim().to_lowercase(),
        children: payload
            .children
            .into_iter()
            .filter_map(|child| match (child.group, child.condition) {
                (Some(group), _) => Some(FilterTreeChild {
                    group: Some(Box::new(payload_to_tree(group))),
                    condition: None,
                }),
                (None, Some(c)) => Some(FilterTreeChild {
                    group: None,
                    condition: Some(FilterRule {
                        field_id: c.field_id,
                        operator: c.operator.trim().to_owned(),
                        value: c.value,
                    }),
                }),
                _ => None,
            })
            .collect(),
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
            let tree = file
                .load_filter_tree(view_id)
                .map_err(view_config_error("filter tree"))?;
            Ok(json!({ "tree": tree_response(tree.as_ref()) }))
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
            let tree = request.tree.map(payload_to_tree);
            file.save_filter_tree(view_id, tree.as_ref())
                .map_err(|err| match err {
                    KitableError::InvalidFilterTree(_) => AppError::bad_request(err.to_string()),
                    other => view_config_error("filter tree")(other),
                })?;
            let reloaded = file
                .load_filter_tree(view_id)
                .map_err(view_config_error("filter tree"))?;
            Ok(json!({ "tree": tree_response(reloaded.as_ref()) }))
        })
        .await?;
    Ok(ok(body))
}

#[derive(Debug, Default, Deserialize)]
struct ItemsRequest {
    #[serde(default, deserialize_with = "nullable")]
    items: Vec<ItemPayload>,
}

#[derive(Debug, Default, Deserialize)]
struct ItemPayload {
    #[serde(default, deserialize_with = "nullable")]
    field_id: i64,
    #[serde(default, deserialize_with = "nullable")]
    direction: String,
}

fn items_response(items: &[ViewSort]) -> Value {
    json!({ "items": items.iter().map(|i| json!({ "field_id": i.field_id, "direction": i.direction })).collect::<Vec<_>>() })
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
            Ok(items_response(
                &file
                    .list_view_sorts(view_id)
                    .map_err(view_config_error("sorts"))?,
            ))
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
            let items: Vec<ViewSort> = request
                .items
                .into_iter()
                .map(|i| ViewSort {
                    field_id: i.field_id,
                    direction: i.direction,
                })
                .collect();
            file.replace_view_sorts(view_id, &items)
                .map_err(view_config_error("sorts"))?;
            Ok(items_response(&items))
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
            Ok(items_response(
                &file
                    .list_view_groups(view_id)
                    .map_err(view_config_error("groups"))?,
            ))
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
            let items: Vec<ViewSort> = request
                .items
                .into_iter()
                .map(|i| ViewSort {
                    field_id: i.field_id,
                    direction: i.direction,
                })
                .collect();
            file.replace_view_groups(view_id, &items)
                .map_err(view_config_error("groups"))?;
            Ok(items_response(&items))
        })
        .await?;
    Ok(ok(body))
}

#[derive(Debug, Default, Deserialize)]
struct ConfigPatch {
    #[serde(default)]
    row_height: Option<String>,
    #[serde(default)]
    frozen_column_count: Option<i64>,
    #[serde(default)]
    search_query: Option<String>,
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
            let table = file
                .get_table(table_id)
                .map_err(|_| AppError::not_found("Table does not exist"))?;
            let view = table
                .views
                .iter()
                .find(|view| view.id == view_id)
                .ok_or_else(|| AppError::not_found("View does not exist"))?;
            let mut config = view.config.clone();
            let mut set_text = |key: &str, value: Option<String>| {
                if let Some(value) = value {
                    let value = value.trim().to_owned();
                    if value.is_empty() {
                        config.remove(key);
                    } else {
                        config.insert(key.to_owned(), Value::String(value));
                    }
                }
            };
            set_text("row_height", request.row_height);
            set_text("search_query", request.search_query);
            if let Some(count) = request.frozen_column_count {
                if count < 0 {
                    return Err(AppError::bad_request("frozen_column_count must be >= 0"));
                }
                config.insert("frozen_column_count".to_owned(), Value::from(count));
            }
            let updated = file
                .update_view(
                    table_id,
                    view_id,
                    &ViewPatch {
                        config: Some(Value::Object(config)),
                        ..ViewPatch::default()
                    },
                )
                .map_err(view_config_error("view config"))?;
            Ok(json!({ "config": updated.config }))
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
            let items = file
                .list_view_fields(view_id)
                .map_err(view_config_error("view fields"))?;
            Ok(json!({ "items": items }))
        })
        .await?;
    Ok(ok(body))
}

#[derive(Debug, Default, Deserialize)]
struct ViewFieldRequest {
    #[serde(default)]
    visible: Option<bool>,
    #[serde(default)]
    width: Option<i64>,
    #[serde(default)]
    position: Option<i64>,
    #[serde(default)]
    frozen: Option<bool>,
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
            let patch = ViewFieldPatch {
                visible: request.visible,
                width: request.width,
                position: request.position,
                frozen: request.frozen,
            };
            let field = file
                .upsert_view_field(view_id, field_id, &patch)
                .map_err(view_config_error("view field"))?;
            Ok(serde_json::to_value(field)?)
        })
        .await?;
    Ok(ok(body))
}

#[derive(Debug, Default, Deserialize)]
struct BulkRequest {
    #[serde(default, deserialize_with = "nullable")]
    row_keys: Vec<String>,
    #[serde(default, deserialize_with = "nullable")]
    target_position: i64,
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
            let result = file
                .bulk_delete_records(table_id, &request.row_keys)
                .map_err(|err| AppError::bad_request(err.to_string()))?;
            Ok(json!({ "deleted_count": result.deleted_count, "missing_keys": result.missing_keys }))
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
            let result = file
                .bulk_copy_records(table_id, &request.row_keys, request.target_position)
                .map_err(|err| AppError::bad_request(err.to_string()))?;
            Ok(json!({ "copied_count": result.copied_count, "new_row_keys": result.new_row_keys }))
        })
        .await?;
    Ok(ok(body))
}
