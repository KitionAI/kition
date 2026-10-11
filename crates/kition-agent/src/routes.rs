//! The `/agent` HTTP API.

use axum::Router;
use axum::extract::{FromRef, Path, Query, State};
use axum::response::Response;
use axum::routing::{get, post};
use kition_ai::chat::{AiGate, require_ai};
use kition_core::{AppError, AppResult};
use kition_http::{AuthConfig, CurrentUser, JsonBody, ok};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::execpolicy::{Decision, Policy, Rule};
use crate::mcp::ServerConfig;
use crate::run::Agent;
use crate::session::{self, StreamRequest};
use crate::store::{self, AgentEvent, AgentMessage, AgentToolCall};
use crate::{catalog, prompts};

#[derive(Clone)]
pub struct AgentState {
    pub auth: AuthConfig,
    pub agent: Agent,
    pub ai_gate: AiGate,
}

impl FromRef<AgentState> for AuthConfig {
    fn from_ref(state: &AgentState) -> Self {
        state.auth.clone()
    }
}

pub fn router(state: AgentState) -> Router {
    Router::new()
        .route("/agent/capabilities", get(capabilities))
        .route("/agent/adapters", get(adapters))
        .route("/agent/skills", get(skills))
        .route("/agent/sessions", get(list_sessions).post(create_session))
        .route(
            "/agent/sessions/{id}",
            axum::routing::delete(delete_session),
        )
        .route("/agent/sessions/{id}/messages", get(list_messages))
        .route("/agent/sessions/{id}/tool-calls", get(list_tool_calls))
        .route("/agent/sessions/{id}/events", get(list_events))
        .route(
            "/agent/sessions/{id}/session-events",
            get(list_session_events),
        )
        .route("/agent/sessions/{id}/messages/stream", post(stream))
        .route(
            "/agent/exec-policy/rules",
            get(list_rules).post(upsert_rule).delete(delete_rule),
        )
        .route(
            "/agent/mcp/servers",
            get(list_mcp).post(upsert_mcp).delete(delete_mcp),
        )
        .route("/agent/mcp/reload", post(reload_mcp))
        .with_state(state)
}

fn parse_id(raw: &str) -> AppResult<i64> {
    raw.trim()
        .parse()
        .map_err(|_| AppError::bad_request("Invalid session ID"))
}

async fn capabilities(State(state): State<AgentState>, _user: CurrentUser) -> Response {
    ok(catalog::capabilities(state.agent.workspace().root()))
}

async fn adapters(_user: CurrentUser) -> Response {
    ok(json!({ "items": [] }))
}

async fn skills(State(state): State<AgentState>, _user: CurrentUser) -> Response {
    ok(json!({ "items": catalog::public_skills(&catalog::skills(state.agent.workspace().root())) }))
}

