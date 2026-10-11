//! Test doubles for the harness and the crates built on it.

use std::collections::VecDeque;
use std::sync::{Mutex, PoisonError};

use futures::future::BoxFuture;
use serde_json::Value;

use crate::events::LoggedCall;
use crate::llm::{ChunkSink, Llm, LlmReply, LlmRequest};

/// A model that answers with fixed replies in order and records requests.
pub struct ScriptedLlm {
    replies: Mutex<VecDeque<LlmReply>>,
    requests: Mutex<Vec<LlmRequest>>,
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
    pub fn new(replies: Vec<LlmReply>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            requests: Mutex::new(Vec::new()),
        }
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
    fn call(
        &self,
        request: LlmRequest,
        on_text: ChunkSink,
    ) -> BoxFuture<'_, Result<LlmReply, String>> {
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
            let reply = reply.ok_or("the scripted model has no more replies")?;
            if !reply.content.is_empty() {
                on_text(&reply.content);
            }
            Ok(reply)
        })
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
        let sink = seen.clone();
        let on_text: ChunkSink = Arc::new(move |delta: &str| {
            sink.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push_str(delta);
        });
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
        let on_text: ChunkSink = Arc::new(|_delta: &str| {});
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
