//! Dashboards: the base's own KDM objects (see `kition_kitable::Dashboard`), in the frontend's
//! `DataDashboard` shape.

use kition_kitable::{Dashboard, KitableFile};
use serde_json::{Map, Value, json};

use crate::{ApiError, ApiResult};

/// A dashboard in the frontend's shape (`src/types/dataDocument.ts`'s `DataDashboard`): `title`
/// is the KDM dashboard's `name`; `order`, `source_table_id`, and `layout` are its `config`;
/// `widgets` is its widgets map, as an array (each widget already carries its own `id`).
pub fn dashboard_json(dashboard: &Dashboard) -> Value {
    let config = dashboard.config.as_object().cloned().unwrap_or_default();
    let mut widgets: Vec<Value> = dashboard.widgets.values().cloned().collect();
    widgets.sort_by(|a, b| {
        let id = |v: &Value| {
            v.get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        id(a).cmp(&id(b))
    });
    json!({
        "id": dashboard.id,
        "title": dashboard.name,
        "order": config.get("order").cloned().unwrap_or(json!(0)),
        "source_table_id": config.get("source_table_id").cloned().unwrap_or(Value::Null),
        "layout": config.get("layout").cloned().unwrap_or(json!([])),
        "widgets": widgets,
    })
}

/// The `name`, `config`, and widgets map a PUT body's `DataDashboard` splits into, the inverse
/// of [`dashboard_json`].
pub fn dashboard_from_request(body: &Map<String, Value>) -> (String, Value, Map<String, Value>) {
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let config = json!({
        "order": body.get("order").cloned().unwrap_or(json!(0)),
        "source_table_id": body.get("source_table_id").cloned().unwrap_or(Value::Null),
        "layout": body.get("layout").cloned().unwrap_or(json!([])),
    });
    let widgets: Map<String, Value> = body
        .get("widgets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|widget| {
            let id = widget.get("id").and_then(Value::as_str)?.to_owned();
            Some((id, widget.clone()))
        })
        .collect();
    (title, config, widgets)
}

/// `GET /dashboards`.
pub fn list(file: &KitableFile) -> ApiResult<Value> {
    let items: Vec<Value> = file
        .list_dashboards()
        .map_err(|err| ApiError::internal(err.to_string()))?
        .iter()
        .map(dashboard_json)
        .collect();
    Ok(json!({ "items": items, "total": items.len() }))
}

/// `PUT /dashboards/{dashboardId}`: creates or replaces the dashboard.
pub fn upsert(
    file: &mut KitableFile,
    dashboard_id: &str,
    request: &Map<String, Value>,
) -> ApiResult<Value> {
    let (title, config, widgets) = dashboard_from_request(request);
    let dashboard = file
        .upsert_dashboard(Some(dashboard_id), &title, config, &widgets)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    Ok(dashboard_json(&dashboard))
}

/// `DELETE /dashboards/{dashboardId}`.
pub fn delete(file: &mut KitableFile, dashboard_id: &str) -> ApiResult<Value> {
    file.delete_dashboard(dashboard_id)
        .map_err(|err| ApiError::bad_request(err.to_string()))?;
    Ok(json!({ "deleted": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_json_round_trips_through_the_request_shape() {
        let dashboard = Dashboard {
            id: "d1".into(),
            name: "Overview".into(),
            config: json!({ "order": 2, "source_table_id": 7, "layout": [{ "widget_id": "w1" }] }),
            widgets: Map::from_iter([(
                "w1".to_owned(),
                json!({ "id": "w1", "title": "Count", "type": "metric" }),
            )]),
        };
        let json = dashboard_json(&dashboard);
        assert_eq!(json["id"], "d1");
        assert_eq!(json["title"], "Overview");
        assert_eq!(json["order"], 2);
        assert_eq!(json["source_table_id"], 7);
        assert_eq!(
            json["widgets"],
            json!([{ "id": "w1", "title": "Count", "type": "metric" }])
        );

        let body = json.as_object().cloned().unwrap_or_default();
        let (title, config, widgets) = dashboard_from_request(&body);
        assert_eq!(title, "Overview");
        assert_eq!(config["source_table_id"], 7);
        assert_eq!(widgets.get("w1"), dashboard.widgets.get("w1"));
    }
}
