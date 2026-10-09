//! The native tool loop: call the model, run the tools it asks for, feed
//! the results back, and repeat until it answers.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use kition_ai::engine::{
    ChatResult, Message, RetryEvent, RetryHandler, StreamEvent, StreamHandler, ToolSpec,
};
use serde_json::{Value, json};

use crate::run::{EventInput, Run};
use crate::stream::{Frame, value};
use crate::tools::{self, images};

pub const MAX_TURNS: usize = 16;

/// How a loop ended.
pub enum Outcome {
    Reply {
        content: String,
        streamed: bool,
        result: Box<ChatResult>,
    },
    /// A command is waiting for the user's approval.
    AwaitingApproval(Value),
}

fn retry_handler(run: &Arc<Run>, turn: usize) -> RetryHandler {
    let run = run.clone();
    Arc::new(move |retry: RetryEvent| {
        let run = run.clone();
        tokio::spawn(async move {
            run.event(
                EventInput::new(
                    "model.reconnecting",
                    "model",
                    "running",
                    "Reconnecting to AI backend",
                    format!("Reconnecting... {}/{}", retry.attempt, retry.max_retries),
                )
                .data(json!({
                    "turn": turn, "attempt": retry.attempt, "max_retries": retry.max_retries,
                    "delay_ms": retry.delay.as_millis() as u64, "reason": retry.reason,
                })),
            )
            .await;
        });
    })
}

fn stream_handler(run: &Arc<Run>, turn: usize, streamed: Arc<AtomicBool>) -> StreamHandler {
    let emitter = run.emitter.clone();
    let model = run.model.model_name.clone();
    Arc::new(move |event: StreamEvent| {
        let frame = match event.kind {
            "delta" if !event.delta.is_empty() => {
                streamed.store(true, Ordering::SeqCst);
                Frame {
                    delta: event.delta,
                    ..Frame::new("model_delta")
                }
                .extra("turn", turn)
                .extra("model", &model)
            }
            "tool_call_delta" => Frame::new("model_tool_call_delta")
                .extra("turn", turn)
                .extra("tool_call_index", event.tool_call_index)
                .extra("tool_call_id", &event.tool_call_id)
                .extra("tool_name", &event.tool_name)
                .extra("arguments_delta", &event.tool_arguments_delta)
                .extra("arguments", &event.tool_arguments)
                .extra("model", &model),
            "tool_call_ready" => Frame::new("model_tool_call_ready")
                .extra("turn", turn)
                .extra("tool_call_index", event.tool_call_index)
                .extra("tool_call_id", &event.tool_call_id)
                .extra("tool_name", &event.tool_name)
                .extra("arguments", &event.tool_arguments)
                .extra("model", &model),
            _ => return,
        };
        emitter.send(&frame);
    })
}

/// Records searches the model ran with its hosted web search tool.
async fn record_hosted_searches(run: &Run, result: &ChatResult) {
    for search in &result.hosted_web_search_calls {
        let mut input = json!({ "query": search.query, "hosted": true });
        if let Some(action) = &search.action {
            input["action"] = json!(action);
        }
        let Some(mut call) = tools::start_tool_call(run, "web_search", input).await else {
            continue;
        };
        let output = json!({
            "provider": result.wire_api, "hosted": true, "status": search.status,
            "query": search.query, "action": search.action,
        });
        tools::complete_tool_call(run, &mut call, output.clone()).await;
        let message = if search.query.is_empty() {
            "Used hosted web search".to_owned()
        } else {
            search.query.clone()
        };
        run.event(
            EventInput::new(
                "tool.completed",
                "research",
                "completed",
                "Web search",
                message,
            )
            .tool_call(Some(call.id))
            .data(json!({ "tool_name": "web_search", "output": output })),
        )
        .await;
        run.send(&Frame {
            tool_call: value(&call),
            ..Frame::new("tool_call")
        });
    }
}

fn user_parts(parts: Vec<kition_ai::engine::MessagePart>) -> Message {
    Message {
        role: "user".into(),
        parts,
        ..Message::default()
    }
}

