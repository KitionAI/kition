//! `POST /agent/sessions/{id}/messages/stream`: one streamed agent turn.

use std::sync::{Arc, Mutex};

use axum::response::Response;
use kition_ai::engine::{KITION_CLOUD_PROVIDER, Message, MessagePart, RuntimeModel, ToolSpec};
use kition_core::{AppError, AppResult, now_millis};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::catalog::{self, SkillDef};
use crate::run::{Agent, EventInput, Run, truncate_chars};
use crate::sources::{self, LocalSourceInput};
use crate::store::{self, AgentArtifact, AgentMessage, AgentSession};
use crate::stream::{Emitter, Frame, value};
use crate::tools::{canvas, documents, exec, images, tables};
use crate::turn::{self, Outcome};
use crate::{attachments, prompts, table_plan};

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

fn supports_hosted_web_search(model: &RuntimeModel) -> bool {
    let provider = model.provider_type.trim().to_lowercase();
    let name = model.model_name.to_lowercase();
    match model.wire_api.trim() {
        "responses" => {
            matches!(
                provider.as_str(),
                "openai" | "openai-oauth2" | "custom" | KITION_CLOUD_PROVIDER
            ) || name.contains("gpt")
        }
        "anthropic_messages" => {
            matches!(provider.as_str(), "anthropic" | "custom") || name.contains("claude")
        }
        _ => false,
    }
}

fn supports_hosted_images(model: &RuntimeModel) -> bool {
    let provider = model.provider_type.trim().to_lowercase();
    model.wire_api.trim() == "responses"
        && (matches!(
            provider.as_str(),
            "openai" | "openai-oauth2" | "custom" | KITION_CLOUD_PROVIDER
        ) || model.model_name.to_lowercase().contains("gpt"))
}

/// The tools offered to the model this turn.
async fn tool_specs(run: &Run) -> Vec<ToolSpec> {
    let mut hidden: Vec<&str> = Vec::new();
    if !(run.pane == "whiteboard" && run.whiteboard.is_some()) {
        hidden.push("whiteboard_propose_patch");
    }
    if !(run.pane == "design" && run.design.is_some()) {
        hidden.push("design_propose_patch");
    }
    let offered_sources = sources::tool_names(&run.local_sources);
    if run.local_sources.is_empty() {
        hidden.extend_from_slice(sources::CORE_TOOLS);
    }
    for name in sources::GIT_TOOLS {
        if !offered_sources.contains(name) {
            hidden.push(name);
        }
    }
    hidden.extend(crate::tools::kits::unavailable(run));
    if !supports_hosted_web_search(&run.model) {
        hidden.push("web_search");
    }
    if supports_hosted_images(&run.model) {
        hidden.push("image_search");
    } else {
        hidden.push("image_generation");
    }
    match run.pane.as_str() {
        "workflow" | "table" | "whiteboard" | "design" => hidden.push("document_write"),
        "gallery" => hidden.extend(["document_write", "image_search"]),
        _ => {}
    }
    let mut specs: Vec<ToolSpec> = catalog::tools()
        .iter()
        .filter(|tool| !hidden.contains(&tool.name.as_str()) && tool.exposure != "hidden")
        .map(|tool| ToolSpec {
            name: tool.name.clone(),
            description: tool.description.clone(),
            input_schema: tool.input_schema.clone(),
        })
        .collect();
    for tool in run.agent.mcp().tools().await {
        let description = if tool.description.trim().is_empty() {
            format!("External MCP tool from {}", tool.server)
        } else {
            format!("[MCP {}] {}", tool.server, tool.description.trim())
        };
        specs.push(ToolSpec {
            name: tool.qualified,
            description,
            input_schema: tool.input_schema,
        });
    }
    specs
}

