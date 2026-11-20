// Copied from kition-sdk crates/kition-kdm/tests/shallow_export.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! regressions/issue-kdm-shallow-export: a shallow replica (rule M16a) answers every change it has
//! in bytes `Replica::load` opens. Asked for its changes since a version that does not reach its
//! root (the empty version above all: "every change"), it answers its shallow snapshot, its state
//! with the history it keeps. Before, it answered only the changes after its root, without the
//! state at the root, which `load` refused ("meta.kit is missing"): a file forked as a new document
//! (`copy_as_new_document`, `document.fork`) then failed the object model over the change exchange
//! (`model.batch`) and agent drafts (`model.export` then `model.open`).

use kition_kdm::{ActorId, DocId, Replica, Version};
use serde_json::json;

mod common;
use common::{page_with_shape, person, schema};

fn actor(n: u64) -> ActorId {
    ActorId::from_u64(n).unwrap()
}

/// A document with history, edited after a copy as a new document is made of it: answers the
/// copy (shallow, rooted at its own first change), edited once, and its shape.
fn edited_copy() -> (Replica, kition_kdm::ObjectId) {
    let mut source = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    let (_, shape) = page_with_shape(&mut source);
    for x in 0..5 {
        source.transact(&person(), |tx| tx.set(&shape, "x", json!(x))).unwrap();
    }
    let mut copy = source.copy_as_new_document(DocId::new(), actor(2)).unwrap();
    copy.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "forked")).unwrap();
    (copy, shape)
}

/// `bytes` load as `replica`'s document: the same id, state, version and root.
fn loads_as(replica: &Replica, bytes: &[u8], by: ActorId) -> Replica {
    let loaded = Replica::load(schema(), bytes, by).unwrap_or_else(|error| panic!("the export does not load: {error}"));
    assert_eq!(loaded.doc_id(), replica.doc_id());
    assert_eq!(loaded.state_hash().unwrap(), replica.state_hash().unwrap());
    assert_eq!(loaded.version(), replica.version());
    assert_eq!(loaded.shallow_root(), replica.shallow_root());
    loaded
}

#[test]
fn a_fresh_copy_exports_every_change_as_bytes_that_load() {
    let mut source = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    page_with_shape(&mut source);
    let copy = source.copy_as_new_document(DocId::new(), actor(2)).unwrap();
    assert!(copy.is_shallow());
    let all = copy.export_changes(&Version::empty()).unwrap();
    assert!(loads_as(&copy, &all, actor(3)).is_shallow());
}

#[test]
fn an_edited_copy_exports_every_change_as_bytes_that_load_and_keep_syncing() {
    let (mut copy, shape) = edited_copy();
    let mut other = loads_as(&copy, &copy.export_changes(&Version::empty()).unwrap(), actor(3));
    // From there the two exchange changes as any two replicas do.
    other.transact(&person(), |tx| tx.set(&shape, "y", json!(42))).unwrap();
    copy.transact(&person(), |tx| tx.set(&shape, "x", json!(7))).unwrap();
    copy.import_changes(&other.export_changes(&copy.version()).unwrap()).unwrap();
    other.import_changes(&copy.export_changes(&other.version()).unwrap()).unwrap();
    assert_eq!(copy.state_hash().unwrap(), other.state_hash().unwrap());
    assert_eq!(copy.get(&shape, "y").unwrap(), json!(42));
    assert_eq!(other.get(&shape, "x").unwrap(), json!(7));
    // Asked again for every change, either answers bytes that load.
    loads_as(&other, &other.export_changes(&Version::empty()).unwrap(), actor(4));
}

