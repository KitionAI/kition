//! `/desktop`: launch verification, Kition Cloud sign-in, provider model
//! discovery, notification preferences, and user shell hooks.

mod body;
pub mod bootstrap;
pub mod discover;
pub mod hooks;
pub mod notifications;
pub mod portal;

use std::path::PathBuf;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use kition_core::{AppError, AppResult, now_millis};
use kition_http::{AuthConfig, CurrentUser, RequestContext, ok, ok_message};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

pub use hooks::{Event as HookEvent, HookRunner};
pub use portal::PortalAuth;

use crate::body::Body;
use crate::portal::{ConnectSession, RemoteAccount, RemoteStart, SessionPayload};

#[derive(Clone)]
pub struct DesktopState {
    pub auth: AuthConfig,
    pub portal: PortalAuth,
    pub hooks: HookRunner,
    pub workspace_dir: Option<PathBuf>,
    /// Where the portal sends the browser after sign-in, e.g.
    /// `http://127.0.0.1:18101/api/v1/desktop/portal/callback`.
    pub callback_url: String,
}

impl axum::extract::FromRef<DesktopState> for AuthConfig {
    fn from_ref(state: &DesktopState) -> Self {
        state.auth.clone()
    }
}

pub fn router(state: DesktopState) -> Router {
    Router::new()
        .route("/desktop/bootstrap/challenge", post(bootstrap_challenge))
        .route("/desktop/bootstrap/complete", post(bootstrap_complete))
        .route("/desktop/portal/connect/start", post(portal_connect_start))
        .route("/desktop/portal/callback", get(portal_callback))
        .route(
            "/desktop/portal/connect/result/{session_id}",
            get(portal_connect_result),
        )
        .route(
            "/desktop/portal/session/status",
            post(portal_session_status),
        )
        .route("/desktop/portal/logout", post(portal_logout))
        .route("/desktop/providers/discover-models", post(discover_models))
        .route(
            "/desktop/notifications",
            get(get_notifications).put(put_notifications),
        )
        .route("/desktop/hooks", get(list_hooks).post(create_hook))
        .route("/desktop/hooks/{id}", put(update_hook).delete(delete_hook))
        .route("/desktop/hooks/{id}/dry-run", post(dry_run_hook))
        .route("/desktop/hooks/lifecycle", post(dispatch_lifecycle_hook))
        .with_state(state)
}

/// A JSON object body with `null` members treated as absent; any decoding
/// failure is a 400 with `message`.
fn decode<T: DeserializeOwned>(bytes: &[u8], message: &str) -> AppResult<T> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| AppError::bad_request(message))?;
    if !(value.is_object() || value.is_null()) {
        return Err(AppError::bad_request(message));
    }
    portal::decode_lenient(value).map_err(|_| AppError::bad_request(message))
}

async fn blocking<T: Send + 'static>(
    state: &DesktopState,
    work: impl FnOnce(&rusqlite::Connection) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    state.auth.db.run(move |conn| work(conn)).await
}

async fn bootstrap_challenge(
    State(state): State<DesktopState>,
    ctx: RequestContext,
    body: Bytes,
) -> AppResult<Response> {
    blocking(&state, move |conn| {
        bootstrap::challenge(conn, &body, &ctx.trace_id)
    })
    .await
}

async fn bootstrap_complete(
    State(state): State<DesktopState>,
    ctx: RequestContext,
    body: Bytes,
) -> AppResult<Response> {
    blocking(&state, move |conn| {
        bootstrap::complete(conn, &body, &ctx.trace_id)
    })
    .await
}

