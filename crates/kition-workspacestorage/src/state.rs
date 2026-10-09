//! Mirroring agent sessions and sync state into workspace files, and
//! importing them on startup, so a workspace folder carries its history.
//!
//! Layout:
//! * `.kition/agents/<session id>/session.json` plus `messages.jsonl` and
//!   `events.jsonl`;
//! * `.kition/sync/forms/state.json` and `.kition/sync/email/state.json`.

use std::path::{Path, PathBuf};

use kition_core::{AppError, AppResult, Millis};
use kition_store::Db;
use kition_store::rows::{
    self, AgentArtifact, AgentEvent, AgentGoal, AgentMessage, AgentPlan, AgentSession,
    AgentSubagent, AgentToolCall, TableRow,
};
use kition_workspace::AssetStore;
use kition_workspace::fsutil::{write_atomic, write_json_atomic};
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Version 2 files store timestamps as milliseconds; version 1 files (text
/// timestamps) are still imported.
pub const STATE_SCHEMA_VERSION: i64 = 2;

/// Tables whose changes are mirrored into workspace files.
pub const MIRRORED_TABLES: [&str; 13] = [
    "agent_sessions",
    "agent_messages",
    "agent_tool_calls",
    "agent_artifacts",
    "agent_events",
    "agent_plans",
    "agent_goals",
    "agent_subagents",
    "form_sync_workflows",
    "form_sync_items",
    "workflows",
    "sync_items",
    "sync_runs",
];

fn importable(version: i64) -> bool {
    version == 1 || version == STATE_SCHEMA_VERSION
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SessionSnapshot {
    #[serde(default)]
    schema_version: i64,
    #[serde(default)]
    session: AgentSession,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<AgentToolCall>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    artifacts: Vec<AgentArtifact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    plans: Vec<AgentPlan>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    goals: Vec<AgentGoal>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    subagents: Vec<AgentSubagent>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct FormSnapshot {
    #[serde(default)]
    schema_version: i64,
    #[serde(default)]
    workflows: Option<Vec<PortableFormWorkflow>>,
    #[serde(default)]
    items: Vec<FormItem>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct EmailSnapshot {
    #[serde(default)]
    schema_version: i64,
    #[serde(default)]
    workflows: Option<Vec<PortableEmailWorkflow>>,
    #[serde(default)]
    items: Vec<EmailItem>,
    #[serde(default)]
    runs: Vec<EmailRun>,
}

fn de_time<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Millis, D::Error> {
    kition_core::time::flexible::required(d)
}

fn de_opt_time<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Millis>, D::Error> {
    kition_core::time::flexible::optional(d)
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct PortableFormWorkflow {
    #[serde(default)]
    id: String,
    #[serde(default)]
    user_id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    template_id: String,
    #[serde(default)]
    binding_id: String,
    #[serde(default)]
    remote_source_id: String,
    #[serde(default)]
    public_url: String,
    #[serde(default)]
    published: bool,
    #[serde(default)]
    document_id: String,
    #[serde(default)]
    table_id: String,
    #[serde(default)]
    fields: Value,
    #[serde(default)]
    target: Value,
    #[serde(default)]
    schedule_enabled: bool,
    #[serde(default)]
    interval_minutes: i64,
    #[serde(default)]
    status: String,
    #[serde(default)]
    cursor_id: i64,
    #[serde(
        default,
        deserialize_with = "de_opt_time",
        skip_serializing_if = "Option::is_none"
    )]
    last_sync_at: Option<Millis>,
    #[serde(
        default,
        deserialize_with = "de_opt_time",
        skip_serializing_if = "Option::is_none"
    )]
    next_sync_at: Option<Millis>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    last_error: String,
    #[serde(default)]
    synced_submissions: i64,
    #[serde(default, deserialize_with = "de_time")]
    created_at: Millis,
    #[serde(default, deserialize_with = "de_time")]
    updated_at: Millis,
}

/// Form sync items keep the legacy field names (they never had JSON tags).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct FormItem {
    #[serde(rename = "ID", default)]
    id: i64,
    #[serde(rename = "WorkflowID", default)]
    workflow_id: String,
    #[serde(rename = "SubmissionID", default)]
    submission_id: String,
    #[serde(rename = "RecordID", default)]
    record_id: String,
    #[serde(rename = "CompletedAt", default, deserialize_with = "de_opt_time")]
    completed_at: Option<Millis>,
    #[serde(rename = "CreatedAt", default, deserialize_with = "de_time")]
    created_at: Millis,
    #[serde(rename = "UpdatedAt", default, deserialize_with = "de_time")]
    updated_at: Millis,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct PortableEmailWorkflow {
    #[serde(default)]
    id: String,
    #[serde(default)]
    user_id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    connection: Value,
    #[serde(default)]
    target: Value,
    #[serde(default)]
    schedule_enabled: bool,
    #[serde(default)]
    interval_minutes: i64,
    #[serde(default)]
    include_attachments: bool,
    #[serde(default)]
    status: String,
    #[serde(
        default,
        deserialize_with = "de_opt_time",
        skip_serializing_if = "Option::is_none"
    )]
    last_sync_at: Option<Millis>,
    #[serde(
        default,
        deserialize_with = "de_opt_time",
        skip_serializing_if = "Option::is_none"
    )]
    next_sync_at: Option<Millis>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    last_error: String,
    #[serde(default)]
    synced_messages: i64,
    #[serde(default)]
    cursor_uid_validity: i64,
    #[serde(default)]
    cursor_uid: i64,
    #[serde(default, deserialize_with = "de_time")]
    created_at: Millis,
    #[serde(default, deserialize_with = "de_time")]
    updated_at: Millis,
}

