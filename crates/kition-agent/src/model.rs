//! The model seam of a turn: each engine call, its streamed deltas and
//! retries forwarded to the harness sink, and the model's hosted tool calls
//! (web search, image generation) returned for the log. Remembers the last
//! reply for the session title.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures::future::BoxFuture;
use kition_ai::engine::{ChatResult, MessagePart};
use kition_harness::events::ContentBlock;
use kition_harness::llm::{HostedCall, Llm, LlmReply, LlmRequest, LlmSink, normalize_calls};
use serde_json::json;

use crate::run::Run;
use crate::tools::images;

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

/// The searches the model ran with its hosted web search tool, as hosted
/// calls for the log; a search without an id gets `<id_prefix>_ws_<i>`.
fn hosted_searches(result: &ChatResult, id_prefix: &str) -> Vec<HostedCall> {
    result
        .hosted_web_search_calls
        .iter()
        .enumerate()
        .map(|(index, search)| {
            let mut input = json!({ "query": search.query, "hosted": true });
            if let Some(action) = &search.action {
                input["action"] = json!(action);
            }
            HostedCall {
                call_id: if search.id.trim().is_empty() {
                    format!("{id_prefix}_ws_{index}")
                } else {
                    search.id.trim().to_owned()
                },
                name: "web_search".into(),
                arguments: input,
                value: json!({
                    "provider": result.wire_api, "hosted": true, "status": search.status,
                    "query": search.query, "action": search.action,
                }),
                meta: Some(json!({ "hosted": true })),
                files: Vec::new(),
            }
        })
        .collect()
}

/// The id prefix for calls of model step `step` that came without an id.
fn call_id_prefix(step: usize) -> String {
    format!("call_{}_{step}", kition_core::now_millis())
}

/// The engine as the turn's `Llm`.
pub(crate) struct AgentLlm {
    run: Arc<Run>,
    calls: AtomicUsize,
    last: Mutex<Option<String>>,
}

impl AgentLlm {
    pub(crate) fn new(run: &Arc<Run>) -> Self {
        Self {
            run: run.clone(),
            calls: AtomicUsize::new(0),
            last: Mutex::new(None),
        }
    }

    /// The last reply's text.
    pub(crate) fn take_last(&self) -> Option<String> {
        self.last
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }
}

impl Llm for AgentLlm {
    fn call(&self, request: LlmRequest, sink: LlmSink) -> BoxFuture<'_, Result<LlmReply, String>> {
        Box::pin(async move {
            let index = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            let run = &self.run;
            let result = run
                .agent
                .engine()
                .chat_with_retry(
                    &request.messages,
                    &request.tools,
                    "",
                    &run.model,
                    Some(sink.stream_handler()),
                    Some(sink.retry_handler(&run.model.provider_type)),
                )
                .await
                .map_err(|error| error.to_string())?;
            let id_prefix = call_id_prefix(index);
            let mut hosted = hosted_searches(&result, &id_prefix);
            let (images, follow_up) = images::save_hosted_images(
                run,
                &result.wire_api,
                &id_prefix,
                &result.hosted_image_generation_calls,
            );
            hosted.extend(images);
            let reply = LlmReply {
                content: result.content.trim().to_owned(),
                tool_calls: normalize_calls(&result.tool_calls, &id_prefix),
                stop_reason: result.stop_reason.clone(),
                model: result.model.clone(),
                raw_items: result.response_items.clone(),
                follow_up: blocks(&follow_up),
                hosted,
            };
            *self.last.lock().unwrap_or_else(PoisonError::into_inner) = Some(reply.content.clone());
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
