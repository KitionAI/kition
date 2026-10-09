//! The `agent_*` tables.

use kition_core::{AppError, AppResult, now_millis};
use kition_store::row_type;
use kition_store::rows::{self, TableRow};
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;
use serde_json::Value;

row_type!(AgentSession, "agent_sessions", {
    user_id: int,
    title: text,
    workspace_root: text,
    active_document_path: text,
    status: text,
    model_id: text,
    system_prompt: text,
    extra_data: json,
    created_at: time,
    updated_at: time,
});

row_type!(AgentMessage, "agent_messages", {
    session_id: int,
    user_id: int,
    role: text,
    content: text,
    parts: json,
    status: text,
    created_at: time,
});

row_type!(AgentToolCall, "agent_tool_calls", {
    session_id: int,
    message_id: opt,
    user_id: int,
    tool_name: text,
    input_data: json,
    output_data: json,
    status: text,
    error_message: text,
    created_at: time,
    updated_at: time,
});

row_type!(AgentArtifact, "agent_artifacts", {
    session_id: int,
    user_id: int,
    tool_call_id: opt,
    kind: text,
    path: text,
    mime_type: text,
    title: text,
    created_at: time,
});

row_type!(AgentEvent, "agent_events", {
    session_id: int,
    user_id: int,
    message_id: opt,
    tool_call_id: opt,
    artifact_id: opt,
    event_type: text,
    stage: text,
    status: text,
    label: text,
    message: text,
    data: json,
    created_at: time,
});

row_type!(AgentPlanStep, "agent_plans", {
    session_id: int,
    user_id: int,
    message_id: opt,
    step_index: int,
    step_text: text,
    status: text,
    updated_at: time,
});

fn db_error(error: rusqlite::Error) -> AppError {
    AppError::unhandled(error)
}

/// Inserts `row` and returns it with its new ID.
pub fn create<T: TableRow + Clone>(conn: &Connection, row: &T) -> AppResult<i64> {
    rows::insert(conn, row).map_err(db_error)
}

pub fn find_session(conn: &Connection, id: i64, user_id: i64) -> AppResult<Option<AgentSession>> {
    let rows: Vec<AgentSession> = rows::select(
        conn,
        "id = ?1 AND user_id = ?2 AND deleted_at IS NULL",
        &[SqlValue::Integer(id), SqlValue::Integer(user_id)],
        "id",
    )
    .map_err(db_error)?;
    Ok(rows.into_iter().next())
}

/// The user's latest sessions in `root`, plus sessions that predate
/// workspace scoping.
pub fn list_sessions(conn: &Connection, user_id: i64, root: &str) -> AppResult<Vec<AgentSession>> {
    let (condition, params) = if root.is_empty() {
        (
            "user_id = ?1 AND deleted_at IS NULL",
            vec![SqlValue::Integer(user_id)],
        )
    } else {
        (
            "user_id = ?1 AND deleted_at IS NULL AND (workspace_root = ?2 OR workspace_root = '' OR workspace_root IS NULL)",
            vec![SqlValue::Integer(user_id), SqlValue::Text(root.to_owned())],
        )
    };
    rows::select(conn, condition, &params, "updated_at DESC LIMIT 100").map_err(db_error)
}

pub fn new_session(
    user_id: i64,
    title: &str,
    root: &str,
    document: &str,
    prompt: &str,
) -> AgentSession {
    let now = now_millis();
    AgentSession {
        user_id,
        title: title.to_owned(),
        workspace_root: root.to_owned(),
        active_document_path: document.to_owned(),
        status: "idle".into(),
        system_prompt: prompt.to_owned(),
        created_at: now,
        updated_at: now,
        ..AgentSession::default()
    }
}

pub fn delete_session(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE agent_sessions SET deleted_at = ?1 WHERE id = ?2",
        rusqlite::params![now_millis(), id],
    )
    .map_err(db_error)?;
    Ok(())
}

