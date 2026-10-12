//! Shared agent state and the context of one streamed turn.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use kition_ai::engine::{Engine, MessagePart, RuntimeModel};
use kition_core::{AppResult, now_millis};
use kition_harness::events::{PresentedFile, TodoItem};
use kition_store::Db;
use rusqlite::Connection;
use serde_json::{Map, Value, json};

use crate::execpolicy::Policy;
use crate::sources::LocalSource;
use crate::store::{self, AgentArtifact, AgentEvent};
use crate::stream::{Emitter, Frame, value};
use crate::workspace::Workspace;

/// Runs the user's desktop hooks for an agent event:
/// `(user_id, hook_event, tool_name, stage, status)`.
pub type HookDispatch = Arc<dyn Fn(i64, &str, &str, &str, &str) + Send + Sync>;

/// Saves an SMTP connection for `configure_smtp_connection`:
/// `(user_id, input) -> (summary, output)`.
pub type SmtpConfigurator = Arc<
    dyn Fn(i64, Value) -> futures::future::BoxFuture<'static, Result<(String, Value), String>>
        + Send
        + Sync,
>;

/// Describes a workflow for the prompt when the user has it open.
pub type WorkflowPrompt = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub struct AgentConfig {
    pub db: Db,
    pub engine: Engine,
    pub workspace_dir: PathBuf,
    pub upload_dir: PathBuf,
    pub policy_path: Option<PathBuf>,
    pub hooks: Option<HookDispatch>,
    pub smtp: Option<SmtpConfigurator>,
    pub tables: Option<kition_datadoc::DataDocState>,
    pub portal_base_url: String,
    pub mcp_path: Option<PathBuf>,
    pub workflow_prompt: Option<WorkflowPrompt>,
    /// Kits the agent can drive, such as the photo editor.
    pub kits: Option<kition_kits::KitManager>,
}

struct Inner {
    db: Db,
    engine: Engine,
    workspace: Workspace,
    upload_dir: PathBuf,
    policy: RwLock<Policy>,
    hooks: Option<HookDispatch>,
    smtp: Option<SmtpConfigurator>,
    tables: Option<kition_datadoc::DataDocState>,
    portal_base_url: String,
    mcp: crate::mcp::Manager,
    workflow_prompt: Option<WorkflowPrompt>,
    kits: Option<kition_kits::KitManager>,
    /// One lock per session for its turns; session ids are unique only
    /// within this agent's database.
    turns: SessionLocks,
    /// The last assistant-stream revision of each session, so frames stay
    /// dense across the turns of a session for as long as this process
    /// runs.
    stream_revisions: Mutex<HashMap<i64, Arc<AtomicU64>>>,
    web: reqwest::Client,
}

/// The agent's long-lived state. Cheap to clone.
#[derive(Clone)]
pub struct Agent {
    inner: Arc<Inner>,
}

