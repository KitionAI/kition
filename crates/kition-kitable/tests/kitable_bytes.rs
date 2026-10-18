//! Documents held in memory: `open_bytes` reads the bytes `KitableFile` writes to disk,
//! `create_in_memory` makes a new one, and `to_bytes` answers bytes `KitableFile::open` reads
//! back natively, edits included.

use std::fs;
use std::path::Path;

use kition_kdm::Origin;
use kition_kitable::{CreateOptions, FieldSpec, KitableFile, TableSpec};
use rusqlite::Connection;
use serde_json::{Map, Value, json};

fn ok<T, E: std::fmt::Display>(result: Result<T, E>) -> T {
    result.unwrap_or_else(|err| panic!("unexpected error: {err}"))
}

fn temp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap_or_else(|err| panic!("tempdir: {err}"))
}

fn values(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// A table "Tasks" (Title, Status) with `rows` records; answers the table id and the two
/// fields' names.
fn tasks(file: &mut KitableFile, rows: usize) -> (i64, String, String) {
    let field = |title: &str, primary: bool| FieldSpec {
        title: title.into(),
        field_type: "text".into(),
        primary,
        ..FieldSpec::default()
    };
    let table = ok(file.create_table(&TableSpec {
        title: "Tasks".into(),
        fields: vec![field("Title", true), field("Status", false)],
        ..TableSpec::default()
    }));
    let title = table.fields[0].name.clone();
    let status = table.fields[1].name.clone();
    let batch: Vec<Map<String, Value>> = (0..rows)
        .map(|index| values(json!({ &title: format!("Task {index}"), &status: "open" })))
        .collect();
    ok(file.create_records(table.id, &batch));
    (table.id, title, status)
}

/// Every record's values of the table, in order.
fn rows(file: &KitableFile, table_id: i64) -> Vec<Map<String, Value>> {
    ok(file.list_records(table_id))
        .into_iter()
        .map(|record| record.values)
        .collect()
}

fn write(path: &Path, bytes: &[u8]) {
    ok(fs::write(path, bytes));
}

#[test]
fn bytes_written_on_disk_open_in_memory_and_edits_reopen_natively() {
    let dir = temp();
    let path = dir.path().join("Tasks.kitable");
    let mut file = ok(KitableFile::create(&path, &CreateOptions::default()));
    let (table_id, title, status) = tasks(&mut file, 50);
    let doc_id = file.replica().doc_id();
    let before = rows(&file, table_id);
    file.close();
    let on_disk = ok(fs::read(&path));

    let mut memory = ok(KitableFile::open_bytes(&on_disk));
    memory.set_origin(Origin::person("user:test"));
    assert_eq!(memory.path(), Path::new(""));
    assert_eq!(memory.read_only(), None);
    assert_eq!(memory.replica().doc_id(), doc_id);
    assert_eq!(rows(&memory, table_id), before);
    assert!(!memory.changed_on_disk());

    // Edit in memory: a new record, a changed one, and an undone change.
    ok(memory.create_record(
        table_id,
        &values(json!({ &title: "Added", &status: "new" })),
    ));
    let first = ok(memory.list_records(table_id)).remove(0);
    ok(memory.update_record(
        table_id,
        first.id,
        &values(json!({ &status: "done" })),
        None,
    ));
    ok(memory.create_record(table_id, &values(json!({ &title: "Undone" }))));
    let (undone, _) = ok(memory.undo());
    assert!(undone);
    let edited = rows(&memory, table_id);
    assert_eq!(edited.len(), 51);
    assert_eq!(edited[0].get(&status), Some(&json!("done")));
    assert!(
        edited
            .iter()
            .any(|row| row.get(&title) == Some(&json!("Added")))
    );
    assert!(
        !edited
            .iter()
            .any(|row| row.get(&title) == Some(&json!("Undone")))
    );

    // The file on disk is untouched; the saved bytes open natively with the edits, writable.
    assert_eq!(ok(fs::read(&path)), on_disk);
    let saved = dir.path().join("Saved.kitable");
    write(&saved, &ok(memory.to_bytes()));
    let mut native = ok(KitableFile::open(&saved));
    assert_eq!(native.read_only(), None);
    assert_eq!(native.replica().doc_id(), doc_id);
    assert_eq!(rows(&native, table_id), edited);
    ok(native.create_record(table_id, &values(json!({ &title: "Native" }))));
    assert_eq!(ok(native.count_records(table_id)), 52);
    native.close();

    // And back into memory once more.
    let again = ok(KitableFile::open_bytes(&ok(fs::read(&saved))));
    assert_eq!(ok(again.count_records(table_id)), 52);
}

#[test]
fn a_document_created_in_memory_saves_as_a_kitable_file() {
    let dir = temp();
    let mut memory = ok(KitableFile::create_in_memory(&CreateOptions {
        title: "Plan".into(),
        ..CreateOptions::default()
    }));
    assert_eq!(memory.path(), Path::new(""));
    let (table_id, _, _) = tasks(&mut memory, 3);
    let info = ok(memory.info());
    let tables = ok(memory.list_tables());

    let path = dir.path().join("Plan.kitable");
    write(&path, &ok(memory.to_bytes()));
    let native = ok(KitableFile::open(&path));
    assert_eq!(native.read_only(), None);
    assert_eq!(ok(native.info()).document_id, info.document_id);
    assert_eq!(ok(native.info()).title, "Plan");
    assert_eq!(ok(native.list_tables()), tables);
    assert_eq!(rows(&native, table_id), rows(&memory, table_id));
    assert_eq!(native.replica().doc_id(), memory.replica().doc_id());
}

#[test]
fn bytes_of_a_file_from_before_the_kdm_migrate_in_memory() {
    let dir = temp();
    let path = dir.path().join("Old.kitable");
    let mut file = ok(KitableFile::create(&path, &CreateOptions::default()));
    let (table_id, _, _) = tasks(&mut file, 20);
    let before = rows(&file, table_id);
    file.close();
    let mut conn = ok(Connection::open(&path));
    ok(kition_kitable::kdm::migrate::downgrade(&mut conn));
    drop(conn);
    let old = ok(fs::read(&path));

    let mut memory = ok(KitableFile::open_bytes(&old));
    assert_eq!(memory.read_only(), None);
    assert_eq!(rows(&memory, table_id), before);
    let record = ok(memory.list_records(table_id)).remove(0);
    ok(memory.delete_record(table_id, record.id));
    assert_eq!(ok(fs::read(&path)), old);

    let saved = dir.path().join("Migrated.kitable");
    write(&saved, &ok(memory.to_bytes()));
    let native = ok(KitableFile::open(&saved));
    assert_eq!(native.read_only(), None);
    assert_eq!(rows(&native, table_id), rows(&memory, table_id));
    assert_eq!(ok(native.count_records(table_id)), 19);
}

#[test]
fn bytes_that_are_no_kitable_file_are_refused() {
    assert!(KitableFile::open_bytes(&[]).is_err());
    assert!(KitableFile::open_bytes(b"not a database at all, just text").is_err());
}
