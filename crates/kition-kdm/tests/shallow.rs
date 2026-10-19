// Copied from kition-sdk crates/kition-kdm/tests/shallow.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Shallow replicas (standard 2.0 rule M16a): a device holds a large document's current state
//! with only recent history, and merges with full replicas like a full replica does.

use kition_kdm::{ActorId, DocId, KdmError, ObjectId, Origin, Replica, Version};
use serde_json::json;

mod common;
use common::{fields, page_with_shape, person, schema, schema_v2};

fn actor(n: u64) -> ActorId {
    ActorId::from_u64(n).unwrap()
}

/// A full replica with some history: a page, a shape, and a few edits to both.
fn full_with_history() -> (Replica, ObjectId, ObjectId) {
    let mut full = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    let (page, shape) = page_with_shape(&mut full);
    for x in 0..20 {
        full.transact(&person(), |tx| tx.set(&shape, "x", json!(x))).unwrap();
    }
    full.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "history")).unwrap();
    (full, page, shape)
}

/// Exchanges changes both ways until both replicas have the same version.
fn sync(a: &mut Replica, b: &mut Replica) {
    let to_b = a.export_changes(&b.version()).unwrap();
    b.import_changes(&to_b).unwrap();
    let to_a = b.export_changes(&a.version()).unwrap();
    a.import_changes(&to_a).unwrap();
    assert_eq!(a.version(), b.version());
}

#[test]
fn a_shallow_snapshot_loads_to_the_same_state_without_the_history() {
    let (full, _, _) = full_with_history();
    let bytes = full.shallow_snapshot(&full.version()).unwrap();
    let shallow = Replica::load(schema(), &bytes, actor(2)).unwrap();
    assert!(shallow.is_shallow());
    assert!(!full.is_shallow());
    assert_eq!(full.shallow_root(), None);
    assert_eq!(shallow.state_hash().unwrap(), full.state_hash().unwrap());
    assert_eq!(shallow.version(), full.version());
    assert!(shallow.version().includes(&shallow.shallow_root().unwrap()));
    assert!(bytes.len() < full.snapshot().unwrap().len(), "{} >= {}", bytes.len(), full.snapshot().unwrap().len());
}

#[test]
fn shallow_and_full_replicas_converge_both_ways() {
    let (mut full, page, shape) = full_with_history();
    let mut shallow = Replica::load(schema(), &full.shallow_snapshot(&full.version()).unwrap(), actor(2)).unwrap();
    // Concurrent edits after the root, on both sides.
    shallow.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "S:")).unwrap();
    shallow
        .transact(&person(), |tx| {
            let made = tx.create("Shape", fields(json!({ "kind": "ellipse", "x": 1, "y": 2 })))?;
            tx.list_insert(&page, "shapes", 1, &made)
        })
        .unwrap();
    full.transact(&person(), |tx| tx.set(&shape, "fill", json!("#5645d4"))).unwrap();
    full.transact(&person(), |tx| tx.text_insert(&shape, "label", 7, ":F")).unwrap();
    sync(&mut full, &mut shallow);
    assert_eq!(shallow.state_hash().unwrap(), full.state_hash().unwrap());
    assert_eq!(full.text(&shape, "label").unwrap(), "S:history:F");
    assert_eq!(full.list(&page, "shapes").unwrap().len(), 2);
    // A third, full replica that only ever talks to the shallow one gets its changes too.
    let mut other = Replica::load(schema(), &full.snapshot().unwrap(), actor(3)).unwrap();
    shallow.transact(&person(), |tx| tx.set(&shape, "y", json!(99))).unwrap();
    sync(&mut shallow, &mut other);
    sync(&mut other, &mut full);
    assert_eq!(other.state_hash().unwrap(), shallow.state_hash().unwrap());
    assert_eq!(full.state_hash().unwrap(), shallow.state_hash().unwrap());
}

#[test]
fn a_shallow_replica_keeps_the_history_after_its_root() {
    let (full, _, shape) = full_with_history();
    let middle = full.version();
    let mut full = full;
    full.transact(&person(), |tx| tx.set(&shape, "x", json!(500))).unwrap();
    full.transact(&person(), |tx| tx.set(&shape, "x", json!(600))).unwrap();
    let shallow = Replica::load(schema(), &full.shallow_snapshot(&middle).unwrap(), actor(2)).unwrap();
    assert!(shallow.is_shallow());
    assert!(shallow.version().includes(&middle));
    // Drafts fork at the current version; earlier versions are read from the server.
    let draft = shallow.fork_at(&shallow.version(), actor(4)).unwrap();
    assert!(draft.is_shallow());
    assert_eq!(draft.get(&shape, "x").unwrap(), json!(600));
    for version in [middle, Version::empty()] {
        let error = shallow.fork_at(&version, actor(5)).err().unwrap();
        assert!(matches!(error, KdmError::HistoryMissing(_)), "{error:?}");
    }
    // A snapshot of a shallow replica is shallow too, rooted where it was; a shallow snapshot
    // from before the root is clamped to it.
    let again = Replica::load(schema(), &shallow.snapshot().unwrap(), actor(6)).unwrap();
    assert_eq!(again.shallow_root(), shallow.shallow_root());
    let clamped = Replica::load(schema(), &shallow.shallow_snapshot(&Version::empty()).unwrap(), actor(7)).unwrap();
    assert_eq!(clamped.shallow_root(), shallow.shallow_root());
    assert_eq!(clamped.state_hash().unwrap(), full.state_hash().unwrap());
}

