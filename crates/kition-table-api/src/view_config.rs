//! View configuration: filter trees, sorts, groups, grid settings, per-view field layout, and
//! bulk record operations.

use kition_kitable::{
    FilterRule, FilterTree, FilterTreeChild, KitableError, KitableFile, ViewFieldPatch, ViewPatch,
    ViewSort,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::coerce::nullable;
use crate::{ApiError, ApiResult};

/// Not-found becomes `<Resource> not found`; anything else a 500.
fn view_config_error(resource: &str) -> impl Fn(KitableError) -> ApiError + '_ {
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
            ApiError::NotFound(format!("{title} not found"))
        }
        _ => ApiError::Internal(format!("Failed to access {resource}")),
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
pub struct TreePayload {
    #[serde(default, deserialize_with = "nullable")]
    pub conjunction: String,
    #[serde(default, deserialize_with = "nullable")]
    pub children: Vec<ChildPayload>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ChildPayload {
    #[serde(default)]
    pub group: Option<TreePayload>,
    #[serde(default)]
    pub condition: Option<ConditionPayload>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ConditionPayload {
    #[serde(default, deserialize_with = "nullable")]
    pub field_id: i64,
    #[serde(default, deserialize_with = "nullable")]
    pub operator: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Default, Deserialize)]
pub struct TreeRequest {
    #[serde(default)]
    pub tree: Option<TreePayload>,
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

#[derive(Debug, Default, Deserialize)]
pub struct ItemsRequest {
    #[serde(default, deserialize_with = "nullable")]
    pub items: Vec<ItemPayload>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ItemPayload {
    #[serde(default, deserialize_with = "nullable")]
    pub field_id: i64,
    #[serde(default, deserialize_with = "nullable")]
    pub direction: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct ConfigPatch {
    #[serde(default)]
    pub row_height: Option<String>,
    #[serde(default)]
    pub frozen_column_count: Option<i64>,
    #[serde(default)]
    pub search_query: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct ViewFieldRequest {
    #[serde(default)]
    pub visible: Option<bool>,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub position: Option<i64>,
    #[serde(default)]
    pub frozen: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
pub struct BulkRequest {
    #[serde(default, deserialize_with = "nullable")]
    pub row_keys: Vec<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub target_position: i64,
}

/// `GET /views/{viewId}/filter-tree`.
pub fn get_filter_tree(file: &KitableFile, view_id: i64) -> ApiResult<Value> {
    let tree = file
        .load_filter_tree(view_id)
        .map_err(view_config_error("filter tree"))?;
    Ok(json!({ "tree": tree_response(tree.as_ref()) }))
}

/// `PUT /views/{viewId}/filter-tree`: answers the tree as stored.
pub fn put_filter_tree(
    file: &mut KitableFile,
    view_id: i64,
    request: TreeRequest,
) -> ApiResult<Value> {
    let tree = request.tree.map(payload_to_tree);
    file.save_filter_tree(view_id, tree.as_ref())
        .map_err(|err| match err {
            KitableError::InvalidFilterTree(_) => ApiError::bad_request(err.to_string()),
            other => view_config_error("filter tree")(other),
        })?;
    let reloaded = file
        .load_filter_tree(view_id)
        .map_err(view_config_error("filter tree"))?;
    Ok(json!({ "tree": tree_response(reloaded.as_ref()) }))
}

fn items_response(items: &[ViewSort]) -> Value {
    json!({ "items": items.iter().map(|i| json!({ "field_id": i.field_id, "direction": i.direction })).collect::<Vec<_>>() })
}

fn sort_items(request: ItemsRequest) -> Vec<ViewSort> {
    request
        .items
        .into_iter()
        .map(|i| ViewSort {
            field_id: i.field_id,
            direction: i.direction,
        })
        .collect()
}

/// `GET /views/{viewId}/sorts`.
pub fn get_sorts(file: &KitableFile, view_id: i64) -> ApiResult<Value> {
    Ok(items_response(
        &file
            .list_view_sorts(view_id)
            .map_err(view_config_error("sorts"))?,
    ))
}

/// `PUT /views/{viewId}/sorts`.
pub fn put_sorts(file: &mut KitableFile, view_id: i64, request: ItemsRequest) -> ApiResult<Value> {
    let items = sort_items(request);
    file.replace_view_sorts(view_id, &items)
        .map_err(view_config_error("sorts"))?;
    Ok(items_response(&items))
}

/// `GET /views/{viewId}/groups`.
pub fn get_groups(file: &KitableFile, view_id: i64) -> ApiResult<Value> {
    Ok(items_response(
        &file
            .list_view_groups(view_id)
            .map_err(view_config_error("groups"))?,
    ))
}

/// `PUT /views/{viewId}/groups`.
pub fn put_groups(file: &mut KitableFile, view_id: i64, request: ItemsRequest) -> ApiResult<Value> {
    let items = sort_items(request);
    file.replace_view_groups(view_id, &items)
        .map_err(view_config_error("groups"))?;
    Ok(items_response(&items))
}

/// `PATCH /views/{viewId}/config`: row height, frozen columns, and search; a blank text value
/// removes its key.
pub fn patch_config(
    file: &mut KitableFile,
    table_id: i64,
    view_id: i64,
    request: ConfigPatch,
) -> ApiResult<Value> {
    let table = file
        .get_table(table_id)
        .map_err(|_| ApiError::not_found("Table does not exist"))?;
    let view = table
        .views
        .iter()
        .find(|view| view.id == view_id)
        .ok_or_else(|| ApiError::not_found("View does not exist"))?;
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
            return Err(ApiError::bad_request("frozen_column_count must be >= 0"));
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
}

/// `GET /views/{viewId}/view-fields`.
pub fn list_view_fields(file: &KitableFile, view_id: i64) -> ApiResult<Value> {
    let items = file
        .list_view_fields(view_id)
        .map_err(view_config_error("view fields"))?;
    Ok(json!({ "items": items }))
}

/// `PATCH /views/{viewId}/view-fields/{fieldId}`.
pub fn patch_view_field(
    file: &mut KitableFile,
    view_id: i64,
    field_id: i64,
    request: ViewFieldRequest,
) -> ApiResult<Value> {
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
}

/// `POST /records/bulk-delete`.
pub fn bulk_delete(
    file: &mut KitableFile,
    table_id: i64,
    request: BulkRequest,
) -> ApiResult<Value> {
    let result = file
        .bulk_delete_records(table_id, &request.row_keys)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    Ok(json!({ "deleted_count": result.deleted_count, "missing_keys": result.missing_keys }))
}

/// `POST /records/bulk-copy`.
pub fn bulk_copy(file: &mut KitableFile, table_id: i64, request: BulkRequest) -> ApiResult<Value> {
    let result = file
        .bulk_copy_records(table_id, &request.row_keys, request.target_position)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    Ok(json!({ "copied_count": result.copied_count, "new_row_keys": result.new_row_keys }))
}
