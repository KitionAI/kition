//! The schema-3-to-KDM migration: every bundled fixture round-trips through
//! `replica_from_relational`/`upgrade`, matching the legacy relational reads field for field.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use kition_kdm::{ActorId, ObjectId, Replica};
use kition_kitable::kdm::migrate;
use kition_kitable::kdm::model::is_computed;
use kition_kitable::kdm::options::options_from_kdm;
use kition_kitable::kdm::read::ModelView;
use kition_kitable::kdm::{schema, store};
use kition_kitable::{
    CreateOptions, Field, FieldPatch, FieldSpec, KitableFile, TableSpec, View, ViewField,
};
use rusqlite::Connection;
use serde_json::{Map, Value, json};

fn temp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap_or_else(|err| panic!("tempdir: {err}"))
}

fn actor(id: u64) -> ActorId {
    ActorId::from_u64(id).unwrap_or_else(|err| panic!("actor: {err}"))
}

fn ok<T, E: std::fmt::Display>(result: Result<T, E>) -> T {
    result.unwrap_or_else(|err| panic!("unexpected error: {err}"))
}

fn values(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn copy_into(dir: &Path, original: &Path) -> PathBuf {
    let path = dir.join(
        original
            .file_name()
            .unwrap_or_else(|| panic!("a file name for {}", original.display())),
    );
    fs::copy(original, &path).unwrap_or_else(|err| panic!("copy {}: {err}", original.display()));
    path
}

// ---------------------------------------------------------------------------
// Discovering the bundled fixtures.

/// Every bundled `.kitable` fixture under `public/onboarding` (onboarding tables and templates).
fn bundled_files() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/onboarding");
    let mut found = Vec::new();
    collect_kitable(&root, &mut found);
    assert!(
        !found.is_empty(),
        "no bundled .kitable fixtures found under {}",
        root.display()
    );
    found.sort();
    found
}

fn collect_kitable(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_kitable(&path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("kitable") {
            out.push(path);
        }
    }
}

// ---------------------------------------------------------------------------
// Capturing the legacy ("before") picture of a file, read through the relational API.

struct ExpectedRecord {
    relational_id: i64,
    row_key: String,
    values: Map<String, Value>,
}

struct ExpectedTable {
    relational_id: i64,
    name: String,
    title: String,
    description: String,
    meta: Map<String, Value>,
    primary_field_id: Option<i64>,
    fields: Vec<Field>,
    views: Vec<View>,
    view_fields: HashMap<i64, Vec<ViewField>>,
    records: Vec<ExpectedRecord>,
}

struct ExpectedLink {
    from_record_id: i64,
    from_field_id: i64,
    to_record_id: i64,
}

/// Opens `path` (migrating it to schema 3 if it predates it, as a real open would) and reads
/// every table, field, view, record, and link through the legacy API, then closes it.
fn capture_before(path: &Path) -> (Vec<ExpectedTable>, Vec<ExpectedLink>) {
    let file = ok(KitableFile::open(path));
    let mut tables = Vec::new();
    for table in ok(file.list_tables()) {
        let mut view_fields = HashMap::new();
        for view in &table.views {
            view_fields.insert(view.id, ok(file.list_view_fields(view.id)));
        }
        let mut records = Vec::new();
        for record in ok(file.list_records(table.id)) {
            records.push(ExpectedRecord {
                relational_id: record.id,
                row_key: record.row_key,
                values: record.values,
            });
        }
        tables.push(ExpectedTable {
            relational_id: table.id,
            name: table.name,
            title: table.title,
            description: table.description,
            meta: table.meta,
            primary_field_id: table.primary_field_id,
            fields: table.fields,
            views: table.views,
            view_fields,
            records,
        });
    }
    let links: Vec<ExpectedLink> = {
        let mut statement = file
            .conn()
            .prepare("SELECT from_record_id, from_field_id, to_record_id FROM kition_record_links ORDER BY id ASC")
            .unwrap_or_else(|err| panic!("prepare links: {err}"));
        statement
            .query_map([], |row| {
                Ok(ExpectedLink {
                    from_record_id: row.get(0)?,
                    from_field_id: row.get(1)?,
                    to_record_id: row.get(2)?,
                })
            })
            .unwrap_or_else(|err| panic!("query links: {err}"))
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap_or_else(|err| panic!("collect links: {err}"))
    };
    file.close();
    (tables, links)
}