async fn portal_connect_start(State(state): State<DesktopState>) -> AppResult<Response> {
    let portal = &state.portal;
    portal.prune_expired(now_millis());
    let code_verifier = portal::random_url_token(32);
    let session_state = format!("portal_state_{}", portal::random_url_token(24));
    let session_id = format!("portal_{}", portal::random_url_token(24));
    let payload = json!({
        "code_challenge": portal::s256(&code_verifier),
        "code_challenge_method": "S256",
        "redirect_uri": state.callback_url,
        "state": session_state,
    });
    let mut remote: RemoteStart = portal
        .fetch(
            reqwest::Method::POST,
            "/api/oauth/desktop/start",
            Some(payload),
            "",
        )
        .await
        .map_err(AppError::bad_request)?;
    if remote.expires_at <= 0 {
        remote.expires_at = now_millis() + 10 * 60_000;
    }
    let authorize = if remote.authorize_url.trim().is_empty() {
        remote.login_url.trim()
    } else {
        remote.authorize_url.trim()
    };
    if authorize.is_empty() {
        return Err(AppError::internal(
            "Portal login entry is temporarily unavailable",
        ));
    }
    let authorize_url = portal::resolve_portal_url(&portal.base_url, authorize);
    portal.save(ConnectSession {
        session_id: session_id.clone(),
        state: session_state,
        challenge_id: remote.challenge_id.trim().to_owned(),
        code_verifier,
        expires_at: remote.expires_at,
        status: portal::STATUS_PENDING.into(),
        ..Default::default()
    });
    let poll_interval_ms = if remote.poll_interval_seconds > 0 {
        remote.poll_interval_seconds * 1000
    } else {
        portal::POLL_INTERVAL_MS
    };
    Ok(ok(json!({
        "session_id": session_id,
        "authorize_url": authorize_url,
        "expires_at": remote.expires_at,
        "poll_interval_ms": poll_interval_ms,
    })))
}

async fn portal_connect_result(
    State(state): State<DesktopState>,
    Path(session_id): Path<String>,
) -> AppResult<Response> {
    let portal = &state.portal;
    portal.prune_expired(now_millis());
    let id = session_id.trim();
    let mut session = portal.get(id).ok_or_else(|| {
        AppError::bad_request("Login session does not exist, please start again.")
    })?;
    if now_millis() > session.expires_at && session.status == portal::STATUS_PENDING {
        portal.expire(id);
        session = portal.get(id).unwrap_or(session);
    }
    let mut data = json!({"status": session.status, "expires_at": session.expires_at});
    if let Some(payload) = &session.session {
        data["session"] = serde_json::to_value(payload)?;
    }
    if !session.error_message.is_empty() {
        data["error_message"] = Value::String(session.error_message.clone());
    }
    Ok(ok(data))
}

/// Reads the required `access_token` member.
fn access_token(bytes: &[u8]) -> AppResult<String> {
    let mut body = Body::parse(bytes);
    let token = body.required("access_token");
    if body.ok() {
        Ok(token)
    } else {
        Err(AppError::localized_bad_request("common.bad_request"))
    }
}

async fn portal_session_status(
    State(state): State<DesktopState>,
    body: Bytes,
) -> AppResult<Response> {
    let token = access_token(&body)?;
    let portal = &state.portal;
    let remote: RemoteAccount = portal
        .fetch(
            reqwest::Method::GET,
            "/api/oauth/desktop/session",
            None,
            &token,
        )
        .await
        .map_err(AppError::bad_request)?;
    if !remote.authenticated {
        portal.clear_active_by_token(&token);
        return Ok(ok(json!({"authenticated": false})));
    }
    let payload = SessionPayload::from_remote(&token, &remote, remote.expires_at.unwrap_or(0));
    portal.activate_restored(payload.clone());
    let mut data = serde_json::to_value(&payload.credits)?;
    if let Some(map) = data.as_object_mut() {
        map.insert("authenticated".into(), Value::Bool(true));
        map.insert("user_id".into(), json!(remote.user_id));
        map.insert("user_email".into(), json!(remote.user_email));
        map.insert("token_prefix".into(), json!(remote.token_prefix));
        map.insert(
            "credit_summary".into(),
            serde_json::to_value(remote.credits())?,
        );
        if let Some(expires_at) = remote.expires_at {
            map.insert("expires_at".into(), json!(expires_at));
        }
    }
    Ok(ok(data))
}

async fn portal_logout(State(state): State<DesktopState>, body: Bytes) -> AppResult<Response> {
    let token = access_token(&body)?;
    state
        .portal
        .request(
            reqwest::Method::POST,
            "/api/oauth/desktop/logout",
            Some(json!({})),
            &token,
        )
        .await
        .map_err(AppError::bad_request)?;
    state.portal.clear_active_by_token(&token);
    Ok(ok(json!({"success": true})))
}

