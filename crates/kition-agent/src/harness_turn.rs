//! One agent turn on `kition-harness`: the same prompts, tools, stream
//! frames, and timeline as `turn.rs`, with the session event log as the
//! source of model history. This is the default; `KITION_AGENT_HARNESS=0`
//! falls back to the original loop in `turn.rs` for one release.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures::future::BoxFuture;
use kition_ai::engine::{ChatResult, MessagePart, ToolSpec};
use kition_harness::cancel::Cancel;
use kition_harness::driver::{Driver, Live, TurnInput};
use kition_harness::events::{ContentBlock, EventBody, TurnEndReason};
use kition_harness::llm::{ChunkSink, Llm, LlmReply, LlmRequest, normalize_calls};
use kition_harness::log::{SessionLog, SqliteLog};
use kition_harness::policy::{CallInfo, Pipeline, Policy};
use kition_harness::provider::{TurnScene, assemble};
use kition_harness::stop::{RecoveryPrompt, UnresolvedWrites};
use kition_harness::tool::{
    Settled, ToolContext, ToolDef as HarnessTool, ToolFailure, ToolRegistry, define,
};
use serde_json::{Value, json};

use crate::providers::{self, ToolFactory, ToolShape, TurnFacts};
use crate::run::{EventInput, Run};
use crate::session;
use crate::store::{self, AgentSession};
use crate::tools::{self, images};
use crate::{prompts, turn};

/// The output of the call that paused the turn, for the approval frames.
type Pending = Arc<Mutex<Option<Value>>>;

/// Each call's follow-up content (`Executed::follow_up`), by call id, until
/// the `FollowUp` policy appends it to that call's result.
type Notes = Arc<Mutex<HashMap<String, Vec<ContentBlock>>>>;

/// Runs one named tool call: `(name, arguments, context)`.
type Body = Arc<
    dyn Fn(String, Value, ToolContext) -> BoxFuture<'static, Result<Value, ToolFailure>>
        + Send
        + Sync,
>;