impl Agent {
    /// The agent over `config`.
    pub fn new(config: AgentConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                db: config.db,
                engine: config.engine,
                workspace: Workspace::new(config.workspace_dir),
                upload_dir: config.upload_dir,
                policy: RwLock::new(Policy::load(config.policy_path)),
                hooks: config.hooks,
                smtp: config.smtp,
                tables: config.tables,
                portal_base_url: config.portal_base_url,
                mcp: crate::mcp::Manager::new(config.mcp_path),
                workflow_prompt: config.workflow_prompt,
                kits: config.kits,
                turns: SessionLocks::default(),
                stream_revisions: Mutex::default(),
                web: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(std::time::Duration::from_secs(10))
                    .build()
                    .unwrap_or_default(),
            }),
        }
    }

    pub fn db(&self) -> &Db {
        &self.inner.db
    }

    pub fn engine(&self) -> &Engine {
        &self.inner.engine
    }

    pub fn workspace(&self) -> &Workspace {
        &self.inner.workspace
    }

    pub fn upload_dir(&self) -> &std::path::Path {
        &self.inner.upload_dir
    }

    /// An HTTP client for public web reads; redirects are left to the
    /// caller so each hop can be checked.
    pub fn web(&self) -> &reqwest::Client {
        &self.inner.web
    }

    pub fn smtp(&self) -> Option<&SmtpConfigurator> {
        self.inner.smtp.as_ref()
    }

    pub fn tables(&self) -> Option<&kition_datadoc::DataDocState> {
        self.inner.tables.as_ref()
    }

    pub fn kits(&self) -> Option<&kition_kits::KitManager> {
        self.inner.kits.as_ref()
    }

    /// The session's turn guard, or `None` while another turn of it runs.
    pub(crate) fn hold_turn(&self, session_id: i64) -> Option<TurnGuard> {
        hold(&self.inner.turns, session_id)
    }

    pub fn portal_base_url(&self) -> &str {
        &self.inner.portal_base_url
    }

    pub fn mcp(&self) -> &crate::mcp::Manager {
        &self.inner.mcp
    }

    /// The prompt block for an open workflow, or `""`.
    pub fn workflow_prompt(&self, id: &str) -> String {
        self.inner
            .workflow_prompt
            .as_ref()
            .and_then(|describe| describe(id))
            .unwrap_or_default()
    }

    pub fn policy(&self) -> std::sync::RwLockReadGuard<'_, Policy> {
        self.inner
            .policy
            .read()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub fn policy_mut(&self) -> std::sync::RwLockWriteGuard<'_, Policy> {
        self.inner
            .policy
            .write()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// The assistant-stream revision counter of a session.
    pub fn stream_revision(&self, session_id: i64) -> Arc<AtomicU64> {
        self.inner
            .stream_revisions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(session_id)
            .or_default()
            .clone()
    }

    /// Drops what this process keeps for a deleted session: its stream
    /// revision counter and its turn lock, unless a turn still holds it.
    pub(crate) fn forget_session(&self, session_id: i64) {
        self.inner
            .stream_revisions
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&session_id);
        let mut turns = self
            .inner
            .turns
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if turns
            .get(&session_id)
            .is_some_and(|lock| Arc::strong_count(lock) == 1)
        {
            turns.remove(&session_id);
        }
    }

    /// Runs blocking database work off the async executor.
    pub async fn with_db<T, F>(&self, work: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> AppResult<T> + Send + 'static,
    {
        self.inner.db.run(move |conn| work(conn)).await
    }
}

/// One lock per session, so two turns of a session never interleave their
/// log appends. Each `Agent` owns one: session ids are only unique within
/// its database.
type SessionLocks = Mutex<HashMap<i64, Arc<tokio::sync::Mutex<()>>>>;

/// The session's lock. Entries nobody holds are pruned on the next lookup.
fn session_lock(locks: &SessionLocks, session_id: i64) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = locks.lock().unwrap_or_else(PoisonError::into_inner);
    locks.retain(|id, lock| *id == session_id || Arc::strong_count(lock) > 1);
    locks.entry(session_id).or_default().clone()
}

/// What a second turn of a session hears while the first is running.
pub(crate) const BUSY: &str =
    "This session is still answering. Wait for the reply or stop it first.";

/// Whether a turn of this session is running.
#[cfg(test)]
fn is_busy(locks: &SessionLocks, session_id: i64) -> bool {
    session_lock(locks, session_id).try_lock().is_err()
}

/// Held by one turn (or image request) of a session from the
/// request's busy check to its last frame.
pub(crate) type TurnGuard = tokio::sync::OwnedMutexGuard<()>;

/// The session's turn guard, or `None` while another turn holds it.
fn hold(locks: &SessionLocks, session_id: i64) -> Option<TurnGuard> {
    session_lock(locks, session_id).try_lock_owned().ok()
}

/// The permission mode a turn runs with.
pub fn permission_for_execution_mode(mode: &str) -> &'static str {
    match mode {
        "research" | "preview" => crate::catalog::READ_ONLY,
        _ => crate::catalog::WORKSPACE_WRITE,
    }
}

/// One timeline event.
#[derive(Debug, Clone, Default)]
pub struct EventInput {
    pub kind: String,
    pub stage: String,
    pub status: String,
    pub label: String,
    pub message: String,
    pub tool_call_id: Option<i64>,
    pub artifact_id: Option<i64>,
    pub data: Option<Value>,
}

impl EventInput {
    pub fn new(
        kind: &str,
        stage: &str,
        status: &str,
        label: &str,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind: kind.to_owned(),
            stage: stage.to_owned(),
            status: status.to_owned(),
            label: label.to_owned(),
            message: message.into(),
            ..Self::default()
        }
    }

    pub fn data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn tool_call(mut self, id: Option<i64>) -> Self {
        self.tool_call_id = id;
        self
    }
}

/// Agent event types that also fire the user's desktop hooks.
fn hook_name(event_type: &str) -> Option<&'static str> {
    match event_type {
        "task.started" => Some("task_started"),
        "task.completed" => Some("task_completed"),
        "task.failed" => Some("task_failed"),
        "tool.called" => Some("tool_called"),
        "user.input_needed" => Some("user_input_needed"),
        _ => None,
    }
}

