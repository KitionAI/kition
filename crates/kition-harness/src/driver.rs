//! The turn and step driver (DeepSeek Harness `agent-loop`). A turn is steps
//! until the model answers without tools; a step is one model call plus the
//! tools it asked for. Every model-visible input is logged first and the
//! request is derived from the log, which is read once at the start of the
//! turn; every event the turn itself appends also lands in that local copy,
//! so no step re-reads the log store.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use kition_core::now_millis;
use serde::{Deserialize, Serialize};

use crate::cancel::Cancel;
use crate::derive::derive_messages_for;
use crate::events::{
    ContentBlock, EventBody, InboxTarget, LlmFailure, LoggedCall, MessageSource, PresentedFile,
    QueuedMessage, RetryMode, SessionEvent, TurnEndReason,
};
use crate::history::{HistoryBudget, bound_history};
use crate::llm::{HostedCall, Llm, LlmRequest, LlmSink, RetryInfo, StreamChunk};
use crate::log::SessionLog;
use crate::policy::{CallInfo, Decision, Pipeline};
use crate::stop::StopCheck;
use crate::tool::{Emits, Pause, Settled, ToolContext, ToolRegistry};

pub const MAX_STEPS: u32 = 16;

/// Live updates for the panel: never needed for replay (DeepSeek Harness
/// `agent/*`). Every durable event is also sent live as `Event`.
#[derive(Debug, Clone, PartialEq)]
pub enum Live {
    Status {
        running: bool,
    },
    /// dsh `agent/assistant-stream`.
    AssistantStream(AssistantStreamFrame),
    Event(Box<SessionEvent>),
}

/// One live publication of a model attempt (dsh `AssistantStreamFrame`).
/// `revision` counts the frames of one session from 1 (see
/// `TurnInput::stream_revision`); `index` counts the chunks of one attempt
/// from 0, and `end` carries their number.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum AssistantStreamFrame {
    Start {
        attempt_id: String,
        revision: u64,
        turn: u32,
        step: u32,
    },
    Chunk {
        attempt_id: String,
        revision: u64,
        index: u64,
        time: i64,
        chunk: StreamChunk,
    },
    End {
        attempt_id: String,
        revision: u64,
        index: u64,
        outcome: StreamOutcome,
    },
}

/// How an attempt settled: the durable event committed for it
/// (`assistant/message` or `assistant/attempt`), or abandoned without one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum StreamOutcome {
    Committed { event_type: String, seq: u64 },
    Abandoned,
}

/// Publishes the frames of one model attempt.
struct AttemptStream {
    live: LiveSink,
    attempt_id: String,
    revision: Arc<AtomicU64>,
    chunks: Arc<AtomicU64>,
}

impl AttemptStream {
    fn start(
        live: &LiveSink,
        revision: &Arc<AtomicU64>,
        attempt_id: String,
        turn: u32,
        step: u32,
    ) -> Self {
        let stream = Self {
            live: live.clone(),
            attempt_id,
            revision: revision.clone(),
            chunks: Arc::default(),
        };
        (stream.live)(Live::AssistantStream(AssistantStreamFrame::Start {
            attempt_id: stream.attempt_id.clone(),
            revision: stream.next_revision(),
            turn,
            step,
        }));
        stream
    }

