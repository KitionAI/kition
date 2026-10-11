//! `POST /agent/sessions/{id}/messages/stream`: one streamed agent turn.

use std::sync::{Arc, Mutex};

use axum::response::Response;
use kition_ai::engine::RuntimeModel;
use kition_core::{AppError, AppResult, now_millis};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::catalog::{self, SkillDef};
use crate::providers::TurnFacts;
use crate::run::{Agent, BUSY, EventInput, Run, TurnGuard, truncate_chars};
use crate::sources::{self, LocalSourceInput};
use crate::store::{self, AgentSession};
use crate::stream::{Emitter, Frame, value};
use crate::tools::{canvas, documents, exec, images};
use crate::{attachments, log, prompts, table_plan, turn};

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ShellApprovalInput {
    pub tool_call_id: i64,
    pub decision: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct StreamRequest {
    pub content: String,
    pub prompt_context: String,
    pub attachment_paths: Vec<String>,
    pub local_sources: Vec<LocalSourceInput>,
    pub active_document_path: String,
    pub active_data_document_id: i64,
    pub active_data_table_id: i64,
    pub active_workflow_id: String,
    pub pane_context: String,
    pub execution_mode: String,
    pub task_mode: String,
    pub image_generation_intent: Option<Value>,
    pub whiteboard_context: Option<Value>,
    pub design_context: Option<Value>,
    pub table_plan_context: Option<Value>,
    pub shell_approval: Option<ShellApprovalInput>,
    pub model_id: String,
    pub runtime_model: Option<RuntimeModel>,
    pub hide_user_message: bool,
    pub language: String,
}

fn pane(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        pane @ ("workflow" | "table" | "gallery" | "whiteboard" | "design") => pane.to_owned(),
        _ => "document".to_owned(),
    }
}

fn execution_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        mode @ ("research" | "preview") => mode.to_owned(),
        _ => "apply".to_owned(),
    }
}

fn task_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "table" => "table".to_owned(),
        _ => "auto".to_owned(),
    }
}

/// Loads the caller's live session.
pub async fn owned_session(agent: &Agent, id: i64, user_id: i64) -> AppResult<AgentSession> {
    agent
        .with_db(move |conn| store::find_session(conn, id, user_id))
        .await?
        .ok_or_else(|| AppError::not_found("Agent session not found"))
}

fn session_table(session: &AgentSession) -> (i64, i64) {
    let id = |key: &str| {
        session
            .extra_data
            .get(key)
            .and_then(Value::as_i64)
            .unwrap_or(0)
    };
    (id("active_data_document_id"), id("active_data_table_id"))
}

/// Everything a turn needs that can be checked before streaming starts.
pub struct Prepared {
    request: StreamRequest,
    session: AgentSession,
    content: String,
    image_intent: Option<images::ImageIntent>,
    approval: Option<exec::Approval>,
    local_sources: Vec<sources::LocalSource>,
    /// The session's turn guard, taken by the busy check and held until
    /// the turn's last frame.
    turn: TurnGuard,
}

/// Validates the request; failures become ordinary error responses.
pub async fn prepare(
    agent: &Agent,
    user_id: i64,
    session_id: i64,
    mut request: StreamRequest,
) -> AppResult<Prepared> {
    let session = owned_session(agent, session_id, user_id).await?;
    // Taken here, not when the turn starts, so no second request can slip
    // in between the check and the turn. Image requests hold it too.
    let turn = agent
        .hold_turn(session_id)
        .ok_or_else(|| AppError::conflict(BUSY))?;
    let image_intent = match &request.image_generation_intent {
        Some(raw) => {
            if request.hide_user_message {
                return Err(AppError::bad_request(
                    "image generation requires a visible user message",
                ));
            }
            Some(images::parse_intent(raw).map_err(AppError::bad_request)?)
        }
        None => None,
    };
    let pane_name = pane(&request.pane_context);
    if let Some(context) = &request.whiteboard_context {
        if pane_name != "whiteboard" {
            return Err(AppError::bad_request(
                "Whiteboard context requires pane_context=whiteboard",
            ));
        }
        canvas::validate_whiteboard_context(context).map_err(AppError::bad_request)?;
    }
    if let Some(context) = &request.design_context {
        if pane_name != "design" {
            return Err(AppError::bad_request(
                "design context requires pane_context=design",
            ));
        }
        canvas::validate_design_context(context).map_err(AppError::bad_request)?;
    }
    let content = request.content.trim().to_owned();
    if content.is_empty() {
        return Err(AppError::bad_request("Message content cannot be empty"));
    }
    let approval = match &request.shell_approval {
        Some(input) => Some(
            exec::resolve_approval(
                agent,
                user_id,
                session.id,
                input.tool_call_id,
                input.decision.trim(),
            )
            .await
            .map_err(AppError::bad_request)?,
        ),
        None => None,
    };
    let local_sources =
        sources::normalize(&request.local_sources).map_err(AppError::bad_request)?;
    let (document_id, table_id) = session_table(&session);
    if request.active_data_document_id == 0 {
        request.active_data_document_id = document_id;
    }
    if request.active_data_table_id == 0 {
        request.active_data_table_id = table_id;
    }
    Ok(Prepared {
        request,
        session,
        content,
        image_intent,
        approval,
        local_sources,
        turn,
    })
}

