//! The NDJSON stream of a turn: one JSON-RPC 2.0 notification per line, in
//! the DeepSeek Harness SDK shapes (`contracts/runtime/agent-stream.schema.json`):
//! `session.status`, `session.event`, and `agent/assistant-stream`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::body::Body;
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use kition_harness::driver::{Live, LiveSink};
use kition_harness::events::{EventBody, TurnEndReason};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::run::HookDispatch;

/// The sending half of a streamed response. Cheap to clone.
#[derive(Clone)]
pub struct Emitter {
    tx: mpsc::UnboundedSender<Bytes>,
}

impl Emitter {
    /// An emitter and the streaming response that carries its lines. The
    /// body ends at `finish` or when every emitter is dropped.
    pub fn channel() -> (Self, Response) {
        let (tx, rx) = mpsc::unbounded_channel::<Bytes>();
        let body = Body::from_stream(futures::stream::unfold(rx, |mut rx| async move {
            rx.recv()
                .await
                .filter(|chunk| !chunk.is_empty())
                .map(|chunk| (Ok::<_, std::convert::Infallible>(chunk), rx))
        }));
        let response = (
            [
                (
                    http::header::CONTENT_TYPE,
                    "application/x-ndjson; charset=utf-8",
                ),
                (http::header::CACHE_CONTROL, "no-cache"),
            ],
            body,
        )
            .into_response();
        (Self { tx }, response)
    }

    /// Writes one notification; false once the client has gone away.
    pub fn notify(&self, method: &str, params: Value) -> bool {
        let line = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let Ok(mut line) = serde_json::to_vec(&line) else {
            return !self.tx.is_closed();
        };
        line.push(b'\n');
        self.tx.send(Bytes::from(line)).is_ok()
    }

    /// Ends the response body; later lines are dropped.
    pub fn finish(&self) {
        let _ = self.tx.send(Bytes::new());
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }

    /// Resolves when the client disconnects.
    pub async fn closed(&self) {
        self.tx.closed().await
    }
}

/// The stream of one request on one session: its status lines and the live
/// sink its turn writes through.
#[derive(Clone)]
pub struct TurnStream {
    emitter: Emitter,
    session: String,
    /// Set once a `turn/end` went out, so `idle` is only sent for a turn
    /// whose outcome is in the log.
    ended: Arc<AtomicBool>,
}

impl TurnStream {
    pub fn new(emitter: Emitter, session_id: i64) -> Self {
        Self {
            emitter,
            session: crate::log::log_key(session_id),
            ended: Arc::default(),
        }
    }

    /// Sends `session.status`.
    pub fn status(&self, running: bool) {
        self.emitter.notify(
            "session.status",
            json!({
                "sessionId": self.session,
                "status": if running { "running" } else { "idle" },
            }),
        );
    }

    /// Sends `idle` and ends the body when the turn's `turn/end` was sent;
    /// otherwise ends the body without `idle`, so the client reads the log
    /// to learn the outcome.
    pub fn close(&self) {
        if self.ended.load(Ordering::SeqCst) {
            self.status(false);
        }
        self.emitter.finish();
    }

    /// Ends the stream of a request that had nothing to run (a repeated
    /// image request): `running`, then `idle`.
    pub fn close_unchanged(&self) {
        self.status(true);
        self.status(false);
        self.emitter.finish();
    }

    /// The sink the turn's durable events and assistant-stream frames go
    /// through. Events are sent as `session.event` (provider-native items
    /// left out, as `GET /session-events` serves them) and fire the user's
    /// desktop hooks. The harness's own status updates are dropped: the
    /// stream says `running` before the turn and `idle` once the session row
    /// is saved after it (`close`).
    pub fn live_sink(&self, hooks: Option<HookDispatch>, user_id: i64) -> LiveSink {
        let stream = self.clone();
        Arc::new(move |live: Live| match live {
            Live::Status { .. } => {}
            Live::AssistantStream(frame) => {
                stream.emitter.notify(
                    "agent/assistant-stream",
                    json!({ "sessionId": stream.session, "frame": frame }),
                );
            }
            Live::Event(event) => {
                let event = crate::log::public(*event);
                if let Some(hooks) = &hooks {
                    fire_hook(hooks, user_id, &event.body);
                }
                if matches!(event.body, EventBody::TurnEnd { .. }) {
                    stream.ended.store(true, Ordering::SeqCst);
                }
                stream.emitter.notify(
                    "session.event",
                    json!({ "sessionId": stream.session, "event": event }),
                );
            }
        })
    }
}

