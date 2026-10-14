//! Request origin checks. The API only answers requests addressed to a
//! loopback host, which defeats DNS rebinding. Loopback and desktop-app
//! origins are allowed with credentials, other cross-origin requests get
//! `403`, and preflights end with `204` before any other middleware runs.

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};

const ALLOWED_ORIGINS: [&str; 2] = ["http://localhost:34115", "http://127.0.0.1:34115"];
/// The desktop app's renderer: `tauri://localhost` on macOS and Linux, and
/// `tauri.localhost` on Windows.
const DESKTOP_SHELL_ORIGINS: [&str; 3] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];
const ALLOW_METHODS: &str = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
// `Range` lets kit workers read workspace media in ranges (lent files in docs/kit-sdk.md).
// `Kition-Session` tags a data-document request with this window's session so the
// runtime can skip the origin's own `table/changed` events; `Kition-Origin` marks
// template seeding requests that run before any window session exists.
const ALLOW_HEADERS: &str =
    "Authorization,Content-Type,X-Request-Id,X-Locale,Range,Kition-Session,Kition-Origin";
// Kit editors follow a file by its `ETag`, and lent reads check `Content-Range`.
const EXPOSE_HEADERS: &str = "ETag,Content-Range,Accept-Ranges";

fn origin_allowed(origin: &str) -> bool {
    ALLOWED_ORIGINS.contains(&origin)
        || DESKTOP_SHELL_ORIGINS.contains(&origin)
        || origin.starts_with("http://localhost:")
        || origin.starts_with("http://127.0.0.1:")
}

/// Whether a `Host` header names this machine.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or_default()
    } else {
        host.rsplit_once(':').map_or(host, |(name, _)| name)
    };
    matches!(
        name.to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1"
    )
}

pub async fn cors(request: Request, next: Next) -> Response {
    let host_allowed = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_none_or(is_loopback_host);
    if !host_allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(origin) = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
    else {
        return next.run(request).await;
    };
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if origin == format!("http://{host}") || origin == format!("https://{host}") {
        return next.run(request).await;
    }
    if !origin_allowed(&origin) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(origin_value) = HeaderValue::from_str(&origin) else {
        return StatusCode::FORBIDDEN.into_response();
    };

    if request.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        let headers = response.headers_mut();
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static(ALLOW_METHODS),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(ALLOW_HEADERS),
        );
        headers.append(header::VARY, HeaderValue::from_static("Origin"));
        headers.append(
            header::VARY,
            HeaderValue::from_static("Access-Control-Request-Method"),
        );
        headers.append(
            header::VARY,
            HeaderValue::from_static("Access-Control-Request-Headers"),
        );
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin_value);
        return response;
    }

    let mut response = next.run(request).await;
    apply_normal(response.headers_mut(), origin_value);
    response
}

fn apply_normal(headers: &mut HeaderMap, origin: HeaderValue) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPOSE_HEADERS),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::routing::get;
    use tower::ServiceExt;

    use super::*;

    fn app() -> Router {
        Router::new()
            .route("/x", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn(cors))
    }

    async fn send(request: http::request::Builder) -> Response {
        app()
            .oneshot(request.body(Body::empty()).unwrap_or_default())
            .await
            .unwrap_or_else(|err| match err {})
    }

    fn header_text<'a>(response: &'a Response, name: &str) -> Vec<&'a str> {
        response
            .headers()
            .get_all(name)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .collect()
    }

    #[tokio::test]
    async fn preflight_from_loopback() {
        let response = send(
            Request::options("/x")
                .header("Origin", "http://localhost:5173")
                .header("Host", "127.0.0.1:18101"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            header_text(&response, "access-control-allow-origin"),
            ["http://localhost:5173"]
        );
        assert_eq!(
            header_text(&response, "access-control-allow-methods"),
            [ALLOW_METHODS]
        );
        assert_eq!(header_text(&response, "vary").len(), 3);
    }

    #[tokio::test]
    async fn normal_request_gets_cors_headers() {
        let response = send(Request::get("/x").header("Origin", "http://127.0.0.1:9000")).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            header_text(&response, "access-control-allow-credentials"),
            ["true"]
        );
        assert_eq!(header_text(&response, "vary"), ["Origin"]);
        assert_eq!(
            header_text(&response, "access-control-expose-headers"),
            [EXPOSE_HEADERS]
        );
        assert!(ALLOW_HEADERS.split(',').any(|name| name == "Range"));
        assert!(ALLOW_HEADERS.split(',').any(|name| name == "Kition-Session"));
        assert!(ALLOW_HEADERS.split(',').any(|name| name == "Kition-Origin"));
    }

    #[tokio::test]
    async fn desktop_shell_origins_are_allowed() {
        for origin in DESKTOP_SHELL_ORIGINS {
            let response = send(Request::get("/x").header("Origin", origin)).await;
            assert_eq!(response.status(), StatusCode::OK, "{origin}");
            assert_eq!(
                header_text(&response, "access-control-allow-origin"),
                [origin]
            );
        }
        let lookalike = send(Request::get("/x").header("Origin", "tauri://evil.example")).await;
        assert_eq!(lookalike.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn non_loopback_hosts_are_forbidden() {
        for host in [
            "evil.example:18101",
            "192.168.1.5:18101",
            "localhost.evil.example",
        ] {
            let response = send(Request::get("/x").header("Host", host)).await;
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{host}");
        }
        for host in [
            "127.0.0.1:18101",
            "localhost:3000",
            "[::1]:18101",
            "LOCALHOST",
        ] {
            let response = send(Request::get("/x").header("Host", host)).await;
            assert_eq!(response.status(), StatusCode::OK, "{host}");
        }
    }

    #[tokio::test]
    async fn foreign_origin_is_forbidden() {
        let response = send(Request::get("/x").header("Origin", "https://example.com")).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn same_origin_and_no_origin_pass_through() {
        let same = send(
            Request::get("/x")
                .header("Origin", "http://127.0.0.1:1")
                .header("Host", "127.0.0.1:1"),
        )
        .await;
        assert_eq!(same.status(), StatusCode::OK);
        assert!(header_text(&same, "access-control-allow-origin").is_empty());
        let none = send(Request::get("/x")).await;
        assert_eq!(none.status(), StatusCode::OK);
    }
}
