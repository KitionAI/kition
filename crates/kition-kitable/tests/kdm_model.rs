//! The `kit.table` model on the KDM: typed writes, reads, convergence, and repair.

use std::collections::BTreeSet;
use std::fmt::Display;

use kition_kdm::testing::{Network, Rng};
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Tx};
use kition_kitable::kdm::model::{self, Anchor, BaseSpec, TableIds};
use kition_kitable::kdm::options::{IdKind, options_from_kdm, options_to_kdm};
use kition_kitable::kdm::read::{FieldData, ModelView};
use kition_kitable::kdm::{repair, schema};
use kition_kitable::{
    FIELD_TYPES, FieldPatch, FieldSpec, KitableError, TablePatch, TableSpec, VIEW_TYPES, ViewPatch,
    ViewSpec,
};
use serde_json::{Map, Value, json};

fn ok<T, E: Display>(result: Result<T, E>) -> T {
    result.unwrap_or_else(|err| panic!("unexpected error: {err}"))
}

fn person() -> Origin {
    Origin::person("user:test")
}

fn object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn new_replica() -> Replica {
    ok(Replica::create(
        schema(),
        DocId::new(),
        ok(ActorId::from_u64(1)),
    ))
}

fn write<R>(replica: &mut Replica, f: impl FnOnce(&mut Tx<'_>) -> kition_kitable::Result<R>) -> R {
    ok(model::transact(replica, &person(), f))
}

fn base_in(replica: &mut Replica) -> ObjectId {
    write(replica, |tx| {
        model::create_base(
            tx,
            &BaseSpec {
                title: "Base".into(),
                ..BaseSpec::default()
            },
        )
    })
}

fn field(title: &str, field_type: &str) -> FieldSpec {
    FieldSpec {
        title: title.into(),
        field_type: field_type.into(),
        ..FieldSpec::default()
    }
}

fn view(title: &str, view_type: &str) -> ViewSpec {
    ViewSpec {
        title: title.into(),
        view_type: view_type.into(),
        config: Value::Null,
    }
}

fn table_with(replica: &mut Replica, base: &ObjectId, spec: &TableSpec) -> TableIds {
    write(replica, |tx| model::create_table(tx, base, spec, None))
}

/// A table with a primary "Name" text field, a "Notes" text field, and a grid view.
fn simple_table(replica: &mut Replica, base: &ObjectId, title: &str) -> TableIds {
    let spec = TableSpec {
        title: title.into(),
        fields: vec![
            FieldSpec {
                primary: true,
                ..field("Name", "text")
            },
            field("Notes", "text"),
        ],
        views: vec![view("Grid", "grid")],
        ..TableSpec::default()
    };
    table_with(replica, base, &spec)
}

fn records(replica: &mut Replica, table: &ObjectId, rows: Vec<Value>) -> Vec<ObjectId> {
    let rows: Vec<Map<String, Value>> = rows.into_iter().map(object).collect();
    write(replica, |tx| {
        model::create_records(tx, table, None, &rows, 1_000, "user:test")
    })
}

fn by_name<'a>(fields: &'a [FieldData], name: &str) -> &'a FieldData {
    fields
        .iter()
        .find(|field| field.name == name)
        .unwrap_or_else(|| panic!("no field named {name}"))
}

fn nth(ids: &[ObjectId], index: usize) -> ObjectId {
    ids.get(index)
        .cloned()
        .unwrap_or_else(|| panic!("no item {index} in {ids:?}"))
}

fn repair_now(replica: &mut Replica) -> bool {
    let changed = replica.take_changed();
    ok(repair::run(replica, &changed))
}

// ---------------------------------------------------------------------------
// Schema and single-replica behavior.

#[test]
fn the_schema_parses_and_names_the_kit() {
    let schema = schema();
    assert_eq!(schema.kit, "kit.table");
    assert_eq!(schema.root, "Base");
    for ty in [
        "Base",
        "Table",
        "Field",
        "View",
        "Record",
        "Link",
        "Dashboard",
    ] {
        assert!(schema.types.contains_key(ty), "{ty} is declared");
    }
}

#[test]
fn computed_field_types_are_exactly_the_derived_ones() {
    let computed: Vec<&str> = FIELD_TYPES
        .iter()
        .copied()
        .filter(|ty| model::is_computed(ty))
        .collect();
    assert_eq!(
        computed,
        vec![
            "formula",
            "link_to_record",
            "lookup",
            "rollup",
            "created_time",
            "last_modified_time",
            "created_by",
            "last_modified_by",
            "auto_number",
        ]
    );
    assert!(!model::is_computed("ai"));
    assert!(!model::is_computed("attachment"));
}

#[test]
fn an_empty_table_spec_seeds_a_title_field_and_an_all_view() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let ids = table_with(
        &mut replica,
        &base,
        &TableSpec {
            title: "Tasks".into(),
            ..TableSpec::default()
        },
    );
    let view = ModelView::new(&replica);
    assert_eq!(view.base(), Some(base.clone()));
    assert_eq!(ok(view.tables()), vec![ids.table.clone()]);
    let table = ok(view.table(&ids.table));
    assert_eq!(table.name, "tasks");
    assert_eq!(table.title, "Tasks");
    let fields = ok(view.fields(&ids.table));
    assert_eq!(fields.len(), 1);
    let title = by_name(&fields, "title");
    assert_eq!(
        (
            title.title.as_str(),
            title.field_type.as_str(),
            title.required
        ),
        ("Title", "text", true)
    );
    assert_eq!(table.primary_field, Some(title.id.clone()));
    assert_eq!(ids.fields, vec![title.id.clone()]);
    let views = ok(view.views(&ids.table));
    assert_eq!(views.len(), 1);
    let all = views.first().unwrap_or_else(|| panic!("a view"));
    assert_eq!(
        (all.title.as_str(), all.view_type.as_str()),
        ("All", "grid")
    );
    assert!(!all.locked);
    assert_eq!(ids.views, vec![all.id.clone()]);
}

