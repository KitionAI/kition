use std::sync::Arc;

use super::*;
use entry::STORE_CONFLICT;

const DOC: &str = "0199c2a4-7b3e-7cde-8f00-1234567890ab";

fn workspace() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap_or_else(|err| panic!("{err}"));
    (dir, root)
}

fn meta(doc_id: &str, path: &str) -> Value {
    json!({ "docId": doc_id, "kit": "kit.note", "path": path, "fileStamp": "v1" })
}

const W: Access = Access::Writer;

/// Writes a whole replica, as the store's writer.
fn put(
    root: &Path,
    locks: &GuardedWrites,
    doc_id: &str,
    meta: &Value,
    snapshot: &[u8],
    blobs: Option<&[u8]>,
) -> io::Result<()> {
    let save = Save {
        write: Write {
            meta,
            body: Body::Snapshot(snapshot),
            version: None,
            blobs,
        },
        new_lineage: false,
        checkpoint: None,
    };
    write_entry(root, locks, W, doc_id, save).map(|_| ())
}

/// An entry's meta, snapshot, and blobs.
fn plain(entry: Option<Entry>) -> Option<(Value, Vec<u8>, Option<Vec<u8>>)> {
    entry.map(|entry| (entry.meta, entry.snapshot, entry.blobs))
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
    assert!(read_entry(&root, &locks, W, "../escape").is_err());
    assert!(put(&root, &locks, "../x", &meta("../x", "a.md"), b"s", None).is_err());
    assert!(delete_entry(&root, &locks, W, "a/b").is_err());
    assert!(!root.join(".kition").exists());
}

#[test]
fn writes_meta_and_snapshot_together() {
    let (_dir, root) = workspace();
    let locks = GuardedWrites::default();
    assert_eq!(ok(read_entry(&root, &locks, W, DOC)), None);
    let first = meta(DOC, "notes/a.md");
    ok(put(&root, &locks, DOC, &first, &[0, 1, 2, 255], None));
    let entry = ok(read_entry(&root, &locks, W, DOC));
    assert_eq!(
        plain(entry.clone()),
        Some((first, vec![0, 1, 2, 255], None))
    );
    assert!(
        entry
            .is_some_and(|entry| entry.complete && entry.changes.is_empty() && entry.head.seq == 1)
    );

    let second = meta(DOC, "notes/b.md");
    ok(put(&root, &locks, DOC, &second, b"second", None));
    let entry = ok(read_entry(&root, &locks, W, DOC));
    assert_eq!(
        entry.map(|entry| (entry.meta, entry.snapshot)),
        Some((second, b"second".to_vec()))
    );

    let folder = root.join(".kition/docs").join(DOC);
    assert_eq!(
        file_names(&folder),
        vec![entry::META_FILE, entry::SNAPSHOT_FILE]
    );
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
    ok(put(&root, &locks, DOC, &kit_meta, b"snap", Some(b"blobs")));
    let entry = ok(read_entry(&root, &locks, W, DOC));
    assert_eq!(
        plain(entry),
        Some((kit_meta.clone(), b"snap".to_vec(), Some(b"blobs".to_vec())))
    );
    let folder = root.join(".kition/docs").join(DOC);
    assert_eq!(
        file_names(&folder),
        vec![blobs::BLOBS_DIR, entry::META_FILE, entry::SNAPSHOT_FILE]
    );

    // Damaged or missing blobs make an incomplete entry, without blobs.
    let blob = folder.join(blobs::BLOBS_DIR).join(sha256_hex(b"blobs"));
    ok(fs::write(&blob, b"other"));
    let damaged = ok(read_entry(&root, &locks, W, DOC));
    assert!(damaged.is_some_and(|entry| !entry.complete && entry.blobs.is_none()));
    ok(fs::remove_file(&blob));
    let missing = ok(read_entry(&root, &locks, W, DOC));
    assert!(missing.is_some_and(|entry| !entry.complete && entry.blobs.is_none()));

    // A write without blobs leaves none behind.
    ok(put(&root, &locks, DOC, &kit_meta, b"snap", Some(b"blobs")));
    ok(put(&root, &locks, DOC, &meta(DOC, "a.md"), b"text", None));
    assert_eq!(
        file_names(&folder),
        vec![entry::META_FILE, entry::SNAPSHOT_FILE]
    );
    assert_eq!(
        ok(read_entry(&root, &locks, W, DOC)).and_then(|entry| entry.blobs),
        None
    );

    let request = |value: Value| Request::new(Some(value));
    ok(write_entry_request(
        &root,
        &locks,
        W,
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
        W,
        &request(json!({ "doc_id": DOC })),
    ));
    assert_eq!(read["blobs_base64"], json!(BASE64.encode([2, 3])));
    assert!(
        write_entry_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "meta": meta(DOC, "a.md"), "snapshot_base64": "", "blobs_base64": "%%%" })),
        )
        .is_err()
    );
}