/// Starts the turn and returns the streaming response.
pub async fn start(agent: Agent, user_id: i64, prepared: Prepared) -> Response {
    let (emitter, response) = Emitter::channel();
    tokio::spawn(async move { drive(agent, user_id, prepared, emitter).await });
    response
}

async fn latest_editable_document(agent: &Agent, session: &AgentSession) -> String {
    let (id, user) = (session.id, session.user_id);
    agent
        .with_db(move |conn| store::recent_artifacts(conn, id, user, 20))
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|artifact| documents::is_editable_document(&artifact.path))
        .map(|artifact| artifact.path)
        .unwrap_or_default()
}

pub(crate) async fn set_status(run: &Run, status: &'static str) {
    let id = run.session_id;
    let _ = run
        .agent
        .with_db(move |conn| store::set_session_status(conn, id, status))
        .await;
}

pub(crate) async fn fail(run: &Run, label: &str, stage: &str, message: &str) {
    set_status(run, "failed").await;
    run.event(EventInput::new(
        "task.failed",
        stage,
        "failed",
        label,
        message,
    ))
    .await;
    run.send(&Frame::error(message));
}

async fn drive(agent: Agent, user_id: i64, prepared: Prepared, emitter: Emitter) {
    let Prepared {
        request,
        mut session,
        content,
        image_intent,
        approval,
        local_sources,
        turn,
    } = prepared;
    let mut active_document = request.active_document_path.trim().to_owned();
    if active_document.is_empty() {
        active_document = session.active_document_path.trim().to_owned();
    }
    if active_document.is_empty() {
        active_document = latest_editable_document(&agent, &session).await;
    }
    session.active_document_path = active_document.clone();
    emitter.send(&Frame {
        session: value(&session),
        ..Frame::new("started")
    });
    let parts = if request.hide_user_message {
        let source = if approval.is_some() {
            "internal_shell_approval"
        } else {
            "internal_continuation"
        };
        json!({ "hidden": true, "source": source })
    } else {
        Value::Null
    };
    let user_message = store::new_message(&session, "user", &content, parts);
    let user_message = match agent
        .with_db(move |conn| store::insert_message(conn, user_message))
        .await
    {
        Ok(message) => message,
        Err(_) => {
            emitter.send(&Frame::error("Failed to save the user message"));
            return;
        }
    };
    emitter.send(&Frame {
        chat: value(&user_message),
        ..Frame::new("user_message")
    });
    let attachments = attachments::resolve(agent.workspace(), &request.attachment_paths).await;
    let run = Arc::new(Run {
        agent: agent.clone(),
        emitter: emitter.clone(),
        user_id,
        session_id: session.id,
        trigger_message_id: user_message.id,
        active_document_path: active_document.clone(),
        active_data_document_id: request.active_data_document_id,
        active_data_table_id: request.active_data_table_id,
        execution_mode: execution_mode(&request.execution_mode),
        task_mode: task_mode(&request.task_mode),
        pane: pane(&request.pane_context),
        whiteboard: request.whiteboard_context.clone(),
        design: request.design_context.clone(),
        model: request.runtime_model.clone().unwrap_or_default(),
        prompt: content.clone(),
        attachments,
        local_sources,
        approved_command: Mutex::new(
            approval
                .as_ref()
                .filter(|a| a.decision == exec::ALLOW_ONCE)
                .map(|a| a.command.clone()),
        ),
        language: request.language.trim().to_owned(),
    });
    if let Some(intent) = image_intent {
        // The session is released as soon as the client leaves; the image
        // work keeps running in its own task and records its own outcome,
        // logging the exchange so later turns see it.
        let (task_run, portal) = (run.clone(), agent.portal_base_url().to_owned());
        let request = content.clone();
        let work = tokio::spawn(async move {
            if let Some(reply) = images::stream_intent(&task_run, session, &portal, intent).await {
                log::record_exchange(&task_run.agent, task_run.session_id, &request, &reply).await;
            }
        });
        tokio::select! {
            result = work => {
                if let Err(error) = result {
                    tracing::warn!(error = %error, "image generation task ended abnormally");
                }
            }
            () = emitter.closed() => {}
        }
        drop(turn);
        return;
    }
    run.event(
        EventInput::new(
            "task.created",
            "intent",
            "completed",
            "Understand task",
            format!(
                "{} \u{b7} {} / {}",
                truncate_chars(&content, 160),
                run.execution_mode,
                run.task_mode
            ),
        )
        .data(json!({
            "execution_mode": run.execution_mode,
            "permission_mode": run.permission(),
            "task_mode": run.task_mode,
        })),
    )
    .await;
    if let Some(approval) = &approval {
        run.event(
            EventInput::new(
                "shell.approval_decided",
                "execute",
                "completed",
                "Command approval decided",
                "The user responded to the pending command approval",
            )
            .data(json!({ "tool_call_id": approval.tool_call_id, "decision": approval.decision })),
        )
        .await;
    }
    if let Some(context) = &run.whiteboard {
        let (message, data) = canvas::whiteboard_event(context);
        run.event(
            EventInput::new(
                "whiteboard.context.attached",
                "context",
                "completed",
                "Whiteboard context attached",
                message,
            )
            .data(data),
        )
        .await;
    }
    if let Some(context) = &run.design {
        let (message, data) = canvas::design_event(context);
        run.event(
            EventInput::new(
                "design.context.attached",
                "context",
                "completed",
                "Design context attached",
                message,
            )
            .data(data),
        )
        .await;
    }
    if !run.local_sources.is_empty() {
        run.event(
            EventInput::new(
                "local_sources.attached",
                "context",
                "completed",
                "Local analysis folders attached",
                format!(
                    "Attached {} read-only local folder(s)",
                    run.local_sources.len()
                ),
            )
            .data(sources::event_data(&run.local_sources)),
        )
        .await;
    }
    if let Some(plan) = &request.table_plan_context {
        run.event(
            EventInput::new(
                "table.plan.attached",
                "context",
                "completed",
                "Reused prior plan",
                prompts::table_plan_event(plan),
            )
            .data(plan.clone()),
        )
        .await;
    }
    session.status = "running".into();
    session.model_id = request.model_id.trim().to_owned();
    if run.active_data_document_id != 0 && run.active_data_table_id != 0 {
        let mut extra = session.extra_data.as_object().cloned().unwrap_or_default();
        extra.insert(
            "active_data_document_id".into(),
            json!(run.active_data_document_id),
        );
        extra.insert(
            "active_data_table_id".into(),
            json!(run.active_data_table_id),
        );
        session.extra_data = Value::Object(extra);
    }
    let mut saved = session.clone();
    let _ = agent
        .with_db(move |conn| store::save_session(conn, &mut saved))
        .await;
    run.event(EventInput::new(
        "task.started",
        "intent",
        "running",
        "Start execution",
        "The agent has started planning and executing the task",
    ))
    .await;

    let has_table = run.active_data_table_id != 0;
    let has_documents = !active_document.is_empty()
        || !request.prompt_context.trim().is_empty()
        || !run.local_sources.is_empty();
    let all_skills = catalog::skills(agent.workspace().root());
    let skills: Vec<SkillDef> =
        catalog::match_skills(&all_skills, &content, has_table, has_documents);
    if !skills.is_empty() {
        let names: Vec<&str> = skills.iter().map(|skill| skill.name.as_str()).collect();
        run.event(
            EventInput::new(
                "skill.enabled",
                "intent",
                "completed",
                "Skills enabled",
                format!("Enabled: {}", names.join(", ")),
            )
            .data(json!({ "skills": catalog::public_skills(&skills) })),
        )
        .await;
    }
    if request.runtime_model.is_none() {
        fail(
            &run,
            "Missing model configuration",
            "final",
            "Configure a text model in Settings before using the agent.",
        )
        .await;
        return;
    }
    let wire = run.model.wire_api.trim();
    if !matches!(
        wire,
        "responses" | "chat_completions" | "anthropic_messages"
    ) {
        let message = format!(
            "Provider wire_api={wire:?} is no longer supported; switch to OpenAI Responses, OpenAI Chat Completions, or Anthropic Messages in settings."
        );
        fail(&run, "Unsupported wire_api", "final", &message).await;
        return;
    }
    let facts = TurnFacts {
        prompt_context: request.prompt_context,
        active_workflow_id: request.active_workflow_id,
        table_plan: request.table_plan_context,
        skills,
        hosted_web_search: run.model.supports_hosted_web_search(),
        hosted_images: run.model.supports_hosted_images(),
    };
    turn::drive(&run, session, &content, facts, turn).await;
}

