//! The turn and step driver (DeepSeek Harness `agent-loop`). A turn is steps
//! until the model answers without tools; a step is one model call plus the
//! tools it asked for. Every model-visible input is logged first and the
//! request is derived from the log, which is read once at the start of the
//! turn; every event the turn itself appends also lands in that local copy,
//! so no step re-reads the log store.

use std::sync::Arc;

use crate::cancel::Cancel;
use crate::derive::derive_messages_for;
use crate::events::{
    ContentBlock, EventBody, LoggedCall, MessageSource, SessionEvent, TurnEndReason,
};
use crate::history::{HistoryBudget, bound_history};
use crate::llm::{ChunkSink, Llm, LlmRequest};
use crate::log::SessionLog;
use crate::policy::{CallInfo, Decision, Pipeline};
use crate::stop::StopCheck;
use crate::tool::{Pause, Settled, ToolContext, ToolRegistry};

pub const MAX_STEPS: u32 = 16;

/// Live updates for the panel: never needed for replay (DeepSeek Harness
/// `agent/*`). Every durable event is also sent live as `Event`.
#[derive(Debug, Clone, PartialEq)]
pub enum Live {
    Status { running: bool },
    AssistantText { delta: String },
    Event(Box<SessionEvent>),
}

pub type LiveSink = Arc<dyn Fn(Live) + Send + Sync>;

/// One turn's input. Build `system` and `tools` with `provider::assemble`.
pub struct TurnInput {
    pub session: String,
    pub system: String,
    pub tools: ToolRegistry,
    pub user: Vec<ContentBlock>,
    /// Who sent `user`: logged on the turn's first `user/message`.
    pub source: MessageSource,
    pub cancel: Cancel,
    pub live: LiveSink,
    /// The model id this turn will use. Provider-native `raw_items` on
    /// assistant messages from a different model are dropped before the
    /// request is built; `None` keeps everything (model not yet known).
    pub model: Option<String>,
}

impl std::fmt::Debug for TurnInput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TurnInput")
            .field("session", &self.session)
            .field("tools", &self.tools)
            .finish_non_exhaustive()
    }
}

/// A call's arguments as its tool allows them to be logged; an unknown
/// tool's arguments are logged as the model sent them.
fn logged_arguments(tools: &ToolRegistry, call: &LoggedCall) -> serde_json::Value {
    tools.get(&call.name).map_or_else(
        || call.arguments.clone(),
        |tool| tool.logged_arguments(&call.arguments),
    )
}

/// The number the next turn of a session gets: one past its turns so far.
pub fn next_turn(events: &[SessionEvent]) -> u32 {
    events
        .iter()
        .filter(|event| matches!(event.body, EventBody::TurnStart { .. }))
        .count() as u32
        + 1
}

/// Appends one event to `session` and sends it live. Every durable event
/// goes through here, including those written outside a model turn.
pub fn append_live(
    log: &dyn SessionLog,
    session: &str,
    live: &LiveSink,
    body: EventBody,
) -> Result<SessionEvent, String> {
    let event = log.append(session, body)?;
    live(Live::Event(Box::new(event.clone())));
    Ok(event)
}

/// The `approval/asked` for a call that waits for the person.
fn approval_asked(call: &LoggedCall, reason: String) -> EventBody {
    EventBody::ApprovalAsked {
        id: format!("approval:{}", call.call_id),
        tool_name: call.name.clone(),
        call_id: call.call_id.clone(),
        reason,
    }
}

pub struct Driver {
    pub log: Arc<dyn SessionLog>,
    pub llm: Arc<dyn Llm>,
    pub pipeline: Pipeline,
    pub max_steps: u32,
    /// Checked when the model stops calling tools, before the turn may end
    /// as completed.
    pub stop_checks: Vec<Arc<dyn StopCheck>>,
    /// How much of the log each request carries; the log itself keeps
    /// everything.
    pub history: HistoryBudget,
}

impl std::fmt::Debug for Driver {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Driver")
            .field("pipeline", &self.pipeline)
            .field("max_steps", &self.max_steps)
            .field("stop_checks", &self.stop_checks.len())
            .field("history", &self.history)
            .finish_non_exhaustive()
    }
}

impl Driver {
    pub fn new(log: Arc<dyn SessionLog>, llm: Arc<dyn Llm>) -> Self {
        Self {
            log,
            llm,
            pipeline: Pipeline::default(),
            max_steps: MAX_STEPS,
            stop_checks: Vec::new(),
            history: HistoryBudget::default(),
        }
    }

