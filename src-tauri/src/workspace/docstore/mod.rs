//! The private store of document replicas under `.kition/docs/`: Markdown
//! documents', boards' history, and those kit editors keep for their files
//! (Kit UI protocol capability `replica`).
//!
//! ```text
//! .kition/docs/
//!   .gitignore                 keeps the store out of the workspace's Git history
//!   index.json                 workspace paths to document ids
//!   store.lock                 the store's one writer (`lock`)
//!   <docId>/                   one document (`entry`, `blobs`, `history`)
//! ```
//!
//! The store is local to this machine, and deleting it loses only editing
//! history, never document text: the workspace file is the document. Reads and
//! writes of one document, and of the index, are serialised; only the Kition
//! that holds the store lock writes.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub mod blobs;
pub mod entry;
pub mod history;
pub mod lock;

pub use entry::{Body, Entry, Head, Write, Written};
pub use history::{Checkpoint, CheckpointInput};
pub use lock::{STORE_READ_ONLY, StoreLock, StoreLocks};

use super::files::{check_expected_root, ensure_initialized};
use super::guarded::GuardedWrites;
use super::safety::{assert_safe, invalid, join_relative, normalize_relative, write_atomically};
use crate::request::Request;

/// The error a guarded index write fails with when the index changed since
/// the version the renderer expected.
pub const INDEX_CONFLICT: &str = "DOCUMENT_INDEX_CONFLICT";

const STORE_DIR: &str = ".kition/docs";
const INDEX_FILE: &str = "index.json";
const GITIGNORE_FILE: &str = ".gitignore";
const GITIGNORE: &str = "*\n!.gitignore\n";
const INDEX_FORMAT: u64 = 1;
const MAX_DOC_ID_LEN: usize = 128;

/// Whether this Kition may write the store (it holds the store lock).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Writer,
    ReadOnly,
}

impl Access {
    pub fn of(lock: &StoreLock) -> Self {
        if lock.is_writer() {
            Self::Writer
        } else {
            Self::ReadOnly
        }
    }

    fn check(self) -> io::Result<()> {
        match self {
            Self::Writer => Ok(()),
            Self::ReadOnly => Err(io::Error::other(STORE_READ_ONLY)),
        }
    }
}

/// The path-to-document index and the version a guarded write must name.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Index {
    pub entries: BTreeMap<String, String>,
    pub version: Option<String>,
}

/// Accepts `^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$`.
pub fn validate_doc_id(doc_id: &str) -> io::Result<()> {
    let bytes = doc_id.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= MAX_DOC_ID_LEN
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(invalid("invalid document id"))
    }
}

/// The folder name of a document: its id, with `:` (not allowed in Windows
/// file names) written as `%3A`.
fn entry_folder_name(doc_id: &str) -> String {
    doc_id.replace(':', "%3A")
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn store_dir(root: &Path) -> PathBuf {
    join_relative(root, STORE_DIR)
}

fn entry_dir(root: &Path, doc_id: &str) -> io::Result<PathBuf> {
    validate_doc_id(doc_id)?;
    Ok(store_dir(root).join(entry_folder_name(doc_id)))
}

fn index_path(root: &Path) -> PathBuf {
    store_dir(root).join(INDEX_FILE)
}

/// Reads a file inside the workspace, or `None` when it does not exist.
fn read_confined(root: &Path, path: &Path) -> io::Result<Option<Vec<u8>>> {
    assert_safe(root, path, true)?;
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Creates `.kition/docs/` inside the workspace, with the `.gitignore` that
/// keeps it local, and returns it.
fn ensure_store(root: &Path) -> io::Result<PathBuf> {
    let dir = store_dir(root);
    assert_safe(root, &dir, true)?;
    fs::create_dir_all(&dir)?;
    assert_safe(root, &dir, false)?;
    let gitignore = dir.join(GITIGNORE_FILE);
    match fs::symlink_metadata(&gitignore) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            write_atomically(&gitignore, GITIGNORE.as_bytes())?;
        }
        Err(error) => return Err(error),
    }
    Ok(dir)
}

fn check_meta(doc_id: &str, meta: &Value) -> io::Result<()> {
    let Some(object) = meta.as_object() else {
        return Err(invalid("document store meta must be an object"));
    };
    if object.get("docId").and_then(Value::as_str) != Some(doc_id) {
        return Err(invalid("document store meta names another document"));
    }
    Ok(())
}

/// Reads `doc_id`'s replica, or `None` when there is none or it is damaged. The
/// writer migrates a format-1 entry as it reads it.
pub fn read_entry(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    doc_id: &str,
) -> io::Result<Option<Entry>> {
    let dir = entry_dir(root, doc_id)?;
    locks.exclusive(&dir, || {
        if access == Access::Writer {
            entry::migrate(root, &dir, doc_id)?;
        }
        entry::read(root, &dir, doc_id)
    })
}

