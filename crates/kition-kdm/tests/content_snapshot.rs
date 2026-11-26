// Copied from kition-sdk crates/kition-kdm/tests/content_snapshot.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! What a kit writes into a person's file (data model 7.4): the document's content, which depends
//! on its state alone. No deleted text, overwritten value, origin, actor, version or time is in
//! it; it loads as the same document (its id and object ids) on a new line of changes; a document
//! saved again unchanged, or the same state saved by another replica, is the same bytes.

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Version};
use serde_json::{Value, json};

mod common;
use common::{fields, page_with_shape, person, schema};

fn actor(n: u64) -> ActorId {
    ActorId::from_u64(n).unwrap()
}

/// Unique text that is typed and deleted, an overwritten title, and a deleted object's text.
const DELETED_TEXT: &str = "zq7Wv-DELETED-k3Rx9";
const OLD_TITLE: &str = "hT4uB-OLD-TITLE";
const DELETED_OBJECT: &str = "n8Ls1-GONE-yC6e";

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle.as_bytes())
}

/// A document with history: text typed and deleted, a title overwritten, an object deleted, an
/// agent's edit.
fn edited() -> (Replica, ObjectId, ObjectId) {
    let mut replica = Replica::create(schema(), DocId::new(), actor(1)).unwrap();
    let (page, shape) = page_with_shape(&mut replica);
    replica.transact(&person(), |tx| tx.set(&page, "title", json!(OLD_TITLE))).unwrap();
    replica.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, &format!("kept {DELETED_TEXT}"))).unwrap();
    let gone = replica
        .transact(&Origin::agent("agent:writer"), |tx| {
            let gone = tx.create("Shape", fields(json!({ "kind": "ellipse", "x": 1, "y": 2 })))?;
            tx.text_insert(&gone, "label", 0, DELETED_OBJECT)?;
            Ok(gone)
        })
        .unwrap();
    replica.transact(&person(), |tx| tx.delete(&gone)).unwrap();
    replica.transact(&person(), |tx| tx.text_delete(&shape, "label", 4, DELETED_TEXT.chars().count() + 1)).unwrap();
    replica.transact(&person(), |tx| tx.set(&page, "title", json!("Final"))).unwrap();
    (replica, page, shape)
}

#[test]
fn a_content_snapshot_holds_the_state_and_no_history() {
    let (replica, _, shape) = edited();
    let bytes = replica.content_snapshot().unwrap();
    for gone in [DELETED_TEXT, OLD_TITLE, DELETED_OBJECT, "agent:writer", "user:test", "lineage", "version", "seq"] {
        assert!(!contains(&bytes, gone), "`{gone}` is in the content");
    }
    assert!(contains(&bytes, "Final") && contains(&bytes, "kept"));
    let read = Replica::load(schema(), &bytes, actor(2)).unwrap();
    assert_eq!(read.state_json().unwrap(), replica.state_json().unwrap());
    assert_eq!(replica.text(&shape, "label").unwrap(), "kept");
}

#[test]
fn a_content_snapshot_loads_as_the_same_document_on_a_new_line() {
    let (replica, page, shape) = edited();
    let file = Replica::load(schema(), &replica.content_snapshot().unwrap(), actor(2)).unwrap();
    assert_eq!(file.doc_id(), replica.doc_id());
    assert_eq!(file.state_json().unwrap(), replica.state_json().unwrap());
    assert_eq!(file.list(&page, "shapes").unwrap(), vec![shape]);
    // The file holds no version: the replica it opens starts a line of its own.
    assert!(!file.version().includes(&replica.version()));
    assert!(file.version().includes(&Version::empty()));
    assert!(!file.can_undo());
    // A snapshot keeps the version.
    let stored = Replica::load(schema(), &replica.snapshot().unwrap(), actor(3)).unwrap();
    assert_eq!(stored.version(), replica.version());
}

#[test]
fn a_content_snapshot_is_no_change() {
    let (mut replica, page, shape) = edited();
    let version = replica.version();
    replica.take_changed();
    let bytes = replica.content_snapshot().unwrap();
    assert_eq!(replica.version(), version);
    assert!(replica.take_changed().is_empty());
    // An undo after it takes back the last edit, as before.
    assert!(replica.undo().unwrap().is_done());
    assert_eq!(replica.get(&page, "title").unwrap(), json!(OLD_TITLE));
    assert_ne!(replica.content_snapshot().unwrap(), bytes);
    // On a replica opened from the file: its one edit is its one undo step, before and after a
    // save, and the undo and redo give back the exact values.
    let mut file = Replica::load(schema(), &bytes, actor(3)).unwrap();
    file.transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
    file.content_snapshot().unwrap();
    assert!(file.undo().unwrap().is_done());
    assert_eq!(file.get(&shape, "x").unwrap(), json!(10));
    assert!(!file.can_undo());
    assert!(file.redo().unwrap().is_done());
    assert_eq!(file.get(&shape, "x").unwrap(), json!(5));
    assert!(!file.can_redo());
}

#[test]
fn an_unchanged_content_snapshot_is_the_same_bytes_after_the_whole_state_is_read() {
    let (replica, page, shape) = edited();
    let first = replica.content_snapshot().unwrap();
    replica.state_json().unwrap();
    replica.tree(&page, "outline").unwrap();
    replica.text_delta(&shape, "label").unwrap();
    assert_eq!(replica.content_snapshot().unwrap(), first);
    // Opened from the file and saved again unchanged: the file it read, byte for byte.
    let file = Replica::load(schema(), &first, actor(2)).unwrap();
    file.state_json().unwrap();
    assert_eq!(file.content_snapshot().unwrap(), first);
}

#[test]
fn the_same_state_saved_by_another_replica_after_another_history_is_the_same_bytes() {
    let (replica, page, _) = edited();
    let mut other = Replica::load(schema(), &replica.snapshot().unwrap(), actor(9)).unwrap();
    other.transact(&Origin::agent("agent:other"), |tx| tx.set(&page, "title", json!("Elsewhere"))).unwrap();
    other.transact(&person(), |tx| tx.set(&page, "title", json!("Final"))).unwrap();
    assert_ne!(other.version(), replica.version());
    assert_eq!(other.content_snapshot().unwrap(), replica.content_snapshot().unwrap());
    let text = String::from_utf8(replica.content_snapshot().unwrap()).unwrap();
    assert!(text.starts_with(&format!("{{\"kdm\":1,\"kit\":\"kit.test\",\"docId\":\"{}\",\"schemaVersion\":1,\"objects\":{{\n", replica.doc_id())), "{text}");
    assert!(text.ends_with("\n}}\n"));
    let objects: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(objects["objects"].as_object().map(|objects| objects.len()), Some(2));
}
