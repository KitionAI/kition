//! `/channels` and `/connections`. These endpoints answer with bare JSON
//! (no envelope) and `{"error": ...}` failures, as the client expects.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{FromRef, Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::StatusCode;
use kition_core::AppResult;
use kition_http::{AuthConfig, CurrentUser};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::channel;
use crate::secret::SecretBag;
use crate::store::{CHANNEL_EMAIL_SMTP, Store, TestResult, UpsertInput};

/// Counts workflows that reference a connection.
pub type UsedByCounter = Arc<dyn Fn(&str) -> usize + Send + Sync>;

#[derive(Clone)]
pub struct ConnectionsState {
    pub auth: AuthConfig,
    pub store: Store,
    pub used_by: Option<UsedByCounter>,
}

impl FromRef<ConnectionsState> for AuthConfig {
    fn from_ref(state: &ConnectionsState) -> Self {
        state.auth.clone()
    }
}

impl ConnectionsState {
    fn used_by(&self, id: &str) -> usize {
        self.used_by.as_ref().map_or(0, |count| count(id))
    }
}

pub fn router(state: ConnectionsState) -> Router {
    Router::new()
        .route("/channels", get(channels))
        .route("/connections", get(list).post(create))
        .route(
            "/connections/{id}",
            get(detail).patch(update).delete(delete),
        )
        .route("/connections/{id}/test", post(test))
        .with_state(state)
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, axum::Json(json!({ "error": message.into() }))).into_response()
}

fn internal(message: impl ToString) -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, message.to_string())
}

async fn channels(_user: CurrentUser) -> Response {
    axum::Json(json!([channel::schema()])).into_response()
}

async fn list(State(state): State<ConnectionsState>, user: CurrentUser) -> AppResult<Response> {
    let conn = state.store.db.conn()?;
    let rows = match state.store.list(&conn, user.id) {
        Ok(rows) => rows,
        Err(err) => return Ok(internal(err)),
    };
    let items: Vec<_> = rows
        .iter()
        .map(|row| row.view(state.used_by(&row.id)))
        .collect();
    Ok(axum::Json(json!({ "items": items })).into_response())
}

async fn detail(
    State(state): State<ConnectionsState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let conn = state.store.db.conn()?;
    Ok(match state.store.get(&conn, user.id, &id) {
        Err(err) => internal(err),
        Ok(None) => error(StatusCode::NOT_FOUND, "connection not found"),
        Ok(Some(row)) => axum::Json(row.view(state.used_by(&row.id))).into_response(),
    })
}

#[derive(Debug, Default, Deserialize)]
struct SaveRequest {
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    settings: Option<Map<String, Value>>,
    #[serde(default)]
    secrets: Option<SecretBag>,
}

fn parse_save(body: &[u8]) -> Result<SaveRequest, Box<Response>> {
    if body.trim_ascii().starts_with(b"[") {
        return Err(Box::new(error(
            StatusCode::BAD_REQUEST,
            "json: cannot unmarshal array into object",
        )));
    }
    serde_json::from_slice(body)
        .map_err(|err| Box::new(error(StatusCode::BAD_REQUEST, err.to_string())))
}

/// Test & Save: inserts the row, verifies it, and removes it again when the
/// verification fails.
async fn create(
    State(state): State<ConnectionsState>,
    user: CurrentUser,
    body: Bytes,
) -> AppResult<Response> {
    let request = match parse_save(&body) {
        Ok(request) => request,
        Err(response) => return Ok(*response),
    };
    let channel_name = request.channel.unwrap_or_default();
    if channel_name != CHANNEL_EMAIL_SMTP {
        return Ok(error(StatusCode::BAD_REQUEST, "unsupported channel"));
    }
    let name = request.name.unwrap_or_default();
    if name.trim().is_empty() {
        return Ok(error(StatusCode::BAD_REQUEST, "name required"));
    }
    let settings = request.settings.unwrap_or_default();
    let secrets = request.secrets.unwrap_or_default();
    if let Err(message) = channel::validate(&settings, &secrets) {
        return Ok(error(StatusCode::BAD_REQUEST, message));
    }
    let conn = state.store.db.conn()?;
    let mut row = match state.store.create(
        &conn,
        user.id,
        UpsertInput {
            channel: channel_name,
            name,
            settings: Some(settings),
            secrets,
        },
    ) {
        Ok(row) => row,
        Err(err) => return Ok(internal(err)),
    };
    let bag = match state.store.open_secrets(&row) {
        Ok(bag) => bag,
        Err(err) => {
            let _ = state.store.delete(&conn, user.id, &row.id);
            return Ok(internal(err));
        }
    };
    drop(conn);
    let result = channel::test(&row, &bag).await;
    let conn = state.store.db.conn()?;
    if !result.ok {
        let _ = state.store.delete(&conn, user.id, &row.id);
        return Ok((
            StatusCode::BAD_GATEWAY,
            axum::Json(json!({ "error": result.message, "errorCode": result.error_code })),
        )
            .into_response());
    }
    let _ = state.store.mark_test_result(&conn, &mut row, &result);
    Ok((
        StatusCode::CREATED,
        axum::Json(row.view(state.used_by(&row.id))),
    )
        .into_response())
}