/// The desktop hook an event fires: `(hook, tool_name, stage, status)`.
fn hook_of(body: &EventBody) -> Option<(&'static str, String, &'static str, &'static str)> {
    match body {
        EventBody::TurnStart { .. } => Some(("task_started", String::new(), "intent", "running")),
        EventBody::TurnEnd {
            reason: TurnEndReason::Completed,
            ..
        } => Some(("task_completed", String::new(), "final", "completed")),
        EventBody::TurnEnd {
            reason: TurnEndReason::Failed | TurnEndReason::Cancelled | TurnEndReason::StepLimit,
            ..
        } => Some(("task_failed", String::new(), "final", "failed")),
        EventBody::ToolCall { name, .. } => Some((
            "tool_called",
            name.clone(),
            crate::tools::stage(name),
            "running",
        )),
        EventBody::ApprovalAsked { tool_name, .. } => {
            Some(("user_input_needed", tool_name.clone(), "execute", "pending"))
        }
        _ => None,
    }
}

fn fire_hook(hooks: &HookDispatch, user_id: i64, body: &EventBody) {
    if let Some((name, tool, stage, status)) = hook_of(body) {
        hooks(user_id, name, &tool, stage, status);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use http_body_util::BodyExt;
    use kition_harness::events::SessionEvent;

    use super::*;

    async fn lines(response: Response) -> Vec<Value> {
        let body = response
            .into_body()
            .collect()
            .await
            .map(|body| body.to_bytes())
            .unwrap_or_default();
        String::from_utf8_lossy(&body)
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    #[tokio::test]
    async fn notifications_are_newline_delimited_and_end_at_finish() {
        let (emitter, response) = Emitter::channel();
        let stream = TurnStream::new(emitter.clone(), 42);
        stream.status(true);
        let sink = stream.live_sink(None, 1);
        sink(Live::Status { running: true });
        sink(Live::Event(Box::new(SessionEvent {
            seq: 1,
            at: 5,
            body: EventBody::AssistantMessage {
                turn: 1,
                step: 1,
                provider: String::new(),
                content: "Hi".into(),
                tool_calls: Vec::new(),
                stop_reason: String::new(),
                model: String::new(),
                raw_items: vec![json!({ "type": "provider_note" })],
                usage: None,
            },
        })));
        stream.close();
        emitter.notify("session.status", json!({ "late": true }));
        // A clone still exists, yet the body has ended.
        assert_eq!(
            lines(response).await,
            [
                json!({ "jsonrpc": "2.0", "method": "session.status", "params": { "sessionId": "agent:42", "status": "running" } }),
                json!({ "jsonrpc": "2.0", "method": "session.event", "params": { "sessionId": "agent:42", "event": {
                    "seq": 1, "at": 5, "type": "assistant/message", "turn": 1, "step": 1, "content": "Hi",
                    "stopReason": "", "provider": "", "model": "",
                } } }),
            ],
            "no idle without a turn/end, and raw items are left out"
        );
        drop(emitter);
    }

    #[tokio::test]
    async fn a_logged_turn_end_closes_with_idle() {
        let (emitter, response) = Emitter::channel();
        let stream = TurnStream::new(emitter, 7);
        let sink = stream.live_sink(None, 1);
        sink(Live::Event(Box::new(SessionEvent {
            seq: 2,
            at: 5,
            body: EventBody::TurnEnd {
                turn: 1,
                reason: TurnEndReason::Completed,
                error: String::new(),
            },
        })));
        stream.close();
        let lines = lines(response).await;
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["params"]["status"], "idle");
    }

    #[test]
    fn events_fire_the_desktop_hooks() {
        let fired: Arc<Mutex<Vec<String>>> = Arc::default();
        let seen = fired.clone();
        let hooks: HookDispatch = Arc::new(move |user, name, tool, stage, _status| {
            seen.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(format!("{user}:{name}:{tool}:{stage}"));
        });
        let end = |reason| EventBody::TurnEnd {
            turn: 1,
            reason,
            error: String::new(),
        };
        for body in [
            EventBody::TurnStart { turn: 1 },
            EventBody::ToolCall {
                turn: 1,
                step: 1,
                hosted: false,
                call_id: "c1".into(),
                name: "exec_command".into(),
                arguments: json!({}),
            },
            EventBody::ApprovalAsked {
                id: "approval:c1".into(),
                tool_name: "exec_command".into(),
                call_id: "c1".into(),
                reason: String::new(),
            },
            end(TurnEndReason::AwaitingApproval),
            end(TurnEndReason::Completed),
            end(TurnEndReason::StepLimit),
            EventBody::StepStart { turn: 1, step: 1 },
        ] {
            fire_hook(&hooks, 3, &body);
        }
        assert_eq!(
            *fired
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            [
                "3:task_started::intent",
                "3:tool_called:exec_command:execute",
                "3:user_input_needed:exec_command:execute",
                "3:task_completed::final",
                "3:task_failed::final",
            ]
        );
    }
}
