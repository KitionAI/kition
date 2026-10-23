//! `POST /ai/generate`: a model call a kit asks the host for (Kit UI protocol 2.4 section 7j,
//! `host/generate`), run with the person's model settings.
//!
//! The runtime serves the protocol's defined purposes: `ai-field` (an AI field's cell) and
//! `rewrite` (text the person selected, rewritten as they asked). A kit's own purposes
//! (`<kit>.<name>`) are refused before they get here, because Kition has no generic handling
//! for them.
//!
//! The kit stays offline: it builds the prompt from what its document holds and the renderer
//! forwards it here with the runtime model the person's settings choose. The answer is text, or
//! one image as base64; the kit writes it into its document itself (UI-G3). The kit never sees a
//! key or an endpoint (UI-G2). A refusal carries `data.reason`: `unavailable` (no model),
//! `not-allowed` (an unknown purpose), `quota` (no credits left), `too-large`, `timeout`, or
//! `failed`.

use std::time::Instant;

use axum::Router;
use axum::extract::State;
use axum::response::Response;
use axum::routing::post;
use base64::Engine as _;
use kition_core::{AppError, AppResult};
use kition_http::{AuthConfig, CurrentUser, JsonBody, ok};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::chat::{AiGate, require_ai};
use crate::engine::{AiError, Engine, ImageRequest, Message, MessagePart, RuntimeModel};

/// The purposes a kit may generate for (Kit UI protocol 2.4 section 7j's defined purposes).
const PURPOSES: &[&str] = &["ai-field", "rewrite"];
/// The host's instructions for a `rewrite`, put before the kit's own messages. The kit's messages
/// name the change the person asked for (improve, shorten, expand, change the tone, fix the
/// spelling, translate) and carry the selected text; the kit shows the answer as a suggestion
/// and writes it only when the person accepts it, so the answer must be the replacement text
/// alone.
const REWRITE_INSTRUCTIONS: &str = "You rewrite text a person selected in a document, as they ask: \
improve, shorten, expand, change the tone, fix the spelling, or translate it. Keep the meaning, \
the language (unless asked to translate), and the formatting (paragraphs, lists, inline marks) \
unless asked to change them. Answer with the rewritten text only: no preamble, no quotes, no \
explanation, and nothing before or after it.";
/// At most this many bytes of prompt text and images, together.
const MAX_REQUEST_BYTES: usize = 24 << 20;
/// At most this many images in one request.
const MAX_IMAGES: usize = 8;

#[derive(Clone)]
pub struct GenerateState {
    pub auth: AuthConfig,
    pub engine: Engine,
    pub ai_gate: AiGate,
}

