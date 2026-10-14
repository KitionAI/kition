//! Storage for a table's KDM replica inside its `.kitable` file.
//!
//! The replica lives as a compacted snapshot (`kition_kdm`) plus an append-only log of changes
//! since that snapshot (`kition_kdm_changes`). The relational tables (`kition_tables`,
//! `kition_fields`, ...) are a projection of the replica, written separately by a projector; this
//! module only stores and loads the replica itself.
//!
//! Every function here takes a plain `&Connection`. Callers that need crash safety open their own
//! SQL transaction and pass its `rusqlite::Transaction` (which derefs to `Connection`): if the
//! transaction is rolled back, nothing written through it is kept. None of these functions start
//! or end a transaction themselves.

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension, params};

use kition_kdm::{ActorId, Replica, Schema, Version};

use crate::Result;

/// Above this many change rows, or this many bytes of change rows, [`should_compact`] says yes.
const COMPACT_MAX_CHANGES: i64 = 500;
const COMPACT_MAX_BYTES: i64 = 1024 * 1024;

const PROJECTED_GENERATION_KEY: &str = "kdm_projected_generation";
const PROJECTED_SEQ_KEY: &str = "kdm_projected_seq";

/// Creates the KDM tables and columns if they are missing, and the indexes that keep `kdm_id`
/// unique per live row. Safe to call on a file that already has them.
pub fn ensure_tables(conn: &Connection) -> crate::Result<()> {
    for create in crate::schema::KDM_TABLES {
        conn.execute_batch(&create.replacen("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1))?;
    }
    for (table, column) in crate::schema::KDM_COLUMNS {
        if !has_column(conn, table, column)? {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"))?;
        }
    }
    for index in crate::schema::KDM_INDEXES {
        conn.execute_batch(index)?;
    }
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> crate::Result<bool> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let found = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == column);
    Ok(found)
}

/// Loads the stored replica: the snapshot, then every change row in `seq` order. `None` when
/// `kition_kdm` has no row (the file predates the KDM, or has not been initialized yet).
pub fn load(conn: &Connection, schema: Arc<Schema>, actor: ActorId) -> Result<Option<Replica>> {
    let snapshot: Option<Vec<u8>> = conn
        .query_row("SELECT snapshot FROM kition_kdm WHERE id = 1", [], |row| {
            row.get(0)
        })
        .optional()?;
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    let mut replica = Replica::load(schema, &snapshot, actor)?;
    let mut statement = conn.prepare("SELECT bytes FROM kition_kdm_changes ORDER BY seq ASC")?;
    let rows = statement
        .query_map([], |row| row.get::<_, Vec<u8>>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for bytes in rows {
        replica.import_changes(&bytes)?;
    }
    Ok(Some(replica))
}

/// Writes `replica`'s snapshot as generation 1. Fails if `kition_kdm` already has a row (its
/// primary key is fixed at 1).
pub fn save_initial(conn: &Connection, replica: &Replica, now: i64) -> Result<()> {
    let snapshot = replica.snapshot()?;
    conn.execute(
        "INSERT INTO kition_kdm (id, snapshot, generation, updated_at) VALUES (1, ?1, 1, ?2)",
        params![snapshot, now],
    )?;
    Ok(())
}

/// Appends one change row holding every change `replica` has beyond `since`. Returns its `seq`.
/// A no-op (returns the last existing `seq`, or 0) when `replica` has nothing beyond `since`.
pub fn append(
    conn: &Connection,
    replica: &Replica,
    since: &Version,
    origin: &str,
    now: i64,
) -> Result<i64> {
    if replica.version() == *since {
        return last_seq(conn);
    }
    let bytes = replica.export_changes(since)?;
    conn.execute(
        "INSERT INTO kition_kdm_changes (bytes, origin, created_at) VALUES (?1, ?2, ?3)",
        params![bytes, origin, now],
    )?;
    Ok(conn.last_insert_rowid())
}

fn last_seq(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM kition_kdm_changes",
        [],
        |row| row.get(0),
    )?)
}

/// Writes `replica`'s snapshot, increments `generation`, and deletes every change row: the
/// snapshot already carries them.
pub fn compact(conn: &Connection, replica: &Replica, now: i64) -> Result<()> {
    let snapshot = replica.snapshot()?;
    let updated = conn.execute(
        "UPDATE kition_kdm SET snapshot = ?1, generation = generation + 1, updated_at = ?2 WHERE id = 1",
        params![snapshot, now],
    )?;
    if updated == 0 {
        return Err(crate::KitableError::invalid(
            "kdm replica is not initialized; call save_initial first",
        ));
    }
    conn.execute("DELETE FROM kition_kdm_changes", [])?;
    Ok(())
}

/// Whether the change log has grown enough that [`compact`] is worth running: more than 500
/// change rows, or more than 1 MiB of them.
pub fn should_compact(conn: &Connection) -> Result<bool> {
    let (count, bytes): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(bytes)), 0) FROM kition_kdm_changes",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(count > COMPACT_MAX_CHANGES || bytes > COMPACT_MAX_BYTES)
}

/// The stored replica's position: `(generation, last seq)`. `(0, 0)` when `kition_kdm` has no
/// row; the seq is 0 when the change log is empty.
pub fn stored_position(conn: &Connection) -> Result<(i64, i64)> {
    let generation: Option<i64> = conn
        .query_row(
            "SELECT generation FROM kition_kdm WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok((generation.unwrap_or(0), last_seq(conn)?))
}

/// The projection's last-applied position, as recorded in `kition_meta`. `(0, 0)` when the
/// projector has not run yet.
pub fn projected_position(conn: &Connection) -> Result<(i64, i64)> {
    Ok((
        get_meta_i64(conn, PROJECTED_GENERATION_KEY)?.unwrap_or(0),
        get_meta_i64(conn, PROJECTED_SEQ_KEY)?.unwrap_or(0),
    ))
}

/// Records the projection's last-applied position.
pub fn set_projected_position(conn: &Connection, position: (i64, i64)) -> Result<()> {
    set_meta_i64(conn, PROJECTED_GENERATION_KEY, position.0)?;
    set_meta_i64(conn, PROJECTED_SEQ_KEY, position.1)?;
    Ok(())
}

fn get_meta_i64(conn: &Connection, key: &str) -> Result<Option<i64>> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM kition_meta WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value.and_then(|value| value.parse().ok()))
}

fn set_meta_i64(conn: &Connection, key: &str, value: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO kition_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )?;
    Ok(())
}