/// Everything one streamed turn needs.
pub struct Run {
    pub agent: Agent,
    pub emitter: Emitter,
    pub user_id: i64,
    pub session_id: i64,
    pub trigger_message_id: i64,
    pub active_document_path: String,
    pub active_data_document_id: i64,
    pub active_data_table_id: i64,
    pub execution_mode: String,
    pub task_mode: String,
    pub pane: String,
    pub whiteboard: Option<Value>,
    pub design: Option<Value>,
    pub model: RuntimeModel,
    pub prompt: String,
    pub attachments: Vec<crate::attachments::Attachment>,
    pub local_sources: Vec<LocalSource>,
    /// A command the user approved once for this turn.
    pub approved_command: Mutex<Option<String>>,
    pub language: String,
    /// Who sent the turn's message, as the `user/message` source kind:
    /// `user`, `approval`, or `context-action`.
    pub source: &'static str,
}

impl Run {
    pub fn workspace(&self) -> &Workspace {
        self.agent.workspace()
    }

    pub fn permission(&self) -> &'static str {
        permission_for_execution_mode(&self.execution_mode)
    }

    /// Takes the one-time approval when it covers `command`.
    pub fn consume_approval(&self, command: &str) -> bool {
        let mut approved = self
            .approved_command
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if approved.as_deref() == Some(command.trim()) {
            *approved = None;
            return true;
        }
        false
    }

    pub fn send(&self, frame: &Frame) -> bool {
        self.emitter.send(frame)
    }

    /// Records a timeline event and streams it.
    pub async fn event(&self, input: EventInput) -> Option<AgentEvent> {
        if self.session_id <= 0 {
            return None;
        }
        let event = AgentEvent {
            session_id: self.session_id,
            user_id: self.user_id,
            message_id: (self.trigger_message_id > 0).then_some(self.trigger_message_id),
            tool_call_id: input.tool_call_id,
            artifact_id: input.artifact_id,
            event_type: if input.kind.trim().is_empty() {
                "event".into()
            } else {
                input.kind.trim().to_owned()
            },
            stage: input.stage.trim().to_owned(),
            status: input.status.trim().to_owned(),
            label: input.label.trim().to_owned(),
            message: input.message.trim().to_owned(),
            data: input
                .data
                .clone()
                .unwrap_or_else(|| Value::Object(Map::new())),
            created_at: now_millis(),
            ..AgentEvent::default()
        };
        let event = self
            .agent
            .with_db(move |conn| store::insert_event(conn, event))
            .await
            .ok()?;
        self.send(&Frame {
            event: value(&event),
            ..Frame::new("agent_event")
        });
        if let (Some(name), Some(hooks)) = (hook_name(&event.event_type), &self.agent.inner.hooks) {
            let tool_name = input
                .data
                .as_ref()
                .and_then(|data| data.get("tool_name"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            hooks(self.user_id, name, tool_name, &event.stage, &event.status);
        }
        Some(event)
    }

    /// Saves an artifact made by a tool call and announces it.
    pub async fn record_artifact(
        &self,
        tool_call_id: Option<i64>,
        kind: &str,
        path: &str,
        mime_type: &str,
        title: &str,
    ) -> Option<AgentArtifact> {
        if path.trim().is_empty() {
            return None;
        }
        let artifact = AgentArtifact {
            session_id: self.session_id,
            user_id: self.user_id,
            tool_call_id,
            kind: kind.to_owned(),
            path: path.to_owned(),
            mime_type: mime_type.to_owned(),
            title: title.to_owned(),
            created_at: now_millis(),
            ..AgentArtifact::default()
        };
        let artifact = self
            .agent
            .with_db(move |conn| store::insert_artifact(conn, artifact))
            .await
            .ok()?;
        self.event(EventInput {
            artifact_id: Some(artifact.id),
            tool_call_id,
            data: Some(json!({
                "kind": kind,
                "path": path,
                "mime_type": mime_type,
                "title": title,
            })),
            ..EventInput::new(
                "artifact.created",
                "artifact",
                "completed",
                "Save artifact",
                path,
            )
        })
        .await;
        Some(artifact)
    }
}

/// A tool's result for the model and the timeline.
#[derive(Debug, Clone, Default)]
pub struct ToolOutput {
    pub summary: String,
    pub output: Value,
    /// What the timeline stores when it must not keep the model view.
    pub event_summary: Option<String>,
    pub event_output: Option<Value>,
    pub artifact: Option<AgentArtifact>,
    /// `await_shell_approval` pauses the turn for the user.
    pub interrupt: Option<&'static str>,
    /// Content shown to the model on its next turn, such as an image.
    pub follow_up: Vec<MessagePart>,
    /// Files the call hands to the user, logged as `deliverables/presented`.
    pub deliverables: Vec<PresentedFile>,
    /// The agent's whole todo list when the call rewrote it, logged as
    /// `todo/write`.
    pub todos: Option<Vec<TodoItem>>,
}

/// A file a tool hands to the user.
pub fn delivered(path: &str, description: &str) -> PresentedFile {
    PresentedFile {
        path: path.to_owned(),
        description: description.to_owned(),
    }
}

impl ToolOutput {
    pub fn new(summary: impl Into<String>, output: Value) -> Self {
        Self {
            summary: summary.into(),
            output,
            ..Self::default()
        }
    }
}

/// A failed tool call; `output` is kept for the model when present.
#[derive(Debug, Clone, Default)]
pub struct ToolError {
    pub message: String,
    pub summary: String,
    pub output: Option<Value>,
}

impl<T: Into<String>> From<T> for ToolError {
    fn from(message: T) -> Self {
        Self {
            message: message.into(),
            ..Self::default()
        }
    }
}

pub type ToolResult = Result<ToolOutput, ToolError>;

/// Truncates to `max` characters, appending an ellipsis.
pub fn truncate_chars(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{head}...")
    } else {
        head
    }
}