#[test]
fn every_field_type_and_view_type_round_trips() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let fields: Vec<FieldSpec> = FIELD_TYPES
        .iter()
        .enumerate()
        .map(|(index, ty)| FieldSpec {
            name: format!("f_{ty}"),
            title: format!("Field {ty}"),
            field_type: (*ty).into(),
            primary: index == 0,
            required: index % 3 == 0,
            readonly: index % 4 == 0,
            options: json!({ "index": index, "choices": ["A", "B"] }),
            formula: if *ty == "formula" {
                "{f_number} * 2".into()
            } else {
                String::new()
            },
            ai_prompt: if *ty == "ai" {
                "Summarize {f_text}".into()
            } else {
                String::new()
            },
            meta: json!({ "hint": ty }),
            order: None,
        })
        .collect();
    let views: Vec<ViewSpec> = VIEW_TYPES
        .iter()
        .map(|ty| ViewSpec {
            title: format!("View {ty}"),
            view_type: (*ty).into(),
            config: json!({ "sorts": [{ "field": "f_text", "desc": true }] }),
        })
        .collect();
    let ids = table_with(
        &mut replica,
        &base,
        &TableSpec {
            name: "all_types".into(),
            title: "All types".into(),
            description: "Every type".into(),
            fields: fields.clone(),
            views: views.clone(),
            meta: json!({ "color": "blue" }),
        },
    );
    let read = ModelView::new(&replica);
    let table = ok(read.table(&ids.table));
    assert_eq!(
        (table.name.as_str(), table.description.as_str()),
        ("all_types", "Every type")
    );
    assert_eq!(table.meta, json!({ "color": "blue" }));
    let stored = ok(read.fields(&ids.table));
    assert_eq!(stored.len(), FIELD_TYPES.len());
    assert_eq!(
        stored
            .iter()
            .map(|field| field.id.clone())
            .collect::<Vec<_>>(),
        ids.fields
    );
    for (spec, field) in fields.iter().zip(&stored) {
        assert_eq!(field.name, spec.name);
        assert_eq!(field.title, spec.title);
        assert_eq!(field.field_type, spec.field_type);
        assert_eq!(field.required, spec.required);
        let forced = spec.field_type == "formula" || spec.field_type == "ai";
        assert_eq!(
            field.readonly,
            spec.readonly || forced,
            "{}",
            spec.field_type
        );
        assert_eq!(field.options, spec.options);
        assert_eq!(field.formula, spec.formula);
        assert_eq!(field.ai_prompt, spec.ai_prompt);
        assert_eq!(field.meta, spec.meta);
    }
    assert_eq!(table.primary_field, Some(nth(&ids.fields, 0)));
    let stored_views = ok(read.views(&ids.table));
    assert_eq!(stored_views.len(), VIEW_TYPES.len());
    for (spec, view) in views.iter().zip(&stored_views) {
        assert_eq!(view.title, spec.title);
        assert_eq!(view.view_type, spec.view_type);
        assert_eq!(view.config, spec.config);
        assert!(view.widths.is_empty() && view.hidden.is_empty());
    }

    // One record with a value for every field: computed types are never stored.
    let mut row = Map::new();
    for (field, spec) in stored.iter().zip(&fields) {
        let value = match spec.field_type.as_str() {
            "number" | "rating" => json!(4),
            "checkbox" => json!(true),
            "multi_select" => json!(["A", "B"]),
            "attachment" => json!([{ "name": "a.png", "url": "kition://a.png", "sizeBytes": 3 }]),
            "user" => json!([{ "id": "u1", "name": "Ann" }]),
            other => json!(format!("value of {other}")),
        };
        row.insert(field.id.to_string(), value);
    }
    let created = write(&mut replica, |tx| {
        model::create_records(
            tx,
            &ids.table,
            None,
            std::slice::from_ref(&row),
            42,
            "user:ann",
        )
    });
    let record = nth(&created, 0);
    assert_eq!(record.as_str().len(), 36, "a record id is a UUID row key");
    let read = ModelView::new(&replica);
    let expected: Map<String, Value> = row
        .iter()
        .filter(|(key, _)| {
            let field = stored
                .iter()
                .find(|field| field.id.as_str() == key.as_str())
                .unwrap_or_else(|| panic!("field {key}"));
            !model::is_computed(&field.field_type)
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    assert_eq!(expected.len(), FIELD_TYPES.len() - 9);
    assert_eq!(ok(read.cells(&record)), expected);
    let data = ok(read.record(&record));
    assert_eq!(
        (data.created_at, data.created_by.as_str()),
        (42, "user:ann")
    );
    assert_eq!(data.cells, expected);
    assert_eq!(ok(read.record_ids(&ids.table)), vec![record.clone()]);
    let all = ok(read.records(&ids.table));
    assert_eq!(all.len(), 1);
    assert_eq!(all.first().map(|data| data.cells.clone()), Some(expected));
}

#[test]
fn template_shapes_round_trip() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let companies = simple_table(&mut replica, &base, "Companies");
    let ai_config = json!({
        "type": "image_customization",
        "sourceFieldTitle": "Face Photo",
        "prompt": "Make a cover",
        "enabled": true,
        "auto_update": true,
        "n": 2,
        "quality": "high",
        "aspect_ratio": "16:9",
    });
    let fields = vec![
        FieldSpec {
            primary: true,
            ..field("Company", "text")
        },
        FieldSpec {
            options: json!({ "choices": ["1–10", "11–50", "51–200"] }),
            ..field("Company size", "single_select")
        },
        FieldSpec {
            options: json!({ "choices": ["CRM", "Operations"] }),
            ..field("Use case", "multi_select")
        },
        FieldSpec {
            name: "thumbnail_16_9".into(),
            options: json!({ "description": "Two variants", "ai_config": ai_config }),
            ..field("Thumbnail (16:9)", "attachment")
        },
        FieldSpec {
            options: json!({ "date_format": "year_month_day_dash" }),
            ..field("Start Date", "date")
        },
        FieldSpec {
            options: json!({ "target_table": companies.table.as_str(), "allow_multiple": true }),
            ..field("Parent", "link_to_record")
        },
        FieldSpec {
            options: json!({ "max": 5, "icon": "star" }),
            ..field("Score", "rating")
        },
        FieldSpec {
            options: json!({ "label": "Open", "action": { "kind": "open_url", "url": "https://example.com" } }),
            ..field("Open", "button")
        },
    ];
    let views = vec![
        view("Lead form", "form"),
        view("Grid", "grid"),
        ViewSpec {
            config: json!({ "group_by": "company_size", "card_fields": ["company"] }),
            ..view("Pipeline", "kanban")
        },
        ViewSpec {
            config: json!({ "date_field": "start_date" }),
            ..view("Calendar", "calendar")
        },
        view("Gallery", "gallery"),
    ];
    let leads = table_with(
        &mut replica,
        &base,
        &TableSpec {
            title: "Leads".into(),
            fields: fields.clone(),
            views: views.clone(),
            ..TableSpec::default()
        },
    );
    let read = ModelView::new(&replica);
    let stored = ok(read.fields(&leads.table));
    let names: Vec<&str> = stored.iter().map(|field| field.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "company",
            "company_size",
            "use_case",
            "thumbnail_16_9",
            "start_date",
            "parent",
            "score",
            "open"
        ]
    );
    for (spec, field) in fields.iter().zip(&stored) {
        assert_eq!(field.options, spec.options, "{}", spec.title);
    }
    let stored_views = ok(read.views(&leads.table));
    for (spec, view) in views.iter().zip(&stored_views) {
        assert_eq!(
            (&view.title, &view.view_type, &view.config),
            (&spec.title, &spec.view_type, &spec.config)
        );
    }
    assert_eq!(
        ok(read.field_by_name(&leads.table, "parent")),
        Some(by_name(&stored, "parent").id.clone())
    );
    assert_eq!(ok(read.field_by_name(&leads.table, "nope")), None);

    // Links between the two tables.
    let link_field = by_name(&stored, "parent").id.clone();
    let targets = records(
        &mut replica,
        &companies.table,
        vec![json!({}), json!({}), json!({})],
    );
    let lead = nth(&records(&mut replica, &leads.table, vec![json!({})]), 0);
    write(&mut replica, |tx| {
        model::replace_links(
            tx,
            &lead,
            &link_field,
            &[nth(&targets, 2), nth(&targets, 0)],
        )
    });
    let read = ModelView::new(&replica);
    assert_eq!(
        ok(read.links_from(&lead, &link_field)),
        vec![nth(&targets, 2), nth(&targets, 0)]
    );
    assert_eq!(
        ok(read.links_to(&nth(&targets, 0))),
        vec![(lead.clone(), link_field.clone())]
    );
    assert!(ok(read.links_to(&nth(&targets, 1))).is_empty());
    assert_eq!(ok(read.links()).len(), 2);
}

#[test]
fn field_names_are_unique_within_a_table_and_order_inserts() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let ids = simple_table(&mut replica, &base, "T");
    let (a, b, c) = write(&mut replica, |tx| {
        let a = model::create_field(tx, &ids.table, &field("Status", "single_select"))?;
        let b = model::create_field(tx, &ids.table, &field("Status", "text"))?;
        let c = model::create_field(
            tx,
            &ids.table,
            &FieldSpec {
                order: Some(1),
                ..field("First", "text")
            },
        )?;
        Ok((a, b, c))
    });
    let read = ModelView::new(&replica);
    let fields = ok(read.fields(&ids.table));
    let order: Vec<(String, ObjectId)> = fields
        .iter()
        .map(|field| (field.name.clone(), field.id.clone()))
        .collect();
    assert_eq!(
        order,
        vec![
            ("first".to_owned(), c),
            ("name".to_owned(), nth(&ids.fields, 0)),
            ("notes".to_owned(), nth(&ids.fields, 1)),
            ("status".to_owned(), a),
            ("status_2".to_owned(), b),
        ]
    );
    // A second table may reuse a table name only with a suffix.
    let again = simple_table(&mut replica, &base, "T");
    assert_eq!(ok(ModelView::new(&replica).table(&again.table)).name, "t_2");
}

#[test]
fn updates_patch_tables_fields_and_views() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let ids = simple_table(&mut replica, &base, "T");
    let name = nth(&ids.fields, 0);
    let notes = nth(&ids.fields, 1);
    let grid = nth(&ids.views, 0);
    write(&mut replica, |tx| {
        model::update_table(
            tx,
            &ids.table,
            &TablePatch {
                title: Some("  Renamed ".into()),
                description: Some("About".into()),
                meta: Some(json!({ "k": 1 })),
                primary_field_id: None,
            },
            Some(&notes),
        )?;
        model::update_field(
            tx,
            &notes,
            &FieldPatch {
                title: Some("Summary".into()),
                field_type: Some("formula".into()),
                formula: Some("{name}".into()),
                options: Some(json!({ "precision": 2 })),
                ..FieldPatch::default()
            },
        )?;
        model::update_view(
            tx,
            &grid,
            &ViewPatch {
                title: Some("Board".into()),
                view_type: Some("kanban".into()),
                config: Some(json!({ "group_by": "name" })),
            },
        )?;
        model::set_view_width(tx, &grid, &name, 5)?;
        model::set_view_width(tx, &grid, &notes, 5000)?;
        model::set_view_hidden(tx, &grid, &notes, true)
    });
    let read = ModelView::new(&replica);
    let table = ok(read.table(&ids.table));
    assert_eq!(
        (table.title.as_str(), table.description.as_str()),
        ("Renamed", "About")
    );
    assert_eq!(table.meta, json!({ "k": 1 }));
    assert_eq!(table.primary_field, Some(notes.clone()));
    let summary = ok(read.field(&notes));
    assert_eq!(
        (
            summary.title.as_str(),
            summary.field_type.as_str(),
            summary.readonly,
            summary.name.as_str()
        ),
        ("Summary", "formula", true, "notes")
    );
    assert_eq!(summary.options, json!({ "precision": 2 }));
    let board = ok(read.view(&grid));
    assert_eq!(
        (board.title.as_str(), board.view_type.as_str()),
        ("Board", "kanban")
    );
    assert_eq!(board.config, json!({ "group_by": "name" }));
    assert_eq!(board.widths.get(&name), Some(&40));
    assert_eq!(board.widths.get(&notes), Some(&1200));
    assert_eq!(board.hidden.get(&notes), Some(&true));

    // Refusals: an unknown type, unsetting the primary field, a primary field of another table.
    let bad_type = model::transact(&mut replica, &person(), |tx| {
        model::update_field(
            tx,
            &name,
            &FieldPatch {
                field_type: Some("nope".into()),
                ..FieldPatch::default()
            },
        )
    });
    assert!(matches!(bad_type, Err(KitableError::Invalid(_))));
    let unset = model::transact(&mut replica, &person(), |tx| {
        model::update_field(
            tx,
            &notes,
            &FieldPatch {
                is_primary: Some(false),
                ..FieldPatch::default()
            },
        )
    });
    assert!(matches!(unset, Err(KitableError::Invalid(_))));
    let other = simple_table(&mut replica, &base, "Other");
    let foreign = model::transact(&mut replica, &person(), |tx| {
        model::update_table(
            tx,
            &ids.table,
            &TablePatch::default(),
            Some(&nth(&other.fields, 0)),
        )
    });
    assert!(matches!(foreign, Err(KitableError::NotFound)));
    // `is_primary` on a field moves the table's primary field.
    write(&mut replica, |tx| {
        model::update_field(
            tx,
            &name,
            &FieldPatch {
                is_primary: Some(true),
                ..FieldPatch::default()
            },
        )
    });
    assert_eq!(
        ok(ModelView::new(&replica).table(&ids.table)).primary_field,
        Some(name)
    );
}

