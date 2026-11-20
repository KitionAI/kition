// Copied from kition-sdk crates/kition-kdm/tests/whole_history.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Whether a replica carries the document's whole history (`Replica::carries_whole_history`, data
//! model "A copy is a new document", sync protocol S20): a full replica does, and so does a shallow
//! one rooted at the document's birth (a copy made by `Replica::copy_as_new_document` and every
//! replica loaded from it), because no replica of that document can hold history before it. A
//! replica truncated later does not. The birth is read from the replica's state at its root, so no
//! change after the root can claim another one.

use kition_kdm::{ActorId, DocId, Replica, Version};
use loro::{ExportMode, LoroDoc, LoroValue, VersionVector};
use serde_json::json;

mod common;
use common::{envelope, page_with_shape, person, schema};

fn actor(n: u64) -> ActorId {
    ActorId::from_u64(n).unwrap()
}

fn load(bytes: &[u8], n: u64) -> Replica {
    Replica::load(schema(), bytes, actor(n)).unwrap()
}

/// A full document with a page and a shape, edited twice.
fn source() -> (Replica, kition_kdm::ObjectId) {
    let mut source = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    let (_, shape) = page_with_shape(&mut source);
    source.transact(&person(), |tx| tx.set(&shape, "x", json!(11))).unwrap();
    (source, shape)
}

/// The engine document inside a KDM export, with its envelope's docId.
fn engine(bytes: &[u8]) -> (DocId, LoroDoc) {
    let id = DocId::parse(&uuid::Uuid::from_slice(&bytes[4..20]).unwrap().to_string()).unwrap();
    let doc = LoroDoc::new();
    doc.import(&bytes[20..]).unwrap();
    (id, doc)
}

/// A shallow snapshot of `doc` rooted at its current version, under `id`.
fn shallow_now(id: &DocId, doc: &LoroDoc) -> Vec<u8> {
    envelope(id, &doc.export(ExportMode::shallow_snapshot(&doc.oplog_frontiers())).unwrap())
}

/// Writes `value` as the recorded birth in its own change, by `peer`, as a client that bypasses
/// KDM would.
fn write_birth(doc: &LoroDoc, peer: u64, value: &VersionVector) {
    doc.set_peer_id(peer).unwrap();
    doc.get_map("birth").insert("root", LoroValue::Binary(value.encode().into())).unwrap();
    doc.commit();
}

#[test]
fn a_full_replica_carries_the_whole_history() {
    let (source, _) = source();
    assert!(!source.is_shallow());
    assert!(source.carries_whole_history());
    assert!(load(&source.snapshot().unwrap(), 2).carries_whole_history());
    assert!(load(&source.export_changes(&Version::empty()).unwrap(), 2).carries_whole_history());
}

#[test]
fn a_shallow_replica_of_a_created_document_does_not() {
    let (source, _) = source();
    let shallow = load(&source.shallow_snapshot(&source.version()).unwrap(), 2);
    assert!(shallow.is_shallow());
    assert!(!shallow.carries_whole_history());
    assert!(!load(&shallow.snapshot().unwrap(), 3).carries_whole_history());
}

#[test]
fn a_copy_is_rooted_at_its_birth_and_carries_the_whole_history() {
    let (source, shape) = source();
    let copy = source.copy_as_new_document(DocId::new(), actor(5)).unwrap();
    assert!(copy.is_shallow());
    assert!(copy.carries_whole_history());
    // Every replica loaded from it, its snapshot after edits, its changes and its drafts carry it.
    let mut other = load(&copy.snapshot().unwrap(), 6);
    assert!(other.carries_whole_history());
    other.transact(&person(), |tx| tx.set(&shape, "y", json!(3))).unwrap();
    let edited = load(&other.snapshot().unwrap(), 7);
    assert!(edited.carries_whole_history());
    assert_eq!(edited.shallow_root(), copy.shallow_root());
    assert!(load(&other.export_changes(&Version::empty()).unwrap(), 8).carries_whole_history());
    assert!(other.fork(actor(9)).unwrap().carries_whole_history());
    // A shallow snapshot at or before its root keeps the root.
    assert!(load(&other.shallow_snapshot(&Version::empty()).unwrap(), 10).carries_whole_history());
    assert!(load(&other.shallow_snapshot(&copy.version()).unwrap(), 10).carries_whole_history());
}

#[test]
fn a_copy_truncated_after_more_edits_does_not() {
    let (source, shape) = source();
    let mut copy = source.copy_as_new_document(DocId::new(), actor(5)).unwrap();
    copy.transact(&person(), |tx| tx.set(&shape, "x", json!(12))).unwrap();
    let truncated = load(&copy.shallow_snapshot(&copy.version()).unwrap(), 6);
    assert!(truncated.is_shallow());
    assert_ne!(truncated.shallow_root(), copy.shallow_root());
    assert!(!truncated.carries_whole_history());
    assert!(!load(&truncated.snapshot().unwrap(), 7).carries_whole_history());
    // The copy itself still does.
    assert!(copy.carries_whole_history());
}

