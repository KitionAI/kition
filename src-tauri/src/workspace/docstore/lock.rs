//! One writer per store: `.kition/docs/store.lock`.
//!
//! People may keep a workspace in their own file sync (Dropbox, iCloud Drive,
//! OneDrive) and open it on two devices, or open it in a second Kition. Two
//! writers appending to one change log would each name the other's changes as
//! their own `seq`, so the store has one writer: the Kition that holds the lock
//! file, which names it (an instance id, its process id, its host, when it
//! started) and which it touches every `HEARTBEAT`. Any other Kition opens the
//! store read-only: it reads replicas and history, and saves files as usual,
//! but writes nothing to the store, and tells the person why.
//!
//! A lock is stale, and the next Kition takes it over, when its heartbeat is
//! older than `STALE_AFTER` (a crashed Kition, a device that went to sleep), or
//! at once when it names a process on this host that is no longer running.
//! A writer that finds the lock file naming someone else (it slept past
//! `STALE_AFTER` and was taken over) becomes read-only.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use std::{fs, io};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{ensure_store, read_confined, store_dir};
use crate::workspace::safety::{assert_safe, write_atomically};

/// The error a store write fails with in a Kition that does not hold the lock.
pub const STORE_READ_ONLY: &str = "DOCUMENT_STORE_READ_ONLY";
pub(super) const LOCK_FILE: &str = "store.lock";
/// How often the writer touches the lock file.
pub const HEARTBEAT: Duration = Duration::from_secs(15);
/// How old a heartbeat may be before the lock is taken over. Generous, as
/// file sync delivers the heartbeats of another device late.
pub const STALE_AFTER: Duration = Duration::from_secs(120);
const LOCK_FORMAT: u64 = 1;

/// What the lock file says about its holder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockRecord {
    pub format: u64,
    pub instance: String,
    pub pid: u32,
    pub host: String,
    /// Milliseconds since the Unix epoch.
    pub started: u64,
    pub heartbeat: u64,
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

fn host_name() -> String {
    let name = gethostname::gethostname()
        .to_string_lossy()
        .trim()
        .to_owned();
    if name.is_empty() {
        "unknown".to_owned()
    } else {
        name
    }
}

