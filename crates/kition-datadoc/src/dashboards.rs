//! `GET /data-documents/{id}/dashboards`, `PUT`/`DELETE …/{dashboardId}`: dashboards as the
//! base's own KDM objects (see `kition_kitable::Dashboard`), replacing the legacy
//! workspace-DB `meta.dashboards` column `DataDocState::migrate_dashboards_from_meta` moves out
//! of, the first time a document with one is opened.

use axum::Router;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::get;
use kition_core::AppResult;
use kition_core::events::DomainEvent;
use kition_http::{CurrentUser, JsonBody, ok};
use kition_kdm::Origin;
use kition_kitable::TableChange;
use kition_table_api::dashboards::{self as api, dashboard_from_request};
use serde_json::{Map, Value};

use crate::index::DataDocument;
use crate::table_documents::{TableHandle, table_changed_event};
use crate::transact::RequestOrigin;
use crate::{DataDocState, api_error};

pub fn routes() -> Router<DataDocState> {
    Router::new()
        .route("/data-documents/{documentId}/dashboards", get(list))
        .route(
            "/data-documents/{documentId}/dashboards/{dashboardId}",
            axum::routing::put(upsert).delete(delete),
        )
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
            api::list(&file).map_err(api_error)
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
    let (doc, body) = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let mut file = state.open_or_500_as(&doc, origin.clone())?;
            let body = api::upsert(&mut file, &dashboard_id, &request).map_err(api_error)?;
            Ok((doc, body))
        })
        .await?;
    publish_dashboards_changed(&state, &doc, &event_origin);
    Ok(ok(body))
}

async fn delete(
    State(state): State<DataDocState>,
    user: CurrentUser,
    RequestOrigin(origin): RequestOrigin,
    Path((document_id, dashboard_id)): Path<(String, String)>,
) -> AppResult<Response> {
    let user_id = user.id;
    let event_origin = origin.clone();
    let (doc, body) = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let mut file = state.open_or_500_as(&doc, origin.clone())?;
            let body = api::delete(&mut file, &dashboard_id).map_err(api_error)?;
            Ok((doc, body))
        })
        .await?;
    publish_dashboards_changed(&state, &doc, &event_origin);
    Ok(ok(body))
}
