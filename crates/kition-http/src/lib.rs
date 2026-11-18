//! HTTP plumbing shared by every route group.

pub mod auth;
pub mod cors;
pub mod extract;
pub mod gate;
pub mod middleware;

use axum::Json;
use axum::Router;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use kition_core::response::Envelope;
use serde::Serialize;

pub use auth::{AuthConfig, CurrentUser, require_admin};
pub use extract::{JsonBody, RequestContext, decode_object};

/// `200 {"code":200,"message":"success","data":...}`.
pub fn ok<T: Serialize>(data: T) -> Response {
    match serde_json::to_value(data) {
        Ok(value) => Json(Envelope::success(value)).into_response(),
        Err(error) => kition_core::AppError::unhandled(error).into_response(),
    }
}

/// `200` with `{"message": ...}` as data.
pub fn ok_message(message: &str) -> Response {
    ok(serde_json::json!({ "message": message }))
}

/// The response for unknown routes, identical to the legacy router's.
pub async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(http::header::CONTENT_TYPE, "text/plain")],
        "404 page not found",
    )
        .into_response()
}

/// `routes` behind the transport checks every runtime answers through: the loopback `Host` and
/// origin checks ([`cors`]), then the API token gate ([`gate`]), both in front of routing, so a
/// refused request reaches no route and an unknown path is refused like a known one.
pub fn guard(routes: Router, gate: gate::ApiGate, policy: cors::CorsPolicy) -> Router {
    Router::new()
        .fallback_service(routes)
        .layer(axum::middleware::from_fn_with_state(gate, gate::require))
        .layer(axum::middleware::from_fn_with_state(policy, cors::cors))
}