fn blocks(parts: &[MessagePart]) -> Vec<ContentBlock> {
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

/// The model seam with the original loop's frames, retry events, and hosted
/// tool handling. Remembers the last result for the final reply.
struct AgentLlm {
    run: Arc<Run>,
    calls: AtomicUsize,
    last: Mutex<Option<(ChatResult, bool)>>,
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
                    Some(turn::stream_handler(run, index, streamed.clone())),
                    Some(turn::retry_handler(run, index)),
                )
                .await
                .map_err(|error| error.to_string())?;
            turn::record_hosted_searches(run, &result).await;
            let follow_up = blocks(
                &images::save_hosted_images(run, &result.hosted_image_generation_calls).await,
            );
            let tool_calls = normalize_calls(
                &result.tool_calls,
                &format!("ow_tool_{}_{index}", kition_core::now_millis()),
            );
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

/// Stores a call's follow-up for the `FollowUp` policy.
fn remember(notes: &Notes, call_id: &str, follow_up: &[MessagePart]) {
    let content = blocks(follow_up);
    if !content.is_empty() {
        notes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(call_id.to_owned(), content);
    }
}

/// Appends a call's follow-up (notes such as the `image_search` system
/// follow-up, image captions, and images) to its result content, after the
/// result itself, on success and failure alike. The logged value stays the
/// tool's record alone.
struct FollowUp {
    notes: Notes,
}

impl Policy for FollowUp {
    fn post_execute(&self, call: &CallInfo<'_>, settled: &mut Settled) {
        let notes = self
            .notes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(call.call_id);
        settled.content.extend(notes.unwrap_or_default());
    }
}

fn pipeline(notes: &Notes) -> Pipeline {
    Pipeline::default()
        .with(FollowUp {
            notes: notes.clone(),
        })
        .with(RecoveryPrompt)
}

/// The arguments as written to the session log for tools whose provider
/// does not shape them. Mirrors `persisted_input` in `tools/mod.rs` (the
/// source of these rules); keep the two in sync. Tools that need their own
/// summary pass it through their provider's `ToolShape`.
fn logged_arguments(name: &str, input: &Value) -> Value {
    match name {
        "source_search" | "source_file_search" | "configure_smtp_connection" => {
            let mut safe = input.as_object().cloned().unwrap_or_default();
            if let Some(query) = safe.remove("query") {
                safe.insert(
                    "query_chars".into(),
                    json!(query.as_str().unwrap_or_default().chars().count()),
                );
            }
            if safe.remove("password").is_some() {
                safe.insert("password".into(), json!("[redacted]"));
            }
            Value::Object(safe)
        }
        _ => input.clone(),
    }
}

/// The event log key of an agent session.
pub(crate) fn log_key(session_id: i64) -> String {
    format!("agent:{session_id}")
}

/// The most session events one page answers.
pub(crate) const EVENT_PAGE_LIMIT: usize = 500;

/// The session events after `after`, in order, at most one page, and the
/// cursor for the next page (the last seq returned, or `after`).
pub(crate) fn read_events(
    log: &dyn SessionLog,
    session_id: i64,
    after: u64,
) -> Result<(Vec<kition_harness::events::SessionEvent>, u64), String> {
    let items: Vec<_> = log
        .read(&log_key(session_id))?
        .into_iter()
        .filter(|event| event.seq > after)
        .take(EVENT_PAGE_LIMIT)
        .collect();
    let next_after = items.last().map_or(after, |event| event.seq);
    Ok((items, next_after))
}

/// One lock per session, so two turns of a session never interleave their
/// log appends. Each `Agent` owns one: session ids are only unique within
/// its database.
pub type SessionLocks = Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>;

/// The session's lock. Entries nobody holds are pruned on the next lookup.
fn session_lock(locks: &SessionLocks, session_id: i64) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = locks.lock().unwrap_or_else(PoisonError::into_inner);
    locks.retain(|id, lock| *id == session_id || Arc::strong_count(lock) > 1);
    locks.entry(session_id).or_default().clone()
}

/// What a second turn of a session hears while the first is running.
pub const BUSY: &str = "This session is still answering. Wait for the reply or stop it first.";

/// Whether a harness turn of this session is running.
#[cfg(test)]
fn is_busy(locks: &SessionLocks, session_id: i64) -> bool {
    session_lock(locks, session_id).try_lock().is_err()
}

/// Held by one harness turn (or image request) of a session from the
/// request's busy check to its last frame.
pub type TurnGuard = tokio::sync::OwnedMutexGuard<()>;

/// The session's turn guard, or `None` while another turn holds it.
pub fn hold(locks: &SessionLocks, session_id: i64) -> Option<TurnGuard> {
    session_lock(locks, session_id).try_lock_owned().ok()
}

/// Aborts the task when dropped, even if the turn panics.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// One offered tool as a harness tool that runs through `body`, logged and
/// presented as its provider's `shape` says.
fn harness_tool(spec: &ToolSpec, shape: &ToolShape, body: &Body) -> Result<HarnessTool, String> {
    let (name, logged_name, body) = (spec.name.clone(), spec.name.clone(), body.clone());
    let schema = spec
        .input_schema
        .clone()
        .unwrap_or_else(|| json!({ "type": "object" }));
    let generic_log: providers::LogArguments =
        Arc::new(move |args: &Value| logged_arguments(&logged_name, args));
    let builder = define(&spec.name, &spec.description).unchecked_parameters(schema);
    let mut builder = shape
        .apply(builder, Some(generic_log))
        .execute(move |args: Value, cx: ToolContext| body(name.clone(), args, cx))
        .render(|_args, value| {
            vec![ContentBlock::text(
                json!({
                    "name": value["name"], "summary": value["summary"],
                    "output": value["output"], "failed": false,
                })
                .to_string(),
            )]
        });
    if tools::writes(&spec.name) {
        builder = builder.writes();
    }
    builder.build()
}