#[cfg(unix)]
fn process_running(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks that the process exists and may be signalled.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn process_running(_pid: u32) -> bool {
    // Without a cheap check, a lock of this host goes stale by its heartbeat.
    true
}

/// Whether a lock that is not ours may be taken over now.
fn is_stale(record: &LockRecord, me: &LockRecord, now: u64) -> bool {
    if record.host == me.host && !process_running(record.pid) {
        return true;
    }
    now.saturating_sub(record.heartbeat) > STALE_AFTER.as_millis() as u64
}

/// The lock of one workspace's store, as this Kition sees it.
pub struct StoreLock {
    root: PathBuf,
    me: Mutex<LockRecord>,
    state: Mutex<State>,
}

#[derive(Clone, Debug, PartialEq)]
struct State {
    writer: bool,
    /// The holder when this Kition is not the writer (`None`: unknown, the
    /// lock could not be read or written).
    holder: Option<LockRecord>,
}

impl StoreLock {
    /// This Kition's view of `root`'s store lock; takes the lock when it is
    /// free or stale.
    pub fn open(root: &Path) -> Self {
        let now = now_ms();
        let lock = Self {
            root: root.to_path_buf(),
            me: Mutex::new(LockRecord {
                format: LOCK_FORMAT,
                instance: uuid::Uuid::new_v4().to_string(),
                pid: std::process::id(),
                host: host_name(),
                started: now,
                heartbeat: now,
            }),
            state: Mutex::new(State {
                writer: false,
                holder: None,
            }),
        };
        lock.refresh();
        lock
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path(&self) -> PathBuf {
        store_dir(&self.root).join(LOCK_FILE)
    }

    fn read_record(&self) -> io::Result<Option<LockRecord>> {
        Ok(read_confined(&self.root, &self.path())?
            .and_then(|bytes| serde_json::from_slice::<LockRecord>(&bytes).ok()))
    }

    fn write_record(&self, record: &LockRecord) -> io::Result<()> {
        let path = self.path();
        assert_safe(&self.root, &path, true)?;
        let mut bytes = serde_json::to_vec_pretty(record).map_err(io::Error::other)?;
        bytes.push(b'\n');
        write_atomically(&path, &bytes)
    }

    /// Creates the lock file only when there is none: a hard link fails when
    /// another Kition made one first.
    fn create_record(&self, record: &LockRecord) -> io::Result<bool> {
        let path = self.path();
        assert_safe(&self.root, &path, true)?;
        let temporary = store_dir(&self.root).join(format!(".{LOCK_FILE}.{}.tmp", record.instance));
        let mut bytes = serde_json::to_vec_pretty(record).map_err(io::Error::other)?;
        bytes.push(b'\n');
        write_atomically(&temporary, &bytes)?;
        let linked = fs::hard_link(&temporary, &path);
        let _ = fs::remove_file(&temporary);
        match linked {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn set_state(&self, next: State) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let changed = *state != next;
        *state = next;
        changed
    }

    fn try_refresh(&self) -> io::Result<State> {
        ensure_store(&self.root)?;
        let now = now_ms();
        let mut me = self
            .me
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        me.heartbeat = now;
        let raw = read_confined(&self.root, &self.path())?;
        let Some(raw) = raw else {
            if self.create_record(&me)? {
                *self.me.lock().unwrap_or_else(PoisonError::into_inner) = me;
                return Ok(State {
                    writer: true,
                    holder: None,
                });
            }
            // Another Kition made it first.
            return Ok(State {
                writer: false,
                holder: self.read_record()?,
            });
        };
        // A lock file that does not parse (a torn write) is stale.
        let current = serde_json::from_slice::<LockRecord>(&raw).ok();
        let take = match &current {
            Some(record) if record.instance == me.instance => true,
            Some(record) => is_stale(record, &me, now),
            None => true,
        };
        if !take {
            return Ok(State {
                writer: false,
                holder: current,
            });
        }
        let taking_over = current
            .as_ref()
            .is_none_or(|record| record.instance != me.instance);
        self.write_record(&me)?;
        *self.me.lock().unwrap_or_else(PoisonError::into_inner) = me.clone();
        if taking_over {
            // Two Kitions taking over a stale lock at once: the last rename
            // wins, and the other sees it here (or at its next heartbeat).
            std::thread::sleep(Duration::from_millis(50));
            let after = self.read_record()?;
            if after.as_ref().map(|record| &record.instance) != Some(&me.instance) {
                return Ok(State {
                    writer: false,
                    holder: after,
                });
            }
        }
        Ok(State {
            writer: true,
            holder: None,
        })
    }

    /// Touches the lock when this Kition holds it, takes it over when it is
    /// stale, and answers whether the access changed.
    pub fn refresh(&self) -> bool {
        let next = self.try_refresh().unwrap_or_else(|error| {
            eprintln!("document store lock: {error}");
            State {
                writer: false,
                holder: None,
            }
        });
        self.set_state(next)
    }

    pub fn is_writer(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .writer
    }

    /// Fails with `STORE_READ_ONLY` unless this Kition is the store's writer.
    #[cfg(test)]
    pub fn check_writer(&self) -> io::Result<()> {
        if self.is_writer() {
            Ok(())
        } else {
            Err(io::Error::other(STORE_READ_ONLY))
        }
    }

    /// `{ writable, holder: { host, pid, started, heartbeat, sameHost } | null }`.
    pub fn status(&self) -> Value {
        let state = self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let host = self
            .me
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .host
            .clone();
        json!({
            "writable": state.writer,
            "holder": state.holder.map(|holder| json!({
                "host": holder.host,
                "pid": holder.pid,
                "started": holder.started,
                "heartbeat": holder.heartbeat,
                "sameHost": holder.host == host,
            })),
        })
    }

    /// Removes the lock file when this Kition holds it.
    pub fn release(&self) {
        let instance = self
            .me
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .instance
            .clone();
        if self.is_writer()
            && self
                .read_record()
                .ok()
                .flatten()
                .is_some_and(|record| record.instance == instance)
        {
            let _ = fs::remove_file(self.path());
        }
        self.set_state(State {
            writer: false,
            holder: None,
        });
    }
}

type Listener = Box<dyn Fn(Value) + Send + Sync>;

/// The store lock of the active workspace, kept alive by a heartbeat thread.
#[derive(Default)]
pub struct StoreLocks {
    current: Mutex<Option<Arc<StoreLock>>>,
    listener: Mutex<Option<Listener>>,
    started: Mutex<bool>,
}

impl StoreLocks {
    /// Calls `listener` with the new status whenever this Kition's access to
    /// the store changes (it took the lock over, or lost it).
    pub fn on_change(&self, listener: impl Fn(Value) + Send + Sync + 'static) {
        *self.listener.lock().unwrap_or_else(PoisonError::into_inner) = Some(Box::new(listener));
    }

    /// The lock of `root`'s store, opened (and the previous workspace's
    /// released) when the workspace changed.
    pub fn lock_for(self: &Arc<Self>, root: &Path) -> Arc<StoreLock> {
        let mut current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(lock) = current.as_ref().filter(|lock| lock.root() == root) {
            return lock.clone();
        }
        if let Some(previous) = current.take() {
            previous.release();
        }
        let lock = Arc::new(StoreLock::open(root));
        *current = Some(lock.clone());
        drop(current);
        self.start_heartbeat();
        lock
    }

    fn start_heartbeat(self: &Arc<Self>) {
        let mut started = self.started.lock().unwrap_or_else(PoisonError::into_inner);
        if *started {
            return;
        }
        *started = true;
        let locks = Arc::downgrade(self);
        let spawned = std::thread::Builder::new()
            .name("kition-store-lock".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(HEARTBEAT);
                    let Some(locks) = locks.upgrade() else {
                        return;
                    };
                    let lock = locks
                        .current
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .clone();
                    if let Some(lock) = lock
                        && lock.refresh()
                        && let Some(listener) = locks
                            .listener
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .as_ref()
                    {
                        listener(lock.status());
                    }
                }
            });
        if spawned.is_err() {
            *started = false;
        }
    }

    /// Releases the active workspace's lock (the app is quitting).
    pub fn release(&self) {
        if let Some(lock) = self
            .current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            lock.release();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = temp.path().join("workspace");
        fs::create_dir_all(&root).unwrap_or_else(|err| panic!("{err}"));
        (temp, root)
    }

    fn lock_file(root: &Path) -> PathBuf {
        root.join(".kition/docs").join(LOCK_FILE)
    }

    fn rewrite(root: &Path, edit: impl FnOnce(&mut LockRecord)) {
        let bytes = fs::read(lock_file(root)).unwrap_or_default();
        let mut record: LockRecord =
            serde_json::from_slice(&bytes).unwrap_or_else(|err| panic!("{err}"));
        edit(&mut record);
        let bytes = serde_json::to_vec(&record).unwrap_or_default();
        fs::write(lock_file(root), bytes).unwrap_or_else(|err| panic!("{err}"));
    }

    #[test]
    fn has_one_writer_and_takes_over_a_stale_lock() {
        let (_temp, root) = workspace();
        let first = StoreLock::open(&root);
        assert!(first.is_writer());
        assert!(lock_file(&root).is_file());
        assert!(first.check_writer().is_ok());

        // Another Kition (here: another device, by file sync) opens it read-only.
        rewrite(&root, |record| {
            record.host = "other-device".into();
            record.instance = "other".into();
        });
        let second = StoreLock::open(&root);
        assert!(!second.is_writer());
        assert_eq!(
            second.check_writer().map_err(|error| error.to_string()),
            Err(STORE_READ_ONLY.to_owned())
        );
        let status = second.status();
        assert_eq!(status["writable"], json!(false));
        assert_eq!(status["holder"]["host"], json!("other-device"));
        assert_eq!(status["holder"]["sameHost"], json!(false));
        // The first one sees that the lock is no longer its own.
        assert!(first.refresh());
        assert!(!first.is_writer());

        // A heartbeat stops: the lock goes stale and is taken over.
        rewrite(&root, |record| {
            record.heartbeat = now_ms() - STALE_AFTER.as_millis() as u64 - 1_000
        });
        assert!(second.refresh());
        assert!(second.is_writer());
        assert!(!second.refresh(), "the writer's heartbeat changes nothing");
        first.refresh();
        assert!(!first.is_writer());
        assert_eq!(first.status()["holder"]["sameHost"], json!(true));

        second.release();
        assert!(!lock_file(&root).exists());
        assert!(first.refresh());
        assert!(first.is_writer());
    }

    #[test]
    fn takes_over_the_lock_of_a_process_that_ended() {
        let (_temp, root) = workspace();
        let first = StoreLock::open(&root);
        assert!(first.is_writer());
        // A Kition of this host that is no longer running (a pid that cannot exist).
        rewrite(&root, |record| {
            record.instance = "ended".into();
            record.pid = u32::MAX - 1;
        });
        let second = StoreLock::open(&root);
        if cfg!(unix) {
            assert!(second.is_writer());
            assert!(first.refresh());
            assert!(!first.is_writer());
        }
        // A damaged lock file is taken over too.
        fs::write(lock_file(&root), b"garbage").unwrap_or_else(|err| panic!("{err}"));
        assert!(first.refresh());
        assert!(first.is_writer());
    }

    #[test]
    fn follows_the_active_workspace() {
        let (_temp, root) = workspace();
        let (_temp2, other) = workspace();
        let locks = Arc::new(StoreLocks::default());
        let lock = locks.lock_for(&root);
        assert!(lock.is_writer());
        assert!(Arc::ptr_eq(&lock, &locks.lock_for(&root)));
        let moved = locks.lock_for(&other);
        assert!(moved.is_writer());
        assert!(
            !lock_file(&root).exists(),
            "the previous workspace's lock is released"
        );
        locks.release();
        assert!(!lock_file(&other).exists());
    }
}