#[test]
fn an_empty_root_keeps_the_whole_history() {
    let (full, _, _) = full_with_history();
    let whole = Replica::load(schema(), &full.shallow_snapshot(&Version::empty()).unwrap(), actor(2)).unwrap();
    assert!(!whole.is_shallow());
    assert_eq!(whole.state_hash().unwrap(), full.state_hash().unwrap());
}

#[test]
fn a_shallow_snapshot_at_a_version_the_replica_lacks_is_refused() {
    let (full, _, shape) = full_with_history();
    let mut ahead = full.fork(actor(9)).unwrap();
    ahead.transact(&person(), |tx| tx.set(&shape, "x", json!(1))).unwrap();
    let error = full.shallow_snapshot(&ahead.version()).unwrap_err();
    assert!(matches!(error, KdmError::InvalidValue { .. }), "{error:?}");
}

#[test]
fn undo_reverts_the_shallow_replicas_own_changes_after_the_root() {
    let (full, _, shape) = full_with_history();
    let mut shallow = Replica::load(schema(), &full.shallow_snapshot(&full.version()).unwrap(), actor(2)).unwrap();
    // Loaded replicas start with no undo history: nothing before the root to undo.
    assert!(!shallow.can_undo());
    shallow.transact(&person(), |tx| tx.set(&shape, "x", json!(77))).unwrap();
    shallow.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "new ")).unwrap();
    assert!(shallow.undo().unwrap());
    assert!(shallow.undo().unwrap());
    assert!(!shallow.can_undo());
    assert_eq!(shallow.get(&shape, "x").unwrap(), json!(19));
    assert_eq!(shallow.text(&shape, "label").unwrap(), "history");
    assert!(shallow.redo().unwrap());
    assert_eq!(shallow.get(&shape, "x").unwrap(), json!(77));
}

#[test]
fn a_draft_of_a_shallow_replica_merges_back() {
    let (full, _, shape) = full_with_history();
    let mut shallow = Replica::load(schema(), &full.shallow_snapshot(&full.version()).unwrap(), actor(2)).unwrap();
    let mut draft = shallow.fork(actor(8)).unwrap();
    draft.transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
    let changes = draft.export_changes(&shallow.version()).unwrap();
    let changed = shallow.merge_changes(&changes, &person()).unwrap();
    assert!(changed.contains(&shape));
    assert_eq!(shallow.get(&shape, "x").unwrap(), json!(5));
}

/// A full replica that had not seen the root when it edited: its changes depend on history the
/// shallow replica does not have. The import is refused without changing anything; the server's
/// newer snapshot (rooted before those changes) takes them, and a rebase keeps the shallow
/// replica's own changes on top.
#[test]
fn changes_from_before_the_root_are_refused_and_a_rebase_takes_them() {
    let (mut server, _, shape) = full_with_history();
    let mut offline = Replica::load(schema(), &server.snapshot().unwrap(), actor(3)).unwrap();
    offline.transact(&person(), |tx| tx.set(&shape, "fill", json!("#000000"))).unwrap();
    server.transact(&person(), |tx| tx.set(&shape, "y", json!(3))).unwrap();
    let mut shallow = Replica::load(schema(), &server.shallow_snapshot(&server.version()).unwrap(), actor(2)).unwrap();
    shallow.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "mine ")).unwrap();
    let (version, state) = (shallow.version(), shallow.state_hash().unwrap());
    shallow.take_changed();

    let late = offline.export_changes(&Version::empty()).unwrap();
    let error = shallow.import_changes(&late).unwrap_err();
    assert!(matches!(error, KdmError::HistoryMissing(_)), "{error:?}");
    assert_eq!(shallow.version(), version);
    assert_eq!(shallow.state_hash().unwrap(), state);
    assert!(shallow.take_changed().is_empty());

    // The server takes the late change (it has all the history) and the shallow replica's pushed
    // change; then it answers a newer shallow snapshot.
    server.import_changes(&late).unwrap();
    let pushed = shallow.export_changes(&server.version()).unwrap();
    server.import_changes(&pushed).unwrap();
    // One more change the server does not have yet: kept by the rebase.
    shallow.transact(&person(), |tx| tx.set(&shape, "x", json!(42))).unwrap();
    let newer = server.shallow_snapshot(&server.version()).unwrap();
    let changed = shallow.rebase(&newer).unwrap();
    assert!(changed.contains(&shape));
    assert!(shallow.is_shallow());
    assert!(!shallow.can_undo());
    assert_eq!(shallow.get(&shape, "fill").unwrap(), json!("#000000"));
    assert_eq!(shallow.get(&shape, "x").unwrap(), json!(42));
    assert_eq!(shallow.text(&shape, "label").unwrap(), "mine history");
    // From here it syncs with the server as usual.
    sync(&mut shallow, &mut server);
    assert_eq!(shallow.state_hash().unwrap(), server.state_hash().unwrap());
    let more = offline.export_changes(&Version::empty()).unwrap();
    shallow.import_changes(&more).unwrap();
}