// ---------------------------------------------------------------------------
// Reading `kdm_id` back from the relational tables after an upgrade.

fn kdm_ids(conn: &Connection, table: &str) -> HashMap<i64, ObjectId> {
    let sql = format!("SELECT id, kdm_id FROM {table} WHERE kdm_id IS NOT NULL");
    let mut statement = conn
        .prepare(&sql)
        .unwrap_or_else(|err| panic!("prepare {table}: {err}"));
    statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap_or_else(|err| panic!("query {table}: {err}"))
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap_or_else(|err| panic!("collect {table}: {err}"))
        .into_iter()
        .map(|(id, kdm)| (id, ObjectId::from_string(kdm)))
        .collect()
}

fn assert_no_missing_kdm_id(conn: &Connection, sql: &str, label: &str) {
    let count: i64 = conn
        .query_row(sql, [], |row| row.get(0))
        .unwrap_or_else(|err| panic!("{label}: {err}"));
    assert_eq!(count, 0, "{label} has live rows without a kdm_id");
}

// ---------------------------------------------------------------------------
// Comparing the legacy picture to the replica's.

fn assert_matches(
    expected: &[ExpectedTable],
    links: &[ExpectedLink],
    conn_after: &Connection,
    replica: &Replica,
) {
    let table_kdm = kdm_ids(conn_after, "kition_tables");
    let field_kdm = kdm_ids(conn_after, "kition_fields");
    let view_kdm = kdm_ids(conn_after, "kition_views");
    let mut local_any: HashMap<ObjectId, i64> = HashMap::new();
    for (id, object) in &table_kdm {
        local_any.insert(object.clone(), *id);
    }
    for (id, object) in &field_kdm {
        local_any.insert(object.clone(), *id);
    }

    let view = ModelView::new(replica);
    let mut row_key_by_relational_id: HashMap<i64, String> = HashMap::new();

    for table in expected {
        let table_object = table_kdm
            .get(&table.relational_id)
            .unwrap_or_else(|| panic!("missing kdm_id for table {}", table.name))
            .clone();
        let kdm_table = ok(view.table(&table_object));
        assert_eq!(kdm_table.name, table.name);
        assert_eq!(kdm_table.title, table.title);
        assert_eq!(kdm_table.description, table.description);
        assert_eq!(
            kdm_table.meta,
            Value::Object(table.meta.clone()),
            "{}",
            table.name
        );
        if let Some(primary_id) = table.primary_field_id {
            assert_eq!(
                kdm_table.primary_field,
                field_kdm.get(&primary_id).cloned(),
                "primary field of {}",
                table.name
            );
        }
        assert_eq!(
            ok(view.fields(&table_object)).len(),
            table.fields.len(),
            "field count of {}",
            table.name
        );
        assert_eq!(
            ok(view.views(&table_object)).len(),
            table.views.len(),
            "view count of {}",
            table.name
        );

        for field in &table.fields {
            let object = field_kdm
                .get(&field.id)
                .unwrap_or_else(|| panic!("missing kdm_id for field {}", field.name))
                .clone();
            let kdm_field = ok(view.field(&object));
            assert_eq!(kdm_field.name, field.name);
            assert_eq!(kdm_field.title, field.title);
            assert_eq!(kdm_field.field_type, field.field_type);
            assert_eq!(kdm_field.required, field.required, "{}", field.name);
            assert_eq!(kdm_field.readonly, field.readonly, "{}", field.name);
            assert_eq!(kdm_field.formula, field.formula);
            assert_eq!(kdm_field.ai_prompt, field.ai_prompt);
            assert_eq!(
                kdm_field.meta,
                Value::Object(field.meta.clone()),
                "{}",
                field.name
            );
            let converted = options_from_kdm(&kdm_field.options, |id| local_any.get(id).copied());
            assert_eq!(
                converted,
                Value::Object(field.options.clone()),
                "options of field {}",
                field.name
            );
        }

        for view_row in &table.views {
            let object = view_kdm
                .get(&view_row.id)
                .unwrap_or_else(|| panic!("missing kdm_id for view {}", view_row.title))
                .clone();
            let kdm_view = ok(view.view(&object));
            assert_eq!(kdm_view.view_type, view_row.view_type);
            assert_eq!(kdm_view.title, view_row.title);
            assert_eq!(kdm_view.locked, view_row.locked);
            assert_eq!(
                kdm_view.config,
                Value::Object(view_row.config.clone()),
                "config of view {}",
                view_row.title
            );
            let empty = Vec::new();
            let layout = table.view_fields.get(&view_row.id).unwrap_or(&empty);
            let mut expected_widths: BTreeMap<ObjectId, i64> = BTreeMap::new();
            let mut expected_hidden: BTreeMap<ObjectId, bool> = BTreeMap::new();
            for item in layout {
                let Some(field_object) = field_kdm.get(&item.field_id) else {
                    continue;
                };
                expected_widths.insert(field_object.clone(), item.width.clamp(40, 1200));
                if !item.visible {
                    expected_hidden.insert(field_object.clone(), true);
                }
            }
            assert_eq!(
                kdm_view.widths, expected_widths,
                "widths of view {}",
                view_row.title
            );
            assert_eq!(
                kdm_view.hidden, expected_hidden,
                "hidden of view {}",
                view_row.title
            );
        }

        let expected_order: Vec<String> = table
            .records
            .iter()
            .map(|record| record.row_key.clone())
            .collect();
        let actual_order: Vec<String> = ok(view.record_ids(&table_object))
            .into_iter()
            .map(|id| id.to_string())
            .collect();
        assert_eq!(
            actual_order, expected_order,
            "record order of table {}",
            table.name
        );

        for record in &table.records {
            row_key_by_relational_id.insert(record.relational_id, record.row_key.clone());
            let record_object = ObjectId::from_string(record.row_key.clone());
            let mut expected_cells = Map::new();
            for (name, value) in &record.values {
                if value.is_null() {
                    continue;
                }
                let Some(field) = table.fields.iter().find(|field| &field.name == name) else {
                    continue;
                };
                if is_computed(&field.field_type) {
                    continue;
                }
                let Some(object) = field_kdm.get(&field.id) else {
                    continue;
                };
                expected_cells.insert(object.to_string(), value.clone());
            }
            let actual_cells = ok(view.cells(&record_object));
            assert_eq!(
                actual_cells, expected_cells,
                "cells of record {}",
                record.row_key
            );
        }
    }

    let mut expected_links: Vec<(String, String, String)> = Vec::new();
    for link in links {
        let (Some(from), Some(field), Some(to)) = (
            row_key_by_relational_id.get(&link.from_record_id),
            field_kdm.get(&link.from_field_id),
            row_key_by_relational_id.get(&link.to_record_id),
        ) else {
            // One end is a soft-deleted record or field: neither is this link.
            continue;
        };
        expected_links.push((from.clone(), field.as_str().to_owned(), to.clone()));
    }
    expected_links.sort();
    let mut actual_links: Vec<(String, String, String)> = ok(view.links())
        .into_iter()
        .map(|link| {
            (
                link.from.to_string(),
                link.field.to_string(),
                link.to.to_string(),
            )
        })
        .collect();
    actual_links.sort();
    assert_eq!(actual_links, expected_links, "links");
}

