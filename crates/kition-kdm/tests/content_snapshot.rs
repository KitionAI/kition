// Copied from kition-sdk crates/kition-kdm/tests/content_snapshot.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! What a content snapshot holds (data model, "A file holds no history"):
//! `Replica::content_snapshot` seals the replica and answers its state with, of the history, only
//! the seal. The TypeScript `packages/kdm/test/content-snapshot.test.ts` tests the same.
//!
//! The content needles below are written once each and share no run of four characters with
//! anything else in the document, so the engine's compression keeps each one literal in the bytes
//! that hold it: every test checks the full snapshot holds them (the control) before it checks a
//! content snapshot does not. Commit messages are stored in a form a byte search does not always
//! find, so the origins are checked through the engine: the content snapshot's history holds one
//! change, the seal. Their bytes are searched as well.

use kition_kdm::{ActorId, DocId, KdmError, ObjectId, Origin, OriginKind, Replica};
use loro::{ContainerTrait, LoroDoc, ValueOrContainer, VersionVector};
use serde_json::json;

mod common;
use common::{fields, page_with_shape, person, schema};

const DELETED_OBJECT: &str = "Qv7Zp9Wm2Rk5";
const DELETED_TEXT: &str = "Jx4Hb8Ty3Nc6";
const OVERWRITTEN: &str = "Ug5Le1Fo0Dw4";
// Principals are searched for by their own part: `user:` itself occurs elsewhere.
const DELETER: &str = "Wk3Rf8Yb1Qz";
const TYPIST: &str = "Hs6Pn2Dc9Lx";
const TYPIST_LABEL: &str = "Ty5Ga1Ve7Oj";
const AGENT: &str = "Mz8Cu4Ki0Ef";
const AGENT_LABEL: &str = "Rb2Wn6Xs3Ip";
const LAST: &str = "Vy9Jt4Sa7Gm";
const LAST_LABEL: &str = "Ze3Ko8Ux2Bh";
const CONTENT: [&str; 3] = [DELETED_OBJECT, DELETED_TEXT, OVERWRITTEN];
const ORIGINS: [&str; 5] = [DELETER, TYPIST, TYPIST_LABEL, AGENT, AGENT_LABEL];

fn actor(n: u64) -> ActorId {
    ActorId::from_u64(n).unwrap()
}

fn load(bytes: &[u8], n: u64) -> Replica {
    Replica::load(schema(), bytes, actor(n)).unwrap()
}

fn contains(bytes: &[u8], needle: &[u8]) -> bool {
    bytes.windows(needle.len()).any(|window| window == needle)
}

