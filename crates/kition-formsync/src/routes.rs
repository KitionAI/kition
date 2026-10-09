//! `/form-sync`: bare JSON responses with `{"error": ...}` failures.

use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRef, Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::StatusCode;
use kition_http::{AuthConfig, CurrentUser};
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::service::Service;
use crate::types::{SaveWorkflowInput, UpdateWorkflowInput};

#[derive(Clone)]
pub struct FormSyncState {
    pub auth: AuthConfig,
    pub service: Service,
}

impl FromRef<FormSyncState> for AuthConfig {
    fn from_ref(state: &FormSyncState) -> Self {
        state.auth.clone()
    }
}

pub fn router(state: FormSyncState) -> Router {
    Router::new()
        .route("/form-sync/workflows", get(list).post(create))
        .route("/form-sync/workflows/{id}", patch(update))
        .route("/form-sync/workflows/{id}/sync", post(sync))
        .with_state(state)
}

/// Runs scheduled syncs every minute until the runtime exits.
pub fn start_scheduler(service: Service) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(60));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(err) = service.sync_due().await {
                tracing::warn!(error = %err, "scheduled form sync failed");
            }
        }
    });
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, axum::Json(json!({ "error": message.into() }))).into_response()
}

fn parse<T: DeserializeOwned>(body: &[u8]) -> Result<T, String> {
    if body.trim_ascii().starts_with(b"[") {
        return Err("json: cannot unmarshal array into object".into());
    }
    serde_json::from_slice(body).map_err(|e| e.to_string())
}

async fn list(State(state): State<FormSyncState>, user: CurrentUser) -> Response {
    match state.service.list(user.id).await {
        Ok(items) => axum::Json(json!({ "items": items })).into_response(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err),
    }
}

async fn create(State(state): State<FormSyncState>, user: CurrentUser, body: Bytes) -> Response {
    let input: SaveWorkflowInput = match parse(&body) {
        Ok(input) => input,
        Err(err) => return error(StatusCode::BAD_REQUEST, err),
    };
    match state.service.create(user.id, input).await {
        Ok(view) => (StatusCode::CREATED, axum::Json(view)).into_response(),
        Err(err) => error(StatusCode::BAD_REQUEST, err),
    }
}

async fn update(
    State(state): State<FormSyncState>,
    user: CurrentUser,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let input: UpdateWorkflowInput = match parse(&body) {
        Ok(input) => input,
        Err(err) => return error(StatusCode::BAD_REQUEST, err),
    };
    match state.service.update(user.id, &id, input).await {
        Ok(Some(view)) => axum::Json(view).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "form sync workflow not found"),
        Err(err) => error(StatusCode::BAD_REQUEST, err),
    }
}

async fn sync(
    State(state): State<FormSyncState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Response {
    match state.service.sync(user.id, &id).await {
        Ok(Some(result)) => axum::Json(result).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "form sync workflow not found"),
        Err((message, result)) => (
            StatusCode::BAD_GATEWAY,
            axum::Json(json!({ "error": message, "result": result })),
        )
            .into_response(),
    }
}