// ---------------------------------------------------------------------------
// Per-fixture checks.

/// Copies `original`, upgrades the copy, and checks it against the legacy picture. Returns how
/// long `upgrade` took.
fn check_bundled_file(original: &Path) -> std::time::Duration {
    let dir = temp();
    let path = copy_into(dir.path(), original);
    let (expected, links) = capture_before(&path);

    let mut conn =
        Connection::open(&path).unwrap_or_else(|err| panic!("open {}: {err}", path.display()));
    // Reading through `KitableFile` migrated the copy; start the upgrade from schema 3 again.
    ok(migrate::downgrade(&mut conn));
    let start = Instant::now();
    ok(migrate::upgrade(&mut conn, actor(1)));
    let elapsed = start.elapsed();

    assert_no_missing_kdm_id(
        &conn,
        "SELECT COUNT(*) FROM kition_tables WHERE deleted_at IS NULL AND kdm_id IS NULL",
        "kition_tables",
    );
    assert_no_missing_kdm_id(
        &conn,
        "SELECT COUNT(*) FROM kition_fields WHERE deleted_at IS NULL AND kdm_id IS NULL",
        "kition_fields",
    );
    assert_no_missing_kdm_id(
        &conn,
        "SELECT COUNT(*) FROM kition_views WHERE deleted_at IS NULL AND kdm_id IS NULL",
        "kition_views",
    );
    assert_no_missing_kdm_id(
        &conn,
        "SELECT COUNT(*) FROM kition_record_links WHERE kdm_id IS NULL",
        "kition_record_links",
    );

    let replica = ok(store::load(&conn, schema(), actor(2)))
        .unwrap_or_else(|| panic!("expected a replica for {}", path.display()));
    assert_matches(&expected, &links, &conn, &replica);

    let position_before = ok(store::stored_position(&conn));
    ok(migrate::upgrade(&mut conn, actor(1)));
    assert_eq!(
        ok(store::stored_position(&conn)),
        position_before,
        "a second upgrade should be a no-op for {}",
        path.display()
    );

    elapsed
}