fn utf16(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

/// A document whose history holds a deleted object, typed-then-deleted text and an overwritten
/// value, by two replicas: `a` (actor 1) has imported `b`'s (actor 2) changes, so with `last_edit`
/// its version has one head (its own person's edit after the import), and without, two concurrent
/// ones. Answers `(a, b, page, shape)`.
fn history(last_edit: bool) -> (Replica, Replica, ObjectId, ObjectId) {
    let mut a = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    let (page, shape) = page_with_shape(&mut a);
    let deleter = Origin::person(format!("user:{DELETER}"));
    let gone = a.transact(&deleter, |tx| tx.create("Shape", fields(json!({ "kind": "rect", "x": 1, "y": 2, "fill": DELETED_OBJECT })))).unwrap();
    a.transact(&deleter, |tx| tx.delete(&gone)).unwrap();
    let mut b = load(&a.snapshot().unwrap(), 2);
    let typist = Origin::person(format!("user:{TYPIST}")).with_label(TYPIST_LABEL);
    a.transact(&typist, |tx| tx.text_insert(&shape, "label", 0, DELETED_TEXT)).unwrap();
    a.transact(&typist, |tx| tx.text_delete(&shape, "label", 0, DELETED_TEXT.len())).unwrap();
    let agent = Origin::agent(format!("agent:{AGENT}")).with_label(AGENT_LABEL);
    b.transact(&agent, |tx| tx.set(&shape, "fill", json!(OVERWRITTEN))).unwrap();
    b.transact(&agent, |tx| tx.set(&shape, "fill", json!("plain"))).unwrap();
    a.import_changes(&b.export_changes(&a.version()).unwrap()).unwrap();
    if last_edit {
        let last = Origin::person(format!("user:{LAST}")).with_label(LAST_LABEL);
        a.transact(&last, |tx| tx.set(&shape, "x", json!(99))).unwrap();
    }
    (a, b, page, shape)
}

/// The engine document inside a KDM export.
fn engine(bytes: &[u8]) -> LoroDoc {
    let doc = LoroDoc::new();
    doc.import(&bytes[20..]).unwrap();
    doc
}

/// The changes a KDM export holds, read through the engine: each one's commit message.
fn messages(bytes: &[u8]) -> Vec<String> {
    let doc = engine(bytes);
    doc.export_json_updates(&VersionVector::default(), &doc.oplog_vv()).changes.into_iter().map(|change| change.msg.unwrap_or_default()).collect()
}

fn holds_no_history(last_edit: bool) {
    let (mut a, ..) = history(last_edit);
    assert!(!a.is_sealed());
    let full = a.snapshot().unwrap();
    for needle in CONTENT {
        assert!(contains(&full, needle.as_bytes()), "the control: the full snapshot holds {needle}");
    }
    let mut needles: Vec<&str> = CONTENT.iter().chain(ORIGINS.iter()).copied().collect();
    if last_edit {
        needles.extend([LAST, LAST_LABEL]);
    }
    let origins = messages(&full).join("\n");
    for needle in &needles[CONTENT.len()..] {
        assert!(origins.contains(needle), "the control: the full history names {needle}");
    }
    let content = a.content_snapshot().unwrap();
    for needle in &needles {
        assert!(!contains(&content, needle.as_bytes()), "{needle}");
        assert!(!contains(&content, &utf16(needle)), "{needle} (UTF-16)");
    }
    // Of the history, the engine reads one change: the seal.
    let held = messages(&content);
    assert_eq!(held.len(), 1, "{held:?}");
    let (origin, _) = Origin::decode_commit(&held[0]).unwrap();
    assert_eq!(origin, Origin::system("content-seal"));
    assert_eq!(origin.kind, OriginKind::System);
    // Its timestamp is zero: the KDM records no times.
    let doc = engine(&content);
    let changes = doc.export_json_updates(&VersionVector::default(), &doc.oplog_vv()).changes;
    assert_eq!(changes[0].timestamp, 0);
    // The full snapshot taken after holds the seal on top of every earlier change.
    assert!(messages(&a.snapshot().unwrap()).len() > 5);
}

#[test]
fn a_content_snapshot_of_one_head_holds_no_deleted_content_overwritten_value_or_origin() {
    holds_no_history(true);
}

#[test]
fn a_content_snapshot_of_two_concurrent_heads_holds_no_deleted_content_overwritten_value_or_origin() {
    holds_no_history(false);
}

#[test]
fn a_content_snapshot_loads_as_the_same_document_edits_and_merges_with_a_full_replica() {
    let (mut a, _, page, shape) = history(false);
    let content = a.content_snapshot().unwrap();
    let mut file = load(&content, 3);
    assert_eq!(file.doc_id(), a.doc_id());
    assert!(file.is_shallow());
    assert_eq!(file.version(), a.version());
    assert_eq!(file.state_hash().unwrap(), a.state_hash().unwrap());
    assert_eq!(file.objects_of_type("Shape"), a.objects_of_type("Shape"));
    assert_eq!(file.list(&page, "shapes").unwrap(), vec![shape.clone()]);
    // What survives of who wrote what: the actor (peer) ids inside element ids.
    let doc = engine(&content);
    let Some(ValueOrContainer::Container(object)) = doc.get_map("objects").get(&shape.to_string()) else { panic!("the shape is a container") };
    let cid = object.id().to_string();
    assert_eq!(&cid[cid.find('@').unwrap() + 1..cid.rfind(':').unwrap()], "1", "{cid}");
    // New edits on the file's replica, and changes made after the seal by the full one, cross.
    let since = a.version();
    file.transact(&person(), |tx| tx.set(&shape, "y", json!(7))).unwrap();
    a.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "after")).unwrap();
    a.import_changes(&file.export_changes(&since).unwrap()).unwrap();
    file.import_changes(&a.export_changes(&file.version()).unwrap()).unwrap();
    assert_eq!(file.state_hash().unwrap(), a.state_hash().unwrap());
    assert_eq!(file.get(&shape, "y").unwrap(), json!(7));
    assert_eq!(file.text(&shape, "label").unwrap(), "after");
}

