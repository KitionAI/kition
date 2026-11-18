//! The sign-in flow and model discovery against a fake portal.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Request, StatusCode};
use axum::routing::{get, post};
use http_body_util::BodyExt;
use kition_desktop::discover::{DiscoverRequest, discover};
use kition_desktop::{DesktopState, HookRunner, PortalAuth};
use kition_http::AuthConfig;
use kition_store::Db;
use serde_json::{Value, json};
use tower::ServiceExt;

#[derive(Clone, Default)]
struct Seen(Arc<Mutex<Vec<(String, Value, String)>>>);

impl Seen {
    fn push(&self, path: &str, body: Value, auth: &HeaderMap) {
        let auth = auth
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((path.to_owned(), body, auth));
    }

    fn all(&self) -> Vec<(String, Value, String)> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

async fn fake_portal() -> (String, Seen) {
    let seen = Seen::default();
    let app = Router::new()
        .route(
            "/api/oauth/desktop/start",
            post(|State(seen): State<Seen>, headers: HeaderMap, body: String| async move {
                seen.push("start", serde_json::from_str(&body).unwrap_or_default(), &headers);
                axum::Json(json!({"data": {"challenge_id": "c1", "authorize_url": "/login?x=1", "expires_at": 0, "poll_interval_seconds": 2}}))
            }),
        )
        .route(
            "/api/oauth/desktop/exchange",
            post(|State(seen): State<Seen>, headers: HeaderMap, body: String| async move {
                seen.push("exchange", serde_json::from_str(&body).unwrap_or_default(), &headers);
                axum::Json(json!({"data": {"token": "tok-1", "token_prefix": "tok", "user_id": 42, "user_email": "a@example.invalid",
                    "expires_at": 0, "credit_balance": 7, "plan_code": " pro "}}))
            }),
        )
        .route(
            "/api/oauth/desktop/session",
            get(|State(seen): State<Seen>, headers: HeaderMap| async move {
                seen.push("session", Value::Null, &headers);
                let ok = headers.get("authorization").is_some_and(|v| v == "Bearer tok-1");
                axum::Json(json!({"data": {"authenticated": ok, "user_id": 42, "credit_summary": {"credit_balance": 9}}}))
            }),
        )
        .route(
            "/api/oauth/desktop/logout",
            post(|State(seen): State<Seen>, headers: HeaderMap| async move {
                seen.push("logout", Value::Null, &headers);
                (StatusCode::OK, "")
            }),
        )
        .route(
            "/api/llm/v1/models",
            get(|headers: HeaderMap| async move {
                let ok = headers.get("authorization").is_some_and(|v| v == "Bearer tok-1");
                if ok {
                    (StatusCode::OK, axum::Json(json!({"data": [{"id": "gpt-b"}, {"id": "gpt-a"}]})))
                } else {
                    (StatusCode::UNAUTHORIZED, axum::Json(json!({"error": "nope"})))
                }
            }),
        )
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let addr = listener.local_addr().unwrap_or_else(|err| panic!("{err}"));
    tokio::spawn(async move { axum::serve(listener, app).await });
    (format!("http://{addr}"), seen)
}

async fn call(app: &Router, method: &str, uri: &str, body: Value) -> (StatusCode, String) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "127.0.0.1:9999")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|err| panic!("{err}"));
    let response = app
        .clone()
        .oneshot(request)
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .map(|b| b.to_bytes())
        .unwrap_or_default();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn data(text: &str) -> Value {
    serde_json::from_str::<Value>(text).unwrap_or_default()["data"].clone()
}

#[tokio::test]
async fn signs_in_restores_and_signs_out() {
    let (base, seen) = fake_portal().await;
    let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
    let portal = PortalAuth::new(&base);
    let app = kition_desktop::router(DesktopState {
        auth: AuthConfig {
            db: db.clone(),
            jwt_secret: String::new(),
            disabled: true,
        },
        portal: portal.clone(),
        hooks: HookRunner {
            db,
            logs_dir: None,
            workspace_dir: None,
        },
        workspace_dir: None,
        callback_url: "http://127.0.0.1:9999/api/v1/desktop/portal/callback".into(),
    });

    let (status, body) = call(&app, "POST", "/desktop/portal/connect/start", Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let start = data(&body);
    assert_eq!(start["authorize_url"], json!(format!("{base}/login?x=1")));
    assert_eq!(start["poll_interval_ms"], json!(2000));
    let session_id = start["session_id"].as_str().unwrap_or_default().to_owned();
    let sent = seen.all();
    assert_eq!(
        sent[0].1["redirect_uri"],
        json!("http://127.0.0.1:9999/api/v1/desktop/portal/callback")
    );
    let state = sent[0].1["state"].as_str().unwrap_or_default().to_owned();

    let (_, pending) = call(
        &app,
        "GET",
        &format!("/desktop/portal/connect/result/{session_id}"),
        Value::Null,
    )
    .await;
    assert_eq!(data(&pending)["status"], json!("pending"));

    let (status, page) = call(
        &app,
        "GET",
        &format!("/desktop/portal/callback?code=abc&state={state}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(page.contains("Login complete") && page.contains("kition://auth/complete"));
    let exchange = &seen.all()[1].1;
    assert_eq!(
        (exchange["challenge_id"].as_str(), exchange["code"].as_str()),
        (Some("c1"), Some("abc"))
    );
    assert_eq!(
        portal.credentials().map(|c| c.access_token),
        Ok("tok-1".to_owned())
    );

    let (_, done) = call(
        &app,
        "GET",
        &format!("/desktop/portal/connect/result/{session_id}"),
        Value::Null,
    )
    .await;
    let done = data(&done);
    assert_eq!(
        (done["status"].clone(), done["session"]["plan_code"].clone()),
        (json!("completed"), json!("pro"))
    );

    let (status, page) = call(
        &app,
        "GET",
        "/desktop/portal/callback?code=abc&state=unknown",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(page.contains("no longer valid"));

    let found = discover(
        &portal,
        DiscoverRequest {
            provider_type: "kition_console".into(),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(
        found,
        Ok((
            vec!["gpt-a".to_owned(), "gpt-b".to_owned()],
            format!("{base}/api/llm/v1/models")
        ))
    );

    let (status, body) = call(
        &app,
        "POST",
        "/desktop/portal/logout",
        json!({"access_token": "tok-1"}),
    )
    .await;
    assert_eq!(
        (status, data(&body)),
        (StatusCode::OK, json!({"success": true}))
    );
    assert!(!portal.signed_in());

    let (_, restored) = call(
        &app,
        "POST",
        "/desktop/portal/session/status",
        json!({"access_token": "tok-1"}),
    )
    .await;
    let restored = data(&restored);
    assert_eq!(
        (
            restored["authenticated"].clone(),
            restored["credit_balance"].clone()
        ),
        (json!(true), json!(9))
    );
    assert!(portal.signed_in());
    let (_, rejected) = call(
        &app,
        "POST",
        "/desktop/portal/session/status",
        json!({"access_token": "other"}),
    )
    .await;
    assert_eq!(data(&rejected), json!({"authenticated": false}));

    let (status, _) = call(&app, "POST", "/desktop/portal/logout", json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}