#[test]
fn a_rebase_refuses_another_document_and_a_snapshot_older_than_the_root() {
    let (mut server, _, shape) = full_with_history();
    let old = server.snapshot().unwrap();
    // Two changes after `old`: the root is at the second, so the first is in neither.
    server.transact(&person(), |tx| tx.set(&shape, "x", json!(1))).unwrap();
    server.transact(&person(), |tx| tx.set(&shape, "x", json!(2))).unwrap();
    let mut shallow = Replica::load(schema(), &server.shallow_snapshot(&server.version()).unwrap(), actor(2)).unwrap();
    let state = shallow.state_hash().unwrap();
    let error = shallow.rebase(&old).unwrap_err();
    assert!(matches!(error, KdmError::HistoryMissing(_)), "{error:?}");
    let other = Replica::create(schema(), DocId::new(), actor(4)).unwrap();
    let error = shallow.rebase(&other.snapshot().unwrap()).unwrap_err();
    assert!(matches!(error, KdmError::WrongDocument { .. }), "{error:?}");
    assert_eq!(shallow.state_hash().unwrap(), state);
    // A full snapshot is always a base it can rebase on, and leaves it full.
    shallow.transact(&person(), |tx| tx.set(&shape, "y", json!(8))).unwrap();
    shallow.rebase(&server.snapshot().unwrap()).unwrap();
    assert!(!shallow.is_shallow());
    assert_eq!(shallow.get(&shape, "y").unwrap(), json!(8));
}

#[test]
fn many_shallow_and_full_replicas_converge_in_any_delivery_order() {
    let (full, page, _) = full_with_history();
    let snapshot = full.snapshot().unwrap();
    let shallow = full.shallow_snapshot(&full.version()).unwrap();
    for seed in 0..6_u64 {
        let mut replicas: Vec<Replica> =
            (0..4_u64).map(|index| Replica::load(schema(), if index % 2 == 0 { &shallow } else { &snapshot }, actor(10 + index)).unwrap()).collect();
        let mut log: Vec<Vec<u8>> = Vec::new();
        for (index, replica) in replicas.iter_mut().enumerate() {
            let before = replica.version();
            replica
                .transact(&person(), |tx| {
                    let made = tx.create("Shape", fields(json!({ "kind": "rect", "x": index, "y": seed })))?;
                    tx.list_insert(&page, "shapes", 0, &made)?;
                    tx.set(&page, "title", json!(format!("by {index}")))
                })
                .unwrap();
            log.push(replica.export_changes(&before).unwrap());
        }
        let mut rng = kition_kdm::testing::Rng::new(seed);
        for replica in &mut replicas {
            let mut order: Vec<usize> = (0..log.len()).chain(0..log.len()).collect();
            rng.shuffle(&mut order);
            for index in order {
                replica.import_changes(&log[index]).unwrap();
            }
        }
        let hash = replicas[0].state_hash().unwrap();
        assert!(replicas.iter().all(|replica| replica.state_hash().unwrap() == hash), "seed {seed}");
        assert_eq!(replicas[0].list(&page, "shapes").unwrap().len(), 5);
    }
}

#[test]
fn a_refused_import_leaves_a_shallow_replica_unchanged_and_shallow() {
    let (mut full, page, shape) = full_with_history();
    let mut newer = Replica::load(schema_v2(), &full.snapshot().unwrap(), actor(3)).unwrap();
    let base = newer.version();
    let mut shallow = Replica::load(schema(), &full.shallow_snapshot(&full.version()).unwrap(), actor(2)).unwrap();
    shallow.transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
    shallow.take_changed();
    newer
        .transact(&Origin::system("migrate"), |tx| {
            tx.set(&page, "title", json!("Migrated"))?;
            tx.raise_schema_version(2).map(drop)
        })
        .unwrap();
    let before = (shallow.version(), shallow.state_json().unwrap(), shallow.shallow_root());
    let error = shallow.import_changes(&newer.export_changes(&base).unwrap()).unwrap_err();
    assert_eq!(error, KdmError::NewerSchema { found: 2, reads: 1 });
    assert_eq!(shallow.version(), before.0);
    assert_eq!(shallow.state_json().unwrap(), before.1);
    assert_eq!(shallow.shallow_root(), before.2);
    assert_eq!(shallow.min_schema_version(), 1);
    assert!(shallow.take_changed().is_empty());
    // It goes on syncing with replicas of its own schema.
    sync(&mut shallow, &mut full);
    assert_eq!(shallow.state_hash().unwrap(), full.state_hash().unwrap());
    assert_eq!(full.get(&shape, "x").unwrap(), json!(5));
}
