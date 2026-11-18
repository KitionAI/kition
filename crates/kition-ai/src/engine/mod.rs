//! Calling model providers: chat with tools (streaming or not, with
//! retries), hosted web search, and image generation. Requests for the
//! Kition Cloud provider are routed through the signed-in account.

mod anthropic;
mod chat_completions;
pub mod error;
pub mod image_prompt;
mod images;
mod responses;
mod retry;
pub mod transport;
pub mod types;

use std::path::PathBuf;
use std::sync::Arc;

use kition_core::cloud::{CloudSessionProvider, NOT_LOGGED_IN};
use serde_json::{Value, json};
use tokio::sync::Semaphore;

pub use anthropic::appends_only;
pub use error::{AiError, AiResult};
pub use images::{IMAGE_MODEL, ImageRequest, normalize_quality, normalize_size};
pub use retry::{DEFAULT_MAX_RETRIES, RetryEvent, RetryHandler};
pub use transport::sniff_mime;
pub use types::*;

/// The provider type that routes through Kition Cloud.
pub const KITION_CLOUD_PROVIDER: &str = "kition_console";
const CLOUD_LLM_PATH: &str = "/api/llm/v1";
const CLOUD_TOPUP_PATH: &str = "/app/billing";
const CLOUD_TEXT_MODEL: &str = "gpt-5.6-sol";

/// Resolves the Kition Cloud endpoint for the signed-in account.
pub type CloudResolver = Arc<dyn Fn() -> AiResult<ConsoleRuntime> + Send + Sync>;

/// Kition Cloud's hosted models, reached through the portal session.
pub fn cloud_resolver(session: CloudSessionProvider) -> CloudResolver {
    Arc::new(move || {
        let session = session().map_err(|message| {
            if message == NOT_LOGGED_IN {
                AiError::NotLoggedIn
            } else {
                AiError::Message(message)
            }
        })?;
        let token = session.access_token.trim().to_owned();
        let base = session.base_url.trim().trim_end_matches('/').to_owned();
        if token.is_empty() {
            return Err(AiError::NotLoggedIn);
        }
        if base.is_empty() {
            return Err(AiError::msg("kition console base URL is not configured"));
        }
        Ok(ConsoleRuntime {
            base_url: format!("{base}{CLOUD_LLM_PATH}"),
            access_token: token,
            topup_url: format!("{base}{CLOUD_TOPUP_PATH}"),
            default_text_model: CLOUD_TEXT_MODEL.into(),
            default_image_model: IMAGE_MODEL.into(),
            supports_images: true,
            supports_responses: true,
            ..ConsoleRuntime::default()
        })
    })
}

#[derive(Clone)]
pub struct Engine {
    http: reqwest::Client,
    cloud: Option<CloudResolver>,
    images: images::Images,
}

fn is_video_scene(scene: &str) -> bool {
    scene.trim().to_lowercase().contains("video")
}

