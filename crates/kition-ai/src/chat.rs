//! `POST /ai/chat`: a one-shot completion with the client's model settings.

use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::response::Response;
use axum::routing::post;
use kition_core::{AppError, AppResult};
use kition_http::{AuthConfig, CurrentUser, JsonBody, ok};
use serde::Deserialize;

use crate::engine::{Engine, Message, RuntimeModel};

/// Whether a signed-in cloud account allows AI features.
pub type AiGate = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Clone)]
pub struct ChatState {
    pub auth: AuthConfig,
    pub engine: Engine,
    pub ai_gate: AiGate,
}

impl axum::extract::FromRef<ChatState> for AuthConfig {
    fn from_ref(state: &ChatState) -> Self {
        state.auth.clone()
    }
}

pub fn require_ai(gate: &AiGate) -> AppResult<()> {
    if gate() {
        Ok(())
    } else {
        Err(AppError::localized(
            401,
            4015,
            "auth.ai_login_required",
            Vec::new(),
        ))
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ChatRequest {
    scene_type: String,
    messages: Vec<ChatMessage>,
    runtime_model: Option<RuntimeModel>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ChatMessage {
    role: String,
    content: String,
}

pub fn router(state: ChatState) -> Router {
    Router::new()
        .route("/ai/chat", post(chat))
        .with_state(state)
}

async fn chat(
    State(state): State<ChatState>,
    _user: CurrentUser,
    JsonBody(request): JsonBody<ChatRequest>,
) -> AppResult<Response> {
    require_ai(&state.ai_gate)?;
    let messages: Vec<Message> = request
        .messages
        .into_iter()
        .map(|message| Message::new(&message.role, message.content))
        .collect();
    let model = request.runtime_model.unwrap_or_default();
    match state
        .engine
        .chat(&messages, &request.scene_type, &model)
        .await
    {
        Ok(result) => Ok(ok(result)),
        Err(error) => {
            tracing::warn!(error = %error, "AI chat failed");
            Err(AppError::internal(error.to_string()))
        }
    }
}