/// HTML escaping like the legacy `html.EscapeString`.
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('\'', "&#39;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&#34;")
}

fn callback_page(status: StatusCode, success: bool, message: &str) -> Response {
    let (state_class, title, label, detail, icon, footer, script) = if success {
        (
            "portal-callback--success",
            "Login complete",
            "Connection secured",
            "Your browser session is now linked to the desktop app.",
            include_str!("callback/success_icon.html"),
            include_str!("callback/success_footer.html"),
            include_str!("callback/launch_script.html"),
        )
    } else {
        (
            "portal-callback--error",
            "Login incomplete",
            "Connection needs attention",
            "Return to Kition and start the sign-in again.",
            include_str!("callback/error_icon.html"),
            include_str!("callback/error_footer.html"),
            "",
        )
    };
    // The message is user-influenced, so it is substituted last.
    let page = include_str!("callback/page.html")
        .replace("__STATE_CLASS__", state_class)
        .replace("__TITLE__", &escape_html(title))
        .replace("__STATUS_ICON__", icon)
        .replace("__STATUS_LABEL__", &escape_html(label))
        .replace("__STATUS_DETAIL__", &escape_html(detail))
        .replace("__FOOTER__", footer)
        .replace("__LAUNCH_SCRIPT__", script)
        .replace("__MESSAGE__", &escape_html(message));
    (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        page,
    )
        .into_response()
}

async fn portal_callback(
    State(state): State<DesktopState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let portal = &state.portal;
    portal.prune_expired(now_millis());
    let code = query.get("code").map(|v| v.trim()).unwrap_or_default();
    let session_state = query.get("state").map(|v| v.trim()).unwrap_or_default();
    if code.is_empty() || session_state.is_empty() {
        return callback_page(
            StatusCode::BAD_REQUEST,
            false,
            "Missing callback parameters; login could not complete.",
        );
    }
    let Some(session) = portal.get_by_state(session_state) else {
        return callback_page(
            StatusCode::BAD_REQUEST,
            false,
            "This login session is no longer valid; return to Kition and start again.",
        );
    };
    if now_millis() > session.expires_at && session.status == portal::STATUS_PENDING {
        portal.expire(&session.session_id);
        return callback_page(
            StatusCode::BAD_REQUEST,
            false,
            "This login session has expired; return to Kition and start again.",
        );
    }
    let payload = json!({"challenge_id": session.challenge_id, "code": code, "code_verifier": session.code_verifier});
    let remote: RemoteAccount = match portal
        .fetch(
            reqwest::Method::POST,
            "/api/oauth/desktop/exchange",
            Some(payload),
            "",
        )
        .await
    {
        Ok(remote) => remote,
        Err(message) => {
            portal.fail_by_state(session_state, &message);
            return callback_page(StatusCode::BAD_GATEWAY, false, &message);
        }
    };
    let token = remote.token.clone();
    portal.complete_by_state(
        session_state,
        SessionPayload::from_remote(&token, &remote, remote.expires_at.unwrap_or(0)),
    );
    callback_page(
        StatusCode::OK,
        true,
        "Your account is connected. Kition should reopen automatically.",
    )
}

async fn discover_models(
    State(state): State<DesktopState>,
    _user: CurrentUser,
    body: Bytes,
) -> AppResult<Response> {
    let mut reader = Body::parse(&body);
    let req = discover::DiscoverRequest {
        provider_type: reader.required("provider_type"),
        base_url: reader.string("base_url"),
        api_key: reader.string("api_key"),
        access_token: reader.string("access_token"),
        models_path: reader.string("models_path"),
        auth_header: reader.string("auth_header"),
        auth_scheme: reader.string("auth_scheme"),
    };
    if reader.invalid {
        return Err(AppError::bad_request(
            "Please use a POST JSON request and provide provider_type",
        ));
    }
    if !reader.missing.is_empty() {
        return Err(AppError::bad_request(
            "Missing required field: provider_type",
        ));
    }
    let provider_type = req.provider_type.clone();
    let (models, endpoint) = discover::discover(&state.portal, req)
        .await
        .map_err(AppError::bad_request)?;
    Ok(ok(json!({
        "provider_type": provider_type,
        "endpoint": endpoint,
        "models": models,
        "fetched_at": now_millis(),
    })))
}

