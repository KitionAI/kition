//! Startup migration.
//!
//! Brings any database up to [`SCHEMA_VERSION`]:
//!
//! 1. Creates missing tables, adds missing columns, creates missing indexes.
//! 2. On databases from older runtimes (`user_version` below 2), converts
//!    text timestamps in `datetime` columns to Unix milliseconds. A copy of
//!    the original file is written next to it first.

use std::path::Path;

use kition_core::time::parse_legacy;
use kition_core::{AppError, AppResult, now_millis};
use rusqlite::{Connection, params};

use crate::schema::{self, MAIN_SQL};

/// Version 2: every timestamp column holds Unix milliseconds.
pub const SCHEMA_VERSION: i64 = 2;

/// The legacy zero time, `0001-01-01T00:00:00Z`, which meant "unset".
const LEGACY_ZERO_TIME: i64 = -62_135_596_800_000;

pub fn run(conn: &mut Connection, path: &Path) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let schema = schema::parse(MAIN_SQL);

    let legacy_columns = if version < SCHEMA_VERSION {
        legacy_time_columns(conn)?
    } else {
        Vec::new()
    };
    let needs_conversion = legacy_columns
        .iter()
        .map(|(table, column)| text_count(conn, table, column))
        .collect::<AppResult<Vec<_>>>()?
        .into_iter()
        .any(|count| count > 0);
    if needs_conversion {
        backup(conn, path)?;
    }

    let tx = conn.transaction()?;
    for table in &schema.tables {
        let existing = column_names(&tx, &table.name)?;
        if existing.is_empty() {
            tx.execute_batch(&table.create_sql)?;
            continue;
        }
        for column in &table.columns {
            if !existing
                .iter()
                .any(|name| name.eq_ignore_ascii_case(&column.name))
            {
                tx.execute_batch(&format!(
                    "ALTER TABLE `{}` ADD `{}` {}",
                    table.name, column.name, column.definition
                ))?;
                backfill_added_column(&tx, &table.name, &column.name)?;
            }
        }
    }
    for index in &schema.indexes {
        tx.execute_batch(&index.create_sql)?;
    }
    for (table, column) in &legacy_columns {
        convert_column(&tx, table, column)?;
    }
    if version < SCHEMA_VERSION {
        tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    }
    tx.commit()?;
    Ok(())
}

/// Data fixes that must run when a column first appears.
fn backfill_added_column(conn: &Connection, table: &str, column: &str) -> AppResult<()> {
    // Forms that already had a cloud source were published before the
    // `published` flag existed.
    if table == "form_sync_workflows" && column == "published" {
        conn.execute(
            "UPDATE form_sync_workflows SET published = 1 WHERE remote_source_id <> ''",
            [],
        )?;
    }
    Ok(())
}

fn column_names(conn: &Connection, table: &str) -> AppResult<Vec<String>> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info(`{table}`)"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names)
}

/// Every `datetime` column in every existing user table.
fn legacy_time_columns(conn: &Connection) -> AppResult<Vec<(String, String)>> {
    let mut tables = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )?;
    let names = tables
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut columns = Vec::new();
    for table in names {
        let mut info = conn.prepare(&format!("PRAGMA table_info(`{table}`)"))?;
        let rows = info
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (name, declared) in rows {
            if declared.eq_ignore_ascii_case("datetime") {
                columns.push((table.clone(), name));
            }
        }
    }
    Ok(columns)
}

fn text_count(conn: &Connection, table: &str, column: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        &format!("SELECT COUNT(*) FROM `{table}` WHERE typeof(`{column}`) = 'text'"),
        [],
        |row| row.get(0),
    )?)
}

fn convert_column(conn: &Connection, table: &str, column: &str) -> AppResult<()> {
    let mut select = conn.prepare(&format!(
        "SELECT rowid, `{column}` FROM `{table}` WHERE typeof(`{column}`) = 'text'"
    ))?;
    let rows = select
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut update = conn.prepare(&format!(
        "UPDATE `{table}` SET `{column}` = ?1 WHERE rowid = ?2"
    ))?;
    for (rowid, text) in rows {
        let millis = match parse_legacy(&text) {
            Some(LEGACY_ZERO_TIME) | None => 0,
            Some(millis) => millis,
        };
        update.execute(params![millis, rowid])?;
    }
    Ok(())
}

fn backup(conn: &Connection, path: &Path) -> AppResult<()> {
    if path.as_os_str() == ":memory:" {
        return Ok(());
    }
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "kition.db".to_owned());
    let target = path.with_file_name(format!(
        "{file_name}.before-v{SCHEMA_VERSION}-{}.bak",
        now_millis()
    ));
    let target_text = target
        .to_str()
        .ok_or_else(|| AppError::internal("database backup path is not valid UTF-8"))?;
    conn.execute("VACUUM INTO ?1", [target_text])?;
    tracing::info!(backup = %target.display(), "backed up database before timestamp migration");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        Connection::open_in_memory().unwrap_or_else(|err| panic!("{err}"))
    }

    #[test]
    fn creates_schema_on_empty_database() {
        let mut conn = fresh();
        run(&mut conn, Path::new(":memory:")).unwrap_or_else(|err| panic!("{err}"));
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_default();
        assert_eq!(tables, 20);
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap_or_default();
        assert_eq!(version, SCHEMA_VERSION);
        run(&mut conn, Path::new(":memory:")).unwrap_or_else(|err| panic!("rerun: {err}"));
    }

    #[test]
    fn upgrades_legacy_database() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let path = dir.path().join("legacy.db");
        let mut conn = Connection::open(&path).unwrap_or_else(|err| panic!("{err}"));
        conn.execute_batch(
            "CREATE TABLE `users` (`id` integer PRIMARY KEY AUTOINCREMENT,`username` text NOT NULL,\
             `email` text NOT NULL,`password_hash` text NOT NULL,`created_at` datetime,`updated_at` datetime,\
             `last_login_at` datetime,`deleted_at` datetime);
             INSERT INTO users (username, email, password_hash, created_at, updated_at, last_login_at)
             VALUES ('a', 'a@x', 'h', '2026-10-09 11:57:06.334767+08:00', '0001-01-01 00:00:00+00:00', NULL);",
        )
        .unwrap_or_else(|err| panic!("{err}"));

        run(&mut conn, &path).unwrap_or_else(|err| panic!("{err}"));

        let (created, updated, last_login): (i64, i64, Option<i64>) = conn
            .query_row(
                "SELECT created_at, updated_at, last_login_at FROM users",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(created, 1_791_518_226_334);
        assert_eq!(updated, 0);
        assert_eq!(last_login, None);
        let columns = column_names(&conn, "users").unwrap_or_default();
        assert!(
            columns.iter().any(|c| c == "nickname"),
            "missing columns are added"
        );
        let backups = std::fs::read_dir(dir.path())
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|e| e.file_name().to_string_lossy().contains(".before-v2-"))
                    .count()
            })
            .unwrap_or_default();
        assert_eq!(backups, 1);
    }
}