#[test]
fn a_content_snapshot_refuses_changes_that_depend_on_history_before_the_seal() {
    let (mut a, mut b, _, shape) = history(false);
    let before = b.version();
    let mut file = load(&a.content_snapshot().unwrap(), 3);
    let state = file.state_hash().unwrap();
    // b did not see the seal: its next change is concurrent with it.
    b.transact(&person(), |tx| tx.set(&shape, "y", json!(1))).unwrap();
    assert!(matches!(file.import_changes(&b.export_changes(&before).unwrap()), Err(KdmError::HistoryMissing(_))));
    assert_eq!(file.state_hash().unwrap(), state);
}

#[test]
fn a_content_snapshot_commits_nothing_and_answers_the_same_bytes_when_nothing_changed() {
    let (mut a, ..) = history(false);
    let first = a.content_snapshot().unwrap();
    let version = a.version();
    assert!(a.is_sealed());
    assert!(!a.seal().unwrap());
    assert_eq!(a.content_snapshot().unwrap(), first);
    assert_eq!(a.version(), version);
    // A replica loaded from it is sealed too: it commits nothing and answers the same bytes (the
    // bytes it was loaded from: the engine would write a reloaded document's version vectors in
    // another order), every time, and so does one loaded from those.
    let mut file = load(&first, 3);
    assert!(file.is_sealed());
    assert_eq!(file.content_snapshot().unwrap(), first);
    assert_eq!(file.version(), version);
    assert_eq!(file.content_snapshot().unwrap(), first);
    assert_eq!(load(&first, 4).sealed_content_snapshot().unwrap(), first);
    // Once it changes, its content is its own again.
    let shape = file.objects_of_type("Shape").into_iter().next().unwrap();
    file.transact(&person(), |tx| tx.set(&shape, "x", json!(77))).unwrap();
    let changed = file.content_snapshot().unwrap();
    assert_ne!(changed, first);
    assert_eq!(load(&changed, 5).get(&shape, "x").unwrap(), json!(77));
}

/// Reading a replica's whole state between two saves changes nothing in what it saves: a replica
/// loaded from a file or a snapshot holds the engine's encoded state until something reads it,
/// and the content snapshot is the same bytes whether it was read or not (kition-layout's
/// unchanged save after `state_hash`).
#[test]
fn an_unchanged_content_snapshot_is_the_same_bytes_after_the_whole_state_is_read() {
    let (mut a, _, _, shape) = history(false);
    let content = a.content_snapshot().unwrap();
    let full = a.snapshot().unwrap();
    for (bytes, n) in [(&content, 3), (&full, 4)] {
        let mut replica = load(bytes, n);
        replica.transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
        replica.seal().unwrap();
        let first = replica.sealed_content_snapshot().unwrap();
        replica.state_json().unwrap();
        replica.state_hash().unwrap();
        assert_eq!(replica.sealed_content_snapshot().unwrap(), first, "after reading the state of a replica loaded from {n}");
        // The same edit on a replica whose state was read before the first save: the same bytes.
        let mut read = load(bytes, n);
        read.state_hash().unwrap();
        read.transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
        read.seal().unwrap();
        assert_eq!(read.sealed_content_snapshot().unwrap(), first, "whether or not the state was read first");
    }
    a.state_hash().unwrap();
    assert_eq!(a.sealed_content_snapshot().unwrap(), content, "and from the live replica");
    // A replica made here that has imported nothing and whose state nobody read yet.
    let mut fresh = Replica::create(schema(), DocId::new(), actor(6)).unwrap();
    page_with_shape(&mut fresh);
    let first = fresh.content_snapshot().unwrap();
    fresh.state_json().unwrap();
    assert_eq!(fresh.sealed_content_snapshot().unwrap(), first, "and from a replica made here");
    assert_eq!(load(&first, 7).state_json().unwrap(), fresh.state_json().unwrap());
}