#[test]
fn rejects_a_torn_or_foreign_entry() {
    let (_dir, root) = workspace();
    let locks = GuardedWrites::default();
    ok(put(&root, &locks, DOC, &meta(DOC, "a.md"), b"one", None));
    let folder = root.join(".kition/docs").join(DOC);
    // A crash between the two renames leaves a snapshot the meta does not describe.
    ok(fs::write(folder.join(entry::SNAPSHOT_FILE), b"two"));
    assert_eq!(ok(read_entry(&root, &locks, W, DOC)), None);
    ok(fs::write(folder.join(entry::META_FILE), b"not json"));
    assert_eq!(ok(read_entry(&root, &locks, W, DOC)), None);
    ok(fs::remove_file(folder.join(entry::META_FILE)));
    assert_eq!(ok(read_entry(&root, &locks, W, DOC)), None);

    assert_eq!(
        error_text(put(&root, &locks, DOC, &meta("other", "a.md"), b"x", None)),
        "document store meta names another document"
    );
    assert!(put(&root, &locks, DOC, &json!([]), b"x", None).is_err());
}

#[test]
fn stores_ids_with_colons_under_portable_names() {
    let (_dir, root) = workspace();
    let locks = GuardedWrites::default();
    let id = "urn:uuid:1";
    ok(put(&root, &locks, id, &meta(id, "a.md"), b"s", None));
    assert!(root.join(".kition/docs/urn%3Auuid%3A1/meta.json").is_file());
    assert_eq!(
        ok(read_entry(&root, &locks, W, id)).map(|entry| entry.snapshot),
        Some(b"s".to_vec())
    );
}

#[test]
fn deletes_an_entry() {
    let (_dir, root) = workspace();
    let locks = GuardedWrites::default();
    ok(delete_entry(&root, &locks, W, DOC));
    ok(put(&root, &locks, DOC, &meta(DOC, "a.md"), b"s", None));
    ok(delete_entry(&root, &locks, W, DOC));
    assert_eq!(ok(read_entry(&root, &locks, W, DOC)), None);
    assert!(!root.join(".kition/docs").join(DOC).exists());
    ok(delete_entry(&root, &locks, W, DOC));
}

#[test]
fn creates_the_gitignore_once() {
    let (_dir, root) = workspace();
    let locks = GuardedWrites::default();
    let gitignore = root.join(".kition/docs/.gitignore");
    ok(put(&root, &locks, DOC, &meta(DOC, "a.md"), b"s", None));
    assert_eq!(ok(fs::read_to_string(&gitignore)), "*\n!.gitignore\n");
    ok(fs::write(&gitignore, "# kept by the user\n"));
    ok(write_index(&root, &locks, W, &BTreeMap::new(), None));
    assert_eq!(ok(fs::read_to_string(&gitignore)), "# kept by the user\n");
    ok(fs::remove_file(&gitignore));
    ok(put(&root, &locks, DOC, &meta(DOC, "a.md"), b"t", None));
    assert_eq!(ok(fs::read_to_string(&gitignore)), GITIGNORE);
}

