//! The model seam of a turn: each engine call with its stream frames,
//! reconnect events, timeline events, and hosted tool handling. Remembers
//! the last result for the final reply.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures::future::BoxFuture;
use kition_ai::engine::{
    ChatResult, MessagePart, RetryEvent, RetryHandler, StreamEvent, StreamHandler,
};
use kition_harness::events::ContentBlock;
use kition_harness::llm::{ChunkSink, Llm, LlmReply, LlmRequest, normalize_calls};
use serde_json::json;

use crate::run::{EventInput, Run};
use crate::stream::{Frame, value};
use crate::tools::{self, images};

/// Message parts as harness content blocks; parts with nothing to show are
/// dropped.
pub(crate) fn blocks(parts: &[MessagePart]) -> Vec<ContentBlock> {
    parts
        .iter()
        .filter_map(|part| match part.kind.as_str() {
            "image_url" if !part.image_url.is_empty() => Some(ContentBlock::Image {
                url: part.image_url.clone(),
            }),
            "text" if !part.text.is_empty() => Some(ContentBlock::text(part.text.clone())),
            _ => None,
        })
        .collect()
}

fn retry_handler(run: &Arc<Run>, turn: usize) -> RetryHandler {
    let run = run.clone();
    Arc::new(move |retry: RetryEvent| {
        let run = run.clone();
        tokio::spawn(async move {
            run.event(
                EventInput::new(
                    "model.reconnecting",
                    "model",
                    "running",
                    "Reconnecting to AI backend",
                    format!("Reconnecting... {}/{}", retry.attempt, retry.max_retries),
                )
                .data(json!({
                    "turn": turn, "attempt": retry.attempt, "max_retries": retry.max_retries,
                    "delay_ms": retry.delay.as_millis() as u64, "reason": retry.reason,
                })),
            )
            .await;
        });
    })
}

fn stream_handler(run: &Arc<Run>, turn: usize, streamed: Arc<AtomicBool>) -> StreamHandler {
    let emitter = run.emitter.clone();
    let model = run.model.model_name.clone();
    Arc::new(move |event: StreamEvent| {
        let frame = match event.kind {
            "delta" if !event.delta.is_empty() => {
                streamed.store(true, Ordering::SeqCst);
                Frame {
                    delta: event.delta,
                    ..Frame::new("model_delta")
                }
                .extra("turn", turn)
                .extra("model", &model)
            }
            "tool_call_delta" => Frame::new("model_tool_call_delta")
                .extra("turn", turn)
                .extra("tool_call_index", event.tool_call_index)
                .extra("tool_call_id", &event.tool_call_id)
                .extra("tool_name", &event.tool_name)
                .extra("arguments_delta", &event.tool_arguments_delta)
                .extra("arguments", &event.tool_arguments)
                .extra("model", &model),
            "tool_call_ready" => Frame::new("model_tool_call_ready")
                .extra("turn", turn)
                .extra("tool_call_index", event.tool_call_index)
                .extra("tool_call_id", &event.tool_call_id)
                .extra("tool_name", &event.tool_name)
                .extra("arguments", &event.tool_arguments)
                .extra("model", &model),
            _ => return,
        };
        emitter.send(&frame);
    })
}

/// Records searches the model ran with its hosted web search tool.
async fn record_hosted_searches(run: &Run, result: &ChatResult) {
    for search in &result.hosted_web_search_calls {
        let mut input = json!({ "query": search.query, "hosted": true });
        if let Some(action) = &search.action {
            input["action"] = json!(action);
        }
        let Some(mut call) = tools::start_tool_call(run, "web_search", input).await else {
            continue;
        };
        let output = json!({
            "provider": result.wire_api, "hosted": true, "status": search.status,
            "query": search.query, "action": search.action,
        });
        tools::complete_tool_call(run, &mut call, output.clone()).await;
        let message = if search.query.is_empty() {
            "Used hosted web search".to_owned()
        } else {
            search.query.clone()
        };
        run.event(
            EventInput::new(
                "tool.completed",
                "research",
                "completed",
                "Web search",
                message,
            )
            .tool_call(Some(call.id))
            .data(json!({ "tool_name": "web_search", "output": output })),
        )
        .await;
        run.send(&Frame {
            tool_call: value(&call),
            ..Frame::new("tool_call")
        });
    }
}

/// The id prefix for calls of model step `step` that came without an id.
fn call_id_prefix(step: usize) -> String {
    format!("call_{}_{step}", kition_core::now_millis())
}

/// The engine as the turn's `Llm`.
pub(crate) struct AgentLlm {
    run: Arc<Run>,
    calls: AtomicUsize,
    last: Mutex<Option<(ChatResult, bool)>>,
}

impl AgentLlm {
    pub(crate) fn new(run: &Arc<Run>) -> Self {
        Self {
            run: run.clone(),
            calls: AtomicUsize::new(0),
            last: Mutex::new(None),
        }
    }

    /// The last call's result and whether its text was streamed.
    pub(crate) fn take_last(&self) -> Option<(ChatResult, bool)> {
        self.last
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }
}

impl Llm for AgentLlm {
    fn call(
        &self,
        request: LlmRequest,
        _on_text: ChunkSink,
    ) -> BoxFuture<'_, Result<LlmReply, String>> {
        Box::pin(async move {
            let index = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            let run = &self.run;
            run.event(
                EventInput::new("model.turn.started", "model", "running", "Call AI backend", format!("Requesting model turn {index}"))
                    .data(json!({ "turn": index, "model": run.model.model_name, "wire_api": run.model.wire_api })),
            )
            .await;
            let streamed = Arc::new(AtomicBool::new(false));
            let result = run
                .agent
                .engine()
                .chat_with_retry(
                    &request.messages,
                    &request.tools,
                    "",
                    &run.model,
                    Some(stream_handler(run, index, streamed.clone())),
                    Some(retry_handler(run, index)),
                )
                .await
                .map_err(|error| error.to_string())?;
            record_hosted_searches(run, &result).await;
            let follow_up = blocks(
                &images::save_hosted_images(run, &result.hosted_image_generation_calls).await,
            );
            let tool_calls = normalize_calls(&result.tool_calls, &call_id_prefix(index));
            run.event(
                EventInput::new(
                    "model.turn.completed",
                    "model",
                    "completed",
                    "AI backend returned",
                    format!(
                        "Turn {index} completed with {} tool calls",
                        tool_calls.len()
                    ),
                )
                .data(json!({
                    "turn": index, "content_chars": result.content.trim().chars().count(),
                    "tool_calls": tool_calls.len(), "stop_reason": result.stop_reason,
                })),
            )
            .await;
            let reply = LlmReply {
                content: result.content.trim().to_owned(),
                tool_calls,
                stop_reason: result.stop_reason.clone(),
                model: result.model.clone(),
                raw_items: result.response_items.clone(),
                follow_up,
            };
            *self.last.lock().unwrap_or_else(PoisonError::into_inner) =
                Some((result, streamed.load(Ordering::SeqCst)));
            Ok(reply)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_call_ids_name_the_step() {
        let prefix = call_id_prefix(3);
        assert!(prefix.starts_with("call_"), "{prefix}");
        assert!(prefix.ends_with("_3"), "{prefix}");
    }
}