/// The stored meta and head of `doc_id`, without the replica's bytes.
pub fn read_entry_head(
    root: &Path,
    locks: &GuardedWrites,
    doc_id: &str,
) -> io::Result<Option<(Value, Head)>> {
    let dir = entry_dir(root, doc_id)?;
    locks.exclusive(&dir, || entry::read_head(root, &dir, doc_id))
}

/// A replica write and what goes with it.
pub struct Save<'a> {
    pub write: Write<'a>,
    /// The replica is not a continuation of the stored one (a kit made a new
    /// replica for a file changed elsewhere): its history starts over.
    pub new_lineage: bool,
    pub checkpoint: Option<CheckpointInput>,
}

#[derive(Debug)]
pub struct Saved {
    pub written: Written,
    pub checkpoint: Option<Checkpoint>,
}

pub fn write_entry(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    doc_id: &str,
    save: Save<'_>,
) -> io::Result<Saved> {
    let dir = entry_dir(root, doc_id)?;
    check_meta(doc_id, save.write.meta)?;
    entry::check_body(&save.write.body)?;
    access.check()?;
    locks.exclusive(&dir, || {
        ensure_store(root)?;
        entry::migrate(root, &dir, doc_id)?;
        let compaction = matches!(save.write.body, Body::Snapshot(_));
        let written = entry::write(root, &dir, doc_id, &save.write)?;
        if save.new_lineage {
            history::clear(root, &dir)?;
        }
        let checkpoint = match save.checkpoint {
            Some(input) => {
                let input = CheckpointInput {
                    version: input.version.or_else(|| written.head.version.clone()),
                    ..input
                };
                Some(history::record(
                    root,
                    &dir,
                    input,
                    Some(written.head.seq),
                    written.blobs.clone(),
                )?)
            }
            None => None,
        };
        if compaction {
            let mut keep = history::blob_records(root, &dir)?;
            keep.extend(written.blobs.clone());
            blobs::collect_garbage(root, &dir, keep.iter())?;
        }
        Ok(Saved {
            written,
            checkpoint,
        })
    })
}

pub fn delete_entry(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    doc_id: &str,
) -> io::Result<()> {
    let dir = entry_dir(root, doc_id)?;
    access.check()?;
    locks.exclusive(&dir, || {
        assert_safe(root, &dir, true)?;
        match fs::remove_dir_all(&dir) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    })
}

/// The document's checkpoints, newest first.
pub fn read_history(
    root: &Path,
    locks: &GuardedWrites,
    doc_id: &str,
) -> io::Result<Vec<Checkpoint>> {
    let dir = entry_dir(root, doc_id)?;
    locks.exclusive(&dir, || history::list(root, &dir))
}

/// Records a checkpoint of `doc_id` at its stored version (for a stored
/// replica), or at `input.version` alone (a board, whose file holds its replica).
pub fn record_checkpoint(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    doc_id: &str,
    input: CheckpointInput,
) -> io::Result<Checkpoint> {
    let dir = entry_dir(root, doc_id)?;
    access.check()?;
    locks.exclusive(&dir, || {
        ensure_store(root)?;
        entry::migrate(root, &dir, doc_id)?;
        let manifest = entry::read_manifest(root, &dir, doc_id)?;
        let (seq, blobs) = match &manifest {
            Some(manifest) => (Some(manifest.head.seq), manifest.blobs.clone()),
            None => (None, None),
        };
        let input = CheckpointInput {
            version: input
                .version
                .or_else(|| manifest.and_then(|manifest| manifest.head.version)),
            ..input
        };
        history::record(root, &dir, input, seq, blobs)
    })
}

/// The checkpoint `id` and the blob bundle the replica named then.
pub fn read_checkpoint(
    root: &Path,
    locks: &GuardedWrites,
    doc_id: &str,
    id: &str,
) -> io::Result<Option<(Checkpoint, Option<Vec<u8>>)>> {
    let dir = entry_dir(root, doc_id)?;
    locks.exclusive(&dir, || {
        let Some(checkpoint) = history::find(root, &dir, id)? else {
            return Ok(None);
        };
        let bundle = match &checkpoint.blobs {
            Some(record) => blobs::load(root, &dir, record)?,
            None => None,
        };
        Ok(Some((checkpoint, bundle)))
    })
}

/// A stored index path is a normalized workspace path.
fn is_index_path(path: &str) -> bool {
    normalize_relative(path, false).is_ok_and(|normalized| normalized == path)
}