async fn list_sessions(State(state): State<AgentState>, user: CurrentUser) -> AppResult<Response> {
    let root = state.agent.workspace().root_text();
    let user_id = user.id;
    let items = state
        .agent
        .with_db(move |conn| store::list_sessions(conn, user_id, &root))
        .await
        .map_err(|_| AppError::internal("Failed to load agent sessions"))?;
    Ok(ok(json!({ "items": items })))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct CreateSession {
    title: String,
    active_document_path: String,
    language: String,
}

async fn create_session(
    State(state): State<AgentState>,
    user: CurrentUser,
    JsonBody(request): JsonBody<CreateSession>,
) -> AppResult<Response> {
    let title = match request.title.trim() {
        "" => "New chat",
        title => title,
    };
    let mut session = store::new_session(
        user.id,
        title,
        &state.agent.workspace().root_text(),
        request.active_document_path.trim(),
        &prompts::system_prompt(&request.language),
    );
    let row = session.clone();
    session.id = state
        .agent
        .with_db(move |conn| store::create(conn, &row))
        .await
        .map_err(|_| AppError::internal("Failed to create agent session"))?;
    Ok(ok(session))
}

async fn delete_session(
    State(state): State<AgentState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let session = session::owned_session(&state.agent, parse_id(&id)?, user.id).await?;
    state
        .agent
        .with_db(move |conn| store::delete_session(conn, session.id))
        .await
        .map_err(|_| AppError::internal("Failed to delete agent session"))?;
    Ok(ok(json!({ "deleted": true })))
}

async fn session_rows<T>(
    state: &AgentState,
    user_id: i64,
    id: &str,
    what: &str,
) -> AppResult<Response>
where
    T: kition_store::rows::TableRow + serde::Serialize + Send + 'static,
{
    let session = session::owned_session(&state.agent, parse_id(id)?, user_id).await?;
    let items: Vec<T> = state
        .agent
        .with_db(move |conn| store::session_rows(conn, session.id, user_id))
        .await
        .map_err(|_| AppError::internal(format!("Failed to load agent {what}")))?;
    Ok(ok(json!({ "items": items })))
}

async fn list_messages(
    State(state): State<AgentState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    session_rows::<AgentMessage>(&state, user.id, &id, "messages").await
}

async fn list_tool_calls(
    State(state): State<AgentState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    session_rows::<AgentToolCall>(&state, user.id, &id, "tool calls").await
}

async fn list_events(
    State(state): State<AgentState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Response> {
    session_rows::<AgentEvent>(&state, user.id, &id, "events").await
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct EventsQuery {
    after: u64,
}

/// The session event log (`contracts/runtime/agent-session-events.schema.json`).
async fn list_session_events(
    State(state): State<AgentState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> AppResult<Response> {
    let session = session::owned_session(&state.agent, parse_id(&id)?, user.id).await?;
    let log = kition_harness::log::SqliteLog::new(state.agent.db().clone());
    let (items, next_after) = tokio::task::spawn_blocking(move || {
        crate::turn::read_events(&log, session.id, query.after)
    })
    .await
    .map_err(|_| AppError::internal("Failed to load agent session events"))?
    .map_err(|_| AppError::internal("Failed to load agent session events"))?;
    Ok(ok(json!({ "items": items, "next_after": next_after })))
}

async fn stream(
    State(state): State<AgentState>,
    user: CurrentUser,
    Path(id): Path<String>,
    JsonBody(request): JsonBody<StreamRequest>,
) -> AppResult<Response> {
    require_ai(&state.ai_gate)?;
    let prepared = session::prepare(&state.agent, user.id, parse_id(&id)?, request).await?;
    Ok(session::start(state.agent.clone(), user.id, prepared).await)
}

fn rule_view(rule: &Rule) -> Value {
    let mut view = json!({ "prefix": rule.prefix, "decision": rule.decision.as_str() });
    if !rule.justification.is_empty() {
        view["justification"] = json!(rule.justification);
    }
    if Policy::is_builtin(rule) {
        view["builtin"] = json!(true);
    }
    view
}

async fn list_rules(State(state): State<AgentState>, _user: CurrentUser) -> Response {
    let policy = state.agent.policy();
    let items: Vec<Value> = policy.rules().iter().map(rule_view).collect();
    let path = policy
        .path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    ok(json!({ "items": items, "path": path }))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct RuleRequest {
    prefix: Vec<String>,
    decision: String,
    justification: String,
}

fn clean_prefix(prefix: Vec<String>) -> Vec<String> {
    prefix
        .into_iter()
        .map(|token| token.trim().to_owned())
        .filter(|token| !token.is_empty())
        .collect()
}

async fn upsert_rule(
    State(state): State<AgentState>,
    _user: CurrentUser,
    JsonBody(request): JsonBody<RuleRequest>,
) -> AppResult<Response> {
    let prefix = clean_prefix(request.prefix);
    if prefix.is_empty() {
        return Err(AppError::bad_request("prefix is required"));
    }
    let decision = Decision::parse(&request.decision)
        .ok_or_else(|| AppError::bad_request("decision must be allow | prompt | forbidden"))?;
    let mut policy = state.agent.policy_mut();
    policy.add_rule(Rule {
        prefix: prefix.clone(),
        decision,
        justification: request.justification.trim().to_owned(),
    });
    policy
        .save()
        .map_err(|error| AppError::internal(format!("failed to persist exec policy: {error}")))?;
    Ok(ok(
        json!({ "saved": true, "prefix": prefix, "decision": decision.as_str() }),
    ))
}

async fn delete_rule(
    State(state): State<AgentState>,
    _user: CurrentUser,
    JsonBody(request): JsonBody<RuleRequest>,
) -> AppResult<Response> {
    let prefix = clean_prefix(request.prefix);
    if prefix.is_empty() {
        return Err(AppError::bad_request("prefix is required"));
    }
    let mut policy = state.agent.policy_mut();
    let removed = policy.remove_rule(&prefix);
    if removed {
        policy.save().map_err(|error| {
            AppError::internal(format!("failed to persist exec policy: {error}"))
        })?;
    }
    Ok(ok(json!({ "removed": removed, "prefix": prefix })))
}

async fn list_mcp(State(state): State<AgentState>, _user: CurrentUser) -> AppResult<Response> {
    let mcp = state.agent.mcp();
    let configs = mcp
        .configs()
        .map_err(|error| AppError::internal(format!("failed to read mcp config: {error}")))?;
    let statuses = mcp.statuses().await;
    let items: Vec<Value> = configs
        .into_iter()
        .map(|config| {
            let status = statuses.get(&config.name).cloned().unwrap_or_default();
            json!({ "config": config, "status": status })
        })
        .collect();
    Ok(ok(
        json!({ "items": items, "tools": mcp.tools().await, "path": mcp.path() }),
    ))
}

async fn upsert_mcp(
    State(state): State<AgentState>,
    _user: CurrentUser,
    JsonBody(config): JsonBody<ServerConfig>,
) -> AppResult<Response> {
    let config = config.normalized();
    config.validate().map_err(AppError::bad_request)?;
    let name = config.name.clone();
    state
        .agent
        .mcp()
        .upsert(config)
        .await
        .map_err(|error| AppError::internal(format!("failed to persist mcp config: {error}")))?;
    Ok(ok(json!({ "saved": true, "name": name })))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct NameRequest {
    name: String,
}

async fn delete_mcp(
    State(state): State<AgentState>,
    _user: CurrentUser,
    JsonBody(request): JsonBody<NameRequest>,
) -> AppResult<Response> {
    let name = request.name.trim().to_owned();
    if name.is_empty() {
        return Err(AppError::bad_request("name is required"));
    }
    let removed = state
        .agent
        .mcp()
        .delete(&name)
        .await
        .map_err(|error| AppError::internal(format!("failed to update mcp config: {error}")))?;
    Ok(ok(json!({ "removed": removed, "name": name })))
}

async fn reload_mcp(State(state): State<AgentState>, _user: CurrentUser) -> AppResult<Response> {
    let mcp = state.agent.mcp();
    mcp.reload()
        .await
        .map_err(|error| AppError::internal(format!("failed to reload mcp: {error}")))?;
    Ok(ok(
        json!({ "reloaded": true, "tools": mcp.tools().await.len() }),
    ))
}
