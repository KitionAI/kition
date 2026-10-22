//! The per-launch API token (contracts/runtime/transport.schema.json).
//!
//! The runtime can run commands as the person (desktop hooks run in their login shell), so no
//! caller may reach it on ambient authority: not another account on the machine, not a page in
//! the person's browser, not a kit's editor frame. Every request carries the token the host made
//! for this launch in the `Kition-Token` header, or is a signed URL (`/_signed/…`) made with it
//! for a read that cannot carry a header (`<img>`, `EventSource`, a kit engine's lent reads).
//! Anything else gets `401` before routing, so it has no side effect. A short, tested list of
//! routes stays open: the health probe and the portal sign-in callback the system browser
//! reaches.
//!
//! A signed URL is `/_signed/<expires>.<length>.<signature>/<path>`: `<signature>` is the
//! lower-case hex HMAC-SHA-256, keyed with the token, of `<expires>\n<scope>`, where `<scope>` is
//! the first `<length>` bytes of `/<path>` as sent (percent-encoded). A URL for one file signs
//! the whole path; a lent root signs a folder and the kit appends the rest. It serves `GET` and
//! `HEAD` only, until `<expires>` (Unix seconds), and only under the file services, the kit
//! bridge stream, and data-document blobs. The request is routed as `/<path>`.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::{Method, StatusCode, Uri};
use kition_core::response::Envelope;
use sha2::{Digest, Sha256};

/// The request header that carries the token.
pub const TOKEN_HEADER: &str = "kition-token";
/// Where signed URLs start.
pub const SIGNED_ROOT: &str = "/_signed/";
/// `data.reason` of the `401` answer.
pub const REFUSAL_REASON: &str = "api_token";

/// How a request passed the gate; the gate puts it in the request's extensions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// It carried the token.
    Token,
    /// A signed URL for one read.
    Signed,
    /// A route on the open list.
    Open,
}

/// The gate: this launch's token, the open routes, and the paths a signed URL may name.
#[derive(Clone)]
pub struct ApiGate(Arc<Inner>);

struct Inner {
    token: String,
    open: Vec<(Method, String)>,
    signable: Vec<String>,
}

/// A new token: 256 random bits, lower-case hex.
pub fn new_token() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}

impl ApiGate {
    /// The gate for `token` in front of a runtime whose API routes are under `api_prefix`.
    ///
    /// # Panics
    ///
    /// An empty token would let everyone in, so it is refused outright.
    pub fn new(token: &str, api_prefix: &str) -> Self {
        assert!(!token.is_empty(), "the API gate needs a token");
        let prefix = api_prefix.trim_end_matches('/');
        Self(Arc::new(Inner {
            token: token.to_owned(),
            open: vec![
                (Method::GET, "/health".to_owned()),
                (Method::GET, format!("{prefix}/desktop/portal/callback")),
            ],
            signable: vec![
                "/workspace-files/".to_owned(),
                "/kit-files/".to_owned(),
                "/uploads/".to_owned(),
                format!("{prefix}/kits/bridge"),
                format!("{prefix}/data-documents/"),
            ],
        }))
    }

    /// The routes that need no token, as `(method, path)`.
    pub fn open_routes(&self) -> impl Iterator<Item = (&Method, &str)> {
        self.0
            .open
            .iter()
            .map(|(method, path)| (method, path.as_str()))
    }

    /// The signature of `scope` until `expires`.
    pub fn signature(&self, scope: &str, expires: u64) -> String {
        hex::encode(hmac_sha256(
            self.0.token.as_bytes(),
            format!("{expires}\n{scope}").as_bytes(),
        ))
    }

    /// A signed URL path for `path` (percent-encoded, from `/`), whose first `scope_len` bytes are
    /// signed. Kition's renderer makes these; Rust callers and tests use this.
    pub fn signed_path(&self, path: &str, scope_len: usize, expires: u64) -> String {
        let scope = path.get(..scope_len).unwrap_or(path);
        format!(
            "{SIGNED_ROOT}{expires}.{}.{}{path}",
            scope.len(),
            self.signature(scope, expires)
        )
    }

    fn token_matches(&self, presented: &[u8]) -> bool {
        constant_time_eq(presented, self.0.token.as_bytes())
    }

    fn is_open(&self, method: &Method, path: &str) -> bool {
        self.0
            .open
            .iter()
            .any(|(open_method, open_path)| open_method == method && open_path == path)
    }

