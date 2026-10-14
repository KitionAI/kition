//! Opening, creating, and migrating `.kitable` files.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use kition_core::time::parse_legacy;
use kition_core::{Millis, now_millis};
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Version};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::kdm::model::{self, BaseSpec};
use crate::kdm::project::{self, TableChange};
use crate::kdm::read::ModelView;
use crate::kdm::{migrate, schema, store};
use crate::schema::{INDEXES, TABLES};
use crate::{KitableError, Result};

pub const FORMAT: &str = "kition-kitable";
pub const FORMAT_VERSION: i64 = 1;
/// Version 3: timestamps are INTEGER Unix milliseconds. Version 4: the file holds its table
/// document's KDM replica, and the relational tables are its projection.
pub const SCHEMA_VERSION: i64 = 4;

/// The last schema version without a KDM replica.
const RELATIONAL_SCHEMA_VERSION: i64 = 3;

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

/// An open `.kitable` file: one SQLite connection and the file's KDM replica.
///
/// Every mutation is one transaction of the replica, stored (`kdm::store`) and projected onto
/// the relational tables (`kdm::project`) in one SQL transaction; reads go to the relational
/// tables. See [`crate::kdm::commit`].
pub struct KitableFile {
    pub(crate) conn: Connection,
    pub(crate) path: PathBuf,
    pub(crate) replica: Replica,
    pub(crate) origin: Origin,
    /// The stored replica's version: the `since` of the next append.
    pub(crate) since: Version,
    /// The stored position `(generation, seq)` this handle last read or wrote.
    pub(crate) position: (i64, i64),
    pub(crate) base: Option<ObjectId>,
    /// The file's identity right after this handle's open or last own write.
    pub(crate) identity: Option<FileIdentity>,
    pub(crate) last_change: Option<TableChange>,
    /// A failed write could not reload the replica; the next write reloads it first.
    pub(crate) stale: bool,
}

/// What tells one file on disk from another, or from itself after a write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    dev: u64,
    ino: u64,
    mtime: Option<std::time::SystemTime>,
    size: u64,
}

impl FileIdentity {
    pub(crate) fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        #[cfg(unix)]
        let (dev, ino) = {
            use std::os::unix::fs::MetadataExt;
            (meta.dev(), meta.ino())
        };
        #[cfg(not(unix))]
        let (dev, ino) = (0, 0);
        Some(Self {
            dev,
            ino,
            mtime: meta.modified().ok(),
            size: meta.len(),
        })
    }
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
            let (mut conn, absolute) = open_sqlite(&path)?;
            migrate_schema(&mut conn)?;
            let (doc_id, spec) = initialize_document(&mut conn, &absolute, options)?;
            let (replica, _) = Replica::create_with(
                schema(),
                doc_id,
                ActorId::random(),
                &Origin::system("create"),
                |tx| {
                    model::create_base(tx, &spec)
                        .map_err(|err| kition_kdm::KdmError::Engine(err.to_string()))
                },
            )?;
            {
                let tx = conn.transaction()?;
                let now = now_millis();
                store::save_initial(&tx, &replica, now)?;
                project::rebuild(&tx, &replica, now)?;
                let position = store::stored_position(&tx)?;
                store::set_projected_position(&tx, position)?;
                tx.commit()?;
            }
            Self::attach(conn, absolute, replica)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&path);
        }
        result
    }

    /// Opens an existing file, migrating it to the current schema: a file from before the KDM
    /// gets its replica ([`migrate::upgrade`]), and a projection behind the stored replica is
    /// rebuilt.
    pub fn open(path: &Path) -> Result<Self> {
        if path.as_os_str().is_empty() {
            return Err(KitableError::invalid("kitable path is required"));
        }
        std::fs::metadata(path)?;
        let (mut conn, absolute) = open_sqlite(path)?;
        migrate_schema(&mut conn)?;
        validate(&conn)?;
        if !has_replica(&conn)? {
            migrate::upgrade(&mut conn, ActorId::random())?;
        }
        if schema_version(&conn)? != SCHEMA_VERSION {
            set_meta(&conn, "schema_version", &SCHEMA_VERSION.to_string())?;
        }
        let replica = load_replica(&conn)?;
        let stored = store::stored_position(&conn)?;
        if store::projected_position(&conn)? != stored {
            let tx = conn.transaction()?;
            project::rebuild(&tx, &replica, now_millis())?;
            store::set_projected_position(&tx, stored)?;
            tx.commit()?;
        }
        Self::attach(conn, absolute, replica)
    }

    fn attach(conn: Connection, path: PathBuf, replica: Replica) -> Result<Self> {
        let position = store::stored_position(&conn)?;
        let base = ModelView::new(&replica).base();
        Ok(Self {
            since: replica.version(),
            identity: FileIdentity::of(&path),
            conn,
            path,
            replica,
            origin: Origin::system("unknown"),
            position,
            base,
            last_change: None,
            stale: false,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// The file's KDM replica, as of this handle's last read or write of the store.
    pub fn replica(&self) -> &Replica {
        &self.replica
    }

    /// Closes the file after letting SQLite refresh its statistics.
    pub fn close(self) {
        let _ = self.conn.execute_batch("PRAGMA optimize");
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

    /// Writes one key of the file's own bookkeeping (`kition_meta`: format, versions, ...).
    /// This is not part of the table document, so it is no KDM transaction.
    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        set_meta(&self.conn, key, value)
    }
}

/// Opens the SQLite database at `path`; answers the connection and the absolute path.
pub(crate) fn open_sqlite(path: &Path) -> Result<(Connection, PathBuf)> {
    let absolute = std::path::absolute(path)?;
    let conn = Connection::open(&absolute)?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA journal_mode = DELETE;
         PRAGMA synchronous = NORMAL;",
    )?;
    Ok((conn, absolute))
}

/// Loads the stored replica with a new random actor.
pub(crate) fn load_replica(conn: &Connection) -> Result<Replica> {
    store::load(conn, schema(), ActorId::random())?
        .ok_or_else(|| KitableError::Kdm("the kitable file holds no kdm replica".into()))
}

fn validate(conn: &Connection) -> Result<()> {
    let format: String = conn.query_row(
        "SELECT value FROM kition_meta WHERE key = 'format'",
        [],
        |row| row.get(0),
    )?;
    if format != FORMAT {
        return Err(KitableError::invalid(format!(
            "invalid kitable format {format:?}"
        )));
    }
    Ok(())
}

/// Whether the file holds a KDM replica (`kition_kdm` exists and has its row).
fn has_replica(conn: &Connection) -> Result<bool> {
    let table: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kition_kdm'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if table.is_none() {
        return Ok(false);
    }
    Ok(conn
        .query_row("SELECT id FROM kition_kdm WHERE id = 1", [], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?
        .is_some())
}

fn schema_version(conn: &Connection) -> Result<i64> {
    let has_meta: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kition_meta'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if has_meta.is_none() {
        return Ok(0);
    }
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM kition_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value.map_or(0, |v| atoi(&v)))
}

