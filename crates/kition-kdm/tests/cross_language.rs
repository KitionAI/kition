// Copied from kition-sdk crates/kition-kdm/tests/cross_language.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Rust writes, other implementations read (plan 2026-11-24, section 4): the canonical content
//! fixtures under `fixtures/content/`, which the TypeScript reader checks
//! (`packages/kdm/test/cross-language.test.ts`), are what this crate's replicas write. The board
//! fixture is built here with transactions, as a kit builds a document, and its content is the
//! fixture's bytes exactly. The change-list fixture (`changes.json`) is what transactions on the
//! snapshot `changes-start.content.json` export: every kind of operation, as applied, with what
//! its inverse needs; `changes.state.json` is the state they leave. Fixtures are written by hand
//! from the rules and never regenerated to make a test pass.

use std::sync::Arc;

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, Version};
use serde_json::{Map, Value, json};

fn schema() -> Arc<Schema> {
    Arc::new(Schema::parse(include_str!("fixtures/content/schema.json")).expect("content schema parses"))
}

fn id(suffix: &str) -> ObjectId {
    ObjectId::from_string(format!("0193a5c4-0000-7000-8000-0000000000{suffix}"))
}

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

#[test]
fn a_document_built_by_transactions_writes_the_board_fixture_exactly() {
    let doc = DocId::parse("0193a5c4-0000-7000-8000-000000000001").unwrap();
    let mut replica = Replica::create(schema(), doc, ActorId::from_u64(1).unwrap()).unwrap();
    let person = Origin::person("user:test");
    let (board, p1, p2, p3) = (id("a1"), id("b1"), id("b2"), id("b3"));
    let image = json!({ "hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "mime": "image/png", "size": 5120 });
    replica
        .transact(&person, |tx| {
            tx.create_with_id("Board", &board, fields(json!({ "title": "Q4" })))?;
            tx.create_with_id("Page", &p2, fields(json!({ "name": "" })))?;
            tx.create_with_id(
                "Page",
                &p1,
                fields(json!({ "name": "Page 1", "kind": "sticky", "count": 3, "done": false, "scale": 0.5, "box": [0, 0, 200, 120], "image": image, "next": p2.as_str() })),
            )?;
            tx.create_with_id("Page", &p3, fields(json!({ "name": "Page 3", "kind": "frame", "count": 0, "done": true, "scale": -2.25, "box": {} })))?;
            for (index, page) in [&p1, &p2, &p3].into_iter().enumerate() {
                tx.list_insert(&board, "pages", index, page)?;
            }
            let first = tx.tree_create(&board, "outline", None, &p1)?;
            tx.tree_create(&board, "outline", None, &p3)?;
            tx.tree_create(&board, "outline", Some(&first), &p2)?;
            tx.map_set(&board, "vars", "zoom", json!(1.5))?;
            tx.map_set(&board, "vars", "gap", json!(8))?;
            tx.text_insert(&p1, "body", 0, "Ship it")?;
            tx.text_mark(&p1, "body", 5, 7, "bold", json!(true))?;
            tx.text_insert(&p3, "body", 0, "site")?;
            tx.text_mark(&p3, "body", 0, 4, "link", json!("https://kition.ai"))?;
            // Typed and deleted: an empty text is left out.
            tx.text_insert(&board, "notes", 0, "draft")?;
            tx.text_delete(&board, "notes", 0, 5)
        })
        .unwrap();
    let written = String::from_utf8(replica.content_snapshot().unwrap()).unwrap();
    assert_eq!(written, include_str!("fixtures/content/board.content.json"));
    // Read back, it is the same document and writes the same bytes.
    let read = Replica::load(schema(), written.as_bytes(), ActorId::from_u64(2).unwrap()).unwrap();
    assert_eq!(read.state_json().unwrap(), replica.state_json().unwrap());
    assert_eq!(String::from_utf8(read.content_snapshot().unwrap()).unwrap(), written);
}

/// The snapshot the change-list fixture continues (lineage `...fe`, seq 7).
const START: &str = include_str!("fixtures/content/changes-start.content.json");

/// The canonical text of a value, keys sorted, for an assertion that shows the whole of both.
fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("JSON prints")
}

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).expect("the fixture is JSON")
}

