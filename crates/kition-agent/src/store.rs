//! The `agent_sessions` table: the session index. Conversations live in
//! the session event log (`agent_session_events`).

use kition_core::{AppError, AppResult, now_millis};
use kition_store::row_type;
use kition_store::rows::{self, TableRow};
use rusqlite::Connection;
use rusqlite::types::Value as SqlValue;

row_type!(AgentSession, "agent_sessions", {
    user_id: int,
    title: text,
    workspace_root: text,
    active_document_path: text,
    model_id: text,
    extra_data: json,
    created_at: time,
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

pub fn new_session(user_id: i64, title: &str, root: &str, document: &str) -> AgentSession {
    let now = now_millis();
    AgentSession {
        user_id,
        title: title.to_owned(),
        workspace_root: root.to_owned(),
        active_document_path: document.to_owned(),
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
        "UPDATE agent_sessions SET title = ?1, active_document_path = ?2, model_id = ?3, \
         extra_data = ?4, updated_at = ?5 WHERE id = ?6",
        rusqlite::params![
            session.title,
            session.active_document_path,
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

#[cfg(test)]
mod tests {
    use kition_store::Db;

    use super::*;

    #[test]
    fn sessions_round_trip_and_soft_delete() {
        let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        let mut session = new_session(1, "New chat", "/ws", "");
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
}