#[test]
fn a_copy_of_a_copy_or_of_a_truncated_replica_has_its_own_birth() {
    let (source, shape) = source();
    let mut copy = source.copy_as_new_document(DocId::new(), actor(5)).unwrap();
    copy.transact(&person(), |tx| tx.set(&shape, "x", json!(12))).unwrap();
    let again = copy.copy_as_new_document(DocId::new(), actor(5)).unwrap();
    assert!(again.carries_whole_history());
    assert_ne!(again.shallow_root(), copy.shallow_root());
    assert!(load(&again.snapshot().unwrap(), 6).carries_whole_history());
    let truncated = load(&copy.shallow_snapshot(&copy.version()).unwrap(), 7);
    let rescued = truncated.copy_as_new_document(DocId::new(), actor(7)).unwrap();
    assert!(rescued.carries_whole_history());
    // An actor that already wrote to the source makes the copy too.
    let mut busy = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    page_with_shape(&mut busy);
    assert!(busy.copy_as_new_document(DocId::new(), actor(1)).unwrap().carries_whole_history());
}

#[test]
fn a_later_change_claiming_another_birth_is_not_honoured() {
    let (source, shape) = source();
    let mut copy = source.copy_as_new_document(DocId::new(), actor(5)).unwrap();
    copy.transact(&person(), |tx| tx.set(&shape, "x", json!(12))).unwrap();
    let (id, doc) = engine(&copy.snapshot().unwrap());

    // Claims the current version as the birth, edits on, then truncates there: the root is after
    // the claim's own change, so the claim names a version before the root.
    let claimed = doc.oplog_vv();
    write_birth(&doc, 40, &claimed);
    doc.get_map("objects").insert("tamper", 1).unwrap();
    doc.commit();
    let after_claim = load(&shallow_now(&id, &doc), 41);
    assert!(after_claim.is_shallow());
    assert!(!after_claim.carries_whole_history());

    // Truncates at the claimed version: the state there holds the copy's birth, not the claim.
    let at_claim = envelope(&id, &doc.export(ExportMode::shallow_snapshot(&doc.vv_to_frontiers(&claimed))).unwrap());
    assert!(!load(&at_claim, 42).carries_whole_history());

    // An honestly truncated replica whose later change claims its root: the root's state still
    // records the copy's birth, and a later change never counts.
    let truncated = copy.shallow_snapshot(&copy.version()).unwrap();
    let (id, doc) = engine(&truncated);
    let root = doc.shallow_since_vv().to_vv();
    write_birth(&doc, 43, &root);
    let claimed_root = load(&envelope(&id, &doc.export(ExportMode::Snapshot).unwrap()), 44);
    assert!(claimed_root.is_shallow());
    assert!(!claimed_root.carries_whole_history());
}

#[test]
fn a_change_recording_its_own_root_is_a_birth() {
    // The bytes decide, so a change that records the root it ends at is a birth, as a copy's first
    // change is: whoever makes one declares a new document under that docId, as a full snapshot of
    // other content under that docId would (the room's first state is its creator's to give). What
    // no client can do is make a replica truncated after its birth carry a claim that counts.
    let (source, _) = source();
    let (id, doc) = engine(&source.snapshot().unwrap());
    let mut root = doc.oplog_vv();
    root.insert(60, 0);
    write_birth(&doc, 60, &root);
    let declared = load(&shallow_now(&id, &doc), 61);
    assert!(declared.is_shallow());
    assert!(declared.carries_whole_history());
}

#[test]
fn a_later_change_to_the_birth_of_a_copy_keeps_it_whole() {
    // The predicate reads the root's state alone: a change after the root, even one that rewrites
    // the recorded birth, never makes a birth-rooted replica stop carrying its whole history (a
    // pushed change could otherwise make a room's own document unloadable).
    let (source, _) = source();
    let copy = source.copy_as_new_document(DocId::new(), actor(5)).unwrap();
    let (id, doc) = engine(&copy.snapshot().unwrap());
    write_birth(&doc, 40, &VersionVector::default());
    let rewritten = load(&envelope(&id, &doc.export(ExportMode::Snapshot).unwrap()), 41);
    assert!(rewritten.carries_whole_history());
}

#[test]
fn a_shallow_document_without_a_recorded_birth_does_not() {
    // Copies made before the birth was recorded (board 0.1.4-dev builds only) carry none.
    let (source, _) = source();
    let (_, doc) = engine(&source.snapshot().unwrap());
    let new_id = DocId::new();
    doc.set_peer_id(50).unwrap();
    doc.get_map("meta").insert("docId", new_id.to_string()).unwrap();
    doc.commit();
    let bytes = envelope(&new_id, &doc.export(ExportMode::shallow_snapshot(&doc.oplog_frontiers())).unwrap());
    let old_copy = load(&bytes, 51);
    assert!(old_copy.is_shallow());
    assert!(!old_copy.carries_whole_history());
}

#[test]
fn bytes_tell_the_same_without_a_schema() {
    let (source, shape) = source();
    let full = |bytes: &[u8]| Replica::snapshot_carries_whole_history(bytes).unwrap();
    assert!(full(&source.snapshot().unwrap()));
    assert!(full(&source.export_changes(&Version::empty()).unwrap()));
    assert!(!full(&source.shallow_snapshot(&source.version()).unwrap()));
    let mut copy = source.copy_as_new_document(DocId::new(), actor(5)).unwrap();
    assert!(full(&copy.snapshot().unwrap()));
    copy.transact(&person(), |tx| tx.set(&shape, "x", json!(12))).unwrap();
    assert!(full(&copy.snapshot().unwrap()));
    assert!(full(&copy.export_changes(&Version::empty()).unwrap()));
    assert!(!full(&copy.shallow_snapshot(&copy.version()).unwrap()));
    assert!(matches!(Replica::snapshot_carries_whole_history(b"not a KDM export"), Err(kition_kdm::KdmError::Encoding(_))));
}