#[test]
fn deleting_a_field_refuses_the_primary_and_hides_its_cells() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let ids = simple_table(&mut replica, &base, "T");
    let name = nth(&ids.fields, 0);
    let notes = nth(&ids.fields, 1);
    let record = nth(
        &records(
            &mut replica,
            &ids.table,
            vec![json!({ name.as_str(): "a", notes.as_str(): "b" })],
        ),
        0,
    );
    let refused = model::transact(&mut replica, &person(), |tx| {
        model::delete_field(tx, &ids.table, &name)
    });
    assert!(matches!(refused, Err(KitableError::Invalid(_))));
    write(&mut replica, |tx| {
        model::delete_field(tx, &ids.table, &notes)
    });
    let read = ModelView::new(&replica);
    assert_eq!(ok(read.fields(&ids.table)).len(), 1);
    assert_eq!(
        ok(read.cells(&record)),
        object(json!({ name.as_str(): "a" }))
    );
    // The stored cell stays, so a concurrent edit of it still merges.
    assert_eq!(
        ok(replica.map_get(&record, "cells", notes.as_str())),
        json!("b")
    );
}

#[test]
fn records_insert_at_anchors_and_move() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let ids = simple_table(&mut replica, &base, "T");
    let first = records(
        &mut replica,
        &ids.table,
        vec![json!({}), json!({}), json!({})],
    );
    let (a, b, c) = (nth(&first, 0), nth(&first, 1), nth(&first, 2));
    let before_b = write(&mut replica, |tx| {
        model::create_records(
            tx,
            &ids.table,
            Some(&Anchor::Before(b.clone())),
            &[Map::new()],
            1,
            "",
        )
    });
    let after_c = write(&mut replica, |tx| {
        model::create_records(
            tx,
            &ids.table,
            Some(&Anchor::After(c.clone())),
            &[Map::new(), Map::new()],
            1,
            "",
        )
    });
    let (x, y, z) = (nth(&before_b, 0), nth(&after_c, 0), nth(&after_c, 1));
    let list = |replica: &Replica| ok(ModelView::new(replica).record_ids(&ids.table));
    assert_eq!(
        list(&replica),
        vec![
            a.clone(),
            x.clone(),
            b.clone(),
            c.clone(),
            y.clone(),
            z.clone()
        ]
    );
    write(&mut replica, |tx| {
        model::move_records(tx, &ids.table, &[a.clone(), c.clone()], Some(&z))
    });
    assert_eq!(
        list(&replica),
        vec![
            x.clone(),
            b.clone(),
            y.clone(),
            a.clone(),
            c.clone(),
            z.clone()
        ]
    );
    write(&mut replica, |tx| {
        model::move_records(tx, &ids.table, std::slice::from_ref(&x), None)
    });
    assert_eq!(
        list(&replica),
        vec![
            b.clone(),
            y.clone(),
            a.clone(),
            c.clone(),
            z.clone(),
            x.clone()
        ]
    );
    // Fields move the same way, by target index among the rest.
    let extra = write(&mut replica, |tx| {
        model::create_field(tx, &ids.table, &field("Extra", "text"))
    });
    write(&mut replica, |tx| {
        model::move_fields(tx, &ids.table, std::slice::from_ref(&extra), 0)
    });
    let fields: Vec<ObjectId> = ok(ModelView::new(&replica).fields(&ids.table))
        .into_iter()
        .map(|field| field.id)
        .collect();
    assert_eq!(
        fields,
        vec![extra, nth(&ids.fields, 0), nth(&ids.fields, 1)]
    );
    let missing = model::transact(&mut replica, &person(), |tx| {
        model::create_records(
            tx,
            &ids.table,
            Some(&Anchor::After(ObjectId::new())),
            &[Map::new()],
            1,
            "",
        )
    });
    assert!(matches!(missing, Err(KitableError::NotFound)));
}

#[test]
fn set_cells_writes_only_what_differs() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let ids = table_with(
        &mut replica,
        &base,
        &TableSpec {
            title: "T".into(),
            fields: vec![
                field("Name", "text"),
                field("Count", "number"),
                field("Total", "formula"),
            ],
            ..TableSpec::default()
        },
    );
    let (name, count, total) = (
        nth(&ids.fields, 0),
        nth(&ids.fields, 1),
        nth(&ids.fields, 2),
    );
    let record = nth(&records(&mut replica, &ids.table, vec![json!({})]), 0);
    write(&mut replica, |tx| {
        model::set_cells(
            tx,
            &ids.table,
            &record,
            &object(
                json!({ name.as_str(): "a", count.as_str(): 2, total.as_str(): 9, "unknown": 1 }),
            ),
        )
    });
    assert_eq!(
        ok(ModelView::new(&replica).cells(&record)),
        object(json!({ name.as_str(): "a", count.as_str(): 2 }))
    );
    assert_eq!(
        ok(replica.map_get(&record, "cells", total.as_str())),
        Value::Null
    );
    // The same values (2.0 equals 2) write nothing at all.
    let version = replica.version();
    write(&mut replica, |tx| {
        model::set_cells(
            tx,
            &ids.table,
            &record,
            &object(json!({ name.as_str(): "a", count.as_str(): 2.0 })),
        )
    });
    assert_eq!(replica.version(), version);
    // Null clears.
    write(&mut replica, |tx| {
        model::set_cells(
            tx,
            &ids.table,
            &record,
            &object(json!({ name.as_str(): null })),
        )
    });
    assert_eq!(
        ok(ModelView::new(&replica).cells(&record)),
        object(json!({ count.as_str(): 2 }))
    );
}

#[test]
fn replace_links_changes_only_the_difference() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let ids = simple_table(&mut replica, &base, "T");
    let link = write(&mut replica, |tx| {
        model::create_field(tx, &ids.table, &field("Related", "link_to_record"))
    });
    let rows = records(
        &mut replica,
        &ids.table,
        vec![json!({}), json!({}), json!({}), json!({})],
    );
    let (from, a, b, c) = (nth(&rows, 0), nth(&rows, 1), nth(&rows, 2), nth(&rows, 3));
    write(&mut replica, |tx| {
        model::replace_links(tx, &from, &link, &[a.clone(), b.clone()])
    });
    let before: Vec<ObjectId> = ok(ModelView::new(&replica).links())
        .into_iter()
        .filter(|data| data.to == b)
        .map(|data| data.id)
        .collect();
    write(&mut replica, |tx| {
        model::replace_links(tx, &from, &link, &[b.clone(), c.clone(), b.clone()])
    });
    let read = ModelView::new(&replica);
    assert_eq!(
        ok(read.links_from(&from, &link)),
        vec![b.clone(), c.clone()]
    );
    let after: Vec<ObjectId> = ok(read.links())
        .into_iter()
        .filter(|data| data.to == b)
        .map(|data| data.id)
        .collect();
    assert_eq!(before, after, "the kept link object is the same");
    let version = replica.version();
    write(&mut replica, |tx| {
        model::replace_links(tx, &from, &link, &[b.clone(), c.clone()])
    });
    assert_eq!(replica.version(), version, "no difference, no change");
    let not_link = model::transact(&mut replica, &person(), |tx| {
        model::replace_links(tx, &from, &nth(&ids.fields, 0), std::slice::from_ref(&a))
    });
    assert!(matches!(not_link, Err(KitableError::Invalid(_))));
}

