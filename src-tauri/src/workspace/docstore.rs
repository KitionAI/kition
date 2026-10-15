//! The private store of document replicas under `.kition/docs/`: Markdown
//! documents', and those kit editors keep for their files (Kit UI protocol
//! capability `replica`).
//!
//! `index.json` maps workspace paths to document ids, and each document has a
//! folder with `meta.json` (what the renderer keeps about the replica),
//! `snapshot.bin` (the replica's bytes), and for a kit's replica `blobs.bin`
//! (the blobs it references). The store is local to this machine:
//! its own `.gitignore` keeps it out of the workspace's Git history, and
//! deleting it loses only editing history, never document text.
//!
//! Every file is written atomically (temporary sibling and rename). A meta
//! file records the hashes of the snapshot and blobs it belongs to, so a reader
//! never accepts a meta file and a snapshot from different writes; such a pair, left
//! only by a crash between the two renames, reads as no entry at all. Reads and
//! writes of one document, and of the index, are serialised.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::files::{check_expected_root, ensure_initialized};
use super::guarded::GuardedWrites;
use super::safety::{assert_safe, invalid, join_relative, normalize_relative, write_atomically};
use crate::request::Request;

/// The error a guarded index write fails with when the index changed since
/// the version the renderer expected.
pub const INDEX_CONFLICT: &str = "DOCUMENT_INDEX_CONFLICT";

const STORE_DIR: &str = ".kition/docs";
const INDEX_FILE: &str = "index.json";
const META_FILE: &str = "meta.json";
const SNAPSHOT_FILE: &str = "snapshot.bin";
const BLOBS_FILE: &str = "blobs.bin";
const GITIGNORE_FILE: &str = ".gitignore";
const GITIGNORE: &str = "*\n!.gitignore\n";
const STORE_FORMAT: u64 = 1;
const MAX_DOC_ID_LEN: usize = 128;

/// One stored replica: the renderer's meta object, the snapshot bytes, and
/// the blobs a kit's replica references.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub meta: Value,
    pub snapshot: Vec<u8>,
    pub blobs: Option<Vec<u8>>,
}

/// The hash and size a meta file records for the file it belongs with.
fn file_record(bytes: &[u8]) -> Value {
    json!({ "sha256": sha256_hex(bytes), "size": bytes.len() })
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

pub fn read_entry(root: &Path, locks: &GuardedWrites, doc_id: &str) -> io::Result<Option<Entry>> {
    let dir = entry_dir(root, doc_id)?;
    locks.exclusive(&dir, || {
        let Some(meta_bytes) = read_confined(root, &dir.join(META_FILE))? else {
            return Ok(None);
        };
        let Some(snapshot) = read_confined(root, &dir.join(SNAPSHOT_FILE))? else {
            return Ok(None);
        };
        let Ok(stored) = serde_json::from_slice::<Value>(&meta_bytes) else {
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
                let Some(blobs) = read_confined(root, &dir.join(BLOBS_FILE))? else {
                    return Ok(None);
                };
                if record.get("sha256").and_then(Value::as_str) != Some(sha256_hex(&blobs).as_str())
                {
                    return Ok(None);
                }
                Some(blobs)
            }
        };
        Ok(Some(Entry {
            meta,
            snapshot,
            blobs,
        }))
    })
}

pub fn write_entry(
    root: &Path,
    locks: &GuardedWrites,
    doc_id: &str,
    meta: &Value,
    snapshot: &[u8],
    blobs: Option<&[u8]>,
) -> io::Result<()> {
    let dir = entry_dir(root, doc_id)?;
    check_meta(doc_id, meta)?;
    let mut stored = json!({
        "format": STORE_FORMAT,
        "meta": meta,
        "snapshot": file_record(snapshot),
    });
    if let Some(blobs) = blobs {
        stored["blobs"] = file_record(blobs);
    }
    let mut meta_bytes = serde_json::to_vec_pretty(&stored).map_err(io::Error::other)?;
    meta_bytes.push(b'\n');
    locks.exclusive(&dir, || {
        ensure_store(root)?;
        assert_safe(root, &dir, true)?;
        fs::create_dir_all(&dir)?;
        let snapshot_path = dir.join(SNAPSHOT_FILE);
        let blobs_path = dir.join(BLOBS_FILE);
        let meta_path = dir.join(META_FILE);
        assert_safe(root, &snapshot_path, true)?;
        assert_safe(root, &blobs_path, true)?;
        assert_safe(root, &meta_path, true)?;
        write_atomically(&snapshot_path, snapshot)?;
        if let Some(blobs) = blobs {
            write_atomically(&blobs_path, blobs)?;
        }
        // The meta file goes last: it names the files of this write.
        write_atomically(&meta_path, &meta_bytes)?;
        if blobs.is_none() {
            match fs::remove_file(&blobs_path) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                _ => {}
            }
        }
        Ok(())
    })
}

