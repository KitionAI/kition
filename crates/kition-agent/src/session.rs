//! `POST /agent/sessions/{id}/messages/stream`: one streamed agent turn.

use std::sync::{Arc, Mutex};

use axum::response::Response;
use kition_ai::engine::RuntimeModel;
use kition_core::{AppError, AppResult, now_millis};
use kition_harness::driver::{append_live, next_turn};
use kition_harness::events::{ApprovalOutcome, EventBody};
use kition_harness::log::SqliteLog;
use serde::Deserialize;
use serde_json::Value;

use crate::catalog::{self, SkillDef};
use crate::providers::TurnFacts;
use crate::run::{Agent, BUSY, Run, TurnGuard};
use crate::sources::{self, LocalSourceInput};
use crate::store::{self, AgentSession};
use crate::stream::{Emitter, TurnStream};
use crate::tools::{canvas, documents, exec, images};
use crate::{attachments, log, prompts, turn};

/// The user's answer to the command approval of the tool call `call_id`
/// (`agent-shell-approval.schema.json#/$defs/response`).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ShellApprovalInput {
    pub call_id: String,
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
    pub active_workflow_id: String,
    pub pane_context: String,
    pub execution_mode: String,
    /// How the agent edits kit documents: `live` (the default) or `draft` (standard 2.0 A12).
    pub kit_edit_mode: String,
    pub image_generation_intent: Option<Value>,
    pub design_context: Option<Value>,
    pub shell_approval: Option<ShellApprovalInput>,
    pub model_id: String,
    pub runtime_model: Option<RuntimeModel>,
    pub hide_user_message: bool,
    pub language: String,
}

fn pane(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        pane @ ("workflow" | "gallery" | "design") => pane.to_owned(),
        _ => "document".to_owned(),
    }
}

fn execution_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        mode @ ("research" | "preview") => mode.to_owned(),
        _ => "apply".to_owned(),
    }
}

fn kit_edit_mode(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "draft" => "draft".to_owned(),
        _ => "live".to_owned(),
    }
}

/// Whether a model turn can run on `model`: one is configured and speaks a
/// supported wire.
fn check_model(model: Option<&RuntimeModel>) -> Result<(), String> {
    let Some(model) = model else {
        return Err("Configure a text model in Settings before using the agent.".into());
    };
    match model.wire_api.trim() {
        "responses" | "chat_completions" | "anthropic_messages" => Ok(()),
        wire => Err(format!(
            "Provider wire_api={wire:?} is no longer supported; switch to OpenAI Responses, OpenAI Chat Completions, or Anthropic Messages in settings."
        )),
    }
}

/// The `user/message` source kind of a request: an approval resume, a
/// hidden follow-up the client sent, or the person's own message.
fn message_source(approval: bool, hidden: bool) -> &'static str {
    match (approval, hidden) {
        (true, _) => "approval",
        (false, true) => "context-action",
        (false, false) => "user",
    }
}

/// Loads the caller's live session.
pub async fn owned_session(agent: &Agent, id: i64, user_id: i64) -> AppResult<AgentSession> {
    agent
        .with_db(move |conn| store::find_session(conn, id, user_id))
        .await?
        .ok_or_else(|| AppError::not_found("Agent session not found"))
}

/// Everything a turn needs that can be checked before streaming starts.
pub struct Prepared {
    request: StreamRequest,
    session: AgentSession,
    content: String,
    image_intent: Option<images::ImageIntent>,
    /// The image request was already logged with the same settings.
    image_repeat: bool,
    approval: Option<exec::Approval>,
    local_sources: Vec<sources::LocalSource>,
    /// The inbox id of the turn's message: minted here, or the client's.
    message_id: String,
    /// The session's turn guard, taken by the busy check and held until
    /// the turn's last frame.
    turn: TurnGuard,
}

