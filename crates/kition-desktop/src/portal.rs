//! Kition Cloud sign-in through the portal's desktop OAuth flow (PKCE),
//! and the in-memory active session other features use for cloud access.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use base64::Engine;
use kition_core::cloud::{CloudSession, CloudSessionProvider, NOT_LOGGED_IN};
use kition_core::now_millis;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_COMPLETED: &str = "completed";
pub const STATUS_ERROR: &str = "error";
pub const STATUS_EXPIRED: &str = "expired";
pub const POLL_INTERVAL_MS: i64 = 1500;
const EXPIRED_MESSAGE: &str = "Login expired, please start again.";
const MINUTE_MS: i64 = 60_000;

/// Credit and plan figures reported by the portal.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CreditSummary {
    pub credit_total: i64,
    pub credit_balance: i64,
    pub credit_spent: i64,
    pub period_credit_total: i64,
    pub period_credit_balance: i64,
    pub period_credit_spent: i64,
    pub wallet_credit_total: i64,
    pub wallet_credit_balance: i64,
    pub wallet_credit_spent: i64,
    pub plan_code: String,
    pub plan_type: String,
    pub subscription_status: String,
    pub credit_purchased_total: i64,
    pub credit_granted_total: i64,
    pub lifetime_credit_total: i64,
    pub credit_reset_cycle: String,
    pub credit_reset_at: Option<i64>,
}

impl CreditSummary {
    fn trimmed(mut self) -> Self {
        for text in [
            &mut self.plan_code,
            &mut self.plan_type,
            &mut self.subscription_status,
            &mut self.credit_reset_cycle,
        ] {
            *text = text.trim().to_owned();
        }
        self
    }
}

/// The portal's exchange and session responses: flat credit fields plus an
/// optional nested summary that wins when present.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub(crate) struct RemoteAccount {
    pub token: String,
    pub token_prefix: String,
    pub user_id: u64,
    pub user_email: String,
    pub expires_at: Option<i64>,
    pub authenticated: bool,
    #[serde(flatten)]
    pub flat: CreditSummary,
    pub credit_summary: Option<CreditSummary>,
}

