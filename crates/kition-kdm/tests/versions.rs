// Copied from kition-sdk crates/kition-kdm/tests/versions.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Versions (plan 2026-11-24, section 1.3): a line of changes (`lineage`) and how many changes of
//! it a state holds (`seq`). Imports take changes in order only (section 1.4): a change already
//! held is skipped, the first new one must follow, anything else is stale and changes nothing.

use kition_kdm::{ActorId, DocId, KdmError, Replica, Version};
use serde_json::{Value, json};

mod common;
use common::{fields, page_with_shape, person, schema};

fn actor(n: u64) -> ActorId {
    ActorId::from_u64(n).unwrap()
}

#[test]
fn a_version_is_its_line_and_its_count_in_24_bytes() {
    let mut replica = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    let start = replica.version();
    assert_eq!(start.encode().len(), 24);
    assert_eq!(&start.encode()[16..], &0u64.to_be_bytes());
    page_with_shape(&mut replica);
    let after = replica.version();
    assert_eq!(&after.encode()[..16], &start.encode()[..16], "the same line");
    assert_eq!(&after.encode()[16..], &1u64.to_be_bytes(), "one change");
    assert_eq!(Version::decode(&after.encode()).unwrap(), after);
    assert!(Version::empty().encode().is_empty());
    assert_eq!(Version::decode(&[]).unwrap(), Version::empty());
    assert!(matches!(Version::decode(&[1, 2, 3]), Err(KdmError::Encoding(_))));
    assert!(after.includes(&start) && !start.includes(&after) && after.includes(&Version::empty()) && !Version::empty().includes(&after));
}

#[test]
fn a_new_document_a_file_and_a_copy_start_a_line_and_a_snapshot_or_a_fork_keeps_it() {
    let mut replica = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    page_with_shape(&mut replica);
    let line = |replica: &Replica| replica.version().encode()[..16].to_vec();
    let other = Replica::create(schema(), replica.doc_id(), actor(2)).unwrap();
    assert_ne!(line(&other), line(&replica));
    let file = Replica::load(schema(), &replica.content_snapshot().unwrap(), actor(3)).unwrap();
    assert_ne!(line(&file), line(&replica));
    let copy = replica.copy_as_new_document(DocId::new(), actor(4)).unwrap();
    assert_ne!(line(&copy), line(&replica));
    let stored = Replica::load(schema(), &replica.snapshot().unwrap(), actor(5)).unwrap();
    assert_eq!(stored.version(), replica.version());
    assert_eq!(replica.fork(actor(6)).unwrap().version(), replica.version());
}

#[test]
fn an_import_skips_what_it_holds_and_takes_the_rest_in_order() {
    let mut a = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    let mut b = Replica::load(schema(), &a.snapshot().unwrap(), actor(2)).unwrap();
    let start = a.version();
    let (page, _) = page_with_shape(&mut a);
    let middle = a.version();
    a.transact(&person(), |tx| tx.set(&page, "title", json!("Two"))).unwrap();
    let all = a.export_changes(&start).unwrap();
    let last = a.export_changes(&middle).unwrap();
    // The second change alone does not follow b's version: stale, nothing changes.
    let before = (b.version(), b.state_json().unwrap());
    assert!(matches!(b.import_changes(&last), Err(KdmError::Stale(_))));
    assert_eq!((b.version(), b.state_json().unwrap()), before);
    // Both, then both again: the second import holds nothing new.
    assert!(!b.import_changes(&all).unwrap().is_empty());
    assert_eq!(b.version(), a.version());
    assert!(b.import_changes(&all).unwrap().is_empty());
    assert!(b.import_changes(&last).unwrap().is_empty());
    assert_eq!(b.state_json().unwrap(), a.state_json().unwrap());
    // Since the current version, an export holds no change.
    let none: Value = serde_json::from_slice(&a.export_changes(&a.version()).unwrap()).unwrap();
    assert_eq!(none["changes"], json!([]));
}

#[test]
fn changes_that_went_another_way_from_one_version_are_stale() {
    let mut a = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    let mut b = Replica::load(schema(), &a.snapshot().unwrap(), actor(2)).unwrap();
    let start = a.version();
    a.transact(&person(), |tx| tx.create("Page", fields(json!({ "title": "A" })))).unwrap();
    b.transact(&person(), |tx| tx.create("Page", fields(json!({ "title": "B" })))).unwrap();
    assert_eq!(a.version(), b.version(), "the same version, other changes");
    let before = (b.version(), b.state_json().unwrap());
    assert!(matches!(b.import_changes(&a.export_changes(&start).unwrap()), Err(KdmError::Stale(_))));
    a.transact(&person(), |tx| tx.create("Page", fields(json!({ "title": "A2" })))).unwrap();
    assert!(matches!(b.import_changes(&a.export_changes(&b.version()).unwrap()), Err(KdmError::Stale(_))));
    assert_eq!((b.version(), b.state_json().unwrap()), before);
    // Another line's snapshot is stale too, once a replica has changes of its own.
    let other = Replica::create(schema(), a.doc_id(), actor(3)).unwrap();
    assert!(matches!(b.import_changes(&other.snapshot().unwrap()), Err(KdmError::Stale(_))));
}

#[test]
fn a_snapshot_ahead_on_the_line_replaces_the_state_and_tells_what_changed() {
    let mut a = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    let mut b = Replica::load(schema(), &a.snapshot().unwrap(), actor(2)).unwrap();
    let (page, shape) = page_with_shape(&mut a);
    let changed = b.import_changes(&a.snapshot().unwrap()).unwrap();
    assert!(changed.contains(&page) && changed.contains(&shape));
    assert_eq!((b.version(), b.state_json().unwrap()), (a.version(), a.state_json().unwrap()));
    // A snapshot behind it is stale; its own is nothing new.
    let behind = b.snapshot().unwrap();
    a.transact(&person(), |tx| tx.set(&page, "title", json!("Later"))).unwrap();
    b.import_changes(&a.export_changes(&b.version()).unwrap()).unwrap();
    assert!(matches!(b.import_changes(&behind), Err(KdmError::Stale(_))));
    assert!(b.import_changes(&b.snapshot().unwrap()).unwrap().is_empty());
}
