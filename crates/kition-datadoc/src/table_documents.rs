//! The shared-connection manager behind every `.kitable` file the runtime touches over HTTP.
//!
//! Historically every request opened its own [`KitableFile`], each its own SQLite connection to
//! the same file; concurrent writers raced SQLite's own file locking (`SQLITE_BUSY`) instead of
//! being serialized by the runtime. [`TableDocuments`] keeps one [`KitableFile`] per path behind
//! a lock, reused by every caller (HTTP routes, the Agent, email/form sync, workflows): a
//! [`TableHandle`] is the lock held, for as long as the caller needs it, and derefs straight to
//! `KitableFile` so call sites written against the old by-value file barely change.
//!
//! A handle must only be created and dropped inside [`tokio::task::spawn_blocking`]: the lock it
//! holds is a blocking one and must never be held across an `.await`. It locks with
//! `parking_lot::Mutex`, not `tokio::sync::Mutex::blocking_lock`: the latter panics outright if
//! ever called from an async worker thread instead of inside `spawn_blocking`, where
//! `parking_lot` just blocks that thread instead (slow, not fatal, if a caller gets it wrong).
//!
//! Co-editing relays a file's replica to a sync room, and learns what to send from
//! [`TableDocuments::on_replica_changed`]: when a handle drops after its file's replica moved to a
//! new version under any origin but `import` (a person's, the Agent's, a workflow's, a merge from
//! disk), the listener is told the file and its new version. Imports are relayed changes coming
//! in, so they are not reported back (but see [`TableHandle::report_replica_change`]).

use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use kition_core::{AppError, AppResult};
use kition_kdm::{DocId, Origin, OriginKind, Version};
use kition_kitable::{KitableFile, MergeOutcome, TableChange};
use parking_lot::{ArcMutexGuard, Mutex as FileMutex, RawMutex, RwLock};

/// How long an unused `.kitable` connection stays open after its last checkout.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

/// [`KitableFile::open`]/`create`'s own default, restored on [`TableHandle`] drop. Not exported
/// by `kition-kitable` (it is just what a freshly opened file already carries), so this mirrors
/// it rather than importing it.
pub(crate) fn default_origin() -> Origin {
    Origin::system("unknown")
}

struct Entry {
    file: Arc<FileMutex<KitableFile>>,
    last_used: Instant,
}

/// A file's replica reached a new version: what [`TableDocuments::on_replica_changed`] hears.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplicaChange {
    /// The file's absolute path.
    pub path: PathBuf,
    pub doc_id: DocId,
    pub version: Version,
}

/// Called with the lock on the file still held: it must not open a table itself.
pub type ReplicaListener = Arc<dyn Fn(&ReplicaChange) + Send + Sync>;

/// Every `.kitable` file the runtime has open, keyed by its absolute path. Cheap to clone: every
/// clone shares the same files (`DataDocState`, which holds one, is itself cloned per request).
#[derive(Default, Clone)]
pub struct TableDocuments {
    open: Arc<std::sync::Mutex<HashMap<PathBuf, Entry>>>,
    replica_listener: Arc<RwLock<Option<ReplicaListener>>>,
}

impl TableDocuments {
    /// The file at `path`: the shared handle, reused if already open, else freshly opened, and
    /// the `TableChange` of a merge if the file had changed on disk since the last handle to it
    /// closed (`None` otherwise). Sets `origin` on the file for as long as the returned handle
    /// is held; blocks the caller's thread, so this must only run inside `spawn_blocking`.
    pub fn open(
        &self,
        path: &Path,
        origin: Origin,
    ) -> AppResult<(TableHandle, Option<TableChange>)> {
        let absolute = std::path::absolute(path)?;
        let file = self.checkout_file(&absolute)?;
        let listener = self.replica_listener.read().clone();
        let mut handle = TableHandle::new(file, origin, absolute, listener);
        let merge = if handle.changed_on_disk() {
            match handle.reopen_merging().map_err(AppError::unhandled)? {
                MergeOutcome::Unchanged => None,
                MergeOutcome::Merged(change) => Some(change),
                MergeOutcome::DifferentDocument => {
                    return Err(AppError::conflict(
                        "Data document file was replaced on disk",
                    ));
                }
            }
        } else {
            None
        };
        Ok((handle, merge))
    }

