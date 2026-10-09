//! The `data_documents` index: one row per known `.kitable` file.

use kition_core::{AppResult, Millis, now_millis};
use kition_store::json_column;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Map, Value};

/// `meta.storage` value marking a row backed by a `.kitable` file.
pub const STORAGE_KITABLE_FILE: &str = "kitable_file";

#[derive(Debug, Clone, PartialEq)]
pub struct DataDocument {
    pub id: i64,
    pub user_id: i64,
    pub workspace_root: String,
    pub path: String,
    pub title: String,
    pub description: String,
    pub icon: String,
    pub color: String,
    pub meta: Value,
    pub created_at: Millis,
    pub updated_at: Millis,
}

impl DataDocument {
    pub fn is_file_backed(&self) -> bool {
        self.meta.get("storage").and_then(Value::as_str) == Some(STORAGE_KITABLE_FILE)
    }
}

const COLUMNS: &str = "id, user_id, workspace_root, path, title, description, icon, color, meta, created_at, updated_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<DataDocument> {
    let text = |i: usize| -> rusqlite::Result<String> {
        Ok(row.get::<_, Option<String>>(i)?.unwrap_or_default())
    };
    Ok(DataDocument {
        id: row.get(0)?,
        user_id: row.get::<_, Option<i64>>(1)?.unwrap_or_default(),
        workspace_root: text(2)?,
        path: text(3)?,
        title: text(4)?,
        description: text(5)?,
        icon: text(6)?,
        color: text(7)?,
        meta: json_column(row.get(8)?),
        created_at: row.get::<_, Option<i64>>(9)?.unwrap_or_default(),
        updated_at: row.get::<_, Option<i64>>(10)?.unwrap_or_default(),
    })
}

/// A live document owned by `user_id`. `id` is matched as text so that
/// malformed IDs simply find nothing.
pub fn find(conn: &Connection, user_id: i64, id: &str) -> AppResult<Option<DataDocument>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM data_documents WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL"),
            params![id, user_id],
            from_row,
        )
        .optional()?)
}

/// The newest live document at `path`, optionally scoped to a workspace root.
pub fn find_by_path(
    conn: &Connection,
    user_id: i64,
    root: &str,
    path: &str,
) -> AppResult<Option<DataDocument>> {
    let sql = if root.is_empty() {
        format!(
            "SELECT {COLUMNS} FROM data_documents WHERE user_id = ?1 AND path = ?2 AND deleted_at IS NULL \
             ORDER BY id DESC LIMIT 1"
        )
    } else {
        format!(
            "SELECT {COLUMNS} FROM data_documents WHERE user_id = ?1 AND path = ?2 AND deleted_at IS NULL \
             AND workspace_root = ?3 ORDER BY id DESC LIMIT 1"
        )
    };
    let result = if root.is_empty() {
        conn.query_row(&sql, params![user_id, path], from_row)
    } else {
        conn.query_row(&sql, params![user_id, path, root], from_row)
    };
    Ok(result.optional()?)
}

pub struct ListQuery<'a> {
    pub user_id: i64,
    pub workspace_root: &'a str,
    pub search: &'a str,
}

/// Live documents, most recently updated first.
pub fn list(conn: &Connection, query: &ListQuery<'_>) -> AppResult<Vec<DataDocument>> {
    let mut sql =
        format!("SELECT {COLUMNS} FROM data_documents WHERE user_id = ?1 AND deleted_at IS NULL");
    let mut values: Vec<rusqlite::types::Value> = vec![query.user_id.into()];
    if !query.workspace_root.is_empty() {
        values.push(query.workspace_root.to_owned().into());
        sql.push_str(&format!(" AND workspace_root = ?{}", values.len()));
    }
    let search = query.search.trim();
    if !search.is_empty() {
        values.push(format!("%{}%", search.to_lowercase()).into());
        let n = values.len();
        sql.push_str(&format!(
            " AND (LOWER(title) LIKE ?{n} OR LOWER(description) LIKE ?{n} OR LOWER(path) LIKE ?{n})"
        ));
    }
    sql.push_str(" ORDER BY updated_at DESC, id DESC");
    let mut statement = conn.prepare(&sql)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(values.iter()), from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Paths of live documents in one workspace.
pub fn indexed_paths(conn: &Connection, user_id: i64, root: &str) -> AppResult<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT path FROM data_documents WHERE user_id = ?1 AND workspace_root = ?2 AND deleted_at IS NULL",
    )?;
    let rows = statement
        .query_map(params![user_id, root], |row| {
            row.get::<_, Option<String>>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().flatten().collect())
}

