//! The model seam: one streamed call. The harness is model-agnostic; any
//! provider the engine can reach works. `EngineLlm` adapts Kition's AI engine,
//! which speaks the OpenAI Responses and Anthropic Messages wires (DeepSeek
//! through its Anthropic-compatible Messages API).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use futures::future::BoxFuture;
use kition_ai::engine::{
    Engine, Message, RetryEvent, RetryHandler, RuntimeModel, StreamEvent, StreamHandler, ToolCall,
    ToolSpec,
};
use kition_core::now_millis;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::events::{ContentBlock, LoggedCall, PresentedFile};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LlmRequest {
    pub messages: Vec<Message>,
    pub tools: Vec<ToolSpec>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LlmReply {
    pub content: String,
    pub tool_calls: Vec<LoggedCall>,
    pub stop_reason: String,
    /// The provider route that answered.
    pub provider: String,
    pub model: String,
    pub raw_items: Vec<Value>,
    /// Model input produced by the provider call itself (hosted image
    /// results), logged as a `user/message` after the step's tool results.
    pub follow_up: Vec<ContentBlock>,
    /// Calls the provider ran itself during this call (hosted web search,
    /// hosted image generation), logged after the `assistant/message`.
    pub hosted: Vec<HostedCall>,
    /// What the call used, as the provider reported it.
    pub usage: Option<TokenUsage>,
}

/// Token counts of one model call, logged with its `assistant/message`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cache_read_input_tokens: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cache_creation_input_tokens: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

impl TokenUsage {
    /// The engine's counts for one call.
    pub fn from_engine(usage: &kition_ai::engine::Usage) -> Self {
        Self {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
        }
    }
}

/// A call the provider ran itself. It is logged as a `tool/call` and a
/// successful `tool/result`, plus `deliverables/presented` for its files;
/// the model never asked for it through a tool call, so it is not model
/// history.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HostedCall {
    pub call_id: String,
    pub name: String,
    pub arguments: Value,
    pub value: Value,
    pub meta: Option<Value>,
    pub files: Vec<PresentedFile>,
}

impl LlmReply {
    pub fn text(content: &str) -> Self {
        Self {
            content: content.to_owned(),
            stop_reason: "stop".into(),
            ..Self::default()
        }
    }

    pub fn calls(calls: Vec<LoggedCall>) -> Self {
        Self {
            tool_calls: calls,
            stop_reason: "tool_use".into(),
            ..Self::default()
        }
    }
}

/// A piece of a streaming model reply (dsh `StreamChunk`, the kinds Kition
/// streams). Text uses block index 0, tool call `i` uses `1 + i`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum StreamChunk {
    TextDelta {
        index: u32,
        text: String,
    },
    ToolCallDelta {
        index: u32,
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        arguments_delta: String,
    },
}

/// A failed provider request that will be retried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryInfo {
    /// The retry number, from 1.
    pub retry: u32,
    pub max_retries: u32,
    pub delay_ms: u64,
    pub code: String,
    pub message: String,
    pub provider: String,
}

/// Where a model call reports progress while it runs: streamed chunks, a
/// retry being scheduled, and a retry's wait being over (with its number).
#[derive(Clone)]
pub struct LlmSink {
    pub chunk: Arc<dyn Fn(StreamChunk) + Send + Sync>,
    pub retry: Arc<dyn Fn(RetryInfo) + Send + Sync>,
    pub retry_started: Arc<dyn Fn(u32) + Send + Sync>,
}

impl LlmSink {
    /// A sink that drops everything.
    pub fn discard() -> Self {
        Self {
            chunk: Arc::new(|_| {}),
            retry: Arc::new(|_| {}),
            retry_started: Arc::new(|_| {}),
        }
    }

    /// The engine stream handler that forwards text and tool argument
    /// deltas as chunks.
    pub fn stream_handler(&self) -> StreamHandler {
        let chunk = self.chunk.clone();
        Arc::new(move |event: StreamEvent| {
            if let Some(piece) = stream_chunk(&event) {
                chunk(piece);
            }
        })
    }

    /// The engine retry handler that forwards scheduled and started retries
    /// of `provider`.
    pub fn retry_handler(&self, provider: &str) -> RetryHandler {
        let (retry, started) = (self.retry.clone(), self.retry_started.clone());
        let provider = provider.to_owned();
        Arc::new(move |event: RetryEvent| {
            if event.started {
                started(event.attempt);
            } else {
                retry(RetryInfo {
                    retry: event.attempt,
                    max_retries: event.max_retries,
                    delay_ms: u64::try_from(event.delay.as_millis()).unwrap_or(u64::MAX),
                    code: event.reason,
                    message: event.message,
                    provider: provider.clone(),
                });
            }
        })
    }
}