    fn checkout_file(&self, absolute: &Path) -> AppResult<Arc<FileMutex<KitableFile>>> {
        let mut open = self.lock();
        evict_idle(&mut open, IDLE_TIMEOUT);
        if let Some(entry) = open.get_mut(absolute) {
            entry.last_used = Instant::now();
            return Ok(entry.file.clone());
        }
        let file = Arc::new(FileMutex::new(
            KitableFile::open(absolute).map_err(AppError::unhandled)?,
        ));
        open.insert(
            absolute.to_path_buf(),
            Entry {
                file: file.clone(),
                last_used: Instant::now(),
            },
        );
        Ok(file)
    }

    /// Tells `listener` about every replica version a handle leaves behind on drop, for every
    /// clone of this manager; replaces the listener set before. See the module documentation.
    pub fn on_replica_changed(&self, listener: impl Fn(&ReplicaChange) + Send + Sync + 'static) {
        *self.replica_listener.write() = Some(Arc::new(listener));
    }

    /// Drops the manager's own reference to every open file, for shutdown. A handle a caller
    /// still holds keeps its file open until that handle drops.
    pub fn close_all(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Entry>> {
        self.open
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg(test)]
    fn open_count(&self) -> usize {
        self.lock().len()
    }

    /// Evicts idle entries now, regardless of [`IDLE_TIMEOUT`]; for tests.
    #[cfg(test)]
    fn evict_idle_older_than(&self, max_age: Duration) {
        evict_idle(&mut self.lock(), max_age);
    }
}

/// Drops entries nothing else references (no outstanding [`TableHandle`]) whose last checkout
/// is older than `max_age`.
fn evict_idle(open: &mut HashMap<PathBuf, Entry>, max_age: Duration) {
    open.retain(|_, entry| {
        Arc::strong_count(&entry.file) > 1 || entry.last_used.elapsed() < max_age
    });
}

/// One checked-out `.kitable` file: the lock on its shared [`KitableFile`], already held, so
/// this derefs straight to it. Sets the checkout's origin on construction, restores
/// [`default_origin`] on drop, and reports a new replica version then (see the module
/// documentation).
pub struct TableHandle {
    guard: ArcMutexGuard<RawMutex, KitableFile>,
    path: PathBuf,
    /// The replica's version at checkout.
    start: Version,
    /// Whether a new version is reported on drop: the checkout's origin is not `import`, or
    /// [`TableHandle::report_replica_change`] asked for it.
    report: bool,
    listener: Option<ReplicaListener>,
}

impl TableHandle {
    fn new(
        file: Arc<FileMutex<KitableFile>>,
        origin: Origin,
        path: PathBuf,
        listener: Option<ReplicaListener>,
    ) -> Self {
        let mut guard = FileMutex::lock_arc(&file);
        let report = origin.kind != OriginKind::Import;
        guard.set_origin(origin);
        let start = guard.replica_version();
        Self {
            guard,
            path,
            start,
            report,
            listener,
        }
    }

    /// Reports this handle's new replica version on drop even though its origin is `import`:
    /// for an import whose repair wrote changes of this replica's own, which the peers lack.
    pub fn report_replica_change(&mut self) {
        self.report = true;
    }

    /// No-op: a handle no longer owns the connection outright, so there is nothing for one
    /// caller to close. Kept so call sites written against the old by-value `KitableFile`
    /// (`file.close()`) keep compiling; the manager closes idle files on its own.
    pub fn close(self) {}
}

impl Deref for TableHandle {
    type Target = KitableFile;