/// Builds the replica directly, saves and loads it, and checks the two have the same state hash.
/// Done on a separate copy: `upgrade`'s own build mints a fresh document id, so it cannot be
/// compared against an independent build of the same file.
fn check_store_round_trip(original: &Path) {
    let dir = temp();
    let path = copy_into(dir.path(), original);
    ok(KitableFile::open(&path)).close();

    let mut conn =
        Connection::open(&path).unwrap_or_else(|err| panic!("open {}: {err}", path.display()));
    ok(migrate::downgrade(&mut conn));
    let replica = ok(migrate::replica_from_relational(&conn, actor(1)));
    {
        let tx = conn
            .transaction()
            .unwrap_or_else(|err| panic!("transaction: {err}"));
        ok(store::ensure_tables(&tx));
        ok(store::save_initial(&tx, &replica, 0));
        tx.commit().unwrap_or_else(|err| panic!("commit: {err}"));
    }
    let loaded = ok(store::load(&conn, schema(), actor(2)))
        .unwrap_or_else(|| panic!("expected a replica for {}", path.display()));
    assert_eq!(
        ok(loaded.state_hash()),
        ok(replica.state_hash()),
        "state hash round trip for {}",
        path.display()
    );
}

#[test]
fn every_bundled_file_migrates() {
    let files = bundled_files();
    let mut largest: Option<(PathBuf, std::time::Duration, u64)> = None;
    for path in &files {
        let size = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        let elapsed = check_bundled_file(path);
        check_store_round_trip(path);
        if largest.as_ref().is_none_or(|(_, _, best)| size > *best) {
            largest = Some((path.clone(), elapsed, size));
        }
    }
    if let Some((path, elapsed, size)) = largest {
        println!(
            "upgrade of the largest bundled fixture ({}, {size} bytes) took {elapsed:?}",
            path.display()
        );
    }
}

// ---------------------------------------------------------------------------
// Targeted behavior.

#[test]
fn upgrading_twice_is_a_no_op() {
    let dir = temp();
    let path = dir.path().join("doc.kitable");
    let file = ok(KitableFile::create(
        &path,
        &CreateOptions {
            title: "Doc".into(),
            ..Default::default()
        },
    ));
    file.close();

    let mut conn = Connection::open(&path).unwrap_or_else(|err| panic!("open: {err}"));
    // Files are written with a replica now; start from the schema-3 file the legacy writers made.
    ok(migrate::downgrade(&mut conn));
    ok(migrate::upgrade(&mut conn, actor(1)));
    let position = ok(store::stored_position(&conn));
    ok(migrate::upgrade(&mut conn, actor(1)));
    assert_eq!(ok(store::stored_position(&conn)), position);
}