/// Email sync items keep the legacy field names (they never had JSON tags).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct EmailItem {
    #[serde(rename = "ID", default)]
    id: i64,
    #[serde(rename = "WorkflowID", default)]
    workflow_id: String,
    #[serde(rename = "Mailbox", default)]
    mailbox: String,
    #[serde(rename = "UIDValidity", default)]
    uid_validity: i64,
    #[serde(rename = "UID", default)]
    uid: i64,
    #[serde(rename = "DocumentPath", default)]
    document_path: String,
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "LastError", default)]
    last_error: String,
    #[serde(rename = "CompletedAt", default, deserialize_with = "de_opt_time")]
    completed_at: Option<Millis>,
    #[serde(rename = "CreatedAt", default, deserialize_with = "de_time")]
    created_at: Millis,
    #[serde(rename = "UpdatedAt", default, deserialize_with = "de_time")]
    updated_at: Millis,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct EmailRun {
    #[serde(default)]
    id: String,
    #[serde(default)]
    workflow_id: String,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    discovered_messages: i64,
    #[serde(default)]
    processed_messages: i64,
    #[serde(default)]
    imported: i64,
    #[serde(default)]
    updated: i64,
    #[serde(default)]
    skipped: i64,
    #[serde(default)]
    failed: i64,
    #[serde(default)]
    current_batch: i64,
    #[serde(default)]
    table_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    error: String,
    #[serde(
        default,
        deserialize_with = "de_opt_time",
        skip_serializing_if = "Option::is_none"
    )]
    started_at: Option<Millis>,
    #[serde(
        default,
        deserialize_with = "de_opt_time",
        skip_serializing_if = "Option::is_none"
    )]
    finished_at: Option<Millis>,
    #[serde(default, deserialize_with = "de_time")]
    created_at: Millis,
    #[serde(default, deserialize_with = "de_time")]
    updated_at: Millis,
}

fn raw_json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

