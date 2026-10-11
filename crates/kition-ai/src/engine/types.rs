//! The shapes exchanged with model providers: conversation messages, tool
//! specs and calls, stream events, and hosted-tool results.

use std::sync::Arc;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use super::KITION_CLOUD_PROVIDER;

/// One conversation turn. Provider-native items in `raw_items` replay
/// verbatim on the Responses wire.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Message {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<MessagePart>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tool_call_id: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub raw_items: Vec<Value>,
}

impl Message {
    pub fn new(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.to_owned(),
            content: content.into(),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MessagePart {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub image_url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

/// The provider settings the client sends with each AI request.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimeModel {
    pub provider_type: String,
    pub provider_label: String,
    pub model_name: String,
    pub base_url: String,
    pub api_key: String,
    pub access_token: String,
    pub auth_header: String,
    pub auth_scheme: String,
    pub wire_api: String,
    pub reasoning_effort: String,
    pub disable_response_storage: Option<bool>,
    pub hosted_web_search_version: String,
    pub anthropic_version_header: String,
    pub max_output_tokens: i64,
}

impl RuntimeModel {
    /// Responses storage is off unless the client asks for it.
    pub fn disable_storage(&self) -> bool {
        self.disable_response_storage.unwrap_or(true)
    }

    /// Whether the provider runs web search itself: OpenAI-style providers
    /// (or GPT models) on the Responses wire, Anthropic (or Claude models)
    /// on the Messages wire.
    pub fn supports_hosted_web_search(&self) -> bool {
        let provider = self.provider_type.trim().to_lowercase();
        let name = self.model_name.to_lowercase();
        match self.wire_api.trim() {
            "responses" => {
                matches!(
                    provider.as_str(),
                    "openai" | "openai-oauth2" | "custom" | KITION_CLOUD_PROVIDER
                ) || name.contains("gpt")
            }
            "anthropic_messages" => {
                matches!(provider.as_str(), "anthropic" | "custom") || name.contains("claude")
            }
            _ => false,
        }
    }

    /// Whether the provider generates images itself: OpenAI-style providers
    /// (or GPT models) on the Responses wire.
    pub fn supports_hosted_images(&self) -> bool {
        let provider = self.provider_type.trim().to_lowercase();
        self.wire_api.trim() == "responses"
            && (matches!(
                provider.as_str(),
                "openai" | "openai-oauth2" | "custom" | KITION_CLOUD_PROVIDER
            ) || self.model_name.to_lowercase().contains("gpt"))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ToolSpec {
    pub name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

/// A function call the model asked for. `input` is the raw JSON argument
/// text exactly as the provider sent it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: String,
}

impl ToolCall {
    /// The arguments as JSON, or an empty object when they do not parse.
    pub fn input_value(&self) -> Value {
        serde_json::from_str(&self.input).unwrap_or_else(|_| Value::Object(Default::default()))
    }
}

/// Raw JSON text written back as JSON, like an embedded raw message.
pub(crate) fn raw_json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_owned()))
}

impl Serialize for ToolCall {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.id)?;
        map.serialize_entry("name", &self.name)?;
        if !self.input.is_empty() {
            map.serialize_entry("input", &raw_json(&self.input))?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for ToolCall {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct Raw {
            id: String,
            name: String,
            input: Option<Value>,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(Self {
            id: raw.id,
            name: raw.name,
            input: match raw.input {
                None | Some(Value::Null) => String::new(),
                Some(value) => value.to_string(),
            },
        })
    }
}

/// Incremental output while a model call streams.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StreamEvent {
    /// `delta`, `tool_call_delta`, or `tool_call_ready`.
    pub kind: &'static str,
    pub delta: String,
    pub tool_call_index: i64,
    pub tool_call_id: String,
    pub tool_name: String,
    pub tool_arguments_delta: String,
    pub tool_arguments: String,
}

pub type StreamHandler = Arc<dyn Fn(StreamEvent) + Send + Sync>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HostedWebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HostedWebSearchCall {
    pub id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<serde_json::Map<String, Value>>,
}

/// A hosted `image_generation` result; `result` is base64 PNG data.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HostedImageGenerationCall {
    pub id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub result: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub size: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub revised_prompt: String,
}