pub async fn run_loop(
    run: &Arc<Run>,
    mut messages: Vec<Message>,
    specs: Vec<ToolSpec>,
) -> Result<Outcome, String> {
    let engine = run.agent.engine().clone();
    let mut unresolved_write: Option<(String, String)> = None;
    for index in 0..MAX_TURNS {
        let turn = index + 1;
        run.event(
            EventInput::new("model.turn.started", "model", "running", "Call AI backend", format!("Requesting model turn {turn}"))
                .data(json!({ "turn": turn, "model": run.model.model_name, "wire_api": run.model.wire_api })),
        )
        .await;
        let streamed = Arc::new(AtomicBool::new(false));
        let call = engine.chat_with_retry(
            &messages,
            &specs,
            "",
            &run.model,
            Some(stream_handler(run, turn, streamed.clone())),
            Some(retry_handler(run, turn)),
        );
        let result = tokio::select! {
            result = call => result.map_err(|error| error.to_string())?,
            () = run.emitter.closed() => return Err("the client disconnected".into()),
        };
        let content = result.content.trim().to_owned();
        record_hosted_searches(run, &result).await;
        let hosted_follow_up =
            images::save_hosted_images(run, &result.hosted_image_generation_calls).await;
        let mut calls = result.tool_calls.clone();
        for (position, call) in calls.iter_mut().enumerate() {
            call.id = call.id.trim().to_owned();
            call.name = call.name.trim().to_owned();
            if call.id.is_empty() {
                call.id = format!("ow_tool_{}_{turn}_{position}", kition_core::now_millis());
            }
            if call.input.trim().is_empty() {
                call.input = "{}".into();
            }
        }
        run.event(
            EventInput::new(
                "model.turn.completed",
                "model",
                "completed",
                "AI backend returned",
                format!("Turn {turn} completed with {} tool calls", calls.len()),
            )
            .data(json!({
                "turn": turn, "content_chars": content.chars().count(),
                "tool_calls": calls.len(), "stop_reason": result.stop_reason,
            })),
        )
        .await;
        if calls.is_empty() && hosted_follow_up.is_empty() {
            if let Some((name, message)) = unresolved_write {
                return Err(format!(
                    "agent did not recover from failed workspace tool {name}: {message}"
                ));
            }
            if content.is_empty() {
                return Err("agent model returned no content and no tool calls".into());
            }
            return Ok(Outcome::Reply {
                content,
                streamed: streamed.load(Ordering::SeqCst),
                result: Box::new(result),
            });
        }
        messages.push(Message {
            role: "assistant".into(),
            content,
            tool_calls: calls.clone(),
            raw_items: result.response_items.clone(),
            ..Message::default()
        });
        for call in &calls {
            let executed = tools::execute(run, &call.name, &call.input).await;
            if executed.interrupt == Some("await_shell_approval") {
                return Ok(Outcome::AwaitingApproval(executed.output));
            }
            if tools::writes(&call.name) {
                if executed.failed {
                    let message = if executed.error_message.is_empty() {
                        executed.summary.clone()
                    } else {
                        executed.error_message.clone()
                    };
                    unresolved_write = Some((call.name.clone(), message));
                } else {
                    unresolved_write = None;
                }
            }
            messages.push(Message {
                role: "tool".into(),
                name: call.name.clone(),
                tool_call_id: call.id.clone(),
                content: json!({
                    "name": executed.name, "summary": executed.summary,
                    "output": executed.output, "failed": executed.failed,
                })
                .to_string(),
                ..Message::default()
            });
            if !executed.follow_up.is_empty() {
                messages.push(user_parts(executed.follow_up.clone()));
            }
            if executed.failed {
                let failure = if executed.error_message.is_empty() {
                    &executed.summary
                } else {
                    &executed.error_message
                };
                messages.push(Message::new(
                    "user",
                    [
                        "[tool recovery required] The previous tool call failed and the user's task is not complete.".to_owned(),
                        format!("Failed tool: {}", call.name),
                        format!("Failure: {failure}"),
                        "Inspect the latest state and recover now. For a failed apply_patch, reread the target and retry with a smaller exact patch or use document_write for a whole-document rewrite. Do not return an empty response or claim completion while the write is unresolved.".to_owned(),
                    ]
                    .join("\n"),
                ));
            }
        }
        if !hosted_follow_up.is_empty() {
            messages.push(user_parts(hosted_follow_up));
        }
    }
    Err(format!(
        "agent tool loop exceeded {MAX_TURNS} turns; narrow the task or clarify the next step"
    ))
}
