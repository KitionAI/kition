// Copied from kition-sdk crates/kition-kdm/tests/version_bytes.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Equal versions encode to equal bytes (case regressions/issue-kdm-version-bytes). The engine
//! wrote a version's entries in its hash map's order, so two replicas at the same version could
//! answer different bytes, and a host comparing versions as bytes (a checkpoint at the newest
//! one's version, a write continuing the stored history) saw two versions. `Version::encode` now
//! sorts the entries by actor id; `fixtures/version-bytes.json` holds versions and their bytes,
//! and the TypeScript KDM's `test/version-bytes.test.ts` reads the same file.

use kition_kdm::{ActorId, DocId, Replica, Version};
use serde_json::{Value, json};

mod common;
use common::{fields, page_with_shape, person, schema};

fn hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap()).collect()
}

#[test]
fn a_version_encodes_its_entries_sorted_by_actor_id() {
    let cases: Value = serde_json::from_str(include_str!("fixtures/version-bytes.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let name = case["versions"].as_str().unwrap();
        let (engine_order, canonical) = (hex(case["engineOrder"].as_str().unwrap()), hex(case["canonical"].as_str().unwrap()));
        let read = Version::decode(&engine_order).unwrap();
        assert_eq!(read.encode(), canonical, "{name}");
        assert_eq!(Version::decode(&canonical).unwrap(), read, "{name}: the canonical bytes decode to the same version");
        assert_eq!(Version::decode(&canonical).unwrap().encode(), canonical, "{name}");
    }
}

#[test]
fn replicas_at_the_same_version_answer_the_same_bytes_whatever_order_they_imported_in() {
    let mut origin = Replica::create(schema(), DocId::new(), ActorId::from_u64(1).unwrap()).unwrap();
    page_with_shape(&mut origin);
    let start = origin.snapshot().unwrap();
    let base = origin.version();
    // Many writers, so the version holds many entries.
    let exports: Vec<Vec<u8>> = (0..40u64)
        .map(|writer| {
            let mut replica = Replica::load(schema(), &start, ActorId::from_u64(1_000 + writer * 7_919).unwrap()).unwrap();
            replica.transact(&person(), |tx| tx.create("Page", fields(json!({ "title": format!("page {writer}") })))).unwrap();
            replica.export_changes(&base).unwrap()
        })
        .collect();
    let mut forward = Replica::load(schema(), &start, ActorId::from_u64(2).unwrap()).unwrap();
    let mut backward = Replica::load(schema(), &start, ActorId::from_u64(3).unwrap()).unwrap();
    for export in &exports {
        forward.import_changes(export).unwrap();
    }
    for export in exports.iter().rev() {
        backward.import_changes(export).unwrap();
    }
    assert_eq!(forward.version(), backward.version());
    assert_eq!(forward.version().encode(), backward.version().encode());
    assert_eq!(Version::decode(&forward.version().encode()).unwrap(), forward.version());
}
