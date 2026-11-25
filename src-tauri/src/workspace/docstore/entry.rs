//! One document's stored state (format 3):
//!
//! ```text
//! <docId>/meta.json        the manifest: the renderer's meta, the state's hash, its version, its blobs
//! <docId>/state.bin        the last written snapshot, opaque bytes, replaced whole
//! <docId>/blobs/<sha256>   a kit replica's blobs (see `blobs`)
//! <docId>/history.json     the checkpoints (see `history`)
//! <docId>/states/<sha256>  each checkpoint's snapshot, the same bytes once
//! ```
//!
//! A write replaces the state whole: the manifest first names the new state as
//! `pending`, then `state.bin` is renamed into place, then the manifest names
//! it. So a crash at any point leaves a manifest and a state that read as one
//! of the written versions. The store never reads the snapshot's bytes: they
//! are the kit's (Kit UI protocol section 7), and `version` is the opaque
//! version the writer says they hold.
//!
//! A folder whose manifest is not this format (an older layout, a damaged
//! file) reads as no entry, and the next write replaces the folder whole.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::blobs::{self, BlobRecord};
use super::{check_meta, ensure_store, read_confined, sha256_hex};
use crate::workspace::safety::{assert_safe, write_atomically};

pub(super) const META_FILE: &str = "meta.json";
pub(super) const STATE_FILE: &str = "state.bin";
pub(super) const FORMAT: u64 = 3;

/// A file the manifest names: its hash and size.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileRecord {
    pub sha256: String,
    pub size: u64,
}

impl FileRecord {
    pub(super) fn of(bytes: &[u8]) -> Self {
        Self {
            sha256: sha256_hex(bytes),
            size: bytes.len() as u64,
        }
    }

    fn matches(&self, bytes: &[u8]) -> bool {
        self.size == bytes.len() as u64 && self.sha256 == sha256_hex(bytes)
    }
}

/// A stored state: what `state.bin` holds and what goes with it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Stored {
    pub meta: Value,
    pub state: FileRecord,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blobs: Option<BlobRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Manifest {
    pub format: u64,
    #[serde(flatten)]
    pub current: Stored,
    /// A write in flight: the state about to be renamed into place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<Stored>,
}

/// One stored document: the renderer's meta, the snapshot, the version it
/// holds, and a kit replica's blob bundle.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub meta: Value,
    pub snapshot: Vec<u8>,
    pub version: String,
    pub blobs: Option<Vec<u8>>,
}

pub struct Write<'a> {
    pub meta: &'a Value,
    pub snapshot: &'a [u8],
    /// The version `snapshot` holds, as the writer names it.
    pub version: &'a str,
    pub blobs: Option<&'a [u8]>,
}

/// What a write answers: the stored version and the blobs it names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Written {
    pub version: String,
    pub blobs: Option<BlobRecord>,
}

fn parse_manifest(doc_id: &str, bytes: &[u8]) -> Option<Manifest> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    if value.get("format").and_then(Value::as_u64) != Some(FORMAT) {
        return None;
    }
    let manifest: Manifest = serde_json::from_value(value).ok()?;
    check_meta(doc_id, &manifest.current.meta).ok()?;
    Some(manifest)
}

/// The manifest of a format-3 entry, or `None` (no entry, another layout, or
/// a damaged manifest).
pub(super) fn read_manifest(root: &Path, dir: &Path, doc_id: &str) -> io::Result<Option<Manifest>> {
    Ok(read_confined(root, &dir.join(META_FILE))?.and_then(|bytes| parse_manifest(doc_id, &bytes)))
}

fn write_manifest(root: &Path, dir: &Path, manifest: &Manifest) -> io::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(manifest).map_err(io::Error::other)?;
    bytes.push(b'\n');
    let path = dir.join(META_FILE);
    assert_safe(root, &path, true)?;
    write_atomically(&path, &bytes)
}