fn parse_index(bytes: &[u8]) -> BTreeMap<String, String> {
    let Ok(stored) = serde_json::from_slice::<Value>(bytes) else {
        return BTreeMap::new();
    };
    let Some(entries) = stored.get("entries").and_then(Value::as_object) else {
        return BTreeMap::new();
    };
    entries
        .iter()
        .filter_map(|(path, doc_id)| {
            let doc_id = doc_id.as_str()?;
            (is_index_path(path) && validate_doc_id(doc_id).is_ok())
                .then(|| (path.clone(), doc_id.to_owned()))
        })
        .collect()
}

/// The index; unreadable entries are left out, and the version is the hash of
/// the file, so a damaged index can still be replaced by a guarded write.
pub fn read_index(root: &Path, locks: &GuardedWrites) -> io::Result<Index> {
    let path = index_path(root);
    locks.exclusive(&path, || {
        Ok(match read_confined(root, &path)? {
            None => Index::default(),
            Some(bytes) => Index {
                entries: parse_index(&bytes),
                version: Some(sha256_hex(&bytes)),
            },
        })
    })
}

/// Replaces the index when it is still at `expected_version` (`None`: no index
/// yet) and returns the new version.
pub fn write_index(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    entries: &BTreeMap<String, String>,
    expected_version: Option<&str>,
) -> io::Result<String> {
    for (path, doc_id) in entries {
        if !is_index_path(path) {
            return Err(invalid("invalid document path in the document index"));
        }
        validate_doc_id(doc_id)?;
    }
    access.check()?;
    let mut bytes =
        serde_json::to_vec_pretty(&json!({ "format": INDEX_FORMAT, "entries": entries }))
            .map_err(io::Error::other)?;
    bytes.push(b'\n');
    let path = index_path(root);
    locks.exclusive(&path, || {
        let current = read_confined(root, &path)?.map(|current| sha256_hex(&current));
        if current.as_deref() != expected_version {
            return Err(io::Error::other(INDEX_CONFLICT));
        }
        ensure_store(root)?;
        write_atomically(&path, &bytes)?;
        Ok(sha256_hex(&bytes))
    })
}

// --- Renderer requests --------------------------------------------------

fn prepare(root: &Path, request: &Request) -> io::Result<()> {
    ensure_initialized(root)?;
    check_expected_root(root, request)
}

fn decode(request: &Request, key: &str, what: &str) -> io::Result<Option<Vec<u8>>> {
    match request.value(key).filter(|value| !value.is_null()) {
        None => Ok(None),
        Some(value) => BASE64
            .decode(value.as_str().unwrap_or_default().trim())
            .map(Some)
            .map_err(|_| invalid(format!("document store {what} is not base64"))),
    }
}

fn head_json(head: &Head) -> Value {
    json!({ "seq": head.seq, "version": head.version })
}

/// A checkpoint as the renderer sees it: without the store's blob record.
fn checkpoint_json(checkpoint: &Checkpoint) -> Value {
    let mut value = serde_json::to_value(checkpoint).unwrap_or(Value::Null);
    if let Some(object) = value.as_object_mut() {
        let has_blobs = object.remove("blobs").is_some();
        object.insert("hasBlobs".into(), Value::Bool(has_blobs));
    }
    value
}

fn checkpoint_input(value: &Value) -> io::Result<CheckpointInput> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let Some(origin) = text("origin") else {
        return Err(invalid("a checkpoint needs an origin"));
    };
    Ok(CheckpointInput {
        origin,
        author: text("author"),
        label: text("label"),
        version: text("version"),
        time: value.get("time").and_then(Value::as_u64),
    })
}

/// `{ doc_id, head_only?, expected_root? }` to `null`, or `{ meta, seq, version }`
/// with `head_only`, or `{ meta, snapshot_base64, changes_base64, blobs_base64?,
/// seq, version, complete }`.
pub fn read_entry_request(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let doc_id = request.str("doc_id");
    if request.bool("head_only") {
        return Ok(match read_entry_head(root, locks, &doc_id)? {
            None => Value::Null,
            Some((meta, head)) => json!({ "meta": meta, "seq": head.seq, "version": head.version }),
        });
    }
    Ok(match read_entry(root, locks, access, &doc_id)? {
        None => Value::Null,
        Some(entry) => {
            let mut payload = json!({
                "meta": entry.meta,
                "snapshot_base64": BASE64.encode(&entry.snapshot),
                "changes_base64": entry.changes.iter().map(|change| BASE64.encode(change)).collect::<Vec<_>>(),
                "seq": entry.head.seq,
                "version": entry.head.version,
                "complete": entry.complete,
            });
            if let Some(blobs) = entry.blobs {
                payload["blobs_base64"] = Value::String(BASE64.encode(blobs));
            }
            payload
        }
    })
}

