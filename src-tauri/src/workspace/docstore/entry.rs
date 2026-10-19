//! One document's replica in the store (format 2):
//!
//! ```text
//! <docId>/meta.json          the manifest: the renderer's meta, and the files of the replica
//! <docId>/snapshot.bin       the latest compacted snapshot
//! <docId>/changes/<seq>.bin  the changes after the snapshot, append-only
//! <docId>/blobs/<sha256>     a kit replica's blobs (see `blobs`)
//! <docId>/history.json       the device's version history (see `history`)
//! ```
//!
//! A save appends only the changes since the last stored version, as the next
//! `changes/<seq>.bin` (written and synced, then renamed into place), and then
//! replaces the manifest, which names every file with its hash. The snapshot is
//! rewritten only when the change log is compacted: the manifest first names
//! the new snapshot as `pending`, then the snapshot is renamed into place, then
//! the manifest names it and drops the changes it holds. So a crash at any
//! point leaves a manifest and files that read as a stored version: a change
//! file the manifest does not name yet (a torn or interrupted append) is
//! ignored and written over by the next append, and a snapshot renamed before
//! its manifest is recognised as the pending one.
//!
//! Format 1 (one `snapshot.bin`, one `blobs.bin`, a meta file with their hashes)
//! stays readable. The store's writer migrates such an entry when it reads it:
//! it keeps a copy of the old files in `format-1-backup/`, writes the blob
//! files and the new manifest, reads the entry back, and only when it reads
//! the same meta, snapshot, and blobs removes the backup and `blobs.bin`;
//! otherwise it puts the old manifest back.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::blobs::{self, BlobRecord};
use super::{check_meta, ensure_store, read_confined, sha256_hex};
use crate::workspace::safety::{assert_safe, invalid, write_atomically};

/// The error an append fails with when the store is not at the version the
/// writer named (another writer, or a store the writer has not read).
pub const STORE_CONFLICT: &str = "DOCUMENT_STORE_CONFLICT";

pub(super) const META_FILE: &str = "meta.json";
pub(super) const SNAPSHOT_FILE: &str = "snapshot.bin";
pub(super) const LEGACY_BLOBS_FILE: &str = "blobs.bin";
pub(super) const CHANGES_DIR: &str = "changes";
pub(super) const BACKUP_DIR: &str = "format-1-backup";
const FORMAT_1: u64 = 1;
pub(super) const FORMAT: u64 = 2;

/// A save after this many changes since the snapshot is told to compact.
pub const COMPACT_AFTER_CHANGES: usize = 64;
/// … or after the changes since the snapshot reach this size, or the
/// snapshot's own size if that is larger.
pub const COMPACT_AFTER_BYTES: u64 = 8 << 20;

/// A file the manifest names: its hash, size, and the version (`seq`) it
/// brings the replica to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRecord {
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub seq: u64,
}

impl FileRecord {
    fn of(bytes: &[u8], seq: u64) -> Self {
        Self {
            sha256: sha256_hex(bytes),
            size: bytes.len() as u64,
            seq,
        }
    }

    fn matches(&self, bytes: &[u8]) -> bool {
        self.size == bytes.len() as u64 && self.sha256 == sha256_hex(bytes)
    }
}

/// The stored version: the last `seq`, and the replica version (an opaque
/// string the writer names, the KDM version in hex) it holds.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Head {
    pub seq: u64,
    #[serde(default)]
    pub version: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Manifest {
    pub format: u64,
    pub meta: Value,
    pub snapshot: FileRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<Pending>,
    #[serde(default)]
    pub changes: Vec<FileRecord>,
    #[serde(default)]
    pub head: Head,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blobs: Option<BlobRecord>,
}

/// A compaction in flight: the snapshot about to be renamed into place, with
/// the meta, version, and blobs that go with it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Pending {
    pub snapshot: FileRecord,
    pub meta: Value,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blobs: Option<BlobRecord>,
}

