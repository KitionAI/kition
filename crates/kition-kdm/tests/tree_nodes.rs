// Copied from kition-sdk crates/kition-kdm/tests/tree_nodes.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::expect_used)]
//! Deleting an object that a tree holds: every read skips the node of a deleted
//! object with its subtree (`Replica::tree`, `Tx::tree`, a load), as the canonical state keeps the
//! node (the shared batch fixtures say so for both implementations), and a change set (a write's,
//! or two reads of a file compared) tells a plain deletion at the node's place. An object whose
//! node has live children is not deleted ([`kition_kdm::KdmError::InvalidValue`]): delete or move
//! them first, as the batch's `delete` says.
#![allow(clippy::unwrap_used, clippy::indexing_slicing)]

use std::sync::Arc;

use kition_kdm::reread::diff_paired;
use kition_kdm::{ActorId, DocId, KdmError, ObjectId, Origin, Replica, Schema};
use serde_json::{Map, Value, json};

/// An image as a photo kit models it: layers with integer tool ids in a tree, groups holding
/// layers.
fn schema() -> Arc<Schema> {
    Arc::new(
        Schema::parse(
            &json!({
                "kdm": 1, "kit": "kit.trees", "schemaVersion": 1, "root": "Image",
                "types": {
                    "Image": { "fields": { "layers": { "kind": "tree", "of": "Layer" } } },
                    "Layer": { "fields": {
                        "id": { "kind": "integer", "readOnly": true },
                        "name": { "kind": "string" }
                    }, "toolId": { "field": "id" } }
                }
            })
            .to_string(),
        )
        .unwrap(),
    )
}

fn person() -> Origin {
    Origin::person("user:test")
}

/// A layer's fields.
fn layer(id: u64, name: &str) -> Map<String, Value> {
    json!({ "id": id, "name": name }).as_object().cloned().unwrap_or_default()
}

/// An image whose layers are `1`, the group `2` holding `3` and `4`, and `5`; object ids made of
/// `mint` and the layer's number, as a kit that mints them on every read does.
fn image(mint: &str, without: &[u64]) -> (Replica, ObjectId) {
    let id = |n: u64| ObjectId::from_string(format!("{mint}-{n}"));
    let (replica, root) = Replica::create_with(schema(), DocId::new(), ActorId::from_u64(1).unwrap(), &Origin::system("open"), |tx| {
        let root = tx.create_with_id("Image", &ObjectId::from_string(format!("{mint}-image")), Map::new())?;
        let mut group = None;
        for (n, parent) in [(1, false), (2, false), (3, true), (4, true), (5, false)] {
            if without.contains(&n) {
                continue;
            }
            let object = tx.create_with_id("Layer", &id(n), layer(n, &format!("L{n}")))?;
            let node = tx.tree_create(&root, "layers", if parent { group.as_ref() } else { None }, &object)?;
            if n == 2 {
                group = Some(node);
            }
        }
        Ok(root)
    })
    .unwrap();
    (replica, root)
}

fn objects_in(replica: &Replica, root: &ObjectId) -> Vec<String> {
    replica.tree(root, "layers").unwrap().iter().map(|entry| entry.object.to_string()).collect()
}

#[test]
fn a_deleted_layers_node_is_read_by_no_one_and_its_deletion_is_plain() {
    let (mut replica, root) = image("a", &[]);
    let since = replica.version();
    replica.transact(&person(), |tx| tx.delete(&ObjectId::from_string("a-3"))).unwrap();
    assert_eq!(objects_in(&replica, &root), ["a-1", "a-2", "a-4", "a-5"]);
    replica
        .transact(&person(), |tx| {
            assert_eq!(tx.tree(&root, "layers")?.len(), 4, "a transaction's read skips it too");
            Ok(())
        })
        .unwrap();
    let changes = replica.changes_since(&since).unwrap().to_json();
    assert_eq!(changes["deleted"].as_array().map(Vec::len), Some(1), "{changes}");
    assert_eq!(changes["deleted"][0]["id"], "3");
    assert_eq!(changes["deleted"][0]["at"], json!({ "parent": "2", "field": "layers", "index": 0 }));
    assert_eq!(changes["moved"], json!([]), "a deletion is no move: {changes}");
}

#[test]
fn a_node_with_live_children_is_not_deleted_and_children_first_is() {
    let (mut replica, root) = image("a", &[]);
    let error = replica.transact(&person(), |tx| tx.delete(&ObjectId::from_string("a-2"))).unwrap_err();
    assert!(matches!(error, KdmError::InvalidValue { .. }), "{error:?}");
    assert_eq!(objects_in(&replica, &root).len(), 5, "nothing deleted");
    // Children first, in one transaction: the group goes with them.
    replica
        .transact(&person(), |tx| {
            tx.delete(&ObjectId::from_string("a-3"))?;
            tx.delete(&ObjectId::from_string("a-4"))?;
            tx.delete(&ObjectId::from_string("a-2"))
        })
        .unwrap();
    assert_eq!(objects_in(&replica, &root), ["a-1", "a-5"]);
}

#[test]
fn a_file_read_again_without_a_layer_tells_a_plain_deletion() {
    let (before, _) = image("a", &[]);
    let (after, _) = image("b", &[4]);
    let diff = diff_paired(&schema(), &before.state_json().unwrap(), &after.state_json().unwrap()).to_json();
    assert_eq!(diff["deleted"].as_array().map(Vec::len), Some(1), "{diff}");
    assert_eq!(diff["deleted"][0]["id"], "4");
    assert_eq!(diff["deleted"][0]["type"], "Layer");
    assert_eq!(diff["deleted"][0]["at"], json!({ "parent": "2", "field": "layers", "index": 1 }));
    assert_eq!(diff["moved"], json!([]), "{diff}");
    assert_eq!(diff["created"], json!([]), "{diff}");
}

#[test]
fn a_file_read_again_after_a_write_that_deleted_a_layer_tells_nothing_more() {
    // The kit deleted layer 4 and saved; the file read again has no node for it either.
    let (mut written, _) = image("a", &[]);
    written.transact(&person(), |tx| tx.delete(&ObjectId::from_string("a-4"))).unwrap();
    let (read_again, _) = image("b", &[4]);
    let diff = diff_paired(&schema(), &written.state_json().unwrap(), &read_again.state_json().unwrap());
    assert!(diff.is_empty(), "{}", diff.to_json());
}

#[test]
fn a_node_naming_no_object_in_a_read_is_no_change() {
    // A document saved before may hold the node of a deleted layer: no object of either
    // read, so nothing to tell.
    let (before, _) = image("a", &[]);
    let mut state = before.state_json().unwrap();
    state["objects"]["a-image"]["layers"][1]["children"].as_array_mut().unwrap().push(json!({ "object": "a-9", "children": [] }));
    let (after, _) = image("b", &[]);
    let diff = diff_paired(&schema(), &state, &after.state_json().unwrap());
    assert!(diff.is_empty(), "{}", diff.to_json());
}

#[test]
fn a_constant_root_tells_the_same_tree_deletion_as_the_receipt() {
    let (mut before, _) = image("a", &[]);
    let state = before.state_json().unwrap();
    let version = before.version();
    before.transact(&person(), |tx| tx.delete(&ObjectId::from_string("a-4"))).unwrap();
    let receipt = before.changes_since(&version).unwrap().to_json();
    let (after, _) = image("a", &[4]);
    let reread = diff_paired(&schema(), &state, &after.state_json().unwrap()).without_texts().to_json();
    assert_eq!(reread["changed"], json!([]), "a tree deletion has no holder edit: {reread}");
    assert_eq!(reread, receipt);
}