pub fn delete_entry(root: &Path, locks: &GuardedWrites, doc_id: &str) -> io::Result<()> {
    let dir = entry_dir(root, doc_id)?;
    locks.exclusive(&dir, || {
        assert_safe(root, &dir, true)?;
        match fs::remove_dir_all(&dir) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
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
    entries: &BTreeMap<String, String>,
    expected_version: Option<&str>,
) -> io::Result<String> {
    for (path, doc_id) in entries {
        if !is_index_path(path) {
            return Err(invalid("invalid document path in the document index"));
        }
        validate_doc_id(doc_id)?;
    }
    let mut bytes =
        serde_json::to_vec_pretty(&json!({ "format": STORE_FORMAT, "entries": entries }))
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

/// `{ doc_id, expected_root? }` to `null` or `{ meta, snapshot_base64, blobs_base64? }`.
pub fn read_entry_request(
    root: &Path,
    locks: &GuardedWrites,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    Ok(match read_entry(root, locks, &request.str("doc_id"))? {
        None => Value::Null,
        Some(entry) => {
            let mut payload =
                json!({ "meta": entry.meta, "snapshot_base64": BASE64.encode(entry.snapshot) });
            if let Some(blobs) = entry.blobs {
                payload["blobs_base64"] = Value::String(BASE64.encode(blobs));
            }
            payload
        }
    })
}

/// `{ doc_id, meta, snapshot_base64, blobs_base64?, expected_root? }`.
pub fn write_entry_request(
    root: &Path,
    locks: &GuardedWrites,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    let meta = request.value("meta").cloned().unwrap_or(Value::Null);
    let snapshot = BASE64
        .decode(request.str("snapshot_base64").trim())
        .map_err(|_| invalid("document store snapshot is not base64"))?;
    let blobs = match request
        .value("blobs_base64")
        .filter(|blobs| !blobs.is_null())
    {
        None => None,
        Some(blobs) => Some(
            BASE64
                .decode(blobs.as_str().unwrap_or_default().trim())
                .map_err(|_| invalid("document store blobs are not base64"))?,
        ),
    };
    write_entry(
        root,
        locks,
        &request.str("doc_id"),
        &meta,
        &snapshot,
        blobs.as_deref(),
    )?;
    Ok(Value::Null)
}

/// `{ doc_id, expected_root? }`.
pub fn delete_entry_request(
    root: &Path,
    locks: &GuardedWrites,
    request: &Request,
) -> io::Result<Value> {
    prepare(root, request)?;
    delete_entry(root, locks, &request.str("doc_id"))?;
    Ok(Value::Null)
}

/// `{ expected_root? }` to `{ entries, version }`.
pub fn read_index_request(
    root: &Path,
    locks: &GuardedWrites,
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
    let version = write_index(root, locks, &entries, expected.as_deref())?;
    Ok(json!({ "version": version }))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    const DOC: &str = "0199c2a4-7b3e-7cde-8f00-1234567890ab";

    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap_or_else(|err| panic!("{err}"));
        (dir, root)
    }

    fn meta(doc_id: &str, path: &str) -> Value {
        json!({
            "docId": doc_id,
            "kit": "kit.document",
            "path": path,
            "fileHash": "abc",
            "fileStamp": null,
            "exported": "00",
            "style": { "eol": "\n", "bom": false, "finalNewline": true },
        })
    }

    fn ok<T>(result: io::Result<T>) -> T {
        result.unwrap_or_else(|err| panic!("{err}"))
    }

    fn error_text<T: std::fmt::Debug>(result: io::Result<T>) -> String {
        result.err().map(|err| err.to_string()).unwrap_or_default()
    }

    fn file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn validates_document_ids() {
        for valid in [DOC, "a", "A:b_c-d", &"x".repeat(128)] {
            assert!(validate_doc_id(valid).is_ok(), "{valid}");
        }
        for bad in [
            "",
            "-a",
            ":a",
            "_a",
            "a/b",
            "a\\b",
            "..",
            "a.b",
            "a b",
            &"x".repeat(129),
            "\u{e9}",
        ] {
            assert!(validate_doc_id(bad).is_err(), "{bad}");
        }
        let (_dir, root) = workspace();
        let locks = GuardedWrites::default();
        assert!(read_entry(&root, &locks, "../escape").is_err());
        assert!(write_entry(&root, &locks, "../x", &meta("../x", "a.md"), b"s", None).is_err());
        assert!(delete_entry(&root, &locks, "a/b").is_err());
        assert!(!root.join(".kition").exists());
    }

    #[test]
    fn writes_meta_and_snapshot_together() {
        let (_dir, root) = workspace();
        let locks = GuardedWrites::default();
        assert_eq!(ok(read_entry(&root, &locks, DOC)), None);
        let first = meta(DOC, "notes/a.md");
        ok(write_entry(
            &root,
            &locks,
            DOC,
            &first,
            &[0, 1, 2, 255],
            None,
        ));
        let entry = ok(read_entry(&root, &locks, DOC));
        assert_eq!(
            entry,
            Some(Entry {
                meta: first,
                snapshot: vec![0, 1, 2, 255],
                blobs: None,
            })
        );

        let second = meta(DOC, "notes/b.md");
        ok(write_entry(&root, &locks, DOC, &second, b"second", None));
        let entry = ok(read_entry(&root, &locks, DOC));
        assert_eq!(
            entry.map(|entry| (entry.meta, entry.snapshot)),
            Some((second, b"second".to_vec()))
        );

        let folder = root.join(".kition/docs").join(DOC);
        assert_eq!(file_names(&folder), vec![META_FILE, SNAPSHOT_FILE]);
        assert_eq!(
            file_names(&root.join(".kition/docs")),
            vec![".gitignore".to_owned(), DOC.to_owned()]
        );
        // The document tree never shows the store.
        let tree = ok(super::super::files::read_tree(&root, ""));
        assert!(tree.is_empty(), "{tree:?}");
    }

    #[test]
    fn keeps_a_kit_replica_with_its_blobs() {
        let (_dir, root) = workspace();
        let locks = GuardedWrites::default();
        let kit_meta =
            json!({ "docId": DOC, "kit": "kit.photo", "path": "art/a.psd", "fileStamp": "v1" });
        ok(write_entry(
            &root,
            &locks,
            DOC,
            &kit_meta,
            b"snap",
            Some(b"blobs"),
        ));
        let entry = ok(read_entry(&root, &locks, DOC));
        assert_eq!(
            entry,
            Some(Entry {
                meta: kit_meta.clone(),
                snapshot: b"snap".to_vec(),
                blobs: Some(b"blobs".to_vec()),
            })
        );
        let folder = root.join(".kition/docs").join(DOC);
        assert_eq!(
            file_names(&folder),
            vec![BLOBS_FILE, META_FILE, SNAPSHOT_FILE]
        );

        // Blobs from another write, or none where the meta names some, make no entry.
        ok(fs::write(folder.join(BLOBS_FILE), b"other"));
        assert_eq!(ok(read_entry(&root, &locks, DOC)), None);
        ok(fs::remove_file(folder.join(BLOBS_FILE)));
        assert_eq!(ok(read_entry(&root, &locks, DOC)), None);

        // A write without blobs leaves none behind.
        ok(write_entry(
            &root,
            &locks,
            DOC,
            &kit_meta,
            b"snap",
            Some(b"blobs"),
        ));
        ok(write_entry(
            &root,
            &locks,
            DOC,
            &meta(DOC, "a.md"),
            b"text",
            None,
        ));
        assert_eq!(file_names(&folder), vec![META_FILE, SNAPSHOT_FILE]);
        assert_eq!(
            ok(read_entry(&root, &locks, DOC)).and_then(|entry| entry.blobs),
            None
        );

        let request = |value: Value| Request::new(Some(value));
        ok(write_entry_request(
            &root,
            &locks,
            &request(json!({
                "doc_id": DOC,
                "meta": kit_meta,
                "snapshot_base64": BASE64.encode([1]),
                "blobs_base64": BASE64.encode([2, 3]),
            })),
        ));
        let read = ok(read_entry_request(
            &root,
            &locks,
            &request(json!({ "doc_id": DOC })),
        ));
        assert_eq!(read["blobs_base64"], json!(BASE64.encode([2, 3])));
        assert!(
            write_entry_request(
                &root,
                &locks,
                &request(json!({ "doc_id": DOC, "meta": meta(DOC, "a.md"), "snapshot_base64": "", "blobs_base64": "%%%" })),
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_a_torn_or_foreign_entry() {
        let (_dir, root) = workspace();
        let locks = GuardedWrites::default();
        ok(write_entry(
            &root,
            &locks,
            DOC,
            &meta(DOC, "a.md"),
            b"one",
            None,
        ));
        let folder = root.join(".kition/docs").join(DOC);
        // A crash between the two renames leaves a snapshot the meta does not describe.
        ok(fs::write(folder.join(SNAPSHOT_FILE), b"two"));
        assert_eq!(ok(read_entry(&root, &locks, DOC)), None);
        ok(fs::write(folder.join(META_FILE), b"not json"));
        assert_eq!(ok(read_entry(&root, &locks, DOC)), None);
        ok(fs::remove_file(folder.join(META_FILE)));
        assert_eq!(ok(read_entry(&root, &locks, DOC)), None);

        assert_eq!(
            error_text(write_entry(
                &root,
                &locks,
                DOC,
                &meta("other", "a.md"),
                b"x",
                None
            )),
            "document store meta names another document"
        );
        assert!(write_entry(&root, &locks, DOC, &json!([]), b"x", None).is_err());
    }

    #[test]
    fn stores_ids_with_colons_under_portable_names() {
        let (_dir, root) = workspace();
        let locks = GuardedWrites::default();
        let id = "urn:uuid:1";
        ok(write_entry(
            &root,
            &locks,
            id,
            &meta(id, "a.md"),
            b"s",
            None,
        ));
        assert!(root.join(".kition/docs/urn%3Auuid%3A1/meta.json").is_file());
        assert_eq!(
            ok(read_entry(&root, &locks, id)).map(|entry| entry.snapshot),
            Some(b"s".to_vec())
        );
    }

    #[test]
    fn deletes_an_entry() {
        let (_dir, root) = workspace();
        let locks = GuardedWrites::default();
        ok(delete_entry(&root, &locks, DOC));
        ok(write_entry(
            &root,
            &locks,
            DOC,
            &meta(DOC, "a.md"),
            b"s",
            None,
        ));
        ok(delete_entry(&root, &locks, DOC));
        assert_eq!(ok(read_entry(&root, &locks, DOC)), None);
        assert!(!root.join(".kition/docs").join(DOC).exists());
        ok(delete_entry(&root, &locks, DOC));
    }

    #[test]
    fn creates_the_gitignore_once() {
        let (_dir, root) = workspace();
        let locks = GuardedWrites::default();
        let gitignore = root.join(".kition/docs/.gitignore");
        ok(write_entry(
            &root,
            &locks,
            DOC,
            &meta(DOC, "a.md"),
            b"s",
            None,
        ));
        assert_eq!(ok(fs::read_to_string(&gitignore)), "*\n!.gitignore\n");
        ok(fs::write(&gitignore, "# kept by the user\n"));
        ok(write_index(&root, &locks, &BTreeMap::new(), None));
        assert_eq!(ok(fs::read_to_string(&gitignore)), "# kept by the user\n");
        ok(fs::remove_file(&gitignore));
        ok(write_entry(
            &root,
            &locks,
            DOC,
            &meta(DOC, "a.md"),
            b"t",
            None,
        ));
        assert_eq!(ok(fs::read_to_string(&gitignore)), GITIGNORE);
    }

    #[test]
    fn guards_index_writes_by_version() {
        let (_dir, root) = workspace();
        let locks = GuardedWrites::default();
        assert_eq!(ok(read_index(&root, &locks)), Index::default());

        let mut entries = BTreeMap::new();
        entries.insert("notes/a.md".to_owned(), DOC.to_owned());
        let first = ok(write_index(&root, &locks, &entries, None));
        let index = ok(read_index(&root, &locks));
        assert_eq!(index.entries, entries);
        assert_eq!(index.version.as_deref(), Some(first.as_str()));

        assert_eq!(
            error_text(write_index(&root, &locks, &entries, None)),
            INDEX_CONFLICT
        );
        assert_eq!(
            error_text(write_index(&root, &locks, &entries, Some("stale"))),
            INDEX_CONFLICT
        );

        entries.insert("b.md".to_owned(), "other-doc".to_owned());
        let second = ok(write_index(&root, &locks, &entries, Some(&first)));
        assert_ne!(first, second);
        assert_eq!(
            error_text(write_index(&root, &locks, &entries, Some(&first))),
            INDEX_CONFLICT
        );
        assert_eq!(ok(read_index(&root, &locks)).entries.len(), 2);

        // Another writer changes the file: the version moves with it.
        ok(fs::write(
            root.join(".kition/docs/index.json"),
            b"{\"entries\":{}}",
        ));
        assert_eq!(
            error_text(write_index(&root, &locks, &entries, Some(&second))),
            INDEX_CONFLICT
        );
    }

    #[test]
    fn validates_index_entries() {
        let (_dir, root) = workspace();
        let locks = GuardedWrites::default();
        for (path, doc_id) in [
            ("../a.md", DOC),
            ("/abs.md", DOC),
            ("a//b.md", DOC),
            ("", DOC),
            ("a.md", "bad id"),
        ] {
            let entries = BTreeMap::from([(path.to_owned(), doc_id.to_owned())]);
            assert!(
                write_index(&root, &locks, &entries, None).is_err(),
                "{path} {doc_id}"
            );
        }
        // A damaged index reads as empty and can be replaced under its version.
        ok(fs::create_dir_all(root.join(".kition/docs")));
        ok(fs::write(
            root.join(".kition/docs/index.json"),
            format!("{{\"entries\":{{\"ok.md\":\"{DOC}\",\"../x.md\":\"{DOC}\",\"n.md\":3}}}}"),
        ));
        let index = ok(read_index(&root, &locks));
        assert_eq!(
            index.entries,
            BTreeMap::from([("ok.md".to_owned(), DOC.to_owned())])
        );
        ok(fs::write(root.join(".kition/docs/index.json"), b"garbage"));
        let index = ok(read_index(&root, &locks));
        assert!(index.entries.is_empty());
        assert!(write_index(&root, &locks, &BTreeMap::new(), index.version.as_deref()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn stays_inside_the_workspace() {
        let (dir, root) = workspace();
        let locks = GuardedWrites::default();
        let outside = dir.path().join("outside");
        ok(fs::create_dir_all(&outside));
        // A `.kition` that links out of the workspace is refused.
        ok(std::os::unix::fs::symlink(&outside, root.join(".kition")));
        assert!(write_entry(&root, &locks, DOC, &meta(DOC, "a.md"), b"s", None).is_err());
        assert!(write_index(&root, &locks, &BTreeMap::new(), None).is_err());
        assert!(read_index(&root, &locks).is_err());
        assert!(read_entry(&root, &locks, DOC).is_err());
        assert!(delete_entry(&root, &locks, DOC).is_err());
        assert!(file_names(&outside).is_empty());
        ok(fs::remove_file(root.join(".kition")));

        // So is an entry file that links out.
        ok(write_entry(
            &root,
            &locks,
            DOC,
            &meta(DOC, "a.md"),
            b"s",
            None,
        ));
        let secret = outside.join("secret");
        ok(fs::write(&secret, b"secret"));
        let snapshot = root.join(".kition/docs").join(DOC).join(SNAPSHOT_FILE);
        ok(fs::remove_file(&snapshot));
        ok(std::os::unix::fs::symlink(&secret, &snapshot));
        assert!(read_entry(&root, &locks, DOC).is_err());
        assert!(write_entry(&root, &locks, DOC, &meta(DOC, "a.md"), b"t", None).is_err());
        assert_eq!(ok(fs::read(&secret)), b"secret");
    }

    #[test]
    fn serialises_concurrent_writes_of_one_document() {
        let (_dir, root) = workspace();
        let locks = Arc::new(GuardedWrites::default());
        ok(write_entry(
            &root,
            &locks,
            DOC,
            &meta(DOC, "start.md"),
            b"start.md",
            None,
        ));
        let workers: Vec<_> = (0..4)
            .map(|worker| {
                let (root, locks) = (root.clone(), locks.clone());
                std::thread::spawn(move || {
                    for round in 0..25 {
                        let path = format!("w{worker}-{round}.md");
                        let snapshot = path.repeat(64);
                        ok(write_entry(
                            &root,
                            &locks,
                            DOC,
                            &meta(DOC, &path),
                            snapshot.as_bytes(),
                            None,
                        ));
                        // Interleaved reads never see a meta from one write and a snapshot from another.
                        let entry = ok(read_entry(&root, &locks, DOC))
                            .unwrap_or_else(|| panic!("entry missing during concurrent writes"));
                        let stored_path =
                            entry.meta["path"].as_str().unwrap_or_default().to_owned();
                        assert_eq!(entry.snapshot, stored_path.repeat(64).into_bytes());
                    }
                })
            })
            .collect();
        for worker in workers {
            assert!(worker.join().is_ok());
        }
        let folder = root.join(".kition/docs").join(DOC);
        assert_eq!(file_names(&folder), vec![META_FILE, SNAPSHOT_FILE]);
    }

    #[test]
    fn answers_renderer_requests() {
        let (_dir, root) = workspace();
        let locks = GuardedWrites::default();
        let root_text = root.to_string_lossy().into_owned();
        let request = |value: Value| Request::new(Some(value));

        let written = write_entry_request(
            &root,
            &locks,
            &request(json!({
                "doc_id": DOC,
                "meta": meta(DOC, "a.md"),
                "snapshot_base64": BASE64.encode([1, 2, 3]),
                "expected_root": root_text,
            })),
        );
        assert_eq!(ok(written), Value::Null);
        let read = ok(read_entry_request(
            &root,
            &locks,
            &request(json!({ "doc_id": DOC })),
        ));
        assert_eq!(read["snapshot_base64"], json!(BASE64.encode([1, 2, 3])));
        assert_eq!(read["meta"]["path"], json!("a.md"));
        assert!(
            write_entry_request(
                &root,
                &locks,
                &request(
                    json!({ "doc_id": DOC, "meta": meta(DOC, "a.md"), "snapshot_base64": "%%%" })
                ),
            )
            .is_err()
        );
        assert_eq!(
            error_text(read_entry_request(
                &root,
                &locks,
                &request(json!({ "doc_id": DOC, "expected_root": "/elsewhere" })),
            )),
            super::super::files::WORKSPACE_CHANGED
        );

        let index = ok(read_index_request(&root, &locks, &request(json!({}))));
        assert_eq!(index, json!({ "entries": {}, "version": null }));
        let written = ok(write_index_request(
            &root,
            &locks,
            &request(json!({ "entries": { "a.md": DOC }, "expected_version": null })),
        ));
        let version = written["version"].as_str().unwrap_or_default().to_owned();
        let index = ok(read_index_request(&root, &locks, &request(json!({}))));
        assert_eq!(
            index,
            json!({ "entries": { "a.md": DOC }, "version": version })
        );
        assert_eq!(
            error_text(write_index_request(
                &root,
                &locks,
                &request(json!({ "entries": {}, "expected_version": null })),
            )),
            INDEX_CONFLICT
        );
        assert!(
            write_index_request(
                &root,
                &locks,
                &request(json!({ "entries": { "a.md": 1 }, "expected_version": version })),
            )
            .is_err()
        );

        ok(delete_entry_request(
            &root,
            &locks,
            &request(json!({ "doc_id": DOC })),
        ));
        assert_eq!(
            ok(read_entry_request(
                &root,
                &locks,
                &request(json!({ "doc_id": DOC }))
            )),
            Value::Null
        );
    }
}
