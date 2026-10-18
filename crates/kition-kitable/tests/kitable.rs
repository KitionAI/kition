//! Behavior of the `.kitable` format, ported from the legacy suite plus the
//! version 3 timestamp migration.

use std::path::{Path, PathBuf};

use kition_kitable::{
    AttachmentSpec, CreateOptions, FieldPatch, FieldSpec, FilterRule, FilterTree, FilterTreeChild,
    KitableError, KitableFile, Record, SCHEMA_VERSION, TablePatch, TableSpec, ViewFieldPatch,
    ViewPatch, ViewSort, ViewSpec,
};
use serde_json::{Map, Value, json};

fn temp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap_or_else(|err| panic!("tempdir: {err}"))
}

fn create(dir: &Path, name: &str) -> (PathBuf, KitableFile) {
    let path = dir.join(name);
    let file = KitableFile::create(
        &path,
        &CreateOptions {
            title: "Test".into(),
            ..Default::default()
        },
    )
    .unwrap_or_else(|err| panic!("create: {err}"));
    (path, file)
}

fn ok<T>(result: kition_kitable::Result<T>) -> T {
    result.unwrap_or_else(|err| panic!("unexpected error: {err}"))
}

fn values(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn field(name: &str, field_type: &str) -> FieldSpec {
    FieldSpec {
        name: name.into(),
        title: name.into(),
        field_type: field_type.into(),
        ..Default::default()
    }
}

fn primary(name: &str) -> FieldSpec {
    FieldSpec {
        primary: true,
        required: true,
        ..field(name, "text")
    }
}

#[test]
fn create_initializes_metadata_and_schema() {
    let dir = temp();
    let path = dir.path().join("topics.kitable");
    let file = ok(KitableFile::create(
        &path,
        &CreateOptions {
            title: "Topics".into(),
            document_id: "doc_test".into(),
            description: "Ideas".into(),
            created_at: Some(1_778_574_600_000),
            ..Default::default()
        },
    ));
    let info = ok(file.info());
    assert_eq!(info.path, path);
    assert_eq!(info.document_id, "doc_test");
    assert_eq!(info.title, "Topics");
    assert_eq!(info.format, "kition-kitable");
    assert_eq!(info.format_version, 1);
    assert_eq!(info.schema_version, SCHEMA_VERSION);
    assert_eq!(info.created_at, 1_778_574_600_000);
    for table in [
        "kition_meta",
        "kition_documents",
        "kition_tables",
        "kition_fields",
        "kition_views",
        "kition_records",
        "kition_attachments",
        "kition_change_log",
    ] {
        let count: i64 = ok(file
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |r| r.get(0),
            )
            .map_err(KitableError::from));
        assert_eq!(count, 1, "{table}");
    }
}

#[test]
fn title_defaults_to_file_stem_and_extension_is_added() {
    let dir = temp();
    let file = ok(KitableFile::create(
        &dir.path().join("calendar"),
        &CreateOptions::default(),
    ));
    assert!(file.path().ends_with("calendar.kitable"));
    assert_eq!(ok(file.info()).title, "calendar");
}

#[test]
fn reopen_preserves_document() {
    let dir = temp();
    let (path, file) = create(dir.path(), "calendar.kitable");
    let id = ok(file.info()).document_id;
    file.close();
    let reopened = ok(KitableFile::open(&path));
    assert_eq!(ok(reopened.info()).document_id, id);
}

#[test]
fn create_rejects_existing_path_and_open_rejects_newer_schema() {
    let dir = temp();
    let (path, file) = create(dir.path(), "existing.kitable");
    assert!(matches!(
        KitableFile::create(&path, &CreateOptions::default()),
        Err(KitableError::Exists)
    ));
    ok(file.set_meta("schema_version", "999"));
    file.close();
    assert!(matches!(
        KitableFile::open(&path),
        Err(KitableError::Newer(999))
    ));
}