#[test]
fn guards_index_writes_by_version() {
    let (_dir, root) = workspace();
    let locks = GuardedWrites::default();
    assert_eq!(ok(read_index(&root, &locks)), Index::default());

    let mut entries = BTreeMap::new();
    entries.insert("notes/a.md".to_owned(), DOC.to_owned());
    let first = ok(write_index(&root, &locks, W, &entries, None));
    let index = ok(read_index(&root, &locks));
    assert_eq!(index.entries, entries);
    assert_eq!(index.version.as_deref(), Some(first.as_str()));

    assert_eq!(
        error_text(write_index(&root, &locks, W, &entries, None)),
        INDEX_CONFLICT
    );
    assert_eq!(
        error_text(write_index(&root, &locks, W, &entries, Some("stale"))),
        INDEX_CONFLICT
    );

    entries.insert("b.md".to_owned(), "other-doc".to_owned());
    let second = ok(write_index(&root, &locks, W, &entries, Some(&first)));
    assert_ne!(first, second);
    assert_eq!(
        error_text(write_index(&root, &locks, W, &entries, Some(&first))),
        INDEX_CONFLICT
    );
    assert_eq!(ok(read_index(&root, &locks)).entries.len(), 2);

    // Another writer changes the file: the version moves with it.
    ok(fs::write(
        root.join(".kition/docs/index.json"),
        b"{\"entries\":{}}",
    ));
    assert_eq!(
        error_text(write_index(&root, &locks, W, &entries, Some(&second))),
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
            write_index(&root, &locks, W, &entries, None).is_err(),
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
    assert!(write_index(&root, &locks, W, &BTreeMap::new(), index.version.as_deref()).is_ok());
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
    assert!(put(&root, &locks, DOC, &meta(DOC, "a.md"), b"s", None).is_err());
    assert!(write_index(&root, &locks, W, &BTreeMap::new(), None).is_err());
    assert!(read_index(&root, &locks).is_err());
    assert!(read_entry(&root, &locks, W, DOC).is_err());
    assert!(delete_entry(&root, &locks, W, DOC).is_err());
    assert!(file_names(&outside).is_empty());
    ok(fs::remove_file(root.join(".kition")));

    // So is an entry file that links out.
    ok(put(&root, &locks, DOC, &meta(DOC, "a.md"), b"s", None));
    let secret = outside.join("secret");
    ok(fs::write(&secret, b"secret"));
    let snapshot = root
        .join(".kition/docs")
        .join(DOC)
        .join(entry::SNAPSHOT_FILE);
    ok(fs::remove_file(&snapshot));
    ok(std::os::unix::fs::symlink(&secret, &snapshot));
    assert!(read_entry(&root, &locks, W, DOC).is_err());
    assert!(put(&root, &locks, DOC, &meta(DOC, "a.md"), b"t", None).is_err());
    assert_eq!(ok(fs::read(&secret)), b"secret");
}

#[test]
fn serialises_concurrent_writes_of_one_document() {
    let (_dir, root) = workspace();
    let locks = Arc::new(GuardedWrites::default());
    ok(put(
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
                    ok(put(
                        &root,
                        &locks,
                        DOC,
                        &meta(DOC, &path),
                        snapshot.as_bytes(),
                        None,
                    ));
                    // Interleaved reads never see a meta from one write and a snapshot from another.
                    let entry = ok(read_entry(&root, &locks, W, DOC))
                        .unwrap_or_else(|| panic!("entry missing during concurrent writes"));
                    let stored_path = entry.meta["path"].as_str().unwrap_or_default().to_owned();
                    assert_eq!(entry.snapshot, stored_path.repeat(64).into_bytes());
                }
            })
        })
        .collect();
    for worker in workers {
        assert!(worker.join().is_ok());
    }
    let folder = root.join(".kition/docs").join(DOC);
    assert_eq!(
        file_names(&folder),
        vec![entry::META_FILE, entry::SNAPSHOT_FILE]
    );
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
        W,
        &request(json!({
            "doc_id": DOC,
            "meta": meta(DOC, "a.md"),
            "snapshot_base64": BASE64.encode([1, 2, 3]),
            "expected_root": root_text,
        })),
    );
    assert_eq!(
        ok(written),
        json!({ "seq": 1, "version": null, "compact": false })
    );
    let read = ok(read_entry_request(
        &root,
        &locks,
        W,
        &request(json!({ "doc_id": DOC })),
    ));
    assert_eq!(read["snapshot_base64"], json!(BASE64.encode([1, 2, 3])));
    assert_eq!(read["meta"]["path"], json!("a.md"));
    assert!(
        write_entry_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "meta": meta(DOC, "a.md"), "snapshot_base64": "%%%" })),
        )
        .is_err()
    );
    assert_eq!(
        error_text(read_entry_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "expected_root": "/elsewhere" })),
        )),
        super::super::files::WORKSPACE_CHANGED
    );

    let index = ok(read_index_request(&root, &locks, W, &request(json!({}))));
    assert_eq!(index, json!({ "entries": {}, "version": null }));
    let written = ok(write_index_request(
        &root,
        &locks,
        W,
        &request(json!({ "entries": { "a.md": DOC }, "expected_version": null })),
    ));
    let version = written["version"].as_str().unwrap_or_default().to_owned();
    let index = ok(read_index_request(&root, &locks, W, &request(json!({}))));
    assert_eq!(
        index,
        json!({ "entries": { "a.md": DOC }, "version": version })
    );
    assert_eq!(
        error_text(write_index_request(
            &root,
            &locks,
            W,
            &request(json!({ "entries": {}, "expected_version": null })),
        )),
        INDEX_CONFLICT
    );
    assert!(
        write_index_request(
            &root,
            &locks,
            W,
            &request(json!({ "entries": { "a.md": 1 }, "expected_version": version })),
        )
        .is_err()
    );

    ok(delete_entry_request(
        &root,
        &locks,
        W,
        &request(json!({ "doc_id": DOC })),
    ));
    assert_eq!(
        ok(read_entry_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC }))
        )),
        Value::Null
    );
}