#[test]
fn deleting_records_and_tables_removes_their_links() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let one = simple_table(&mut replica, &base, "One");
    let two = simple_table(&mut replica, &base, "Two");
    let link = write(&mut replica, |tx| {
        model::create_field(tx, &one.table, &field("Two", "link_to_record"))
    });
    let from = records(&mut replica, &one.table, vec![json!({}), json!({})]);
    let to = records(&mut replica, &two.table, vec![json!({}), json!({})]);
    write(&mut replica, |tx| {
        model::replace_links(tx, &nth(&from, 0), &link, &to)?;
        model::replace_links(tx, &nth(&from, 1), &link, &to)
    });
    assert_eq!(ok(ModelView::new(&replica).links()).len(), 4);
    let deleted = write(&mut replica, |tx| {
        model::delete_records(tx, &two.table, &[nth(&to, 0), ObjectId::new()])
    });
    assert_eq!(deleted, 1);
    let read = ModelView::new(&replica);
    assert_eq!(ok(read.links()).len(), 2);
    assert_eq!(ok(read.record_ids(&two.table)), vec![nth(&to, 1)]);
    assert!(!replica.exists(&nth(&to, 0)));
    write(&mut replica, |tx| {
        model::delete_table(tx, &base, &two.table)
    });
    let read = ModelView::new(&replica);
    assert!(ok(read.links()).is_empty());
    assert_eq!(ok(read.tables()), vec![one.table.clone()]);
    for id in two.fields.iter().chain(&two.views).chain(&to) {
        assert!(!replica.exists(id));
    }
    assert!(!replica.exists(&two.table));
    // Deleting a view.
    write(&mut replica, |tx| {
        model::delete_view(tx, &one.table, &nth(&one.views, 0))
    });
    assert!(ok(ModelView::new(&replica).views(&one.table)).is_empty());
}

#[test]
fn dashboards_upsert_and_delete() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let widgets = object(json!({
        "w1": { "id": "w1", "title": "Count", "type": "metric", "query": { "aggregation": "count" } },
        "w2": { "id": "w2", "title": "By stage", "type": "bar", "query": { "aggregation": "count", "group_by_field_name": "stage" } },
    }));
    let config = json!({ "title": "Sales", "order": 1, "source_table": "t", "layout": [{ "widget_id": "w1", "x": 0, "y": 0, "w": 3, "h": 2 }] });
    let id = write(&mut replica, |tx| {
        model::upsert_dashboard(tx, &base, None, "Sales", config.clone(), &widgets)
    });
    let chosen = ObjectId::from_string("dashboard-ops");
    write(&mut replica, |tx| {
        model::upsert_dashboard(tx, &base, Some(&chosen), "Ops", Value::Null, &Map::new())
    });
    let mut next = widgets.clone();
    next.remove("w2");
    next.insert("w3".into(), json!({ "id": "w3", "type": "pie" }));
    write(&mut replica, |tx| {
        model::upsert_dashboard(tx, &base, Some(&id), "Sales 2", config.clone(), &next)
    });
    let read = ModelView::new(&replica);
    let dashboards = ok(read.dashboards());
    assert_eq!(
        dashboards
            .iter()
            .map(|data| (data.id.clone(), data.name.clone()))
            .collect::<Vec<_>>(),
        vec![
            (id.clone(), "Sales 2".to_owned()),
            (chosen.clone(), "Ops".to_owned())
        ]
    );
    let sales = dashboards.first().unwrap_or_else(|| panic!("a dashboard"));
    assert_eq!(sales.config, config);
    assert_eq!(sales.widgets, next);
    write(&mut replica, |tx| model::delete_dashboard(tx, &base, &id));
    let dashboards = ok(ModelView::new(&replica).dashboards());
    assert_eq!(dashboards.len(), 1);
    assert!(!replica.exists(&id));
}

#[test]
fn a_failed_model_call_changes_nothing() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let ids = simple_table(&mut replica, &base, "T");
    let version = replica.version();
    let failed = model::transact(&mut replica, &person(), |tx| {
        model::create_field(tx, &ids.table, &field("Fine", "text"))?;
        model::delete_field(tx, &ids.table, &nth(&ids.fields, 0))
    });
    assert!(matches!(failed, Err(KitableError::Invalid(_))));
    assert_eq!(replica.version(), version);
}

// ---------------------------------------------------------------------------
// Repair.

#[test]
fn repair_fixes_lists_primary_fields_and_links() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let ids = simple_table(&mut replica, &base, "T");
    let link = write(&mut replica, |tx| {
        model::create_field(tx, &ids.table, &field("Rel", "link_to_record"))
    });
    let rows = records(&mut replica, &ids.table, vec![json!({}), json!({})]);
    let (a, b) = (nth(&rows, 0), nth(&rows, 1));
    write(&mut replica, |tx| {
        model::replace_links(tx, &a, &link, std::slice::from_ref(&b))
    });
    repair_now(&mut replica);
    assert!(
        !repair_now(&mut replica),
        "a valid document needs no repair"
    );
    let name = nth(&ids.fields, 0);
    let other = simple_table(&mut replica, &base, "Other");
    // Break the document behind the model's back: a duplicate record entry, an entry naming no
    // object, the primary field deleted, a dangling link, a duplicate link, and orphans (a
    // record, a field, a table, and a dashboard nothing lists, and a link to the orphan record).
    let orphans = ok(replica.transact(&person(), |tx| {
        tx.list_insert(&ids.table, "records", 2, &a)?;
        tx.list_insert(&ids.table, "records", 0, &ObjectId::from_string("ghost"))?;
        let index = tx
            .list_items(&ids.table, "fields")?
            .iter()
            .position(|id| *id == name)
            .unwrap_or_default();
        tx.list_remove(&ids.table, "fields", index)?;
        tx.delete(&name)?;
        let mut ends = Map::new();
        ends.insert("from".into(), json!(a.as_str()));
        ends.insert("field".into(), json!(link.as_str()));
        ends.insert("to".into(), json!("missing-record"));
        tx.create("Link", ends.clone())?;
        ends.insert("to".into(), json!(b.as_str()));
        tx.create("Link", ends.clone())?;
        let record = tx.create_with_id(
            "Record",
            &ObjectId::from_string("orphan-record"),
            object(json!({ "createdAt": 1, "createdBy": "" })),
        )?;
        ends.insert("to".into(), json!(record.as_str()));
        tx.create("Link", ends)?;
        let field = tx.create(
            "Field",
            object(
                json!({ "name": "x", "title": "X", "type": "text", "required": false,
                "readonly": false, "formula": "", "aiPrompt": "" }),
            ),
        )?;
        let table = tx.create(
            "Table",
            object(json!({ "name": "lost", "title": "Lost", "description": "" })),
        )?;
        let dashboard = tx.create("Dashboard", object(json!({ "name": "lost" })))?;
        // The other table's list removed from the base: the table and its contents are orphans.
        let index = tx
            .list_items(&base, "tables")?
            .iter()
            .position(|id| *id == other.table)
            .unwrap_or_default();
        tx.list_remove(&base, "tables", index)?;
        Ok(vec![record, field, table, dashboard])
    }));
    assert!(repair_now(&mut replica));
    let read = ModelView::new(&replica);
    assert_eq!(ok(read.record_ids(&ids.table)), vec![a.clone(), b.clone()]);
    // The repeated entry stays (which copy to drop depends on the replica); readers skip it.
    assert_eq!(
        ok(replica.list(&ids.table, "records")),
        vec![a.clone(), b.clone(), a.clone()]
    );
    assert_eq!(
        ok(read.table(&ids.table)).primary_field,
        Some(nth(&ids.fields, 1))
    );
    assert_eq!(ok(read.links()).len(), 1);
    assert_eq!(ok(read.links_from(&a, &link)), vec![b.clone()]);
    assert_eq!(replica.objects_of_type("Link").len(), 1);
    for orphan in orphans
        .iter()
        .chain(std::iter::once(&other.table))
        .chain(&other.fields)
        .chain(&other.views)
    {
        assert!(!replica.exists(orphan), "{orphan} is collected");
    }
    assert!(!repair_now(&mut replica));
}

#[test]
fn readers_and_positions_use_the_first_of_repeated_entries() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let ids = simple_table(&mut replica, &base, "T");
    let rows = records(
        &mut replica,
        &ids.table,
        vec![json!({}), json!({}), json!({})],
    );
    let (a, b, c) = (nth(&rows, 0), nth(&rows, 1), nth(&rows, 2));
    // Raw [a, b, a, c]: readers see [a, b, c].
    ok(replica.transact(&person(), |tx| tx.list_insert(&ids.table, "records", 2, &a)));
    let list = |replica: &Replica| ok(ModelView::new(replica).record_ids(&ids.table));
    assert_eq!(list(&replica), vec![a.clone(), b.clone(), c.clone()]);
    write(&mut replica, |tx| {
        model::move_records(tx, &ids.table, std::slice::from_ref(&a), None)
    });
    assert_eq!(list(&replica), vec![b.clone(), c.clone(), a.clone()]);
    assert_eq!(
        ok(replica.list(&ids.table, "records")).len(),
        4,
        "no copy is removed"
    );
    write(&mut replica, |tx| {
        model::move_records(tx, &ids.table, std::slice::from_ref(&a), Some(&c))
    });
    assert_eq!(list(&replica), vec![b.clone(), a.clone(), c.clone()]);
    let created = write(&mut replica, |tx| {
        model::create_records(
            tx,
            &ids.table,
            Some(&Anchor::After(a.clone())),
            &[Map::new()],
            1,
            "",
        )
    });
    assert_eq!(
        list(&replica),
        vec![b.clone(), a.clone(), nth(&created, 0), c.clone()]
    );
    // A field created at a position counts live fields only.
    let extra = write(&mut replica, |tx| {
        // Raw [ghost, name, notes, name]: live [name, notes].
        tx.list_insert(&ids.table, "fields", 0, &ObjectId::from_string("ghost"))?;
        tx.list_insert(&ids.table, "fields", 3, &nth(&ids.fields, 0))?;
        model::create_field(
            tx,
            &ids.table,
            &FieldSpec {
                order: Some(2),
                ..field("Extra", "text")
            },
        )
    });
    let fields: Vec<ObjectId> = ok(ModelView::new(&replica).fields(&ids.table))
        .into_iter()
        .map(|field| field.id)
        .collect();
    assert_eq!(
        fields,
        vec![nth(&ids.fields, 0), extra, nth(&ids.fields, 1)]
    );
}

