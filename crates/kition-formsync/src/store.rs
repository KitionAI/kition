//! `form_sync_workflows` and `form_sync_items`.

use kition_core::{AppResult, Millis, now_millis};
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::types::Workflow;

const COLUMNS: &str = "id, user_id, name, template_id, binding_id, remote_source_id, public_url, published, document_id, \
    table_id, fields_json, target_json, schedule_enabled, interval_minutes, status, cursor_id, last_sync_at, next_sync_at, \
    last_error, synced_submissions, created_at, updated_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Workflow> {
    let text = |i: usize| -> rusqlite::Result<String> {
        Ok(row.get::<_, Option<String>>(i)?.unwrap_or_default())
    };
    let int = |i: usize| -> rusqlite::Result<i64> {
        Ok(row.get::<_, Option<i64>>(i)?.unwrap_or_default())
    };
    Ok(Workflow {
        id: row.get(0)?,
        user_id: int(1)?,
        name: text(2)?,
        template_id: text(3)?,
        binding_id: text(4)?,
        remote_source_id: text(5)?,
        public_url: text(6)?,
        published: int(7)? != 0,
        document_id: text(8)?,
        table_id: text(9)?,
        fields_json: text(10)?,
        target_json: text(11)?,
        schedule_enabled: int(12)? != 0,
        interval_minutes: int(13)?,
        status: text(14)?,
        cursor_id: int(15)?,
        last_sync_at: row.get(16)?,
        next_sync_at: row.get(17)?,
        last_error: text(18)?,
        synced_submissions: int(19)?,
        created_at: int(20)?,
        updated_at: int(21)?,
    })
}

pub fn list(conn: &Connection, user_id: i64) -> AppResult<Vec<Workflow>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM form_sync_workflows WHERE user_id = ?1 ORDER BY created_at DESC"
    ))?;
    Ok(statement
        .query_map([user_id], from_row)?
        .collect::<Result<Vec<_>, _>>()?)
}

pub fn list_all(conn: &Connection) -> AppResult<Vec<Workflow>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM form_sync_workflows ORDER BY id ASC"
    ))?;
    Ok(statement
        .query_map([], from_row)?
        .collect::<Result<Vec<_>, _>>()?)
}

pub fn list_due(conn: &Connection, now: Millis) -> AppResult<Vec<Workflow>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM form_sync_workflows WHERE published = 1 AND schedule_enabled = 1 \
         AND next_sync_at IS NOT NULL AND next_sync_at <= ?1"
    ))?;
    Ok(statement
        .query_map([now], from_row)?
        .collect::<Result<Vec<_>, _>>()?)
}

pub fn get(conn: &Connection, user_id: i64, id: &str) -> AppResult<Option<Workflow>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM form_sync_workflows WHERE user_id = ?1 AND id = ?2 LIMIT 1"
            ),
            params![user_id, id],
            from_row,
        )
        .optional()?)
}

pub fn get_by_target(
    conn: &Connection,
    user_id: i64,
    template_id: &str,
    document_id: &str,
    table_id: &str,
) -> AppResult<Option<Workflow>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM form_sync_workflows WHERE user_id = ?1 AND template_id = ?2 \
                 AND document_id = ?3 AND table_id = ?4 LIMIT 1"
            ),
            params![user_id, template_id, document_id, table_id],
            from_row,
        )
        .optional()?)
}

pub fn insert(conn: &Connection, workflow: &mut Workflow) -> AppResult<()> {
    let now = now_millis();
    workflow.created_at = now;
    workflow.updated_at = now;
    write(conn, workflow, true)
}

/// Writes every column and bumps `updated_at`.
pub fn save(conn: &Connection, workflow: &mut Workflow) -> AppResult<()> {
    workflow.updated_at = now_millis();
    write(conn, workflow, false)
}

/// Inserts or replaces a row exactly as given (used when importing state).
pub fn upsert_exact(conn: &Connection, workflow: &Workflow) -> AppResult<()> {
    write(conn, workflow, true)
}

fn write(conn: &Connection, w: &Workflow, insert: bool) -> AppResult<()> {
    let verb = if insert {
        "INSERT OR REPLACE"
    } else {
        "REPLACE"
    };
    conn.execute(
        &format!(
            "{verb} INTO form_sync_workflows ({COLUMNS}) VALUES \
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)"
        ),
        params![
            w.id,
            w.user_id,
            w.name,
            w.template_id,
            w.binding_id,
            w.remote_source_id,
            w.public_url,
            w.published,
            w.document_id,
            w.table_id,
            w.fields_json,
            w.target_json,
            w.schedule_enabled,
            w.interval_minutes,
            w.status,
            w.cursor_id,
            w.last_sync_at,
            w.next_sync_at,
            w.last_error,
            w.synced_submissions,
            w.created_at,
            w.updated_at
        ],
    )?;
    Ok(())
}

pub fn has_item(conn: &Connection, workflow_id: &str, submission_id: &str) -> AppResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM form_sync_items WHERE workflow_id = ?1 AND submission_id = ?2",
        params![workflow_id, submission_id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Records a processed submission once.
pub fn save_item(
    conn: &Connection,
    workflow_id: &str,
    submission_id: &str,
    record_id: &str,
    completed_at: Millis,
) -> AppResult<()> {
    let now = now_millis();
    conn.execute(
        "INSERT OR IGNORE INTO form_sync_items (workflow_id, submission_id, record_id, completed_at, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![workflow_id, submission_id, record_id, completed_at, now],
    )?;
    Ok(())
}