    /// The path a signed URL path names, when its signature holds now.
    fn verify_signed(&self, method: &Method, path: &str, now: u64) -> Option<String> {
        if method != Method::GET && method != Method::HEAD {
            return None;
        }
        let rest = path.strip_prefix(SIGNED_ROOT)?;
        let (stamp, target) = rest.split_at(rest.find('/')?);
        let mut parts = stamp.splitn(3, '.');
        let expires: u64 = parts.next()?.parse().ok()?;
        let length: usize = parts.next()?.parse().ok()?;
        let signature = hex::decode(parts.next()?).ok()?;
        if expires < now || length == 0 {
            return None;
        }
        let scope = target.get(..length)?;
        if !self
            .0
            .signable
            .iter()
            .any(|prefix| scope.starts_with(prefix.as_str()))
        {
            return None;
        }
        let expected = hmac_sha256(
            self.0.token.as_bytes(),
            format!("{expires}\n{scope}").as_bytes(),
        );
        constant_time_eq(&signature, &expected).then(|| target.to_owned())
    }
}

/// The gate as middleware. Put it in front of routing ([`crate::guard`]): a signed URL is routed
/// by the path it names.
pub async fn require(State(gate): State<ApiGate>, mut request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    if path.starts_with(SIGNED_ROOT) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        let Some(target) = gate.verify_signed(request.method(), &path, now) else {
            return refused();
        };
        let rewritten = match request.uri().query() {
            Some(query) => format!("{target}?{query}"),
            None => target,
        };
        let Ok(uri) = rewritten.parse::<Uri>() else {
            return refused();
        };
        *request.uri_mut() = uri;
        request.extensions_mut().insert(Access::Signed);
        return next.run(request).await;
    }
    let access = if request
        .headers()
        .get(TOKEN_HEADER)
        .is_some_and(|value| gate.token_matches(value.as_bytes()))
    {
        Access::Token
    } else if gate.is_open(request.method(), &path) {
        Access::Open
    } else {
        return refused();
    };
    request.extensions_mut().insert(access);
    next.run(request).await
}

fn refused() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(Envelope::failure(
            401,
            "This request needs Kition's API token.",
            serde_json::json!({ "reason": REFUSAL_REASON }),
        )),
    )
        .into_response()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