/// Builds offered tools on `body`. A tool the harness cannot define (an
/// MCP name with a `.`, or longer than 64 characters) is skipped rather
/// than failing the turn.
fn factory(body: Body) -> ToolFactory {
    Arc::new(
        move |spec: &ToolSpec, shape: &ToolShape| match harness_tool(spec, shape, &body) {
            Ok(tool) => Some(tool),
            Err(error) => {
                tracing::warn!(tool = %spec.name, error = %error, "tool not offered on the harness");
                None
            }
        },
    )
}

/// The existing tools, unchanged, as a harness tool factory. Each call
/// still records its row, timeline events, and frames through
/// `tools::execute`.
fn legacy_factory(run: &Arc<Run>, pending: &Pending, notes: &Notes) -> ToolFactory {
    let (run, pending, notes) = (run.clone(), pending.clone(), notes.clone());
    let body: Body = Arc::new(move |name: String, args: Value, cx: ToolContext| {
        let (run, pending, notes) = (run.clone(), pending.clone(), notes.clone());
        Box::pin(async move { legacy_call(&run, &name, args, &cx, &pending, &notes).await })
    });
    factory(body)
}

/// Runs `work` in its own task and waits for it unless the turn is
/// cancelled first; then it keeps running and its result is dropped. An
/// already cancelled turn does not start `work` at all. A panic in `work`
/// is resumed here, as if it had run inline; `None` with the turn not
/// cancelled means the task was interrupted (runtime shutdown).
async fn unless_cancelled<T: Send + 'static>(
    work: impl std::future::Future<Output = T> + Send + 'static,
    cancel: &Cancel,
) -> Option<T> {
    if cancel.is_cancelled() {
        return None;
    }
    let task = tokio::spawn(work);
    tokio::select! {
        biased;
        result = task => match result {
            Ok(value) => Some(value),
            Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
            Err(_) => None,
        },
        () = cancel.cancelled() => None,
    }
}

async fn legacy_call(
    run: &Arc<Run>,
    name: &str,
    args: Value,
    cx: &ToolContext,
    pending: &Pending,
    notes: &Notes,
) -> Result<Value, ToolFailure> {
    // A stopped turn does not wait for a long tool: it finishes in the
    // background (its row, events, and files complete normally) and its
    // result is dropped.
    let (task_run, task_name, raw) = (run.clone(), name.to_owned(), args.to_string());
    let Some(executed) = unless_cancelled(
        async move { tools::execute(&task_run, &task_name, &raw).await },
        &cx.cancel,
    )
    .await
    else {
        return Err(ToolFailure::from(if cx.cancel.is_cancelled() {
            "stopped by the user; the tool may still finish in the background"
        } else {
            "the tool was interrupted"
        }));
    };
    if executed.interrupt == Some("await_shell_approval") {
        let reason = executed.output["reason"]
            .as_str()
            .unwrap_or("Waiting for the user to approve the command")
            .to_owned();
        *pending.lock().unwrap_or_else(PoisonError::into_inner) = Some(executed.output.clone());
        cx.pause.request(reason);
    }
    remember(notes, &cx.call_id, &executed.follow_up);
    if executed.failed {
        // The model sees the failure, then the same record the original loop
        // sends for a failed call.
        let detail = json!({
            "name": executed.name, "summary": executed.summary,
            "output": executed.output, "failed": true,
        });
        let message = if executed.error_message.is_empty() {
            executed.summary
        } else {
            executed.error_message
        };
        return Err(ToolFailure {
            message,
            detail: Some(detail),
        });
    }
    Ok(json!({
        "name": executed.name, "summary": executed.summary,
        "output": executed.output,
    }))
}

