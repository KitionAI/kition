// Copied from kition-sdk crates/kition-kdm/tests/new_document.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! A copy as a new document (`Replica::copy_as_new_document`): the same content under a new
//! permanent `docId` on a new line of changes, with no history, for a template instantiated twice,
//! a copied file, or the same bytes uploaded twice. Each copy is its own document, never taking the
//! source's or another copy's changes.

use kition_kdm::{ActorId, DocId, KdmError, ObjectId, Origin, Replica};
use serde_json::json;

mod common;
use common::{fields, page_with_shape, person, schema};

fn actor(n: u64) -> ActorId {
    ActorId::from_u64(n).unwrap()
}

/// Deleted text a copy must not carry: unique, with no repeated run, so the engine's compression
/// keeps it as plain bytes wherever it is stored.
const DELETED_TEXT: &str = "zq7Wv-DELETED-k3Rx9-MARKER-p2Jm";
/// Text of an object deleted before the copy.
const DELETED_OBJECT: &str = "hT4uB-GONE-OBJECT-n8Ls1-yC6e";

/// The document's objects: its canonical state without `meta`, which names the document.
fn content(replica: &Replica) -> serde_json::Value {
    replica.state_json().unwrap()["objects"].clone()
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle.as_bytes())
}

/// A document with history: a page, a shape with a blob and a label, a tree, deleted text and a
/// deleted object. Answers the replica, its page and its shape.
fn source() -> (Replica, ObjectId, ObjectId) {
    let mut source = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    let (page, shape) = page_with_shape(&mut source);
    let image = json!({ "hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "mime": "image/png", "size": 4 });
    source
        .transact(&person(), |tx| {
            tx.set(&shape, "image", image.clone())?;
            tx.text_insert(&shape, "label", 0, "kept label")?;
            tx.tree_create(&page, "outline", None, &shape)?;
            Ok(())
        })
        .unwrap();
    source.transact(&person(), |tx| tx.text_insert(&shape, "label", 4, DELETED_TEXT)).unwrap();
    let gone = source
        .transact(&person(), |tx| {
            let gone = tx.create("Shape", fields(json!({ "kind": "ellipse", "x": 1, "y": 2 })))?;
            tx.text_insert(&gone, "label", 0, DELETED_OBJECT)?;
            tx.list_insert(&page, "shapes", 1, &gone)?;
            tx.tree_create(&page, "outline", None, &gone)?;
            Ok(gone)
        })
        .unwrap();
    source.transact(&person(), |tx| tx.delete(&gone)).unwrap();
    // The last change deletes the text, by the same actor the copy is made with below.
    let at = source.text(&shape, "label").unwrap().find(DELETED_TEXT).unwrap();
    source.transact(&person(), |tx| tx.text_delete(&shape, "label", at, DELETED_TEXT.chars().count())).unwrap();
    assert_eq!(source.text(&shape, "label").unwrap(), "kept label");
    (source, page, shape)
}

#[test]
fn a_copy_is_a_new_document_with_the_same_objects_and_content() {
    let (source, page, shape) = source();
    let id = DocId::new();
    let copy = source.copy_as_new_document(id, actor(1)).unwrap();
    assert_eq!(copy.doc_id(), id);
    assert_ne!(copy.doc_id(), source.doc_id());
    assert_eq!(copy.actor(), actor(1));
    assert_eq!(content(&copy), content(&source));
    let mut meta = source.state_json().unwrap()["meta"].clone();
    meta["docId"] = json!(id.to_string());
    assert_eq!(copy.state_json().unwrap()["meta"], meta);
    assert_eq!(copy.list(&page, "shapes").unwrap(), source.list(&page, "shapes").unwrap());
    // A blob is its content-addressed reference, unchanged: it resolves wherever the source's did.
    assert_eq!(copy.get(&shape, "image").unwrap(), source.get(&shape, "image").unwrap());
    // Tree nodes keep their ids, so node references a kit stored still name the same nodes.
    assert_eq!(copy.tree(&page, "outline").unwrap(), source.tree(&page, "outline").unwrap());
    // Its bytes load cleanly, as the new document, by another actor.
    let loaded = Replica::load(schema(), &copy.snapshot().unwrap(), actor(5)).unwrap();
    assert_eq!(loaded.doc_id(), id);
    assert_eq!(loaded.state_hash().unwrap(), copy.state_hash().unwrap());
}

#[test]
fn a_copy_carries_no_history_and_no_deleted_content() {
    let (source, _, _) = source();
    let copy = source.copy_as_new_document(DocId::new(), actor(1)).unwrap();
    for bytes in [copy.snapshot().unwrap(), copy.export_changes(&kition_kdm::Version::empty()).unwrap()] {
        assert!(!contains(&bytes, DELETED_TEXT), "deleted text travelled into the copy");
        assert!(!contains(&bytes, DELETED_OBJECT), "a deleted object's text travelled into the copy");
        assert!(!contains(&bytes, &source.doc_id().to_string()), "the source's docId travelled into the copy");
    }
    // It starts a new line of changes: the source's versions are not its own, and a draft forks
    // only at its current version.
    assert!(!copy.version().includes(&source.version()));
    assert_ne!(copy.version().encode()[..16], source.version().encode()[..16]);
    assert!(matches!(copy.fork_at(&source.version(), actor(2)), Err(KdmError::InvalidValue { .. })));
    assert!(matches!(copy.changes_since(&source.version()), Err(KdmError::HistoryMissing(_))));
    assert!(copy.fork(actor(2)).is_ok());
}

#[test]
fn a_copy_starts_with_empty_undo_history() {
    let (source, _, _) = source();
    assert!(source.can_undo());
    let mut copy = source.copy_as_new_document(DocId::new(), actor(1)).unwrap();
    assert!(!copy.can_undo() && !copy.can_redo());
    assert!(!copy.undo().unwrap());
    assert_eq!(content(&copy), content(&source));
}

#[test]
fn a_copy_and_its_source_never_take_each_others_changes() {
    let (mut source, page, shape) = source();
    let mut copy = source.copy_as_new_document(DocId::new(), actor(2)).unwrap();
    let base = copy.version();
    copy.transact(&person(), |tx| tx.set(&shape, "x", json!(99))).unwrap();
    source.transact(&person(), |tx| tx.set(&page, "title", json!("source only"))).unwrap();
    let wrong = |result: Result<_, KdmError>| matches!(result, Err(KdmError::WrongDocument { .. }));
    // Changes, drafts and snapshots of one are refused by the other, both ways, and change nothing.
    let (source_hash, copy_hash) = (source.state_hash().unwrap(), copy.state_hash().unwrap());
    assert!(wrong(source.import_changes(&copy.export_changes(&base).unwrap())));
    assert!(wrong(source.merge_changes(&copy.export_changes(&base).unwrap(), &person())));
    assert!(wrong(copy.import_changes(&source.export_changes(&kition_kdm::Version::empty()).unwrap())));
    assert!(wrong(copy.merge_changes(&source.export_changes(&kition_kdm::Version::empty()).unwrap(), &person())));
    let draft = source.fork(actor(3)).unwrap();
    assert!(wrong(copy.merge_changes(&draft.export_changes(&kition_kdm::Version::empty()).unwrap(), &person())));
    assert_eq!((source.state_hash().unwrap(), copy.state_hash().unwrap()), (source_hash, copy_hash));
    assert_eq!(source.get(&shape, "x").unwrap(), json!(10));
    assert_eq!(copy.get(&page, "title").unwrap(), json!("One"));
}

#[test]
fn two_copies_of_one_source_are_two_documents_that_each_co_edit() {
    let (source, _, shape) = source();
    let first = source.copy_as_new_document(DocId::new(), actor(1)).unwrap();
    let second = source.copy_as_new_document(DocId::new(), actor(1)).unwrap();
    assert_ne!(first.doc_id(), second.doc_id());
    let mut a = Replica::load(schema(), &first.snapshot().unwrap(), actor(10)).unwrap();
    let mut b = Replica::load(schema(), &first.snapshot().unwrap(), actor(11)).unwrap();
    let mut other = Replica::load(schema(), &second.snapshot().unwrap(), actor(12)).unwrap();
    a.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "A:")).unwrap();
    let to_b = a.export_changes(&b.version()).unwrap();
    b.import_changes(&to_b).unwrap();
    b.transact(&person(), |tx| tx.set(&shape, "y", json!(7))).unwrap();
    other.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "OTHER:")).unwrap();
    let to_a = b.export_changes(&a.version()).unwrap();
    a.import_changes(&to_a).unwrap();
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());
    assert_eq!(a.text(&shape, "label").unwrap(), "A:kept label");
    assert!(matches!(other.import_changes(&a.export_changes(&other.version()).unwrap()), Err(KdmError::WrongDocument { .. })));
    assert_eq!(other.text(&shape, "label").unwrap(), "OTHER:kept label");
    assert_eq!(other.get(&shape, "y").unwrap(), json!(20));
}