#[test]
fn single_target_links_keep_the_lowest_id() {
    let (mut net, _, ids) = shared(2, 8);
    let link = write(replica(&mut net, 0), |tx| {
        model::create_field(
            tx,
            &ids.table,
            &FieldSpec {
                options: json!({ "allow_multiple": false }),
                ..field("Owner", "link_to_record")
            },
        )
    });
    let rows = records(
        replica(&mut net, 0),
        &ids.table,
        vec![json!({}), json!({}), json!({})],
    );
    ok(net.sync_all());
    let (from, a, b) = (nth(&rows, 0), nth(&rows, 1), nth(&rows, 2));
    let too_many = model::transact(replica(&mut net, 0), &person(), |tx| {
        model::replace_links(tx, &from, &link, &[a.clone(), b.clone()])
    });
    assert!(matches!(too_many, Err(KitableError::Invalid(_))));
    write(replica(&mut net, 0), |tx| {
        model::replace_links(tx, &from, &link, std::slice::from_ref(&a))
    });
    write(replica(&mut net, 1), |tx| {
        model::replace_links(tx, &from, &link, std::slice::from_ref(&b))
    });
    ok(net.sync_all());
    let lowest = replica(&mut net, 0)
        .objects_of_type("Link")
        .into_iter()
        .next()
        .unwrap_or_else(|| panic!("a link"));
    let expected = ok(replica(&mut net, 0).get(&lowest, "to"));
    // Readers already show one target; repair deletes the other link.
    assert_eq!(
        ok(ModelView::new(replica(&mut net, 0)).links_from(&from, &link)).len(),
        1
    );
    converge(&mut net);
    for replica in &net.replicas {
        assert_eq!(replica.objects_of_type("Link"), vec![lowest.clone()]);
        let targets = ok(ModelView::new(replica).links_from(&from, &link));
        assert_eq!(
            targets
                .iter()
                .map(|id| json!(id.as_str()))
                .collect::<Vec<_>>(),
            vec![expected.clone()]
        );
    }
}

#[test]
fn links_group_by_field() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let ids = simple_table(&mut replica, &base, "T");
    let link = write(&mut replica, |tx| {
        model::create_field(tx, &ids.table, &field("Rel", "link_to_record"))
    });
    let rows = records(
        &mut replica,
        &ids.table,
        vec![json!({}), json!({}), json!({})],
    );
    let (a, b, c) = (nth(&rows, 0), nth(&rows, 1), nth(&rows, 2));
    write(&mut replica, |tx| {
        model::replace_links_many(
            tx,
            &link,
            &[
                (a.clone(), vec![b.clone(), c.clone()]),
                (b.clone(), vec![c.clone()]),
            ],
        )
    });
    let grouped = ok(ModelView::new(&replica).links_of_field(&link));
    assert_eq!(grouped.len(), 2);
    assert_eq!(grouped.get(&a), Some(&vec![b.clone(), c.clone()]));
    assert_eq!(grouped.get(&b), Some(&vec![c.clone()]));
    let read = ModelView::new(&replica);
    let mut to_c = ok(read.links_to(&c));
    to_c.sort();
    let mut expected = vec![(a.clone(), link.clone()), (b.clone(), link.clone())];
    expected.sort();
    assert_eq!(to_c, expected);
}

#[test]
fn options_convert_between_relational_and_object_ids() {
    let table = ObjectId::from_string("table-a");
    let field = ObjectId::from_string("field-b");
    let resolve = |kind: IdKind, id: i64| match (kind, id) {
        (IdKind::Table, 3) => Some(table.clone()),
        (IdKind::Field, 7) => Some(field.clone()),
        _ => None,
    };
    let relational = json!({
        "target_table_id": 3,
        "symmetric_field_id": null,
        "link_field_id": "7",
        "target_field_id": 0,
        "allow_multiple": false,
        "ai_config": { "type": "summarize", "source_field_id": 7 },
    });
    let kdm = ok(options_to_kdm(&relational, resolve));
    assert_eq!(
        kdm,
        json!({
            "target_table": "table-a",
            "symmetric_field": null,
            "link_field": "field-b",
            "target_field": null,
            "allow_multiple": false,
            "ai_config": { "type": "summarize", "source_field": "field-b" },
        })
    );
    let local = |id: &ObjectId| match id.as_str() {
        "table-a" => Some(3),
        "field-b" => Some(7),
        _ => None,
    };
    assert_eq!(
        options_from_kdm(&kdm, local),
        json!({
            "target_table_id": 3,
            "symmetric_field_id": null,
            "link_field_id": 7,
            "target_field_id": null,
            "allow_multiple": false,
            "ai_config": { "type": "summarize", "source_field_id": 7 },
        })
    );
    let dashboard = ok(options_to_kdm(
        &json!({ "source_table_id": 3, "order": 1 }),
        resolve,
    ));
    assert_eq!(dashboard, json!({ "source_table": "table-a", "order": 1 }));
    // A dangling reference reads back as null.
    assert_eq!(
        options_from_kdm(&json!({ "target_table": "gone" }), local),
        json!({ "target_table_id": null })
    );
    for bad in [
        json!({ "target_table_id": 99 }),
        json!({ "link_field_id": "x" }),
    ] {
        assert!(matches!(
            options_to_kdm(&bad, resolve),
            Err(KitableError::Invalid(_))
        ));
    }
    assert_eq!(ok(options_to_kdm(&Value::Null, resolve)), Value::Null);
}

#[test]
fn relational_ids_and_foreign_records_are_refused() {
    let mut replica = new_replica();
    let base = base_in(&mut replica);
    let one = simple_table(&mut replica, &base, "One");
    let two = simple_table(&mut replica, &base, "Two");
    let refused = model::transact(&mut replica, &person(), |tx| {
        model::update_table(
            tx,
            &one.table,
            &TablePatch {
                primary_field_id: Some(1),
                ..TablePatch::default()
            },
            None,
        )
    });
    assert!(matches!(refused, Err(KitableError::Invalid(_))));
    let relational = model::transact(&mut replica, &person(), |tx| {
        model::create_field(
            tx,
            &one.table,
            &FieldSpec {
                options: json!({ "ai_config": { "source_field_id": 1 } }),
                ..field("AI", "ai")
            },
        )
    });
    assert!(matches!(relational, Err(KitableError::Invalid(_))));
    let relational = model::transact(&mut replica, &person(), |tx| {
        model::upsert_dashboard(
            tx,
            &base,
            None,
            "D",
            json!({ "source_table_id": 1 }),
            &Map::new(),
        )
    });
    assert!(matches!(relational, Err(KitableError::Invalid(_))));
    let record = nth(&records(&mut replica, &two.table, vec![json!({})]), 0);
    let foreign = model::transact(&mut replica, &person(), |tx| {
        model::set_cells(
            tx,
            &one.table,
            &record,
            &object(json!({ nth(&one.fields, 0).as_str(): "x" })),
        )
    });
    assert!(matches!(foreign, Err(KitableError::NotFound)));
    // Cells keyed by another table's field are not that record's cells.
    write(&mut replica, |tx| {
        model::set_cells(
            tx,
            &two.table,
            &record,
            &object(
                json!({ nth(&one.fields, 0).as_str(): "x", nth(&two.fields, 0).as_str(): "y" }),
            ),
        )
    });
    assert_eq!(
        ok(ModelView::new(&replica).cells(&record)),
        object(json!({ nth(&two.fields, 0).as_str(): "y" }))
    );
}

// ---------------------------------------------------------------------------
// Two replicas.

fn network(count: usize, seed: u64) -> Network {
    ok(Network::new(schema(), count, seed))
}

fn replica(net: &mut Network, index: usize) -> &mut Replica {
    net.replicas
        .get_mut(index)
        .unwrap_or_else(|| panic!("replica {index}"))
}

/// A network whose replicas share one base with one simple table.
fn shared(count: usize, seed: u64) -> (Network, ObjectId, TableIds) {
    let mut net = network(count, seed);
    let base = base_in(replica(&mut net, 0));
    let ids = simple_table(replica(&mut net, 0), &base, "T");
    ok(net.sync_all());
    (net, base, ids)
}

fn converge(net: &mut Network) {
    ok(net.sync_all());
    for index in 0..net.replicas.len() {
        repair_now(replica(net, index));
    }
    if let Err(diff) = net.converged() {
        panic!("replicas differ after repair: {diff}");
    }
    ok(net.sync_all());
    if let Err(diff) = net.converged() {
        panic!("replicas differ after syncing the repairs: {diff}");
    }
}

