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

use crate::{KitableError, Result, file};

/// Above this many change rows, or this many bytes of change rows, [`should_compact`] says yes.
const COMPACT_MAX_CHANGES: i64 = 500;
const COMPACT_MAX_BYTES: i64 = 1024 * 1024;

const PROJECTED_GENERATION_KEY: &str = "kdm_projected_generation";
const PROJECTED_SEQ_KEY: &str = "kdm_projected_seq";

/// The document id [`save_initial`] records, so [`append`] and [`compact`] can refuse a replica of
/// another document (one loaded from the wrong file, or a programming mistake).
const DOC_ID_KEY: &str = "kdm_doc_id";

/// Creates the KDM tables and columns if they are missing, and the indexes that keep `kdm_id`
/// unique per live row. Safe to call on a file that already has them.
pub fn ensure_tables(conn: &Connection) -> Result<()> {
    for create in crate::schema::KDM_TABLES {
        conn.execute_batch(create)?;
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

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    Ok(file::column_names(conn, table)?
        .iter()
        .any(|name| name == column))
}

/// Loads the stored replica: the snapshot, then every change row in `seq` order. `None` when
/// `kition_kdm` has no row (the file predates the KDM, or has not been initialized yet).
///
/// [`KitableError::Kdm`] when, after importing every row, the replica still has changes pending on
/// others that the log does not hold ([`Replica::has_pending_changes`]): the change log is broken,
/// for instance a row was lost between `append` calls, or one was written against a `since` the
/// log never actually reached. The store's invariant is that importing the whole log in `seq`
/// order always leaves nothing pending; this is never silently swallowed into an incomplete
/// replica.
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
    if replica.has_pending_changes() {
        return Err(KitableError::Kdm(
            "the kdm change log is broken: a stored change depends on changes the log does not hold".into(),
        ));
    }
    Ok(Some(replica))
}

/// Writes `replica`'s snapshot as generation 1 and records its document id. Fails if `kition_kdm`
/// already has a row (its primary key is fixed at 1).
pub fn save_initial(conn: &Connection, replica: &Replica, now: i64) -> Result<()> {
    let snapshot = replica.snapshot()?;
    conn.execute(
        "INSERT INTO kition_kdm (id, snapshot, generation, updated_at) VALUES (1, ?1, 1, ?2)",
        params![snapshot, now],
    )?;
    file::set_meta(conn, DOC_ID_KEY, &replica.doc_id().to_string())?;
    Ok(())
}

/// Refuses `replica` if a document id was recorded (by [`save_initial`]) and it does not match.
/// Does nothing when none was recorded yet, so this stays usable before `save_initial` runs.
fn check_doc_id(conn: &Connection, replica: &Replica) -> Result<()> {
    let Some(stored) = file::get_meta(conn, DOC_ID_KEY)? else {
        return Ok(());
    };
    let found = replica.doc_id().to_string();
    if stored != found {
        return Err(KitableError::invalid(format!(
            "kdm replica is document {found}, but this file holds the KDM replica of document {stored}"
        )));
    }
    Ok(())
}

/// Appends one change row holding every change `replica` has beyond `since`. Returns its `seq`.
/// A no-op (returns the last existing `seq`, or 0 when the log has never held a row) when `since`
/// already includes everything `replica` has: not only when the two versions are equal, but also
/// when `since` is strictly ahead of `replica` (another writer already stored more than `replica`
/// knows about) or holds concurrent changes `replica` lacks. There is nothing to export either
/// way: [`Version::includes`] is the right comparison, not equality.
///
/// `since` must be the version the store last accepted: the stored replica's own version right
/// after the last successful [`save_initial`] or `append` (for instance, [`load`]'s version, or an
/// in-memory replica's version taken immediately after its own last successful `append`). Taking
/// `since` from an in-memory replica that kept transacting after one of its `append` calls was
/// rolled back (its SQL transaction failed or was abandoned) would skip the changes made in
/// between: the engine already reflects them, but they never reached storage.
pub fn append(
    conn: &Connection,
    replica: &Replica,
    since: &Version,
    origin: &str,
    now: i64,
) -> Result<i64> {
    check_doc_id(conn, replica)?;
    if since.includes(&replica.version()) {
        return last_seq(conn);
    }
    let bytes = replica.export_changes(since)?;
    conn.execute(
        "INSERT INTO kition_kdm_changes (bytes, origin, created_at) VALUES (?1, ?2, ?3)",
        params![bytes, origin, now],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The highest `seq` ever inserted into `kition_kdm_changes`, including generations [`compact`]
/// has since cleared. SQLite's `AUTOINCREMENT` counter (`sqlite_sequence`) survives the `DELETE`
/// that empties the table on compaction, so seqs keep increasing across generations; reading
/// `MAX(seq)` instead would wrongly read back as 0 right after a compact, and a seq could be
/// reused. 0 when the table has never held a row (the counter is created on its first insert).
fn last_seq(conn: &Connection) -> Result<i64> {
    Ok(conn
        .query_row(
            "SELECT seq FROM sqlite_sequence WHERE name = 'kition_kdm_changes'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

/// Writes `replica`'s snapshot, increments `generation`, and deletes every change row: the
/// snapshot already carries them.
pub fn compact(conn: &Connection, replica: &Replica, now: i64) -> Result<()> {
    check_doc_id(conn, replica)?;
    let snapshot = replica.snapshot()?;
    let updated = conn.execute(
        "UPDATE kition_kdm SET snapshot = ?1, generation = generation + 1, updated_at = ?2 WHERE id = 1",
        params![snapshot, now],
    )?;
    if updated == 0 {
        return Err(KitableError::invalid(
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
/// row; the seq is 0 when the change log has never held a row.
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

/// `None` when `key` is unset; [`KitableError::Invalid`] when it is set but is not an integer
/// (corrupt `kition_meta`), rather than silently reading as missing.
fn get_meta_i64(conn: &Connection, key: &str) -> Result<Option<i64>> {
    let Some(value) = file::get_meta(conn, key)? else {
        return Ok(None);
    };
    value.parse().map(Some).map_err(|_| {
        KitableError::invalid(format!("kition_meta.{key} is not an integer: {value:?}"))
    })
}

fn set_meta_i64(conn: &Connection, key: &str, value: i64) -> Result<()> {
    file::set_meta(conn, key, &value.to_string())
}
