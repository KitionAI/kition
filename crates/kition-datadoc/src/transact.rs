//! `transact`, `undo`, `redo`, and `history-state`: the Table on the KDM's write path.
//!
//! Every request here carries the caller's [`Origin`] in headers (`Kition-Session` for a
//! window, `Kition-Origin` for template seeding before any session exists); a successful
//! mutation's `TableChange` is both returned to the caller and published as a `table/changed`
//! event on the kit bridge stream, so every other open window picks it up too (its own request
//! ignores the echo by comparing `origin`, client-side).

use axum::Router;
use axum::extract::{FromRequestParts, Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::request::Parts;
use kition_core::events::DomainEvent;
use kition_core::{AppError, AppResult};
use kition_http::{CurrentUser, JsonBody, ok};
use kition_kdm::Origin;
use kition_kitable::{KitableError, TableOp};
use serde::Deserialize;
use serde_json::json;

use crate::DataDocState;
use crate::table_documents::{change_json, origin_from_headers, table_changed_event};

pub fn routes() -> Router<DataDocState> {
    Router::new()
        .route("/data-documents/{documentId}/transact", post(transact))
        .route("/data-documents/{documentId}/undo", post(undo))
        .route("/data-documents/{documentId}/redo", post(redo))
        .route(
            "/data-documents/{documentId}/history-state",
            get(history_state),
        )
}

/// `Kition-Session` / `Kition-Origin`, mapped by [`origin_from_headers`].
pub struct RequestOrigin(pub Origin);

impl<S: Send + Sync> FromRequestParts<S> for RequestOrigin {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let header = |name: &str| parts.headers.get(name).and_then(|v| v.to_str().ok());
        Ok(RequestOrigin(origin_from_headers(
            header("Kition-Session"),
            header("Kition-Origin"),
        )))
    }
}

/// A write that the file's `.kitable` layer refused. A read-only file (opened that way because
/// it could not be written, or could not be brought up to date) answers 409, not 400: the
/// request itself was fine, the document just cannot take writes right now.
fn bad(err: KitableError) -> AppError {
    match err {
        KitableError::ReadOnly(reason) => AppError::conflict(reason),
        other => AppError::bad_request(other.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct TransactRequest {
    ops: Vec<TableOp>,
}

async fn transact(
    State(state): State<DataDocState>,
    user: CurrentUser,
    RequestOrigin(origin): RequestOrigin,
    Path(document_id): Path<String>,
    JsonBody(request): JsonBody<TransactRequest>,
) -> AppResult<Response> {
    if request.ops.is_empty() {
        return Err(AppError::bad_request("ops must not be empty"));
    }
    let user_id = user.id;
    let event_origin = origin.clone();
    let (doc, created, change) = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let mut file = state.open_or_500_as(&doc, origin.clone())?;
            let (created, change) = file.transact(&request.ops).map_err(bad)?;
            Ok((doc, created, change))
        })
        .await?;
    state
        .events
        .publish(DomainEvent::TableChanged(table_changed_event(
            &doc.id.to_string(),
            &event_origin,
            &doc.path,
            &change,
        )));
    Ok(ok(json!({
        "change": change_json(&doc.id.to_string(), &event_origin, &change),
        "created": created,
    })))
}

async fn undo(
    State(state): State<DataDocState>,
    user: CurrentUser,
    RequestOrigin(origin): RequestOrigin,
    Path(document_id): Path<String>,
) -> AppResult<Response> {
    undo_or_redo(state, user.id, document_id, origin, false).await
}

async fn redo(
    State(state): State<DataDocState>,
    user: CurrentUser,
    RequestOrigin(origin): RequestOrigin,
    Path(document_id): Path<String>,
) -> AppResult<Response> {
    undo_or_redo(state, user.id, document_id, origin, true).await
}

async fn undo_or_redo(
    state: DataDocState,
    user_id: i64,
    document_id: String,
    origin: Origin,
    redo: bool,
) -> AppResult<Response> {
    let event_origin = origin.clone();
    let (doc, done, change) = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let mut file = state.open_or_500_as(&doc, origin.clone())?;
            let (done, change) = if redo { file.redo() } else { file.undo() }.map_err(bad)?;
            Ok((doc, done, change))
        })
        .await?;
    if done {
        state
            .events
            .publish(DomainEvent::TableChanged(table_changed_event(
                &doc.id.to_string(),
                &event_origin,
                &doc.path,
                &change,
            )));
    }
    Ok(ok(json!({
        "done": done,
        "change": change_json(&doc.id.to_string(), &event_origin, &change),
    })))
}

async fn history_state(
    State(state): State<DataDocState>,
    user: CurrentUser,
    Path(document_id): Path<String>,
) -> AppResult<Response> {
    let user_id = user.id;
    let body = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let file = state.open_or_500(&doc)?;
            Ok(json!({ "canUndo": file.can_undo(), "canRedo": file.can_redo() }))
        })
        .await?;
    Ok(ok(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transact_request_parses_the_contracts_op_shapes() {
        let request: TransactRequest = serde_json::from_value(json!({
            "ops": [
                { "op": "cells.set", "tableId": 1, "records": [{ "rowKey": "r1", "values": { "Name": "Ada" } }] },
                { "op": "records.create", "tableId": 1, "at": null, "records": [{}] },
                { "op": "records.delete", "tableId": 1, "rowKeys": ["r1"] },
                { "op": "records.move", "tableId": 1, "rowKeys": ["r1"], "before": null },
                { "op": "fields.move", "tableId": 1, "fieldIds": [2, 3], "toIndex": 0 },
            ]
        }))
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(request.ops.len(), 5);
    }
}
