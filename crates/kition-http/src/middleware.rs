//! Per-request context: trace ID, locale, and localized error bodies.

use axum::Json;
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::HeaderValue;
use kition_core::AppError;
use kition_core::i18n::Locale;
use kition_core::response::Envelope;

use crate::extract::RequestContext;

const REQUEST_ID: &str = "x-request-id";

/// Assigns the trace ID (from `X-Request-Id` or a new UUID) and the locale
/// (from `X-Locale`, then `Accept-Language`), echoes both as response
/// headers, and renders [`AppError`] bodies in the request locale.
pub async fn request_context(mut request: Request, next: Next) -> Response {
    let headers = request.headers();
    let trace_id = headers
        .get(REQUEST_ID)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_owned);
    let locale = match headers
        .get("x-locale")
        .and_then(|value| value.to_str().ok())
    {
        Some(explicit) if !explicit.is_empty() => Locale::normalize(explicit),
        _ => headers
            .get(http::header::ACCEPT_LANGUAGE)
            .and_then(|value| value.to_str().ok())
            .map_or(Locale::DEFAULT, Locale::from_accept_language),
    };
    let path = request.uri().path().to_owned();
    request.extensions_mut().insert(RequestContext {
        trace_id: trace_id.clone(),
        locale,
    });

    let mut response = next.run(request).await;
    if let Some(error) = response.extensions_mut().remove::<AppError>() {
        if error.status >= 500 {
            tracing::error!(error = %error, tid = %trace_id, path = %path, "request failed");
        } else {
            tracing::warn!(error = %error, tid = %trace_id, path = %path, "request failed");
        }
        let status = response.status();
        let body = Envelope::failure(error.code, error.localize(locale), error.data.clone());
        let mut rendered = (status, Json(body)).into_response();
        std::mem::swap(rendered.headers_mut(), response.headers_mut());
        rendered.headers_mut().remove(http::header::CONTENT_LENGTH);
        response = rendered;
    }
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&trace_id) {
        headers.insert(REQUEST_ID, value);
    }
    headers.insert(
        http::header::CONTENT_LANGUAGE,
        HeaderValue::from_static(locale.as_str()),
    );
    response
}

#[cfg(test)]
mod tests {
    use axum::Router;
    use axum::body::Body;
    use axum::routing::get;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    fn app() -> Router {
        Router::new()
            .route(
                "/fail",
                get(|| async { AppError::localized_unauthorized("auth.unauthorized") }),
            )
            .route("/ok", get(|| async { "fine" }))
            .layer(axum::middleware::from_fn(request_context))
    }

    async fn body(response: Response) -> serde_json::Value {
        let bytes = response
            .into_body()
            .collect()
            .await
            .map(|b| b.to_bytes())
            .unwrap_or_default();
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    #[tokio::test]
    async fn renders_errors_in_request_locale() {
        let request = Request::get("/fail")
            .header("Accept-Language", "zh-CN")
            .body(Body::empty());
        let response = app()
            .oneshot(request.unwrap_or_default())
            .await
            .unwrap_or_else(|err| match err {});
        assert_eq!(response.status(), http::StatusCode::UNAUTHORIZED);
        assert_eq!(
            response
                .headers()
                .get("content-language")
                .and_then(|v| v.to_str().ok()),
            Some("zh-CN")
        );
        let json = body(response).await;
        assert_eq!(json["code"], 401);
        assert_ne!(json["message"], "Unauthorized, please sign in again");
    }

    #[tokio::test]
    async fn echoes_or_generates_trace_id() {
        let request = Request::get("/ok")
            .header("X-Request-Id", "abc")
            .body(Body::empty());
        let response = app()
            .oneshot(request.unwrap_or_default())
            .await
            .unwrap_or_else(|err| match err {});
        assert_eq!(
            response
                .headers()
                .get("x-request-id")
                .and_then(|v| v.to_str().ok()),
            Some("abc")
        );
        let response = app()
            .oneshot(Request::get("/ok").body(Body::empty()).unwrap_or_default())
            .await
            .unwrap_or_else(|err| match err {});
        let generated = response
            .headers()
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert_eq!(generated.len(), 36);
        assert_eq!(
            response
                .headers()
                .get("content-language")
                .and_then(|v| v.to_str().ok()),
            Some("en-US")
        );
    }
}
