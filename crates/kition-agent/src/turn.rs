//! One agent turn on `kition-harness`: the providers assemble the prompt
//! and tools, the driver calls the model and runs the tools it asks for
//! until it answers, and the session event log is the source of model
//! history.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use futures::future::BoxFuture;
use kition_ai::engine::{MessagePart, ToolSpec};
use kition_harness::cancel::Cancel;
use kition_harness::driver::{Driver, Live, LiveSink, TurnInput, fail_turn};
use kition_harness::events::{ContentBlock, EventBody, MessageSource, TurnEndReason};
use kition_harness::log::SqliteLog;
use kition_harness::policy::{CallInfo, Pipeline, Policy};
use kition_harness::provider::{TurnScene, assemble};
use kition_harness::stop::{RecoveryPrompt, UnresolvedWrites};
use kition_harness::tool::{Settled, ToolContext, ToolDef, ToolFailure, ToolRegistry, define};
use serde_json::{Value, json};

use crate::model::{AgentLlm, blocks};
use crate::providers::{self, ToolFactory, ToolShape, TurnFacts};
use crate::run::{EventInput, Run, TurnGuard};
use crate::store::AgentSession;
use crate::{prompts, session, tools};

/// The most model calls one turn makes.
const MAX_STEPS: u32 = 16;

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

/// Aborts the task when dropped, even if the turn panics.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// One offered tool, run through `body`, logged and presented as its
/// provider's `shape` says.
fn tool(spec: &ToolSpec, shape: &ToolShape, body: &Body) -> Result<ToolDef, String> {
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
        move |spec: &ToolSpec, shape: &ToolShape| match tool(spec, shape, &body) {
            Ok(tool) => Some(tool),
            Err(error) => {
                tracing::warn!(tool = %spec.name, error = %error, "tool not offered");
                None
            }
        },
    )
}

/// The agent's tools as a tool factory. Each call records its row,
/// timeline events, and frames through `tools::execute`.
fn tools_factory(run: &Arc<Run>, pending: &Pending, notes: &Notes) -> ToolFactory {
    let (run, pending, notes) = (run.clone(), pending.clone(), notes.clone());
    let body: Body = Arc::new(move |name: String, args: Value, cx: ToolContext| {
        let (run, pending, notes) = (run.clone(), pending.clone(), notes.clone());
        Box::pin(async move { call_tool(&run, &name, args, &cx, &pending, &notes).await })
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

async fn call_tool(
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
    if !executed.deliverables.is_empty() {
        // The driver fills in this turn and call.
        cx.emit.push(EventBody::DeliverablesPresented {
            turn: cx.turn,
            call_id: cx.call_id.clone(),
            files: executed.deliverables,
        });
    }
    if let Some(todos) = executed.todos {
        cx.emit.push(EventBody::TodoWrite { todos });
    }
    if executed.failed {
        // The model sees the failure, then the call's record.
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

/// The offered tools and whether hosted web search is among them, for the
/// `prompt.sent` event. `hosted_search` says whether the model supports it.
fn turn_capabilities(tool_names: &[String], hosted_search: bool) -> Value {
    let mut names: Vec<&str> = tool_names.iter().map(String::as_str).collect();
    names.sort_unstable();
    names.dedup();
    let search = names.contains(&"web_search");
    let reason = if search {
        "available"
    } else if hosted_search {
        "not_exposed"
    } else {
        "provider_unsupported"
    };
    json!({
        "available_tools": names,
        "hosted_web_search": { "available": search, "reason": reason },
    })
}

/// Runs the turn, assembled from the providers, and finishes it.
pub async fn drive(
    run: &Arc<Run>,
    session: AgentSession,
    prompt: &str,
    facts: TurnFacts,
    turn: TurnGuard,
) {
    // Taken by `session::prepare` and held for the whole turn, through the
    // final frame, so a second turn of this session is refused meanwhile.
    let _turn = turn;
    let pending: Pending = Arc::new(Mutex::new(None));
    let notes = Notes::default();
    let hosted_search = facts.hosted_web_search;
    let (system, tools) =
        match assemble_turn(run, facts, &tools_factory(run, &pending, &notes)).await {
            Ok(assembled) => assembled,
            Err(error) => {
                let (log, key) = (
                    SqliteLog::new(run.agent.db().clone()),
                    crate::log::log_key(run.session_id),
                );
                let live: LiveSink = Arc::new(|_: Live| {});
                if let Err(log_error) = fail_turn(&log, &key, &live, &error) {
                    tracing::warn!(error = %log_error, "could not log the failed turn");
                }
                session::fail(run, "Execution failed", "final", &error).await;
                return;
            }
        };
    let names: Vec<String> = tools.specs().into_iter().map(|spec| spec.name).collect();
    run.event(
        EventInput::new("prompt.sent", "intent", "completed", "Send model request", "Sent the user goal, session context, and available tools to the model")
            .data(json!({ "model_id": session.model_id, "turn_capabilities": turn_capabilities(&names, hosted_search) })),
    )
    .await;
    let llm = Arc::new(AgentLlm::new(run));
    let key = crate::log::log_key(run.session_id);
    let log = Arc::new(SqliteLog::new(run.agent.db().clone()));
    let mut driver = Driver::new(log, llm.clone());
    driver.max_steps = MAX_STEPS;
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
        preset: Some(run.execution_mode.clone()),
        source: MessageSource::new(run.source),
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
            let Some((result, streamed)) = llm.take_last() else {
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
                "the turn exceeded {MAX_STEPS} model steps; narrow the task or clarify the next step"
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
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    /// The specs as tools on `body`, as `factory` builds them.
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
    fn the_turn_names_no_pane_or_kit() {
        let source = include_str!("turn.rs");
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
            assert!(!turn.contains(needle), "turn.rs names {needle}");
        }
    }

    #[test]
    fn tools_with_names_the_harness_rejects_are_skipped() {
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
                preset: None,
                source: MessageSource::user(),
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
    fn capabilities_say_why_web_search_is_missing() {
        let caps = turn_capabilities(&["web_search".to_owned(), "web_search".to_owned()], false);
        assert_eq!(caps["hosted_web_search"]["available"], true);
        assert_eq!(caps["available_tools"], json!(["web_search"]));
        let caps = turn_capabilities(&["document_read".to_owned()], true);
        assert_eq!(caps["hosted_web_search"]["reason"], "not_exposed");
        let caps = turn_capabilities(&[], false);
        assert_eq!(caps["hosted_web_search"]["reason"], "provider_unsupported");
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
}
