// Copied from kition-sdk crates/kition-kdm/tests/versions.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Incomplete imports and the partial order of versions.

use kition_kdm::{ActorId, DocId, Replica, Version};
use serde_json::json;

mod common;
use common::{fields, page_with_shape, person, schema};

fn pair() -> (Replica, Replica) {
    let mut a = Replica::create(schema(), DocId::new(), ActorId::from_u64(1).unwrap()).unwrap();
    page_with_shape(&mut a);
    let b = Replica::load(schema(), &a.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    (a, b)
}

/// Makes one change on `replica`; answers its export.
fn change(replica: &mut Replica, title: &str) -> Vec<u8> {
    let since = replica.version();
    replica.transact(&person(), |tx| tx.create("Page", fields(json!({ "title": title })))).unwrap();
    replica.export_changes(&since).unwrap()
}

#[test]
fn a_change_imported_before_its_predecessor_is_pending_until_the_predecessor_arrives() {
    let (mut a, mut b) = pair();
    assert!(!b.has_pending_changes());
    let first = change(&mut a, "first");
    let second = change(&mut a, "second");
    let before = b.state_hash().unwrap();
    b.import_changes(&second).unwrap();
    assert!(b.has_pending_changes());
    assert_eq!(b.state_hash().unwrap(), before, "a pending change is not applied");
    assert!(!b.version().includes(&a.version()));
    b.import_changes(&first).unwrap();
    assert!(!b.has_pending_changes());
    assert_eq!(b.state_hash().unwrap(), a.state_hash().unwrap());
    assert!(b.version().includes(&a.version()));
}

#[test]
fn a_complete_import_from_another_replica_leaves_a_gap_pending() {
    let (mut a, mut b) = pair();
    let mut c = Replica::load(schema(), &a.snapshot().unwrap(), ActorId::from_u64(3).unwrap()).unwrap();
    let first = change(&mut a, "first");
    let second = change(&mut a, "second");
    b.import_changes(&second).unwrap();
    let other = change(&mut c, "other");
    b.import_changes(&other).unwrap();
    assert!(b.has_pending_changes(), "another replica's change does not fill the gap");
    b.import_changes(&first).unwrap();
    assert!(!b.has_pending_changes());
}

#[test]
fn in_order_sync_never_has_pending_changes() {
    let (mut a, mut b) = pair();
    for title in ["one", "two", "three"] {
        let bytes = change(&mut a, title);
        b.import_changes(&bytes).unwrap();
        assert!(!b.has_pending_changes());
        let bytes = change(&mut b, title);
        a.import_changes(&bytes).unwrap();
        assert!(!a.has_pending_changes());
    }
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());
    // Importing changes a replica already has changes nothing and leaves nothing pending.
    b.import_changes(&a.export_changes(&Version::empty()).unwrap()).unwrap();
    assert!(!b.has_pending_changes());
}

/// A snapshot holds the changes a replica applied, not those still pending on it.
#[test]
fn a_snapshot_of_a_replica_with_pending_changes_loads_without_them() {
    let (mut a, mut b) = pair();
    let first = change(&mut a, "first");
    let second = change(&mut a, "second");
    b.import_changes(&second).unwrap();
    assert!(b.has_pending_changes());
    let mut loaded = Replica::load(schema(), &b.snapshot().unwrap(), ActorId::from_u64(4).unwrap()).unwrap();
    assert!(!loaded.has_pending_changes());
    assert_eq!(loaded.state_hash().unwrap(), b.state_hash().unwrap());
    assert_eq!(loaded.version(), b.version());
    loaded.import_changes(&first).unwrap();
    assert!(!loaded.has_pending_changes());
    assert!(!loaded.version().includes(&a.version()), "the pending change must be fetched again");
    loaded.import_changes(&second).unwrap();
    assert_eq!(loaded.state_hash().unwrap(), a.state_hash().unwrap());
}

#[test]
fn versions_include_each_other_by_the_partial_order_of_changes() {
    let (mut a, mut b) = pair();
    let empty = Version::empty();
    assert!(a.version().includes(&b.version()), "equal");
    assert!(b.version().includes(&a.version()), "equal");
    assert!(a.version().includes(&empty));
    assert!(empty.includes(&empty));
    assert!(!empty.includes(&a.version()));
    let bytes = change(&mut a, "ahead");
    assert!(a.version().includes(&b.version()), "ahead");
    assert!(!b.version().includes(&a.version()), "behind");
    change(&mut b, "concurrent");
    assert!(!a.version().includes(&b.version()), "concurrent");
    assert!(!b.version().includes(&a.version()), "concurrent");
    b.import_changes(&bytes).unwrap();
    assert!(b.version().includes(&a.version()));
    assert!(!a.version().includes(&b.version()));
    let decoded = Version::decode(&b.version().encode()).unwrap();
    assert!(decoded.includes(&b.version()) && b.version().includes(&decoded));
}