/// Saves the change, then re-verifies and records the outcome; always 200
/// once the row is updated.
async fn update(
    State(state): State<ConnectionsState>,
    user: CurrentUser,
    Path(id): Path<String>,
    body: Bytes,
) -> AppResult<Response> {
    let request = match parse_save(&body) {
        Ok(request) => request,
        Err(response) => return Ok(*response),
    };
    let channel_name = request.channel.unwrap_or_default();
    if !channel_name.is_empty() && channel_name != CHANNEL_EMAIL_SMTP {
        return Ok(error(StatusCode::BAD_REQUEST, "unsupported channel"));
    }
    let conn = state.store.db.conn()?;
    let existing = match state.store.get(&conn, user.id, &id) {
        Err(err) => return Ok(internal(err)),
        Ok(None) => return Ok(error(StatusCode::NOT_FOUND, "connection not found")),
        Ok(Some(row)) => row,
    };
    let mut merged = existing.settings.clone();
    for (key, value) in request.settings.clone().unwrap_or_default() {
        merged.insert(key, value);
    }
    let new_secrets = request.secrets.unwrap_or_default();
    let merged_secrets = if new_secrets.is_empty() {
        state.store.open_secrets(&existing).unwrap_or_default()
    } else {
        new_secrets.clone()
    };
    if let Err(message) = channel::validate(&merged, &merged_secrets) {
        return Ok(error(StatusCode::BAD_REQUEST, message));
    }
    let input = UpsertInput {
        channel: String::new(),
        name: request.name.unwrap_or_default(),
        settings: request.settings,
        secrets: new_secrets,
    };
    let mut row = match state.store.update(&conn, user.id, &id, input) {
        Err(err) => return Ok(internal(err)),
        Ok(None) => return Ok(error(StatusCode::NOT_FOUND, "connection not found")),
        Ok(Some(row)) => row,
    };
    let bag = match state.store.open_secrets(&row) {
        Ok(bag) => bag,
        Err(message) => {
            let result = TestResult {
                ok: false,
                latency_ms: 0,
                message,
                error_code: "secret_unavailable".into(),
            };
            let _ = state.store.mark_test_result(&conn, &mut row, &result);
            return Ok(axum::Json(row.view(state.used_by(&row.id))).into_response());
        }
    };
    drop(conn);
    let result = channel::test(&row, &bag).await;
    let conn = state.store.db.conn()?;
    let _ = state.store.mark_test_result(&conn, &mut row, &result);
    Ok(axum::Json(row.view(state.used_by(&row.id))).into_response())
}

/// Refuses to delete a connection still used by workflows unless `force=true`.
async fn delete(
    State(state): State<ConnectionsState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> AppResult<Response> {
    let used = state.used_by(&id);
    if used > 0 && query.get("force").map(String::as_str) != Some("true") {
        return Ok((
            StatusCode::CONFLICT,
            axum::Json(json!({ "error": "connection is in use", "errorCode": "connection_in_use", "usedBy": used })),
        )
            .into_response());
    }
    let conn = state.store.db.conn()?;
    Ok(match state.store.delete(&conn, user.id, &id) {
        Err(err) => internal(err),
        Ok(false) => error(StatusCode::NOT_FOUND, "connection not found"),
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
    })
}

async fn test(
    State(state): State<ConnectionsState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let conn = state.store.db.conn()?;
    let mut row = match state.store.get(&conn, user.id, &id) {
        Err(err) => return Ok(internal(err)),
        Ok(None) => return Ok(error(StatusCode::NOT_FOUND, "connection not found")),
        Ok(Some(row)) => row,
    };
    let result = match state.store.open_secrets(&row) {
        Ok(bag) => {
            drop(conn);
            channel::test(&row, &bag).await
        }
        Err(message) => TestResult {
            ok: false,
            latency_ms: 0,
            message,
            error_code: "secret_unavailable".into(),
        },
    };
    let conn = state.store.db.conn()?;
    let _ = state.store.mark_test_result(&conn, &mut row, &result);
    let status = if result.ok {
        StatusCode::OK
    } else {
        StatusCode::BAD_GATEWAY
    };
    Ok((status, axum::Json(result)).into_response())
}