    fn deref(&self) -> &KitableFile {
        &self.guard
    }
}

impl DerefMut for TableHandle {
    fn deref_mut(&mut self) -> &mut KitableFile {
        &mut self.guard
    }
}

impl Drop for TableHandle {
    fn drop(&mut self) {
        if self.report
            && let Some(listener) = self.listener.take()
        {
            let version = self.guard.replica_version();
            if version != self.start {
                listener(&ReplicaChange {
                    path: self.path.clone(),
                    doc_id: self.guard.replica().doc_id(),
                    version,
                });
            }
        }
        self.guard.set_origin(default_origin());
    }
}

/// `bytes` as the standard base64 the replica routes and events carry.
pub fn encode_bytes(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// `path` relative to `workspace_dir`, with `/` separators, when it is inside it; else `path`
/// as it is.
pub fn workspace_relative(workspace_dir: &Path, path: &Path) -> String {
    let root = std::path::absolute(workspace_dir).unwrap_or_else(|_| workspace_dir.to_path_buf());
    match path.strip_prefix(&root) {
        Ok(relative) => relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

/// The `table/replica-changed` bridge event payload
/// (`contracts/runtime/data-documents-replica.schema.json#/$defs/replicaChanged`): the file's
/// workspace-relative `documentPath`, its KDM `docId`, and its new `version` (base64).
pub fn replica_changed_event(workspace_dir: &Path, change: &ReplicaChange) -> serde_json::Value {
    serde_json::json!({
        "documentPath": workspace_relative(workspace_dir, &change.path),
        "docId": change.doc_id.to_string(),
        "version": encode_bytes(&change.version.encode()),
    })
}

/// `Kition-Session: <uuid>` maps to `Origin::person("session:<uuid>")`; `Kition-Origin:
/// template` (no session yet, as during seeding) maps to `Origin::system("template")`; neither
/// header present falls back to `Origin::person("session:unknown")`.
pub fn origin_from_headers(session: Option<&str>, origin_header: Option<&str>) -> Origin {
    if let Some(session) = session.map(str::trim).filter(|s| !s.is_empty()) {
        return Origin::person(format!("session:{session}"));
    }
    if let Some(label) = origin_header.map(str::trim).filter(|s| !s.is_empty()) {
        return Origin::system(label.to_owned());
    }
    Origin::person("session:unknown")
}

/// The `origin` string the transact/undo/redo/table-changed JSON carries: `person:session:<id>`
/// for a window, `agent:<turnId>` for the agent, or just the label (for example `template`) for
/// a system origin, matching `contracts/runtime/data-documents-transact.schema.json`.
pub fn render_origin(origin: &Origin) -> String {
    match origin.kind {
        OriginKind::System => origin
            .label
            .clone()
            .unwrap_or_else(|| origin.principal.clone()),
        kind => format!("{}:{}", kind.as_str(), origin.principal),
    }
}

/// A [`TableChange`] as the `change` field of the transact/undo/redo responses
/// (`contracts/runtime/data-documents-transact.schema.json`): `documentId` and `origin` plus
/// the change's own camelCase fields.
pub fn change_json(document_id: &str, origin: &Origin, change: &TableChange) -> serde_json::Value {
    // TableChange derives Serialize with rename_all = "camelCase" already; this just adds the
    // two fields the manager knows and the replica does not.
    let mut value = serde_json::to_value(change)
        .unwrap_or_else(|_| serde_json::Value::Object(serde_json::Map::new()));
    if let serde_json::Value::Object(map) = &mut value {
        map.insert(
            "documentId".to_owned(),
            serde_json::Value::from(document_id),
        );
        map.insert(
            "origin".to_owned(),
            serde_json::Value::from(render_origin(origin)),
        );
    }
    value
}

/// The `table/changed` bridge event payload (`contracts/runtime/table-changed.schema.json`):
/// [`change_json`] plus the document's workspace-relative `documentPath`.
pub fn table_changed_event(
    document_id: &str,
    origin: &Origin,
    document_path: &str,
    change: &TableChange,
) -> serde_json::Value {
    let mut value = change_json(document_id, origin, change);
    value["documentPath"] = serde_json::Value::from(document_path);
    value
}

#[cfg(test)]
mod tests {
    use std::thread;

    use kition_kitable::CreateOptions;

    use super::*;

    fn kitable_at(dir: &std::path::Path, name: &str) -> PathBuf {
        let path = dir.join(format!("{name}.kitable"));
        let mut file = KitableFile::create(&path, &CreateOptions::default())
            .unwrap_or_else(|err| panic!("{err}"));
        file.create_table(&kition_kitable::TableSpec {
            name: "Items".into(),
            fields: vec![kition_kitable::FieldSpec {
                name: "Title".into(),
                field_type: "text".into(),
                primary: true,
                required: true,
                ..Default::default()
            }],
            ..Default::default()
        })
        .unwrap_or_else(|err| panic!("{err}"));
        path
    }

    #[test]
    fn two_opens_of_one_path_share_one_file() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let path = kitable_at(dir.path(), "a");
        let documents = TableDocuments::default();

        let (first, merge) = documents
            .open(&path, Origin::person("session:1"))
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(merge, None);
        assert_eq!(documents.open_count(), 1);
        drop(first);

        let (second, _) = documents
            .open(&path, Origin::person("session:2"))
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(documents.open_count(), 1, "the same path reuses the entry");
        drop(second);
    }

    #[test]
    fn concurrent_writers_serialize_instead_of_racing_sqlite() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let path = kitable_at(dir.path(), "a");
        let documents = Arc::new(TableDocuments::default());

        let threads: Vec<_> = (0..8)
            .map(|n| {
                let documents = documents.clone();
                let path = path.clone();
                thread::spawn(move || {
                    for i in 0..10 {
                        let (mut handle, _) = documents
                            .open(&path, Origin::person(format!("session:{n}")))
                            .unwrap_or_else(|err| panic!("{err}"));
                        let table = handle
                            .list_tables()
                            .unwrap_or_else(|err| panic!("{err}"))
                            .remove(0);
                        handle
                            .create_record(
                                table.id,
                                &serde_json::Map::from_iter([(
                                    "title".to_owned(),
                                    serde_json::Value::from(format!("{n}-{i}")),
                                )]),
                            )
                            .unwrap_or_else(|err| panic!("{err}"));
                    }
                })
            })
            .collect();
        for thread in threads {
            thread
                .join()
                .unwrap_or_else(|_| panic!("a writer thread panicked"));
        }

        let (handle, _) = documents
            .open(&path, Origin::person("session:check"))
            .unwrap_or_else(|err| panic!("{err}"));
        let table = handle
            .list_tables()
            .unwrap_or_else(|err| panic!("{err}"))
            .remove(0);
        let count = handle
            .count_records(table.id)
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(
            count, 80,
            "every writer's records landed, none lost to a race"
        );
    }

    #[test]
    fn idle_entries_close_once_nothing_holds_a_handle() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let path = kitable_at(dir.path(), "a");
        let documents = TableDocuments::default();

        let (handle, _) = documents
            .open(&path, Origin::person("session:1"))
            .unwrap_or_else(|err| panic!("{err}"));
        documents.evict_idle_older_than(Duration::ZERO);
        assert_eq!(documents.open_count(), 1, "a held handle is never evicted");
        drop(handle);

        documents.evict_idle_older_than(Duration::ZERO);
        assert_eq!(documents.open_count(), 0, "an unheld, idle entry closes");
    }

    #[test]
    fn origin_headers_map_as_specified() {
        assert_eq!(
            origin_from_headers(Some(" abc-123 "), None),
            Origin::person("session:abc-123")
        );
        assert_eq!(
            origin_from_headers(None, Some("template")),
            Origin::system("template")
        );
        assert_eq!(
            origin_from_headers(Some(""), Some("template")),
            Origin::system("template")
        );
        assert_eq!(
            origin_from_headers(None, None),
            Origin::person("session:unknown")
        );
    }

    #[test]
    fn origin_renders_as_the_contract_describes() {
        assert_eq!(
            render_origin(&Origin::person("session:abc")),
            "person:session:abc"
        );
        assert_eq!(render_origin(&Origin::agent("turn-1")), "agent:turn-1");
        assert_eq!(render_origin(&Origin::system("template")), "template");
    }

    #[test]
    fn change_json_matches_the_contracts_table_change_shape() {
        let change = TableChange {
            tables: vec![1],
            schema: vec![1],
            views: vec![2],
            records_upserted: vec![(1, "r1".into())],
            records_deleted: vec![(1, "r2".into())],
            records_reordered: vec![1],
            dashboards: true,
        };
        let value = change_json("42", &Origin::person("session:abc"), &change);
        assert_eq!(
            value,
            serde_json::json!({
                "documentId": "42",
                "origin": "person:session:abc",
                "tables": [1],
                "schema": [1],
                "views": [2],
                "recordsUpserted": [[1, "r1"]],
                "recordsDeleted": [[1, "r2"]],
                "recordsReordered": [1],
                "dashboards": true,
            })
        );
    }

    #[test]
    fn table_changed_event_adds_the_document_path() {
        let change = TableChange::default();
        let value = table_changed_event("42", &Origin::agent("turn-9"), "Notes/a.kitable", &change);
        assert_eq!(value["documentId"], "42");
        assert_eq!(value["origin"], "agent:turn-9");
        assert_eq!(value["documentPath"], "Notes/a.kitable");
        assert_eq!(value["dashboards"], false);
    }
}
