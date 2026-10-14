//! Opening, creating, and migrating `.kitable` files.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kition_core::time::parse_legacy;
use kition_core::{Millis, now_millis};
use rusqlite::{Connection, OptionalExtension, params};

use crate::schema::{INDEXES, TABLES};
use crate::{KitableError, Result};

pub const FORMAT: &str = "kition-kitable";
pub const FORMAT_VERSION: i64 = 1;
/// Version 3: timestamps are INTEGER Unix milliseconds.
pub const SCHEMA_VERSION: i64 = 3;

#[derive(Debug, Default, Clone)]
pub struct CreateOptions {
    pub title: String,
    pub document_id: String,
    pub description: String,
    pub icon: String,
    pub color: String,
    pub meta_json: String,
    pub created_at: Option<Millis>,
    pub updated_at: Option<Millis>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Info {
    pub path: PathBuf,
    pub document_id: String,
    pub title: String,
    pub format: String,
    pub format_version: i64,
    pub schema_version: i64,
    pub created_at: Millis,
    pub updated_at: Millis,
}

/// An open `.kitable` file. Holds a single connection.
pub struct KitableFile {
    pub(crate) conn: Connection,
    path: PathBuf,
}

impl std::fmt::Debug for KitableFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KitableFile")
            .field("path", &self.path)
            .finish()
    }
}

impl KitableFile {
    /// Creates a new file; appends `.kitable` when `path` has no extension.
    pub fn create(path: &Path, options: &CreateOptions) -> Result<Self> {
        let mut path = path.to_path_buf();
        if path.as_os_str().is_empty() {
            return Err(KitableError::invalid("kitable path is required"));
        }
        if path.extension().is_none() {
            path.set_extension("kitable");
        }
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        if path.exists() {
            return Err(KitableError::Exists);
        }
        let result = (|| {
            let mut file = Self::open_sqlite(&path)?;
            file.migrate()?;
            file.initialize_document(options)?;
            Ok(file)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&path);
        }
        result
    }

    /// Opens an existing file, migrating it to the current schema.
    pub fn open(path: &Path) -> Result<Self> {
        if path.as_os_str().is_empty() {
            return Err(KitableError::invalid("kitable path is required"));
        }
        std::fs::metadata(path)?;
        let mut file = Self::open_sqlite(path)?;
        file.migrate()?;
        file.validate()?;
        Ok(file)
    }

