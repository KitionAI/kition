//! One agent turn on `kition-harness`: the same prompts, tools, stream
//! frames, and timeline as `turn.rs`, with the session event log as the
//! source of model history. Selected by `KITION_AGENT_HARNESS=1`.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures::future::BoxFuture;
use kition_ai::engine::{ChatResult, MessagePart, ToolSpec};
use kition_harness::cancel::Cancel;
use kition_harness::driver::{Driver, Live, TurnInput};
use kition_harness::events::{ContentBlock, TurnEndReason};
use kition_harness::llm::{ChunkSink, Llm, LlmReply, LlmRequest, normalize_calls};
use kition_harness::log::SqliteLog;
use kition_harness::policy::Pipeline;
use kition_harness::stop::{RecoveryPrompt, UnresolvedWrites};
use kition_harness::tool::{ToolContext, ToolFailure, ToolRegistry, define};
use serde_json::{Value, json};

use crate::run::{EventInput, Run};
use crate::session;
use crate::store::{self, AgentArtifact, AgentSession};
use crate::tools::{self, images};
use crate::{attachments, prompts, turn};

/// The output of the call that paused the turn, for the approval frames.
type Pending = Arc<Mutex<Option<Value>>>;

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

/// The offered tools as harness tools that all run through `body`. A tool
/// the harness cannot register (an MCP name with a `.`, or longer than 64
/// characters) is skipped rather than failing the turn.
fn registry(specs: &[ToolSpec], body: &Body) -> ToolRegistry {
    let mut registry = ToolRegistry::default();
    for spec in specs {
        let (name, body) = (spec.name.clone(), body.clone());
        let schema = spec
            .input_schema
            .clone()
            .unwrap_or_else(|| json!({ "type": "object" }));
        let mut builder = define(&spec.name, &spec.description)
            .unchecked_parameters(schema)
            .execute(move |args: Value, cx: ToolContext| body(name.clone(), args, cx))
            .render(|_args, value| {
                let mut content = vec![ContentBlock::text(
                    json!({
                        "name": value["name"], "summary": value["summary"],
                        "output": value["output"], "failed": false,
                    })
                    .to_string(),
                )];
                for url in value["images"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    content.push(ContentBlock::Image {
                        url: url.to_owned(),
                    });
                }
                content
            });
        if tools::writes(&spec.name) {
            builder = builder.writes();
        }
        if let Err(error) = builder.build().and_then(|tool| registry.register(tool)) {
            tracing::warn!(tool = %spec.name, error = %error, "tool not offered on the harness");
        }
    }
    registry
}

/// The existing tools, unchanged, as harness tools. Each call still records
/// its row, timeline events, and frames through `tools::execute`.
fn legacy_tools(run: &Arc<Run>, specs: &[ToolSpec], pending: &Pending) -> ToolRegistry {
    let (run, pending) = (run.clone(), pending.clone());
    let body: Body = Arc::new(move |name: String, args: Value, cx: ToolContext| {
        let (run, pending) = (run.clone(), pending.clone());
        Box::pin(async move { legacy_call(&run, &name, args, &cx, &pending).await })
    });
    registry(specs, &body)
}

async fn legacy_call(
    run: &Arc<Run>,
    name: &str,
    args: Value,
    cx: &ToolContext,
    pending: &Pending,
) -> Result<Value, ToolFailure> {
    let executed = tools::execute(run, name, &args.to_string()).await;
    if executed.interrupt == Some("await_shell_approval") {
        let reason = executed.output["reason"]
            .as_str()
            .unwrap_or("Waiting for the user to approve the command")
            .to_owned();
        *pending.lock().unwrap_or_else(PoisonError::into_inner) = Some(executed.output.clone());
        cx.pause.request(reason);
    }
    let images: Vec<&str> = executed
        .follow_up
        .iter()
        .filter(|part| part.kind == "image_url")
        .map(|part| part.image_url.as_str())
        .collect();
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
        "output": executed.output, "images": images,
    }))
}

/// The per-turn system prompt: the same blocks `session::build_messages`
/// sends as system messages, joined.
async fn system_prompt(run: &Run, session: &AgentSession, context: &str) -> String {
    let (id, user) = (session.id, session.user_id);
    let mut images: Vec<AgentArtifact> = run
        .agent
        .with_db(move |conn| store::recent_artifacts(conn, id, user, 40))
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a.kind == "image" || a.mime_type.starts_with("image/"))
        .take(8)
        .collect();
    images.reverse();
    let mut blocks = vec![prompts::system_prompt(&run.language)];
    if !run.active_document_path.is_empty() {
        blocks.push(prompts::linked_document(&run.active_document_path));
    }
    blocks.push(attachments::prompt_block(&run.attachments));
    blocks.push(prompts::recent_images(&images));
    blocks.push(context.to_owned());
    blocks.retain(|block| !block.trim().is_empty());
    blocks.join("\n\n")
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

/// Runs the turn and finishes it exactly as `session::drive` does.
pub async fn drive(
    run: &Arc<Run>,
    session: AgentSession,
    prompt: &str,
    context: &str,
    specs: Vec<ToolSpec>,
) {
    let pending: Pending = Arc::new(Mutex::new(None));
    let tools = legacy_tools(run, &specs, &pending);
    let llm = Arc::new(AgentLlm {
        run: run.clone(),
        calls: AtomicUsize::new(0),
        last: Mutex::new(None),
    });
    let mut driver = Driver::new(
        Arc::new(SqliteLog::new(run.agent.db().clone())),
        llm.clone(),
    );
    driver.max_steps = u32::try_from(turn::MAX_TURNS).unwrap_or(16);
    driver.pipeline = Pipeline::default().with(RecoveryPrompt);
    driver.stop_checks.push(Arc::new(UnresolvedWrites));
    let cancel = Cancel::default();
    let watcher = {
        let (emitter, cancel) = (run.emitter.clone(), cancel.clone());
        // Holds an emitter clone, so it must be aborted when the turn ends or
        // the response body would never close.
        tokio::spawn(async move {
            emitter.closed().await;
            cancel.cancel();
        })
    };
    let input = TurnInput {
        session: format!("agent:{}", run.session_id),
        system: system_prompt(run, &session, context).await,
        tools,
        user: user_content(run),
        cancel,
        live: Arc::new(|_: Live| {}),
        model: Some(run.model.model_name.clone()),
    };
    let outcome = driver.run_turn(input).await;
    watcher.abort();
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
}