#[test]
fn concurrent_edits_of_different_cells_both_survive() {
    let (mut net, _, ids) = shared(2, 1);
    let (name, notes) = (nth(&ids.fields, 0), nth(&ids.fields, 1));
    let record = nth(
        &records(replica(&mut net, 0), &ids.table, vec![json!({})]),
        0,
    );
    ok(net.sync_all());
    write(replica(&mut net, 0), |tx| {
        model::set_cells(
            tx,
            &ids.table,
            &record,
            &object(json!({ name.as_str(): "zero" })),
        )
    });
    write(replica(&mut net, 1), |tx| {
        model::set_cells(
            tx,
            &ids.table,
            &record,
            &object(json!({ notes.as_str(): "one" })),
        )
    });
    converge(&mut net);
    for replica in &net.replicas {
        assert_eq!(
            ok(ModelView::new(replica).cells(&record)),
            object(json!({ name.as_str(): "zero", notes.as_str(): "one" }))
        );
    }
}

#[test]
fn concurrent_link_adds_both_survive() {
    let (mut net, _, ids) = shared(2, 2);
    let link = write(replica(&mut net, 0), |tx| {
        model::create_field(tx, &ids.table, &field("Rel", "link_to_record"))
    });
    let rows = records(
        replica(&mut net, 0),
        &ids.table,
        vec![json!({}), json!({}), json!({})],
    );
    ok(net.sync_all());
    let (from, a, b) = (nth(&rows, 0), nth(&rows, 1), nth(&rows, 2));
    write(replica(&mut net, 0), |tx| {
        model::replace_links(tx, &from, &link, std::slice::from_ref(&a))
    });
    write(replica(&mut net, 1), |tx| {
        model::replace_links(tx, &from, &link, std::slice::from_ref(&b))
    });
    converge(&mut net);
    for replica in &net.replicas {
        let mut targets = ok(ModelView::new(replica).links_from(&from, &link));
        targets.sort();
        let mut expected = vec![a.clone(), b.clone()];
        expected.sort();
        assert_eq!(targets, expected);
    }
}

#[test]
fn concurrent_identical_links_dedupe_to_the_lowest_id() {
    let (mut net, _, ids) = shared(2, 7);
    let link = write(replica(&mut net, 0), |tx| {
        model::create_field(tx, &ids.table, &field("Rel", "link_to_record"))
    });
    let rows = records(replica(&mut net, 0), &ids.table, vec![json!({}), json!({})]);
    ok(net.sync_all());
    let (from, to) = (nth(&rows, 0), nth(&rows, 1));
    for index in 0..2 {
        write(replica(&mut net, index), |tx| {
            model::replace_links(tx, &from, &link, std::slice::from_ref(&to))
        });
    }
    ok(net.sync_all());
    let both = replica(&mut net, 0).objects_of_type("Link");
    assert_eq!(both.len(), 2);
    assert_eq!(
        ok(ModelView::new(replica(&mut net, 0)).links()).len(),
        1,
        "readers show one"
    );
    converge(&mut net);
    for replica in &net.replicas {
        assert_eq!(replica.objects_of_type("Link"), vec![nth(&both, 0)]);
    }
}

#[test]
fn concurrent_fields_with_one_name_get_unique_names_after_repair() {
    let (mut net, _, ids) = shared(2, 3);
    let mut created = Vec::new();
    for index in 0..2 {
        created.push(write(replica(&mut net, index), |tx| {
            model::create_field(tx, &ids.table, &field("Status", "text"))
        }));
    }
    ok(net.sync_all());
    let fields = ok(ModelView::new(replica(&mut net, 0)).fields(&ids.table));
    assert_eq!(
        fields.iter().filter(|field| field.name == "status").count(),
        2
    );
    converge(&mut net);
    created.sort();
    for replica in &net.replicas {
        let read = ModelView::new(replica);
        assert_eq!(ok(read.field(&nth(&created, 0))).name, "status");
        assert_eq!(ok(read.field(&nth(&created, 1))).name, "status_2");
    }
}

#[test]
fn a_record_moved_and_deleted_concurrently_is_deleted() {
    let (mut net, _, ids) = shared(2, 4);
    let rows = records(
        replica(&mut net, 0),
        &ids.table,
        vec![json!({}), json!({}), json!({})],
    );
    ok(net.sync_all());
    let (a, b, c) = (nth(&rows, 0), nth(&rows, 1), nth(&rows, 2));
    write(replica(&mut net, 0), |tx| {
        model::move_records(tx, &ids.table, std::slice::from_ref(&a), None)
    });
    write(replica(&mut net, 1), |tx| {
        model::delete_records(tx, &ids.table, std::slice::from_ref(&a))
    });
    converge(&mut net);
    for replica in &net.replicas {
        assert_eq!(
            ok(ModelView::new(replica).record_ids(&ids.table)),
            vec![b.clone(), c.clone()]
        );
        assert_eq!(ok(replica.list(&ids.table, "records")).len(), 2);
        assert!(!replica.exists(&a));
    }
}

#[test]
fn concurrent_widths_of_different_fields_both_survive() {
    let (mut net, _, ids) = shared(2, 5);
    let grid = nth(&ids.views, 0);
    let (name, notes) = (nth(&ids.fields, 0), nth(&ids.fields, 1));
    write(replica(&mut net, 0), |tx| {
        model::set_view_width(tx, &grid, &name, 300)
    });
    write(replica(&mut net, 1), |tx| {
        model::set_view_width(tx, &grid, &notes, 90)
    });
    converge(&mut net);
    for replica in &net.replicas {
        let view = ok(ModelView::new(replica).view(&grid));
        assert_eq!(view.widths.get(&name), Some(&300));
        assert_eq!(view.widths.get(&notes), Some(&90));
    }
}

#[test]
fn a_link_to_a_record_deleted_concurrently_is_removed() {
    let (mut net, _, ids) = shared(2, 6);
    let link = write(replica(&mut net, 0), |tx| {
        model::create_field(tx, &ids.table, &field("Rel", "link_to_record"))
    });
    let rows = records(replica(&mut net, 0), &ids.table, vec![json!({}), json!({})]);
    ok(net.sync_all());
    let (from, to) = (nth(&rows, 0), nth(&rows, 1));
    write(replica(&mut net, 0), |tx| {
        model::replace_links(tx, &from, &link, std::slice::from_ref(&to))
    });
    repair_now(replica(&mut net, 0));
    write(replica(&mut net, 1), |tx| {
        model::delete_records(tx, &ids.table, std::slice::from_ref(&to))
    });
    repair_now(replica(&mut net, 1));
    converge(&mut net);
    for replica in &net.replicas {
        assert!(ok(ModelView::new(replica).links()).is_empty());
        assert!(ok(replica.state_json()).to_string().contains(from.as_str()));
    }
}

#[test]
fn replicas_repairing_different_states_converge() {
    let (mut net, _, ids) = shared(2, 9);
    let a = write(replica(&mut net, 0), |tx| {
        model::create_field(tx, &ids.table, &field("Status", "text"))
    });
    let b = write(replica(&mut net, 1), |tx| {
        model::create_field(tx, &ids.table, &field("Status", "text"))
    });
    // Replica 0 sees both and repairs; replica 1 goes on alone and names a third field
    // `status_2`, which replica 0's repair also gave one of the first two.
    ok(net.deliver(1, 0));
    assert!(repair_now(replica(&mut net, 0)));
    let c = write(replica(&mut net, 1), |tx| {
        model::create_field(tx, &ids.table, &field("Status", "text"))
    });
    assert!(!repair_now(replica(&mut net, 1)));
    converge(&mut net);
    let mut ids_sorted = vec![a.clone(), b.clone()];
    ids_sorted.sort();
    for replica in &net.replicas {
        let read = ModelView::new(replica);
        let fields = ok(read.fields(&ids.table));
        let names: BTreeSet<&str> = fields.iter().map(|field| field.name.as_str()).collect();
        assert_eq!(names.len(), fields.len());
        assert_eq!(ok(read.field(&nth(&ids_sorted, 0))).name, "status");
        for id in [&a, &b, &c] {
            assert!(ok(read.field(id)).name.starts_with("status"));
        }
    }
}

#[test]
fn records_anchored_on_a_record_deleted_concurrently_survive() {
    let (mut net, _, ids) = shared(2, 10);
    let rows = records(
        replica(&mut net, 0),
        &ids.table,
        vec![json!({}), json!({}), json!({})],
    );
    ok(net.sync_all());
    let (a, b, c) = (nth(&rows, 0), nth(&rows, 1), nth(&rows, 2));
    write(replica(&mut net, 0), |tx| {
        model::delete_records(tx, &ids.table, std::slice::from_ref(&b))
    });
    let created = write(replica(&mut net, 1), |tx| {
        model::create_records(
            tx,
            &ids.table,
            Some(&Anchor::Before(b.clone())),
            &[Map::new()],
            1,
            "",
        )
    });
    converge(&mut net);
    for replica in &net.replicas {
        assert_eq!(
            ok(ModelView::new(replica).record_ids(&ids.table)),
            vec![a.clone(), nth(&created, 0), c.clone()]
        );
    }
}

