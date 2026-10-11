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
            "/kits/files",
            axum::routing::put(write_file)
                .layer(axum::extract::DefaultBodyLimit::max(MAX_FILE_BYTES)),
        )
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
        .route("/kits/bridge", get(bridge_stream).post(bridge_message))
        .route("/kits/surfaces", post(open_surface))
        .route(
            "/kits/surfaces/{surface}",
            axum::routing::put(update_surface).delete(close_surface),
        )
        .with_state(state)
}

/// Ends a bridge session when its stream is dropped (the renderer window went away).
struct BridgeStream {
    bridge: std::sync::Arc<crate::bridge::Bridge>,
    session: u64,
    rx: tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl Drop for BridgeStream {
    fn drop(&mut self) {
        self.bridge.disconnect(self.session);
    }
}

impl tokio_stream::Stream for BridgeStream {
    type Item = Result<axum::response::sse::Event, std::convert::Infallible>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx).map(|message| {
            message
                .map(|message| Ok(axum::response::sse::Event::default().data(message.to_string())))
        })
    }
}

/// `GET /kits/bridge`: the renderer's stream of bridge requests (one JSON-RPC message per event).
async fn bridge_stream(State(state): State<KitsState>, _user: CurrentUser) -> Response {
    let bridge = state.kits.bridge().clone();
    let (session, rx) = bridge.connect();
    axum::response::sse::Sse::new(BridgeStream {
        bridge,
        session,
        rx,
    })
    .keep_alive(axum::response::sse::KeepAlive::default())
    .into_response()
}

#[derive(Deserialize)]
struct BridgeQuery {
    session: u64,
}

/// `POST /kits/bridge?session=<id>`: an answer to a bridge request, or a `kit.changed` notification.
async fn bridge_message(
    State(state): State<KitsState>,
    _user: CurrentUser,
    Query(query): Query<BridgeQuery>,
    JsonBody(message): JsonBody<Value>,
) -> AppResult<Response> {
    state
        .kits
        .bridge()
        .receive(query.session, &message)
        .map_err(|message| AppError::new(404, 40402, message))?;
    Ok(ok(json!({})))
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
        KitError::Unavailable(_) => (409, 40904),
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
        KitError::Unavailable(_) => json!("unavailable"),
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

#[derive(Deserialize)]
struct OpenSurfaceBody {
    path: String,
    rect: crate::surfaces::Rect,
    #[serde(default = "default_visible")]
    visible: bool,
}

const fn default_visible() -> bool {
    true
}

async fn open_surface(
    State(state): State<KitsState>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<OpenSurfaceBody>,
) -> AppResult<Response> {
    let view = state
        .kits
        .open_surface(&body.path, body.rect, body.visible)
        .await
        .map_err(app_error)?;
    Ok(ok(view))
}

#[derive(Deserialize)]
struct UpdateSurfaceBody {
    #[serde(default)]
    rect: Option<crate::surfaces::Rect>,
    #[serde(default)]
    visible: Option<bool>,
}

async fn update_surface(
    State(state): State<KitsState>,
    _user: CurrentUser,
    Path(surface): Path<u64>,
    JsonBody(body): JsonBody<UpdateSurfaceBody>,
) -> AppResult<Response> {
    state
        .kits
        .update_surface(surface, body.rect, body.visible)
        .await
        .map_err(app_error)?;
    Ok(ok(json!({})))
}

async fn close_surface(
    State(state): State<KitsState>,
    _user: CurrentUser,
    Path(surface): Path<u64>,
) -> AppResult<Response> {
    state.kits.close_surface(surface).await;
    Ok(ok(json!({})))
}

/// The largest file an in-page editor may save in one request.
const MAX_FILE_BYTES: usize = 2 << 30;

#[derive(Deserialize)]
struct WriteFileQuery {
    path: String,
}

async fn write_file(
    State(state): State<KitsState>,
    _user: CurrentUser,
    Query(query): Query<WriteFileQuery>,
    body: axum::body::Bytes,
) -> AppResult<Response> {
    state
        .kits
        .write_file(&query.path, &body)
        .map_err(app_error)?;
    Ok(ok(json!({ "path": query.path, "bytes": body.len() })))
}
