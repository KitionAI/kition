//! `/kits`: kit status and documents opened in kits, for kit tabs in the renderer.
//! JSON answers use the runtime envelope; previews are bare `image/png`.

use axum::Router;
use axum::extract::{FromRef, Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::header;
use kition_core::{AppError, AppResult};
use kition_http::{AuthConfig, CurrentUser, JsonBody, ok};
use kition_kit_protocol::ErrorReason;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::manager::{Caller, KitError, KitManager};

#[derive(Clone)]
pub struct KitsState {
    pub auth: AuthConfig,
    pub kits: KitManager,
}

impl FromRef<KitsState> for AuthConfig {
    fn from_ref(state: &KitsState) -> Self {
        state.auth.clone()
    }
}

pub fn router(state: KitsState) -> Router {
    Router::new()
        .route("/kits", get(list))
        .route("/kits/documents", post(open))
        .route("/kits/documents/new", post(create))
        .route(
            "/kits/{kit}/documents/{document}",
            get(document).delete(close),
        )
        .route("/kits/{kit}/documents/{document}/preview", get(preview))
        .route(
            "/kits/{kit}/documents/{document}/commands",
            get(commands).post(execute),
        )
        .route("/kits/{kit}/documents/{document}/save", post(save))
        .with_state(state)
}

/// Maps kit failures to statuses the renderer can branch on.
pub fn app_error(error: KitError) -> AppError {
    let message = error.to_string();
    let (status, code) = match &error {
        KitError::UnknownKit(_) => (404, 40400),
        KitError::NotInstalled { .. } => (409, 40901),
        KitError::NoWorkspace => (409, 40902),
        KitError::InvalidPath(_) => (400, 40000),
        KitError::Launch { .. } => (502, 50201),
        KitError::Stopped { .. } => (503, 50301),
        KitError::Kit { reason, .. } => match reason {
            Some(ErrorReason::DocumentNotFound) => (404, 40401),
            Some(ErrorReason::UriNotGranted) => (403, 40301),
            Some(ErrorReason::DocumentDirty) => (409, 40903),
            Some(_) | None => (400, 40001),
        },
    };
    let reason = match &error {
        KitError::Kit {
            reason: Some(reason),
            ..
        } => serde_json::to_value(reason).unwrap_or(Value::Null),
        KitError::NotInstalled { .. } => json!("not_installed"),
        KitError::Stopped { .. } => json!("stopped"),
        _ => Value::Null,
    };
    AppError::new(status, code, message).with_data(json!({ "reason": reason }))
}

async fn list(State(state): State<KitsState>, _user: CurrentUser) -> Response {
    ok(json!({ "kits": state.kits.statuses() }))
}

#[derive(Deserialize)]
struct OpenBody {
    path: String,
}

async fn open(
    State(state): State<KitsState>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<OpenBody>,
) -> AppResult<Response> {
    let view = state
        .kits
        .open(Caller::User, &body.path)
        .await
        .map_err(app_error)?;
    Ok(ok(view))
}

#[derive(Deserialize)]
struct CreateBody {
    #[serde(default)]
    folder: String,
    #[serde(default = "default_extension")]
    extension: String,
    #[serde(default = "default_width")]
    width: u32,
    #[serde(default = "default_height")]
    height: u32,
}

fn default_extension() -> String {
    "psd".into()
}

const fn default_width() -> u32 {
    1920
}

const fn default_height() -> u32 {
    1080
}

async fn create(
    State(state): State<KitsState>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<CreateBody>,
) -> AppResult<Response> {
    if !(1..=30_000).contains(&body.width) || !(1..=30_000).contains(&body.height) {
        return Err(AppError::bad_request(
            "width and height must be between 1 and 30000 pixels",
        ));
    }
    let options = Map::from_iter([
        ("width".to_owned(), json!(body.width)),
        ("height".to_owned(), json!(body.height)),
        ("background".to_owned(), json!("white")),
    ]);
    let view = state
        .kits
        .create(Caller::User, &body.folder, &body.extension, options)
        .await
        .map_err(app_error)?;
    Ok(ok(view))
}

async fn document(
    State(state): State<KitsState>,
    _user: CurrentUser,
    Path((kit, document)): Path<(String, String)>,
) -> AppResult<Response> {
    let view = state
        .kits
        .document(Caller::User, &kit, &document)
        .await
        .map_err(app_error)?;
    Ok(ok(view))
}

#[derive(Deserialize)]
struct CloseQuery {
    #[serde(default)]
    discard: bool,
}

async fn close(
    State(state): State<KitsState>,
    _user: CurrentUser,
    Path((kit, document)): Path<(String, String)>,
    Query(query): Query<CloseQuery>,
) -> AppResult<Response> {
    state
        .kits
        .close(&kit, &document, query.discard)
        .await
        .map_err(app_error)?;
    Ok(ok(json!({})))
}

#[derive(Deserialize)]
struct PreviewQuery {
    #[serde(default, rename = "maxSize")]
    max_size: Option<u32>,
}

async fn preview(
    State(state): State<KitsState>,
    _user: CurrentUser,
    Path((kit, document)): Path<(String, String)>,
    Query(query): Query<PreviewQuery>,
) -> AppResult<Response> {
    let png = state
        .kits
        .preview(&kit, &document, query.max_size.unwrap_or(1600))
        .await
        .map_err(app_error)?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        png,
    )
        .into_response())
}

#[derive(Deserialize)]
struct CommandsQuery {
    #[serde(default)]
    query: Option<String>,
}

async fn commands(
    State(state): State<KitsState>,
    _user: CurrentUser,
    Path((kit, document)): Path<(String, String)>,
    Query(query): Query<CommandsQuery>,
) -> AppResult<Response> {
    let commands = state
        .kits
        .commands(Caller::User, &kit, Some(&document), query.query.as_deref())
        .await
        .map_err(app_error)?;
    Ok(ok(json!({ "commands": commands })))
}

#[derive(Deserialize)]
struct ExecuteBody {
    command: String,
    #[serde(default)]
    params: Map<String, Value>,
}

async fn execute(
    State(state): State<KitsState>,
    _user: CurrentUser,
    Path((kit, document)): Path<(String, String)>,
    JsonBody(body): JsonBody<ExecuteBody>,
) -> AppResult<Response> {
    let executed = state
        .kits
        .execute(Caller::User, &kit, &document, &body.command, body.params)
        .await
        .map_err(app_error)?;
    Ok(ok(executed))
}

async fn save(
    State(state): State<KitsState>,
    _user: CurrentUser,
    Path((kit, document)): Path<(String, String)>,
) -> AppResult<Response> {
    let view = state
        .kits
        .save(Caller::User, &kit, &document)
        .await
        .map_err(app_error)?;
    Ok(ok(view))
}
