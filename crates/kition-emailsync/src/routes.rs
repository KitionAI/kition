//! `/email-sync`: bare JSON responses with `{"error": ...}` failures.

use std::collections::HashMap;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRef, Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::StatusCode;
use kition_http::{AuthConfig, CurrentUser};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::json;

use crate::service::{Service, ServiceError};
use crate::types::SaveWorkflowInput;

#[derive(Clone)]
pub struct EmailSyncState {
    pub auth: AuthConfig,
    pub service: Service,
}

impl FromRef<EmailSyncState> for AuthConfig {
    fn from_ref(state: &EmailSyncState) -> Self {
        state.auth.clone()
    }
}

pub fn router(state: EmailSyncState) -> Router {
    Router::new()
        .route("/email-sync/workflows", get(list).post(create))
        .route("/email-sync/workflows/{id}", patch(update).delete(delete))
        .route("/email-sync/workflows/{id}/test", post(test))
        .route("/email-sync/workflows/{id}/sync", post(sync))
        .route("/email-sync/workflows/{id}/sync-all", post(sync_all))
        .route("/email-sync/workflows/{id}/runs", post(create_run))
        .route("/email-sync/runs", get(list_runs))
        .route("/email-sync/runs/{id}", get(get_run))
        .route("/email-sync/runs/{id}/cancel", post(cancel_run))
        .route("/email-sync/runs/{id}/retry", post(retry_run))
        .with_state(state)
}

/// Resumes interrupted runs, then starts scheduled syncs every minute.
pub fn start_scheduler(service: Service) {
    tokio::spawn(async move {
        if let Err(err) = service.recover_runs().await {
            tracing::warn!(error = %err, "recovering email sync runs failed");
        }
        let mut ticker = tokio::time::interval(Duration::from_secs(60));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(err) = service.sync_due().await {
                tracing::warn!(error = %err, "scheduled email sync failed");
            }
        }
    });
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, axum::Json(json!({ "error": message.into() }))).into_response()
}

fn service_error(err: ServiceError) -> Response {
    match err {
        ServiceError::RunActive => error(StatusCode::CONFLICT, err.message()),
        ServiceError::Sync(sync) => (
            StatusCode::BAD_GATEWAY,
            axum::Json(json!({ "error": sync.message, "error_code": sync.code_or_default() })),
        )
            .into_response(),
        ServiceError::Invalid(message) => error(StatusCode::BAD_REQUEST, message),
        ServiceError::Internal(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

fn parse<T: DeserializeOwned>(body: &[u8]) -> Result<T, String> {
    if body.trim_ascii().starts_with(b"[") {
        return Err("json: cannot unmarshal array into object".into());
    }
    serde_json::from_slice(body).map_err(|e| e.to_string())
}

fn not_found_workflow() -> Response {
    error(StatusCode::NOT_FOUND, "email sync workflow not found")
}

fn not_found_run() -> Response {
    error(StatusCode::NOT_FOUND, "email sync run not found")
}

async fn list(State(state): State<EmailSyncState>, user: CurrentUser) -> Response {
    match state.service.list(user.id).await {
        Ok(items) => axum::Json(json!({ "items": items })).into_response(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.message()),
    }
}

async fn create(State(state): State<EmailSyncState>, user: CurrentUser, body: Bytes) -> Response {
    let input: SaveWorkflowInput = match parse(&body) {
        Ok(input) => input,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    match state.service.create(user.id, input).await {
        Ok(view) => (StatusCode::CREATED, axum::Json(view)).into_response(),
        Err(err) => service_error(err),
    }
}

async fn update(
    State(state): State<EmailSyncState>,
    user: CurrentUser,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let input: SaveWorkflowInput = match parse(&body) {
        Ok(input) => input,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    match state.service.update(user.id, &id, input).await {
        Ok(Some(view)) => axum::Json(view).into_response(),
        Ok(None) => not_found_workflow(),
        Err(err) => service_error(err),
    }
}

async fn delete(
    State(state): State<EmailSyncState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Response {
    match state.service.delete(user.id, &id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => not_found_workflow(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.message()),
    }
}

async fn test(
    State(state): State<EmailSyncState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Response {
    match state.service.test(user.id, &id).await {
        Ok(Some(result)) => {
            let status = if result.ok {
                StatusCode::OK
            } else {
                StatusCode::BAD_GATEWAY
            };
            (status, axum::Json(result)).into_response()
        }
        Ok(None) => not_found_workflow(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.message()),
    }
}

async fn run_sync(state: &EmailSyncState, user_id: i64, id: &str, all: bool) -> Response {
    match state.service.sync(user_id, id, all).await {
        Ok(Some(result)) => axum::Json(result).into_response(),
        Ok(None) => not_found_workflow(),
        Err((message, result)) => (
            StatusCode::BAD_GATEWAY,
            axum::Json(json!({ "error": message, "result": result })),
        )
            .into_response(),
    }
}

async fn sync(
    State(state): State<EmailSyncState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Response {
    run_sync(&state, user.id, &id, false).await
}

async fn sync_all(
    State(state): State<EmailSyncState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Response {
    run_sync(&state, user.id, &id, true).await
}

#[derive(Debug, Default, Deserialize)]
struct RunInput {
    #[serde(default)]
    mode: Option<String>,
}

async fn create_run(
    State(state): State<EmailSyncState>,
    user: CurrentUser,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let input: RunInput = match parse(&body) {
        Ok(input) => input,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    match state
        .service
        .create_run(user.id, &id, &input.mode.unwrap_or_default(), true)
        .await
    {
        Ok(Some(run)) => (StatusCode::ACCEPTED, axum::Json(run)).into_response(),
        Ok(None) => not_found_workflow(),
        Err(err) => service_error(err),
    }
}

async fn list_runs(
    State(state): State<EmailSyncState>,
    user: CurrentUser,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let limit = query
        .get("limit")
        .map_or(Some(50), |v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let workflow_id = query.get("workflow_id").cloned().unwrap_or_default();
    match state.service.store.list_runs(user.id, &workflow_id, limit) {
        Ok(runs) => axum::Json(json!({ "items": runs })).into_response(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.message.clone()),
    }
}

async fn get_run(
    State(state): State<EmailSyncState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Response {
    match state.service.store.get_run(user.id, &id) {
        Ok(Some(run)) => axum::Json(run).into_response(),
        Ok(None) => not_found_run(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.message.clone()),
    }
}

async fn cancel_run(
    State(state): State<EmailSyncState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Response {
    match state.service.store.request_cancellation(user.id, &id) {
        Ok(Some(run)) => axum::Json(run).into_response(),
        Ok(None) => not_found_run(),
        Err(err) => error(StatusCode::INTERNAL_SERVER_ERROR, err.message.clone()),
    }
}

async fn retry_run(
    State(state): State<EmailSyncState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Response {
    match state.service.retry_run(user.id, &id).await {
        Ok(Some(run)) => (StatusCode::ACCEPTED, axum::Json(run)).into_response(),
        Ok(None) => not_found_run(),
        Err(err) => service_error(err),
    }
}
