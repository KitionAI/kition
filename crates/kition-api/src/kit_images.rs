//! `POST /kits/images/fetch`: Kition's answer to a kit's `host/fetchImage` (Kit UI protocol
//! section 7l). A kit loads nothing from the network and the renderer cannot read another
//! site's picture, so the runtime downloads it, from public addresses only (the agent's
//! `fetch_image`: never loopback, private, or link-local addresses, at any redirect), and answers
//! its bytes with its type. Only Kition's renderer, with this launch's token, may ask.

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Extension, Router};
use kition_core::{AppError, AppResult};
use kition_http::gate::Access;
use kition_http::{AuthConfig, CurrentUser, JsonBody};
use serde::Deserialize;
use serde_json::json;

#[derive(Clone)]
pub struct KitImagesState {
    pub auth: AuthConfig,
    /// The agent's client for public web reads: it leaves redirects to `fetch_image`.
    pub web: reqwest::Client,
}

impl axum::extract::FromRef<KitImagesState> for AuthConfig {
    fn from_ref(state: &KitImagesState) -> Self {
        state.auth.clone()
    }
}

pub fn router(state: KitImagesState) -> Router {
    Router::new()
        .route("/kits/images/fetch", post(fetch))
        .with_state(state)
}

#[derive(Deserialize)]
struct FetchBody {
    url: String,
}

async fn fetch(
    State(state): State<KitImagesState>,
    access: Option<Extension<Access>>,
    _user: CurrentUser,
    JsonBody(body): JsonBody<FetchBody>,
) -> AppResult<Response> {
    if access.map(|Extension(access)| access) != Some(Access::Token) {
        return Err(AppError::localized_unauthorized("auth.unauthorized"));
    }
    let image = kition_agent::fetch_image(&state.web, &body.url)
        .await
        .map_err(refusal)?;
    Ok((
        [
            (http::header::CONTENT_TYPE, image.mime),
            (http::header::CACHE_CONTROL, "no-store".to_owned()),
        ],
        image.data,
    )
        .into_response())
}

/// A refusal with the Kit UI protocol's reason in `data.reason`.
fn refusal(error: kition_agent::ImageFetchError) -> AppError {
    use kition_agent::ImageFetchError;
    let (status, code) = match &error {
        ImageFetchError::NotAllowed(_) => (403, 40320),
        ImageFetchError::TooLarge => (413, 41320),
        ImageFetchError::NotAnImage(_) => (415, 41520),
        ImageFetchError::Failed(_) => (502, 50220),
    };
    AppError::new(status, code, error.to_string()).with_data(json!({ "reason": error.reason() }))
}