#[test]
fn open_rejects_missing_file_and_foreign_format() {
    let dir = temp();
    assert!(KitableFile::open(&dir.path().join("missing.kitable")).is_err());
    let (path, file) = create(dir.path(), "x.kitable");
    ok(file.set_meta("format", "other"));
    file.close();
    assert!(matches!(
        KitableFile::open(&path),
        Err(KitableError::Invalid(_))
    ));
}

#[test]
fn migrates_legacy_text_timestamps_to_v3() {
    let dir = temp();
    let path = dir.path().join("legacy.kitable");
    {
        let conn = rusqlite::Connection::open(&path).unwrap_or_else(|err| panic!("{err}"));
        conn.execute_batch(
            "CREATE TABLE kition_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO kition_meta VALUES ('format','kition-kitable'),('format_version','1'),('schema_version','1'),
               ('document_id','doc_legacy'),('created_at','2026-10-09T03:57:06.334767Z'),('updated_at','2026-10-09T03:57:06Z');
             CREATE TABLE kition_documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
               icon TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', meta_json TEXT NOT NULL DEFAULT '{}',
               created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
             INSERT INTO kition_documents (id, title, created_at, updated_at) VALUES ('doc_legacy','Old','2026-10-09T03:57:06Z','2026-10-09T03:57:06Z');
             CREATE TABLE kition_tables (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id TEXT NOT NULL, name TEXT NOT NULL,
               title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
               primary_field_id INTEGER, meta_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL, deleted_at TEXT, UNIQUE(document_id, name),
               FOREIGN KEY(document_id) REFERENCES kition_documents(id) ON DELETE CASCADE);
             INSERT INTO kition_tables (document_id, name, title, created_at, updated_at, deleted_at)
               VALUES ('doc_legacy','tasks','Tasks','2026-10-09T03:57:06Z','2026-10-09T03:57:06Z','2026-10-09T04:00:00Z');",
        )
        .unwrap_or_else(|err| panic!("{err}"));
    }
    let file = ok(KitableFile::open(&path));
    let info = ok(file.info());
    // Opening also adds the KDM replica (schema 4) after the rebuild into schema 3.
    assert_eq!(info.schema_version, SCHEMA_VERSION);
    assert_eq!(info.created_at, 1_791_518_226_334);
    assert_eq!(info.title, "Old");
    let (created, deleted): (i64, i64) = ok(file
        .conn()
        .query_row(
            "SELECT created_at, deleted_at FROM kition_tables",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(KitableError::from));
    assert_eq!(created, 1_791_518_226_000);
    assert_eq!(deleted, 1_791_518_400_000);
    // The soft-deleted name can be reused; two live rows still collide.
    let now = 1_i64;
    let insert = "INSERT INTO kition_tables (document_id, name, title, created_at, updated_at) VALUES ('doc_legacy','tasks','T',?1,?1)";
    assert!(file.conn().execute(insert, [now]).is_ok());
    assert!(file.conn().execute(insert, [now]).is_err());
    // Tables missing from the legacy file were created.
    let records: i64 = ok(file
        .conn()
        .query_row("SELECT COUNT(*) FROM kition_records", [], |r| r.get(0))
        .map_err(KitableError::from));
    assert_eq!(records, 0);
}

#[test]
fn create_table_with_defaults_and_custom_schema() {
    let dir = temp();
    let (_, mut file) = create(dir.path(), "t.kitable");
    let table = ok(file.create_table(&TableSpec {
        title: "Untitled table".into(),
        ..Default::default()
    }));
    assert_eq!(table.name, "untitled_table");
    assert_eq!(table.order, 1);
    assert_eq!(table.fields.len(), 1);
    assert!(table.fields[0].is_primary && table.fields[0].required);
    assert_eq!(table.fields[0].name, "title");
    assert_eq!(table.primary_field_id, Some(table.fields[0].id));
    assert_eq!(table.views.len(), 1);
    assert_eq!(
        (
            table.views[0].title.as_str(),
            table.views[0].view_type.as_str()
        ),
        ("All", "grid")
    );
    assert!(table.created_at > 1_700_000_000_000);

    let second = ok(file.create_table(&TableSpec {
        title: "Untitled table".into(),
        fields: vec![field("Name", "text"), field("Score", "number")],
        views: vec![ViewSpec {
            title: "Board".into(),
            view_type: "kanban".into(),
            config: json!({"group": 1}),
        }],
        meta: json!({"color": "red"}),
        ..Default::default()
    }));
    assert_eq!(second.name, "untitled_table_2");
    assert!(
        second.fields[0].is_primary,
        "first field becomes primary when none is marked"
    );
    assert_eq!(second.views[0].config, values(json!({"group": 1})));
    assert_eq!(second.meta, values(json!({"color": "red"})));
    assert_eq!(ok(file.list_tables()).len(), 2);

    let bad = file.create_table(&TableSpec {
        fields: vec![field("x", "nope")],
        ..Default::default()
    });
    assert!(matches!(bad, Err(KitableError::Invalid(_))));
}

#[test]
fn record_crud_validation_and_history() {
    let dir = temp();
    let (path, mut file) = create(dir.path(), "r.kitable");
    let table = ok(file.create_table(&TableSpec {
        title: "Tasks".into(),
        fields: vec![primary("title"), field("status", "single_select")],
        ..Default::default()
    }));
    assert!(matches!(
        file.create_record(table.id, &values(json!({"status": "x"}))),
        Err(KitableError::Invalid(_))
    ));
    let record = ok(file.create_record(
        table.id,
        &values(json!({"title": "Write", "status": "todo", "ghost": 1})),
    ));
    assert_eq!(
        record.values,
        values(json!({"title": "Write", "status": "todo"}))
    );
    assert_eq!(record.row_key.len(), 36);
    assert_eq!(record.order, 1);

    let updated = ok(file.update_record(
        table.id,
        record.id,
        &values(json!({"status": "done"})),
        Some(5),
    ));
    assert_eq!(updated.values["status"], "done");
    assert_eq!(updated.values["title"], "Write");
    // Positions follow the record list: `order` moves the record before the first other record
    // at that position or later, so the only record keeps its place.
    assert_eq!(updated.order, 1);
    assert!(matches!(
        file.update_record(table.id, record.id, &values(json!({"title": " "})), None),
        Err(KitableError::Invalid(_))
    ));

    let (history, total) = ok(file.list_record_history(table.id, record.id, 0, 0));
    assert_eq!(total, 2);
    assert_eq!(history[0].action, "update");
    assert_eq!(history[0].before, json!("todo"));
    assert_eq!(history[0].after, json!("done"));
    assert_eq!(history[1].action, "create");

    ok(file.delete_record(table.id, record.id));
    assert!(matches!(
        file.get_record(table.id, record.id),
        Err(KitableError::NotFound)
    ));
    assert!(matches!(
        file.delete_record(table.id, record.id),
        Err(KitableError::NotFound)
    ));
    let (history, total) = ok(file.list_record_history(table.id, record.id, 1, 0));
    assert_eq!((history.len(), total), (1, 3));
    assert_eq!(history[0].action, "delete");

    let kept = ok(file.create_record(table.id, &values(json!({"title": "Persist"}))));
    file.close();
    let reopened = ok(KitableFile::open(&path));
    let records: Vec<Record> = ok(reopened.list_records(table.id));
    assert_eq!(
        records.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![kept.id]
    );
    assert_eq!(ok(reopened.count_records(table.id)), 1);
}

#[test]
fn keyset_pagination_on_position() {
    let dir = temp();
    let (_, mut file) = create(dir.path(), "p.kitable");
    let table = ok(file.create_table(&TableSpec::default()));
    for title in ["a", "b", "c"] {
        ok(file.create_record(table.id, &values(json!({"title": title}))));
    }
    let page = ok(file.list_records_page(table.id, 2, 1));
    assert_eq!(
        page.iter()
            .map(|r| r.values["title"].clone())
            .collect::<Vec<_>>(),
        vec![json!("b"), json!("c")]
    );
}

#[test]
fn update_and_delete_schema() {
    let dir = temp();
    let (_, mut file) = create(dir.path(), "s.kitable");
    let table = ok(file.create_table(&TableSpec {
        fields: vec![primary("name"), field("notes", "long_text")],
        ..Default::default()
    }));
    let notes = table.fields[1].clone();

    let renamed = ok(file.update_table(
        table.id,
        &TablePatch {
            title: Some("  Renamed ".into()),
            description: Some("d".into()),
            meta: Some(json!({"k": 1})),
            primary_field_id: Some(notes.id),
        },
    ));
    assert_eq!(renamed.title, "Renamed");
    assert_eq!(renamed.primary_field_id, Some(notes.id));
    assert!(
        renamed
            .fields
            .iter()
            .find(|f| f.id == notes.id)
            .is_some_and(|f| f.is_primary)
    );
    assert!(matches!(
        file.update_table(
            table.id,
            &TablePatch {
                primary_field_id: Some(9999),
                ..Default::default()
            }
        ),
        Err(KitableError::NotFound)
    ));

    let formula = ok(file.update_field(
        table.id,
        table.fields[0].id,
        &FieldPatch {
            field_type: Some("formula".into()),
            formula: Some("1+1".into()),
            ..Default::default()
        },
    ));
    assert!(formula.readonly);
    assert!(matches!(
        file.update_field(
            table.id,
            notes.id,
            &FieldPatch {
                is_primary: Some(false),
                ..Default::default()
            }
        ),
        Err(KitableError::Invalid(_))
    ));
    assert!(matches!(
        file.update_field(
            table.id,
            notes.id,
            &FieldPatch {
                field_type: Some("bogus".into()),
                ..Default::default()
            }
        ),
        Err(KitableError::Invalid(_))
    ));
    assert!(matches!(
        file.delete_field(table.id, notes.id),
        Err(KitableError::Invalid(_))
    ));
    ok(file.delete_field(table.id, table.fields[0].id));
    assert_eq!(ok(file.get_table(table.id)).fields.len(), 1);

    let view = table.views[0].clone();
    let changed = ok(file.update_view(
        table.id,
        view.id,
        &ViewPatch {
            title: Some("Grid".into()),
            view_type: Some("gallery".into()),
            config: Some(json!("{\"a\":1}")),
        },
    ));
    assert_eq!(
        (changed.title.as_str(), changed.view_type.as_str()),
        ("Grid", "gallery")
    );
    assert_eq!(changed.config, values(json!({"a": 1})));
    assert!(matches!(
        file.update_view(
            table.id,
            view.id,
            &ViewPatch {
                view_type: Some("pie".into()),
                ..Default::default()
            }
        ),
        Err(KitableError::Invalid(_))
    ));
    ok(file.delete_view(table.id, view.id));
    assert!(matches!(
        file.delete_view(table.id, view.id),
        Err(KitableError::NotFound)
    ));

    ok(file.delete_table(table.id));
    assert!(matches!(
        file.get_table(table.id),
        Err(KitableError::NotFound)
    ));
    assert!(ok(file.list_tables()).is_empty());
}

#[test]
fn update_view_with_the_config_it_reads_writes_nothing() {
    let dir = temp();
    let (_, mut file) = create(dir.path(), "v.kitable");
    let table = ok(file.create_table(&TableSpec {
        fields: vec![primary("name")],
        ..Default::default()
    }));
    let view = ok(file.create_view(table.id, &ViewSpec::default()));
    assert_eq!(
        view.config,
        Map::new(),
        "a view without a config reads as {{}}"
    );
    let version = file.replica_version();
    let undoable = file.can_undo();

    // What an editor that only opened the view sends back: what it read, or nothing.
    for config in [json!({}), json!("{}"), json!(view.config.clone())] {
        let same = ok(file.update_view(
            table.id,
            view.id,
            &ViewPatch {
                title: Some(view.title.clone()),
                config: Some(config),
                ..Default::default()
            },
        ));
        assert_eq!(same.config, Map::new());
        assert_eq!(file.replica_version(), version, "no change is written");
        assert_eq!(file.can_undo(), undoable);
    }

    // A real change still writes.
    let changed = ok(file.update_view(
        table.id,
        view.id,
        &ViewPatch {
            config: Some(json!({ "row_height": "tall" })),
            ..Default::default()
        },
    ));
    assert_eq!(changed.config, values(json!({ "row_height": "tall" })));
    assert_ne!(file.replica_version(), version);
}

#[test]
fn create_field_at_order_and_duplicate() {
    let dir = temp();
    let (_, mut file) = create(dir.path(), "f.kitable");
    let table = ok(file.create_table(&TableSpec {
        fields: vec![primary("a"), field("b", "text"), field("c", "text")],
        ..Default::default()
    }));
    let inserted = ok(file.create_field(
        table.id,
        &FieldSpec {
            order: Some(2),
            ..field("x", "number")
        },
    ));
    assert_eq!(inserted.order, 2);
    let names: Vec<String> = ok(file.list_fields(table.id))
        .into_iter()
        .map(|f| f.name)
        .collect();
    assert_eq!(names, ["a", "x", "b", "c"]);

    let copy = ok(file.duplicate_field(table.id, table.fields[0].id));
    assert_eq!(copy.title, "a copy");
    assert_eq!(copy.name, "a_copy");
    assert!(!copy.is_primary);
    let names: Vec<String> = ok(file.list_fields(table.id))
        .into_iter()
        .map(|f| f.name)
        .collect();
    assert_eq!(names, ["a", "a_copy", "x", "b", "c"]);
}

#[test]
fn attachments() {
    let dir = temp();
    let (_, file) = create(dir.path(), "a.kitable");
    assert!(file.add_attachment(&AttachmentSpec::default()).is_err());
    let attachment = ok(file.add_attachment(&AttachmentSpec {
        path: ".kition/assets/x.png".into(),
        mime_type: " image/png ".into(),
        size: 3,
        meta: json!({"w": 1}),
        ..Default::default()
    }));
    assert_eq!(attachment.name, "attachment");
    assert_eq!(attachment.mime_type, "image/png");
    assert_eq!(attachment.document_id, ok(file.info()).document_id);
}

struct Linked {
    file: KitableFile,
    tasks: i64,
    link: i64,
    projects: Vec<Record>,
    _dir: tempfile::TempDir,
}

fn linked() -> Linked {
    let dir = temp();
    let (_, mut file) = create(dir.path(), "links.kitable");
    let projects = ok(file.create_table(&TableSpec {
        title: "Projects".into(),
        fields: vec![primary("name"), field("budget", "number")],
        ..Default::default()
    }));
    let tasks = ok(file.create_table(&TableSpec {
        title: "Tasks".into(),
        fields: vec![primary("title")],
        ..Default::default()
    }));
    let link = ok(file.create_field(
        tasks.id,
        &FieldSpec {
            options: json!({"target_table_id": projects.id, "allow_multiple": true}),
            ..field("project", "link_to_record")
        },
    ));
    ok(file.create_field(tasks.id, &FieldSpec {
        options: json!({"link_field_id": link.id, "target_field_id": projects.fields[0].id, "multi_value_mode": "concat"}),
        ..field("project_name", "lookup")
    }));
    ok(file.create_field(tasks.id, &FieldSpec {
        options: json!({"link_field_id": link.id, "target_field_id": projects.fields[1].id, "aggregation": "sum"}),
        ..field("budget_sum", "rollup")
    }));
    let records = vec![
        ok(file.create_record(
            projects.id,
            &values(json!({"name": "Alpha", "budget": 100.0})),
        )),
        ok(file.create_record(projects.id, &values(json!({"name": "Beta", "budget": 250})))),
    ];
    Linked {
        file,
        tasks: tasks.id,
        link: link.id,
        projects: records,
        _dir: dir,
    }
}

#[test]
fn links_lookups_and_rollups() {
    let Linked {
        mut file,
        tasks,
        link,
        projects,
        _dir,
    } = linked();
    let task = ok(file.create_record(tasks, &values(json!({"title": "Build"}))));
    assert_eq!(task.values.get("budget_sum"), Some(&json!(0)));
    assert_eq!(task.values.get("project_name"), Some(&json!("")));

    let keys = vec![
        projects[0].row_key.clone(),
        projects[1].row_key.clone(),
        projects[0].row_key.clone(),
    ];
    let refs = ok(file.replace_record_links(tasks, task.id, link, &keys));
    assert_eq!(
        refs.iter().map(|r| r.display.as_str()).collect::<Vec<_>>(),
        ["Alpha", "Beta"]
    );
    let record = ok(file.get_record(tasks, task.id));
    assert_eq!(record.values["project_name"], "Alpha, Beta");
    assert_eq!(record.values["budget_sum"], json!(350));
    assert_eq!(record.values["project"][1]["display"], "Beta");
    assert_eq!(ok(file.list_record_links(tasks, task.id, link)).len(), 2);

    ok(file.delete_record_links(tasks, task.id, link, &[projects[0].row_key.clone()]));
    let record = ok(file.get_record(tasks, task.id));
    assert_eq!(record.values["project_name"], "Beta");
    assert_eq!(record.values["budget_sum"], json!(250));

    let candidates = ok(file.list_link_candidates(link, "alp", 0));
    assert_eq!(
        candidates
            .iter()
            .map(|c| c.display.as_str())
            .collect::<Vec<_>>(),
        ["Alpha"]
    );
    assert_eq!(ok(file.list_link_candidates(link, "", 1)).len(), 1);

    // Deleting a linked record refreshes the records that pointed at it.
    let projects_table = projects[1].table_id;
    ok(file.delete_record(projects_table, projects[1].id));
    let record = ok(file.get_record(tasks, task.id));
    assert_eq!(record.values["budget_sum"], json!(0));
    assert_eq!(record.values["project_name"], "");

    assert!(
        file.replace_record_links(tasks, task.id, link, &["missing".into()])
            .is_err()
    );
}

#[test]
fn single_link_fields_reject_multiple_targets() {
    let Linked {
        mut file,
        tasks,
        projects,
        _dir,
        ..
    } = linked();
    let single = ok(file.create_field(
        tasks,
        &FieldSpec {
            options: json!({"target_table_id": projects[0].table_id, "allow_multiple": false}),
            ..field("owner", "link_to_record")
        },
    ));
    let task = ok(file.create_record(tasks, &values(json!({"title": "T"}))));
    let keys = vec![projects[0].row_key.clone(), projects[1].row_key.clone()];
    assert!(matches!(
        file.replace_record_links(tasks, task.id, single.id, &keys),
        Err(KitableError::Invalid(_))
    ));
}

#[test]
fn formulas_evaluate_on_write() {
    let dir = temp();
    let (_, mut file) = create(dir.path(), "formula.kitable");
    let table = ok(file.create_table(&TableSpec {
        fields: vec![
            primary("name"),
            field("qty", "number"),
            field("price", "number"),
            FieldSpec {
                formula: "{qty} * {price}".into(),
                ..field("total", "formula")
            },
            FieldSpec {
                formula: "upper({name}) + ' x' + {qty}".into(),
                ..field("label", "formula")
            },
            FieldSpec {
                formula: "{qty} / 0".into(),
                ..field("broken", "formula")
            },
        ],
        ..Default::default()
    }));
    let record = ok(file.create_record(
        table.id,
        &values(json!({"name": "pen", "qty": 3, "price": 1.5})),
    ));
    assert_eq!(record.values["total"], json!(4.5));
    assert_eq!(record.values["label"], "PEN x3");
    assert_eq!(record.values["broken"], "#ERROR: division by zero");
    let record = ok(file.update_record(table.id, record.id, &values(json!({"qty": 4})), None));
    assert_eq!(record.values["total"], json!(6));
}

#[test]
fn bulk_delete_and_copy() {
    let dir = temp();
    let (_, mut file) = create(dir.path(), "bulk.kitable");
    let table = ok(file.create_table(&TableSpec::default()));
    let records: Vec<Record> = ["a", "b", "c"]
        .into_iter()
        .map(|title| ok(file.create_record(table.id, &values(json!({"title": title})))))
        .collect();

    let copied = ok(file.bulk_copy_records(
        table.id,
        &[records[2].row_key.clone(), records[0].row_key.clone()],
        2,
    ));
    assert_eq!(copied.copied_count, 2);
    let order: Vec<Value> = ok(file.list_records(table.id))
        .into_iter()
        .map(|r| r.values["title"].clone())
        .collect();
    assert_eq!(
        order,
        [json!("a"), json!("c"), json!("a"), json!("b"), json!("c")]
    );
    let appended = ok(file.bulk_copy_records(table.id, &[records[1].row_key.clone()], 0));
    let last = ok(file.list_records(table.id)).pop();
    assert_eq!(
        last.map(|r| r.row_key),
        appended.new_row_keys.first().cloned()
    );

    let deleted = ok(file.bulk_delete_records(
        table.id,
        &[records[0].row_key.clone(), " ".into(), "nope".into()],
    ));
    assert_eq!(deleted.deleted_count, 1);
    assert_eq!(deleted.missing_keys, ["nope"]);
    assert_eq!(ok(file.bulk_delete_records(table.id, &[])).deleted_count, 0);
    assert!(file.bulk_delete_records(0, &["x".into()]).is_err());
}

#[test]
fn view_configuration() {
    let dir = temp();
    let (_, mut file) = create(dir.path(), "views.kitable");
    let table = ok(file.create_table(&TableSpec {
        fields: vec![primary("name"), field("n", "number")],
        ..Default::default()
    }));
    let view = table.views[0].id;
    let name = table.fields[0].id;
    let n = table.fields[1].id;

    assert_eq!(ok(file.load_filter_tree(view)), None);
    let tree = FilterTree {
        conjunction: "OR".into(),
        children: vec![
            FilterTreeChild {
                group: None,
                condition: Some(FilterRule {
                    field_id: name,
                    operator: "contains".into(),
                    value: json!("a"),
                }),
            },
            FilterTreeChild {
                group: Some(Box::new(FilterTree {
                    conjunction: "and".into(),
                    children: vec![FilterTreeChild {
                        group: None,
                        condition: Some(FilterRule {
                            field_id: n,
                            operator: ">".into(),
                            value: json!(3),
                        }),
                    }],
                })),
                condition: None,
            },
        ],
    };
    ok(file.save_filter_tree(view, Some(&tree)));
    let loaded = ok(file.load_filter_tree(view)).unwrap_or_default();
    assert_eq!(loaded.conjunction, "or");
    assert_eq!(loaded.children.len(), 2);
    assert_eq!(
        loaded.children[1].group.as_ref().map(|g| g.children.len()),
        Some(1)
    );
    ok(file.save_filter_tree(view, None));
    assert_eq!(ok(file.load_filter_tree(view)), None);
    let invalid = FilterTree {
        conjunction: "and".into(),
        children: vec![FilterTreeChild::default()],
    };
    assert!(matches!(
        file.save_filter_tree(view, Some(&invalid)),
        Err(KitableError::InvalidFilterTree(_))
    ));

    ok(file.replace_view_sorts(
        view,
        &[
            ViewSort {
                field_id: n,
                direction: "DESC".into(),
            },
            ViewSort {
                field_id: name,
                direction: String::new(),
            },
        ],
    ));
    let sorts = ok(file.list_view_sorts(view));
    assert_eq!(
        sorts
            .iter()
            .map(|s| s.direction.as_str())
            .collect::<Vec<_>>(),
        ["desc", "asc"]
    );
    assert!(
        file.replace_view_sorts(
            view,
            &[ViewSort {
                field_id: n,
                direction: "up".into()
            }]
        )
        .is_err()
    );
    assert!(
        file.replace_view_groups(
            view,
            &[ViewSort {
                field_id: 0,
                direction: "asc".into()
            }]
        )
        .is_err()
    );
    ok(file.replace_view_groups(
        view,
        &[ViewSort {
            field_id: name,
            direction: "asc".into(),
        }],
    ));
    assert_eq!(ok(file.list_view_groups(view)).len(), 1);
    assert!(matches!(
        file.list_view_sorts(9999),
        Err(KitableError::NotFound)
    ));

    let created = ok(file.upsert_view_field(
        view,
        n,
        &ViewFieldPatch {
            width: Some(10),
            ..Default::default()
        },
    ));
    assert_eq!((created.width, created.visible), (40, true));
    let updated = ok(file.upsert_view_field(
        view,
        n,
        &ViewFieldPatch {
            visible: Some(false),
            width: Some(5000),
            ..Default::default()
        },
    ));
    assert_eq!((updated.width, updated.visible), (1200, false));
    assert_eq!(ok(file.list_view_fields(view)).len(), 1);
    assert!(matches!(
        file.upsert_view_field(view, 9999, &ViewFieldPatch::default()),
        Err(KitableError::NotFound)
    ));
}

#[test]
fn dashboards_round_trip_through_the_relational_api() {
    let dir = temp();
    let (_, mut file) = create(dir.path(), "dashboards.kitable");
    let table = ok(file.create_table(&TableSpec {
        fields: vec![primary("name")],
        ..Default::default()
    }));

    assert_eq!(ok(file.list_dashboards()), Vec::new());

    let widgets = values(json!({ "w1": { "kind": "chart", "title": "Sales" } }));
    let created = ok(file.upsert_dashboard(
        None,
        "Overview",
        json!({ "source_table_id": table.id, "layout": [] }),
        &widgets,
    ));
    assert_eq!(created.name, "Overview");
    assert_eq!(created.config["source_table_id"], json!(table.id));
    assert!(created.config.get("source_table").is_none());
    assert_eq!(created.widgets, widgets);

    let listed = ok(file.list_dashboards());
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, created.id);

    let renamed = ok(file.upsert_dashboard(
        Some(&created.id),
        "Overview 2",
        json!({ "source_table_id": table.id }),
        &Map::new(),
    ));
    assert_eq!(renamed.id, created.id);
    assert_eq!(renamed.name, "Overview 2");
    assert_eq!(
        renamed.widgets,
        Map::new(),
        "an empty widgets map clears it"
    );

    ok(file.delete_dashboard(&created.id));
    assert_eq!(ok(file.list_dashboards()), Vec::new());
    assert!(matches!(
        file.delete_dashboard(&created.id),
        Err(KitableError::NotFound)
    ));
}

#[test]
fn import_dashboards_moves_legacy_dashboards_in_as_one_transaction() {
    let dir = temp();
    let (_, mut file) = create(dir.path(), "import-dashboards.kitable");
    let table = ok(file.create_table(&TableSpec {
        fields: vec![primary("name")],
        ..Default::default()
    }));

    ok(file.import_dashboards(&[
        (
            "legacy-a".into(),
            "Legacy A".into(),
            json!({ "source_table_id": table.id, "order": 0 }),
            values(json!({ "w1": { "id": "w1", "type": "metric" } })),
        ),
        (
            "legacy-b".into(),
            "Legacy B".into(),
            json!({ "source_table_id": table.id, "order": 1 }),
            Map::new(),
        ),
    ]));

    let mut listed = ok(file.list_dashboards());
    listed.sort_by(|a, b| a.id.cmp(&b.id));
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id, "legacy-a");
    assert_eq!(listed[0].name, "Legacy A");
    assert_eq!(listed[0].config["source_table_id"], json!(table.id));
    assert_eq!(listed[1].id, "legacy-b");
    assert!(
        !file.can_undo(),
        "import_dashboards keeps the file's own origin"
    );
}
