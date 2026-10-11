//! The turn and step driver (DeepSeek Harness `agent-loop`). A turn is steps
//! until the model answers without tools; a step is one model call plus the
//! tools it asked for. Every model-visible input is logged first and the
//! request is derived from the log.

use std::sync::Arc;

use crate::cancel::Cancel;
use crate::derive::derive_messages;
use crate::events::{ContentBlock, EventBody, LoggedCall, SessionEvent, TurnEndReason};
use crate::llm::{ChunkSink, Llm, LlmRequest};
use crate::log::SessionLog;
use crate::policy::{CallInfo, Decision, Pipeline};
use crate::tool::{Settled, ToolContext, ToolRegistry};

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
    pub cancel: Cancel,
    pub live: LiveSink,
}

pub struct Driver {
    pub log: Arc<dyn SessionLog>,
    pub llm: Arc<dyn Llm>,
    pub pipeline: Pipeline,
    pub max_steps: u32,
}

impl Driver {
    pub fn new(log: Arc<dyn SessionLog>, llm: Arc<dyn Llm>) -> Self {
        Self {
            log,
            llm,
            pipeline: Pipeline::default(),
            max_steps: MAX_STEPS,
        }
    }

    /// Runs one turn to its end. A model failure ends the turn as `failed`
    /// and is returned as the error after `turn/end` is logged.
    pub async fn run_turn(&self, input: TurnInput) -> Result<TurnEndReason, String> {
        let turn = self
            .log
            .read(&input.session)?
            .iter()
            .filter(|event| matches!(event.body, EventBody::TurnStart { .. }))
            .count() as u32
            + 1;
        (input.live)(Live::Status { running: true });
        let outcome = match self.append(&input, EventBody::TurnStart { turn }) {
            Ok(_) => self.steps(&input, turn).await,
            Err(error) => Err(error),
        };
        let (reason, error) = match &outcome {
            Ok(reason) => (*reason, String::new()),
            Err(error) => (TurnEndReason::Failed, error.clone()),
        };
        let ended = self.append(
            &input,
            EventBody::TurnEnd {
                turn,
                reason,
                error,
            },
        );
        (input.live)(Live::Status { running: false });
        ended?;
        outcome
    }

    fn append(&self, input: &TurnInput, body: EventBody) -> Result<SessionEvent, String> {
        let event = self.log.append(&input.session, body)?;
        (input.live)(Live::Event(Box::new(event.clone())));
        Ok(event)
    }

    async fn steps(&self, input: &TurnInput, turn: u32) -> Result<TurnEndReason, String> {
        let mut user = Some(input.user.clone());
        for step in 1..=self.max_steps {
            if input.cancel.is_cancelled() {
                return Ok(TurnEndReason::Cancelled);
            }
            self.append(input, EventBody::StepStart { turn, step })?;
            self.reconcile_system(input)?;
            if let Some(content) = user.take() {
                self.append(input, EventBody::UserMessage { content })?;
            }
            let request = LlmRequest {
                messages: derive_messages(&self.log.read(&input.session)?),
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
                    self.append(
                        input,
                        EventBody::AssistantAttempt {
                            error: error.clone(),
                        },
                    )?;
                    self.append(input, EventBody::StepEnd { turn, step })?;
                    return if input.cancel.is_cancelled() {
                        Ok(TurnEndReason::Cancelled)
                    } else {
                        Err(error)
                    };
                }
            };
            self.append(
                input,
                EventBody::AssistantMessage {
                    content: reply.content.clone(),
                    tool_calls: reply.tool_calls.clone(),
                    stop_reason: reply.stop_reason,
                    model: reply.model,
                    raw_items: reply.raw_items,
                },
            )?;
            if reply.tool_calls.is_empty() {
                self.append(input, EventBody::StepEnd { turn, step })?;
                return if reply.content.trim().is_empty() {
                    Err("the model returned no content and no tool calls".into())
                } else {
                    Ok(TurnEndReason::Completed)
                };
            }
            for call in &reply.tool_calls {
                if let Some(reason) = self.run_call(input, call).await? {
                    self.append(input, EventBody::StepEnd { turn, step })?;
                    return Ok(reason);
                }
            }
            self.append(input, EventBody::StepEnd { turn, step })?;
        }
        Ok(TurnEndReason::StepLimit)
    }

    /// Runs one call through the pipeline. `Some` ends the turn.
    async fn run_call(
        &self,
        input: &TurnInput,
        call: &LoggedCall,
    ) -> Result<Option<TurnEndReason>, String> {
        self.append(
            input,
            EventBody::ToolCall {
                call_id: call.call_id.clone(),
                name: call.name.clone(),
                arguments: call.arguments.clone(),
            },
        )?;
        let Some(tool) = input.tools.get(&call.name) else {
            let missing = Settled::error(
                format!("tool `{}` is not available in this turn", call.name),
                None,
            );
            self.record(input, call, missing)?;
            return Ok(None);
        };
        let info = CallInfo {
            session: &input.session,
            call_id: &call.call_id,
            tool,
            arguments: &call.arguments,
        };
        let mut settled = match self.pipeline.decide(&info) {
            Decision::Allow => {
                let cx = ToolContext {
                    session_id: input.session.clone(),
                    call_id: call.call_id.clone(),
                    cancel: input.cancel.clone(),
                };
                tool.run(call.arguments.clone(), cx).await
            }
            Decision::Deny(reason) => Settled::error(reason, None),
            Decision::Ask(reason) => {
                self.append(
                    input,
                    EventBody::ApprovalAsked {
                        call_id: call.call_id.clone(),
                        reason,
                    },
                )?;
                return Ok(Some(TurnEndReason::AwaitingApproval));
            }
        };
        self.pipeline.settle(&info, &mut settled);
        self.record(input, call, settled)?;
        Ok(input
            .cancel
            .is_cancelled()
            .then_some(TurnEndReason::Cancelled))
    }

    fn record(&self, input: &TurnInput, call: &LoggedCall, settled: Settled) -> Result<(), String> {
        self.append(
            input,
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

    /// Logs the system prompt only when it differs from the newest logged one.
    fn reconcile_system(&self, input: &TurnInput) -> Result<(), String> {
        let current =
            self.log
                .read(&input.session)?
                .into_iter()
                .rev()
                .find_map(|event| match event.body {
                    EventBody::SystemMessage { content } => Some(content),
                    _ => None,
                });
        if current.as_deref() != Some(input.system.as_str()) {
            self.append(
                input,
                EventBody::SystemMessage {
                    content: input.system.clone(),
                },
            )?;
        }
        Ok(())
    }
}