/// Reads a string field of a JSON object, trimmed.
pub fn text_field(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

pub fn int_field(input: &Value, key: &str) -> i64 {
    match input.get(key) {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

pub fn bool_field(input: &Value, key: &str) -> bool {
    input.get(key).and_then(Value::as_bool).unwrap_or(false)
}

pub fn string_list(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.trim().to_owned())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_fields_leniently() {
        let input = json!({ "a": " x ", "n": "4", "f": 2.0, "b": true, "l": ["p", " ", 3] });
        assert_eq!(text_field(&input, "a"), "x");
        assert_eq!(int_field(&input, "n"), 4);
        assert_eq!(int_field(&input, "f"), 2);
        assert!(bool_field(&input, "b"));
        assert_eq!(string_list(&input, "l"), ["p"]);
        assert_eq!(truncate_chars("abcdef", 3), "abc...");
        assert_eq!(truncate_chars("ab", 3), "ab");
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

    fn test_agent(dirs: &[tempfile::TempDir]) -> Agent {
        Agent::new(AgentConfig {
            db: Db::open_in_memory().unwrap_or_else(|error| panic!("{error}")),
            engine: Engine::new(dirs[0].path().to_path_buf(), None),
            workspace_dir: dirs[1].path().to_path_buf(),
            upload_dir: dirs[0].path().to_path_buf(),
            policy_path: None,
            hooks: None,
            smtp: None,
            tables: None,
            portal_base_url: String::new(),
            mcp_path: None,
            workflow_prompt: None,
            kits: None,
        })
    }

    #[test]
    fn a_deleted_session_drops_its_stream_revision_and_lock() {
        let dirs: Vec<tempfile::TempDir> = (0..2)
            .map(|_| tempfile::tempdir().unwrap_or_else(|error| panic!("{error}")))
            .collect();
        let agent = test_agent(&dirs);
        let counter = agent.stream_revision(3);
        counter.store(7, std::sync::atomic::Ordering::SeqCst);
        drop(agent.hold_turn(3));
        let kept = agent.stream_revision(4);
        agent.forget_session(3);
        let revisions = |agent: &Agent| {
            let map = agent
                .inner
                .stream_revisions
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let mut ids: Vec<i64> = map.keys().copied().collect();
            ids.sort_unstable();
            ids
        };
        assert_eq!(revisions(&agent), [4]);
        assert!(
            !agent
                .inner
                .turns
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains_key(&3)
        );
        assert!(Arc::ptr_eq(&kept, &agent.stream_revision(4)));
        assert_eq!(
            agent
                .stream_revision(3)
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
    }

    #[test]
    fn a_session_keeps_one_stream_revision_counter() {
        let dirs: Vec<tempfile::TempDir> = (0..2)
            .map(|_| tempfile::tempdir().unwrap_or_else(|error| panic!("{error}")))
            .collect();
        let agent = test_agent(&dirs);
        let first = agent.stream_revision(3);
        first.store(7, std::sync::atomic::Ordering::SeqCst);
        assert!(Arc::ptr_eq(&first, &agent.stream_revision(3)));
        assert_eq!(
            agent
                .stream_revision(4)
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
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