#[test]
fn a_failed_upgrade_leaves_the_file_unchanged() {
    let dir = temp();
    let path = dir.path().join("doc.kitable");
    let mut file = ok(KitableFile::create(
        &path,
        &CreateOptions {
            title: "Doc".into(),
            ..Default::default()
        },
    ));
    let table = ok(file.create_table(&TableSpec {
        title: "Items".into(),
        ..Default::default()
    }));
    let title_field = table
        .fields
        .first()
        .unwrap_or_else(|| panic!("a default primary field"));
    ok(file.create_record(table.id, &values(json!({ title_field.name.clone(): "A" }))));
    // No safe API makes a bad row_key; corrupt it directly, as a damaged file would have one.
    file.conn()
        .execute(
            "UPDATE kition_records SET row_key = 'bad key!' WHERE table_id = ?1",
            [table.id],
        )
        .unwrap_or_else(|err| panic!("corrupt: {err}"));
    file.close();

    let mut conn = Connection::open(&path).unwrap_or_else(|err| panic!("open: {err}"));
    // Files are written with a replica now; start from the schema-3 file the legacy writers made.
    ok(migrate::downgrade(&mut conn));
    assert!(migrate::upgrade(&mut conn, actor(1)).is_err());

    let kdm_table_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'kition_kdm'",
            [],
            |row| row.get(0),
        )
        .unwrap_or_else(|err| panic!("query: {err}"));
    assert_eq!(
        kdm_table_exists, 0,
        "a failed upgrade must not create kition_kdm"
    );
}

#[test]
fn a_link_to_a_table_created_later_migrates() {
    let dir = temp();
    let path = dir.path().join("doc.kitable");
    let mut file = ok(KitableFile::create(
        &path,
        &CreateOptions {
            title: "Doc".into(),
            ..Default::default()
        },
    ));
    let first = ok(file.create_table(&TableSpec {
        title: "First".into(),
        fields: vec![
            FieldSpec {
                title: "Name".into(),
                field_type: "text".into(),
                primary: true,
                required: true,
                ..Default::default()
            },
            FieldSpec {
                title: "Related".into(),
                field_type: "link_to_record".into(),
                ..Default::default()
            },
        ],
        ..Default::default()
    }));
    let second = ok(file.create_table(&TableSpec {
        title: "Second".into(),
        ..Default::default()
    }));
    let link_field = first
        .fields
        .iter()
        .find(|field| field.field_type == "link_to_record")
        .unwrap_or_else(|| panic!("a link_to_record field"));
    ok(file.update_field(
        first.id,
        link_field.id,
        &FieldPatch {
            options: Some(json!({ "target_table_id": second.id, "allow_multiple": true })),
            ..Default::default()
        },
    ));
    file.close();

    let mut conn = Connection::open(&path).unwrap_or_else(|err| panic!("open: {err}"));
    // Files are written with a replica now; start from the schema-3 file the legacy writers made.
    ok(migrate::downgrade(&mut conn));
    ok(migrate::upgrade(&mut conn, actor(1)));

    let replica =
        ok(store::load(&conn, schema(), actor(2))).unwrap_or_else(|| panic!("expected a replica"));
    let second_object = kdm_ids(&conn, "kition_tables")
        .get(&second.id)
        .cloned()
        .unwrap_or_else(|| panic!("missing kdm_id for the second table"));
    let link_field_object = kdm_ids(&conn, "kition_fields")
        .get(&link_field.id)
        .cloned()
        .unwrap_or_else(|| panic!("missing kdm_id for the link field"));
    let view = ModelView::new(&replica);
    let field_data = ok(view.field(&link_field_object));
    assert_eq!(
        field_data.options.get("target_table"),
        Some(&Value::String(second_object.to_string()))
    );
}

#[test]
fn tables_with_zero_live_views_or_fields_migrate_without_seeding_defaults() {
    let dir = temp();
    let path = dir.path().join("doc.kitable");
    let mut file = ok(KitableFile::create(
        &path,
        &CreateOptions {
            title: "Doc".into(),
            ..Default::default()
        },
    ));
    // A table whose one (default) view gets deleted: nothing stops a user from deleting every
    // view of a table through the legacy API.
    let no_views = ok(file.create_table(&TableSpec {
        title: "No Views".into(),
        ..Default::default()
    }));
    let default_view = no_views
        .views
        .first()
        .unwrap_or_else(|| panic!("a default view"));
    ok(file.delete_view(no_views.id, default_view.id));

    // A table left with no live fields at all. The legacy API refuses deleting the primary
    // field, so this state can only come from a damaged file; corrupt it directly, as such a
    // file would already be.
    let no_fields = ok(file.create_table(&TableSpec {
        title: "No Fields".into(),
        ..Default::default()
    }));
    file.conn()
        .execute(
            "UPDATE kition_fields SET deleted_at = 1 WHERE table_id = ?1",
            [no_fields.id],
        )
        .unwrap_or_else(|err| panic!("soft-delete fields: {err}"));
    file.close();

    let mut conn = Connection::open(&path).unwrap_or_else(|err| panic!("open: {err}"));
    // Files are written with a replica now; start from the schema-3 file the legacy writers made.
    ok(migrate::downgrade(&mut conn));
    ok(migrate::upgrade(&mut conn, actor(1)));

    let table_kdm = kdm_ids(&conn, "kition_tables");
    let replica =
        ok(store::load(&conn, schema(), actor(2))).unwrap_or_else(|| panic!("expected a replica"));
    let view = ModelView::new(&replica);

    let no_views_object = table_kdm
        .get(&no_views.id)
        .cloned()
        .unwrap_or_else(|| panic!("missing kdm_id for No Views"));
    assert!(
        ok(view.views(&no_views_object)).is_empty(),
        "a table with no live views must not get a seeded default view"
    );

    let no_fields_object = table_kdm
        .get(&no_fields.id)
        .cloned()
        .unwrap_or_else(|| panic!("missing kdm_id for No Fields"));
    assert!(
        ok(view.fields(&no_fields_object)).is_empty(),
        "a table with no live fields must not get a seeded default field"
    );
    assert_eq!(ok(view.table(&no_fields_object)).primary_field, None);
}

