//! Per-record change history.

use kition_core::{Millis, now_millis};
use rusqlite::{Connection, Row, params};
use serde::Serialize;
use serde_json::Value;

use crate::{KitableError, KitableFile, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryAction {
    Create,
    Update,
    Delete,
    Duplicate,
    Link,
    Unlink,
}

impl HistoryAction {
    pub fn as_str(self) -> &'static str {
        match self {
            HistoryAction::Create => "create",
            HistoryAction::Update => "update",
            HistoryAction::Delete => "delete",
            HistoryAction::Duplicate => "duplicate",
            HistoryAction::Link => "link",
            HistoryAction::Unlink => "unlink",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub document_id: String,
    pub table_id: i64,
    pub record_id: i64,
    pub field_id: Option<i64>,
    pub action: String,
    pub before: Value,
    pub after: Value,
    pub actor: String,
    pub created_at: Millis,
}

pub(crate) struct HistoryWrite<'a> {
    pub document_id: &'a str,
    pub table_id: i64,
    pub record_id: i64,
    pub field_id: Option<i64>,
    pub action: HistoryAction,
    pub before: Value,
    pub after: Value,
    pub actor: &'a str,
}

fn parse_payload(raw: &str) -> Value {
    if raw.is_empty() || raw == "null" {
        return Value::Null;
    }
    serde_json::from_str(raw).unwrap_or(Value::Null)
}

fn entry_from_row(row: &Row<'_>) -> rusqlite::Result<HistoryEntry> {
    Ok(HistoryEntry {
        id: row.get(0)?,
        document_id: row.get(1)?,
        table_id: row.get(2)?,
        record_id: row.get(3)?,
        field_id: row.get(4)?,
        action: row.get(5)?,
        before: parse_payload(&row.get::<_, String>(6)?),
        after: parse_payload(&row.get::<_, String>(7)?),
        actor: row.get(8)?,
        created_at: row.get(9)?,
    })
}

impl KitableFile {
    /// Newest first; `limit <= 0` returns everything. Also returns the total.
    pub fn list_record_history(
        &self,
        table_id: i64,
        record_id: i64,
        limit: i64,
        offset: i64,
    ) -> Result<(Vec<HistoryEntry>, i64)> {
        if table_id <= 0 || record_id <= 0 {
            return Err(KitableError::invalid("table_id and record_id are required"));
        }
        let total: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM kition_record_history WHERE table_id = ?1 AND record_id = ?2",
            params![table_id, record_id],
            |row| row.get(0),
        )?;
        let base = "SELECT id, document_id, table_id, record_id, field_id, action, before_json, after_json, actor, created_at \
                    FROM kition_record_history WHERE table_id = ?1 AND record_id = ?2 ORDER BY id DESC";
        let entries = if limit > 0 {
            let mut statement = self.conn.prepare(&format!("{base} LIMIT ?3 OFFSET ?4"))?;
            statement
                .query_map(
                    params![table_id, record_id, limit, offset.max(0)],
                    entry_from_row,
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            let mut statement = self.conn.prepare(base)?;
            statement
                .query_map(params![table_id, record_id], entry_from_row)?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        Ok((entries, total))
    }

    pub(crate) fn write_record_history(&self, write: &HistoryWrite<'_>) -> Result<()> {
        insert_history(&self.conn, write, now_millis())
    }
}

/// Inserts one history row created at `created_at`.
pub(crate) fn insert_history(
    conn: &Connection,
    write: &HistoryWrite<'_>,
    created_at: Millis,
) -> Result<()> {
    conn.prepare_cached(
        "INSERT INTO kition_record_history (document_id, table_id, record_id, field_id, action, before_json, after_json, actor, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?
    .execute(params![
        write.document_id,
        write.table_id,
        write.record_id,
        write.field_id,
        write.action.as_str(),
        write.before.to_string(),
        write.after.to_string(),
        write.actor,
        created_at
    ])?;
    Ok(())
}