/// `{ doc_id, meta, snapshot_base64 | changes_base64 + base_seq, version?,
/// blobs_base64?, lineage?: "new", checkpoint?: { origin, author?, label? },
/// expected_root? }` to `{ seq, version, compact, checkpoint? }`.
pub fn write_entry_request(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let meta = request.value("meta").cloned().unwrap_or(Value::Null);
    let snapshot = decode(request, "snapshot_base64", "snapshot")?;
    let changes = decode(request, "changes_base64", "changes")?;
    let blobs = decode(request, "blobs_base64", "blobs")?;
    let version = request.string("version");
    let body = match (&snapshot, &changes) {
        (Some(snapshot), None) => Body::Snapshot(snapshot),
        (None, Some(changes)) => {
            let Some(base_seq) = request.value("base_seq").and_then(Value::as_u64) else {
                return Err(invalid(
                    "appending changes needs the stored seq they follow",
                ));
            };
            Body::Changes {
                bytes: changes,
                base_seq,
            }
        }
        _ => {
            return Err(invalid(
                "a document store write carries a snapshot or changes",
            ));
        }
    };
    let checkpoint = match request.value("checkpoint").filter(|value| !value.is_null()) {
        Some(value) => Some(checkpoint_input(value)?),
        None => None,
    };
    let saved = write_entry(
        root,
        locks,
        access,
        &request.str("doc_id"),
        Save {
            write: Write {
                meta: &meta,
                body,
                version: version.as_deref(),
                blobs: blobs.as_deref(),
            },
            new_lineage: request.str("lineage") == "new",
            checkpoint,
        },
    )?;
    let mut answer = head_json(&saved.written.head);
    answer["compact"] = Value::Bool(saved.written.compact);
    if let Some(checkpoint) = &saved.checkpoint {
        answer["checkpoint"] = checkpoint_json(checkpoint);
    }
    Ok(answer)
}

/// `{ doc_id, expected_root? }`.
pub fn delete_entry_request(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    delete_entry(root, locks, access, &request.str("doc_id"))?;
    Ok(Value::Null)
}

/// `{ doc_id, expected_root? }` to `{ checkpoints }`, newest first.
pub fn read_history_request(
    root: &Path,
    locks: &GuardedWrites,
    _access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let checkpoints = read_history(root, locks, &request.str("doc_id"))?;
    Ok(json!({ "checkpoints": checkpoints.iter().map(checkpoint_json).collect::<Vec<_>>() }))
}

/// `{ doc_id, origin, version?, author?, label?, expected_root? }` to `{ checkpoint }`.
pub fn record_checkpoint_request(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let input = checkpoint_input(request.value("checkpoint").unwrap_or(&Value::Null))?;
    let checkpoint = record_checkpoint(root, locks, access, &request.str("doc_id"), input)?;
    Ok(json!({ "checkpoint": checkpoint_json(&checkpoint) }))
}

/// `{ doc_id, id, expected_root? }` to `null` or `{ checkpoint, blobs_base64? }`.
pub fn read_checkpoint_request(
    root: &Path,
    locks: &GuardedWrites,
    _access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    Ok(
        match read_checkpoint(root, locks, &request.str("doc_id"), &request.str("id"))? {
            None => Value::Null,
            Some((checkpoint, bundle)) => {
                let mut payload = json!({ "checkpoint": checkpoint_json(&checkpoint) });
                if let Some(bundle) = bundle {
                    payload["blobs_base64"] = Value::String(BASE64.encode(bundle));
                }
                payload
            }
        },
    )
}

/// `{ expected_root? }` to `{ entries, version }`.
pub fn read_index_request(
    root: &Path,
    locks: &GuardedWrites,
    _access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let index = read_index(root, locks)?;
    Ok(json!({ "entries": index.entries, "version": index.version }))
}

/// `{ entries, expected_version, expected_root? }` to `{ version }`.
pub fn write_index_request(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let Some(raw) = request.value("entries").and_then(Value::as_object) else {
        return Err(invalid("document index entries must be an object"));
    };
    let entries = raw
        .iter()
        .map(|(path, doc_id)| match doc_id.as_str() {
            Some(doc_id) => Ok((path.clone(), doc_id.to_owned())),
            None => Err(invalid("document index entries map paths to document ids")),
        })
        .collect::<io::Result<BTreeMap<_, _>>>()?;
    let expected = request.exact_string("expected_version");
    let version = write_index(root, locks, access, &entries, expected.as_deref())?;
    Ok(json!({ "version": version }))
}

#[cfg(test)]
mod tests;