impl axum::extract::FromRef<GenerateState> for AuthConfig {
    fn from_ref(state: &GenerateState) -> Self {
        state.auth.clone()
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GenerateRequest {
    pub purpose: String,
    /// `text` or `image`.
    pub output: String,
    /// The model the person's settings choose for this output.
    pub runtime_model: Option<RuntimeModel>,
    pub messages: Vec<GenerateMessage>,
    pub options: GenerateOptions,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct GenerateMessage {
    /// `system` or `user`.
    pub role: String,
    pub parts: Vec<GeneratePart>,
}

/// A text part, or an image as base64 bytes (`data`, with `mime`) or as an `http(s):` URL.
#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct GeneratePart {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
    pub mime: String,
    pub data: String,
    pub url: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GenerateOptions {
    pub max_tokens: Option<i64>,
    pub temperature: Option<f64>,
    /// `WIDTHxHEIGHT`, for images.
    pub size: Option<String>,
}

#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GenerateAnswer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<GeneratedImageAnswer>,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct GeneratedImageAnswer {
    pub mime: String,
    /// The image's bytes, base64.
    pub data: String,
}

pub fn router(state: GenerateState) -> Router {
    Router::new()
        .route("/ai/generate", post(generate))
        .with_state(state)
}

/// A refusal of `host/generate`, with its protocol reason.
fn refused(status: u16, reason: &str, message: impl Into<String>) -> AppError {
    AppError::new(status, i64::from(status) * 100, message).with_data(json!({ "reason": reason }))
}

fn from_ai(error: &AiError) -> AppError {
    match error {
        AiError::NotLoggedIn => refused(401, "unavailable", error.to_string()),
        AiError::CreditsExhausted { .. } => refused(402, "quota", error.to_string()),
        AiError::Wrapped { source, .. } => from_ai(source),
        _ => refused(502, "failed", error.to_string()),
    }
}

/// The prompt as the engine takes it: `system` and `user` messages, images as data or `http(s):`
/// URLs; and every image's URL, for an image request's references.
pub fn engine_messages(request: &GenerateRequest) -> AppResult<(Vec<Message>, Vec<String>)> {
    let mut size = 0usize;
    let mut images = Vec::new();
    let mut messages = Vec::new();
    for message in &request.messages {
        let role = match message.role.as_str() {
            "system" | "user" => message.role.as_str(),
            other => return Err(refused(400, "failed", format!("unknown role `{other}`"))),
        };
        let mut text = String::new();
        let mut parts = Vec::new();
        for part in &message.parts {
            match part.kind.as_str() {
                "text" => {
                    size += part.text.len();
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(&part.text);
                    parts.push(MessagePart {
                        kind: "text".into(),
                        text: part.text.clone(),
                        ..MessagePart::default()
                    });
                }
                "image" => {
                    let url = if !part.data.is_empty() {
                        size += part.data.len();
                        base64::engine::general_purpose::STANDARD
                            .decode(&part.data)
                            .map_err(|_| refused(400, "failed", "an image is not base64"))?;
                        let mime = if part.mime.starts_with("image/") {
                            part.mime.as_str()
                        } else {
                            "image/png"
                        };
                        format!("data:{mime};base64,{}", part.data)
                    } else if part.url.starts_with("https://") || part.url.starts_with("http://") {
                        part.url.clone()
                    } else {
                        return Err(refused(
                            400,
                            "failed",
                            "an image needs bytes or an http(s) URL",
                        ));
                    };
                    images.push(url.clone());
                    parts.push(MessagePart {
                        kind: "image_url".into(),
                        image_url: url,
                        ..MessagePart::default()
                    });
                }
                other => return Err(refused(400, "failed", format!("unknown part `{other}`"))),
            }
        }
        if size > MAX_REQUEST_BYTES || images.len() > MAX_IMAGES {
            return Err(refused(413, "too-large", "the request is too large"));
        }
        let mut built = Message::new(role, text);
        if parts.iter().any(|part| part.kind == "image_url") {
            built.parts = parts;
        }
        messages.push(built);
    }
    if messages.is_empty() {
        return Err(refused(400, "failed", "the request has no messages"));
    }
    if request.purpose == "rewrite" && request.output == "text" {
        messages.insert(0, Message::new("system", REWRITE_INSTRUCTIONS));
    }
    Ok((messages, images))
}

fn image_size(options: &GenerateOptions) -> (i64, i64) {
    options
        .size
        .as_deref()
        .and_then(|size| size.split_once('x'))
        .and_then(|(width, height)| Some((width.trim().parse().ok()?, height.trim().parse().ok()?)))
        .filter(|(width, height): &(i64, i64)| *width > 0 && *height > 0)
        .unwrap_or((1024, 1024))
}

async fn generate(
    State(state): State<GenerateState>,
    user: CurrentUser,
    JsonBody(request): JsonBody<GenerateRequest>,
) -> AppResult<Response> {
    require_ai(&state.ai_gate)?;
    if !PURPOSES.contains(&request.purpose.as_str()) {
        return Err(refused(
            400,
            "not-allowed",
            format!(
                "`{}` is not a purpose this host generates for",
                request.purpose
            ),
        ));
    }
    let model = request
        .runtime_model
        .clone()
        .filter(|model| !model.model_name.trim().is_empty())
        .ok_or_else(|| refused(400, "unavailable", "Configure a model in Settings first"))?;
    let (messages, images) = engine_messages(&request)?;
    let started = Instant::now();
    let prompt: String = messages
        .iter()
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let (answer, usage, failure) = match request.output.as_str() {
        "image" => {
            let (width, height) = image_size(&request.options);
            let image_request = ImageRequest {
                prompt: prompt.clone(),
                references: images,
                count: 1,
                width,
                height,
                quality: String::new(),
            };
            match state
                .engine
                .generate_images(&image_request, Some(&model))
                .await
            {
                Ok(generated) => match generated.into_iter().next() {
                    Some(image) => {
                        let mime = if image.mime_type.is_empty() {
                            "image/png".to_owned()
                        } else {
                            image.mime_type
                        };
                        let answer = GenerateAnswer {
                            image: Some(GeneratedImageAnswer {
                                mime,
                                data: base64::engine::general_purpose::STANDARD.encode(&image.data),
                            }),
                            model: model.model_name.clone(),
                            ..GenerateAnswer::default()
                        };
                        (Some(answer), crate::engine::Usage::default(), None)
                    }
                    None => (
                        None,
                        crate::engine::Usage::default(),
                        Some(refused(502, "failed", "the model answered no image")),
                    ),
                },
                Err(error) => (None, crate::engine::Usage::default(), Some(from_ai(&error))),
            }
        }
        "text" => match state
            .engine
            .chat_with_tools(&messages, &[], "", &model, None)
            .await
        {
            Ok(result) => {
                let usage = result.usage;
                let answer = GenerateAnswer {
                    text: Some(result.content.trim().to_owned()),
                    model: if result.model.is_empty() {
                        model.model_name.clone()
                    } else {
                        result.model.clone()
                    },
                    usage: Some(
                        json!({ "inputTokens": usage.prompt_tokens, "outputTokens": usage.completion_tokens }),
                    ),
                    ..GenerateAnswer::default()
                };
                (Some(answer), usage, None)
            }
            Err(error) => (None, crate::engine::Usage::default(), Some(from_ai(&error))),
        },
        other => return Err(refused(400, "failed", format!("unknown output `{other}`"))),
    };
    let mut usage = usage;
    usage.response_time_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
    let entry = crate::usage::NewUsage {
        user_id: user.user.id,
        provider: model.provider_type.clone(),
        model_name: model.model_name.clone(),
        tool: "kit_generate".into(),
        request_type: format!("{}:{}", request.purpose, request.output),
        input_content: prompt,
        output_content: answer
            .as_ref()
            .and_then(|answer| answer.text.clone())
            .unwrap_or_else(|| {
                if answer.as_ref().is_some_and(|answer| answer.image.is_some()) {
                    "1 image".into()
                } else {
                    String::new()
                }
            }),
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        status: if failure.is_none() {
            "success".into()
        } else {
            "failed".into()
        },
        error_message: failure
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default(),
        response_time_ms: usage.response_time_ms,
        extra_data: json!({ "purpose": request.purpose }),
    };
    if let Ok(conn) = state.auth.db.conn() {
        let _ = crate::usage::record(&conn, &entry);
    }
    match (answer, failure) {
        (_, Some(failure)) => Err(failure),
        (Some(answer), None) => Ok(ok(answer)),
        (None, None) => Err(refused(502, "failed", "the model answered nothing")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(value: Value) -> GenerateRequest {
        serde_json::from_value(value).unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn builds_system_and_user_messages_with_images() {
        let built = request(json!({
            "purpose": "ai-field", "output": "text",
            "messages": [
                { "role": "system", "parts": [{ "type": "text", "text": "Be brief." }] },
                { "role": "user", "parts": [
                    { "type": "text", "text": "Describe" },
                    { "type": "image", "mime": "image/png", "data": "iVBORw0K" },
                    { "type": "image", "url": "https://example.com/a.jpg" }
                ] }
            ]
        }));
        let (messages, images) = engine_messages(&built).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "system");
        assert!(messages[0].parts.is_empty());
        assert_eq!(messages[1].content, "Describe");
        assert_eq!(messages[1].parts.len(), 3);
        assert_eq!(
            images,
            vec![
                "data:image/png;base64,iVBORw0K".to_owned(),
                "https://example.com/a.jpg".to_owned()
            ]
        );
    }

    #[test]
    fn refuses_other_roles_local_urls_and_empty_requests() {
        for value in [
            json!({ "messages": [{ "role": "assistant", "parts": [] }] }),
            json!({ "messages": [{ "role": "user", "parts": [{ "type": "image", "url": "file:///etc/passwd" }] }] }),
            json!({ "messages": [] }),
        ] {
            assert!(engine_messages(&request(value)).is_err());
        }
    }

    #[test]
    fn serves_the_defined_purposes_only() {
        assert!(PURPOSES.contains(&"ai-field"));
        assert!(PURPOSES.contains(&"rewrite"));
        assert!(!PURPOSES.contains(&"note.outline"));
    }

    #[test]
    fn a_rewrite_starts_with_the_host_instructions() {
        let built = request(json!({
            "purpose": "rewrite", "output": "text",
            "messages": [
                { "role": "user", "parts": [{ "type": "text", "text": "Shorten:\nThe quick brown fox jumps over the lazy dog." }] }
            ]
        }));
        let (messages, _) = engine_messages(&built).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "system");
        assert!(messages[0].content.contains("rewritten text only"));
        assert_eq!(messages[1].role, "user");
        assert!(messages[1].content.starts_with("Shorten:"));

        let field = request(json!({
            "purpose": "ai-field", "output": "text",
            "messages": [{ "role": "user", "parts": [{ "type": "text", "text": "Summarize" }] }]
        }));
        let (messages, _) = engine_messages(&field).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn reads_the_image_size() {
        assert_eq!(
            image_size(&GenerateOptions {
                size: Some("512x768".into()),
                ..GenerateOptions::default()
            }),
            (512, 768)
        );
        assert_eq!(image_size(&GenerateOptions::default()), (1024, 1024));
        assert_eq!(
            image_size(&GenerateOptions {
                size: Some("0x5".into()),
                ..GenerateOptions::default()
            }),
            (1024, 1024)
        );
    }

    #[test]
    fn credits_exhausted_is_quota() {
        let error = AiError::CreditsExhausted {
            message: "none".into(),
            code: String::new(),
            topup_url: String::new(),
        };
        let refusal = from_ai(&error);
        assert_eq!(refusal.data["reason"], "quota");
    }
}
