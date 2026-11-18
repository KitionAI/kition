//! Test doubles for the harness and the crates built on it.

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};

use futures::future::BoxFuture;
use serde_json::Value;

use crate::events::LoggedCall;
use crate::llm::{Llm, LlmReply, LlmRequest, LlmSink, RetryInfo, StreamChunk};

/// One scripted model call: the retries it reports (each scheduled, then
/// started), the chunks it streams, and its reply.
#[derive(Debug, Clone, Default)]
pub struct ScriptedCall {
    pub reply: LlmReply,
    pub chunks: Vec<StreamChunk>,
    pub retries: Vec<RetryInfo>,
}

/// A model that answers with fixed replies in order and records requests.
pub struct ScriptedLlm {
    replies: Mutex<VecDeque<ScriptedCall>>,
    requests: Mutex<Vec<LlmRequest>>,
    append_only: bool,
}

impl std::fmt::Debug for ScriptedLlm {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let remaining = self
            .replies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len();
        formatter
            .debug_struct("ScriptedLlm")
            .field("remaining_replies", &remaining)
            .finish_non_exhaustive()
    }
}

impl ScriptedLlm {
    /// Replies whose text, if any, streams as one `text-delta` chunk.
    pub fn new(replies: Vec<LlmReply>) -> Self {
        Self::scripted(
            replies
                .into_iter()
                .map(|reply| ScriptedCall {
                    chunks: if reply.content.is_empty() {
                        Vec::new()
                    } else {
                        vec![StreamChunk::TextDelta {
                            index: 0,
                            text: reply.content.clone(),
                        }]
                    },
                    reply,
                    retries: Vec::new(),
                })
                .collect(),
        )
    }

    pub fn scripted(calls: Vec<ScriptedCall>) -> Self {
        Self {
            replies: Mutex::new(calls.into()),
            requests: Mutex::new(Vec::new()),
            append_only: false,
        }
    }

    /// The same model, standing for one whose history stays append-only.
    #[must_use]
    pub fn appending_only(mut self) -> Self {
        self.append_only = true;
        self
    }

    /// Every request received so far.
    pub fn requests(&self) -> Vec<LlmRequest> {
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl Llm for ScriptedLlm {
    fn call(&self, request: LlmRequest, sink: LlmSink) -> BoxFuture<'_, Result<LlmReply, String>> {
        Box::pin(async move {
            self.requests
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(request);
            let reply = self
                .replies
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .pop_front();
            let call = reply.ok_or("the scripted model has no more replies")?;
            for retry in call.retries {
                let number = retry.retry;
                (sink.retry)(retry);
                (sink.retry_started)(number);
            }
            for chunk in call.chunks {
                (sink.chunk)(chunk);
            }
            Ok(call.reply)
        })
    }

    fn append_only(&self) -> bool {
        self.append_only
    }
}

/// A tool call for scripted replies.
pub fn call(id: &str, name: &str, arguments: Value) -> LoggedCall {
    LoggedCall {
        call_id: id.to_owned(),
        name: name.to_owned(),
        arguments,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[tokio::test]
    async fn scripted_llm_replays_and_records() {
        let llm = ScriptedLlm::new(vec![LlmReply::text("hello")]);
        let seen = Arc::new(Mutex::new(String::new()));
        let text = seen.clone();
        let on_text = LlmSink {
            chunk: Arc::new(move |chunk| {
                if let StreamChunk::TextDelta { text: delta, .. } = chunk {
                    text.lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push_str(&delta);
                }
            }),
            ..LlmSink::discard()
        };
        let request = LlmRequest {
            messages: Vec::new(),
            tools: Vec::new(),
        };
        let reply = llm
            .call(request, on_text.clone())
            .await
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(reply.content, "hello");
        assert_eq!(
            *seen.lock().unwrap_or_else(PoisonError::into_inner),
            "hello"
        );
        assert_eq!(llm.requests().len(), 1);
        let request = LlmRequest {
            messages: Vec::new(),
            tools: Vec::new(),
        };
        assert!(llm.call(request, on_text).await.is_err());
    }

    #[test]
    fn call_does_not_record_or_pop_until_the_future_is_polled() {
        let llm = ScriptedLlm::new(vec![LlmReply::text("hello")]);
        let on_text = LlmSink::discard();
        let request = LlmRequest {
            messages: Vec::new(),
            tools: Vec::new(),
        };
        let future = llm.call(request, on_text);
        drop(future);
        assert!(llm.requests().is_empty());
        assert_eq!(
            llm.replies
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .len(),
            1
        );
    }

    #[test]
    fn debug_shows_the_remaining_reply_count() {
        let llm = ScriptedLlm::new(vec![LlmReply::text("a"), LlmReply::text("b")]);
        assert!(format!("{llm:?}").contains("remaining_replies: 2"));
    }
}