#[test]
fn a_replica_seals_again_after_an_edit_but_not_after_importing_another_replicas_seal() {
    let (mut a, mut b, _, shape) = history(false);
    a.content_snapshot().unwrap();
    let sealed = a.version();
    a.transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
    assert!(!a.is_sealed());
    assert!(a.seal().unwrap());
    // Another replica's seal, imported alone, is the head: nothing to seal.
    b.import_changes(&a.export_changes(&b.version()).unwrap()).unwrap();
    assert!(b.is_sealed());
    assert!(!b.seal().unwrap());
    assert!(a.version().includes(&sealed));
}

#[test]
fn a_sealed_content_snapshot_refuses_a_replica_that_is_not_sealed() {
    let (mut a, ..) = history(true);
    assert!(matches!(a.sealed_content_snapshot(), Err(KdmError::InvalidValue { .. })));
    a.seal().unwrap();
    assert_eq!(a.sealed_content_snapshot().unwrap(), a.content_snapshot().unwrap());
}

#[test]
fn a_seal_is_no_undo_step() {
    let (mut a, _, _, shape) = history(false);
    let mut file = load(&a.content_snapshot().unwrap(), 3);
    file.transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
    file.content_snapshot().unwrap();
    assert!(file.undo().unwrap());
    assert_eq!(file.get(&shape, "x").unwrap(), json!(10));
    assert!(!file.can_undo());
    assert!(file.redo().unwrap());
    assert_eq!(file.get(&shape, "x").unwrap(), json!(5));
}

#[test]
fn a_content_snapshot_is_deterministic_for_one_replica_not_across_histories() {
    let mut one = Replica::create(schema(), DocId::new(), actor(5)).unwrap();
    let (_, shape) = page_with_shape(&mut one);
    let mut two = load(&one.snapshot().unwrap(), 6);
    one.transact(&person(), |tx| tx.set(&shape, "x", json!(3))).unwrap();
    two.transact(&person(), |tx| tx.set(&shape, "x", json!(4))).unwrap();
    two.transact(&person(), |tx| tx.set(&shape, "x", json!(3))).unwrap();
    assert_eq!(one.state_hash().unwrap(), two.state_hash().unwrap());
    let bytes = one.content_snapshot().unwrap();
    assert_eq!(one.content_snapshot().unwrap(), bytes);
    // The seal and the element ids name each replica's own changes.
    assert_ne!(two.content_snapshot().unwrap(), bytes);
}