pub struct NewDocument {
    pub user_id: i64,
    pub workspace_root: String,
    pub path: String,
    pub title: String,
    pub description: String,
    pub icon: String,
    pub color: String,
    pub meta: Map<String, Value>,
}

pub fn insert(conn: &Connection, doc: NewDocument) -> AppResult<DataDocument> {
    let now = now_millis();
    let meta = Value::Object(doc.meta);
    conn.execute(
        "INSERT INTO data_documents (user_id, workspace_root, path, title, description, icon, color, meta, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            doc.user_id,
            doc.workspace_root,
            doc.path,
            doc.title,
            doc.description,
            doc.icon,
            doc.color,
            meta.to_string(),
            now
        ],
    )?;
    Ok(DataDocument {
        id: conn.last_insert_rowid(),
        user_id: doc.user_id,
        workspace_root: doc.workspace_root,
        path: doc.path,
        title: doc.title,
        description: doc.description,
        icon: doc.icon,
        color: doc.color,
        meta,
        created_at: now,
        updated_at: now,
    })
}

/// Writes every column back and bumps `updated_at`.
pub fn save(conn: &Connection, doc: &mut DataDocument) -> AppResult<()> {
    doc.updated_at = now_millis();
    conn.execute(
        "UPDATE data_documents SET workspace_root = ?2, path = ?3, title = ?4, description = ?5, icon = ?6, \
         color = ?7, meta = ?8, updated_at = ?9 WHERE id = ?1",
        params![
            doc.id,
            doc.workspace_root,
            doc.path,
            doc.title,
            doc.description,
            doc.icon,
            doc.color,
            doc.meta.to_string(),
            doc.updated_at
        ],
    )?;
    Ok(())
}

pub fn soft_delete(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE data_documents SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![id, now_millis()],
    )?;
    Ok(())
}

/// Records the root a document was actually found under.
pub fn set_workspace_root(conn: &Connection, id: i64, root: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE data_documents SET workspace_root = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, root, now_millis()],
    )?;
    Ok(())
}

/// Moves every live row at `path` to `target`; returns how many moved.
pub fn rename_path(
    conn: &Connection,
    user_id: i64,
    root: &str,
    path: &str,
    target: &str,
) -> AppResult<usize> {
    let now = now_millis();
    let count = if root.is_empty() {
        conn.execute(
            "UPDATE data_documents SET path = ?3, updated_at = ?4 WHERE user_id = ?1 AND path = ?2 AND deleted_at IS NULL",
            params![user_id, path, target, now],
        )?
    } else {
        conn.execute(
            "UPDATE data_documents SET path = ?3, updated_at = ?4 \
             WHERE user_id = ?1 AND path = ?2 AND workspace_root = ?5 AND deleted_at IS NULL",
            params![user_id, path, target, now, root],
        )?
    };
    Ok(count)
}

/// Live rows at `path`, optionally scoped to a workspace root.
pub fn list_by_path(
    conn: &Connection,
    user_id: i64,
    root: &str,
    path: &str,
) -> AppResult<Vec<DataDocument>> {
    let mut sql = format!(
        "SELECT {COLUMNS} FROM data_documents WHERE user_id = ?1 AND path = ?2 AND deleted_at IS NULL"
    );
    if !root.is_empty() {
        sql.push_str(" AND workspace_root = ?3");
    }
    let mut statement = conn.prepare(&sql)?;
    let rows = if root.is_empty() {
        statement
            .query_map(params![user_id, path], from_row)?
            .collect::<Result<Vec<_>, _>>()?
    } else {
        statement
            .query_map(params![user_id, path, root], from_row)?
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(rows)
}