/// Reads the entry in `dir`, or `None` when there is none, it is of another
/// layout, or its state or blobs are missing or damaged. Callers serialise
/// access to the entry.
pub(super) fn read(root: &Path, dir: &Path, doc_id: &str) -> io::Result<Option<Entry>> {
    let Some(manifest) = read_manifest(root, dir, doc_id)? else {
        return Ok(None);
    };
    let Some(snapshot) = read_confined(root, &dir.join(STATE_FILE))? else {
        return Ok(None);
    };
    // The state the manifest names, or the pending one of a write that
    // stopped after its rename.
    let stored = if manifest.current.state.matches(&snapshot) {
        manifest.current
    } else {
        match manifest.pending {
            Some(pending) if pending.state.matches(&snapshot) => pending,
            _ => return Ok(None),
        }
    };
    let blobs = match &stored.blobs {
        None => None,
        Some(record) => match blobs::load(root, dir, record)? {
            Some(bundle) => Some(bundle),
            None => return Ok(None),
        },
    };
    Ok(Some(Entry {
        meta: stored.meta,
        snapshot,
        version: stored.version,
        blobs,
    }))
}

/// Clears `dir` when it holds something other than a format-3 entry (an
/// older layout, a damaged manifest), so a write replaces it whole.
fn replace_other_layout(root: &Path, dir: &Path, doc_id: &str) -> io::Result<Option<Manifest>> {
    let meta = dir.join(META_FILE);
    let Some(bytes) = read_confined(root, &meta)? else {
        return Ok(None);
    };
    if let Some(manifest) = parse_manifest(doc_id, &bytes) {
        return Ok(Some(manifest));
    }
    assert_safe(root, dir, true)?;
    match fs::remove_dir_all(dir) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(None),
    }
}

/// Writes a state (see `Write`). Callers serialise access to the entry.
pub(super) fn write(
    root: &Path,
    dir: &Path,
    doc_id: &str,
    input: &Write<'_>,
) -> io::Result<Written> {
    check_meta(doc_id, input.meta)?;
    ensure_store(root)?;
    assert_safe(root, dir, true)?;
    let current = replace_other_layout(root, dir, doc_id)?;
    fs::create_dir_all(dir)?;
    let blobs = match input.blobs {
        Some(bundle) => Some(blobs::store(root, dir, bundle)?),
        None => None,
    };
    let next = Stored {
        meta: input.meta.clone(),
        state: FileRecord::of(input.snapshot),
        version: input.version.to_owned(),
        blobs,
    };
    if let Some(mut manifest) = current {
        // Named before the rename, so the state is never one the manifest
        // does not know.
        manifest.pending = Some(next.clone());
        write_manifest(root, dir, &manifest)?;
    }
    let state_path = dir.join(STATE_FILE);
    assert_safe(root, &state_path, true)?;
    write_atomically(&state_path, input.snapshot)?;
    let manifest = Manifest {
        format: FORMAT,
        current: next,
        pending: None,
    };
    write_manifest(root, dir, &manifest)?;
    Ok(Written {
        version: manifest.current.version,
        blobs: manifest.current.blobs,
    })
}