/// The outcome of one model call.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatResult {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub hosted_web_search_calls: Vec<HostedWebSearchCall>,
    /// Only the Anthropic wire reports result entries directly.
    pub hosted_web_search_results: Vec<HostedWebSearchResult>,
    pub hosted_image_generation_calls: Vec<HostedImageGenerationCall>,
    /// Provider-native output items, replayed on the next turn.
    pub response_items: Vec<Value>,
    pub stop_reason: String,
    pub model: String,
    pub usage: Usage,
    pub wire_api: String,
}

/// Token counts; estimated when the provider reports none.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cache_creation_input_tokens: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cache_read_input_tokens: i64,
    pub response_time_ms: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

/// A generated image, already written under `uploads/generated/images`
/// when an upload directory is configured.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GeneratedImage {
    pub url: String,
    pub data: Vec<u8>,
    pub mime_type: String,
    pub extension: String,
    pub width: i64,
    pub height: i64,
}

/// The hosted Kition Cloud model endpoint for the signed-in account.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConsoleRuntime {
    pub base_url: String,
    pub access_token: String,
    pub user_email: String,
    pub topup_url: String,
    pub default_text_model: String,
    pub default_image_model: String,
    pub supports_images: bool,
    pub supports_responses: bool,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn tool_calls_keep_raw_arguments() {
        let call: ToolCall =
            serde_json::from_value(json!({ "id": "c1", "name": "n", "input": { "a": 1 } }))
                .unwrap_or_default();
        assert_eq!(call.input, r#"{"a":1}"#);
        assert_eq!(
            serde_json::to_value(&call).unwrap_or_default(),
            json!({ "id": "c1", "name": "n", "input": { "a": 1 } })
        );
        let empty = ToolCall {
            id: "c".into(),
            name: "n".into(),
            input: String::new(),
        };
        assert_eq!(empty.input_value(), json!({}));
    }

    #[test]
    fn hosted_tool_support_follows_the_wire_and_provider() {
        let model = |provider: &str, wire: &str, name: &str| RuntimeModel {
            provider_type: provider.into(),
            wire_api: wire.into(),
            model_name: name.into(),
            ..RuntimeModel::default()
        };
        let anthropic = model("anthropic", "anthropic_messages", "");
        assert!(anthropic.supports_hosted_web_search());
        assert!(!anthropic.supports_hosted_images());
        let claude = model("gateway", "anthropic_messages", "Claude-Sonnet");
        assert!(claude.supports_hosted_web_search());
        let openai = model(" OpenAI ", "responses", "");
        assert!(openai.supports_hosted_web_search());
        assert!(openai.supports_hosted_images());
        let cloud = model(KITION_CLOUD_PROVIDER, "responses", "");
        assert!(cloud.supports_hosted_web_search());
        assert!(cloud.supports_hosted_images());
        let gpt = model("gateway", "responses", "GPT-5");
        assert!(gpt.supports_hosted_web_search());
        assert!(gpt.supports_hosted_images());
        let other = model("gateway", "responses", "other");
        assert!(!other.supports_hosted_web_search());
        assert!(!other.supports_hosted_images());
        let chat = model("openai", "chat_completions", "gpt-5");
        assert!(!chat.supports_hosted_web_search());
        assert!(!chat.supports_hosted_images());
    }

    #[test]
    fn messages_omit_empty_fields() {
        let value = serde_json::to_value(Message::new("user", "hi")).unwrap_or_default();
        assert_eq!(value, json!({ "role": "user", "content": "hi" }));
    }
}
