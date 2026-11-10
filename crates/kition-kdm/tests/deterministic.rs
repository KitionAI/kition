// Copied from kition-sdk crates/kition-kdm/tests/deterministic.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The same changes encode the same bytes: a JSON object value is written in one key order, not
//! in a hash map's per-process order, so a document built twice by the same commands (a showcase
//! sample, a golden case) saves the same file (kition-table#7).

mod common;

use common::{fields, person, schema};
use kition_kdm::{ActorId, DocId, ObjectId, Replica};
use serde_json::json;

fn build() -> (Vec<u8>, Vec<u8>) {
    let doc = DocId::parse("0b6f2a1e-6c1d-4f43-9a51-3c2d8f1e7a90").unwrap();
    let mut replica = Replica::create(schema(), doc, ActorId::from_u64(7).unwrap()).unwrap();
    replica
        .transact(&person(), |tx| {
            let page = tx.create_with_id("Page", &ObjectId::from_string("page-1"), fields(json!({ "title": "One" })))?;
            // A nested object with enough keys that a hash map's order varies between builds.
            let transform = json!({
                "kind": "group", "conjunction": "and", "id": "root",
                "children": [{ "kind": "condition", "field_name": "stage", "field_id": 2, "operator": "neq", "value": "Won", "id": "c1" }],
                "a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "f": 6, "g": 7, "h": 8,
            });
            let shape =
                tx.create_with_id("Shape", &ObjectId::from_string("shape-1"), fields(json!({ "kind": "rect", "x": 1, "y": 2, "transform": transform })))?;
            tx.list_insert(&page, "shapes", 0, &shape)?;
            Ok(())
        })
        .unwrap();
    (replica.snapshot().unwrap(), replica.export_changes(&kition_kdm::Version::empty()).unwrap())
}

#[test]
fn the_same_changes_encode_the_same_bytes() {
    let first = build();
    for _ in 0..50 {
        assert!(build() == first, "a build encoded other bytes");
    }
}