#[test]
fn a_shallow_snapshot_replica_exports_every_change_as_bytes_that_load() {
    let mut full = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    let (_, shape) = page_with_shape(&mut full);
    for x in 0..10 {
        full.transact(&person(), |tx| tx.set(&shape, "x", json!(x))).unwrap();
    }
    let middle = full.version();
    full.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "after")).unwrap();
    let mut shallow = Replica::load(schema(), &full.shallow_snapshot(&middle).unwrap(), actor(2)).unwrap();
    shallow.transact(&person(), |tx| tx.set(&shape, "y", json!(5))).unwrap();
    let all = shallow.export_changes(&Version::empty()).unwrap();
    loads_as(&shallow, &all, actor(3));
    // A full replica that has the root takes the same bytes as changes, as from any replica.
    full.import_changes(&all).unwrap();
    assert_eq!(full.state_hash().unwrap(), shallow.state_hash().unwrap());
    assert!(!full.is_shallow());
    // Changes since a version at or after the root are the changes, as before.
    let since = shallow.version();
    shallow.transact(&person(), |tx| tx.set(&shape, "y", json!(6))).unwrap();
    full.import_changes(&shallow.export_changes(&since).unwrap()).unwrap();
    assert_eq!(full.get(&shape, "y").unwrap(), json!(6));
}

#[test]
fn a_full_replica_still_exports_every_change_as_changes() {
    let mut full = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    page_with_shape(&mut full);
    let all = full.export_changes(&Version::empty()).unwrap();
    let loaded = loads_as(&full, &all, actor(2));
    assert!(!loaded.is_shallow());
    // The bytes are the change export, not a snapshot.
    assert_ne!(all, full.snapshot().unwrap());
}

/// An agent's draft of a forked document, as a host makes it from `model.export`: the draft opens,
/// edits, merges back as one step, and the fork's undo takes the merge back.
#[test]
fn a_draft_opened_from_a_copys_export_merges_back() {
    let (mut copy, shape) = edited_copy();
    let mut draft = loads_as(&copy, &copy.export_changes(&Version::empty()).unwrap(), actor(5));
    let base = draft.version();
    draft.transact(&person(), |tx| tx.set(&shape, "fill", json!("#123456"))).unwrap();
    // A draft of the draft too: every replica of the document answers bytes that load.
    loads_as(&draft, &draft.export_changes(&Version::empty()).unwrap(), actor(6));
    let changed = copy.merge_changes(&draft.export_changes(&base).unwrap(), &person()).unwrap();
    assert!(changed.contains(&shape));
    assert_eq!(copy.get(&shape, "fill").unwrap(), json!("#123456"));
    assert!(copy.undo().unwrap());
    assert_eq!(copy.get(&shape, "fill").unwrap(), copy.fork(actor(7)).unwrap().get(&shape, "fill").unwrap());
    assert_ne!(copy.get(&shape, "fill").unwrap(), json!("#123456"));
}

/// Two replicas of one forked document: undo after a load, a fork, a rebase on the other's
/// snapshot, and merged drafts all work as on a full document.
#[test]
fn two_replicas_of_a_fork_undo_fork_rebase_and_merge() {
    let (copy, shape) = edited_copy();
    let mut a = loads_as(&copy, &copy.snapshot().unwrap(), actor(10));
    let mut b = loads_as(&copy, &copy.export_changes(&Version::empty()).unwrap(), actor(11));
    assert!(!a.can_undo() && !b.can_undo(), "a load starts with empty undo");
    a.transact(&person(), |tx| tx.set(&shape, "x", json!(100))).unwrap();
    assert!(a.undo().unwrap());
    assert_eq!(a.get(&shape, "x").unwrap(), copy.get(&shape, "x").unwrap());
    assert!(a.redo().unwrap());
    b.transact(&person(), |tx| tx.set(&shape, "y", json!(200))).unwrap();
    // b rebases on a's snapshot, keeping its own change on top.
    b.rebase(&a.snapshot().unwrap()).unwrap();
    assert_eq!(b.get(&shape, "x").unwrap(), json!(100));
    assert_eq!(b.get(&shape, "y").unwrap(), json!(200));
    // a takes b's work as a draft merge.
    let mut draft = b.fork(actor(12)).unwrap();
    let base = draft.version();
    draft.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "draft ")).unwrap();
    a.import_changes(&b.export_changes(&a.version()).unwrap()).unwrap();
    a.merge_changes(&draft.export_changes(&base).unwrap(), &person()).unwrap();
    b.import_changes(&a.export_changes(&b.version()).unwrap()).unwrap();
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());
    assert_eq!(a.text(&shape, "label").unwrap(), "draft forked");
}
