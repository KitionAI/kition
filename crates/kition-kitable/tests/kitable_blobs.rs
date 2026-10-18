//! Attachments held in the file as content-addressed blobs (`kition_kitable::blobs`): stored,
//! read back, kept through saves and reopens, carried to another copy of the document beside
//! the replica changes that reference them, and absent from files that never stored one.

use std::path::Path;

use kition_kdm::{Origin, Version};
use kition_kitable::blobs::{self, blob_url};
use kition_kitable::{CreateOptions, FieldSpec, KitableFile, SCHEMA_VERSION, TableSpec};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value, json};

fn ok<T, E: std::fmt::Display>(result: Result<T, E>) -> T {
    result.unwrap_or_else(|err| panic!("unexpected error: {err}"))
}

fn values(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// A picture's bytes: a PNG signature and some content.
fn picture(seed: u8) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend((0..512u32).map(|index| (index as u8).wrapping_mul(seed)));
    bytes
}

/// A table "Photos" (Title, Files: attachment) with one record; answers the table id, the record
/// id, and the attachment field's name.
fn photos(file: &mut KitableFile) -> (i64, i64, String) {
    file.set_origin(Origin::person("user:test"));
    let table = ok(file.create_table(&TableSpec {
        title: "Photos".into(),
        fields: vec![
            FieldSpec {
                title: "Title".into(),
                field_type: "text".into(),
                primary: true,
                ..FieldSpec::default()
            },
            FieldSpec {
                title: "Files".into(),
                field_type: "attachment".into(),
                ..FieldSpec::default()
            },
        ],
        ..TableSpec::default()
    }));
    let title = table.fields[0].name.clone();
    let files = table.fields[1].name.clone();
    let record = ok(file.create_record(table.id, &values(json!({ title: "Beach" }))));
    (table.id, record.id, files)
}