#[test]
fn appends_changes_and_records_checkpoints_through_requests() {
    let (_dir, root) = workspace();
    let locks = GuardedWrites::default();
    let request = |value: Value| Request::new(Some(value));
    let kit_meta =
        json!({ "docId": DOC, "kit": "kit.photo", "path": "art/a.psd", "fileStamp": "v1" });
    let first = blobs::bundle(&[b"layer"]);
    let written = ok(write_entry_request(
        &root,
        &locks,
        W,
        &request(json!({
            "doc_id": DOC, "meta": kit_meta, "snapshot_base64": BASE64.encode(b"s;"), "version": "aa",
            "blobs_base64": BASE64.encode(&first), "checkpoint": { "origin": "save", "author": "user:local" },
        })),
    ));
    assert_eq!(written["seq"], json!(1));
    assert_eq!(written["checkpoint"]["version"], json!("aa"));
    assert_eq!(written["checkpoint"]["hasBlobs"], json!(true));

    // An append names the seq it follows; a stale one conflicts.
    let second = blobs::bundle(&[b"layer", b"mask"]);
    let append = |base: u64, version: &str, blobs: &[u8]| {
        write_entry_request(
            &root,
            &locks,
            W,
            &request(json!({
                "doc_id": DOC, "meta": kit_meta, "changes_base64": BASE64.encode(b"a;"), "base_seq": base, "version": version,
                "blobs_base64": BASE64.encode(blobs), "checkpoint": { "origin": "agent" },
            })),
        )
    };
    assert_eq!(error_text(append(0, "bb", &second)), STORE_CONFLICT);
    assert_eq!(ok(append(1, "bb", &second))["seq"], json!(2));
    assert!(
        write_entry_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "meta": kit_meta, "changes_base64": "YQ==" }))
        )
        .is_err()
    );
    assert!(
        write_entry_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "meta": kit_meta }))
        )
        .is_err()
    );

    let read = ok(read_entry_request(
        &root,
        &locks,
        W,
        &request(json!({ "doc_id": DOC })),
    ));
    assert_eq!(read["snapshot_base64"], json!(BASE64.encode(b"s;")));
    assert_eq!(read["changes_base64"], json!([BASE64.encode(b"a;")]));
    assert_eq!(
        (
            read["seq"].clone(),
            read["version"].clone(),
            read["complete"].clone()
        ),
        (json!(2), json!("bb"), json!(true))
    );
    assert_eq!(read["blobs_base64"], json!(BASE64.encode(&second)));
    let head = ok(read_entry_request(
        &root,
        &locks,
        W,
        &request(json!({ "doc_id": DOC, "head_only": true })),
    ));
    assert_eq!(head, json!({ "meta": kit_meta, "seq": 2, "version": "bb" }));

    // The history, newest first; each checkpoint keeps the blobs of its time.
    let history = ok(read_history_request(
        &root,
        &locks,
        W,
        &request(json!({ "doc_id": DOC })),
    ));
    let checkpoints = history["checkpoints"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        checkpoints
            .iter()
            .map(|c| c["origin"].clone())
            .collect::<Vec<_>>(),
        vec![json!("agent"), json!("save")]
    );
    let oldest = checkpoints[1]["id"].as_str().unwrap_or_default().to_owned();
    // A compaction drops blobs nothing names, never those of a checkpoint.
    ok(write_entry_request(
        &root,
        &locks,
        W,
        &request(json!({
            "doc_id": DOC, "meta": kit_meta, "snapshot_base64": BASE64.encode(b"s;a;"), "version": "bb",
            "blobs_base64": BASE64.encode(blobs::bundle(&[b"other"])),
        })),
    ));
    let at = ok(read_checkpoint_request(
        &root,
        &locks,
        W,
        &request(json!({ "doc_id": DOC, "id": oldest })),
    ));
    assert_eq!(at["blobs_base64"], json!(BASE64.encode(&first)));
    assert_eq!(
        ok(read_checkpoint_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "id": "none" }))
        )),
        Value::Null
    );

    // A checkpoint on its own: at the stored version.
    let recorded = ok(record_checkpoint_request(
        &root,
        &locks,
        W,
        &request(
            json!({ "doc_id": DOC, "checkpoint": { "origin": "restore", "label": "Restored" } }),
        ),
    ));
    assert_eq!(recorded["checkpoint"]["version"], json!("bb"));
    assert!(
        record_checkpoint_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "checkpoint": {} }))
        )
        .is_err()
    );

    // A replica of a new lineage starts its history over.
    ok(write_entry_request(
        &root,
        &locks,
        W,
        &request(json!({
            "doc_id": DOC, "meta": kit_meta, "snapshot_base64": BASE64.encode(b"n;"), "lineage": "new",
        })),
    ));
    assert_eq!(ok(read_history(&root, &locks, DOC)), Vec::new());

    // A board keeps only history: its file holds the replica.
    let board = "board-1";
    let recorded = ok(record_checkpoint(
        &root,
        &locks,
        W,
        board,
        CheckpointInput {
            origin: "edit".into(),
            version: Some("cc".into()),
            ..CheckpointInput::default()
        },
    ));
    assert_eq!(
        (recorded.seq, recorded.version.as_deref()),
        (None, Some("cc"))
    );
    assert_eq!(ok(read_entry(&root, &locks, W, board)), None);
}