/// One stored replica: the renderer's meta, the snapshot and the changes after
/// it (load the snapshot, then import the changes in order), and a kit
/// replica's blob bundle. `complete` is false when a change or blob the
/// manifest names is missing or damaged (a store synced in part, a damaged
/// disk): the entry then holds the changes before it, and no blobs.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub meta: Value,
    pub snapshot: Vec<u8>,
    pub changes: Vec<Vec<u8>>,
    pub blobs: Option<Vec<u8>>,
    pub head: Head,
    pub complete: bool,
}

/// What a write stores: a whole snapshot (a first write, a compaction, or a
/// replica of a new lineage), or the changes since the stored `base_seq`.
pub enum Body<'a> {
    Snapshot(&'a [u8]),
    Changes { bytes: &'a [u8], base_seq: u64 },
}

pub struct Write<'a> {
    pub meta: &'a Value,
    pub body: Body<'a>,
    /// The replica version the write brings the store to.
    pub version: Option<&'a str>,
    pub blobs: Option<&'a [u8]>,
}

/// What a write answers: the stored `seq`, and whether the next write should
/// carry a snapshot (the change log is due for compaction).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Written {
    pub head: Head,
    pub compact: bool,
    /// The blobs the stored version names.
    pub blobs: Option<BlobRecord>,
}

fn change_path(dir: &Path, seq: u64) -> PathBuf {
    dir.join(CHANGES_DIR).join(format!("{seq}.bin"))
}

fn read_file(root: &Path, path: &Path) -> io::Result<Option<Vec<u8>>> {
    read_confined(root, path)
}

fn parse_manifest(doc_id: &str, bytes: &[u8]) -> Option<Manifest> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    if value.get("format").and_then(Value::as_u64) != Some(FORMAT) {
        return None;
    }
    let manifest: Manifest = serde_json::from_value(value).ok()?;
    check_meta(doc_id, &manifest.meta).ok()?;
    Some(manifest)
}

/// The manifest of a format-2 entry, or `None` (no entry, another format, or
/// a damaged manifest).
pub(super) fn read_manifest(root: &Path, dir: &Path, doc_id: &str) -> io::Result<Option<Manifest>> {
    Ok(read_file(root, &dir.join(META_FILE))?.and_then(|bytes| parse_manifest(doc_id, &bytes)))
}

fn write_manifest(root: &Path, dir: &Path, manifest: &Manifest) -> io::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(manifest).map_err(io::Error::other)?;
    bytes.push(b'\n');
    let path = dir.join(META_FILE);
    assert_safe(root, &path, true)?;
    write_atomically(&path, &bytes)
}

/// Whether the stored meta file is format 1.
fn is_format_1(bytes: &[u8]) -> bool {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|value| value.get("format").and_then(Value::as_u64))
        == Some(FORMAT_1)
}

/// A format-1 entry: one snapshot and one blob bundle, each named by hash in
/// the meta file.
fn read_format_1(
    root: &Path,
    dir: &Path,
    doc_id: &str,
    meta_bytes: &[u8],
) -> io::Result<Option<Entry>> {
    let Ok(stored) = serde_json::from_slice::<Value>(meta_bytes) else {
        return Ok(None);
    };
    let Some(snapshot) = read_file(root, &dir.join(SNAPSHOT_FILE))? else {
        return Ok(None);
    };
    let hash = stored.pointer("/snapshot/sha256").and_then(Value::as_str);
    let meta = stored.get("meta").cloned().unwrap_or(Value::Null);
    if hash != Some(sha256_hex(&snapshot).as_str()) || check_meta(doc_id, &meta).is_err() {
        return Ok(None);
    }
    let blobs = match stored.get("blobs").filter(|blobs| !blobs.is_null()) {
        None => None,
        Some(record) => {
            let Some(blobs) = read_file(root, &dir.join(LEGACY_BLOBS_FILE))? else {
                return Ok(None);
            };
            if record.get("sha256").and_then(Value::as_str) != Some(sha256_hex(&blobs).as_str()) {
                return Ok(None);
            }
            Some(blobs)
        }
    };
    Ok(Some(Entry {
        meta,
        snapshot,
        changes: Vec::new(),
        blobs,
        head: Head::default(),
        complete: true,
    }))
}

