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

use crate::manager::{Caller, FileWrite, KitError, KitManager};

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
        .route("/kits/grants", post(grant_file))
        .route("/kits/grants/create", post(create_file))
        .route("/kits/grants/release", post(release_files))
        .route("/kits/grants/sessions", post(open_grant_session))
        .route(
            "/kits/grants/sessions/{session}",
            get(grant_session).delete(end_grant_session),
        )
        .route("/kits/grants/{handle}", get(stat_file))
        .route("/kits/grants/{handle}/list", get(list_folder))
        .route(
            "/kits/grants/{handle}/content",
            get(read_file)
                .put(write_chunk)
                .layer(axum::extract::DefaultBodyLimit::max(MAX_CHUNK_BYTES)),
        )
        .route("/kits/drafts", get(list_drafts))
        .route("/kits/drafts/compare", get(compare_draft))
        .route("/kits/drafts/merge", post(merge_draft))
        .route("/kits/drafts/discard", post(discard_draft))
        .route("/kits/bridge", get(bridge_stream).post(bridge_message))
        .route("/mcp/kits", post(mcp))
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

/// `POST /mcp/kits`: the kit tools as an MCP server over Streamable HTTP (`mcp.rs`). A request
/// is answered with JSON; a notification is accepted with 202. (MCP 2025-06-18 has no batches.)
async fn mcp(
    State(state): State<KitsState>,
    _user: CurrentUser,
    JsonBody(message): JsonBody<Value>,
) -> Response {
    match crate::mcp::handle(&state.kits, &message).await {
        Some(answer) => (
            [(header::CONTENT_TYPE, "application/json")],
            answer.to_string(),
        )
            .into_response(),
        None => http::StatusCode::ACCEPTED.into_response(),
    }
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
        KitError::Model { .. } => (400, 40002),
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
        KitError::Model { code, .. } => json!(code),
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
    /// The document an in-page editor opened, when the write saves it: only that file is
    /// replaced. Without it the write makes a new file (a new document or an export).
    document: Option<String>,
}

async fn write_file(
    State(state): State<KitsState>,
    _user: CurrentUser,
    Query(query): Query<WriteFileQuery>,
    body: axum::body::Bytes,
) -> AppResult<Response> {
    let write = match query.document.as_deref() {
        Some(document) => FileWrite::Save { document },
        None => FileWrite::New,
    };
    state
        .kits
        .write_file(&query.path, &body, write)
        .map_err(app_error)?;
    Ok(ok(json!({ "path": query.path, "bytes": body.len() })))
}

// File grants (Kit Standard `KitFiles 1.0`, `grants.rs`): the renderer serves a kit's `files/*`
// requests through these routes. A grant session is bound to a kit, the person, and the
// document its editor opened; handles are bound to their session. No answer names a path.

/// The largest chunk one `files/write` stages.
const MAX_CHUNK_BYTES: usize = 64 << 20;

/// Maps a refused file request to a status; `data.reason` is the KitFiles reason (section 10),
/// `null` for malformed parameters.
fn file_error(error: crate::grants::FileError) -> AppError {
    use crate::grants::FileError;
    let (status, code) = match &error {
        FileError::NotGranted(_) => (403, 40310),
        FileError::NotAllowed(_) => (403, 40311),
        FileError::AlreadyCommitted => (409, 40910),
        FileError::Conflict(_) => (409, 40911),
        FileError::UnsavedEdits => (409, 40912),
        FileError::Quota => (413, 41310),
        FileError::Io => (500, 50010),
        FileError::BadParams(_) => (400, 40010),
    };
    AppError::new(status, code, error.to_string()).with_data(json!({ "reason": error.reason() }))
}

/// Who calls a grant route: every grant route takes it, so it is the one place a caller check
/// lives. It is the person a session's handles are bound to (FA1), and the call must have carried
/// this launch's API token (`kition_http::gate`): a signed URL or an open route never reaches a
/// grant, even if a router were mounted without the gate. Kit frame isolation's second phase (a
/// per-kit origin) adds the caller's kit origin here, checked against the session's kit in
/// `GrantStore::with_session`.
struct GrantCaller {
    principal: String,
}