impl std::fmt::Debug for LlmSink {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("LlmSink").finish_non_exhaustive()
    }
}

/// An engine stream event as a chunk: text at block 0, tool call `i` at
/// `1 + i`. Other events (a finished tool call) are not chunks.
pub fn stream_chunk(event: &StreamEvent) -> Option<StreamChunk> {
    match event.kind {
        "delta" if !event.delta.is_empty() => Some(StreamChunk::TextDelta {
            index: 0,
            text: event.delta.clone(),
        }),
        "tool_call_delta" => Some(StreamChunk::ToolCallDelta {
            index: u32::try_from(event.tool_call_index.max(0))
                .unwrap_or(u32::MAX - 1)
                .saturating_add(1),
            id: event.tool_call_id.clone(),
            name: Some(event.tool_name.clone()).filter(|name| !name.is_empty()),
            arguments_delta: event.tool_arguments_delta.clone(),
        }),
        _ => None,
    }
}

pub trait Llm: Send + Sync {
    fn call(&self, request: LlmRequest, sink: LlmSink) -> BoxFuture<'_, Result<LlmReply, String>>;

    /// Whether this model's history must stay append-only: every request
    /// carries the whole log, derived so that nothing an earlier request
    /// sent changes (see [`crate::derive::derive_append_only`]). Its
    /// provider keeps the context in bounds (server-side compaction).
    fn append_only(&self) -> bool {
        false
    }
}

/// Fills blank call ids from `prefix` plus the call's index, trims names, and
/// keeps arguments the model sent as malformed JSON visible as `{"raw": ...}`
/// instead of silently discarding them (matches the loop in
/// `kition-agent/src/tools/mod.rs::execute`, so the model's original text is
/// preserved in the log). `ToolDef::run` refuses that shape before schema
/// validation and tells the model its JSON did not parse, unless the tool
/// itself declares a `raw` parameter.
pub fn normalize_calls(calls: &[ToolCall], prefix: &str) -> Vec<LoggedCall> {
    calls
        .iter()
        .enumerate()
        .map(|(index, call)| {
            let id = call.id.trim();
            let arguments = if call.input.trim().is_empty() {
                json!({})
            } else {
                match serde_json::from_str::<Value>(&call.input) {
                    Ok(value @ Value::Object(_)) => value,
                    _ => json!({ "raw": call.input }),
                }
            };
            LoggedCall {
                call_id: if id.is_empty() {
                    format!("{prefix}_{index}")
                } else {
                    id.to_owned()
                },
                name: call.name.trim().to_owned(),
                arguments,
            }
        })
        .collect()
}

/// Kition's AI engine with one resolved model.
pub struct EngineLlm {
    engine: Engine,
    model: RuntimeModel,
    seq: AtomicU64,
}

impl std::fmt::Debug for EngineLlm {
    /// Shows only the model name: `RuntimeModel` also carries the API key
    /// and access token.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EngineLlm")
            .field("model", &self.model.model_name)
            .finish_non_exhaustive()
    }
}

impl EngineLlm {
    pub fn new(engine: Engine, model: RuntimeModel) -> Self {
        Self {
            engine,
            model,
            seq: AtomicU64::new(0),
        }
    }
}

impl Llm for EngineLlm {
    fn call(&self, request: LlmRequest, sink: LlmSink) -> BoxFuture<'_, Result<LlmReply, String>> {
        Box::pin(async move {
            let result = self
                .engine
                .chat_with_retry(
                    &request.messages,
                    &request.tools,
                    "",
                    &self.model,
                    Some(sink.stream_handler()),
                    Some(sink.retry_handler(&self.model.provider_type)),
                )
                .await
                .map_err(|error| error.to_string())?;
            let seq = self.seq.fetch_add(1, Ordering::SeqCst);
            let prefix = format!("call_{}_{seq}", now_millis());
            let tool_calls = normalize_calls(&result.tool_calls, &prefix);
            Ok(LlmReply {
                content: result.content.trim().to_owned(),
                tool_calls,
                stop_reason: result.stop_reason,
                provider: self.model.provider_type.clone(),
                model: result.model,
                raw_items: result.response_items,
                follow_up: Vec::new(),
                hosted: Vec::new(),
                usage: Some(TokenUsage::from_engine(&result.usage)),
            })
        })
    }

    fn append_only(&self) -> bool {
        kition_ai::engine::appends_only(&self.model)
    }
}