/// A format-2 entry as its manifest names it.
fn read_format_2(root: &Path, dir: &Path, manifest: &Manifest) -> io::Result<Option<Entry>> {
    let Some(snapshot) = read_file(root, &dir.join(SNAPSHOT_FILE))? else {
        return Ok(None);
    };
    // The snapshot the manifest names, or the pending one of a compaction that
    // stopped after its rename: it holds every change up to its `seq`, and
    // goes with the meta, version, and blobs named with it.
    if !manifest.snapshot.matches(&snapshot) {
        let Some(pending) = manifest
            .pending
            .as_ref()
            .filter(|pending| pending.snapshot.matches(&snapshot))
        else {
            return Ok(None);
        };
        let (blobs, complete) = match &pending.blobs {
            None => (None, true),
            Some(record) => {
                let loaded = blobs::load(root, dir, record)?;
                let complete = loaded.is_some();
                (loaded, complete)
            }
        };
        return Ok(Some(Entry {
            meta: pending.meta.clone(),
            snapshot,
            changes: Vec::new(),
            blobs,
            head: Head {
                seq: pending.snapshot.seq,
                version: pending.version.clone(),
            },
            complete,
        }));
    }
    let base = &manifest.snapshot;
    let mut head = Head {
        seq: base.seq,
        version: None,
    };
    let mut changes = Vec::new();
    let mut complete = true;
    for record in manifest
        .changes
        .iter()
        .filter(|record| record.seq > base.seq)
    {
        match read_file(root, &change_path(dir, record.seq))? {
            Some(bytes) if record.matches(&bytes) => {
                changes.push(bytes);
                head.seq = record.seq;
            }
            _ => {
                complete = false;
                break;
            }
        }
    }
    if complete {
        head = manifest.head.clone();
    }
    let blobs = match &manifest.blobs {
        None => None,
        Some(record) => {
            let loaded = blobs::load(root, dir, record)?;
            if loaded.is_none() {
                complete = false;
            }
            loaded
        }
    };
    Ok(Some(Entry {
        meta: manifest.meta.clone(),
        snapshot,
        changes,
        blobs,
        head,
        complete,
    }))
}

/// Reads the entry in `dir` (format 1 or 2), or `None` when there is none or
/// it is damaged. Callers serialise access to the entry.
pub(super) fn read(root: &Path, dir: &Path, doc_id: &str) -> io::Result<Option<Entry>> {
    let Some(meta_bytes) = read_file(root, &dir.join(META_FILE))? else {
        return Ok(None);
    };
    if is_format_1(&meta_bytes) {
        return read_format_1(root, dir, doc_id, &meta_bytes);
    }
    match parse_manifest(doc_id, &meta_bytes) {
        Some(manifest) => read_format_2(root, dir, &manifest),
        None => Ok(None),
    }
}