impl Engine {
    pub fn new(upload_dir: PathBuf, cloud: Option<CloudResolver>) -> Self {
        let http = reqwest::Client::builder().build().unwrap_or_default();
        Self {
            images: images::Images {
                http: http.clone(),
                upload_dir,
                slots: Arc::new(Semaphore::new(images::MAX_CONCURRENT_IMAGE_REQUESTS)),
            },
            http,
            cloud,
        }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// The request to send upstream. Kition Cloud requests get the live
    /// account endpoint and token; others pass through unchanged.
    pub fn resolve(&self, model: &RuntimeModel, scene: &str) -> AiResult<RuntimeModel> {
        if !model
            .provider_type
            .trim()
            .eq_ignore_ascii_case(KITION_CLOUD_PROVIDER)
        {
            return Ok(model.clone());
        }
        if is_video_scene(scene) {
            return Err(AiError::VideoNotSupported);
        }
        let cloud = self.cloud.as_ref().ok_or(AiError::NotLoggedIn)?()?;
        if cloud.base_url.trim().is_empty() || cloud.access_token.trim().is_empty() {
            return Err(AiError::NotLoggedIn);
        }
        let mut out = model.clone();
        out.base_url = cloud.base_url.trim_end_matches('/').to_owned();
        out.access_token = cloud.access_token.clone();
        if out.api_key.trim().is_empty() {
            out.api_key = cloud.access_token;
        }
        if out.auth_header.trim().is_empty() {
            out.auth_header = "Authorization".into();
        }
        if out.auth_scheme.trim().is_empty() {
            out.auth_scheme = "bearer".into();
        }
        if out.wire_api.trim().is_empty() {
            out.wire_api = "responses".into();
        }
        if scene.trim().eq_ignore_ascii_case("image") {
            // Images use the provider's image model, not the chat model.
            out.model_name = if cloud.default_image_model.trim().is_empty() {
                IMAGE_MODEL.into()
            } else {
                cloud.default_image_model.trim().to_owned()
            };
        } else if out.model_name.trim().is_empty() && !cloud.default_text_model.trim().is_empty() {
            out.model_name = cloud.default_text_model.trim().to_owned();
        }
        Ok(out)
    }

    async fn dispatch(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
        choice: &str,
        model: &RuntimeModel,
        stream: Option<&StreamHandler>,
    ) -> AiResult<ChatResult> {
        match model.wire_api.trim() {
            "responses" => {
                responses::call(&self.http, messages, tools, choice, model, stream).await
            }
            "anthropic_messages" => {
                anthropic::call(&self.http, messages, tools, choice, model, stream).await
            }
            "chat_completions" => {
                chat_completions::call(&self.http, messages, tools, choice, model, stream).await
            }
            other => Err(AiError::msg(format!(
                "current provider wire_api={other} is not supported; switch to responses, chat_completions, or anthropic_messages"
            ))),
        }
    }

    /// One model call with optional tools. `choice` forces a tool by name.
    pub async fn chat_with_tools(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
        choice: &str,
        model: &RuntimeModel,
        stream: Option<StreamHandler>,
    ) -> AiResult<ChatResult> {
        let model = self.resolve(model, "")?;
        self.dispatch(messages, tools, choice, &model, stream.as_ref())
            .await
    }

    /// Like [`Self::chat_with_tools`], retrying transient failures that
    /// happened before any output streamed.
    pub async fn chat_with_retry(
        &self,
        messages: &[Message],
        tools: &[ToolSpec],
        choice: &str,
        model: &RuntimeModel,
        stream: Option<StreamHandler>,
        on_retry: Option<RetryHandler>,
    ) -> AiResult<ChatResult> {
        let model = self.resolve(model, "")?;
        let config = retry::RetryConfig {
            max_retries: DEFAULT_MAX_RETRIES,
            initial_delay: retry::INITIAL_DELAY,
            max_delay: retry::MAX_DELAY,
            on_retry,
        };
        retry::with_retry(stream, config, |attempt| {
            let model = model.clone();
            async move {
                self.dispatch(messages, tools, choice, &model, attempt.as_ref())
                    .await
            }
        })
        .await
    }

    /// Plain chat, returning the `/ai/chat` response body.
    pub async fn chat(
        &self,
        messages: &[Message],
        scene: &str,
        model: &RuntimeModel,
    ) -> AiResult<Value> {
        let model = self.resolve(model, scene)?;
        if model.model_name.trim().is_empty() || model.base_url.trim().is_empty() {
            return Err(AiError::msg("runtime provider is not configured"));
        }
        let result = self.dispatch(messages, &[], "", &model, None).await?;
        let model_name = if result.model.trim().is_empty() {
            model.model_name.trim().to_owned()
        } else {
            result.model.trim().to_owned()
        };
        Ok(json!({
            "content": result.content.trim(),
            "model": model_name,
            "usage": result.usage,
            "runtime_model": {
                "provider_type": model.provider_type,
                "provider_label": model.provider_label,
                "model_name": model.model_name,
                "base_url": model.base_url,
                "wire_api": model.wire_api.trim(),
                "reasoning_effort": model.reasoning_effort,
                "disable_response_storage": model.disable_storage(),
            },
        }))
    }

    /// Searches the web through the provider's hosted search tool.
    pub async fn hosted_web_search(
        &self,
        query: &str,
        model: &RuntimeModel,
        tool_type: &str,
    ) -> AiResult<Vec<HostedWebSearchResult>> {
        let model = self.resolve(model, "")?;
        let headers = transport::chat_headers(&model)?;
        let base_url = transport::normalize_base_url(&model.provider_type, &model.base_url);
        let model_name = model.model_name.trim();
        if base_url.is_empty() || model_name.is_empty() {
            return Err(AiError::msg(
                "runtime provider is missing base_url or model_name",
            ));
        }
        let mut tool = responses::hosted_web_search_tool();
        tool["type"] = tool_type.into();
        let mut payload = json!({
            "model": model_name,
            "input": format!(
                "Search the web for the user's query and return a concise summary with source citations.\nQuery: {query}"
            ),
            "store": false,
            "tools": [tool],
            "tool_choice": "auto",
        });
        if !model.reasoning_effort.trim().is_empty() {
            payload["reasoning"] = json!({ "effort": model.reasoning_effort.trim() });
        }
        let endpoint = transport::validate_endpoint(&format!("{base_url}/responses"))?;
        let mut request = self.http.post(&endpoint).body(payload.to_string());
        for (key, value) in &headers {
            request = request.header(key, value);
        }
        let response = transport::send(request, false).await.map_err(|failure| {
            transport::network_error("hosted web search call failed", &endpoint, &failure)
        })?;
        let status = response.status().as_u16();
        let body = transport::read_limited(response, 4 * transport::MIB)
            .await
            .map_err(|_| AiError::msg("failed to read hosted web search response"))?;
        if status >= 400 {
            return Err(AiError::msg(format!(
                "hosted web search failed: {}",
                transport::compact_error(&body)
            )));
        }
        let data: serde_json::Map<String, Value> = serde_json::from_slice(&body)
            .map_err(|_| AiError::msg("hosted web search returned a non-JSON response"))?;
        let output = data
            .get("output")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut content = data
            .get("output_text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned();
        if content.is_empty() {
            content = responses::text_from_output(&output);
        }
        let mut results = responses::web_search_results_from_output(&output, &content);
        if results.is_empty() && !content.is_empty() {
            results.push(HostedWebSearchResult {
                title: "Hosted Web Search".into(),
                url: String::new(),
                snippet: content,
            });
        }
        if results.is_empty() {
            return Err(AiError::msg("hosted web search returned no usable results"));
        }
        Ok(results)
    }

    /// Generates images, or edits `references` when any are given. Without a
    /// configured model, text-only requests get SVG placeholders.
    pub async fn generate_images(
        &self,
        request: &ImageRequest,
        model: Option<&RuntimeModel>,
    ) -> AiResult<Vec<GeneratedImage>> {
        let is_cloud = model.is_some_and(|model| {
            model
                .provider_type
                .trim()
                .eq_ignore_ascii_case(KITION_CLOUD_PROVIDER)
        });
        let resolved = model
            .map(|model| self.resolve(model, "image"))
            .transpose()?;
        if let Some(model) = resolved.filter(|model| !model.base_url.trim().is_empty()) {
            let result = if is_cloud {
                self.images.console(request, &model).await
            } else if !request.references.is_empty() {
                self.images.edit(request, &model).await
            } else {
                self.images.generate(request, &model).await
            };
            return match result {
                Ok(images) if !images.is_empty() => Ok(images),
                Ok(_) => Err(AiError::msg(
                    "image generation for this model returned no usable image",
                )),
                Err(error) => Err(error.wrap("image generation is unavailable for this model")),
            };
        }
        if !request.references.is_empty() {
            return Err(AiError::msg(
                "image editing requires a configured runtime image model",
            ));
        }
        let urls = self.images.placeholders(
            &request.prompt,
            request.count,
            request.width,
            request.height,
        )?;
        let mut images = Vec::new();
        for url in urls {
            images.push(self.images.load(&url).await?);
        }
        Ok(images)
    }

    /// Reads an image URL (data, `/uploads/...`, or HTTP) into bytes.
    pub async fn load_image(&self, url: &str) -> AiResult<GeneratedImage> {
        self.images.load(url).await
    }
}

#[cfg(test)]
mod tests {
    use kition_core::cloud::CloudSession;

    use super::*;

    fn engine(signed_in: bool) -> Engine {
        let session: CloudSessionProvider = if signed_in {
            Arc::new(|| {
                Ok(CloudSession {
                    base_url: "https://kition.ai/".into(),
                    access_token: "tok".into(),
                })
            })
        } else {
            kition_core::cloud::signed_out()
        };
        Engine::new(PathBuf::new(), Some(cloud_resolver(session)))
    }

    fn cloud_model() -> RuntimeModel {
        RuntimeModel {
            provider_type: "kition_console".into(),
            ..RuntimeModel::default()
        }
    }

    #[test]
    fn routes_cloud_requests_through_the_account() {
        let resolved = engine(true).resolve(&cloud_model(), "").unwrap_or_default();
        assert_eq!(resolved.base_url, "https://kition.ai/api/llm/v1");
        assert_eq!(resolved.api_key, "tok");
        assert_eq!(resolved.wire_api, "responses");
        assert_eq!(resolved.model_name, CLOUD_TEXT_MODEL);
        let image = engine(true)
            .resolve(&cloud_model(), "image")
            .unwrap_or_default();
        assert_eq!(image.model_name, IMAGE_MODEL);
        assert_eq!(
            engine(false).resolve(&cloud_model(), "").err(),
            Some(AiError::NotLoggedIn)
        );
        assert_eq!(
            engine(true).resolve(&cloud_model(), "video_ad").err(),
            Some(AiError::VideoNotSupported)
        );
        let byok = RuntimeModel {
            provider_type: "openai".into(),
            base_url: "https://api.openai.com".into(),
            ..RuntimeModel::default()
        };
        assert_eq!(engine(false).resolve(&byok, "").ok(), Some(byok));
    }

    #[tokio::test]
    async fn rejects_unknown_wire_apis() {
        let model = RuntimeModel {
            wire_api: "bogus".into(),
            ..RuntimeModel::default()
        };
        let error = engine(false)
            .chat_with_tools(&[], &[], "", &model, None)
            .await
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default();
        assert!(error.contains("wire_api=bogus is not supported"));
    }
}
