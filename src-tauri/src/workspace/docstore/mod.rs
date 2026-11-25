//! The private store of the replicas kit editors keep for their files under
//! `.kition/docs/` (Kit UI protocol capability `replica`): each document's last
//! written state and its checkpoints.
//!
//! ```text
//! .kition/docs/
//!   .gitignore                 keeps the store out of the workspace's Git history
//!   index.json                 workspace paths to document ids
//!   store.lock                 the store's one writer (`lock`)
//!   <docId>/                   one document (`entry`, `blobs`, `history`)
//! ```
//!
//! `checkpoints` serves the history to kits (Kit UI protocol section 7m).
//! Where the person was in a document (its view state, section 7n) is not
//! kept here but in the app's own data: see `super::viewstate`.
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
pub mod checkpoints;
pub mod entry;
pub mod history;
pub mod lock;

pub use entry::{Entry, Write, Written};
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

/// Reads `doc_id`'s stored state, or `None` when there is none, it is of
/// another layout, or it is damaged.
pub fn read_entry(root: &Path, locks: &GuardedWrites, doc_id: &str) -> io::Result<Option<Entry>> {
    let dir = entry_dir(root, doc_id)?;
    locks.exclusive(&dir, || entry::read(root, &dir, doc_id))
}

/// A state write and the checkpoint asked with it.
pub struct Save<'a> {
    pub write: Write<'a>,
    pub checkpoint: Option<CheckpointInput>,
}

#[derive(Debug)]
pub struct Saved {
    pub written: Written,
    /// The checkpoint recorded (or the newest one, at the same version);
    /// `None` when none was asked or the state is too large for it.
    pub checkpoint: Option<Checkpoint>,
}

/// Removes the blob and state files that neither the stored state nor a
/// checkpoint names.
pub(super) fn collect(root: &Path, dir: &Path, doc_id: &str) -> io::Result<()> {
    let mut keep = history::blob_records(root, dir)?;
    keep.extend(entry::blob_records(root, dir, doc_id)?);
    blobs::collect_garbage(root, dir, keep.iter())
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
    history::check_version(save.write.version)?;
    if let Some(input) = &save.checkpoint {
        history::check_input(input)?;
    }
    access.check()?;
    locks.exclusive(&dir, || {
        ensure_store(root)?;
        let written = entry::write(root, &dir, doc_id, &save.write)?;
        let checkpoint = match save.checkpoint {
            Some(input) => history::record(
                root,
                &dir,
                input,
                history::State {
                    snapshot: save.write.snapshot,
                    version: &written.version,
                    blobs: written.blobs.clone(),
                },
            )?,
            None => None,
        };
        collect(root, &dir, doc_id)?;
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

fn checkpoint_input(value: &Value) -> io::Result<CheckpointInput> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let Some(origin) = text("origin") else {
        return Err(invalid("a checkpoint needs an origin"));
    };
    Ok(CheckpointInput {
        origin,
        author: text("author"),
        label: text("label"),
        description: text("description"),
        time: value.get("time").and_then(Value::as_u64),
    })
}

/// `{ doc_id, expected_root? }` to `null`, or `{ meta, snapshot_base64,
/// version, blobs_base64? }`.
pub fn read_entry_request(
    root: &Path,
    locks: &GuardedWrites,
    _access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    Ok(match read_entry(root, locks, &request.str("doc_id"))? {
        None => Value::Null,
        Some(entry) => {
            let mut payload = json!({
                "meta": entry.meta,
                "snapshot_base64": BASE64.encode(&entry.snapshot),
                "version": entry.version,
            });
            if let Some(blobs) = entry.blobs {
                payload["blobs_base64"] = Value::String(BASE64.encode(blobs));
            }
            payload
        }
    })
}

/// `{ doc_id, meta, snapshot_base64, version, blobs_base64?, checkpoint?: {
/// origin, author?, label?, description? }, expected_root? }` to `{ version,
/// checkpoint? }`, the checkpoint as a kit sees it (Kit UI protocol
/// `host/replicaWrite`). `version` is the version the snapshot holds, as the
/// writer names it (base64 of the kit's bytes); the store keeps it as it is.
pub fn write_entry_request(
    root: &Path,
    locks: &GuardedWrites,
    access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let meta = request.value("meta").cloned().unwrap_or(Value::Null);
    let Some(snapshot) = decode(request, "snapshot_base64", "snapshot")? else {
        return Err(invalid("a document store write carries a snapshot"));
    };
    let blobs = decode(request, "blobs_base64", "blobs")?;
    let Some(version) = request
        .value("version")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Err(invalid(
            "a document store write names the version its snapshot holds",
        ));
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
                snapshot: &snapshot,
                version: &version,
                blobs: blobs.as_deref(),
            },
            checkpoint,
        },
    )?;
    let mut answer = json!({ "version": saved.written.version });
    if let Some(checkpoint) = &saved.checkpoint {
        answer["checkpoint"] = checkpoints::kit_checkpoint_json(checkpoint);
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

/// `{ doc_id, expected_root? }` to `{ checkpoints }`, newest first, each as a
/// kit sees it.
pub fn read_history_request(
    root: &Path,
    locks: &GuardedWrites,
    _access: Access,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let checkpoints = read_history(root, locks, &request.str("doc_id"))?;
    Ok(
        json!({ "checkpoints": checkpoints.iter().map(checkpoints::kit_checkpoint_json).collect::<Vec<_>>() }),
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