async fn get_notifications(
    State(state): State<DesktopState>,
    user: CurrentUser,
) -> AppResult<Response> {
    let user_id = user.user.id;
    Ok(ok(blocking(&state, move |conn| {
        notifications::read(conn, user_id)
    })
    .await?))
}

async fn put_notifications(
    State(state): State<DesktopState>,
    user: CurrentUser,
    body: Bytes,
) -> AppResult<Response> {
    let policy: notifications::Policy = decode(&body, "Invalid request body format")?;
    let user_id = user.user.id;
    Ok(ok(blocking(&state, move |conn| {
        notifications::write(conn, user_id, policy)
    })
    .await?))
}

async fn list_hooks(State(state): State<DesktopState>, user: CurrentUser) -> AppResult<Response> {
    let user_id = user.user.id;
    let items = blocking(&state, move |conn| hooks::list(conn, user_id)).await?;
    Ok(ok(json!({"items": items})))
}

async fn create_hook(
    State(state): State<DesktopState>,
    user: CurrentUser,
    body: Bytes,
) -> AppResult<Response> {
    let mut input: hooks::HookInput = decode(&body, "Invalid request body format")?;
    input.validate()?;
    let user_id = user.user.id;
    Ok(ok(blocking(&state, move |conn| {
        hooks::create(conn, user_id, input)
    })
    .await?))
}

const HOOK_MISSING: &str = "Hook does not exist";

async fn update_hook(
    State(state): State<DesktopState>,
    user: CurrentUser,
    Path(id): Path<String>,
    body: Bytes,
) -> AppResult<Response> {
    let user_id = user.user.id;
    let view = blocking(&state, move |conn| {
        let hook =
            hooks::find(conn, user_id, &id)?.ok_or_else(|| AppError::not_found(HOOK_MISSING))?;
        let mut input: hooks::HookInput = decode(&body, "Invalid request body format")?;
        input.validate()?;
        hooks::update(conn, &hook, input)
    })
    .await?;
    Ok(ok(view))
}

async fn delete_hook(
    State(state): State<DesktopState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let user_id = user.user.id;
    if !blocking(&state, move |conn| hooks::delete(conn, user_id, &id)).await? {
        return Err(AppError::not_found(HOOK_MISSING));
    }
    Ok(ok_message("Deleted"))
}

async fn dry_run_hook(
    State(state): State<DesktopState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let user_id = user.user.id;
    let hook = blocking(&state, move |conn| hooks::find(conn, user_id, &id))
        .await?
        .ok_or_else(|| AppError::not_found(HOOK_MISSING))?;
    let workdir = if hook.workdir.is_empty() {
        state
            .workspace_dir
            .as_ref()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        hook.workdir.clone()
    };
    Ok(ok(json!({
        "command": hook.command,
        "shell": hooks::login_shell(),
        "workdir": workdir,
        "timeout_seconds": hook.timeout_seconds,
        "event": hook.event,
        "would_dispatch": hook.enabled,
    })))
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct LifecycleRequest {
    event: String,
}

/// Fires `session_started` / `on_quit` hooks; task events only come from
/// the Agent.
async fn dispatch_lifecycle_hook(
    State(state): State<DesktopState>,
    user: CurrentUser,
    body: Bytes,
) -> AppResult<Response> {
    let req: LifecycleRequest = decode(&body, "Invalid request body format")?;
    let event = req.event.trim();
    if event != "session_started" && event != "on_quit" {
        return Err(AppError::bad_request(
            "Only session_started or on_quit is supported",
        ));
    }
    state.hooks.dispatch(
        user.user.id,
        HookEvent {
            name: event.to_owned(),
            ..Default::default()
        },
    );
    Ok(ok_message("Dispatched"))
}