#[test]
fn dangling_option_references_become_null() {
    let dir = temp();
    let path = dir.path().join("doc.kitable");
    let mut file = ok(KitableFile::create(
        &path,
        &CreateOptions {
            title: "Doc".into(),
            ..Default::default()
        },
    ));
    let gone = ok(file.create_table(&TableSpec {
        title: "Gone".into(),
        ..Default::default()
    }));
    let main = ok(file.create_table(&TableSpec {
        title: "Main".into(),
        fields: vec![
            FieldSpec {
                title: "Name".into(),
                field_type: "text".into(),
                primary: true,
                required: true,
                ..Default::default()
            },
            FieldSpec {
                title: "Dead Link".into(),
                field_type: "text".into(),
                ..Default::default()
            },
            FieldSpec {
                title: "Dead Source".into(),
                field_type: "text".into(),
                ..Default::default()
            },
        ],
        ..Default::default()
    }));
    let name_field = main
        .fields
        .iter()
        .find(|field| field.name == "name")
        .unwrap_or_else(|| panic!("a name field"));
    let dead_link_field = main
        .fields
        .iter()
        .find(|field| field.name == "dead_link")
        .unwrap_or_else(|| panic!("a dead_link field"));
    let dead_source_field = main
        .fields
        .iter()
        .find(|field| field.name == "dead_source")
        .unwrap_or_else(|| panic!("a dead_source field"));

    // A link field whose target table will be deleted.
    let related = ok(file.create_field(
        main.id,
        &FieldSpec {
            title: "Related".into(),
            field_type: "link_to_record".into(),
            options: json!({ "target_table_id": gone.id, "allow_multiple": true }),
            ..Default::default()
        },
    ));
    // A lookup whose link field will be deleted; its target field (Name) stays.
    let lookup = ok(file.create_field(
        main.id,
        &FieldSpec {
            title: "Lookup".into(),
            field_type: "lookup".into(),
            options: json!({ "link_field_id": dead_link_field.id, "target_field_id": name_field.id }),
            ..Default::default()
        },
    ));
    // An AI field whose source field will be deleted.
    let ai = ok(file.create_field(
        main.id,
        &FieldSpec {
            title: "Thumb".into(),
            field_type: "ai".into(),
            options: json!({ "ai_config": { "source_field_id": dead_source_field.id, "type": "x" } }),
            ..Default::default()
        },
    ));

    ok(file.delete_table(gone.id));
    ok(file.delete_field(main.id, dead_link_field.id));
    ok(file.delete_field(main.id, dead_source_field.id));
    file.close();

    let mut conn = Connection::open(&path).unwrap_or_else(|err| panic!("open: {err}"));
    // Files are written with a replica now; start from the schema-3 file the legacy writers made.
    ok(migrate::downgrade(&mut conn));
    ok(migrate::upgrade(&mut conn, actor(1)));

    let field_kdm = kdm_ids(&conn, "kition_fields");
    let table_kdm = kdm_ids(&conn, "kition_tables");
    let mut local_any: HashMap<ObjectId, i64> = HashMap::new();
    for (id, object) in &table_kdm {
        local_any.insert(object.clone(), *id);
    }
    for (id, object) in &field_kdm {
        local_any.insert(object.clone(), *id);
    }
    let replica =
        ok(store::load(&conn, schema(), actor(2))).unwrap_or_else(|| panic!("expected a replica"));
    let view = ModelView::new(&replica);

    let related_object = field_kdm
        .get(&related.id)
        .cloned()
        .unwrap_or_else(|| panic!("missing kdm_id for Related"));
    let related_data = ok(view.field(&related_object));
    assert_eq!(related_data.options.get("target_table"), Some(&Value::Null));
    assert_eq!(
        options_from_kdm(&related_data.options, |id| local_any.get(id).copied())
            .get("target_table_id"),
        Some(&Value::Null)
    );

    let lookup_object = field_kdm
        .get(&lookup.id)
        .cloned()
        .unwrap_or_else(|| panic!("missing kdm_id for Lookup"));
    let lookup_data = ok(view.field(&lookup_object));
    assert_eq!(lookup_data.options.get("link_field"), Some(&Value::Null));
    // The target field (Name) was kept, so it still resolves.
    assert_eq!(
        lookup_data.options.get("target_field"),
        Some(&Value::String(
            field_kdm
                .get(&name_field.id)
                .unwrap_or_else(|| panic!("missing kdm_id for Name"))
                .to_string()
        ))
    );
    let lookup_relational = options_from_kdm(&lookup_data.options, |id| local_any.get(id).copied());
    assert_eq!(lookup_relational.get("link_field_id"), Some(&Value::Null));
    assert_eq!(
        lookup_relational.get("target_field_id"),
        Some(&json!(name_field.id))
    );

    let ai_object = field_kdm
        .get(&ai.id)
        .cloned()
        .unwrap_or_else(|| panic!("missing kdm_id for Thumb"));
    let ai_data = ok(view.field(&ai_object));
    let ai_config = ai_data
        .options
        .get("ai_config")
        .unwrap_or_else(|| panic!("ai_config"));
    assert_eq!(ai_config.get("source_field"), Some(&Value::Null));
    assert_eq!(ai_config.get("type"), Some(&json!("x")));

    // The rest of the file is intact: Main's live fields and its Name cell still migrate.
    let main_object = table_kdm
        .get(&main.id)
        .cloned()
        .unwrap_or_else(|| panic!("missing kdm_id for Main"));
    let main_fields = ok(view.fields(&main_object));
    let names: Vec<&str> = main_fields
        .iter()
        .map(|field| field.name.as_str())
        .collect();
    assert_eq!(names, vec!["name", "related", "lookup", "thumb"]);
}

