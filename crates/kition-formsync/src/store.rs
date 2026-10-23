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
        document_path: text(8)?,
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
    document_path: &str,
    table_id: &str,
) -> AppResult<Option<Workflow>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM form_sync_workflows WHERE user_id = ?1 AND template_id = ?2 \
                 AND document_id = ?3 AND table_id = ?4 LIMIT 1"
            ),
            params![user_id, template_id, document_path, table_id],
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
            w.document_path,
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

/// `path` after the table file (or folder) `from` moved to `to`; `None` when it is not under it.
fn moved_path(path: &str, from: &str, to: &str) -> Option<String> {
    if path == from {
        Some(to.to_owned())
    } else {
        path.strip_prefix(&format!("{from}/"))
            .map(|rest| format!("{to}/{rest}"))
    }
}

/// Follows a table file renamed or moved from `from` to `to` (a folder moves every file under
/// it): the form sync targets that name it name the new path. Answers how many changed.
pub fn rename_document_path(conn: &Connection, from: &str, to: &str) -> AppResult<usize> {
    let (from, to) = (
        from.trim().trim_end_matches('/'),
        to.trim().trim_end_matches('/'),
    );
    if from.is_empty() || to.is_empty() || from == to {
        return Ok(0);
    }
    let mut changed = 0;
    for mut workflow in list_all(conn)? {
        let Some(path) = moved_path(&workflow.document_path, from, to) else {
            continue;
        };
        let mut target = workflow.target();
        target.document_path = path.clone();
        workflow.document_path = path;
        workflow.target_json = serde_json::to_string(&target).unwrap_or_default();
        save(conn, &mut workflow)?;
        changed += 1;
    }
    Ok(changed)
}

/// Whether `path` is the deleted table file `gone`, or a file under the deleted folder `gone`.
fn is_under(path: &str, gone: &str) -> bool {
    let path = path.trim();
    path == gone || path.starts_with(&format!("{gone}/"))
}

/// Follows a deleted table file (or folder of them): removes the form sync workflows that write
/// to it, with their synced items. Answers how many were removed.
pub fn delete_by_document_path(conn: &Connection, path: &str) -> AppResult<usize> {
    let gone = path.trim().trim_end_matches('/');
    if gone.is_empty() {
        return Ok(0);
    }
    let mut removed = 0;
    for workflow in list_all(conn)? {
        if !is_under(&workflow.document_path, gone) {
            continue;
        }
        conn.execute(
            "DELETE FROM form_sync_items WHERE workflow_id = ?1",
            [&workflow.id],
        )?;
        removed += conn.execute(
            "DELETE FROM form_sync_workflows WHERE id = ?1",
            [&workflow.id],
        )?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workflow(id: &str, path: &str) -> Workflow {
        Workflow {
            id: id.into(),
            user_id: 1,
            name: id.into(),
            template_id: "lead-form".into(),
            binding_id: format!("binding_{id}"),
            document_path: path.into(),
            table_id: "1".into(),
            ..Workflow::default()
        }
    }

    #[test]
    fn deleting_a_table_file_removes_its_form_syncs() {
        let db = kition_store::Db::open_in_memory().unwrap_or_else(|e| panic!("{e}"));
        let conn = db.conn().unwrap_or_else(|e| panic!("{e}"));
        for (id, path) in [
            ("f1", "crm/Leads.ktable"),
            ("f2", "crm/More.ktable"),
            ("f3", "crm-old/Leads.ktable"),
        ] {
            insert(&conn, &mut workflow(id, path)).unwrap_or_else(|e| panic!("{e}"));
        }
        save_item(&conn, "f1", "s1", "7", 1).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            delete_by_document_path(&conn, "crm/Leads.ktable").ok(),
            Some(1)
        );
        assert!(!has_item(&conn, "f1", "s1").unwrap_or(true));
        assert_eq!(delete_by_document_path(&conn, "crm/").ok(), Some(1));
        assert_eq!(delete_by_document_path(&conn, "").ok(), Some(0));
        let left: Vec<String> = list_all(&conn)
            .unwrap_or_default()
            .into_iter()
            .map(|w| w.id)
            .collect();
        assert_eq!(left, vec!["f3".to_owned()]);
    }
}
