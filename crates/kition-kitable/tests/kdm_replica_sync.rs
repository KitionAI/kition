//! Relaying a `.kitable` file's KDM replica to another copy of the same document, as co-editing
//! does through a sync room: `replica_version`, `export_replica_changes(since)`, and
//! `import_replica_changes(changes)`.

use std::fs;
use std::path::{Path, PathBuf};

use kition_kdm::{Origin, Version};
use kition_kitable::{
    CreateOptions, FieldPatch, FieldSpec, KitableFile, TableChange, TableSpec, ViewSpec,
};
use serde_json::{Map, Value, json};

fn ok<T, E: std::fmt::Display>(result: Result<T, E>) -> T {
    result.unwrap_or_else(|err| panic!("unexpected error: {err}"))
}

fn values(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn field(title: &str, field_type: &str) -> FieldSpec {
    FieldSpec {
        title: title.into(),
        field_type: field_type.into(),
        ..FieldSpec::default()
    }
}

fn open(path: &Path) -> KitableFile {
    let mut file = ok(KitableFile::open(path));
    file.set_origin(Origin::person("user:test"));
    file
}

/// One document in two files, `here.kitable` and its copy `there.kitable`, each opened by its own
/// handle (its own replica actor), with a table "Tasks" (Title, Status) and one record. Answers
/// the table and record ids, which the copy shares.
fn two_copies(dir: &Path) -> (PathBuf, KitableFile, KitableFile, i64, i64) {
    let path = dir.join("here.kitable");
    let mut file = ok(KitableFile::create(
        &path,
        &CreateOptions {
            title: "Shared".into(),
            ..CreateOptions::default()
        },
    ));
    file.set_origin(Origin::person("user:test"));
    let table = ok(file.create_table(&TableSpec {
        title: "Tasks".into(),
        fields: vec![
            FieldSpec {
                primary: true,
                ..field("Title", "text")
            },
            field("Status", "text"),
        ],
        ..TableSpec::default()
    }));
    let record = ok(file.create_record(table.id, &values(json!({ "title": "Write" }))));
    file.close();
    let other = dir.join("there.kitable");
    ok(fs::copy(&path, &other));
    (
        path,
        open(&dir.join("here.kitable")),
        open(&other),
        table.id,
        record.id,
    )
}

/// Sends everything `from` has that `to` lacks, as the relay does.
fn send(from: &KitableFile, to: &mut KitableFile) -> TableChange {
    let since = to.replica_version();
    let changes = ok(from.export_replica_changes(&since));
    ok(to.import_replica_changes(&changes)).change
}

fn field_titles(file: &KitableFile, table_id: i64) -> Vec<String> {
    let mut titles: Vec<String> = ok(file.list_fields(table_id))
        .into_iter()
        .map(|field| field.title)
        .collect();
    titles.sort();
    titles
}

fn view_titles(file: &KitableFile, table_id: i64) -> Vec<String> {
    let mut titles: Vec<String> = ok(file.get_table(table_id))
        .views
        .into_iter()
        .map(|view| view.title)
        .collect();
    titles.sort();
    titles
}

/// Every record's row key and values, by row key: integer ids are each file's own.
fn records(file: &KitableFile, table_id: i64) -> Vec<(String, Map<String, Value>)> {
    let mut rows: Vec<(String, Map<String, Value>)> = ok(file.list_records(table_id))
        .into_iter()
        .map(|record| (record.row_key, record.values))
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    rows
}

#[test]
fn two_files_exchanging_changes_converge_on_records_fields_and_views() {
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let (_, mut here, mut there, table_id, record_id) = two_copies(dir.path());

    // Concurrent edits on both sides: a record, a field, and a view each.
    ok(here.update_record(
        table_id,
        record_id,
        &values(json!({ "status": "doing" })),
        None,
    ));
    ok(here.create_record(table_id, &values(json!({ "title": "From here" }))));
    ok(here.create_field(table_id, &field("Owner", "text")));
    ok(here.create_view(
        table_id,
        &ViewSpec {
            title: "Board".into(),
            view_type: "kanban".into(),
            config: Value::Null,
        },
    ));
    ok(there.update_record(
        table_id,
        record_id,
        &values(json!({ "title": "Write more" })),
        None,
    ));
    ok(there.create_record(table_id, &values(json!({ "title": "From there" }))));
    let due = ok(there.create_field(table_id, &field("Due", "date")));
    ok(there.update_field(
        table_id,
        due.id,
        &FieldPatch {
            title: Some("Due date".into()),
            ..FieldPatch::default()
        },
    ));
    ok(there.create_view(
        table_id,
        &ViewSpec {
            title: "Calendar".into(),
            view_type: "calendar".into(),
            config: Value::Null,
        },
    ));

    let to_there = send(&here, &mut there);
    assert!(
        !to_there.records_upserted.is_empty(),
        "the import projected the records it brought: {to_there:?}"
    );
    let to_here = send(&there, &mut here);
    assert!(!to_here.schema.is_empty(), "{to_here:?}");
    // Repairs on either side (none expected here) would reach the other on the next round.
    send(&here, &mut there);

    assert_eq!(
        ok(here.replica().state_hash()),
        ok(there.replica().state_hash()),
        "both replicas hold the same document"
    );
    assert_eq!(here.replica_version(), there.replica_version());
    assert_eq!(records(&here, table_id), records(&there, table_id));
    let record = ok(here.get_record(table_id, record_id));
    assert_eq!(record.values.get("status"), Some(&json!("doing")));
    assert_eq!(record.values.get("title"), Some(&json!("Write more")));
    assert_eq!(records(&here, table_id).len(), 3);
    assert_eq!(
        field_titles(&here, table_id),
        field_titles(&there, table_id)
    );
    assert!(field_titles(&here, table_id).contains(&"Owner".to_owned()));
    assert!(field_titles(&here, table_id).contains(&"Due date".to_owned()));
    assert_eq!(view_titles(&here, table_id), view_titles(&there, table_id));
    assert!(view_titles(&here, table_id).contains(&"Board".to_owned()));
    assert!(view_titles(&here, table_id).contains(&"Calendar".to_owned()));

    // Stored, not only in memory: reopened files read the same.
    let here_path = here.path().to_path_buf();
    let there_path = there.path().to_path_buf();
    here.close();
    there.close();
    let here = open(&here_path);
    let there = open(&there_path);
    assert_eq!(records(&here, table_id), records(&there, table_id));
    assert_eq!(
        field_titles(&here, table_id),
        field_titles(&there, table_id)
    );
    assert_eq!(view_titles(&here, table_id), view_titles(&there, table_id));
}

#[test]
fn an_import_is_not_an_undo_step() {
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let (_, mut here, mut there, table_id, record_id) = two_copies(dir.path());

    ok(here.update_record(
        table_id,
        record_id,
        &values(json!({ "status": "mine" })),
        None,
    ));
    ok(there.update_record(
        table_id,
        record_id,
        &values(json!({ "title": "Theirs" })),
        None,
    ));
    send(&there, &mut here);
    let record = ok(here.get_record(table_id, record_id));
    assert_eq!(record.values.get("title"), Some(&json!("Theirs")));

    // Undo reverts the person's own last edit, not the import that came after it.
    let (done, _) = ok(here.undo());
    assert!(done);
    let record = ok(here.get_record(table_id, record_id));
    assert_ne!(
        record.values.get("status"),
        Some(&json!("mine")),
        "the own edit is undone"
    );
    assert_eq!(
        record.values.get("title"),
        Some(&json!("Theirs")),
        "the imported edit stays"
    );
    // The import was no undo step of its own: nothing is left to undo.
    assert!(!here.can_undo());
    let (done, _) = ok(here.undo());
    assert!(!done);
    assert_eq!(
        ok(here.get_record(table_id, record_id)).values.get("title"),
        Some(&json!("Theirs"))
    );
}

#[test]
fn export_since_a_version_holds_only_newer_changes() {
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let (_, mut here, mut there, table_id, record_id) = two_copies(dir.path());
    let before = here.replica_version();
    let everything_before = ok(here.export_replica_changes(&Version::empty()));

    // Nothing is newer than the current version.
    let nothing = ok(here.export_replica_changes(&before));
    assert_eq!(
        ok(there.import_replica_changes(&nothing)).change,
        TableChange::default(),
        "an export from the current version changes nothing"
    );

    ok(here.update_record(
        table_id,
        record_id,
        &values(json!({ "status": "newer" })),
        None,
    ));
    let newer = ok(here.export_replica_changes(&before));
    let everything = ok(here.export_replica_changes(&Version::empty()));
    assert!(
        newer.len() < everything.len(),
        "the export since `before` is not the whole history ({} vs {} bytes)",
        newer.len(),
        everything.len()
    );
    assert!(everything.len() > everything_before.len());

    // `there` is at `before`: the newer changes alone bring it up to date.
    assert_eq!(there.replica_version(), before);
    let imported = ok(there.import_replica_changes(&newer));
    assert!(
        imported
            .change
            .records_upserted
            .iter()
            .any(|(table, _)| *table == table_id),
        "{imported:?}"
    );
    assert_eq!(
        ok(there.get_record(table_id, record_id))
            .values
            .get("status"),
        Some(&json!("newer"))
    );
    assert_eq!(there.replica_version(), here.replica_version());

    // Importing the same changes again is harmless and changes nothing.
    assert_eq!(
        ok(there.import_replica_changes(&newer)).change,
        TableChange::default()
    );
}

#[test]
fn changes_of_another_document_are_refused() {
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let (_, here, _, _, _) = two_copies(dir.path());
    let stranger_path = dir.path().join("stranger.kitable");
    let mut stranger = ok(KitableFile::create(
        &stranger_path,
        &CreateOptions::default(),
    ));
    let before = stranger.replica_version();
    let changes = ok(here.export_replica_changes(&Version::empty()));
    assert!(stranger.import_replica_changes(&changes).is_err());
    assert!(
        stranger
            .import_replica_changes(b"not a kdm export")
            .is_err()
    );
    assert_eq!(stranger.replica_version(), before, "nothing was imported");
}