#[test]
fn a_cell_written_while_its_field_is_deleted_is_hidden() {
    let (mut net, _, ids) = shared(2, 11);
    let (name, notes) = (nth(&ids.fields, 0), nth(&ids.fields, 1));
    let record = nth(
        &records(replica(&mut net, 0), &ids.table, vec![json!({})]),
        0,
    );
    ok(net.sync_all());
    write(replica(&mut net, 0), |tx| {
        model::delete_field(tx, &ids.table, &notes)
    });
    write(replica(&mut net, 1), |tx| {
        model::set_cells(
            tx,
            &ids.table,
            &record,
            &object(json!({ name.as_str(): "kept", notes.as_str(): "late" })),
        )
    });
    converge(&mut net);
    for replica in &net.replicas {
        let read = ModelView::new(replica);
        assert_eq!(ok(read.fields(&ids.table)).len(), 1);
        assert_eq!(
            ok(read.cells(&record)),
            object(json!({ name.as_str(): "kept" }))
        );
    }
}

#[test]
fn a_table_deleted_while_another_replica_adds_to_it_leaves_no_orphans() {
    let (mut net, base, ids) = shared(2, 12);
    let other = simple_table(replica(&mut net, 0), &base, "Other");
    let link = write(replica(&mut net, 0), |tx| {
        model::create_field(tx, &other.table, &field("Rel", "link_to_record"))
    });
    let source = nth(
        &records(replica(&mut net, 0), &other.table, vec![json!({})]),
        0,
    );
    ok(net.sync_all());
    write(replica(&mut net, 0), |tx| {
        model::delete_table(tx, &base, &ids.table)
    });
    let (added, field_id) = write(replica(&mut net, 1), |tx| {
        let added = model::create_records(tx, &ids.table, None, &[Map::new(), Map::new()], 1, "")?;
        let field_id = model::create_field(tx, &ids.table, &field("Late", "text"))?;
        model::replace_links(tx, &source, &link, &added)?;
        Ok((added, field_id))
    });
    converge(&mut net);
    for replica in &net.replicas {
        for id in added.iter().chain(std::iter::once(&field_id)) {
            assert!(!replica.exists(id), "{id} is collected");
        }
        assert!(replica.objects_of_type("Link").is_empty());
        assert_eq!(
            ok(ModelView::new(replica).tables()),
            vec![other.table.clone()]
        );
    }
}

// ---------------------------------------------------------------------------
// Randomized convergence.

const NAMES: [&str; 4] = ["Status", "Owner", "Due", "Notes"];
const TYPES: [&str; 8] = [
    "text",
    "number",
    "checkbox",
    "formula",
    "link_to_record",
    "link_to_record",
    "link_to_record",
    "link_to_record",
];
const OPS: [&str; 20] = [
    "create_field",
    "delete_field",
    "create_records",
    "delete_records",
    "set_cells",
    "move_records",
    "replace_links",
    "add_link",
    "set_view_width",
    "set_view_hidden",
    "create_view",
    "delete_view",
    "update_view",
    "update_table",
    "update_field",
    "move_fields",
    "create_table",
    "delete_table",
    "upsert_dashboard",
    "delete_dashboard",
];

fn pick<T: Clone>(rng: &mut Rng, items: &[T]) -> Option<T> {
    if items.is_empty() {
        None
    } else {
        items.get(rng.below(items.len())).cloned()
    }
}

fn some<T>(value: Option<T>) -> kition_kitable::Result<T> {
    value.ok_or(KitableError::NotFound)
}

/// What one replica sees, read before a random operation.
struct Seen {
    tables: Vec<ObjectId>,
    table: Option<ObjectId>,
    fields: Vec<FieldData>,
    records: Vec<ObjectId>,
    all_records: Vec<ObjectId>,
    views: Vec<ObjectId>,
    dashboards: Vec<ObjectId>,
}

fn seen(replica: &Replica, rng: &mut Rng) -> Seen {
    let read = ModelView::new(replica);
    let tables = ok(read.tables());
    // Mostly the first table, so replicas edit the same objects.
    let table = if rng.below(4) == 0 {
        pick(rng, &tables)
    } else {
        tables.first().cloned()
    };
    let all_records = tables
        .iter()
        .flat_map(|table| ok(read.record_ids(table)))
        .collect();
    let (fields, records, views) = match &table {
        Some(table) => (
            ok(read.fields(table)),
            ok(read.record_ids(table)),
            ok(read.views(table))
                .into_iter()
                .map(|view| view.id)
                .collect(),
        ),
        None => (Vec::new(), Vec::new(), Vec::new()),
    };
    let dashboards = ok(read.dashboards())
        .into_iter()
        .map(|data| data.id)
        .collect();
    Seen {
        tables,
        table,
        fields,
        records,
        all_records,
        views,
        dashboards,
    }
}

/// One random model operation on one replica; answers its kind when the model accepted it.
/// Operations the model refuses (deleting the primary field, ...) change nothing and are fine.
fn random_op(replica: &mut Replica, rng: &mut Rng, base: &ObjectId) -> Option<&'static str> {
    let seen = seen(replica, rng);
    let kind = if seen.table.is_none() {
        16
    } else {
        match rng.below(26) {
            20..=22 => 4,
            23 | 24 => 2,
            25 => 6,
            other => other,
        }
    };
    let field_ids: Vec<ObjectId> = seen.fields.iter().map(|field| field.id.clone()).collect();
    let links: Vec<ObjectId> = seen
        .fields
        .iter()
        .filter(|field| field.field_type == "link_to_record")
        .map(|field| field.id.clone())
        .collect();
    let value = json!(rng.below(100));
    let result = model::transact(replica, &person(), |tx| -> kition_kitable::Result<()> {
        let table = seen.table.clone().unwrap_or_default();
        match kind {
            0 => {
                let ty = pick(rng, &TYPES).unwrap_or("text");
                let options = if ty == "link_to_record" && rng.below(2) == 0 {
                    json!({ "allow_multiple": false })
                } else {
                    Value::Null
                };
                let spec = FieldSpec {
                    order: Some(rng.below(4) as i64),
                    options,
                    ..field(pick(rng, &NAMES).unwrap_or("Status"), ty)
                };
                model::create_field(tx, &table, &spec)?;
            }
            1 => {
                let primary = tx.get(&table, "primaryField")?;
                let others: Vec<ObjectId> = field_ids
                    .iter()
                    .filter(|field| json!(field.as_str()) != primary)
                    .cloned()
                    .collect();
                model::delete_field(tx, &table, &some(pick(rng, &others))?)?;
            }
            2 => {
                let mut row = Map::new();
                if let Some(field) = pick(rng, &field_ids) {
                    row.insert(field.to_string(), value);
                }
                let at = match (pick(rng, &seen.records), rng.below(3)) {
                    (Some(record), 0) => Some(Anchor::Before(record)),
                    (Some(record), 1) => Some(Anchor::After(record)),
                    _ => None,
                };
                let rows = vec![row; 1 + rng.below(3)];
                model::create_records(tx, &table, at.as_ref(), &rows, 7, "user:rand")?;
            }
            3 => {
                let doomed: Vec<ObjectId> = (0..1 + rng.below(2))
                    .filter_map(|_| pick(rng, &seen.records))
                    .collect();
                if model::delete_records(tx, &table, &doomed)? == 0 {
                    return Err(KitableError::NotFound);
                }
            }
            4 => {
                let record = some(pick(rng, &seen.records))?;
                let field = some(pick(rng, &field_ids))?;
                let value = if rng.below(5) == 0 {
                    Value::Null
                } else {
                    value
                };
                let mut cells = Map::new();
                cells.insert(field.to_string(), value);
                model::set_cells(tx, &table, &record, &cells)?;
            }
            5 => {
                let moved: Vec<ObjectId> = (0..1 + rng.below(3))
                    .filter_map(|_| pick(rng, &seen.records))
                    .collect();
                let before = if rng.below(3) == 0 {
                    None
                } else {
                    pick(rng, &seen.records)
                };
                model::move_records(tx, &table, &moved, before.as_ref())?;
            }
            6 => {
                let from = some(pick(rng, &seen.records))?;
                let field = some(pick(rng, &links))?;
                let targets: Vec<ObjectId> = (0..rng.below(3))
                    .filter_map(|_| pick(rng, &seen.all_records))
                    .collect();
                model::replace_links(tx, &from, &field, &targets)?;
            }
            7 => {
                let from = some(pick(rng, &seen.records))?;
                let field = some(pick(rng, &links))?;
                let to = some(pick(rng, &seen.all_records))?;
                model::add_link(tx, &from, &field, &to)?;
            }
            8 => {
                let view = some(pick(rng, &seen.views))?;
                let field = some(pick(rng, &field_ids))?;
                model::set_view_width(tx, &view, &field, 40 + rng.below(400) as i64)?;
            }
            9 => {
                let view = some(pick(rng, &seen.views))?;
                let field = some(pick(rng, &field_ids))?;
                model::set_view_hidden(tx, &view, &field, rng.below(2) == 0)?;
            }
            10 => {
                model::create_view(tx, &table, &view("V", "kanban"))?;
            }
            11 => model::delete_view(tx, &table, &some(pick(rng, &seen.views))?)?,
            12 => {
                let patch = ViewPatch {
                    title: Some(format!("View {}", rng.below(5))),
                    view_type: pick(rng, &VIEW_TYPES).map(str::to_owned),
                    config: Some(json!({ "sorts": [rng.below(3)] })),
                };
                model::update_view(tx, &some(pick(rng, &seen.views))?, &patch)?;
            }
            13 => {
                let primary = some(pick(rng, &field_ids))?;
                let patch = TablePatch {
                    title: Some(format!("Table {}", rng.below(5))),
                    ..TablePatch::default()
                };
                model::update_table(tx, &table, &patch, Some(&primary))?;
            }
            14 => {
                let field = some(pick(rng, &field_ids))?;
                let patch = match rng.below(3) {
                    0 => FieldPatch {
                        field_type: pick(rng, &TYPES).map(str::to_owned),
                        ..FieldPatch::default()
                    },
                    1 => FieldPatch {
                        is_primary: Some(true),
                        ..FieldPatch::default()
                    },
                    _ => FieldPatch {
                        title: Some(format!("Title {}", rng.below(5))),
                        options: Some(json!({ "choices": ["A", "B"] })),
                        ..FieldPatch::default()
                    },
                };
                model::update_field(tx, &field, &patch)?;
            }
            15 => {
                let moved = some(pick(rng, &field_ids))?;
                model::move_fields(tx, &table, &[moved], rng.below(4))?;
            }
            16 => {
                if seen.tables.len() >= 4 {
                    return Err(KitableError::NotFound);
                }
                let spec = TableSpec {
                    fields: vec![
                        FieldSpec {
                            primary: true,
                            ..field("Title", "text")
                        },
                        field("Rel", "link_to_record"),
                    ],
                    ..TableSpec::default()
                };
                model::create_table(tx, base, &spec, Some(rng.below(3)))?;
            }
            17 => {
                if seen.tables.len() < 2 {
                    return Err(KitableError::NotFound);
                }
                model::delete_table(tx, base, &some(pick(rng, &seen.tables))?)?;
            }
            18 => {
                let id = if rng.below(2) == 0 {
                    pick(rng, &seen.dashboards)
                } else {
                    None
                };
                let mut widgets = Map::new();
                for key in ["w1", "w2", "w3"] {
                    if rng.below(2) == 0 {
                        widgets.insert(key.into(), json!({ "id": key, "n": rng.below(9) }));
                    }
                }
                let config = json!({ "source_table": table.as_str(), "layout": [] });
                model::upsert_dashboard(tx, base, id.as_ref(), "D", config, &widgets)?;
            }
            _ => model::delete_dashboard(tx, base, &some(pick(rng, &seen.dashboards))?)?,
        }
        Ok(())
    });
    result.ok().and_then(|()| OPS.get(kind).copied())
}

