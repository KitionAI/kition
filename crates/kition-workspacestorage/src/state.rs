//! Mirroring agent sessions into workspace files, and
//! importing them on startup, so a workspace folder carries its history.
//!
//! Layout:
//! * `.kition/agents/<session id>/session.json` (the session row and the
//!   number of exported log events) and `session-events.jsonl` (the session event log,
//!   one event per line as `GET /agent/sessions/{id}/session-events` serves
//!   it, without `system/message` events and with inline images omitted).

use std::path::Path;

use kition_core::{AppError, AppResult};
use kition_store::Db;
use kition_store::rows::{self, AgentSession};
use kition_workspace::AssetStore;
use kition_workspace::fsutil::write_atomic;
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Version 3 files carry the agent session event log; older files are not
/// imported.
pub const STATE_SCHEMA_VERSION: i64 = 3;

/// Tables whose changes are mirrored into workspace files.
pub const MIRRORED_TABLES: [&str; 2] = ["agent_sessions", "agent_session_events"];

fn importable(version: i64) -> bool {
    version == STATE_SCHEMA_VERSION
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SessionSnapshot {
    #[serde(default)]
    schema_version: i64,
    #[serde(default)]
    session: AgentSession,
    /// How many logged events `session-events.jsonl` was written from; an
    /// export rewrites the log only when the database holds more.
    #[serde(default)]
    events_count: i64,
}

/// The log key of an agent session (`kition-agent`'s `log_key`).
fn log_key(session_id: i64) -> String {
    format!("agent:{session_id}")
}

/// What an exported image block becomes: inline image data would bloat the
/// workspace file.
const OMITTED_IMAGE: &str = "[image omitted]";

/// Replaces inline (`data:`) image blocks in `content` with a text block.
fn omit_inline_images(content: &mut Value) {
    let Some(blocks) = content.as_array_mut() else {
        return;
    };
    for block in blocks {
        let inline = block.get("type").and_then(Value::as_str) == Some("image")
            && block
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|url| url.starts_with("data:"));
        if inline {
            *block = serde_json::json!({ "type": "text", "text": OMITTED_IMAGE });
        }
    }
}

/// A logged event as the workspace file keeps it: `{seq, at, type, ...}`
/// without the provider-native `rawItems` of `assistant/message` and with
/// inline images omitted. `None` for `system/message`, which every turn
/// rebuilds.
fn portable_event(seq: i64, at: i64, body: &str) -> AppResult<Option<Value>> {
    let mut event: Map<String, Value> = serde_json::from_str(body)?;
    match event.get("type").and_then(Value::as_str) {
        Some("system/message") => return Ok(None),
        Some("assistant/message") => {
            event.remove("rawItems");
        }
        Some("user/message" | "tool/result") => {
            if let Some(content) = event.get_mut("content") {
                omit_inline_images(content);
            }
        }
        _ => {}
    }
    event.insert("seq".into(), seq.into());
    event.insert("at".into(), at.into());
    Ok(Some(Value::Object(event)))
}

/// How many events the session has logged.
fn events_count(conn: &Connection, session_id: i64) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM agent_session_events WHERE session_key = ?1",
        [log_key(session_id)],
        |row| row.get(0),
    )?)
}

/// The session's logged events as `portable_event` writes them, in order.
fn session_events(conn: &Connection, session_id: i64) -> AppResult<Vec<Value>> {
    let mut statement = conn.prepare(
        "SELECT seq, created_at, body FROM agent_session_events WHERE session_key = ?1 ORDER BY seq",
    )?;
    let rows = statement
        .query_map([log_key(session_id)], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut events = Vec::with_capacity(rows.len());
    for (seq, at, body) in &rows {
        if let Some(event) = portable_event(*seq, *at, body)? {
            events.push(event);
        }
    }
    Ok(events)
}

/// Adds one exported event to the session's log unless its `seq` is there.
fn import_event(
    conn: &Connection,
    session_id: i64,
    mut event: Map<String, Value>,
) -> AppResult<()> {
    let (Some(seq), Some(at)) = (
        event.remove("seq").and_then(|seq| seq.as_i64()),
        event.remove("at").and_then(|at| at.as_i64()),
    ) else {
        return Err(AppError::bad_request("session event without seq or at"));
    };
    let kind = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if seq < 0 || kind.is_empty() {
        return Err(AppError::bad_request("session event without seq or type"));
    }
    conn.execute(
        "INSERT OR IGNORE INTO agent_session_events (session_key, seq, event_type, body, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![log_key(session_id), seq, kind, Value::Object(event).to_string(), at],
    )?;
    Ok(())
}

/// Restores one exported session and its log, all or nothing.
fn import_session(conn: &mut Connection, dir: &Path, workspace_root: &str) -> AppResult<()> {
    let Some(snapshot) = read_json::<SessionSnapshot>(&dir.join("session.json"))? else {
        return Ok(());
    };
    if !importable(snapshot.schema_version) || snapshot.session.id == 0 {
        return Ok(());
    }
    let events = read_json_lines::<Map<String, Value>>(&dir.join("session-events.jsonl"))?;
    let tx = conn.transaction()?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT COALESCE(workspace_root, '') FROM agent_sessions WHERE id = ?1",
            [snapshot.session.id],
            |r| r.get(0),
        )
        .ok();
    match existing {
        None => {
            let mut session = snapshot.session.clone();
            session.workspace_root = workspace_root.to_owned();
            rows::insert(&tx, &session)?;
        }
        Some(root) if root.trim() != workspace_root => return Ok(()),
        Some(_) => {}
    }
    for event in events {
        import_event(&tx, snapshot.session.id, event)?;
    }
    tx.commit()?;
    Ok(())
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
        let mut conn = self.db.conn()?;
        let workspace_root = self.root_text();
        for entry in entries.filter_map(Result::ok).filter(|e| e.path().is_dir()) {
            let dir = entry.path();
            if let Err(err) = import_session(&mut conn, &dir, &workspace_root) {
                tracing::warn!(path = %dir.display(), error = %err, "skipping unreadable agent session state");
            }
        }
        Ok(())
    }

    /// Writes all mirrored state to the workspace.
    pub fn export(&self) -> AppResult<()> {
        self.export_agent_state()
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
            let snapshot = SessionSnapshot {
                schema_version: STATE_SCHEMA_VERSION,
                session: portable,
                events_count: events_count(&conn, session.id)?,
            };
            let session_path = dir.join("session.json");
            let previous = std::fs::read(&session_path).unwrap_or_default();
            let exported = serde_json::from_slice::<SessionSnapshot>(&previous).ok();
            let events_path = dir.join("session-events.jsonl");
            if exported.as_ref().map(|old| old.events_count) != Some(snapshot.events_count)
                || !events_path.exists()
            {
                write_json_lines(&events_path, &session_events(&conn, session.id)?)?;
            }
            let mut written = serde_json::to_vec_pretty(&snapshot)?;
            written.push(b'\n');
            if written != previous {
                write_atomic(&session_path, &written)?;
            }
        }
        for entry in std::fs::read_dir(&root)?.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.path().is_dir() && !active.contains(&name) {
                std::fs::remove_dir_all(entry.path())?;
            }
        }
        Ok(())
    }

    /// Number of state files under `.kition/agents`.
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