    fn next_revision(&self) -> u64 {
        self.revision.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn chunk_sink(&self) -> Arc<dyn Fn(StreamChunk) + Send + Sync> {
        let (live, attempt_id) = (self.live.clone(), self.attempt_id.clone());
        let (revision, chunks) = (self.revision.clone(), self.chunks.clone());
        Arc::new(move |chunk| {
            live(Live::AssistantStream(AssistantStreamFrame::Chunk {
                attempt_id: attempt_id.clone(),
                revision: revision.fetch_add(1, Ordering::SeqCst) + 1,
                index: chunks.fetch_add(1, Ordering::SeqCst),
                time: now_millis(),
                chunk,
            }));
        })
    }

    fn end(&self, outcome: StreamOutcome) {
        (self.live)(Live::AssistantStream(AssistantStreamFrame::End {
            attempt_id: self.attempt_id.clone(),
            revision: self.next_revision(),
            index: self.chunks.load(Ordering::SeqCst),
            outcome,
        }));
    }

    /// Ends the attempt with the outcome of appending its settling event.
    fn settle(&self, appended: &Result<SessionEvent, String>) {
        self.end(match appended {
            Ok(event) => StreamOutcome::Committed {
                event_type: event.body.kind().to_owned(),
                seq: event.seq,
            },
            Err(_) => StreamOutcome::Abandoned,
        });
    }
}

/// The retry events one model call appended, in order, and the first
/// append failure.
#[derive(Default)]
struct RetryLog {
    events: Vec<SessionEvent>,
    error: Option<String>,
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
    /// The inbox id of `user`, which the turn splices in and claims.
    pub message_id: String,
    /// The permission preset of this turn, logged as `permission/preset` at
    /// step 1 when it differs from the newest logged one.
    pub preset: Option<String>,
    /// The last `revision` sent on this session's assistant stream. Owned
    /// by the session, not the turn: dsh clients require each frame to be
    /// the previous revision plus one for as long as they stay attached.
    pub stream_revision: Arc<AtomicU64>,
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

/// Opens turn `turn`. With a prompt, as DeepSeek Harness does: the prompt
/// enters the inbox (`agent/inbox/spliced` with it inserted), `turn/start`,
/// and the turn claims it (`agent/inbox/spliced` removing one entry); its
/// `user/message` follows at step 1. Returns the appended events.
pub fn open_turn(
    log: &dyn SessionLog,
    session: &str,
    live: &LiveSink,
    turn: u32,
    message: Option<&QueuedMessage>,
) -> Result<Vec<SessionEvent>, String> {
    let splice =
        |inserted: Vec<QueuedMessage>, removed_count: Option<u32>| EventBody::InboxSpliced {
            target: InboxTarget::NextTurn,
            start: 0,
            inserted,
            removed_count,
        };
    let mut bodies = vec![EventBody::TurnStart { turn }];
    if let Some(message) = message {
        bodies.insert(0, splice(vec![message.clone()], None));
        bodies.push(splice(Vec::new(), Some(1)));
    }
    bodies
        .into_iter()
        .map(|body| append_live(log, session, live, body))
        .collect()
}

/// Logs a turn that failed before it could run (its tools could not be
/// assembled, say): the turn opens with its prompt, if any, then
/// `turn/end {failed, error}`, live between `running` and `idle` like any
/// turn.
pub fn fail_turn(
    log: &dyn SessionLog,
    session: &str,
    live: &LiveSink,
    message: Option<&QueuedMessage>,
    error: &str,
) -> Result<(), String> {
    let turn = next_turn(&log.read(session)?);
    live(Live::Status { running: true });
    let logged = open_turn(log, session, live, turn, message).and_then(|_| {
        append_live(
            log,
            session,
            live,
            EventBody::TurnEnd {
                turn,
                reason: TurnEndReason::Failed,
                error: error.to_owned(),
            },
        )
    });
    live(Live::Status { running: false });
    logged.map(|_| ())
}

/// A `deliverables/presented` for the files of `call_id` that have a path,
/// or `None` when no file does.
fn deliverables(turn: u32, call_id: &str, files: Vec<PresentedFile>) -> Option<EventBody> {
    let files: Vec<PresentedFile> = files
        .into_iter()
        .filter(|file| !file.path.trim().is_empty())
        .collect();
    (!files.is_empty()).then(|| EventBody::DeliverablesPresented {
        turn,
        call_id: call_id.to_owned(),
        files,
    })
}

/// The `approval/asked` for a call that waits for the person.
///
/// Deviation from dsh, whose approval service issues a fresh id per
/// request: the id is `approval:<callId>`, because a call is asked at most
/// once. Also unlike dsh, the matching `approval/decided` is not appended
/// inside this turn: the turn ends `awaiting-approval`, and the decision
/// lands at the start of the next drive, before the turn that resumes it.
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
        let message = (!input.user.is_empty()).then(|| QueuedMessage {
            id: input.message_id.clone(),
            content: input.user.clone(),
            source: input.source.clone(),
        });
        let opened = open_turn(
            self.log.as_ref(),
            &input.session,
            &input.live,
            turn,
            message.as_ref(),
        );
        let outcome = match opened.map(|opened| events.extend(opened)) {
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
        let revision = &input.stream_revision;
        for step in 1..=self.max_steps {
            if input.cancel.is_cancelled() {
                return Ok(TurnEndReason::Cancelled);
            }
            self.append(input, events, EventBody::StepStart { turn, step })?;
            if step == 1 {
                self.reconcile_system(input, events, turn)?;
                self.reconcile_preset(input, events)?;
            }
            if let Some(content) = user.take() {
                self.append(
                    input,
                    events,
                    EventBody::UserMessage {
                        id: input.message_id.clone(),
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
            let attempt_id = format!("{}#{turn}.{step}", input.session);
            let stream =
                AttemptStream::start(&input.live, revision, attempt_id.clone(), turn, step);
            let retries = Arc::new(Mutex::new(RetryLog::default()));
            let sink = self.sink(input, &stream, &retries, &attempt_id, turn, step);
            let reply = tokio::select! {
                reply = self.llm.call(request, sink) => reply,
                () = input.cancel.cancelled() => Err("cancelled".to_owned()),
            };
            let retries =
                std::mem::take(&mut *retries.lock().unwrap_or_else(PoisonError::into_inner));
            events.extend(retries.events);
            if let Some(error) = retries.error {
                stream.end(StreamOutcome::Abandoned);
                return Err(error);
            }
            let reply = match reply {
                Ok(reply) => reply,
                Err(error) => {
                    // A failed `assistant/attempt` append must not shadow
                    // the model error itself: that is the one the caller
                    // needs, and `run_turn` still gets a chance to log
                    // `turn/end` for it.
                    let appended = self.append(
                        input,
                        events,
                        EventBody::AssistantAttempt {
                            turn,
                            step,
                            error: error.clone(),
                            aborted: input.cancel.is_cancelled(),
                        },
                    );
                    stream.settle(&appended);
                    self.append(input, events, EventBody::StepEnd { turn, step })?;
                    return if input.cancel.is_cancelled() {
                        Ok(TurnEndReason::Cancelled)
                    } else {
                        Err(error)
                    };
                }
            };
            let appended = self.append(
                input,
                events,
                EventBody::AssistantMessage {
                    turn,
                    step,
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
                    provider: reply.provider,
                    model: reply.model,
                    raw_items: reply.raw_items,
                },
            );
            stream.settle(&appended);
            appended?;
            for hosted in reply.hosted {
                self.record_hosted(input, events, (turn, step), hosted)?;
            }
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
                let (reason, context) = self.run_call(input, events, (turn, step), call).await?;
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
                        id: format!("{}#{turn}.{step}.recovery", input.session),
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
                        id: format!("{}#{turn}.{step}.tool-follow-up", input.session),
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
        (turn, step): (u32, u32),
        call: &LoggedCall,
    ) -> Result<(Option<TurnEndReason>, Vec<ContentBlock>), String> {
        self.append(
            input,
            events,
            EventBody::ToolCall {
                turn,
                step,
                call_id: call.call_id.clone(),
                name: call.name.clone(),
                arguments: logged_arguments(&input.tools, call),
                hosted: false,
            },
        )?;
        let Some(tool) = input.tools.get(&call.name) else {
            let mut missing = Settled::error(
                format!("tool `{}` is not available in this turn", call.name),
                None,
            );
            self.pipeline.settle_missing(&call.name, &mut missing);
            let context = std::mem::take(&mut missing.context);
            self.record(input, events, (turn, step), call, missing)?;
            return Ok((None, context));
        };
        let info = CallInfo {
            session: &input.session,
            call_id: &call.call_id,
            tool,
            arguments: &call.arguments,
        };
        let pause = Pause::default();
        let emit = Emits::default();
        let mut settled = match self.pipeline.decide(&info) {
            Decision::Allow => {
                let cx = ToolContext {
                    session_id: input.session.clone(),
                    call_id: call.call_id.clone(),
                    turn,
                    cancel: input.cancel.clone(),
                    pause: pause.clone(),
                    emit: emit.clone(),
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
        self.record(input, events, (turn, step), call, settled)?;
        let emitted = emit.take();
        if !is_error {
            for body in emitted {
                self.append_emitted(input, events, turn, &call.call_id, body)?;
            }
        }
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
        (turn, step): (u32, u32),
        call: &LoggedCall,
        settled: Settled,
    ) -> Result<(), String> {
        self.append(
            input,
            events,
            EventBody::ToolResult {
                turn,
                step,
                call_id: call.call_id.clone(),
                name: call.name.clone(),
                value: settled.value,
                content: settled.content,
                is_error: settled.is_error,
                meta: settled.meta,
                hosted: false,
            },
        )
        .map(|_| ())
    }

    /// The sink of one model call: chunks go out as frames of `stream`;
    /// retries are appended right away (`llm/retry` before the wait,
    /// `llm/retry-started` after it), all of one step under `attempt_id`
    /// as their retry chain id, and collected in `retries`.
    ///
    /// Deliberate deviation from dsh, which logs retries between settled
    /// attempts: the engine retries inside one model call, so these events
    /// land inside the open attempt, after its `start` frame and before
    /// its first chunk. That is safe because `with_retry` never retries
    /// once output has streamed.
    fn sink(
        &self,
        input: &TurnInput,
        stream: &AttemptStream,
        retries: &Arc<Mutex<RetryLog>>,
        attempt_id: &str,
        turn: u32,
        step: u32,
    ) -> LlmSink {
        let append = {
            let (log, session) = (self.log.clone(), input.session.clone());
            let (live, retries) = (input.live.clone(), retries.clone());
            Arc::new(move |body: EventBody| {
                let failed = retries
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .error
                    .is_some();
                if failed {
                    return;
                }
                // Appended without holding the lock: the live sink may run
                // arbitrary code.
                let appended = append_live(log.as_ref(), &session, &live, body);
                let mut retries = retries.lock().unwrap_or_else(PoisonError::into_inner);
                match appended {
                    Ok(event) => retries.events.push(event),
                    Err(error) => retries.error = Some(error),
                }
            })
        };
        let scheduled = {
            let (append, retry_id) = (append.clone(), attempt_id.to_owned());
            Arc::new(move |info: RetryInfo| {
                debug_assert!(info.retry >= 1, "retries count from 1");
                append(EventBody::LlmRetry {
                    retry_id: retry_id.clone(),
                    turn,
                    step,
                    provider: info.provider,
                    mode: RetryMode::Normal,
                    policy_key: "engine".into(),
                    retry: info.retry,
                    max_retries: info.max_retries,
                    delay_ms: info.delay_ms,
                    failure: LlmFailure {
                        message: info.message,
                        code: info.code,
                    },
                });
            })
        };
        let started = {
            let retry_id = attempt_id.to_owned();
            Arc::new(move |retry: u32| {
                append(EventBody::LlmRetryStarted {
                    retry_id: retry_id.clone(),
                    turn,
                    step,
                    retry,
                });
            })
        };
        LlmSink {
            chunk: stream.chunk_sink(),
            retry: scheduled,
            retry_started: started,
        }
    }

    /// Logs an event a tool body emitted. A `deliverables/presented` gets
    /// this turn and call, and files without a path are dropped (with the
    /// event when none remain).
    fn append_emitted(
        &self,
        input: &TurnInput,
        events: &mut Vec<SessionEvent>,
        turn: u32,
        call_id: &str,
        body: EventBody,
    ) -> Result<(), String> {
        let body = match body {
            EventBody::DeliverablesPresented { files, .. } => {
                match deliverables(turn, call_id, files) {
                    Some(body) => body,
                    None => return Ok(()),
                }
            }
            body => body,
        };
        self.append(input, events, body).map(|_| ())
    }

    /// Logs a call the provider ran itself: `tool/call`, a successful
    /// `tool/result`, both marked `hosted`, and its files. No `tool/call` of
    /// the model is open for it, so `derive` skips the pair.
    fn record_hosted(
        &self,
        input: &TurnInput,
        events: &mut Vec<SessionEvent>,
        (turn, step): (u32, u32),
        hosted: HostedCall,
    ) -> Result<(), String> {
        self.append(
            input,
            events,
            EventBody::ToolCall {
                turn,
                step,
                call_id: hosted.call_id.clone(),
                name: hosted.name.clone(),
                arguments: hosted.arguments,
                hosted: true,
            },
        )?;
        self.append(
            input,
            events,
            EventBody::ToolResult {
                turn,
                step,
                call_id: hosted.call_id.clone(),
                name: hosted.name,
                value: hosted.value,
                content: Vec::new(),
                is_error: false,
                meta: hosted.meta,
                hosted: true,
            },
        )?;
        if let Some(body) = deliverables(turn, &hosted.call_id, hosted.files) {
            self.append(input, events, body)?;
        }
        Ok(())
    }

    /// Logs the permission preset only when it differs from the newest
    /// logged one; checked once, at the first step of the turn.
    fn reconcile_preset(
        &self,
        input: &TurnInput,
        events: &mut Vec<SessionEvent>,
    ) -> Result<(), String> {
        let Some(preset) = &input.preset else {
            return Ok(());
        };
        let current = events.iter().rev().find_map(|event| match &event.body {
            EventBody::PermissionPreset { preset } => Some(preset.as_str()),
            _ => None,
        });
        if current != Some(preset.as_str()) {
            self.append(
                input,
                events,
                EventBody::PermissionPreset {
                    preset: preset.clone(),
                },
            )?;
        }
        Ok(())
    }

    /// Logs the system prompt only when it differs from the newest logged
    /// one; checked once, at the first step of the turn.
    fn reconcile_system(
        &self,
        input: &TurnInput,
        events: &mut Vec<SessionEvent>,
        turn: u32,
    ) -> Result<(), String> {
        let current = events.iter().rev().find_map(|event| match &event.body {
            EventBody::SystemMessage { content, .. } => Some(content.clone()),
            _ => None,
        });
        if current.as_deref() != Some(input.system.as_str()) {
            self.append(
                input,
                events,
                EventBody::SystemMessage {
                    turn,
                    step: 1,
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
            message_id: "m".into(),
            preset: None,
            stream_revision: Arc::default(),
        };
        let debug = format!("{input:?}");
        assert!(debug.contains("\"s\""), "{debug}");
    }
}