    /// Runs one turn to its end. A model failure, an empty model reply (no
    /// content and no tool calls), or an append failure all end the turn as
    /// `failed`. If the turn's own outcome is an error, that error is
    /// returned even when the closing `turn/end` append itself also fails;
    /// a `turn/end` append failure is only surfaced when the turn otherwise
    /// succeeded, since there is no earlier error to prefer.
    pub async fn run_turn(&self, input: TurnInput) -> Result<TurnEndReason, String> {
        let mut events = self.log.read(&input.session)?;
        let turn = next_turn(&events);
        (input.live)(Live::Status { running: true });
        let outcome = match self.append(&input, &mut events, EventBody::TurnStart { turn }) {
            // dsh closes a turn with no new input without a step or a model call.
            Ok(_) if input.user.is_empty() => Ok(TurnEndReason::Completed),
            Ok(_) => self.steps(&input, &mut events, turn).await,
            Err(error) => Err(error),
        };
        let (reason, error) = match &outcome {
            Ok(reason) => (*reason, String::new()),
            Err(error) => (TurnEndReason::Failed, error.clone()),
        };
        let ended = self.append(
            &input,
            &mut events,
            EventBody::TurnEnd {
                turn,
                reason,
                error,
            },
        );
        (input.live)(Live::Status { running: false });
        match outcome {
            Err(error) => Err(error),
            Ok(reason) => ended.map(|_| reason),
        }
    }

    fn append(
        &self,
        input: &TurnInput,
        events: &mut Vec<SessionEvent>,
        body: EventBody,
    ) -> Result<SessionEvent, String> {
        let event = append_live(self.log.as_ref(), &input.session, &input.live, body)?;
        events.push(event.clone());
        Ok(event)
    }

    async fn steps(
        &self,
        input: &TurnInput,
        events: &mut Vec<SessionEvent>,
        turn: u32,
    ) -> Result<TurnEndReason, String> {
        let mut user = Some(input.user.clone());
        for step in 1..=self.max_steps {
            if input.cancel.is_cancelled() {
                return Ok(TurnEndReason::Cancelled);
            }
            self.append(input, events, EventBody::StepStart { turn, step })?;
            if step == 1 {
                self.reconcile_system(input, events)?;
            }
            if let Some(content) = user.take() {
                self.append(
                    input,
                    events,
                    EventBody::UserMessage {
                        content,
                        source: input.source.clone(),
                    },
                )?;
            }
            let request = LlmRequest {
                messages: derive_messages_for(
                    &bound_history(events.as_slice(), self.history),
                    input.model.as_deref(),
                ),
                tools: input.tools.specs(),
            };
            let live = input.live.clone();
            let on_text: ChunkSink = Arc::new(move |delta: &str| {
                live(Live::AssistantText {
                    delta: delta.to_owned(),
                })
            });
            let reply = tokio::select! {
                reply = self.llm.call(request, on_text) => reply,
                () = input.cancel.cancelled() => Err("cancelled".to_owned()),
            };
            let reply = match reply {
                Ok(reply) => reply,
                Err(error) => {
                    // A failed `assistant/attempt` append must not shadow
                    // the model error itself: that is the one the caller
                    // needs, and `run_turn` still gets a chance to log
                    // `turn/end` for it.
                    let _ = self.append(
                        input,
                        events,
                        EventBody::AssistantAttempt {
                            error: error.clone(),
                        },
                    );
                    self.append(input, events, EventBody::StepEnd { turn, step })?;
                    return if input.cancel.is_cancelled() {
                        Ok(TurnEndReason::Cancelled)
                    } else {
                        Err(error)
                    };
                }
            };
            self.append(
                input,
                events,
                EventBody::AssistantMessage {
                    content: reply.content.clone(),
                    tool_calls: reply
                        .tool_calls
                        .iter()
                        .map(|call| LoggedCall {
                            arguments: logged_arguments(&input.tools, call),
                            ..call.clone()
                        })
                        .collect(),
                    stop_reason: reply.stop_reason,
                    model: reply.model,
                    raw_items: reply.raw_items,
                },
            )?;
            if reply.tool_calls.is_empty() && reply.follow_up.is_empty() {
                self.append(input, events, EventBody::StepEnd { turn, step })?;
                // A stop check (an unresolved failed write, say) is the more
                // useful error even when the reply is also empty: it names
                // the real problem instead of the generic empty-reply text.
                if let Some(message) = self.run_stop_checks(events, &input.tools) {
                    return Err(message);
                }
                if reply.content.trim().is_empty() {
                    return Err("the model returned no content and no tool calls".into());
                }
                return Ok(TurnEndReason::Completed);
            }
            let mut contexts: Vec<ContentBlock> = Vec::new();
            let mut end_reason = None;
            for call in &reply.tool_calls {
                let (reason, context) = self.run_call(input, events, call).await?;
                contexts.extend(context);
                if reason.is_some() {
                    end_reason = reason;
                    break;
                }
            }
            // A cancelled call's step ends right there: its (and any
            // earlier calls') recovery context would only tell the model to
            // "recover now", which makes no sense once the turn is already
            // tearing down.
            if !contexts.is_empty() && end_reason != Some(TurnEndReason::Cancelled) {
                self.append(
                    input,
                    events,
                    EventBody::UserMessage {
                        content: contexts,
                        source: MessageSource::new("recovery"),
                    },
                )?;
            }
            if end_reason.is_none() && !reply.follow_up.is_empty() {
                self.append(
                    input,
                    events,
                    EventBody::UserMessage {
                        content: reply.follow_up,
                        source: MessageSource::new("tool-follow-up"),
                    },
                )?;
            }
            self.append(input, events, EventBody::StepEnd { turn, step })?;
            if let Some(reason) = end_reason {
                return Ok(reason);
            }
        }
        Ok(TurnEndReason::StepLimit)
    }