/// Validates the request; failures become ordinary error responses.
pub async fn prepare(
    agent: &Agent,
    user_id: i64,
    session_id: i64,
    request: StreamRequest,
) -> AppResult<Prepared> {
    let session = owned_session(agent, session_id, user_id).await?;
    if request.shell_approval.is_some() && request.image_generation_intent.is_some() {
        return Err(AppError::bad_request(
            "a shell approval cannot carry an image generation intent",
        ));
    }
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
    let image_repeat = match &image_intent {
        Some(intent) => {
            let events = log::read_session(agent, session.id)
                .await
                .map_err(AppError::internal)?;
            !images::claim(&events, intent).map_err(AppError::conflict)?
        }
        None => {
            check_model(request.runtime_model.as_ref()).map_err(AppError::bad_request)?;
            false
        }
    };
    let local_sources =
        sources::normalize(&request.local_sources).map_err(AppError::bad_request)?;
    // Last: an `allow_always` decision saves a policy rule, which only an
    // otherwise valid request may do.
    let approval = match &request.shell_approval {
        Some(input) => Some(
            exec::resolve_approval(
                agent,
                session.id,
                input.call_id.trim(),
                input.decision.trim(),
            )
            .await
            .map_err(AppError::bad_request)?,
        ),
        None => None,
    };
    Ok(Prepared {
        request,
        session,
        content,
        image_intent,
        image_repeat,
        approval,
        local_sources,
        message_id: uuid::Uuid::new_v4().to_string(),
        turn,
    })
}

impl Prepared {}

/// Starts the turn and returns the streaming response.
pub async fn start(agent: Agent, user_id: i64, prepared: Prepared) -> Response {
    let (emitter, response) = Emitter::channel();
    tokio::spawn(async move { drive(agent, user_id, prepared, emitter).await });
    response
}

/// The `approval/decided` outcome of a decision: a rule the user saved is a
/// policy change, not a session fact, so both allows are `allowed-once`.
fn approval_outcome(decision: &str) -> ApprovalOutcome {
    if decision == exec::DENY {
        ApprovalOutcome::Rejected
    } else {
        ApprovalOutcome::AllowedOnce
    }
}

/// Saves the session row after a turn: its title from the first completed
/// reply (`titled` is the prompt and the reply), the document the turn
/// delivered last, and `updated_at`.
pub(crate) async fn finish(run: &Run, mut session: AgentSession, titled: Option<(&str, String)>) {
    if let Some((prompt, reply)) = titled
        && (session.title == "New chat" || session.title.trim().is_empty())
    {
        session.title = prompts::title_from(&reply, prompt);
    }
    session.active_document_path = run.active_document_path.clone();
    let events = log::read_session(&run.agent, run.session_id)
        .await
        .unwrap_or_default();
    let turn = next_turn(&events).saturating_sub(1);
    if let Some(path) =
        log::recent_deliverables(&events, turn.max(1), 1, documents::is_editable_document)
            .into_iter()
            .next()
    {
        session.active_document_path = path;
    }
    session.updated_at = now_millis();
    let _ = run
        .agent
        .with_db(move |conn| store::save_session(conn, &mut session))
        .await;
}