/// Builds a 10k-record table through the relational API, upgrades it, and prints how long it
/// takes. Run with `cargo test -p kition-kitable --test kdm_migrate -- --ignored large_table`.
#[test]
#[ignore = "prints timings; not a correctness check"]
fn large_table_upgrade_timings() {
    let dir = temp();
    let path = dir.path().join("big.kitable");
    let mut file = ok(KitableFile::create(
        &path,
        &CreateOptions {
            title: "Big".into(),
            ..Default::default()
        },
    ));
    let table = ok(file.create_table(&TableSpec {
        title: "Rows".into(),
        fields: vec![FieldSpec {
            title: "Name".into(),
            field_type: "text".into(),
            primary: true,
            required: true,
            ..Default::default()
        }],
        ..Default::default()
    }));
    let field_name = table
        .fields
        .first()
        .map(|field| field.name.clone())
        .unwrap_or_default();

    let build_start = Instant::now();
    for index in 0..10_000 {
        let mut row = Map::new();
        row.insert(field_name.clone(), json!(format!("row-{index}")));
        ok(file.create_record(table.id, &row));
    }
    println!("building 10k records: {:?}", build_start.elapsed());
    file.close();

    let mut conn = Connection::open(&path).unwrap_or_else(|err| panic!("open: {err}"));
    // Files are written with a replica now; start from the schema-3 file the legacy writers made.
    ok(migrate::downgrade(&mut conn));
    let start = Instant::now();
    ok(migrate::upgrade(&mut conn, actor(1)));
    println!(
        "upgrade of a synthetic 10k-record table: {:?}",
        start.elapsed()
    );
}
