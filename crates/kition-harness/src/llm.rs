//! The model seam: one streamed call. `EngineLlm` adapts Kition's AI engine,
//! which speaks the OpenAI-compatible wire (DeepSeek included), Responses, and
//! Anthropic.

use std::sync::Arc;

use futures::future::BoxFuture;
use kition_ai::engine::{Engine, Message, RuntimeModel, StreamEvent, StreamHandler, ToolSpec};
use kition_core::now_millis;
use serde_json::Value;

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

/// Kition's AI engine with one resolved model.
pub struct EngineLlm {
    pub engine: Engine,
    pub model: RuntimeModel,
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
            let stamp = now_millis();
            let tool_calls = result
                .tool_calls
                .iter()
                .enumerate()
                .map(|(index, call)| LoggedCall {
                    call_id: if call.id.trim().is_empty() {
                        format!("call_{stamp}_{index}")
                    } else {
                        call.id.trim().to_owned()
                    },
                    name: call.name.trim().to_owned(),
                    arguments: call.input_value(),
                })
                .collect();
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