/// The system prompt and tools of this turn, assembled from the providers,
/// with the offered tool names appended.
async fn assemble_turn(
    run: &Arc<Run>,
    facts: TurnFacts,
    factory: &ToolFactory,
) -> Result<(String, ToolRegistry), String> {
    let scene = TurnScene {
        pane: run.pane.clone(),
        active_path: run.active_document_path.clone(),
        language: run.language.clone(),
        extra: Value::Null,
    };
    let providers = providers::providers(run, &Arc::new(facts), factory).await;
    let assembly = assemble(&prompts::system_prompt(&run.language), &providers, &scene).await?;
    let names: Vec<String> = assembly
        .tools
        .specs()
        .into_iter()
        .map(|spec| spec.name)
        .collect();
    let system = format!(
        "{}\n\nAvailable tools: {}",
        assembly.system,
        names.join(", ")
    );
    Ok((system, assembly.tools))
}

fn user_content(run: &Run) -> Vec<ContentBlock> {
    let mut content = vec![ContentBlock::text(run.prompt.clone())];
    content.extend(
        run.attachments
            .iter()
            .filter(|attachment| !attachment.image_url.is_empty())
            .map(|attachment| ContentBlock::Image {
                url: attachment.image_url.clone(),
            }),
    );
    content
}

/// Logs a session's earlier conversation the first time it runs on the
/// harness, so turns started without the flag keep their context.
fn seed(log: &dyn SessionLog, key: &str, history: &[(String, String)]) -> Result<(), String> {
    if !log.read(key)?.is_empty() {
        return Ok(());
    }
    for (role, content) in history {
        let body = match role.as_str() {
            "user" => EventBody::UserMessage {
                content: vec![ContentBlock::text(content.clone())],
            },
            "assistant" => EventBody::AssistantMessage {
                content: content.clone(),
                tool_calls: Vec::new(),
                stop_reason: String::new(),
                model: String::new(),
                raw_items: Vec::new(),
            },
            _ => continue,
        };
        log.append(key, body)?;
    }
    Ok(())
}

/// Seeds the harness log of a session whose earlier turns ran on the
/// original loop. A failure is logged and the turn goes on without them.
async fn carry_over(run: &Run, session: &AgentSession, log: &dyn SessionLog, key: &str) {
    let (id, user) = (session.id, session.user_id);
    let history = match run
        .agent
        .with_db(move |conn| store::recent_messages(conn, id, user, 17))
        .await
    {
        Ok(history) => session::previous_conversation(&history, run.trigger_message_id),
        Err(error) => {
            tracing::warn!(session = id, error = %error, "could not load the conversation to carry over");
            return;
        }
    };
    if let Err(error) = seed(log, key, &history) {
        tracing::warn!(session = id, error = %error, "could not carry the conversation into the harness log");
    }
}