async fn drive(agent: Agent, user_id: i64, prepared: Prepared, emitter: Emitter) {
    let Prepared {
        request,
        mut session,
        content,
        image_intent,
        image_repeat,
        approval,
        local_sources,
        message_id,
        turn,
    } = prepared;
    let stream = TurnStream::new(emitter.clone(), session.id);
    if image_repeat {
        stream.close_unchanged();
        return;
    }
    stream.status(true);
    let mut active_document = request.active_document_path.trim().to_owned();
    if active_document.is_empty() {
        active_document = session.active_document_path.trim().to_owned();
    }
    // One read of the log before the turn serves the document and image
    // defaults below.
    let history = log::read_session(&agent, session.id)
        .await
        .unwrap_or_default();
    if active_document.is_empty() {
        active_document = log::recent_deliverables(&history, 0, 1, documents::is_editable_document)
            .into_iter()
            .next()
            .unwrap_or_default();
    }
    session.active_document_path = active_document.clone();
    let attachments = attachments::resolve(agent.workspace(), &request.attachment_paths).await;
    let run = Arc::new(Run {
        agent: agent.clone(),
        emitter: emitter.clone(),
        live: stream.live_sink(agent.hooks(), user_id),
        user_id,
        session_id: session.id,
        active_document_path: active_document.clone(),
        execution_mode: execution_mode(&request.execution_mode),
        kit_edit_mode: kit_edit_mode(&request.kit_edit_mode),
        pane: pane(&request.pane_context),
        design: request.design_context.clone(),
        model: request.runtime_model.clone().unwrap_or_default(),
        provider_route: request
            .runtime_model
            .as_ref()
            .map(|model| model.provider_type.trim().to_owned())
            .unwrap_or_default(),
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
        source: message_source(approval.is_some(), request.hide_user_message),
        message_id,
    });
    if let Some(intent) = image_intent {
        // The whole request is logged as one turn under the session's turn
        // guard. When the client leaves, the generation stops and the turn
        // ends as cancelled, which releases the session.
        match images::Composer::start(&run, &intent.request_id, &content) {
            Ok(composer) => {
                let portal = agent.portal_base_url().to_owned();
                tokio::select! {
                    () = images::stream_intent(&run, &portal, &intent, &composer) => {}
                    () = emitter.closed() => composer.cancel(),
                }
            }
            Err(error) => tracing::warn!(error = %error, "could not log the image request"),
        }
        finish(&run, session, None).await;
        drop(turn);
        stream.close();
        return;
    }
    if let Some(approval) = &approval {
        // The decision lands before the turn that resumes the paused call.
        let log = SqliteLog::new(agent.db().clone());
        let decided = EventBody::ApprovalDecided {
            id: format!("approval:{}", approval.call_id),
            outcome: approval_outcome(&approval.decision),
        };
        if let Err(error) = append_live(&log, &log::log_key(session.id), &run.live, decided) {
            tracing::warn!(error = %error, "could not log the approval decision");
            drop(turn);
            stream.close();
            return;
        }
    }
    session.model_id = request.model_id.trim().to_owned();
    let mut saved = session.clone();
    let _ = agent
        .with_db(move |conn| store::save_session(conn, &mut saved))
        .await;
    let has_documents = !active_document.is_empty()
        || !request.prompt_context.trim().is_empty()
        || !run.local_sources.is_empty();
    let all_skills = catalog::skills(agent.workspace().root());
    let skills: Vec<SkillDef> = catalog::match_skills(&all_skills, &content, has_documents);
    let facts = TurnFacts {
        prompt_context: request.prompt_context,
        active_workflow_id: request.active_workflow_id,
        skills,
        hosted_web_search: run.model.supports_hosted_web_search(),
        hosted_images: run.model.supports_hosted_images(),
        recent_images: {
            let mut images = log::recent_deliverables(&history, 0, 8, log::is_image_path);
            images.reverse();
            images
        },
    };
    turn::drive(&run, session, &content, facts, turn).await;
    stream.close();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_modes() {
        assert_eq!(pane("Design"), "design");
        assert_eq!(pane("whiteboard"), "document");
        assert_eq!(pane("browser"), "document");
        assert_eq!(execution_mode("PREVIEW"), "preview");
        assert_eq!(kit_edit_mode("Draft"), "draft");
        assert_eq!(kit_edit_mode(""), "live");
        assert_eq!(kit_edit_mode("merge"), "live");
    }

    #[test]
    fn both_allows_are_allowed_once() {
        assert_eq!(
            approval_outcome(exec::ALLOW_ONCE),
            ApprovalOutcome::AllowedOnce
        );
        assert_eq!(
            approval_outcome(exec::ALLOW_ALWAYS),
            ApprovalOutcome::AllowedOnce
        );
        assert_eq!(approval_outcome(exec::DENY), ApprovalOutcome::Rejected);
    }

    #[test]
    fn names_who_sent_the_message() {
        assert_eq!(message_source(true, true), "approval");
        assert_eq!(message_source(false, true), "context-action");
        assert_eq!(message_source(false, false), "user");
    }
}