fn turn_capabilities(specs: &[ToolSpec], model: &RuntimeModel) -> Value {
    let mut names: Vec<&str> = specs.iter().map(|spec| spec.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    let search = names.contains(&"web_search");
    let reason = if search {
        "available"
    } else if supports_hosted_web_search(model) {
        "not_exposed"
    } else {
        "provider_unsupported"
    };
    json!({
        "available_tools": names,
        "hosted_web_search": { "available": search, "reason": reason },
    })
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
}

/// Validates the request; failures become ordinary error responses.
pub async fn prepare(
    agent: &Agent,
    user_id: i64,
    session_id: i64,
    mut request: StreamRequest,
) -> AppResult<Prepared> {
    let session = owned_session(agent, session_id, user_id).await?;
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
        images::stream_intent(&run, session, agent.portal_base_url(), intent).await;
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
    if wire != "responses" && wire != "anthropic_messages" {
        let message = format!(
            "Provider wire_api={wire:?} is no longer supported; switch to OpenAI Responses or Anthropic Messages in settings."
        );
        fail(&run, "Unsupported wire_api", "final", &message).await;
        return;
    }
    let context = build_context(&run, &request, &skills).await;
    let specs = tool_specs(&run).await;
    run.event(
        EventInput::new("prompt.sent", "intent", "completed", "Send model request", "Sent the user goal, session context, and available tools to the model")
            .data(json!({ "model_id": session.model_id, "turn_capabilities": turn_capabilities(&specs, &run.model) })),
    )
    .await;
    let names: Vec<String> = specs.iter().map(|spec| spec.name.clone()).collect();
    let tool_prompt = prompts::tool_loop(&names, &run.pane);
    let context = [context, tool_prompt].join("\n\n");
    if agent.harness() {
        crate::harness_turn::drive(&run, session, &content, &context, specs).await;
        return;
    }
    let messages = match build_messages(&run, &session, &context).await {
        Ok(messages) => messages,
        Err(error) => {
            fail(&run, "Execution failed", "final", &error).await;
            return;
        }
    };
    match turn::run_loop(&run, messages, specs).await {
        Err(error) => {
            if run.emitter.is_closed() {
                set_status(&run, "idle").await;
                run.event(EventInput::new(
                    "task.failed",
                    "final",
                    "failed",
                    "Execution stopped",
                    "The client stopped the request",
                ))
                .await;
                return;
            }
            fail(&run, "Execution failed", "final", &error).await;
        }
        Ok(Outcome::AwaitingApproval(output)) => await_approval(&run, session, output).await,
        Ok(Outcome::Reply {
            content: reply,
            streamed,
            result,
        }) => {
            finish(&run, session, &content, reply, streamed, &result).await;
        }
    }
}

/// The skill, table, pane, and source context for the system prompt.
async fn build_context(run: &Run, request: &StreamRequest, skills: &[SkillDef]) -> String {
    let mut blocks = vec![catalog::skill_prompt(skills)];
    if let Some(state) = run.agent.tables().cloned() {
        let context = tables::TableContext {
            user_id: run.user_id,
            active_document_path: run.active_document_path.clone(),
            document_id: run.active_data_document_id,
            table_id: run.active_data_table_id,
        };
        blocks.push(
            tokio::task::spawn_blocking(move || tables::active_table_context(&state, &context))
                .await
                .unwrap_or_default(),
        );
        if run.pane == "document"
            && run.active_data_document_id != 0
            && run.active_data_table_id == 0
        {
            blocks.push(active_data_document(run).await);
        }
    }
    blocks.push(prompts::task_mode(&run.task_mode).to_owned());
    blocks.push(prompts::WEB_RESEARCH.to_owned());
    if run.active_data_table_id != 0 {
        blocks.push(prompts::table_execution(&run.execution_mode));
    }
    if let Some(plan) = &request.table_plan_context {
        blocks.push(prompts::table_plan(plan));
    }
    blocks.push(prompts::execution_mode(&run.execution_mode).to_owned());
    if run.pane == "workflow" && !request.active_workflow_id.trim().is_empty() {
        blocks.push(run.agent.workflow_prompt(request.active_workflow_id.trim()));
    }
    if let Some(context) = &run.whiteboard {
        blocks.push(canvas::whiteboard_prompt(context));
    }
    if let Some(context) = &run.design {
        blocks.push(canvas::design_prompt(context));
    }
    blocks.push(sources::prompt_context(&run.local_sources));
    blocks.push(request.prompt_context.trim().to_owned());
    blocks.retain(|block| !block.trim().is_empty());
    blocks.join("\n\n")
}

async fn active_data_document(run: &Run) -> String {
    let (id, user) = (run.active_data_document_id, run.user_id);
    let doc = run
        .agent
        .with_db(move |conn| kition_datadoc::index::find(conn, user, &id.to_string()))
        .await
        .ok()
        .flatten();
    let Some(doc) = doc else { return String::new() };
    let mut lines = vec![
        "Active document the user is reading (pane = document):".to_owned(),
        format!("- ID: {}", doc.id),
    ];
    for (label, text) in [("Title", doc.title.trim()), ("Path", doc.path.trim())] {
        if !text.is_empty() {
            lines.push(format!("- {label}: {text}"));
        }
    }
    if !doc.description.trim().is_empty() {
        lines.push(format!(
            "- Description: {}",
            truncate_chars(doc.description.trim(), 240)
        ));
    }
    lines.push("Use document_read to fetch the body before summarizing or editing; do not assume contents from the title alone.".into());
    lines.join("\n")
}

/// The conversation sent to the model: system prompts, the last 16
/// messages, attachments, the turn context, and the user's message.
async fn build_messages(
    run: &Run,
    session: &AgentSession,
    context: &str,
) -> Result<Vec<Message>, String> {
    let (id, user) = (session.id, session.user_id);
    let history = run
        .agent
        .with_db(move |conn| store::recent_messages(conn, id, user, 17))
        .await
        .map_err(|_| "failed to load session context".to_owned())?;
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
    let mut messages = vec![Message::new(
        "system",
        prompts::system_prompt(&run.language),
    )];
    if !run.active_document_path.is_empty() {
        messages.push(Message::new(
            "system",
            prompts::linked_document(&run.active_document_path),
        ));
    }
    let previous = history.iter().filter(|m| m.id != run.trigger_message_id);
    let previous: Vec<&AgentMessage> = previous.collect();
    for message in previous.iter().skip(previous.len().saturating_sub(16)) {
        if message.role != "user" && message.role != "assistant" {
            continue;
        }
        let content = if message.role == "assistant" {
            table_plan::strip_block(&message.content)
        } else {
            message.content.clone()
        };
        messages.push(Message::new(&message.role, content));
    }
    let attachment_block = attachments::prompt_block(&run.attachments);
    if !attachment_block.is_empty() {
        messages.push(Message::new("system", attachment_block));
    }
    let mut context_blocks = vec![context.to_owned()];
    let recent = prompts::recent_images(&images);
    if !recent.is_empty() {
        context_blocks.insert(0, recent);
    }
    messages.push(Message::new("system", context_blocks.join("\n\n")));
    let mut user = Message::new("user", run.prompt.clone());
    let image_parts: Vec<MessagePart> = run
        .attachments
        .iter()
        .filter(|a| !a.image_url.is_empty())
        .map(|a| MessagePart {
            kind: "image_url".into(),
            image_url: a.image_url.clone(),
            ..MessagePart::default()
        })
        .collect();
    if !image_parts.is_empty() {
        user.parts.push(MessagePart {
            kind: "text".into(),
            text: run.prompt.clone(),
            ..MessagePart::default()
        });
        user.parts.extend(image_parts);
    }
    messages.push(user);
    Ok(messages)
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
    fn normalizes_modes_and_provider_support() {
        assert_eq!(pane("Whiteboard"), "whiteboard");
        assert_eq!(pane("browser"), "document");
        assert_eq!(execution_mode("PREVIEW"), "preview");
        assert_eq!(task_mode("browse"), "auto");
        let model = RuntimeModel {
            provider_type: "anthropic".into(),
            wire_api: "anthropic_messages".into(),
            ..RuntimeModel::default()
        };
        assert!(supports_hosted_web_search(&model));
        assert!(!supports_hosted_images(&model));
        let caps = turn_capabilities(
            &[ToolSpec {
                name: "web_search".into(),
                ..ToolSpec::default()
            }],
            &model,
        );
        assert_eq!(caps["hosted_web_search"]["available"], true);
    }
}