#[test]
fn a_rebirth_lets_a_document_known_only_from_its_content_snapshot_start_a_room() {
    let (mut a, _, _, shape) = history(false);
    let content = a.content_snapshot().unwrap();
    assert!(!Replica::snapshot_carries_whole_history(&content).unwrap());
    let mut file = load(&content, 3);
    assert!(!file.carries_whole_history());
    file.transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
    assert!(file.can_undo());
    assert!(file.rebirth().unwrap());
    assert_eq!(file.doc_id(), a.doc_id());
    assert_eq!(file.objects_of_type("Shape"), a.objects_of_type("Shape"));
    assert_eq!(file.get(&shape, "x").unwrap(), json!(5));
    assert!(!file.can_undo());
    assert!(file.carries_whole_history());
    assert!(Replica::snapshot_carries_whole_history(&file.snapshot().unwrap()).unwrap());
    // The rebirth is a seal: the content snapshot commits nothing and carries the whole history.
    let version = file.version();
    let reborn = file.content_snapshot().unwrap();
    assert_eq!(file.version(), version);
    assert!(Replica::snapshot_carries_whole_history(&reborn).unwrap());
    assert!(!file.rebirth().unwrap());
    // A replica of the room edits and syncs like any other.
    let mut member = load(&reborn, 4);
    member.transact(&person(), |tx| tx.set(&shape, "y", json!(9))).unwrap();
    file.import_changes(&member.export_changes(&file.version()).unwrap()).unwrap();
    assert_eq!(file.get(&shape, "y").unwrap(), json!(9));
    // Edits after it make later content snapshots that no longer do.
    assert!(!Replica::snapshot_carries_whole_history(&file.content_snapshot().unwrap()).unwrap());
}

#[test]
fn a_rebirth_leaves_a_replica_that_carries_the_whole_history_as_it_is() {
    let (mut a, ..) = history(false);
    let version = a.version();
    assert!(!a.rebirth().unwrap());
    assert_eq!(a.version(), version);
    let mut copy = a.copy_as_new_document(DocId::new(), actor(7)).unwrap();
    assert!(!copy.rebirth().unwrap());
    // A fresh copy is sealed by the change that made it: its content snapshot carries its birth.
    assert!(copy.is_sealed());
    assert!(Replica::snapshot_carries_whole_history(&copy.content_snapshot().unwrap()).unwrap());
}

#[test]
fn after_a_rebirth_a_replica_that_keeps_earlier_history_cannot_send_concurrent_changes() {
    let (mut a, mut b, _, shape) = history(false);
    let before = b.version();
    let mut file = load(&a.content_snapshot().unwrap(), 3);
    file.rebirth().unwrap();
    b.transact(&person(), |tx| tx.set(&shape, "y", json!(1))).unwrap();
    assert!(matches!(file.import_changes(&b.export_changes(&before).unwrap()), Err(KdmError::HistoryMissing(_))));
}

#[test]
fn a_replica_opened_from_a_content_snapshot_forks_and_tells_what_changed_since_the_file() {
    let (mut a, _, _, shape) = history(false);
    let before = a.version();
    let mut file = load(&a.content_snapshot().unwrap(), 3);
    let opened = file.version();
    assert!(file.reaches(&opened));
    assert!(!file.reaches(&before), "the root's own operation, the seal, is not in it");
    file.transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
    let middle = file.version();
    file.transact(&person(), |tx| tx.set(&shape, "y", json!(6))).unwrap();
    // A batch's receipt: what changed since a version after the file.
    let since = serde_json::to_string(&file.changes_since(&middle).unwrap()).unwrap();
    assert!(since.contains("\"y\"") && !since.contains("\"x\""), "{since}");
    assert!(serde_json::to_string(&file.changes_since(&opened).unwrap()).unwrap().contains("\"x\""));
    let mut draft = file.fork_at(&middle, actor(4)).unwrap();
    assert!(draft.is_shallow());
    assert_eq!(draft.version(), middle);
    assert_eq!(draft.shallow_root(), file.shallow_root());
    assert_eq!(draft.get(&shape, "x").unwrap(), json!(5));
    assert_eq!(draft.get(&shape, "y").unwrap(), json!(20));
    // The draft edits and merges back like any.
    draft.transact(&person(), |tx| tx.set(&shape, "fill", json!("#222222"))).unwrap();
    file.merge_changes(&draft.export_changes(&middle).unwrap(), &person()).unwrap();
    assert_eq!(file.get(&shape, "fill").unwrap(), json!("#222222"));
    assert_eq!(file.get(&shape, "y").unwrap(), json!(6));
    // Versions before the file are not in it.
    assert!(matches!(file.fork_at(&before, actor(5)), Err(KdmError::HistoryMissing(_))));
    assert!(matches!(file.changes_since(&before), Err(KdmError::HistoryMissing(_))));
}