/// Mirrors and restores workspace state.
#[derive(Clone)]
pub struct StateMirror {
    pub db: Db,
    pub assets: AssetStore,
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> AppResult<Option<T>> {
    match std::fs::read(path) {
        Ok(data) => serde_json::from_slice(&data)
            .map(Some)
            .map_err(AppError::from),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

fn read_json_lines<T: for<'de> Deserialize<'de>>(path: &Path) -> AppResult<Vec<T>> {
    match std::fs::read_to_string(path) {
        Ok(text) => text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).map_err(AppError::from))
            .collect(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(err.into()),
    }
}

fn write_json_lines<T: Serialize>(path: &Path, rows: &[T]) -> AppResult<()> {
    let mut out = String::new();
    for row in rows {
        out.push_str(&serde_json::to_string(row)?);
        out.push('\n');
    }
    write_atomic(path, out.as_bytes())
}

fn by_session<T: TableRow>(conn: &Connection, column: &str, id: i64) -> AppResult<Vec<T>> {
    Ok(rows::select(
        conn,
        &format!("{column} = ?1"),
        &[SqlValue::Integer(id)],
        "id ASC",
    )?)
}

impl StateMirror {
    fn workspace(&self) -> &Path {
        self.assets.workspace_dir()
    }

    fn root_text(&self) -> String {
        self.workspace().to_string_lossy().into_owned()
    }

    /// Restores agent sessions found under `.kition/agents` that are not in
    /// the database yet.
    pub fn import_agent_state(&self) -> AppResult<()> {
        let root = self.workspace().join(".kition/agents");
        let entries = match std::fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err.into()),
        };
        let conn = self.db.conn()?;
        let workspace_root = self.root_text();
        for entry in entries.filter_map(Result::ok).filter(|e| e.path().is_dir()) {
            let dir = entry.path();
            let snapshot: SessionSnapshot = match read_json(&dir.join("session.json")) {
                Ok(Some(snapshot)) => snapshot,
                Ok(None) => continue,
                Err(err) => {
                    tracing::warn!(path = %dir.display(), error = %err, "skipping unreadable agent session state");
                    continue;
                }
            };
            if !importable(snapshot.schema_version) || snapshot.session.id == 0 {
                continue;
            }
            let existing: Option<String> = conn
                .query_row(
                    "SELECT COALESCE(workspace_root, '') FROM agent_sessions WHERE id = ?1",
                    [snapshot.session.id],
                    |r| r.get(0),
                )
                .ok();
            match existing {
                None => {
                    let mut session = snapshot.session.clone();
                    session.workspace_root = workspace_root.clone();
                    rows::insert(&conn, &session)?;
                }
                Some(root) if root.trim() != workspace_root => continue,
                Some(_) => {}
            }
            for row in &snapshot.tool_calls {
                rows::insert_if_absent(&conn, row)?;
            }
            for row in &snapshot.artifacts {
                rows::insert_if_absent(&conn, row)?;
            }
            for row in &snapshot.plans {
                rows::insert_if_absent(&conn, row)?;
            }
            for row in &snapshot.goals {
                rows::insert_if_absent(&conn, row)?;
            }
            for row in &snapshot.subagents {
                rows::insert_if_absent(&conn, row)?;
            }
            for row in read_json_lines::<AgentMessage>(&dir.join("messages.jsonl"))? {
                rows::insert_if_absent(&conn, &row)?;
            }
            for row in read_json_lines::<AgentEvent>(&dir.join("events.jsonl"))? {
                rows::insert_if_absent(&conn, &row)?;
            }
        }
        Ok(())
    }

