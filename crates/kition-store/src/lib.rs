//! The main SQLite database.

mod migrate;
pub mod rows;
mod schema;
pub mod seed;
pub mod users;

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use kition_core::{AppError, AppResult};
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;

pub use migrate::SCHEMA_VERSION;

const DEFAULT_SQLITE_PATH: &str = "./data/local.db";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const POOL_SIZE: u32 = 8;

type Listener = Arc<dyn Fn(&str) + Send + Sync>;

/// Callbacks told the name of every table a statement changes. They run
/// inside SQLite and must not touch the database.
#[derive(Clone, Default)]
struct ChangeListeners(Arc<RwLock<Vec<Listener>>>);

impl ChangeListeners {
    fn notify(&self, table: &str) {
        let listeners = self
            .0
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for listener in listeners.iter() {
            listener(table);
        }
    }

    fn init(&self) -> impl Fn(&mut Connection) -> rusqlite::Result<()> + Send + Sync + 'static {
        let listeners = self.clone();
        move |conn: &mut Connection| {
            conn.busy_timeout(BUSY_TIMEOUT)?;
            let listeners = listeners.clone();
            conn.update_hook(Some(
                move |_: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
                    listeners.notify(table)
                },
            ))?;
            Ok(())
        }
    }
}

/// A pooled handle to the main database. Cheap to clone.
#[derive(Clone)]
pub struct Db {
    pool: Pool<SqliteConnectionManager>,
    path: PathBuf,
    listeners: ChangeListeners,
}

impl Db {
    /// Opens (creating if needed) the database at `path`, restricts it to the
    /// owner, and brings the schema up to date.
    pub fn open(path: &str) -> AppResult<Self> {
        let path = PathBuf::from(if path.trim().is_empty() {
            DEFAULT_SQLITE_PATH
        } else {
            path
        });
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        let listeners = ChangeListeners::default();
        let manager = SqliteConnectionManager::file(&path).with_init(listeners.init());
        let pool = Pool::builder()
            .max_size(POOL_SIZE)
            .build(manager)
            .map_err(AppError::unhandled)?;
        restrict_permissions(&path);
        let db = Self {
            pool,
            path,
            listeners,
        };
        {
            let mut conn = db.conn()?;
            migrate::run(&mut conn, &db.path)?;
        }
        Ok(db)
    }

    /// An in-memory database for tests. A single connection keeps the data
    /// alive for the pool's lifetime.
    pub fn open_in_memory() -> AppResult<Self> {
        let listeners = ChangeListeners::default();
        let manager = SqliteConnectionManager::memory().with_init(listeners.init());
        let pool = Pool::builder()
            .max_size(1)
            .build(manager)
            .map_err(AppError::unhandled)?;
        let db = Self {
            pool,
            path: PathBuf::from(":memory:"),
            listeners,
        };
        {
            let mut conn = db.conn()?;
            migrate::run(&mut conn, &db.path)?;
        }
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Calls `listener` with the table name after every row change.
    pub fn on_table_change(&self, listener: impl Fn(&str) + Send + Sync + 'static) {
        self.listeners
            .0
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(Arc::new(listener));
    }

    /// A connection for synchronous startup work.
    pub fn conn(&self) -> AppResult<PooledConnection<SqliteConnectionManager>> {
        self.pool.get().map_err(AppError::unhandled)
    }

    /// Runs `work` on a pooled connection off the async executor.
    pub async fn run<T, F>(&self, work: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> AppResult<T> + Send + 'static,
    {
        let pool = self.pool.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = pool.get().map_err(AppError::unhandled)?;
            work(&mut conn)
        })
        .await
        .map_err(AppError::unhandled)?
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    // Best effort, like the legacy runtime.
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

/// Reads an optional JSON column.
pub fn json_column(raw: Option<String>) -> serde_json::Value {
    raw.filter(|text| !text.is_empty())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(serde_json::Value::Null)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn reports_changed_tables() {
        let db = Db::open_in_memory().unwrap_or_else(|err| panic!("{err}"));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        db.on_table_change(move |table| {
            sink.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(table.to_owned())
        });
        let conn = db.conn().unwrap_or_else(|err| panic!("{err}"));
        conn.execute(
            "INSERT INTO oauth_platforms (platform_id, platform_name) VALUES ('x', 'X')",
            [],
        )
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(
            seen.lock().map(|v| v.clone()).unwrap_or_default(),
            vec!["oauth_platforms".to_owned()]
        );
    }
}