impl RemoteAccount {
    pub fn credits(&self) -> CreditSummary {
        self.credit_summary
            .clone()
            .unwrap_or_else(|| self.flat.clone())
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub(crate) struct RemoteStart {
    pub challenge_id: String,
    pub authorize_url: String,
    pub login_url: String,
    pub expires_at: i64,
    pub poll_interval_seconds: i64,
}

/// A signed-in account as returned to the desktop client.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SessionPayload {
    pub access_token: String,
    pub token_prefix: String,
    pub user_id: u64,
    pub user_email: String,
    pub expires_at: i64,
    #[serde(flatten)]
    pub credits: CreditSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credit_summary: Option<CreditSummary>,
}

impl SessionPayload {
    pub(crate) fn from_remote(access_token: &str, remote: &RemoteAccount, expires_at: i64) -> Self {
        let credits = remote.credits().trimmed();
        Self {
            access_token: access_token.trim().to_owned(),
            token_prefix: remote.token_prefix.trim().to_owned(),
            user_id: remote.user_id,
            user_email: remote.user_email.trim().to_owned(),
            expires_at,
            credit_summary: Some(remote.credits()),
            credits,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ConnectSession {
    pub session_id: String,
    pub state: String,
    pub challenge_id: String,
    pub code_verifier: String,
    pub expires_at: i64,
    pub status: String,
    pub error_message: String,
    pub session: Option<SessionPayload>,
}

#[derive(Default)]
struct Sessions {
    by_session: HashMap<String, ConnectSession>,
    by_state: HashMap<String, String>,
    active: String,
}

/// Portal sign-in state and the HTTP client used to reach the portal.
#[derive(Clone)]
pub struct PortalAuth {
    sessions: Arc<Mutex<Sessions>>,
    pub(crate) base_url: String,
    pub(crate) client: reqwest::Client,
}

pub(crate) fn random_url_token(size: usize) -> String {
    let bytes: Vec<u8> = (0..size).map(|_| rand::random::<u8>()).collect();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn s256(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.trim().as_bytes()))
}

/// Joins a portal path onto the base URL; absolute URLs pass through.
pub(crate) fn resolve_portal_url(base_url: &str, raw: &str) -> String {
    let value = raw.trim();
    let base = base_url.trim().trim_end_matches('/');
    if value.is_empty() {
        return base.to_owned();
    }
    if value.starts_with("http://") || value.starts_with("https://") || base.is_empty() {
        return value.to_owned();
    }
    if value.starts_with('/') {
        format!("{base}{value}")
    } else {
        format!("{base}/{value}")
    }
}

/// The first 180 characters of an error body.
pub(crate) fn compact_remote_error(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let text = text.trim();
    if text.is_empty() {
        return "Unknown error".into();
    }
    if text.len() > 180 {
        let mut cut = 180;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        return format!("{}...", &text[..cut]);
    }
    text.to_owned()
}

/// Decodes like the legacy runtime: `null` members keep their defaults.
pub(crate) fn decode_lenient<T: DeserializeOwned>(
    mut value: Value,
) -> Result<T, serde_json::Error> {
    fn strip(value: &mut Value) {
        match value {
            Value::Object(map) => {
                map.retain(|_, member| !member.is_null());
                map.values_mut().for_each(strip);
            }
            Value::Array(items) => items.iter_mut().for_each(strip),
            _ => {}
        }
    }
    strip(&mut value);
    if value.is_null() {
        value = Value::Object(serde_json::Map::new());
    }
    serde_json::from_value(value)
}

/// Whether credentials may be sent to `base_url`: HTTPS, or plain HTTP to
/// this machine for local development.
pub(crate) fn is_secure_portal(base_url: &str) -> bool {
    match url::Url::parse(base_url.trim()) {
        Ok(url) if url.scheme() == "https" => true,
        Ok(url) if url.scheme() == "http" => matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        ),
        _ => false,
    }
}

const INSECURE_PORTAL: &str = "Kition Cloud must use HTTPS; refusing to send credentials.";

impl PortalAuth {
    pub fn new(base_url: &str) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default();
        Self {
            sessions: Arc::default(),
            base_url: base_url.to_owned(),
            client,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn save(&self, session: ConnectSession) {
        let mut sessions = self.lock();
        sessions
            .by_state
            .insert(session.state.clone(), session.session_id.clone());
        sessions
            .by_session
            .insert(session.session_id.clone(), session);
    }

    pub(crate) fn get(&self, session_id: &str) -> Option<ConnectSession> {
        self.lock().by_session.get(session_id).cloned()
    }

    pub(crate) fn get_by_state(&self, state: &str) -> Option<ConnectSession> {
        let sessions = self.lock();
        let id = sessions.by_state.get(state)?;
        sessions.by_session.get(id).cloned()
    }

    pub(crate) fn complete_by_state(&self, state: &str, payload: SessionPayload) {
        let mut sessions = self.lock();
        let Some(id) = sessions.by_state.get(state).cloned() else {
            return;
        };
        if let Some(session) = sessions.by_session.get_mut(&id) {
            session.status = STATUS_COMPLETED.into();
            session.error_message.clear();
            session.session = Some(payload);
            sessions.active = id;
        }
    }

    pub(crate) fn fail_by_state(&self, state: &str, message: &str) {
        let mut sessions = self.lock();
        let Some(id) = sessions.by_state.get(state).cloned() else {
            return;
        };
        if let Some(session) = sessions.by_session.get_mut(&id) {
            session.status = STATUS_ERROR.into();
            session.error_message = message.trim().to_owned();
        }
    }

    pub(crate) fn expire(&self, session_id: &str) {
        let mut sessions = self.lock();
        if let Some(session) = sessions.by_session.get_mut(session_id)
            && session.status != STATUS_COMPLETED
        {
            session.status = STATUS_EXPIRED.into();
            if session.error_message.is_empty() {
                session.error_message = EXPIRED_MESSAGE.into();
            }
        }
    }

    /// Drops sessions 30 minutes past expiry and expires pending ones.
    pub(crate) fn prune_expired(&self, now: i64) {
        let mut sessions = self.lock();
        let stale: Vec<(String, String)> = sessions
            .by_session
            .values()
            .filter(|s| now > s.expires_at + 30 * MINUTE_MS)
            .map(|s| (s.session_id.clone(), s.state.clone()))
            .collect();
        for (id, state) in stale {
            sessions.by_session.remove(&id);
            sessions.by_state.remove(&state);
        }
        for session in sessions.by_session.values_mut() {
            if now > session.expires_at && session.status == STATUS_PENDING {
                session.status = STATUS_EXPIRED.into();
                if session.error_message.is_empty() {
                    session.error_message = EXPIRED_MESSAGE.into();
                }
            }
        }
    }

    /// Makes a session restored from the client's saved token the active one.
    pub(crate) fn activate_restored(&self, payload: SessionPayload) {
        if payload.access_token.trim().is_empty() {
            return;
        }
        let expires_at = if payload.expires_at > 0 {
            payload.expires_at
        } else {
            now_millis() + 24 * 60 * MINUTE_MS
        };
        let session = ConnectSession {
            session_id: format!("portal_restored_{}", random_url_token(18)),
            state: format!("portal_restored_{}", random_url_token(18)),
            expires_at,
            status: STATUS_COMPLETED.into(),
            session: Some(payload),
            ..Default::default()
        };
        let mut sessions = self.lock();
        sessions.active = session.session_id.clone();
        sessions
            .by_state
            .insert(session.state.clone(), session.session_id.clone());
        sessions
            .by_session
            .insert(session.session_id.clone(), session);
    }

    pub(crate) fn clear_active_by_token(&self, access_token: &str) {
        let token = access_token.trim();
        if token.is_empty() {
            return;
        }
        let mut sessions = self.lock();
        if sessions.active.is_empty() {
            return;
        }
        let matches = match sessions
            .by_session
            .get(&sessions.active)
            .and_then(|s| s.session.as_ref())
        {
            None => true,
            Some(payload) => payload.access_token == token,
        };
        if matches {
            sessions.active.clear();
        }
    }

    /// The signed-in, unexpired account, if any.
    pub fn active_session(&self) -> Option<SessionPayload> {
        let sessions = self.lock();
        let session = sessions.by_session.get(&sessions.active)?;
        let payload = session.session.as_ref()?;
        if session.status != STATUS_COMPLETED {
            return None;
        }
        if payload.expires_at > 0 && now_millis() > payload.expires_at {
            return None;
        }
        Some(payload.clone())
    }

    /// True when a usable cloud account is signed in (gates AI features).
    pub fn signed_in(&self) -> bool {
        self.active_session()
            .is_some_and(|s| !s.access_token.trim().is_empty())
    }

    /// Calls the portal and decodes the result into `T`.
    pub(crate) async fn fetch<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        payload: Option<Value>,
        access_token: &str,
    ) -> Result<T, String> {
        let value = self.request(method, path, payload, access_token).await?;
        value
            .and_then(|v| decode_lenient(v).ok())
            .ok_or_else(|| "Failed to parse Portal response".to_owned())
    }