/// Every invariant repair restores, on a repaired replica.
fn check_invariants(replica: &Replica, seed: u64) {
    let read = ModelView::new(replica);
    let mut reachable = BTreeSet::new();
    let base = read.base().unwrap_or_else(|| panic!("seed {seed}: a base"));
    let raw_live = |id: &ObjectId, field: &str| {
        let items = ok(replica.list(id, field));
        for item in &items {
            assert!(
                replica.exists(item),
                "seed {seed}: dangling entry {item} in {field}"
            );
        }
        items
    };
    let tables = ok(read.tables());
    assert_eq!(
        tables.iter().collect::<BTreeSet<_>>().len(),
        tables.len(),
        "seed {seed}: tables once"
    );
    raw_live(&base, "tables");
    reachable.extend(raw_live(&base, "dashboards"));
    let table_names: BTreeSet<String> = tables
        .iter()
        .map(|table| ok(read.table(table)).name)
        .collect();
    assert_eq!(
        table_names.len(),
        tables.len(),
        "seed {seed}: unique table names"
    );
    let mut single = BTreeSet::new();
    for table in &tables {
        reachable.insert(table.clone());
        for list in ["fields", "views", "records"] {
            reachable.extend(raw_live(table, list));
        }
        let fields = ok(read.fields(table));
        let names: BTreeSet<&str> = fields.iter().map(|field| field.name.as_str()).collect();
        assert_eq!(names.len(), fields.len(), "seed {seed}: unique field names");
        let ids: BTreeSet<&ObjectId> = fields.iter().map(|field| &field.id).collect();
        assert_eq!(ids.len(), fields.len(), "seed {seed}: fields once");
        let records = ok(read.record_ids(table));
        assert_eq!(
            records.iter().collect::<BTreeSet<_>>().len(),
            records.len(),
            "seed {seed}: records once"
        );
        let primary = ok(read.table(table)).primary_field;
        assert_eq!(
            primary.is_some(),
            !fields.is_empty(),
            "seed {seed}: a primary field"
        );
        if let Some(primary) = primary {
            assert!(
                ids.contains(&primary),
                "seed {seed}: the primary field is listed"
            );
        }
        for field in &fields {
            if field.options.get("allow_multiple") == Some(&json!(false)) {
                single.insert(field.id.clone());
            }
        }
    }
    for ty in ["Table", "Field", "View", "Record", "Dashboard"] {
        for id in replica.objects_of_type(ty) {
            assert!(reachable.contains(&id), "seed {seed}: orphan {ty} {id}");
        }
    }
    let mut triples = BTreeSet::new();
    let mut singles = BTreeSet::new();
    let raw_links = replica.objects_of_type("Link");
    for link in &raw_links {
        let end = |name: &str| {
            ObjectId::from_string(ok(replica.get(link, name)).as_str().unwrap_or_default())
        };
        let (from, field, to) = (end("from"), end("field"), end("to"));
        assert!(
            reachable.contains(&from) && reachable.contains(&to) && reachable.contains(&field),
            "seed {seed}: live link ends"
        );
        assert!(
            triples.insert((from.clone(), field.clone(), to)),
            "seed {seed}: links once"
        );
        if single.contains(&field) {
            assert!(
                singles.insert((from, field)),
                "seed {seed}: one link for a single-target field"
            );
        }
    }
    assert_eq!(
        ok(read.links()).len(),
        raw_links.len(),
        "seed {seed}: readers show every link"
    );
}

fn run_random(seed: u64, count: usize, steps: usize) {
    let (mut net, base, ids) = shared(count, seed);
    write(replica(&mut net, 0), |tx| {
        model::create_field(tx, &ids.table, &field("Rel", "link_to_record"))
    });
    ok(net.sync_all());
    let mut rng = Rng::new(seed.wrapping_add(1000));
    let mut accepted: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for _ in 0..steps {
        let index = rng.below(count);
        if let Some(kind) = random_op(replica(&mut net, index), &mut rng, &base) {
            *accepted.entry(kind).or_default() += 1;
        }
        if rng.below(5) == 0 {
            let from = rng.below(count);
            let to = rng.below(count);
            if from != to {
                ok(net.deliver(from, to));
                if rng.below(2) == 0 {
                    repair_now(replica(&mut net, to));
                }
            }
        }
    }
    converge(&mut net);
    for index in 0..count {
        let replica = replica(&mut net, index);
        check_invariants(replica, seed);
        let wrote = ok(model::transact(replica, &Origin::system("repair"), |tx| {
            repair::repair_all(tx)
        }));
        assert!(!wrote, "seed {seed}: repair is idempotent");
    }
    for kind in OPS {
        let done = accepted.get(kind).copied().unwrap_or_default();
        assert!(
            done >= 5,
            "seed {seed}: {kind} succeeded {done} times: {accepted:?}"
        );
    }
}

#[test]
fn random_operations_converge_on_two_replicas() {
    for seed in [11, 12, 13, 14] {
        run_random(seed, 2, 500);
    }
}

#[test]
fn random_operations_converge_on_three_replicas() {
    for seed in [21, 22, 23, 24] {
        run_random(seed, 3, 500);
    }
}

// ---------------------------------------------------------------------------
// Repair cost on a large table. Run with `cargo test --release -- --ignored repair_cost`.

#[test]
#[ignore = "timing; run in release"]
fn repair_cost_on_ten_thousand_records() {
    let mut net = network(2, 99);
    let base = base_in(replica(&mut net, 0));
    let ids = simple_table(replica(&mut net, 0), &base, "Big");
    let link = write(replica(&mut net, 0), |tx| {
        model::create_field(tx, &ids.table, &field("Rel", "link_to_record"))
    });
    let name = nth(&ids.fields, 0);
    let rows: Vec<Map<String, Value>> = (0..10_000)
        .map(|index| object(json!({ name.as_str(): format!("row {index}") })))
        .collect();
    let created = write(replica(&mut net, 0), |tx| {
        model::create_records(tx, &ids.table, None, &rows, 1, "")
    });
    write(replica(&mut net, 0), |tx| {
        for pair in created.chunks(2).take(2_000) {
            if let [from, to] = pair {
                model::add_link(tx, from, &link, to)?;
            }
        }
        Ok(())
    });
    ok(net.sync_all());
    write(replica(&mut net, 1), |tx| {
        model::set_cells(
            tx,
            &ids.table,
            &nth(&created, 5),
            &object(json!({ name.as_str(): "edited" })),
        )
    });
    ok(net.sync_all());
    let replica = replica(&mut net, 0);
    let changed = replica.take_changed();
    let started = std::time::Instant::now();
    let wrote = ok(repair::run(replica, &changed));
    println!("repair pass: {:?} (wrote {wrote})", started.elapsed());
    assert!(!wrote);
}