#[cfg(test)]
mod tests {
    use kition_ai::engine::ToolCall;
    use serde_json::json;

    use super::*;

    fn call(id: &str, name: &str, input: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            input: input.into(),
        }
    }

    #[test]
    fn normalize_calls_fills_blank_ids_trims_names_and_keeps_malformed_arguments_as_raw() {
        let calls = vec![
            call("", "  echo  ", ""),
            call(" c1 ", "echo", "{\"a\":1}"),
            call("", "echo", "{\"a\":"),
            call("", "echo", "[1]"),
        ];
        let normalized = normalize_calls(&calls, "call_1_0");
        assert_eq!(normalized[0].call_id, "call_1_0_0");
        assert_eq!(normalized[0].name, "echo");
        assert_eq!(normalized[0].arguments, json!({}));
        assert_eq!(normalized[1].call_id, "c1");
        assert_eq!(normalized[1].arguments, json!({ "a": 1 }));
        assert_eq!(normalized[2].call_id, "call_1_0_2");
        assert_eq!(normalized[2].arguments, json!({ "raw": "{\"a\":" }));
        assert_eq!(normalized[3].call_id, "call_1_0_3");
        assert_eq!(normalized[3].arguments, json!({ "raw": "[1]" }));
    }

    #[test]
    fn engine_events_become_dsh_chunks() {
        let text = StreamEvent {
            kind: "delta",
            delta: "Hi".into(),
            ..StreamEvent::default()
        };
        assert_eq!(
            serde_json::to_value(stream_chunk(&text)).unwrap_or_default(),
            json!({ "type": "text-delta", "index": 0, "text": "Hi" })
        );
        let tool = StreamEvent {
            kind: "tool_call_delta",
            tool_call_index: 1,
            tool_call_id: "c2".into(),
            tool_name: "document_write".into(),
            tool_arguments_delta: "{\"pa".into(),
            ..StreamEvent::default()
        };
        assert_eq!(
            serde_json::to_value(stream_chunk(&tool)).unwrap_or_default(),
            json!({ "type": "tool-call-delta", "index": 2, "id": "c2", "name": "document_write", "argumentsDelta": "{\"pa" })
        );
        let unnamed = StreamEvent {
            tool_name: String::new(),
            ..tool
        };
        assert_eq!(
            serde_json::to_value(stream_chunk(&unnamed)).unwrap_or_default()["name"],
            Value::Null
        );
        let ready = StreamEvent {
            kind: "tool_call_ready",
            ..StreamEvent::default()
        };
        assert_eq!(stream_chunk(&ready), None);
        assert_eq!(
            stream_chunk(&StreamEvent {
                kind: "delta",
                ..StreamEvent::default()
            }),
            None
        );
    }

    #[test]
    fn engine_retries_reach_the_sink() {
        use std::sync::Mutex;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (scheduled, started) = (seen.clone(), seen.clone());
        let sink = LlmSink {
            retry: Arc::new(move |info: RetryInfo| {
                scheduled
                    .lock()
                    .map(|mut seen| {
                        seen.push(format!("{} {} {}", info.retry, info.code, info.provider))
                    })
                    .ok();
            }),
            retry_started: Arc::new(move |retry| {
                started
                    .lock()
                    .map(|mut seen| seen.push(format!("started {retry}")))
                    .ok();
            }),
            ..LlmSink::discard()
        };
        let handler = sink.retry_handler("openai");
        let event = RetryEvent {
            attempt: 1,
            max_retries: 5,
            delay: std::time::Duration::from_millis(250),
            reason: "timeout".into(),
            message: "timed out".into(),
            started: false,
        };
        handler(event.clone());
        handler(RetryEvent {
            started: true,
            ..event
        });
        assert_eq!(
            *seen
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            ["1 timeout openai", "started 1"]
        );
    }

    #[test]
    fn engine_llm_debug_shows_only_the_model_name() {
        let llm = EngineLlm::new(
            Engine::new(std::path::PathBuf::from("."), None),
            RuntimeModel {
                model_name: "gpt-5".into(),
                api_key: "secret".into(),
                ..RuntimeModel::default()
            },
        );
        let debug = format!("{llm:?}");
        assert!(debug.contains("gpt-5"), "{debug}");
        assert!(!debug.contains("secret"), "{debug}");
    }
}