    /// The cloud base URL and bearer token for sibling features.
    pub fn credentials(&self) -> Result<CloudSession, String> {
        let session = self
            .active_session()
            .filter(|s| !s.access_token.trim().is_empty())
            .ok_or_else(|| NOT_LOGGED_IN.to_owned())?;
        let base_url = self.base_url.trim().trim_end_matches('/').to_owned();
        if base_url.is_empty() {
            return Err("kition console base URL is not configured".into());
        }
        if !is_secure_portal(&base_url) {
            return Err(INSECURE_PORTAL.into());
        }
        Ok(CloudSession {
            base_url,
            access_token: session.access_token.trim().to_owned(),
        })
    }

    pub fn cloud_session_provider(&self) -> CloudSessionProvider {
        let auth = self.clone();
        Arc::new(move || auth.credentials())
    }

    /// Calls the portal; a `{data, error}` envelope is unwrapped and portal
    /// errors become user-facing messages. A successful but unparseable body
    /// is `None`.
    pub(crate) async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        payload: Option<Value>,
        access_token: &str,
    ) -> Result<Option<Value>, String> {
        if !access_token.trim().is_empty() && !is_secure_portal(&self.base_url) {
            return Err(INSECURE_PORTAL.into());
        }
        let url = resolve_portal_url(&self.base_url, path);
        let mut request = self
            .client
            .request(method, url)
            .header("Accept", "application/json");
        if let Some(body) = &payload {
            request = request
                .header("Content-Type", "application/json")
                .body(body.to_string());
        }
        if !access_token.trim().is_empty() {
            request = request.header("Authorization", format!("Bearer {}", access_token.trim()));
        }
        let response = request.send().await.map_err(|_| {
            "Failed to reach Portal; please check your network and try again.".to_owned()
        })?;
        let status = response.status().as_u16();
        let body = read_limited(response)
            .await
            .map_err(|_| "Failed to read Portal response".to_owned())?;
        let parsed: Option<Value> = serde_json::from_slice(&body).ok();
        let envelope = parsed.as_ref().and_then(Value::as_object);
        if status >= 400 {
            let message = envelope
                .and_then(|m| m.get("error"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_owned();
            let message = if message.is_empty() {
                compact_remote_error(&body)
            } else {
                message
            };
            return Err(message);
        }
        Ok(match envelope.and_then(|m| m.get("data")) {
            Some(data) => Some(data.clone()),
            None => parsed,
        })
    }
}

/// Reads at most 2 MiB of a response body.
pub(crate) async fn read_limited(
    mut response: reqwest::Response,
) -> Result<Vec<u8>, reqwest::Error> {
    const LIMIT: usize = 2 << 20;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let room = LIMIT - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() >= LIMIT {
            break;
        }
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(token: &str, expires_at: i64) -> SessionPayload {
        SessionPayload {
            access_token: token.into(),
            expires_at,
            ..Default::default()
        }
    }

    #[test]
    fn only_trusts_secure_portals() {
        assert!(is_secure_portal("https://kition.ai"));
        assert!(is_secure_portal("http://127.0.0.1:9000"));
        assert!(!is_secure_portal("http://kition.ai"));
        assert!(!is_secure_portal("not a url"));
        let auth = PortalAuth::new("http://portal.example");
        auth.activate_restored(payload("tok", 0));
        assert_eq!(auth.credentials(), Err(INSECURE_PORTAL.to_owned()));
    }

    #[test]
    fn tracks_the_active_session() {
        let auth = PortalAuth::new("https://portal.test/");
        assert!(!auth.signed_in());
        assert_eq!(auth.credentials(), Err(NOT_LOGGED_IN.to_owned()));
        auth.save(ConnectSession {
            session_id: "s1".into(),
            state: "st1".into(),
            expires_at: now_millis() + 60_000,
            status: STATUS_PENDING.into(),
            ..Default::default()
        });
        auth.complete_by_state("st1", payload("tok", 0));
        assert!(auth.signed_in());
        assert_eq!(
            auth.credentials(),
            Ok(CloudSession {
                base_url: "https://portal.test".into(),
                access_token: "tok".into()
            })
        );
        auth.clear_active_by_token("other");
        assert!(auth.signed_in());
        auth.clear_active_by_token("tok");
        assert!(!auth.signed_in());
        auth.activate_restored(payload("old", now_millis() - 1));
        assert!(!auth.signed_in(), "expired sessions are not active");
    }

    #[test]
    fn prunes_and_expires_pending_sessions() {
        let auth = PortalAuth::new("");
        let now = now_millis();
        for (id, expires_at) in [
            ("fresh", now + 1000),
            ("late", now - 1000),
            ("gone", now - 31 * MINUTE_MS),
        ] {
            auth.save(ConnectSession {
                session_id: id.into(),
                state: format!("state-{id}"),
                expires_at,
                status: STATUS_PENDING.into(),
                ..Default::default()
            });
        }
        auth.prune_expired(now);
        assert_eq!(
            auth.get("fresh").map(|s| s.status),
            Some(STATUS_PENDING.to_owned())
        );
        let late = auth.get("late").unwrap_or_default();
        assert_eq!(
            (late.status.as_str(), late.error_message.as_str()),
            (STATUS_EXPIRED, EXPIRED_MESSAGE)
        );
        assert!(auth.get("gone").is_none() && auth.get_by_state("state-gone").is_none());
    }

    #[test]
    fn resolves_urls_and_challenges() {
        assert_eq!(
            resolve_portal_url("https://p.test/", "/a"),
            "https://p.test/a"
        );
        assert_eq!(
            resolve_portal_url("https://p.test", "a"),
            "https://p.test/a"
        );
        assert_eq!(
            resolve_portal_url("https://p.test", "https://x/y"),
            "https://x/y"
        );
        assert_eq!(resolve_portal_url("", "/a"), "/a");
        assert_eq!(resolve_portal_url("https://p.test/", " "), "https://p.test");
        // RFC 7636 appendix B.
        assert_eq!(
            s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(random_url_token(24).len(), 32);
        assert_eq!(compact_remote_error(b"  "), "Unknown error");
        assert_eq!(compact_remote_error("x".repeat(200).as_bytes()).len(), 183);
    }

    #[test]
    fn prefers_the_nested_credit_summary() {
        let remote: RemoteAccount = decode_lenient(serde_json::json!({
            "token": "t", "user_id": 7, "credit_total": 5, "plan_code": null,
            "credit_summary": {"credit_total": 9, "plan_code": " pro "}
        }))
        .unwrap_or_default();
        let session = SessionPayload::from_remote(" t ", &remote, 1);
        assert_eq!(
            (
                session.credits.credit_total,
                session.credits.plan_code.as_str()
            ),
            (9, "pro")
        );
        assert_eq!(
            session.credit_summary.map(|c| c.plan_code),
            Some(" pro ".to_owned())
        );
        assert_eq!(session.access_token, "t");
    }
}
