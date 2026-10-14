//! `GET /data-documents/{id}/dashboards`, `PUT`/`DELETE …/{dashboardId}`: dashboards as the
//! base's own KDM objects (see `kition_kitable::Dashboard`), replacing the legacy
//! workspace-DB `meta.dashboards` column `DataDocState::migrate_dashboards_from_meta` moves out
//! of, the first time a document with one is opened.

use axum::Router;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::get;
use kition_core::events::DomainEvent;
use kition_core::{AppError, AppResult};
use kition_http::{CurrentUser, JsonBody, ok};
use kition_kdm::Origin;
use kition_kitable::{Dashboard, TableChange};
use serde_json::{Map, Value, json};

use crate::DataDocState;
use crate::index::DataDocument;
use crate::table_documents::{TableHandle, table_changed_event};
use crate::transact::RequestOrigin;

pub fn routes() -> Router<DataDocState> {
    Router::new()
        .route("/data-documents/{documentId}/dashboards", get(list))
        .route(
            "/data-documents/{documentId}/dashboards/{dashboardId}",
            axum::routing::put(upsert).delete(delete),
        )
}

/// A dashboard in the frontend's shape (`src/types/dataDocument.ts`'s `DataDashboard`): `title`
/// is the KDM dashboard's `name`; `order`, `source_table_id`, and `layout` are its `config`;
/// `widgets` is its widgets map, as an array (each widget already carries its own `id`).
fn dashboard_json(dashboard: &Dashboard) -> Value {
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
fn dashboard_from_request(body: &Map<String, Value>) -> (String, Value, Map<String, Value>) {
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

impl DataDocState {
    /// Moves dashboards still in the workspace-DB row's legacy `meta.dashboards` into the file,
    /// as one `system:migrate` transaction, and clears that column — the first time a document
    /// with one is opened and the file does not already have dashboards of its own (so an
    /// already-migrated document, or a concurrent migration by another handle, is a no-op).
    /// Best-effort: a failure here must not fail the open it runs inside of.
    pub(crate) fn migrate_dashboards_from_meta(&self, doc: &DataDocument, file: &mut TableHandle) {
        let Some(legacy) = doc.meta.get("dashboards").and_then(Value::as_array) else {
            return;
        };
        if legacy.is_empty() {
            return;
        }
        let batch: Vec<(String, String, Value, Map<String, Value>)> = legacy
            .iter()
            .filter_map(|item| {
                let id = item.get("id").and_then(Value::as_str)?.to_owned();
                let (title, config, widgets) = dashboard_from_request(item.as_object()?);
                Some((id, title, config, widgets))
            })
            .collect();
        if batch.is_empty() {
            return;
        }
        match file.list_dashboards() {
            Ok(existing) if existing.is_empty() => {}
            _ => return,
        }
        let previous = file.origin().clone();
        file.set_origin(Origin::system("migrate"));
        let result = file.import_dashboards(&batch);
        file.set_origin(previous);
        if let Err(err) = result {
            tracing::warn!(document_id = doc.id, %err, "dashboard migration failed");
            return;
        }
        if let Ok(conn) = self.db.conn() {
            let mut saved = doc.clone();
            if let Value::Object(meta) = &mut saved.meta {
                meta.remove("dashboards");
            }
            let _ = crate::index::save(&conn, &mut saved);
        }
    }
}

fn publish_dashboards_changed(state: &DataDocState, doc: &DataDocument, origin: &Origin) {
    let change = TableChange {
        dashboards: true,
        ..TableChange::default()
    };
    state
        .events
        .publish(DomainEvent::TableChanged(table_changed_event(
            &doc.id.to_string(),
            origin,
            &doc.path,
            &change,
        )));
}

async fn list(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path(document_id): Path<String>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let file = state.open_or_500(&doc)?;
            let items: Vec<Value> = file
                .list_dashboards()
                .map_err(|err| AppError::internal(err.to_string()))?
                .iter()
                .map(dashboard_json)
                .collect();
            Ok(json!({ "items": items, "total": items.len() }))
        })
        .await?;
    Ok(ok(body))
}

async fn upsert(
    State(state): State<DataDocState>,
    user: CurrentUser,
    RequestOrigin(origin): RequestOrigin,
    Path((document_id, dashboard_id)): Path<(String, String)>,
    JsonBody(request): JsonBody<Map<String, Value>>,
) -> AppResult<Response> {
    let user_id = user.id;
    let event_origin = origin.clone();
    let (doc, dashboard) = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let mut file = state.open_or_500_as(&doc, origin.clone())?;
            let (title, config, widgets) = dashboard_from_request(&request);
            let dashboard = file
                .upsert_dashboard(Some(&dashboard_id), &title, config, &widgets)
                .map_err(|err| AppError::bad_request(err.to_string()))?;
            Ok((doc, dashboard))
        })
        .await?;
    publish_dashboards_changed(&state, &doc, &event_origin);
    Ok(ok(dashboard_json(&dashboard)))
}

async fn delete(
    State(state): State<DataDocState>,
    user: CurrentUser,
    RequestOrigin(origin): RequestOrigin,
    Path((document_id, dashboard_id)): Path<(String, String)>,
) -> AppResult<Response> {
    let user_id = user.id;
    let event_origin = origin.clone();
    let doc = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let mut file = state.open_or_500_as(&doc, origin.clone())?;
            file.delete_dashboard(&dashboard_id)
                .map_err(|err| AppError::bad_request(err.to_string()))?;
            Ok(doc)
        })
        .await?;
    publish_dashboards_changed(&state, &doc, &event_origin);
    Ok(ok(json!({ "deleted": true })))
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