/// The start snapshot after three transactions of actor 7 that use every kind of operation, and
/// the version before them.
fn edited() -> (Replica, Version) {
    let mut replica = Replica::load(schema(), START.as_bytes(), ActorId::from_u64(7).unwrap()).unwrap();
    let start = replica.version();
    let person = Origin::person("user:test");
    let (board, one, two, three) = (id("a1"), id("b1"), id("b2"), id("c1"));
    replica
        .transact(&person, |tx| {
            tx.create_with_id("Page", &three, fields(json!({ "name": "Three", "kind": "sticky" })))?;
            tx.list_insert(&board, "pages", 2, &three)?;
            let first = tx.tree_create(&board, "outline", None, &one)?;
            tx.tree_create(&board, "outline", None, &two)?;
            tx.tree_create(&board, "outline", Some(&first), &three)?;
            tx.set(&two, "count", json!(3))?;
            tx.set(&one, "kind", json!("frame"))?;
            tx.map_set(&board, "vars", "pad", json!(4))?;
            tx.map_delete(&board, "vars", "zoom")
        })
        .unwrap();
    replica
        .transact(&person, |tx| {
            // At the end of the bold `there`: bold expands after.
            tx.text_insert(&one, "body", 8, "!")?;
            // A character outside the BMP: one position.
            tx.text_insert(&one, "body", 0, "\u{1f600}")?;
            tx.text_delete(&one, "body", 1, 3)?;
            tx.text_mark(&one, "body", 0, 2, "link", json!("https://kition.ai"))?;
            tx.text_unmark(&one, "body", 1, 3, "bold")?;
            tx.text_insert(&board, "notes", 3, "c")?;
            tx.text_delete(&board, "notes", 1, 1)
        })
        .unwrap();
    let nodes = replica.tree(&board, "outline").unwrap();
    let node = |object: &ObjectId| nodes.iter().find(|entry| &entry.object == object).map(|entry| entry.node.clone()).expect("a node");
    let (three_node, two_node) = (node(&three), node(&two));
    replica
        .transact(&Origin::agent("agent:bot").with_label("tidy"), |tx| {
            tx.list_move(&board, "pages", 0, 2)?;
            tx.list_remove(&board, "pages", 1)?;
            tx.tree_move(&board, "outline", &three_node, None)?;
            tx.tree_delete(&board, "outline", &two_node)?;
            // A node of the outline: it leaves the tree with the object.
            tx.delete(&three)
        })
        .unwrap();
    (replica, start)
}

#[test]
fn the_start_snapshot_reads_as_its_state_fixture() {
    let replica = Replica::load(schema(), START.as_bytes(), ActorId::from_u64(7).unwrap()).unwrap();
    assert_eq!(pretty(&replica.state_json().unwrap()), pretty(&fixture(include_str!("fixtures/content/changes-start.state.json"))));
}

#[test]
fn transactions_on_the_start_snapshot_export_the_change_list_fixture_exactly() {
    let (replica, start) = edited();
    let exported: Value = serde_json::from_slice(&replica.export_changes(&start).unwrap()).expect("changes are JSON");
    assert_eq!(pretty(&exported), pretty(&fixture(include_str!("fixtures/content/changes.json"))), "the export differs from fixtures/content/changes.json");
    assert_eq!(pretty(&replica.state_json().unwrap()), pretty(&fixture(include_str!("fixtures/content/changes.state.json"))));
}

#[test]
fn a_replica_of_the_start_snapshot_imports_the_change_list_fixture_to_its_state() {
    let changes = include_bytes!("fixtures/content/changes.json");
    let mut replica = Replica::load(schema(), START.as_bytes(), ActorId::from_u64(9).unwrap()).unwrap();
    let changed = replica.import_changes(changes).unwrap();
    assert_eq!(changed.into_iter().collect::<Vec<_>>(), vec![id("a1"), id("b1"), id("b2"), id("c1")]);
    assert_eq!(pretty(&replica.state_json().unwrap()), pretty(&fixture(include_str!("fixtures/content/changes.state.json"))));
    // Importing them again changes nothing.
    assert!(replica.import_changes(changes).unwrap().is_empty());
}