#[test]
fn a_snapshot_lists_the_origins_it_holds() {
    let (mut a, ..) = history(true);
    let full = Replica::snapshot_origins(&a.snapshot().unwrap()).unwrap();
    assert!(full.len() > 5, "{full:?}");
    assert!(full.contains(&Some(Origin::person(format!("user:{LAST}")).with_label(LAST_LABEL))));
    assert_eq!(Replica::snapshot_origins(&a.content_snapshot().unwrap()).unwrap(), vec![Some(Origin::system("content-seal"))]);
    assert!(matches!(Replica::snapshot_origins(&[1, 2, 3]), Err(KdmError::Encoding(_))));
}

/// Regression (kition-table `records.history`): a replica the host stores for a file starts at the
/// file's seal and grows with the session's changes. Its earliest readable version is the sealed
/// content, and the changes after it are listed with their origins, in order; `shallow_root`, the
/// version before the seal's own operation, is not readable.
#[test]
fn a_stored_replica_reads_the_sealed_content_and_lists_the_changes_after_it() {
    let (mut a, _, _, shape) = history(true);
    let content = a.content_snapshot().unwrap();
    let sealed = load(&content, 3);
    let sealed_state = sealed.state_json().unwrap();
    let mut file = load(&content, 3);
    // Reading the history commits nothing: the unchanged save is the same bytes.
    assert_eq!(file.earliest_readable(), file.version());
    assert_eq!(file.history_since(&file.earliest_readable()).unwrap(), vec![]);
    assert_eq!(file.content_snapshot().unwrap(), content);
    let alice = Origin::person("user:alice");
    let agent = Origin::agent("agent:helper").with_label("tidy");
    file.transact(&alice, |tx| tx.set(&shape, "x", json!(31))).unwrap();
    let after_alice = file.version();
    file.transact(&agent, |tx| tx.set(&shape, "y", json!(32))).unwrap();
    // What the host stores and opens again: a snapshot of the grown replica.
    let stored = load(&file.snapshot().unwrap(), 4);
    for replica in [&file, &stored] {
        let start = replica.earliest_readable();
        assert!(replica.reaches(&start));
        let root = replica.shallow_root().expect("a replica opened from a file is shallow");
        assert!(start.includes(&root) && start != root, "the seal's own operation is in it");
        assert!(!replica.reaches(&root));
        assert_eq!(replica.fork_at(&start, actor(5)).unwrap().state_json().unwrap(), sealed_state);
        let changes = replica.history_since(&start).unwrap();
        let origins: Vec<Option<Origin>> = changes.iter().map(|change| change.origin.clone()).collect();
        assert_eq!(origins, vec![Some(alice.clone()), Some(agent.clone())]);
        assert_eq!(changes[0].version, after_alice);
        assert_eq!(changes[1].version, file.version());
        let first = replica.fork_at(&changes[0].version, actor(6)).unwrap();
        assert_eq!((first.get(&shape, "x").unwrap(), first.get(&shape, "y").unwrap()), (json!(31), json!(20)));
        assert_eq!(replica.history_since(&changes[0].version).unwrap().len(), 1);
        assert!(matches!(replica.history_since(&root), Err(KdmError::HistoryMissing(_))));
    }
    // The file's bytes are unchanged by all of it: one change, the seal.
    assert_eq!(Replica::snapshot_origins(&content).unwrap(), vec![Some(Origin::system("content-seal"))]);
    // A full replica reads every version, from the empty one; its history ends with its seal.
    assert_eq!(a.earliest_readable(), kition_kdm::Version::empty());
    let whole = a.history_since(&kition_kdm::Version::empty()).unwrap();
    assert!(whole.len() > 5, "{whole:?}");
    assert_eq!(whole.last().map(|change| change.version.clone()), Some(a.version()));
    assert_eq!(whole.last().and_then(|change| change.origin.clone()), Some(Origin::system("content-seal")));
}