impl axum::extract::FromRequestParts<KitsState> for GrantCaller {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut http::request::Parts,
        state: &KitsState,
    ) -> Result<Self, Self::Rejection> {
        if parts.extensions.get::<kition_http::gate::Access>()
            != Some(&kition_http::gate::Access::Token)
        {
            return Err(AppError::localized_unauthorized("auth.unauthorized"));
        }
        let user = <CurrentUser as axum::extract::FromRequestParts<KitsState>>::from_request_parts(
            parts, state,
        )
        .await?;
        Ok(Self {
            principal: format!("user:{}", user.id),
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenGrantSessionBody {
    kit: String,
    #[serde(default)]
    document: Option<String>,
    #[serde(default)]
    files: crate::grants::FilesManifest,
    #[serde(default)]
    read_only: bool,
}

/// `POST /kits/grants/sessions`: opens a grant session for a kit's editor page.
async fn open_grant_session(
    State(state): State<KitsState>,
    caller: GrantCaller,
    JsonBody(body): JsonBody<OpenGrantSessionBody>,
) -> AppResult<Response> {
    let session = state
        .kits
        .grants()
        .open_session(crate::grants::SessionRequest {
            kit: &body.kit,
            principal: &caller.principal,
            document: body.document.as_deref(),
            manifest: body.files,
            read_only: body.read_only,
        })
        .map_err(file_error)?;
    Ok(ok(json!({ "session": session })))
}

/// `GET /kits/grants/sessions/{session}`: the session's handles and grant log (FA16).
async fn grant_session(
    State(state): State<KitsState>,
    caller: GrantCaller,
    Path(session): Path<String>,
) -> AppResult<Response> {
    let view = state
        .kits
        .grants()
        .view(&session, &caller.principal)
        .map_err(file_error)?;
    Ok(ok(view))
}

/// `DELETE /kits/grants/sessions/{session}`: ends the session; its handles expire (FA4).
async fn end_grant_session(
    State(state): State<KitsState>,
    caller: GrantCaller,
    Path(session): Path<String>,
) -> Response {
    let revoked = state.kits.grants().end_session(&session, &caller.principal);
    ok(json!({ "revoked": revoked }))
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum PersonFlow {
    Pick,
    Drop,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantBody {
    session: String,
    path: String,
    kind: crate::grants::Kind,
    rights: Vec<crate::grants::Right>,
    #[serde(default)]
    accept: Vec<String>,
    flow: PersonFlow,
}

/// `POST /kits/grants`: grants a handle on a file or folder the person picked or dropped.
async fn grant_file(
    State(state): State<KitsState>,
    caller: GrantCaller,
    JsonBody(body): JsonBody<GrantBody>,
) -> AppResult<Response> {
    let flow = match body.flow {
        PersonFlow::Pick => crate::grants::Flow::Pick,
        PersonFlow::Drop => crate::grants::Flow::Drop,
    };
    let stat = state
        .kits
        .grants()
        .grant(
            &body.session,
            &caller.principal,
            crate::grants::GrantRequest {
                path: &body.path,
                kind: body.kind,
                rights: &body.rights,
                accept: &body.accept,
                flow,
                approved: false,
            },
        )
        .map_err(file_error)?;
    Ok(ok(stat))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateFileBody {
    session: String,
    suggested_name: String,
    #[serde(default)]
    mime: Option<String>,
    #[serde(default)]
    folder: Option<String>,
}

/// `POST /kits/grants/create`: `files/create`, a handle on a new file under an unused name.
async fn create_file(
    State(state): State<KitsState>,
    caller: GrantCaller,
    JsonBody(body): JsonBody<CreateFileBody>,
) -> AppResult<Response> {
    let stat = state
        .kits
        .grants()
        .create(
            &body.session,
            &caller.principal,
            &body.suggested_name,
            body.mime.as_deref(),
            body.folder.as_deref(),
        )
        .map_err(file_error)?;
    Ok(ok(stat))
}

#[derive(Deserialize)]
struct ReleaseBody {
    session: String,
    handles: Vec<String>,
}

/// `POST /kits/grants/release`: `files/release`; unknown and expired handles are ignored.
async fn release_files(
    State(state): State<KitsState>,
    caller: GrantCaller,
    JsonBody(body): JsonBody<ReleaseBody>,
) -> Response {
    state
        .kits
        .grants()
        .release(&body.session, &caller.principal, &body.handles);
    ok(json!({}))
}

#[derive(Deserialize)]
struct SessionQuery {
    session: String,
}

/// `GET /kits/grants/{handle}?session=`: `files/stat`.
async fn stat_file(
    State(state): State<KitsState>,
    caller: GrantCaller,
    Path(handle): Path<String>,
    Query(query): Query<SessionQuery>,
) -> AppResult<Response> {
    let stat = state
        .kits
        .grants()
        .stat(&query.session, &caller.principal, &handle)
        .map_err(file_error)?;
    Ok(ok(stat))
}

/// `GET /kits/grants/{handle}/list?session=`: `files/list`.
async fn list_folder(
    State(state): State<KitsState>,
    caller: GrantCaller,
    Path(handle): Path<String>,
    Query(query): Query<SessionQuery>,
) -> AppResult<Response> {
    let files = state
        .kits
        .grants()
        .list(&query.session, &caller.principal, &handle)
        .map_err(file_error)?;
    Ok(ok(json!({ "files": files })))
}

#[derive(Deserialize)]
struct ReadQuery {
    session: String,
    #[serde(default)]
    offset: u64,
    #[serde(default)]
    length: Option<u64>,
}

/// `GET /kits/grants/{handle}/content?session=&offset=&length=`: `files/read`. The body is the
/// bytes; `ETag` is the file's version and `Kition-File-Size` its whole size.
async fn read_file(
    State(state): State<KitsState>,
    caller: GrantCaller,
    Path(handle): Path<String>,
    Query(query): Query<ReadQuery>,
) -> AppResult<Response> {
    let read = state
        .kits
        .grants()
        .read(
            &query.session,
            &caller.principal,
            &handle,
            query.offset,
            query.length,
        )
        .map_err(file_error)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::CACHE_CONTROL, "no-store".to_owned()),
            (header::ETAG, read.version),
            (
                http::HeaderName::from_static("kition-file-size"),
                read.size.to_string(),
            ),
        ],
        read.bytes,
    )
        .into_response())
}

#[derive(Deserialize)]
struct WriteQuery {
    session: String,
    offset: u64,
    #[serde(default, rename = "final")]
    last: bool,
    #[serde(default)]
    expected: Option<String>,
}

/// `PUT /kits/grants/{handle}/content?session=&offset=&final=&expected=`: `files/write`, one
/// chunk of the raw request body. Answers `{}`, or `{ version }` for the final chunk.
async fn write_chunk(
    State(state): State<KitsState>,
    caller: GrantCaller,
    Path(handle): Path<String>,
    Query(query): Query<WriteQuery>,
    body: axum::body::Bytes,
) -> AppResult<Response> {
    let version = state
        .kits
        .write_granted(
            &query.session,
            &caller.principal,
            &handle,
            crate::grants::WriteChunk {
                bytes: &body,
                offset: query.offset,
                last: query.last,
                expected: query.expected.as_deref(),
            },
        )
        .await
        .map_err(file_error)?;
    Ok(ok(match version {
        Some(version) => json!({ "version": version }),
        None => json!({}),
    }))
}

// Drafts an agent kept beside workspace files over `kition-kits-mcp --drafts` (Kit Standard A27):
// the person reviews, merges, or discards them here. The agent can do none of these (A14).

/// Maps a refused draft command to a status the renderer can branch on; `data.reason` is the
/// command's code (`not-found`, `stale`, or a kit tool's code).
fn draft_error(error: crate::drafts::DraftError) -> AppError {
    let (status, code) = match error.code {
        "not-found" => (404, 40403),
        "stale" => (409, 40905),
        _ => (400, 40003),
    };
    AppError::new(status, code, error.message).with_data(json!({ "reason": error.code }))
}

/// `GET /kits/drafts`: the workspace's headless drafts, oldest first, each with `stale`.
async fn list_drafts(State(state): State<KitsState>, _user: CurrentUser) -> Response {
    let drafts = state
        .kits
        .workspace_dir()
        .map(crate::drafts::list)
        .unwrap_or_default();
    ok(json!({ "drafts": drafts }))
}

#[derive(Deserialize)]
struct DraftQuery {
    path: String,
    #[serde(default)]
    previews: bool,
}

/// `GET /kits/drafts/compare?path=&previews=`: what merging the draft of `path` would change.
async fn compare_draft(
    State(state): State<KitsState>,
    _user: CurrentUser,
    Query(query): Query<DraftQuery>,
) -> AppResult<Response> {
    let answer = crate::drafts::compare(&state.kits, &query.path, query.previews)
        .await
        .map_err(draft_error)?;
    Ok(ok(answer))
}

#[derive(Deserialize)]
struct MergeDraftBody {
    path: String,
    /// Replaces the file even though it changed since the draft forked (drops those edits).
    #[serde(default)]
    overwrite: bool,
}

/// `POST /kits/drafts/merge`: writes the draft of `path` as the file; refused as `stale` (409)
/// when the file changed since the draft forked, unless `overwrite`.
async fn merge_draft(
    State(state): State<KitsState>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<MergeDraftBody>,
) -> AppResult<Response> {
    let answer = crate::drafts::merge(&state.kits, &body.path, body.overwrite)
        .await
        .map_err(draft_error)?;
    Ok(ok(answer))
}

#[derive(Deserialize)]
struct DiscardDraftBody {
    path: String,
}

/// `POST /kits/drafts/discard`: drops the draft of `path`; the file stays as it is.
async fn discard_draft(
    State(state): State<KitsState>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<DiscardDraftBody>,
) -> AppResult<Response> {
    let answer = crate::drafts::discard(&state.kits, &body.path)
        .await
        .map_err(draft_error)?;
    Ok(ok(answer))
}