/// HMAC-SHA-256 (RFC 2104).
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::routing::{get, post};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    const TOKEN: &str = "test-token";

    fn app() -> (Router, ApiGate) {
        let gate = ApiGate::new(TOKEN, "/api/v1");
        let inner = Router::new()
            .route("/health", get(|| async { "healthy" }))
            .route("/api/v1/desktop/hooks", post(|| async { "made" }))
            .route(
                "/api/v1/desktop/portal/callback",
                get(|| async { "signed in" }),
            )
            .route(
                "/workspace-files/{*path}",
                get(|request: Request| async move {
                    format!(
                        "{} {:?}",
                        request.uri(),
                        request.extensions().get::<Access>()
                    )
                }),
            )
            .route("/api/v1/kits/bridge", get(|| async { "stream" }));
        (
            crate::guard(inner, gate.clone(), crate::cors::CorsPolicy::default()),
            gate,
        )
    }

    async fn send(app: &Router, request: http::request::Builder) -> (StatusCode, String) {
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap_or_default())
            .await
            .unwrap_or_else(|err| match err {});
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .map(|body| body.to_bytes())
            .unwrap_or_default();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        // Test case 2.
        assert_eq!(
            hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // Test case 6: a key longer than the block.
        assert_eq!(
            hex::encode(hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    /// Validates `instance` against one `$defs` entry of contracts/runtime/transport.schema.json.
    fn check_contract(def: &str, instance: &serde_json::Value) {
        let mut schema: serde_json::Value = serde_json::from_str(include_str!(
            "../../../contracts/runtime/transport.schema.json"
        ))
        .unwrap_or_else(|err| panic!("{err}"));
        schema["$ref"] = serde_json::json!(format!("#/$defs/{def}"));
        let validator = jsonschema::validator_for(&schema).unwrap_or_else(|err| panic!("{err}"));
        assert!(validator.is_valid(instance), "{def}: {instance}");
    }

    #[tokio::test]
    async fn answers_follow_the_contract() {
        let (app, gate) = app();
        let (status, body) = send(&app, Request::get("/api/v1/kits/bridge")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        check_contract(
            "refusal",
            &serde_json::from_str(&body).unwrap_or_else(|err| panic!("{err}")),
        );
        check_contract("tokenHeader", &serde_json::json!("Kition-Token"));
        assert!(TOKEN_HEADER.eq_ignore_ascii_case("Kition-Token"));
        let signed = gate.signed_path("/kit-files/", 11, 4_102_444_800);
        check_contract("signedPath", &serde_json::json!(signed));
        for (method, path) in gate.open_routes() {
            check_contract(
                "openRoute",
                &serde_json::json!({ "method": method.as_str(), "path": path }),
            );
        }
    }

    #[test]
    fn signed_paths_match_the_contracts_example() {
        // The same example is checked by the renderer's signer (src/services/runtimeAuth.spec.ts).
        assert_eq!(
            ApiGate::new(TOKEN, "/api/v1").signed_path("/kit-files/", 11, 4_102_444_800),
            "/_signed/4102444800.11.38171d08275ed2553e0d9f40dfd420d46ee6117cb075fb48a5b4e0c8e7e75d3a/kit-files/"
        );
    }

    #[test]
    fn tokens_are_long_and_fresh() {
        let token = new_token();
        assert_eq!(token.len(), 64);
        assert_ne!(token, new_token());
    }

    #[tokio::test]
    async fn requests_without_the_token_are_refused_before_routing() {
        let (app, _) = app();
        let (status, body) = send(&app, Request::post("/api/v1/desktop/hooks")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.contains(REFUSAL_REASON), "{body}");
        // An unknown path is refused too, not answered 404: nothing reveals the routes.
        let (status, _) = send(&app, Request::get("/no/such/route")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        for wrong in ["", "test-toke", "test-token2", "TEST-TOKEN"] {
            let (status, _) = send(
                &app,
                Request::post("/api/v1/desktop/hooks").header(TOKEN_HEADER, wrong),
            )
            .await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{wrong:?}");
        }
        // The token belongs in its own header; a bearer credential is not it.
        let (status, _) = send(
            &app,
            Request::post("/api/v1/desktop/hooks").header("Authorization", "Bearer test-token"),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, body) = send(
            &app,
            Request::post("/api/v1/desktop/hooks").header(TOKEN_HEADER, TOKEN),
        )
        .await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "made"));
    }

    #[tokio::test]
    async fn only_the_open_list_needs_no_token() {
        let (app, gate) = app();
        assert_eq!(
            gate.open_routes()
                .map(|(method, path)| format!("{method} {path}"))
                .collect::<Vec<_>>(),
            ["GET /health", "GET /api/v1/desktop/portal/callback"]
        );
        assert_eq!(send(&app, Request::get("/health")).await.0, StatusCode::OK);
        assert_eq!(
            send(&app, Request::get("/api/v1/desktop/portal/callback"))
                .await
                .0,
            StatusCode::OK
        );
        // The open list names a method too.
        assert_eq!(
            send(&app, Request::post("/health")).await.0,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn signed_urls_read_one_scope_until_they_expire() {
        let (app, gate) = app();
        let later = 4_102_444_800;
        let file = "/workspace-files/art/cover%20one.png";
        let (status, body) = send(
            &app,
            Request::get(format!("{}?v=2", gate.signed_path(file, file.len(), later))),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, format!("{file}?v=2 Some(Signed)"));

        // A folder scope: anything below it.
        let root = "/workspace-files/art/";
        let signed_root = gate.signed_path(root, root.len(), later);
        let (status, _) = send(&app, Request::get(format!("{signed_root}deep/clip.mp4"))).await;
        assert_eq!(status, StatusCode::OK);

        let refusals = [
            // Another file than the one signed.
            gate.signed_path(file, file.len(), later)
                .replace("cover%20one", "cover%20two"),
            // Outside the signed folder (the browser resolves `..` before it sends).
            format!("{}/workspace-files/secret.txt", {
                let signed = gate.signed_path(root, root.len(), later);
                signed[..signed.len() - root.len()].to_owned()
            }),
            // Expired.
            gate.signed_path(file, file.len(), 1),
            // A route a signed URL never serves.
            gate.signed_path("/api/v1/desktop/hooks", 21, later),
            // Signed with another token.
            ApiGate::new("other", "/api/v1").signed_path(file, file.len(), later),
            // Malformed.
            "/_signed/x/workspace-files/a.png".to_owned(),
            format!("/_signed/{later}.0.00/workspace-files/a.png"),
            format!("/_signed/{later}.999.00/workspace-files/a.png"),
        ];
        for path in refusals {
            assert_eq!(
                send(&app, Request::get(&path)).await.0,
                StatusCode::UNAUTHORIZED,
                "{path}"
            );
        }
        // Reads only.
        assert_eq!(
            send(
                &app,
                Request::post(gate.signed_path(file, file.len(), later))
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        let bridge = "/api/v1/kits/bridge";
        assert_eq!(
            send(
                &app,
                Request::get(gate.signed_path(bridge, bridge.len(), later))
            )
            .await
            .0,
            StatusCode::OK
        );
    }
}