pub(crate) async fn await_approval(run: &Run, mut session: AgentSession, output: Value) {
    let reason = output["reason"]
        .as_str()
        .filter(|r| !r.trim().is_empty())
        .unwrap_or("Waiting for the user to approve the command")
        .to_owned();
    run.event(
        EventInput::new(
            "shell.approval_required",
            "execute",
            "pending",
            "Command approval required",
            reason,
        )
        .data(output.clone()),
    )
    .await;
    run.event(
        EventInput::new(
            "task.awaiting_approval",
            "execute",
            "running",
            "Await command approval",
            "Waiting for the user to approve or deny the pending command",
        )
        .data(json!({ "tool_call_id": output["tool_call_id"] })),
    )
    .await;
    run.event(EventInput::new(
        "user.input_needed",
        "execute",
        "pending",
        "Command approval required",
        "A command is waiting for approval",
    ))
    .await;
    session.status = "idle".into();
    session.active_document_path = run.active_document_path.clone();
    let mut saved = session.clone();
    let _ = run
        .agent
        .with_db(move |conn| store::save_session(conn, &mut saved))
        .await;
    run.send(
        &Frame {
            done: true,
            ..Frame::new("done")
        }
        .extra("awaiting_shell_approval", true)
        .extra("shell_approval_required", &output)
        .extra("session", &session),
    );
}

