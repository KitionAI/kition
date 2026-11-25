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
            snapshot,
            version: "v",
            blobs,
        },
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
    assert!(read_entry(&root, &locks, "../escape").is_err());
    assert!(put(&root, &locks, "../x", &meta("../x", "a.md"), b"s", None).is_err());
    assert!(delete_entry(&root, &locks, W, "a/b").is_err());
    assert!(!root.join(".kition").exists());
}

#[test]
fn writes_meta_and_snapshot_together() {
    let (_dir, root) = workspace();
    let locks = GuardedWrites::default();
    assert_eq!(ok(read_entry(&root, &locks, DOC)), None);
    let first = meta(DOC, "notes/a.md");
    ok(put(&root, &locks, DOC, &first, &[0, 1, 2, 255], None));
    let entry = ok(read_entry(&root, &locks, DOC));
    assert_eq!(
        plain(entry.clone()),
        Some((first, vec![0, 1, 2, 255], None))
    );
    assert!(entry.is_some_and(|entry| entry.version == "v"));

    let second = meta(DOC, "notes/b.md");
    ok(put(&root, &locks, DOC, &second, b"second", None));
    let entry = ok(read_entry(&root, &locks, DOC));
    assert_eq!(
        entry.map(|entry| (entry.meta, entry.snapshot)),
        Some((second, b"second".to_vec()))
    );

    let folder = root.join(".kition/docs").join(DOC);
    assert_eq!(
        file_names(&folder),
        vec![entry::META_FILE, entry::STATE_FILE]
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
    let entry = ok(read_entry(&root, &locks, DOC));
    assert_eq!(
        plain(entry),
        Some((kit_meta.clone(), b"snap".to_vec(), Some(b"blobs".to_vec())))
    );
    let folder = root.join(".kition/docs").join(DOC);
    assert_eq!(
        file_names(&folder),
        vec![blobs::BLOBS_DIR, entry::META_FILE, entry::STATE_FILE]
    );

    // Damaged or missing blobs make the entry unreadable: a snapshot without its blobs is none.
    let blob = folder.join(blobs::BLOBS_DIR).join(sha256_hex(b"blobs"));
    ok(fs::write(&blob, b"other"));
    assert_eq!(ok(read_entry(&root, &locks, DOC)), None);
    ok(fs::remove_file(&blob));
    assert_eq!(ok(read_entry(&root, &locks, DOC)), None);

    // A write without blobs leaves none behind.
    ok(put(&root, &locks, DOC, &kit_meta, b"snap", Some(b"blobs")));
    ok(put(&root, &locks, DOC, &meta(DOC, "a.md"), b"text", None));
    assert_eq!(
        file_names(&folder),
        vec![entry::META_FILE, entry::STATE_FILE]
    );
    assert_eq!(
        ok(read_entry(&root, &locks, DOC)).and_then(|entry| entry.blobs),
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
            "version": "AQ==",
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
            &request(json!({ "doc_id": DOC, "meta": meta(DOC, "a.md"), "snapshot_base64": "", "version": "", "blobs_base64": "%%%" })),
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
    // A state the meta does not describe.
    ok(fs::write(folder.join(entry::STATE_FILE), b"two"));
    assert_eq!(ok(read_entry(&root, &locks, DOC)), None);
    ok(fs::write(folder.join(entry::META_FILE), b"not json"));
    assert_eq!(ok(read_entry(&root, &locks, DOC)), None);
    ok(fs::remove_file(folder.join(entry::META_FILE)));
    assert_eq!(ok(read_entry(&root, &locks, DOC)), None);

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
        ok(read_entry(&root, &locks, id)).map(|entry| entry.snapshot),
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
    assert_eq!(ok(read_entry(&root, &locks, DOC)), None);
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
    assert!(read_entry(&root, &locks, DOC).is_err());
    assert!(delete_entry(&root, &locks, W, DOC).is_err());
    assert!(file_names(&outside).is_empty());
    ok(fs::remove_file(root.join(".kition")));

    // So is an entry file that links out.
    ok(put(&root, &locks, DOC, &meta(DOC, "a.md"), b"s", None));
    let secret = outside.join("secret");
    ok(fs::write(&secret, b"secret"));
    let snapshot = root.join(".kition/docs").join(DOC).join(entry::STATE_FILE);
    ok(fs::remove_file(&snapshot));
    ok(std::os::unix::fs::symlink(&secret, &snapshot));
    assert!(read_entry(&root, &locks, DOC).is_err());
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
                    let entry = ok(read_entry(&root, &locks, DOC))
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
        vec![entry::META_FILE, entry::STATE_FILE]
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
            "version": "",
            "expected_root": root_text,
        })),
    );
    // The empty version (a replica without changes) is a version like any other.
    assert_eq!(ok(written), json!({ "version": "" }));
    // A write without its version stores nothing.
    assert!(
        write_entry_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "meta": meta(DOC, "b.md"), "snapshot_base64": BASE64.encode([9]) })),
        )
        .is_err()
    );
    let read = ok(read_entry_request(
        &root,
        &locks,
        W,
        &request(json!({ "doc_id": DOC })),
    ));
    assert_eq!(read["snapshot_base64"], json!(BASE64.encode([1, 2, 3])));
    assert_eq!(read["meta"]["path"], json!("a.md"));
    assert_eq!(read["version"], json!(""));
    assert!(
        write_entry_request(
            &root,
            &locks,
            W,
            &request(json!({ "doc_id": DOC, "meta": meta(DOC, "a.md"), "snapshot_base64": "%%%", "version": "" })),
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
fn records_checkpoints_through_requests() {
    let (_dir, root) = workspace();
    let locks = GuardedWrites::default();
    let request = |value: Value| Request::new(Some(value));
    let kit_meta =
        json!({ "docId": DOC, "kit": "kit.photo", "path": "art/a.psd", "fileStamp": "v1" });
    let first = blobs::bundle(&[b"layer"]);
    let write = |state: &[u8], version: &str, blobs: &[u8], checkpoint: Value| {
        write_entry_request(
            &root,
            &locks,
            W,
            &request(json!({
                "doc_id": DOC, "meta": kit_meta, "snapshot_base64": BASE64.encode(state), "version": version,
                "blobs_base64": BASE64.encode(blobs), "checkpoint": checkpoint,
            })),
        )
    };
    let written = ok(write(
        b"one",
        "qg==",
        &first,
        json!({ "origin": "save", "author": "user:local" }),
    ));
    assert_eq!(written["checkpoint"]["version"], json!("qg=="));
    assert_eq!(written["checkpoint"]["origin"], json!("save"));
    let second = blobs::bundle(&[b"layer", b"mask"]);
    ok(write(b"two", "uw==", &second, json!({ "origin": "agent" })));
    // A write without a checkpoint keeps the state and records nothing.
    ok(write(
        b"three",
        "zA==",
        &blobs::bundle(&[b"other"]),
        Value::Null,
    ));

    let read = ok(read_entry_request(
        &root,
        &locks,
        W,
        &request(json!({ "doc_id": DOC })),
    ));
    assert_eq!(read["snapshot_base64"], json!(BASE64.encode(b"three")));
    assert_eq!(read["version"], json!("zA=="));
    assert_eq!(
        read["blobs_base64"],
        json!(BASE64.encode(blobs::bundle(&[b"other"])))
    );

    // The history, newest first; each checkpoint keeps its state and the blobs of its time.
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
    let at = ok(checkpoints::read_request(
        &root,
        &locks,
        W,
        &request(json!({ "doc_id": DOC, "id": oldest })),
    ));
    assert_eq!(at["snapshot_base64"], json!(BASE64.encode(b"one")));
    assert_eq!(at["blobs_base64"], json!(BASE64.encode(&first)));

    // The folder holds the state, its blobs, the history, and one state per checkpoint.
    let folder = root.join(".kition/docs").join(DOC);
    assert_eq!(
        file_names(&folder),
        vec![
            blobs::BLOBS_DIR,
            history::HISTORY_FILE,
            entry::META_FILE,
            entry::STATE_FILE,
            history::STATES_DIR
        ]
    );
    assert_eq!(file_names(&folder.join(history::STATES_DIR)).len(), 2);
    // layer, mask, other: what the state and the checkpoints name.
    assert_eq!(file_names(&folder.join(blobs::BLOBS_DIR)).len(), 3);

    // A checkpoint needs an origin.
    assert!(write(b"four", "3Q==", b"", json!({})).is_err());
}

#[test]
fn replaces_an_entry_of_an_older_layout() {
    let (_dir, root) = workspace();
    let locks = GuardedWrites::default();
    let folder = root.join(".kition/docs").join(DOC);
    ok(fs::create_dir_all(folder.join("changes")));
    let old = json!({
        "format": 2, "meta": meta(DOC, "a.md"),
        "snapshot": { "sha256": sha256_hex(b"snap"), "size": 4, "seq": 1 },
        "changes": [{ "sha256": sha256_hex(b"c"), "size": 1, "seq": 2 }],
        "head": { "seq": 2, "version": "0a" },
    });
    ok(fs::write(folder.join(entry::META_FILE), old.to_string()));
    ok(fs::write(folder.join("snapshot.bin"), b"snap"));
    ok(fs::write(folder.join("changes/2.bin"), b"c"));
    ok(fs::write(
        folder.join(history::HISTORY_FILE),
        b"{\"format\":1,\"checkpoints\":[{\"id\":\"old\",\"time\":1,\"origin\":\"save\",\"version\":\"0a\",\"seq\":1}]}",
    ));
    // It reads as no entry and no history, for a reader as for the writer.
    assert_eq!(ok(read_entry(&root, &locks, DOC)), None);
    assert!(ok(read_history(&root, &locks, DOC)).is_empty());
    // The next write replaces the folder whole.
    ok(put(&root, &locks, DOC, &meta(DOC, "a.md"), b"new", None));
    assert_eq!(
        file_names(&folder),
        vec![entry::META_FILE, entry::STATE_FILE]
    );
    assert_eq!(
        plain(ok(read_entry(&root, &locks, DOC))).map(|(_, snapshot, _)| snapshot),
        Some(b"new".to_vec())
    );
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
            snapshot: b"t",
            version: "v",
            blobs: None,
        },
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
    // Reads still work.
    assert_eq!(
        plain(ok(read_entry(&root, &locks, DOC))).map(|(_, snapshot, _)| snapshot),
        Some(b"s".to_vec())
    );
    let lock = StoreLock::open(&root);
    assert_eq!(Access::of(&lock), Access::Writer);
}