    /// This turn's events so far (from its most recent `turn/start`), run
    /// through every stop check in order; the first failure wins.
    fn run_stop_checks(&self, events: &[SessionEvent], tools: &ToolRegistry) -> Option<String> {
        let start = events
            .iter()
            .rposition(|event| matches!(event.body, EventBody::TurnStart { .. }))
            .unwrap_or(0);
        let turn_events = &events[start..];
        self.stop_checks
            .iter()
            .find_map(|check| check.check(turn_events, tools))
    }

    /// Runs one call through the pipeline. The first element of the pair is
    /// `Some` when the call ends the turn; the second is any recovery
    /// context the policies attached to the settled result.
    async fn run_call(
        &self,
        input: &TurnInput,
        events: &mut Vec<SessionEvent>,
        call: &LoggedCall,
    ) -> Result<(Option<TurnEndReason>, Vec<ContentBlock>), String> {
        self.append(
            input,
            events,
            EventBody::ToolCall {
                call_id: call.call_id.clone(),
                name: call.name.clone(),
                arguments: logged_arguments(&input.tools, call),
            },
        )?;
        let Some(tool) = input.tools.get(&call.name) else {
            let mut missing = Settled::error(
                format!("tool `{}` is not available in this turn", call.name),
                None,
            );
            self.pipeline.settle_missing(&call.name, &mut missing);
            let context = std::mem::take(&mut missing.context);
            self.record(input, events, call, missing)?;
            return Ok((None, context));
        };
        let info = CallInfo {
            session: &input.session,
            call_id: &call.call_id,
            tool,
            arguments: &call.arguments,
        };
        let pause = Pause::default();
        let mut settled = match self.pipeline.decide(&info) {
            Decision::Allow => {
                let cx = ToolContext {
                    session_id: input.session.clone(),
                    call_id: call.call_id.clone(),
                    cancel: input.cancel.clone(),
                    pause: pause.clone(),
                };
                tool.run(call.arguments.clone(), cx).await
            }
            Decision::Deny(reason) => Settled::error(reason, None),
            Decision::Ask(reason) => {
                self.append(input, events, approval_asked(call, reason))?;
                return Ok((Some(TurnEndReason::AwaitingApproval), Vec::new()));
            }
        };
        self.pipeline.settle(&info, &mut settled);
        let context = std::mem::take(&mut settled.context);
        let is_error = settled.is_error;
        self.record(input, events, call, settled)?;
        // Cancel takes precedence over a pending pause, and a failed body's
        // pause request is meaningless: discard it either way and only
        // honour a pause when the call actually succeeded.
        let pause_reason = pause.take();
        if input.cancel.is_cancelled() {
            return Ok((Some(TurnEndReason::Cancelled), context));
        }
        if let Some(reason) = pause_reason.filter(|_| !is_error) {
            self.append(input, events, approval_asked(call, reason))?;
            return Ok((Some(TurnEndReason::AwaitingApproval), context));
        }
        Ok((None, context))
    }

    fn record(
        &self,
        input: &TurnInput,
        events: &mut Vec<SessionEvent>,
        call: &LoggedCall,
        settled: Settled,
    ) -> Result<(), String> {
        self.append(
            input,
            events,
            EventBody::ToolResult {
                call_id: call.call_id.clone(),
                name: call.name.clone(),
                value: settled.value,
                content: settled.content,
                is_error: settled.is_error,
                meta: settled.meta,
            },
        )
        .map(|_| ())
    }

    /// Logs the system prompt only when it differs from the newest logged
    /// one; checked once, at the first step of the turn.
    fn reconcile_system(
        &self,
        input: &TurnInput,
        events: &mut Vec<SessionEvent>,
    ) -> Result<(), String> {
        let current = events.iter().rev().find_map(|event| match &event.body {
            EventBody::SystemMessage { content } => Some(content.clone()),
            _ => None,
        });
        if current.as_deref() != Some(input.system.as_str()) {
            self.append(
                input,
                events,
                EventBody::SystemMessage {
                    content: input.system.clone(),
                },
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::MemoryLog;
    use crate::testing::ScriptedLlm;
    use crate::tool::ToolRegistry;

    #[test]
    fn debug_impls_do_not_panic_and_do_not_dump_every_field() {
        let driver = Driver::new(
            Arc::new(MemoryLog::default()),
            Arc::new(ScriptedLlm::new(Vec::new())),
        );
        let debug = format!("{driver:?}");
        assert!(debug.starts_with("Driver {"), "{debug}");
        assert!(debug.contains("max_steps"), "{debug}");
        assert!(debug.contains("history"), "{debug}");

        let input = TurnInput {
            session: "s".into(),
            system: "sys".into(),
            tools: ToolRegistry::default(),
            user: Vec::new(),
            cancel: Cancel::default(),
            live: Arc::new(|_event: Live| {}),
            model: None,
            source: MessageSource::user(),
        };
        let debug = format!("{input:?}");
        assert!(debug.contains("\"s\""), "{debug}");
    }
}