pub(crate) async fn finish(
    run: &Run,
    mut session: AgentSession,
    prompt: &str,
    reply: String,
    streamed: bool,
    result: &kition_ai::engine::ChatResult,
) {
    let (id, user, message_id) = (run.session_id, run.user_id, run.trigger_message_id);
    let calls: Vec<store::AgentToolCall> = run
        .agent
        .with_db(move |conn| store::session_rows(conn, id, user))
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|call: &store::AgentToolCall| call.message_id == Some(message_id))
        .collect();
    let (reply, plan) = table_plan::finalize(&reply, &run.execution_mode, &calls);
    if let Some(plan) = plan {
        let summary = plan["summary"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("Generated a structured table plan")
            .to_owned();
        run.event(
            EventInput::new(
                "table.plan.generated",
                "artifact",
                "completed",
                "Table plan generated",
                summary,
            )
            .data(plan),
        )
        .await;
    }
    if !streamed {
        run.emitter.send_text_in_chunks(&reply).await;
    }
    run.event(EventInput::new(
        "response.completed",
        "final",
        "completed",
        "Finalize response",
        "Generated the final reply",
    ))
    .await;
    let message = store::new_message(
        &session,
        "assistant",
        &reply,
        json!({ "model": result.model, "usage": result.usage }),
    );
    let message = match run
        .agent
        .with_db(move |conn| store::insert_message(conn, message))
        .await
    {
        Ok(message) => message,
        Err(_) => {
            run.event(EventInput::new(
                "task.failed",
                "final",
                "failed",
                "Reply save failed",
                "Failed to save the agent reply",
            ))
            .await;
            run.send(&Frame::error("Failed to save the agent reply"));
            return;
        }
    };
    let artifact = run
        .agent
        .with_db(move |conn| store::latest_artifact_for_message(conn, id, user, message_id))
        .await
        .ok()
        .flatten();
    if session.title == "New chat" || session.title.trim().is_empty() {
        session.title = prompts::title_from(&reply, prompt);
    }
    session.status = "idle".into();
    session.active_document_path = run.active_document_path.clone();
    if let Some(artifact) = &artifact
        && documents::is_editable_document(&artifact.path)
    {
        session.active_document_path = artifact.path.clone();
    }
    session.updated_at = now_millis();
    let mut saved = session.clone();
    let _ = run
        .agent
        .with_db(move |conn| store::save_session(conn, &mut saved))
        .await;
    run.send(&Frame {
        chat: value(&message),
        ..Frame::new("assistant_message")
    });
    run.event(EventInput::new(
        "task.completed",
        "final",
        "completed",
        "Task completed",
        "The agent task is complete",
    ))
    .await;
    let mut done = Frame {
        done: true,
        ..Frame::new("done")
    }
    .extra("message", &message)
    .extra("session", &session);
    if let Some(artifact) = &artifact {
        done = done.extra("artifact", artifact);
    }
    run.send(&done);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_modes() {
        assert_eq!(pane("Whiteboard"), "whiteboard");
        assert_eq!(pane("browser"), "document");
        assert_eq!(execution_mode("PREVIEW"), "preview");
        assert_eq!(task_mode("browse"), "auto");
    }
}