/// The blobs the stored state names, so they survive a collection.
pub(super) fn blob_records(root: &Path, dir: &Path, doc_id: &str) -> io::Result<Vec<BlobRecord>> {
    Ok(read_manifest(root, dir, doc_id)?
        .map(|manifest| {
            [Some(manifest.current), manifest.pending]
                .into_iter()
                .flatten()
                .filter_map(|stored| stored.blobs)
                .collect()
        })
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

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

    fn put(root: &Path, dir: &Path, n: u64, bytes: &[u8], version: &str) -> Written {
        ok(write(
            root,
            dir,
            DOC,
            &Write {
                meta: &meta(n),
                snapshot: bytes,
                version,
                blobs: None,
            },
        ))
    }

    fn names(dir: &Path) -> Vec<String> {
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
    fn replaces_the_state_whole() {
        let (_temp, root, dir) = setup();
        assert_eq!(put(&root, &dir, 1, b"one", "v1").version, "v1");
        put(&root, &dir, 2, b"two", "v2");
        let entry = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(
            (entry.meta, entry.snapshot, entry.version, entry.blobs),
            (meta(2), b"two".to_vec(), "v2".to_owned(), None)
        );
        assert_eq!(names(&dir), vec![META_FILE, STATE_FILE]);
    }

    #[test]
    fn reads_a_write_that_stopped_at_any_step() {
        let (_temp, root, dir) = setup();
        put(&root, &dir, 1, b"one", "v1");
        let before = ok(fs::read(dir.join(META_FILE)));
        // Step 1 done: the manifest names the pending state; the old one is still in place.
        let mut manifest =
            ok(read_manifest(&root, &dir, DOC)).unwrap_or_else(|| panic!("no manifest"));
        manifest.pending = Some(Stored {
            meta: meta(2),
            state: FileRecord::of(b"two"),
            version: "v2".into(),
            blobs: None,
        });
        ok(write_manifest(&root, &dir, &manifest));
        let entry = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(
            (entry.snapshot, entry.version),
            (b"one".to_vec(), "v1".into())
        );
        // Step 2 done: the new state is in place, the manifest not yet rewritten.
        ok(fs::write(dir.join(STATE_FILE), b"two"));
        let entry = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(
            (entry.snapshot, entry.version, entry.meta),
            (b"two".to_vec(), "v2".into(), meta(2))
        );
        // A state the manifest does not know (no pending) reads as no entry.
        ok(fs::write(dir.join(META_FILE), &before));
        assert_eq!(ok(read(&root, &dir, DOC)), None);
        // The next write replaces it.
        put(&root, &dir, 3, b"three", "v3");
        assert!(ok(read(&root, &dir, DOC)).is_some_and(|entry| entry.snapshot == b"three"));
    }

    #[test]
    fn ignores_another_layout_and_replaces_it_on_the_next_write() {
        let (_temp, root, dir) = setup();
        ok(fs::create_dir_all(dir.join("changes")));
        let old = json!({ "format": 2, "meta": meta(1), "snapshot": { "sha256": sha256_hex(b"s"), "size": 1, "seq": 1 } });
        ok(fs::write(dir.join(META_FILE), old.to_string()));
        ok(fs::write(dir.join("snapshot.bin"), b"s"));
        ok(fs::write(dir.join("changes/2.bin"), b"c"));
        ok(fs::write(
            dir.join("history.json"),
            b"{\"format\":1,\"checkpoints\":[{\"id\":\"x\"}]}",
        ));
        assert_eq!(ok(read(&root, &dir, DOC)), None);
        put(&root, &dir, 2, b"new", "v");
        assert_eq!(names(&dir), vec![META_FILE, STATE_FILE]);
        assert!(ok(read(&root, &dir, DOC)).is_some_and(|entry| entry.snapshot == b"new"));
    }

    #[test]
    fn a_missing_blob_reads_as_no_entry() {
        let (_temp, root, dir) = setup();
        let bundle = blobs::bundle(&[b"pixels"]);
        let written = ok(write(
            &root,
            &dir,
            DOC,
            &Write {
                meta: &meta(1),
                snapshot: b"s",
                version: "v",
                blobs: Some(&bundle),
            },
        ));
        assert!(written.blobs.is_some());
        let entry = ok(read(&root, &dir, DOC)).unwrap_or_else(|| panic!("no entry"));
        assert_eq!(entry.blobs, Some(bundle));
        ok(fs::remove_dir_all(dir.join(blobs::BLOBS_DIR)));
        assert_eq!(ok(read(&root, &dir, DOC)), None);
    }

    /// The child of `survives_being_killed_mid_write`: writes `c1;...c<n>;`
    /// for ever, after announcing its first write.
    #[test]
    #[ignore = "run by survives_being_killed_mid_write"]
    fn crash_child() {
        let Ok(base) = std::env::var("KITION_DOCSTORE_CRASH_ROOT") else {
            return;
        };
        let root = PathBuf::from(base);
        let dir = root.join(".kition/docs").join(DOC);
        let mut text = String::new();
        for n in 1u64..u64::MAX {
            text.push_str(&format!("c{n};"));
            put(&root, &dir, n, text.as_bytes(), &n.to_string());
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
            let text = String::from_utf8(entry.snapshot).unwrap_or_default();
            let count = text.matches(';').count() as u64;
            let expected: String = (1..=count).map(|n| format!("c{n};")).collect();
            assert_eq!(text, expected, "round {round}");
            assert!(count >= 1, "round {round}");
            assert_eq!(entry.version, count.to_string(), "round {round}");
            assert_eq!(entry.meta["n"].as_u64(), Some(count), "round {round}");
        }
    }
}