/// Saves the mutable session columns and bumps `updated_at`.
pub fn save_session(conn: &Connection, session: &mut AgentSession) -> AppResult<()> {
    session.updated_at = now_millis();
    conn.execute(
        "UPDATE agent_sessions SET title = ?1, active_document_path = ?2, status = ?3, model_id = ?4, \
         extra_data = ?5, updated_at = ?6 WHERE id = ?7",
        rusqlite::params![
            session.title,
            session.active_document_path,
            session.status,
            session.model_id,
            if session.extra_data.is_null() {
                None
            } else {
                Some(session.extra_data.to_string())
            },
            session.updated_at,
            session.id,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

pub fn set_session_status(conn: &Connection, id: i64, status: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE agent_sessions SET status = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![status, now_millis(), id],
    )
    .map_err(db_error)?;
    Ok(())
}

/// Rows of `T` for a session, oldest first.
pub fn session_rows<T: TableRow>(
    conn: &Connection,
    session_id: i64,
    user_id: i64,
) -> AppResult<Vec<T>> {
    rows::select(
        conn,
        "session_id = ?1 AND user_id = ?2",
        &[SqlValue::Integer(session_id), SqlValue::Integer(user_id)],
        "created_at ASC, id ASC",
    )
    .map_err(db_error)
}

/// The latest `limit` messages, oldest first.
pub fn recent_messages(
    conn: &Connection,
    session_id: i64,
    user_id: i64,
    limit: usize,
) -> AppResult<Vec<AgentMessage>> {
    let mut rows: Vec<AgentMessage> = rows::select(
        conn,
        "session_id = ?1 AND user_id = ?2",
        &[SqlValue::Integer(session_id), SqlValue::Integer(user_id)],
        &format!("created_at DESC, id DESC LIMIT {limit}"),
    )
    .map_err(db_error)?;
    rows.reverse();
    Ok(rows)
}

pub fn new_message(
    session: &AgentSession,
    role: &str,
    content: &str,
    parts: Value,
) -> AgentMessage {
    AgentMessage {
        session_id: session.id,
        user_id: session.user_id,
        role: role.to_owned(),
        content: content.to_owned(),
        parts,
        status: "completed".into(),
        created_at: now_millis(),
        ..AgentMessage::default()
    }
}

/// Inserts a message and returns it with its ID.
pub fn insert_message(conn: &Connection, mut message: AgentMessage) -> AppResult<AgentMessage> {
    message.id = create(conn, &message)?;
    Ok(message)
}

pub fn insert_tool_call(conn: &Connection, mut call: AgentToolCall) -> AppResult<AgentToolCall> {
    call.id = create(conn, &call)?;
    Ok(call)
}

pub fn finish_tool_call(conn: &Connection, call: &mut AgentToolCall) -> AppResult<()> {
    call.updated_at = now_millis();
    conn.execute(
        "UPDATE agent_tool_calls SET output_data = ?1, status = ?2, error_message = ?3, updated_at = ?4 WHERE id = ?5",
        rusqlite::params![
            if call.output_data.is_null() {
                None
            } else {
                Some(call.output_data.to_string())
            },
            call.status,
            call.error_message,
            call.updated_at,
            call.id,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

pub fn find_tool_call(conn: &Connection, id: i64) -> AppResult<Option<AgentToolCall>> {
    rows::find(conn, id).map_err(db_error)
}

pub fn insert_artifact(conn: &Connection, mut artifact: AgentArtifact) -> AppResult<AgentArtifact> {
    artifact.id = create(conn, &artifact)?;
    Ok(artifact)
}

/// Artifacts of a session, newest first.
pub fn recent_artifacts(
    conn: &Connection,
    session_id: i64,
    user_id: i64,
    limit: usize,
) -> AppResult<Vec<AgentArtifact>> {
    rows::select(
        conn,
        "session_id = ?1 AND user_id = ?2",
        &[SqlValue::Integer(session_id), SqlValue::Integer(user_id)],
        &format!("created_at DESC, id DESC LIMIT {limit}"),
    )
    .map_err(db_error)
}

/// The newest artifact created by tools triggered from `message_id`.
pub fn latest_artifact_for_message(
    conn: &Connection,
    session_id: i64,
    user_id: i64,
    message_id: i64,
) -> AppResult<Option<AgentArtifact>> {
    let rows: Vec<AgentArtifact> = rows::select(
        conn,
        "session_id = ?1 AND user_id = ?2 AND tool_call_id IN \
         (SELECT id FROM agent_tool_calls WHERE message_id = ?3)",
        &[
            SqlValue::Integer(session_id),
            SqlValue::Integer(user_id),
            SqlValue::Integer(message_id),
        ],
        "created_at DESC, id DESC LIMIT 1",
    )
    .map_err(db_error)?;
    Ok(rows.into_iter().next())
}

pub fn insert_event(conn: &Connection, mut event: AgentEvent) -> AppResult<AgentEvent> {
    event.id = create(conn, &event)?;
    Ok(event)
}

/// Replaces the plan recorded for one turn.
pub fn replace_plan(
    conn: &Connection,
    session_id: i64,
    user_id: i64,
    message_id: Option<i64>,
    steps: &[(String, String)],
) -> AppResult<()> {
    conn.execute(
        "DELETE FROM agent_plans WHERE session_id = ?1 AND message_id IS ?2",
        rusqlite::params![session_id, message_id],
    )
    .map_err(db_error)?;
    let now = now_millis();
    for (index, (text, status)) in steps.iter().enumerate() {
        create(
            conn,
            &AgentPlanStep {
                session_id,
                user_id,
                message_id,
                step_index: index as i64,
                step_text: text.clone(),
                status: status.clone(),
                updated_at: now,
                ..AgentPlanStep::default()
            },
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use kition_store::Db;

    use super::*;

    #[test]
    fn sessions_round_trip_and_soft_delete() {
        let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        let mut session = new_session(1, "New chat", "/ws", "", "prompt");
        session.id = create(&conn, &session).unwrap_or_else(|err| panic!("{err}"));
        session.title = "Renamed".into();
        save_session(&conn, &mut session).unwrap_or_else(|err| panic!("{err}"));
        let found = find_session(&conn, session.id, 1).unwrap_or_default();
        assert_eq!(found.map(|s| s.title), Some("Renamed".to_owned()));
        assert!(
            find_session(&conn, session.id, 2)
                .unwrap_or_default()
                .is_none()
        );
        assert_eq!(
            list_sessions(&conn, 1, "/other")
                .map(|l| l.len())
                .unwrap_or(9),
            0
        );
        delete_session(&conn, session.id).unwrap_or_else(|err| panic!("{err}"));
        assert!(
            find_session(&conn, session.id, 1)
                .unwrap_or_default()
                .is_none()
        );
    }

    #[test]
    fn recent_messages_are_oldest_first() {
        let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        let session = AgentSession {
            id: 7,
            user_id: 1,
            ..AgentSession::default()
        };
        for text in ["a", "b", "c"] {
            insert_message(&conn, new_message(&session, "user", text, Value::Null))
                .unwrap_or_else(|err| panic!("{err}"));
        }
        let recent = recent_messages(&conn, 7, 1, 2).unwrap_or_default();
        let texts: Vec<_> = recent.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(texts, ["b", "c"]);
    }
}