    /// Restores form and email sync workflows from workspace state files.
    pub fn import_sync_state(&self) -> AppResult<()> {
        let conn = self.db.conn()?;
        let forms: Option<FormSnapshot> =
            read_json(&self.workspace().join(".kition/sync/forms/state.json"))?;
        if let Some(snapshot) = forms.filter(|s| importable(s.schema_version)) {
            for w in snapshot.workflows.unwrap_or_default() {
                let exists: bool = conn
                    .query_row(
                        "SELECT COUNT(*) FROM form_sync_workflows WHERE id = ?1",
                        [&w.id],
                        |r| r.get::<_, i64>(0),
                    )
                    .map(|c| c > 0)?;
                if !exists {
                    kition_formsync::store::upsert_exact(
                        &conn,
                        &kition_formsync::types::Workflow {
                            id: w.id,
                            user_id: w.user_id,
                            name: w.name,
                            template_id: w.template_id,
                            binding_id: w.binding_id,
                            remote_source_id: w.remote_source_id,
                            public_url: w.public_url,
                            published: w.published,
                            document_id: w.document_id,
                            table_id: w.table_id,
                            fields_json: w.fields.to_string(),
                            target_json: w.target.to_string(),
                            schedule_enabled: w.schedule_enabled,
                            interval_minutes: w.interval_minutes,
                            status: w.status,
                            cursor_id: w.cursor_id,
                            last_sync_at: w.last_sync_at,
                            next_sync_at: w.next_sync_at,
                            last_error: w.last_error,
                            synced_submissions: w.synced_submissions,
                            created_at: w.created_at,
                            updated_at: w.updated_at,
                        },
                    )?;
                }
            }
            for item in snapshot.items {
                conn.execute(
                    "INSERT OR IGNORE INTO form_sync_items (id, workflow_id, submission_id, record_id, completed_at, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![item.id, item.workflow_id, item.submission_id, item.record_id, item.completed_at, item.created_at, item.updated_at],
                )?;
            }
        }
        let email: Option<EmailSnapshot> =
            read_json(&self.workspace().join(".kition/sync/email/state.json"))?;
        if let Some(snapshot) = email.filter(|s| importable(s.schema_version)) {
            let mut owners = std::collections::HashMap::new();
            for w in snapshot.workflows.unwrap_or_default() {
                owners.insert(w.id.clone(), w.user_id);
                conn.execute(
                    "INSERT OR IGNORE INTO workflows (id, user_id, name, connection_json, secret_json, target_json, schedule_enabled, \
                     interval_minutes, include_attachments, status, last_sync_at, next_sync_at, last_error, synced_messages, \
                     cursor_uid_validity, cursor_uid, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                    rusqlite::params![
                        w.id, w.user_id, w.name, w.connection.to_string(), w.target.to_string(), w.schedule_enabled,
                        w.interval_minutes, w.include_attachments, w.status, w.last_sync_at, w.next_sync_at, w.last_error,
                        w.synced_messages, w.cursor_uid_validity, w.cursor_uid, w.created_at, w.updated_at
                    ],
                )?;
            }
            for item in snapshot.items {
                conn.execute(
                    "INSERT OR IGNORE INTO sync_items (id, workflow_id, mailbox, uid_validity, uid, document_path, status, last_error, \
                     completed_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    rusqlite::params![
                        item.id, item.workflow_id, item.mailbox, item.uid_validity, item.uid, item.document_path, item.status,
                        item.last_error, item.completed_at, item.created_at, item.updated_at
                    ],
                )?;
            }
            for run in snapshot.runs {
                let user_id = owners.get(&run.workflow_id).copied().unwrap_or_default();
                conn.execute(
                    "INSERT OR IGNORE INTO sync_runs (id, workflow_id, user_id, mode, status, discovered_messages, processed_messages, \
                     imported, updated, skipped, failed, current_batch, table_path, error, cancel_requested, started_at, finished_at, \
                     created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, ?15, ?16, ?17, ?18)",
                    rusqlite::params![
                        run.id, run.workflow_id, user_id, run.mode, run.status, run.discovered_messages, run.processed_messages,
                        run.imported, run.updated, run.skipped, run.failed, run.current_batch, run.table_path, run.error,
                        run.started_at, run.finished_at, run.created_at, run.updated_at
                    ],
                )?;
            }
        }
        Ok(())
    }

    /// Writes all mirrored state to the workspace.
    pub fn export(&self) -> AppResult<()> {
        self.export_agent_state()?;
        self.export_sync_state()
    }

    fn export_agent_state(&self) -> AppResult<()> {
        let root = self.workspace().join(".kition/agents");
        std::fs::create_dir_all(&root)?;
        let conn = self.db.conn()?;
        let sessions: Vec<AgentSession> = rows::select(
            &conn,
            "workspace_root = ?1 AND deleted_at IS NULL",
            &[SqlValue::Text(self.root_text())],
            "id ASC",
        )?;
        let mut active = std::collections::HashSet::new();
        for session in sessions {
            let name = session.id.to_string();
            active.insert(name.clone());
            let dir = root.join(&name);
            let mut portable = session.clone();
            portable.workspace_root = ".".into();
            let mut artifacts: Vec<AgentArtifact> = by_session(&conn, "session_id", session.id)?;
            for artifact in &mut artifacts {
                artifact.path = self.portable_artifact_path(&artifact.path);
            }
            let snapshot = SessionSnapshot {
                schema_version: STATE_SCHEMA_VERSION,
                session: portable,
                tool_calls: by_session(&conn, "session_id", session.id)?,
                artifacts,
                plans: by_session(&conn, "session_id", session.id)?,
                goals: by_session(&conn, "session_id", session.id)?,
                subagents: rows::select(
                    &conn,
                    "parent_session_id = ?1 OR child_session_id = ?1",
                    &[SqlValue::Integer(session.id)],
                    "id ASC",
                )?,
            };
            write_json_atomic(&dir.join("session.json"), &snapshot)?;
            write_json_lines(
                &dir.join("messages.jsonl"),
                &by_session::<AgentMessage>(&conn, "session_id", session.id)?,
            )?;
            write_json_lines(
                &dir.join("events.jsonl"),
                &by_session::<AgentEvent>(&conn, "session_id", session.id)?,
            )?;
        }
        for entry in std::fs::read_dir(&root)?.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.path().is_dir() && !active.contains(&name) {
                std::fs::remove_dir_all(entry.path())?;
            }
        }
        Ok(())
    }

    /// Workspace-relative artifact paths; files outside the workspace are
    /// copied into workspace assets.
    fn portable_artifact_path(&self, raw: &str) -> String {
        let raw = raw.trim();
        let path = PathBuf::from(raw);
        if raw.is_empty() || !path.is_absolute() {
            return raw.replace('\\', "/");
        }
        if let Ok(relative) = path.strip_prefix(self.workspace()) {
            return relative.to_string_lossy().replace('\\', "/");
        }
        let Ok(data) = std::fs::read(&path) else {
            return String::new();
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.assets
            .save_bytes(&data, &name, "application/octet-stream")
            .map(|a| a.workspace_path)
            .unwrap_or_default()
    }

    fn export_sync_state(&self) -> AppResult<()> {
        let conn = self.db.conn()?;
        let workflows: Vec<PortableFormWorkflow> = kition_formsync::store::list_all(&conn)?
            .into_iter()
            .map(|w| PortableFormWorkflow {
                id: w.id,
                user_id: w.user_id,
                name: w.name,
                template_id: w.template_id,
                binding_id: w.binding_id,
                remote_source_id: w.remote_source_id,
                public_url: w.public_url,
                published: w.published,
                document_id: w.document_id,
                table_id: w.table_id,
                fields: raw_json(&w.fields_json),
                target: raw_json(&w.target_json),
                schedule_enabled: w.schedule_enabled,
                interval_minutes: w.interval_minutes,
                status: w.status,
                cursor_id: w.cursor_id,
                last_sync_at: w.last_sync_at,
                next_sync_at: w.next_sync_at,
                last_error: w.last_error,
                synced_submissions: w.synced_submissions,
                created_at: w.created_at,
                updated_at: w.updated_at,
            })
            .collect();
        let items = {
            let mut statement = conn.prepare(
                "SELECT id, workflow_id, submission_id, record_id, completed_at, created_at, updated_at FROM form_sync_items ORDER BY id ASC",
            )?;
            statement
                .query_map([], |r| {
                    Ok(FormItem {
                        id: r.get(0)?,
                        workflow_id: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        submission_id: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                        record_id: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                        completed_at: r.get(4)?,
                        created_at: r.get::<_, Option<i64>>(5)?.unwrap_or_default(),
                        updated_at: r.get::<_, Option<i64>>(6)?.unwrap_or_default(),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        write_json_atomic(
            &self.workspace().join(".kition/sync/forms/state.json"),
            &FormSnapshot {
                schema_version: STATE_SCHEMA_VERSION,
                workflows: (!workflows.is_empty()).then_some(workflows),
                items,
            },
        )?;

        let workflows: Vec<PortableEmailWorkflow> = kition_emailsync::store::all_workflows(&conn)?
            .into_iter()
            .map(|w| PortableEmailWorkflow {
                id: w.id.clone(),
                user_id: w.user_id,
                name: w.name.clone(),
                connection: raw_json(&w.connection_json),
                target: raw_json(&w.target_json),
                schedule_enabled: w.schedule_enabled,
                interval_minutes: w.interval_minutes,
                include_attachments: w.include_attachments,
                status: w.status.clone(),
                last_sync_at: w.last_sync_at,
                next_sync_at: w.next_sync_at,
                last_error: w.last_error.clone(),
                synced_messages: w.synced_messages,
                cursor_uid_validity: i64::from(w.cursor_uid_validity),
                cursor_uid: i64::from(w.cursor_uid),
                created_at: w.created_at,
                updated_at: w.updated_at,
            })
            .collect();
        let items = {
            let mut statement = conn.prepare(
                "SELECT id, workflow_id, mailbox, uid_validity, uid, document_path, status, last_error, completed_at, created_at, updated_at \
                 FROM sync_items ORDER BY id ASC",
            )?;
            statement
                .query_map([], |r| {
                    let text = |i: usize| -> rusqlite::Result<String> {
                        Ok(r.get::<_, Option<String>>(i)?.unwrap_or_default())
                    };
                    Ok(EmailItem {
                        id: r.get(0)?,
                        workflow_id: text(1)?,
                        mailbox: text(2)?,
                        uid_validity: r.get::<_, Option<i64>>(3)?.unwrap_or_default(),
                        uid: r.get::<_, Option<i64>>(4)?.unwrap_or_default(),
                        document_path: text(5)?,
                        status: text(6)?,
                        last_error: text(7)?,
                        completed_at: r.get(8)?,
                        created_at: r.get::<_, Option<i64>>(9)?.unwrap_or_default(),
                        updated_at: r.get::<_, Option<i64>>(10)?.unwrap_or_default(),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        let runs = kition_emailsync::store::all_runs(&conn)?
            .into_iter()
            .map(|r| EmailRun {
                id: r.id,
                workflow_id: r.workflow_id,
                mode: r.mode,
                status: r.status,
                discovered_messages: r.discovered_messages,
                processed_messages: r.processed_messages,
                imported: r.imported,
                updated: r.updated,
                skipped: r.skipped,
                failed: r.failed,
                current_batch: r.current_batch,
                table_path: r.table_path,
                error: r.error,
                started_at: r.started_at,
                finished_at: r.finished_at,
                created_at: r.created_at,
                updated_at: r.updated_at,
            })
            .collect();
        write_json_atomic(
            &self.workspace().join(".kition/sync/email/state.json"),
            &EmailSnapshot {
                schema_version: STATE_SCHEMA_VERSION,
                workflows: (!workflows.is_empty()).then_some(workflows),
                items,
                runs,
            },
        )
    }

    /// Number of state files under `.kition/agents` and `.kition/sync`.
    pub fn count_state_files(&self) -> usize {
        fn count(dir: &Path) -> usize {
            std::fs::read_dir(dir)
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .map(|e| {
                            if e.path().is_dir() {
                                count(&e.path())
                            } else {
                                1
                            }
                        })
                        .sum()
                })
                .unwrap_or(0)
        }
        count(&self.workspace().join(".kition/agents"))
            + count(&self.workspace().join(".kition/sync"))
    }

    /// Agent sessions in this workspace that exist only in the database.
    pub fn external_session_count(&self) -> i64 {
        let Ok(conn) = self.db.conn() else { return 0 };
        conn.query_row(
            "SELECT COUNT(*) FROM agent_sessions WHERE deleted_at IS NULL AND workspace_root = ?1",
            [self.root_text()],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }
}