/// The head (and meta) of the entry without its bytes: what a writer needs to
/// append. Format-1 entries answer `seq` 0 and no version.
pub(super) fn read_head(
    root: &Path,
    dir: &Path,
    doc_id: &str,
) -> io::Result<Option<(Value, Head)>> {
    let Some(meta_bytes) = read_file(root, &dir.join(META_FILE))? else {
        return Ok(None);
    };
    if is_format_1(&meta_bytes) {
        return Ok(read_format_1(root, dir, doc_id, &meta_bytes)?
            .map(|entry| (entry.meta, Head::default())));
    }
    Ok(parse_manifest(doc_id, &meta_bytes).map(|manifest| (manifest.meta, manifest.head)))
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

fn remove_dir_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Copies `from` to `to` (a hard link where the file system allows it).
fn keep_copy(from: &Path, to: &Path) -> io::Result<()> {
    remove_if_present(to)?;
    if fs::hard_link(from, to).is_ok() {
        return Ok(());
    }
    let bytes = fs::read(from)?;
    write_atomically(to, &bytes)
}

/// Migrates a format-1 entry to format 2 (see the module documentation).
/// Answers whether the entry is format 2 now; a format-1 entry that is
/// damaged, or that does not read back the same, stays as it was.
pub(super) fn migrate(root: &Path, dir: &Path, doc_id: &str) -> io::Result<bool> {
    let Some(meta_bytes) = read_file(root, &dir.join(META_FILE))? else {
        return Ok(false);
    };
    if !is_format_1(&meta_bytes) {
        return Ok(parse_manifest(doc_id, &meta_bytes).is_some());
    }
    let Some(old) = read_format_1(root, dir, doc_id, &meta_bytes)? else {
        return Ok(false);
    };
    let backup = dir.join(BACKUP_DIR);
    assert_safe(root, &backup, true)?;
    fs::create_dir_all(&backup)?;
    write_atomically(&backup.join(META_FILE), &meta_bytes)?;
    keep_copy(&dir.join(SNAPSHOT_FILE), &backup.join(SNAPSHOT_FILE))?;
    if old.blobs.is_some() {
        keep_copy(
            &dir.join(LEGACY_BLOBS_FILE),
            &backup.join(LEGACY_BLOBS_FILE),
        )?;
    }
    let blobs = match &old.blobs {
        Some(bundle) => Some(blobs::store(root, dir, bundle)?),
        None => None,
    };
    let manifest = Manifest {
        format: FORMAT,
        meta: old.meta.clone(),
        snapshot: FileRecord::of(&old.snapshot, 0),
        pending: None,
        changes: Vec::new(),
        head: Head::default(),
        blobs,
    };
    write_manifest(root, dir, &manifest)?;
    let verified = read(root, dir, doc_id)?.is_some_and(|entry| {
        entry.complete
            && entry.meta == old.meta
            && entry.snapshot == old.snapshot
            && entry.blobs == old.blobs
    });
    if !verified {
        // Put the old manifest back: the entry stays format 1, as it was.
        write_atomically(&dir.join(META_FILE), &meta_bytes)?;
        return Ok(false);
    }
    remove_if_present(&dir.join(LEGACY_BLOBS_FILE))?;
    remove_dir_if_present(&backup)?;
    Ok(true)
}

fn compact_due(manifest: &Manifest) -> bool {
    let bytes: u64 = manifest.changes.iter().map(|record| record.size).sum();
    manifest.changes.len() >= COMPACT_AFTER_CHANGES
        || bytes >= COMPACT_AFTER_BYTES.max(manifest.snapshot.size)
}

/// Writes a replica (see `Write`). Appending changes needs a format-2 entry at
/// `base_seq`; anything else fails with `STORE_CONFLICT`, and the writer writes
/// a snapshot instead. Callers serialise access to the entry, and migrate a
/// format-1 entry first.
pub(super) fn write(
    root: &Path,
    dir: &Path,
    doc_id: &str,
    input: &Write<'_>,
) -> io::Result<Written> {
    check_meta(doc_id, input.meta)?;
    let current = read_manifest(root, dir, doc_id)?;
    match input.body {
        Body::Changes { bytes, base_seq } => {
            let Some(mut manifest) = current else {
                return Err(io::Error::other(STORE_CONFLICT));
            };
            // The append continues the version the reader saw, whole: never a
            // store whose snapshot is not the one its manifest names.
            let snapshot_ok = read_file(root, &dir.join(SNAPSHOT_FILE))?
                .is_some_and(|snapshot| manifest.snapshot.matches(&snapshot));
            if manifest.head.seq != base_seq || manifest.pending.is_some() || !snapshot_ok {
                return Err(io::Error::other(STORE_CONFLICT));
            }
            let seq = base_seq + 1;
            let changes_dir = dir.join(CHANGES_DIR);
            assert_safe(root, &changes_dir, true)?;
            fs::create_dir_all(&changes_dir)?;
            let path = change_path(dir, seq);
            assert_safe(root, &path, true)?;
            // Written and synced under a temporary name, then renamed: a crash
            // leaves no torn file under the name, and the manifest does not
            // name the change until it is whole.
            write_atomically(&path, bytes)?;
            if let Some(bundle) = input.blobs {
                manifest.blobs = Some(blobs::store(root, dir, bundle)?);
            }
            manifest.meta = input.meta.clone();
            manifest.changes.push(FileRecord::of(bytes, seq));
            manifest.head = Head {
                seq,
                version: input.version.map(str::to_owned),
            };
            write_manifest(root, dir, &manifest)?;
            Ok(Written {
                head: manifest.head.clone(),
                compact: compact_due(&manifest),
                blobs: manifest.blobs,
            })
        }
        Body::Snapshot(snapshot) => {
            ensure_store(root)?;
            assert_safe(root, dir, true)?;
            fs::create_dir_all(dir)?;
            let seq = current.as_ref().map_or(0, |manifest| manifest.head.seq) + 1;
            let record = FileRecord::of(snapshot, seq);
            let blobs = match input.blobs {
                Some(bundle) => Some(blobs::store(root, dir, bundle)?),
                None => None,
            };
            let version = input.version.map(str::to_owned);
            if let Some(mut manifest) = current {
                // Named before the rename, so the snapshot is never one the
                // manifest does not know.
                manifest.pending = Some(Pending {
                    snapshot: record.clone(),
                    meta: input.meta.clone(),
                    version: version.clone(),
                    blobs: blobs.clone(),
                });
                write_manifest(root, dir, &manifest)?;
            }
            let snapshot_path = dir.join(SNAPSHOT_FILE);
            assert_safe(root, &snapshot_path, true)?;
            write_atomically(&snapshot_path, snapshot)?;
            let manifest = Manifest {
                format: FORMAT,
                meta: input.meta.clone(),
                snapshot: record,
                pending: None,
                changes: Vec::new(),
                head: Head { seq, version },
                blobs,
            };
            write_manifest(root, dir, &manifest)?;
            let changes_dir = dir.join(CHANGES_DIR);
            assert_safe(root, &changes_dir, true)?;
            remove_dir_if_present(&changes_dir)?;
            remove_if_present(&dir.join(LEGACY_BLOBS_FILE))?;
            Ok(Written {
                head: manifest.head,
                compact: false,
                blobs: manifest.blobs,
            })
        }
    }
}

/// Fails on an append of nothing (the store does not read replicas: any other
/// bytes are kept as they are).
pub(super) fn check_body(body: &Body<'_>) -> io::Result<()> {
    match body {
        Body::Changes { bytes: [], .. } => Err(invalid("document store changes are empty")),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DOC: &str = "doc-1";

    fn ok<T>(result: io::Result<T>) -> T {
        result.unwrap_or_else(|err| panic!("{err}"))
    }

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = temp.path().join("workspace");
        ok(fs::create_dir_all(&root));
        let dir = root.join(".kition/docs").join(DOC);
        (temp, root, dir)
    }

    fn meta(n: u64) -> Value {
        json!({ "docId": DOC, "kit": "kit.test", "path": "a.test", "n": n })
    }

    fn snapshot(root: &Path, dir: &Path, bytes: &[u8], version: &str) -> Written {
        ok(write(
            root,
            dir,
            DOC,
            &Write {
                meta: &meta(0),
                body: Body::Snapshot(bytes),
                version: Some(version),
                blobs: None,
            },
        ))
    }

    fn append(
        root: &Path,
        dir: &Path,
        bytes: &[u8],
        base_seq: u64,
        version: &str,
    ) -> io::Result<Written> {
        write(
            root,
            dir,
            DOC,
            &Write {
                meta: &meta(base_seq + 1),
                body: Body::Changes { bytes, base_seq },
                version: Some(version),
                blobs: None,
            },
        )
    }

    fn joined(entry: &Entry) -> Vec<u8> {
        let mut out = entry.snapshot.clone();
        for change in &entry.changes {
            out.extend_from_slice(change);
        }
        out
    }

    #[test]
    fn appends_changes_and_compacts_into_a_snapshot() {
        let (_temp, root, dir) = setup();
        assert_eq!(snapshot(&root, &dir, b"s;", "v1").head.seq, 1);
        assert!(
            append(&root, &dir, b"x;", 0, "v")
                .is_err_and(|error| error.to_string() == STORE_CONFLICT)
        );
        let written = ok(append(&root, &dir, b"a;", 1, "v2"));
        assert_eq!(
            written.head,
            Head {
                seq: 2,
                version: Some("v2".into())
            }
        );
        ok(append(&root, &dir, b"b;", 2, "v3"));
        // The snapshot is not rewritten by an append.
        assert_eq!(ok(fs::read(dir.join(SNAPSHOT_FILE))), b"s;");
        let entry = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(entry.changes, vec![b"a;".to_vec(), b"b;".to_vec()]);
        assert_eq!(
            entry.head,
            Head {
                seq: 3,
                version: Some("v3".into())
            }
        );
        assert_eq!(entry.meta, meta(3));
        assert!(entry.complete);

        // A compaction folds the changes into the snapshot and drops their files.
        assert_eq!(snapshot(&root, &dir, b"s;a;b;", "v3").head.seq, 4);
        assert!(!dir.join(CHANGES_DIR).exists());
        let entry = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(
            (entry.snapshot.as_slice(), entry.changes.len()),
            (&b"s;a;b;"[..], 0)
        );
    }

    #[test]
    fn asks_for_a_compaction_when_the_log_grows() {
        let (_temp, root, dir) = setup();
        snapshot(&root, &dir, b"s", "v");
        let mut compact = false;
        for seq in 1..=COMPACT_AFTER_CHANGES as u64 {
            compact = ok(append(&root, &dir, b"c", seq, "v")).compact;
            assert_eq!(compact, seq == COMPACT_AFTER_CHANGES as u64, "{seq}");
        }
        assert!(compact);
        let big = vec![7u8; (COMPACT_AFTER_BYTES + 1) as usize];
        let (_temp2, root2, dir2) = setup();
        snapshot(&root2, &dir2, b"s", "v");
        assert!(ok(append(&root2, &dir2, &big, 1, "v")).compact);
    }

    #[test]
    fn ignores_a_change_the_manifest_does_not_name_and_reads_a_partial_log() {
        let (_temp, root, dir) = setup();
        snapshot(&root, &dir, b"s;", "v1");
        ok(append(&root, &dir, b"a;", 1, "v2"));
        // An append that stopped before its manifest: a whole or torn file under the next name.
        ok(fs::write(change_path(&dir, 3), b"tor"));
        let entry = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(joined(&entry), b"s;a;");
        assert_eq!(entry.head.seq, 2);
        // The next append writes over it.
        ok(append(&root, &dir, b"b;", 2, "v3"));
        let entry = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(joined(&entry), b"s;a;b;");

        // A change the manifest names that is missing (a store synced in part):
        // the changes before it, marked incomplete, with no version.
        ok(fs::remove_file(change_path(&dir, 3)));
        let entry = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(joined(&entry), b"s;a;");
        assert!(!entry.complete);
        assert_eq!(
            entry.head,
            Head {
                seq: 2,
                version: None
            }
        );
        // Nothing appends onto it; a snapshot replaces it.
        assert!(append(&root, &dir, b"c;", 2, "v").is_err());
        assert!(append(&root, &dir, b"c;", 3, "v").is_ok());
    }

    #[test]
    fn reads_a_compaction_that_stopped_at_any_step() {
        let (_temp, root, dir) = setup();
        snapshot(&root, &dir, b"s;", "v1");
        ok(append(&root, &dir, b"a;", 1, "v2"));
        let before = ok(fs::read(dir.join(META_FILE)));
        // Step 1 done: the manifest names the pending snapshot; the old one is still in place.
        let mut manifest =
            ok(read_manifest(&root, &dir, DOC)).unwrap_or_else(|| panic!("no manifest"));
        manifest.pending = Some(Pending {
            snapshot: FileRecord::of(b"s;a;", 3),
            meta: meta(3),
            version: Some("v3".into()),
            blobs: None,
        });
        ok(write_manifest(&root, &dir, &manifest));
        let entry = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(joined(&entry), b"s;a;");
        // Step 2 done: the new snapshot is in place, the manifest not yet rewritten.
        ok(fs::write(dir.join(SNAPSHOT_FILE), b"s;a;"));
        let entry = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(
            (joined(&entry).as_slice(), entry.changes.len()),
            (&b"s;a;"[..], 0)
        );
        assert_eq!((entry.head.seq, entry.meta.clone()), (3, meta(3)));
        // An append is refused until a snapshot write finishes the compaction.
        assert!(append(&root, &dir, b"b;", 2, "v").is_err());
        // A snapshot the manifest does not know (no pending) reads as no entry.
        ok(fs::write(dir.join(META_FILE), &before));
        assert_eq!(ok(read(&root, &dir, DOC)), None);
    }

    #[test]
    fn migrates_a_format_1_entry_and_keeps_it_when_it_does_not_verify() {
        let (_temp, root, dir) = setup();
        ok(fs::create_dir_all(&dir));
        let bundle = blobs::bundle(&[b"pixels", b"font"]);
        let old_meta = json!({
            "format": 1,
            "meta": meta(1),
            "snapshot": { "sha256": sha256_hex(b"snap"), "size": 4 },
            "blobs": { "sha256": sha256_hex(&bundle), "size": bundle.len() },
        });
        let old_meta_bytes = ok(serde_json::to_vec(&old_meta).map_err(io::Error::other));
        ok(fs::write(dir.join(META_FILE), &old_meta_bytes));
        ok(fs::write(dir.join(SNAPSHOT_FILE), b"snap"));
        ok(fs::write(dir.join(LEGACY_BLOBS_FILE), &bundle));
        let old = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("format 1 unreadable"));
        assert_eq!(old.blobs.as_deref(), Some(bundle.as_slice()));

        assert!(ok(migrate(&root, &dir, DOC)));
        let migrated = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(
            (
                migrated.meta.clone(),
                migrated.snapshot.clone(),
                migrated.blobs.clone()
            ),
            (old.meta.clone(), old.snapshot.clone(), old.blobs.clone())
        );
        assert!(!dir.join(LEGACY_BLOBS_FILE).exists());
        assert!(!dir.join(BACKUP_DIR).exists());
        assert_eq!(
            fs::read_dir(dir.join(blobs::BLOBS_DIR))
                .map(Iterator::count)
                .unwrap_or(0),
            2
        );
        // Migrating again changes nothing.
        assert!(ok(migrate(&root, &dir, DOC)));

        // A format-1 entry that is damaged is left alone.
        let (_temp2, root2, dir2) = setup();
        ok(fs::create_dir_all(&dir2));
        ok(fs::write(dir2.join(META_FILE), &old_meta_bytes));
        ok(fs::write(dir2.join(SNAPSHOT_FILE), b"other"));
        assert!(!ok(migrate(&root2, &dir2, DOC)));
        assert_eq!(ok(fs::read(dir2.join(META_FILE))), old_meta_bytes);
    }

    #[test]
    fn keeps_blobs_by_hash_across_appends() {
        let (_temp, root, dir) = setup();
        let first = blobs::bundle(&[b"a"]);
        ok(write(
            &root,
            &dir,
            DOC,
            &Write {
                meta: &meta(0),
                body: Body::Snapshot(b"s"),
                version: None,
                blobs: Some(&first),
            },
        ));
        let second = blobs::bundle(&[b"a", b"b"]);
        ok(write(
            &root,
            &dir,
            DOC,
            &Write {
                meta: &meta(0),
                body: Body::Changes {
                    bytes: b"c",
                    base_seq: 1,
                },
                version: None,
                blobs: Some(&second),
            },
        ));
        let entry = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(entry.blobs, Some(second));
    }

    /// The child of `survives_being_killed_mid_write`: appends `c<n>;` for
    /// ever, compacting every 7 changes, after announcing its first write.
    #[test]
    #[ignore = "run by survives_being_killed_mid_write"]
    fn crash_child() {
        let Ok(base) = std::env::var("KITION_DOCSTORE_CRASH_ROOT") else {
            return;
        };
        let root = PathBuf::from(base);
        let dir = root.join(".kition/docs").join(DOC);
        let mut text = String::new();
        let mut seq = 0u64;
        for n in 1u64..u64::MAX {
            let change = format!("c{n};");
            text.push_str(&change);
            let version = n.to_string();
            let written = if n % 7 == 0 {
                write(
                    &root,
                    &dir,
                    DOC,
                    &Write {
                        meta: &meta(n),
                        body: Body::Snapshot(text.as_bytes()),
                        version: Some(&version),
                        blobs: None,
                    },
                )
            } else if n == 1 {
                write(
                    &root,
                    &dir,
                    DOC,
                    &Write {
                        meta: &meta(n),
                        body: Body::Snapshot(change.as_bytes()),
                        version: Some(&version),
                        blobs: None,
                    },
                )
            } else {
                write(
                    &root,
                    &dir,
                    DOC,
                    &Write {
                        meta: &meta(n),
                        body: Body::Changes {
                            bytes: change.as_bytes(),
                            base_seq: seq,
                        },
                        version: Some(&version),
                        blobs: None,
                    },
                )
            };
            seq = ok(written).head.seq;
            if n == 1 {
                println!("KITION-CRASH-READY");
            }
        }
    }

    /// Kills a writer at random points and checks that what it left reads as
    /// one of the versions it wrote, whole.
    #[test]
    fn survives_being_killed_mid_write() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        for round in 0..6u64 {
            let (_temp, root, dir) = setup();
            let mut child = ok(Command::new(&exe)
                .args([
                    "--exact",
                    "workspace::docstore::entry::tests::crash_child",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("KITION_DOCSTORE_CRASH_ROOT", &root)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn());
            let Some(stdout) = child.stdout.take() else {
                panic!("no child output");
            };
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next() {
                    Some(Ok(line)) if line.contains("KITION-CRASH-READY") => break,
                    Some(_) => {}
                    None => panic!("the writer stopped before its first write"),
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20 + round * 37));
            ok(child.kill());
            ok(child.wait());
            let entry = ok(read(&root, &dir, DOC))
                .unwrap_or_else(|| panic!("round {round}: the store reads as no entry"));
            assert!(entry.complete, "round {round}");
            let text = String::from_utf8(joined(&entry)).unwrap_or_default();
            let count = text.matches(';').count() as u64;
            let expected: String = (1..=count).map(|n| format!("c{n};")).collect();
            assert_eq!(text, expected, "round {round}");
            assert!(count >= 1, "round {round}");
            if let Some(version) = &entry.head.version {
                assert_eq!(version, &count.to_string(), "round {round}");
            }
            assert_eq!(entry.meta["n"].as_u64(), Some(count), "round {round}");
        }
    }
}