fn has_blob_table(path: &Path) -> bool {
    let conn = ok(Connection::open(path));
    ok(conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kition_blobs'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional())
    .is_some()
}

#[test]
fn a_stored_blob_reads_back_and_survives_a_reopen() {
    let dir = ok(tempfile::tempdir());
    let path = dir.path().join("photos.kitable");
    let mut file = ok(KitableFile::create(&path, &CreateOptions::default()));
    let (table_id, record_id, files) = photos(&mut file);
    assert!(
        !has_blob_table(&path),
        "a file without blobs has no blob table"
    );

    let bytes = picture(3);
    let info = ok(file.put_blob(&bytes, "image/png", "beach.png"));
    assert_eq!(info.hash, blobs::blob_hash(&bytes));
    assert_eq!(
        (info.mime.as_str(), info.name.as_str(), info.size),
        ("image/png", "beach.png", bytes.len() as u64)
    );
    // The same bytes again are the same blob, under their first name.
    assert_eq!(
        ok(file.put_blob(&bytes, "image/png", "copy.png")).name,
        "beach.png"
    );
    assert_eq!(ok(file.blob_hashes()), vec![info.hash.clone()]);

    let value = json!([blobs::attachment_value(&info, "beach.png")]);
    let record = ok(file.update_record(
        table_id,
        record_id,
        &values(json!({ files.clone(): value.clone() })),
        None,
    ));
    assert_eq!(record.values[&files], value);
    // Storing a blob is this handle's own write: the handle keeps its undo history.
    assert!(!file.changed_on_disk());
    assert!(file.can_undo());
    file.close();

    let file = ok(KitableFile::open(&path));
    let blob = ok(file.blob(&info.hash)).unwrap_or_else(|| panic!("the blob is kept"));
    assert_eq!(blob.bytes, bytes);
    assert_eq!(blob.info, info);
    assert_eq!(
        ok(file.get_record(table_id, record_id)).values[&files][0]["url"],
        json!(blob_url(&info.hash))
    );
    // Blobs need no schema change: the file stays at the schema older builds open.
    assert_eq!(ok(file.info()).schema_version, SCHEMA_VERSION);
    assert_eq!(SCHEMA_VERSION, 4);
    assert_eq!(ok(file.blob(&blobs::blob_hash(b"other"))), None);
    assert_eq!(ok(file.blob("not a hash")), None);
}

#[test]
fn blobs_round_trip_through_bytes_in_memory() {
    let mut file = ok(KitableFile::create_in_memory(&CreateOptions::default()));
    let (table_id, record_id, files) = photos(&mut file);
    assert!(ok(file.blob_hashes()).is_empty());
    let bytes = picture(5);
    let info = ok(file.put_blob(&bytes, "", "sniffed"));
    assert_eq!(
        info.mime, "image/png",
        "an untyped blob is typed by its signature"
    );
    ok(file.update_record(
        table_id,
        record_id,
        &values(json!({ files: [blobs::attachment_value(&info, "")] })),
        None,
    ));

    let reopened = ok(KitableFile::open_bytes(&ok(file.to_bytes())));
    assert_eq!(
        ok(reopened.blob(&info.hash)).map(|blob| blob.bytes),
        Some(bytes)
    );
    assert_eq!(
        ok(reopened.all_blobs_section()),
        ok(file.all_blobs_section())
    );
}

#[test]
fn bad_blobs_are_refused() {
    let mut file = ok(KitableFile::create_in_memory(&CreateOptions::default()));
    assert!(file.put_blob(&[], "image/png", "empty.png").is_err());
    assert!(
        file.put_blob(&vec![0; blobs::MAX_BLOB_BYTES + 1], "", "huge")
            .is_err()
    );
    // A section whose bytes do not hash to their name stores nothing.
    let section =
        blobs::encode_blob_section([(blobs::blob_hash(b"one").as_str(), b"two".as_slice())]);
    assert!(file.add_blob_section(&section).is_err());
    assert!(ok(file.blob_hashes()).is_empty());
    assert!(file.add_blob_section(&section[..20]).is_err());
}

#[test]
fn a_read_only_file_refuses_blobs_and_reads_none() {
    let dir = ok(tempfile::tempdir());
    let path = dir.path().join("locked.kitable");
    ok(KitableFile::create(&path, &CreateOptions::default())).close();
    let mut permissions = ok(std::fs::metadata(&path)).permissions();
    permissions.set_readonly(true);
    ok(std::fs::set_permissions(&path, permissions.clone()));
    let mut file = ok(KitableFile::open(&path));
    assert!(file.read_only().is_some());
    assert!(file.put_blob(&picture(1), "image/png", "a.png").is_err());
    assert!(ok(file.blob_hashes()).is_empty());
    file.close();
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    ok(std::fs::set_permissions(&path, permissions));
}

#[test]
fn two_copies_sync_a_blob_attachment_beside_its_change() {
    let dir = ok(tempfile::tempdir());
    let mut here = ok(KitableFile::create(
        &dir.path().join("here.kitable"),
        &CreateOptions::default(),
    ));
    let (table_id, record_id, files) = photos(&mut here);
    let mut there = ok(KitableFile::create_from_replica(
        &dir.path().join("there.kitable"),
        &ok(here.export_replica_changes(&Version::empty())),
    ));
    there.set_origin(Origin::person("user:other"));
    let since = there.replica_version();

    // Here, a picture is attached: the blob is stored and the cell names it.
    let bytes = picture(7);
    let info = ok(here.put_blob(&bytes, "image/png", "sunset.png"));
    ok(here.update_record(
        table_id,
        record_id,
        &values(json!({ files.clone(): [blobs::attachment_value(&info, "sunset.png")] })),
        None,
    ));

    // The change names the blob's hash as text (what a relay looks for), and the blob section
    // beside it carries the bytes.
    let changes = ok(here.export_replica_changes(&since));
    assert!(blobs::blob_hash_candidates(&changes).contains(&info.hash));
    let section = ok(here.blobs_for_changes(&changes));
    assert_eq!(
        blobs::decode_blob_section(&section).ok(),
        Some(vec![(info.hash.clone(), bytes.clone())])
    );
    // Changes that name no blob need none.
    assert!(
        ok(here.blobs_for_changes(&ok(here.export_replica_changes(&here.replica_version()))))
            .is_empty()
    );

    // There, the blobs are added and the changes imported: the attachment shows.
    assert_eq!(ok(there.add_blob_section(&section)), 1);
    assert_eq!(
        ok(there.add_blob_section(&section)),
        0,
        "known blobs are not stored twice"
    );
    ok(there.import_replica_changes(&changes));
    let record = ok(there.get_record(table_id, record_id));
    assert_eq!(record.values[&files][0]["url"], json!(blob_url(&info.hash)));
    let blob = ok(there.blob(&info.hash)).unwrap_or_else(|| panic!("the copy holds the blob"));
    assert_eq!(blob.bytes, bytes);
    assert_eq!(blob.info.mime, "image/png");
}

#[test]
fn path_attachments_are_left_as_they_are() {
    let mut file = ok(KitableFile::create_in_memory(&CreateOptions::default()));
    let (table_id, record_id, files) = photos(&mut file);
    let old = json!([{ "url": "/workspace-files/.kition/assets/sha256/ab/abc.png", "name": "old.png", "mimeType": "image/png" }]);
    let record = ok(file.update_record(
        table_id,
        record_id,
        &values(json!({ files.clone(): old.clone() })),
        None,
    ));
    assert_eq!(record.values[&files], old);
    assert!(ok(file.blob_hashes()).is_empty());
}