#[test]
fn refuses_every_write_without_the_store_lock() {
    let (_dir, root) = workspace();
    let locks = GuardedWrites::default();
    ok(put(&root, &locks, DOC, &meta(DOC, "a.md"), b"s", None));
    let read_only = Access::ReadOnly;
    let save = Save {
        write: Write {
            meta: &meta(DOC, "a.md"),
            body: Body::Snapshot(b"t"),
            version: None,
            blobs: None,
        },
        new_lineage: false,
        checkpoint: None,
    };
    assert_eq!(
        error_text(write_entry(&root, &locks, read_only, DOC, save)),
        STORE_READ_ONLY
    );
    assert_eq!(
        error_text(delete_entry(&root, &locks, read_only, DOC)),
        STORE_READ_ONLY
    );
    assert_eq!(
        error_text(write_index(
            &root,
            &locks,
            read_only,
            &BTreeMap::new(),
            None
        )),
        STORE_READ_ONLY
    );
    assert_eq!(
        error_text(record_checkpoint(
            &root,
            &locks,
            read_only,
            DOC,
            CheckpointInput {
                origin: "save".into(),
                ..CheckpointInput::default()
            }
        )),
        STORE_READ_ONLY
    );
    // Reads still work.
    assert_eq!(
        plain(ok(read_entry(&root, &locks, read_only, DOC))).map(|(_, snapshot, _)| snapshot),
        Some(b"s".to_vec())
    );
    let lock = StoreLock::open(&root);
    assert_eq!(Access::of(&lock), Access::Writer);
}

#[test]
fn migrates_a_format_1_entry_only_as_the_writer() {
    let (_dir, root) = workspace();
    let locks = GuardedWrites::default();
    let folder = root.join(".kition/docs").join(DOC);
    ok(fs::create_dir_all(&folder));
    let bundle = blobs::bundle(&[b"one"]);
    let kit_meta = json!({ "docId": DOC, "kit": "kit.photo", "path": "a.psd", "fileStamp": "v1" });
    let old = json!({
        "format": 1, "meta": kit_meta,
        "snapshot": { "sha256": sha256_hex(b"snap"), "size": 4 },
        "blobs": { "sha256": sha256_hex(&bundle), "size": bundle.len() },
    });
    ok(fs::write(
        folder.join(entry::META_FILE),
        ok(serde_json::to_vec(&old).map_err(io::Error::other)),
    ));
    ok(fs::write(folder.join(entry::SNAPSHOT_FILE), b"snap"));
    ok(fs::write(folder.join(entry::LEGACY_BLOBS_FILE), &bundle));
    let expected = Some((kit_meta, b"snap".to_vec(), Some(bundle)));
    // A read-only Kition reads the old layout and leaves it.
    assert_eq!(
        plain(ok(read_entry(&root, &locks, Access::ReadOnly, DOC))),
        expected
    );
    assert!(folder.join(entry::LEGACY_BLOBS_FILE).is_file());
    // The writer migrates it as it reads it.
    assert_eq!(plain(ok(read_entry(&root, &locks, W, DOC))), expected);
    assert!(!folder.join(entry::LEGACY_BLOBS_FILE).exists());
    assert_eq!(
        file_names(&folder),
        vec![blobs::BLOBS_DIR, entry::META_FILE, entry::SNAPSHOT_FILE]
    );
    assert_eq!(
        plain(ok(read_entry(&root, &locks, Access::ReadOnly, DOC))),
        expected
    );
}