#[test]
fn a_copy_of_a_loaded_replica_or_a_copy_is_a_new_document_too() {
    let (source, _, _) = source();
    let loaded = Replica::load(schema(), &source.content_snapshot().unwrap(), actor(4)).unwrap();
    let copy = loaded.copy_as_new_document(DocId::new(), actor(4)).unwrap();
    let again = copy.copy_as_new_document(DocId::new(), actor(6)).unwrap();
    // The file leaves out the deleted shape's list entry (data model C13): the copies hold what
    // the file holds.
    assert_eq!(content(&again), content(&loaded));
    assert_eq!(content(&loaded).as_object().map(serde_json::Map::len), content(&source).as_object().map(serde_json::Map::len));
    assert_ne!(again.doc_id(), copy.doc_id());
    assert!(Replica::load(schema(), &again.snapshot().unwrap(), actor(7)).is_ok());
}

#[test]
fn a_copy_under_the_same_doc_id_is_refused() {
    let (source, _, _) = source();
    assert!(matches!(source.copy_as_new_document(source.doc_id(), actor(1)), Err(KdmError::InvalidValue { .. })));
}

#[test]
fn a_copy_records_a_system_origin_and_the_writer_schema_version() {
    let (source, _, _) = source();
    let mut copy = source.copy_as_new_document(DocId::new(), actor(1)).unwrap();
    assert_eq!(copy.author_schema_version(), Some(1));
    assert!(copy.take_changed().is_empty());
    copy.transact(&Origin::person("user:other"), |tx| tx.create("Page", fields(json!({ "title": "new" })))).unwrap();
    assert!(copy.can_undo());
}