/// Runs the turn, assembled from the providers, and finishes it exactly as
/// `session::drive` does.
pub async fn drive(
    run: &Arc<Run>,
    session: AgentSession,
    prompt: &str,
    facts: TurnFacts,
    turn: Option<TurnGuard>,
) {
    // Taken by `session::prepare` and held for the whole turn, through the
    // final frame, so a second turn of this session is refused meanwhile.
    let _turn = turn;
    let pending: Pending = Arc::new(Mutex::new(None));
    let notes = Notes::default();
    let (system, tools) =
        match assemble_turn(run, facts, &legacy_factory(run, &pending, &notes)).await {
            Ok(assembled) => assembled,
            Err(error) => {
                session::fail(run, "Execution failed", "final", &error).await;
                return;
            }
        };
    run.event(
        EventInput::new("prompt.sent", "intent", "completed", "Send model request", "Sent the user goal, session context, and available tools to the model")
            .data(json!({ "model_id": session.model_id, "turn_capabilities": session::turn_capabilities(&tools.specs(), &run.model) })),
    )
    .await;
    let llm = Arc::new(AgentLlm {
        run: run.clone(),
        calls: AtomicUsize::new(0),
        last: Mutex::new(None),
    });
    let key = log_key(run.session_id);
    let log = Arc::new(SqliteLog::new(run.agent.db().clone()));
    carry_over(run, &session, log.as_ref(), &key).await;
    let mut driver = Driver::new(log, llm.clone());
    driver.max_steps = u32::try_from(turn::MAX_TURNS).unwrap_or(16);
    driver.pipeline = pipeline(&notes);
    driver.stop_checks.push(Arc::new(UnresolvedWrites));
    let cancel = Cancel::default();
    let watcher = {
        let (emitter, cancel) = (run.emitter.clone(), cancel.clone());
        // Holds an emitter clone, so it must be aborted when the turn ends
        // (or panics) or the response body would never close.
        AbortOnDrop(tokio::spawn(async move {
            emitter.closed().await;
            cancel.cancel();
        }))
    };
    let input = TurnInput {
        session: key,
        system,
        tools,
        user: user_content(run),
        cancel,
        live: Arc::new(|_: Live| {}),
        model: Some(run.model.model_name.clone()),
    };
    let outcome = driver.run_turn(input).await;
    drop(watcher);
    match outcome {
        Ok(TurnEndReason::Cancelled) | Err(_) if run.emitter.is_closed() => {
            session::set_status(run, "idle").await;
            run.event(EventInput::new(
                "task.failed",
                "final",
                "failed",
                "Execution stopped",
                "The client stopped the request",
            ))
            .await;
        }
        Ok(TurnEndReason::Completed) => {
            let last = llm
                .last
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            let Some((result, streamed)) = last else {
                session::fail(
                    run,
                    "Execution failed",
                    "final",
                    "the model returned no reply",
                )
                .await;
                return;
            };
            let reply = result.content.trim().to_owned();
            session::finish(run, session, prompt, reply, streamed, &result).await;
        }
        Ok(TurnEndReason::AwaitingApproval) => {
            let output = pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take()
                .unwrap_or_default();
            session::await_approval(run, session, output).await;
        }
        Ok(TurnEndReason::StepLimit) => {
            let message = format!(
                "agent tool loop exceeded {} turns; narrow the task or clarify the next step",
                turn::MAX_TURNS
            );
            session::fail(run, "Execution failed", "final", &message).await;
        }
        Ok(TurnEndReason::Cancelled | TurnEndReason::Failed) => {
            session::fail(
                run,
                "Execution failed",
                "final",
                "the turn ended unexpectedly",
            )
            .await;
        }
        Err(error) => session::fail(run, "Execution failed", "final", &error).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The specs as harness tools on `body`, as `factory` builds them.
    fn registry(specs: &[ToolSpec], body: &Body) -> ToolRegistry {
        let build = factory(body.clone());
        let mut registry = ToolRegistry::default();
        for tool in specs
            .iter()
            .filter_map(|spec| build(spec, &ToolShape::default()))
        {
            registry
                .register(tool)
                .unwrap_or_else(|error| panic!("{error}"));
        }
        registry
    }

    #[test]
    fn the_harness_turn_names_no_pane_or_kit() {
        let source = include_str!("harness_turn.rs");
        let turn = source
            .split("\n#[cfg(test)]\nmod tests")
            .next()
            .unwrap_or_default();
        assert!(turn.len() < source.len());
        for needle in [
            "\"document\"",
            "\"table\"",
            "\"workflow\"",
            "\"gallery\"",
            "\"whiteboard\"",
            "\"design\"",
            "photo_",
            "kit.",
            "_propose_patch",
        ] {
            assert!(!turn.contains(needle), "harness_turn.rs names {needle}");
        }
    }

    #[test]
    fn tools_the_harness_cannot_name_are_skipped() {
        let spec = |name: &str| ToolSpec {
            name: name.into(),
            description: "d".into(),
            input_schema: None,
        };
        let body: Body = Arc::new(|_name: String, _args: Value, _cx: ToolContext| {
            Box::pin(async { Ok(Value::Null) })
        });
        let registry = registry(&[spec("bad.name"), spec("document_read")], &body);
        assert_eq!(registry.len(), 1);
        assert!(registry.get("document_read").is_some());
        assert!(registry.get("bad.name").is_none());
    }

    #[tokio::test]
    async fn follow_up_text_reaches_the_next_model_request() {
        use kition_harness::events::EventBody;
        use kition_harness::llm::LlmReply;
        use kition_harness::log::{MemoryLog, SessionLog};
        use kition_harness::testing::{ScriptedLlm, call};

        let notes = Notes::default();
        let stored = notes.clone();
        let body: Body = Arc::new(move |_name: String, _args: Value, cx: ToolContext| {
            let stored = stored.clone();
            Box::pin(async move {
                remember(
                    &stored,
                    &cx.call_id,
                    &[MessagePart {
                        kind: "text".into(),
                        text: "[image_search system follow-up] Do not call image_search again."
                            .into(),
                        ..MessagePart::default()
                    }],
                );
                Ok(json!({ "name": "image_search", "summary": "found", "output": {} }))
            })
        });
        let spec = ToolSpec {
            name: "image_search".into(),
            description: "d".into(),
            input_schema: None,
        };
        let llm = Arc::new(ScriptedLlm::new(vec![
            LlmReply::calls(vec![call("c1", "image_search", json!({ "query": "cats" }))]),
            LlmReply::text("done"),
        ]));
        let log = Arc::new(MemoryLog::default());
        let mut driver = Driver::new(log.clone(), llm.clone());
        driver.pipeline = pipeline(&notes);
        let reason = driver
            .run_turn(TurnInput {
                session: "s".into(),
                system: "sys".into(),
                tools: registry(&[spec], &body),
                user: vec![ContentBlock::text("find cats")],
                cancel: Cancel::default(),
                live: Arc::new(|_: Live| {}),
                model: None,
            })
            .await
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(reason, TurnEndReason::Completed);
        let requests = llm.requests();
        let tool = requests[1]
            .messages
            .iter()
            .find(|message| message.role == "tool")
            .map(|message| message.content.clone())
            .unwrap_or_default();
        assert!(tool.contains("\"summary\":\"found\""), "{tool}");
        assert!(tool.contains("Do not call image_search again"), "{tool}");
        let events = log.read("s").unwrap_or_else(|error| panic!("{error}"));
        let value = events.iter().find_map(|event| match &event.body {
            EventBody::ToolResult { value, .. } => Some(value.clone()),
            _ => None,
        });
        assert_eq!(
            value,
            Some(json!({ "name": "image_search", "summary": "found", "output": {} }))
        );
    }

    #[test]
    fn logged_arguments_mirror_the_persisted_tool_input() {
        assert_eq!(
            logged_arguments(
                "configure_smtp_connection",
                &json!({ "host": "smtp.example.com", "password": "fake-secret" })
            ),
            json!({ "host": "smtp.example.com", "password": "[redacted]" })
        );
        for name in ["source_search", "source_file_search"] {
            assert_eq!(
                logged_arguments(name, &json!({ "query": "hello", "limit": 3 })),
                json!({ "query_chars": 5, "limit": 3 })
            );
        }
        let args = json!({ "path": "a.md", "password": "kept" });
        assert_eq!(logged_arguments("document_read", &args), args);
    }

    #[test]
    fn session_events_are_paged_after_a_cursor() {
        use kition_harness::log::{MemoryLog, SessionLog};

        let log = MemoryLog::default();
        for turn in 0..(EVENT_PAGE_LIMIT as u32 + 3) {
            log.append(&log_key(4), EventBody::TurnStart { turn })
                .unwrap_or_else(|error| panic!("{error}"));
        }
        log.append(&log_key(5), EventBody::TurnStart { turn: 1 })
            .unwrap_or_else(|error| panic!("{error}"));

        let (first, next) = read_events(&log, 4, 0).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(first.len(), EVENT_PAGE_LIMIT);
        assert_eq!(first.first().map(|event| event.seq), Some(1));
        assert_eq!(next, EVENT_PAGE_LIMIT as u64);
        let (rest, last) = read_events(&log, 4, next).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            rest.iter().map(|event| event.seq).collect::<Vec<_>>(),
            [501, 502, 503]
        );
        let (empty, same) = read_events(&log, 4, last).unwrap_or_else(|error| panic!("{error}"));
        assert!(empty.is_empty());
        assert_eq!(same, last);
        let (missing, cursor) = read_events(&log, 6, 0).unwrap_or_else(|error| panic!("{error}"));
        assert!(missing.is_empty());
        assert_eq!(cursor, 0);
    }

    #[test]
    fn an_empty_log_is_seeded_with_the_previous_conversation() {
        use kition_harness::log::{MemoryLog, SessionLog};

        let log = MemoryLog::default();
        let history = vec![
            ("user".to_owned(), "first".to_owned()),
            ("assistant".to_owned(), "reply".to_owned()),
            ("tool".to_owned(), "ignored".to_owned()),
        ];
        seed(&log, "agent:7", &history).unwrap_or_else(|error| panic!("{error}"));
        let kinds: Vec<&str> = log
            .read("agent:7")
            .unwrap_or_else(|error| panic!("{error}"))
            .iter()
            .map(|e| e.body.kind())
            .collect();
        assert_eq!(kinds, ["user/message", "assistant/message"]);
        seed(&log, "agent:7", &history).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            log.read("agent:7")
                .unwrap_or_else(|error| panic!("{error}"))
                .len(),
            2,
            "a non-empty log is left alone"
        );
    }

    #[tokio::test]
    async fn a_running_turn_marks_its_session_busy() {
        let locks = SessionLocks::default();
        assert!(!is_busy(&locks, 9001));
        let held = session_lock(&locks, 9001).lock_owned().await;
        assert!(is_busy(&locks, 9001));
        assert!(
            !is_busy(&SessionLocks::default(), 9001),
            "another agent's session 9001 is a different session"
        );
        drop(held);
        assert!(!is_busy(&locks, 9001));
    }

    #[tokio::test]
    async fn a_cancelled_wait_returns_early_and_the_work_finishes_anyway() {
        let cancel = Cancel::default();
        let finished = Arc::new(AtomicBool::new(false));
        let done = finished.clone();
        let work = async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            done.store(true, Ordering::SeqCst);
            7
        };
        let stopper = cancel.clone();
        tokio::spawn(async move { stopper.cancel() });
        assert_eq!(unless_cancelled(work, &cancel).await, None);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(finished.load(Ordering::SeqCst));
        assert_eq!(
            unless_cancelled(async { 8 }, &Cancel::default()).await,
            Some(8)
        );
    }

    #[tokio::test]
    async fn a_held_turn_guard_keeps_its_session_busy_until_dropped() {
        let locks = SessionLocks::default();
        let guard = hold(&locks, 5).unwrap_or_else(|| panic!("session 5 is free"));
        assert!(is_busy(&locks, 5));
        assert!(hold(&locks, 5).is_none(), "a second turn is refused");
        assert!(!is_busy(&locks, 6));
        drop(guard);
        assert!(!is_busy(&locks, 5));
        assert!(hold(&locks, 5).is_some());
    }

    #[tokio::test]
    async fn an_already_cancelled_turn_does_not_start_the_tool() {
        let cancel = Cancel::default();
        cancel.cancel();
        let started = Arc::new(AtomicBool::new(false));
        let flag = started.clone();
        let work = async move {
            flag.store(true, Ordering::SeqCst);
            1
        };
        assert_eq!(unless_cancelled(work, &cancel).await, None);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!started.load(Ordering::SeqCst));
    }

    #[test]
    fn turns_of_one_session_share_a_lock() {
        let locks = SessionLocks::default();
        let first = session_lock(&locks, 7);
        let again = session_lock(&locks, 7);
        let other = session_lock(&locks, 8);
        assert!(Arc::ptr_eq(&first, &again));
        assert!(!Arc::ptr_eq(&first, &other));
    }
}
