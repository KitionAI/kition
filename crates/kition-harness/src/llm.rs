//! The model seam: one streamed call. `EngineLlm` adapts Kition's AI engine,
//! which speaks the OpenAI-compatible wire (DeepSeek included), Responses, and
//! Anthropic.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use futures::future::BoxFuture;
use kition_ai::engine::{
    Engine, Message, RuntimeModel, StreamEvent, StreamHandler, ToolCall, ToolSpec,
};
use kition_core::now_millis;
use serde_json::{Value, json};

use crate::events::LoggedCall;

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
    pub model: String,
    pub raw_items: Vec<Value>,
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

/// Receives streamed assistant text.
pub type ChunkSink = Arc<dyn Fn(&str) + Send + Sync>;

pub trait Llm: Send + Sync {
    fn call(
        &self,
        request: LlmRequest,
        on_text: ChunkSink,
    ) -> BoxFuture<'_, Result<LlmReply, String>>;
}

/// Fills blank call ids from `prefix` plus the call's index, trims names, and
/// keeps arguments the model sent as malformed JSON visible as `{"raw": ...}`
/// instead of silently discarding them (matches the loop in
/// `kition-agent/src/tools/mod.rs::execute`, so the model's original text is
/// preserved in the log and the tool's schema validation reports it).
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
    fn call(
        &self,
        request: LlmRequest,
        on_text: ChunkSink,
    ) -> BoxFuture<'_, Result<LlmReply, String>> {
        Box::pin(async move {
            let handler: StreamHandler = Arc::new(move |event: StreamEvent| {
                if event.kind == "delta" && !event.delta.is_empty() {
                    on_text(&event.delta);
                }
            });
            let result = self
                .engine
                .chat_with_retry(
                    &request.messages,
                    &request.tools,
                    "",
                    &self.model,
                    Some(handler),
                    None,
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
                model: result.model,
                raw_items: result.response_items,
            })
        })
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
}