    fn open_sqlite(path: &Path) -> Result<Self> {
        let absolute = std::path::absolute(path)?;
        let conn = Connection::open(&absolute)?;
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA journal_mode = DELETE;
             PRAGMA synchronous = NORMAL;",
        )?;
        Ok(Self {
            conn,
            path: absolute,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Closes the file after letting SQLite refresh its statistics.
    pub fn close(self) {
        let _ = self.conn.execute_batch("PRAGMA optimize");
    }

    fn validate(&self) -> Result<()> {
        let format = self.get_meta("format")?;
        if format != FORMAT {
            return Err(KitableError::invalid(format!(
                "invalid kitable format {format:?}"
            )));
        }
        Ok(())
    }

    pub fn info(&self) -> Result<Info> {
        let meta = self.meta()?;
        let get = |key: &str| meta.get(key).cloned().unwrap_or_default();
        let document_id = get("document_id");
        let title = self
            .conn
            .query_row(
                "SELECT title FROM kition_documents WHERE id = ?1 AND deleted_at IS NULL",
                [&document_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_default();
        Ok(Info {
            path: self.path.clone(),
            document_id,
            title,
            format: get("format"),
            format_version: atoi(&get("format_version")),
            schema_version: atoi(&get("schema_version")),
            created_at: atoi(&get("created_at")),
            updated_at: atoi(&get("updated_at")),
        })
    }

    pub fn meta(&self) -> Result<BTreeMap<String, String>> {
        let mut statement = self.conn.prepare("SELECT key, value FROM kition_meta")?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<BTreeMap<_, _>, _>>()?;
        Ok(rows)
    }

    pub fn get_meta(&self, key: &str) -> Result<String> {
        Ok(self.conn.query_row(
            "SELECT value FROM kition_meta WHERE key = ?1",
            [key],
            |row| row.get(0),
        )?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        set_meta(&self.conn, key, value)
    }

    fn schema_version(&self) -> Result<i64> {
        let has_meta: Option<String> = self
            .conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kition_meta'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if has_meta.is_none() {
            return Ok(0);
        }
        let value: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM kition_meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value.map_or(0, |v| atoi(&v)))
    }

    fn migrate(&mut self) -> Result<()> {
        let version = self.schema_version()?;
        if version > SCHEMA_VERSION {
            return Err(KitableError::Newer(version));
        }
        if version == SCHEMA_VERSION {
            return Ok(());
        }
        if version == 0 {
            let tx = self.conn.transaction()?;
            for (_, create, _) in TABLES {
                tx.execute_batch(&create.replacen(
                    "CREATE TABLE ",
                    "CREATE TABLE IF NOT EXISTS ",
                    1,
                ))?;
            }
            for index in INDEXES {
                tx.execute_batch(index)?;
            }
            set_meta(&tx, "format", FORMAT)?;
            set_meta(&tx, "format_version", &FORMAT_VERSION.to_string())?;
            set_meta(&tx, "schema_version", &SCHEMA_VERSION.to_string())?;
            tx.commit()?;
            return Ok(());
        }
        self.rebuild_to_v3()
    }

    /// Rebuilds every table of a version 1 or 2 file into the version 3
    /// schema, converting text timestamps to milliseconds. Foreign keys are
    /// disabled around the rebuild so dropping and renaming does not cascade.
    fn rebuild_to_v3(&mut self) -> Result<()> {
        self.conn.execute_batch("PRAGMA foreign_keys = OFF")?;
        let result = (|| -> Result<()> {
            let tx = self.conn.transaction()?;
            for (name, create, time_columns) in TABLES {
                if name == "kition_meta" {
                    continue;
                }
                let old_columns = column_names(&tx, name)?;
                if old_columns.is_empty() {
                    tx.execute_batch(create)?;
                    continue;
                }
                let staging = format!("{name}_v3");
                tx.execute_batch(&create.replacen(name, &staging, 1))?;
                let new_columns = column_names(&tx, &staging)?;
                let shared: Vec<&String> = new_columns
                    .iter()
                    .filter(|c| old_columns.contains(c))
                    .collect();
                let list = shared
                    .iter()
                    .map(|c| c.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                tx.execute_batch(&format!(
                    "INSERT INTO {staging} ({list}) SELECT {list} FROM {name};
                     DROP TABLE {name};
                     ALTER TABLE {staging} RENAME TO {name};"
                ))?;
                for column in time_columns {
                    convert_time_column(&tx, name, column)?;
                }
            }
            for index in INDEXES {
                tx.execute_batch(index)?;
            }
            for key in ["created_at", "updated_at"] {
                let value: Option<String> = tx
                    .query_row(
                        "SELECT value FROM kition_meta WHERE key = ?1",
                        [key],
                        |row| row.get(0),
                    )
                    .optional()?;
                if let Some(text) = value
                    && text.parse::<i64>().is_err()
                {
                    set_meta(&tx, key, &parse_legacy(&text).unwrap_or(0).to_string())?;
                }
            }
            set_meta(&tx, "schema_version", &SCHEMA_VERSION.to_string())?;
            let violations: i64 =
                tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get(0)
                })?;
            if violations > 0 {
                return Err(KitableError::invalid(
                    "kitable migration left foreign key violations",
                ));
            }
            tx.commit()?;
            Ok(())
        })();
        self.conn.execute_batch("PRAGMA foreign_keys = ON")?;
        result
    }

    fn initialize_document(&mut self, options: &CreateOptions) -> Result<()> {
        let created = options.created_at.unwrap_or_else(now_millis);
        let updated = options.updated_at.unwrap_or(created);
        let document_id = match options.document_id.trim() {
            "" => uuid::Uuid::new_v4().to_string(),
            id => id.to_owned(),
        };
        let title = match options.title.trim() {
            "" => self
                .path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default(),
            title => title.to_owned(),
        };
        let meta_json = match options.meta_json.trim() {
            "" => "{}",
            meta => meta,
        };
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO kition_documents (id, title, description, icon, color, meta_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                document_id,
                title,
                options.description,
                options.icon,
                options.color,
                meta_json,
                created,
                updated
            ],
        )?;
        set_meta(&tx, "document_id", &document_id)?;
        set_meta(&tx, "created_at", &created.to_string())?;
        set_meta(&tx, "updated_at", &updated.to_string())?;
        set_meta(&tx, "schema_version", &SCHEMA_VERSION.to_string())?;
        tx.commit()?;
        Ok(())
    }
}

pub(crate) fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO kition_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// `None` when `key` is not set. Shared with `crate::kdm::store`, which also keys its bookkeeping
/// off `kition_meta`.
pub(crate) fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM kition_meta WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()?)
}

pub(crate) fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(names)
}

fn convert_time_column(conn: &Connection, table: &str, column: &str) -> Result<()> {
    let mut select = conn.prepare(&format!(
        "SELECT rowid, {column} FROM {table} WHERE typeof({column}) = 'text'"
    ))?;
    let rows = select
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut update = conn.prepare(&format!(
        "UPDATE {table} SET {column} = ?1 WHERE rowid = ?2"
    ))?;
    for (rowid, text) in rows {
        update.execute(params![parse_legacy(&text).unwrap_or(0), rowid])?;
    }
    Ok(())
}

pub(crate) fn atoi(value: &str) -> i64 {
    let trimmed = value.trim();
    let end = trimmed
        .char_indices()
        .find(|(i, c)| !(c.is_ascii_digit() || (*i == 0 && (*c == '-' || *c == '+'))))
        .map_or(trimmed.len(), |(i, _)| i);
    trimmed[..end].parse().unwrap_or(0)
}
