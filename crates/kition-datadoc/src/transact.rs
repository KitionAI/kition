//! `transact`, `undo`, `redo`, and `history-state`: the Table on the KDM's write path, as
//! adapters over `kition_table_api::transact`.
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
use kition_core::AppResult;
use kition_core::events::DomainEvent;
use kition_http::{CurrentUser, JsonBody, ok};
use kition_kdm::Origin;
use kition_table_api::transact::{self as api, TransactRequest};

use crate::table_documents::{origin_from_headers, table_changed_event};
use crate::{DataDocState, api_error};

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

async fn transact(
    State(state): State<DataDocState>,
    user: CurrentUser,
    RequestOrigin(origin): RequestOrigin,
    Path(document_id): Path<String>,
    JsonBody(request): JsonBody<TransactRequest>,
) -> AppResult<Response> {
    let mut request = request.check().map_err(api_error)?;
    let user_id = user.id;
    let event_origin = origin.clone();
    let (doc, body, change) = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let mut file = state.open_or_500_as(&doc, origin.clone())?;
            state.import_path_attachments_in_ops(&mut file, &mut request.ops);
            let (body, change) =
                api::transact(&mut file, &doc.doc_ref(), &request).map_err(api_error)?;
            Ok((doc, body, change))
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
    Ok(ok(body))
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
    let (doc, body, change) = state
        .blocking(move |state| {
            let doc = state.load_document(user_id, &document_id)?;
            let mut file = state.open_or_500_as(&doc, origin.clone())?;
            let (body, change) =
                api::undo_or_redo(&mut file, &doc.doc_ref(), redo).map_err(api_error)?;
            Ok((doc, body, change))
        })
        .await?;
    if let Some(change) = change {
        state
            .events
            .publish(DomainEvent::TableChanged(table_changed_event(
                &doc.id.to_string(),
                &event_origin,
                &doc.path,
                &change,
            )));
    }
    Ok(ok(body))
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
            Ok(api::history_state(&file))
        })
        .await?;
    Ok(ok(body))
}