/// Brings the relational schema up to date: a new file gets every table (KDM tables included)
/// at the current version; a version 1 or 2 file is rebuilt into version 3. Adding the replica
/// to a version 3 file is [`KitableFile::open`]'s job.
fn migrate_schema(conn: &mut Connection) -> Result<()> {
    let version = schema_version(conn)?;
    if version > SCHEMA_VERSION {
        return Err(KitableError::Newer(version));
    }
    if version == 0 {
        let tx = conn.transaction()?;
        for (_, create, _) in TABLES {
            tx.execute_batch(&create.replacen("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1))?;
        }
        for index in INDEXES {
            tx.execute_batch(index)?;
        }
        store::ensure_tables(&tx)?;
        set_meta(&tx, "format", FORMAT)?;
        set_meta(&tx, "format_version", &FORMAT_VERSION.to_string())?;
        set_meta(&tx, "schema_version", &SCHEMA_VERSION.to_string())?;
        tx.commit()?;
        return Ok(());
    }
    if version < RELATIONAL_SCHEMA_VERSION {
        rebuild_to_v3(conn)?;
    }
    Ok(())
}

/// Rebuilds every table of a version 1 or 2 file into the version 3
/// schema, converting text timestamps to milliseconds. Foreign keys are
/// disabled around the rebuild so dropping and renaming does not cascade.
fn rebuild_to_v3(conn: &mut Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = OFF")?;
    let result = (|| -> Result<()> {
        let tx = conn.transaction()?;
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
        set_meta(
            &tx,
            "schema_version",
            &RELATIONAL_SCHEMA_VERSION.to_string(),
        )?;
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
    conn.execute_batch("PRAGMA foreign_keys = ON")?;
    result
}

/// Writes the document row and its bookkeeping; answers the KDM document id and the base the
/// replica starts with. A document id that is not a UUID keeps its string in `kition_meta` and
/// gets a new KDM document id.
fn initialize_document(
    conn: &mut Connection,
    path: &Path,
    options: &CreateOptions,
) -> Result<(DocId, BaseSpec)> {
    let created = options.created_at.unwrap_or_else(now_millis);
    let updated = options.updated_at.unwrap_or(created);
    let document_id = match options.document_id.trim() {
        "" => uuid::Uuid::new_v4().to_string(),
        id => id.to_owned(),
    };
    let title = match options.title.trim() {
        "" => path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default(),
        title => title.to_owned(),
    };
    let meta: Value = match options.meta_json.trim() {
        "" => Value::Null,
        // Legacy files kept any string; the document holds JSON, so anything else is none.
        raw => serde_json::from_str(raw).unwrap_or(Value::Null),
    };
    let meta_json = if meta.is_null() {
        "{}".to_owned()
    } else {
        meta.to_string()
    };
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO kition_documents (id, title, description, icon, color, meta_json, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            document_id,
            title,
            options.description.trim(),
            options.icon.trim(),
            options.color.trim(),
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
    let doc_id = DocId::parse(&document_id).unwrap_or_default();
    Ok((
        doc_id,
        BaseSpec {
            title,
            description: options.description.clone(),
            icon: options.icon.clone(),
            color: options.color.clone(),
            meta,
        },
    ))
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
