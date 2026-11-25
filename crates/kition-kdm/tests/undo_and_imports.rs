// Copied from kition-sdk crates/kition-kdm/tests/undo_and_imports.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Undo across a trimmed log, undo of tree edits, and operations from other replicas checked
//! against the schema (plan 2026-11-24, plain model, review fixes G1 to G4).

mod common;

use common::{fields, page_with_shape, person, schema};
use kition_kdm::{ActorId, DocId, KdmError, NodeRef, ObjectId, Origin, Replica};
use serde_json::{Value, json};

fn replica() -> Replica {
    Replica::create(schema(), DocId::new(), ActorId::from_u64(1).unwrap()).unwrap()
}

fn agent() -> Origin {
    Origin::agent("agent:writer")
}

/// A page whose outline holds `count` new shapes as roots, made by the person; answers the page
/// and the shapes in order.
fn outline(replica: &mut Replica, count: usize) -> (ObjectId, Vec<ObjectId>) {
    replica
        .transact(&person(), |tx| {
            let page = tx.create("Page", fields(json!({ "title": "P" })))?;
            let mut shapes = Vec::new();
            for _ in 0..count {
                let shape = tx.create("Shape", fields(json!({ "kind": "rect", "x": 0, "y": 0 })))?;
                tx.tree_create(&page, "outline", None, &shape)?;
                shapes.push(shape);
            }
            Ok((page, shapes))
        })
        .unwrap()
}

/// The outline as `(object, parent object)` in pre-order.
fn tree(replica: &Replica, page: &ObjectId) -> Vec<(ObjectId, Option<ObjectId>)> {
    replica.tree(page, "outline").unwrap().into_iter().map(|entry| (entry.object, entry.parent.map(|parent| parent.object().clone()))).collect()
}

fn roots(objects: &[&ObjectId]) -> Vec<(ObjectId, Option<ObjectId>)> {
    objects.iter().map(|object| ((*object).clone(), None)).collect()
}

/// The node of `object` in the page's outline.
fn node(replica: &Replica, page: &ObjectId, object: &ObjectId) -> NodeRef {
    replica.tree(page, "outline").unwrap().into_iter().find(|entry| &entry.object == object).map(|entry| entry.node).expect("a node")
}

/// One change of actor 9 with `ops`, following `replica`'s version, as another replica of the
/// session would send it.
fn change(replica: &Replica, ops: Value) -> Vec<u8> {
    let snapshot: Value = serde_json::from_slice(&replica.snapshot().unwrap()).unwrap();
    let seq = snapshot["version"]["seq"].as_u64().unwrap();
    json!({
        "kdm": 1,
        "docId": replica.doc_id().to_string(),
        "lineage": snapshot["version"]["lineage"].clone(),
        "after": { "seq": seq, "actor": null },
        "changes": [{ "seq": seq + 1, "actor": "0000000000000009", "origin": ["person", "user:other", null, 1], "ops": ops }]
    })
    .to_string()
    .into_bytes()
}

// ---- G1: the undo history follows the log ----

#[test]
fn undo_steps_older_than_the_log_are_dropped_when_the_log_trims() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    replica.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "abc")).unwrap();
    // The agent's insertion moves the person's text; an undo must be carried over it.
    replica.transact(&agent(), |tx| tx.text_insert(&shape, "label", 0, "X")).unwrap();
    assert!(replica.can_undo());
    // The log keeps 10,000 changes: these push the person's steps and the agent's insertion out.
    for n in 0..10_000 {
        replica.transact(&agent(), |tx| tx.set(&page, "title", json!(n.to_string()))).unwrap();
    }
    // The steps the log can no longer carry over what came after are gone, not undone wrongly.
    assert!(!replica.can_undo());
    assert!(!replica.undo().unwrap());
    assert_eq!(replica.text(&shape, "label").unwrap(), "Xabc");
}

// ---- G2: an undone deletion finds a place in a tree that changed ----

#[test]
fn an_undone_delete_whose_parent_is_gone_comes_back_as_a_root() {
    let mut replica = replica();
    let (page, shapes) = outline(&mut replica, 1);
    let parent = shapes[0].clone();
    let parent_node = node(&replica, &page, &parent);
    let (a, d) = replica
        .transact(&person(), |tx| {
            let a = tx.create("Shape", fields(json!({ "kind": "rect", "x": 1, "y": 1 })))?;
            let d = tx.create("Shape", fields(json!({ "kind": "rect", "x": 2, "y": 2 })))?;
            tx.tree_create(&page, "outline", Some(&parent_node), &a)?;
            tx.tree_create(&page, "outline", Some(&parent_node), &d)?;
            Ok((a, d))
        })
        .unwrap();
    replica.transact(&person(), |tx| tx.delete(&d)).unwrap();
    // The agent deletes the rest of the subtree, `d`'s parent with it.
    replica
        .transact(&agent(), |tx| {
            tx.delete(&a)?;
            tx.delete(&parent)
        })
        .unwrap();
    assert!(replica.undo().unwrap());
    assert!(replica.exists(&d), "the deletion of `d` is undone");
    assert_eq!(tree(&replica, &page), roots(&[&d]));
    // The step before it (the creation of `a` and `d`) is not undone in its place.
    assert!(replica.can_undo());
    assert!(replica.exists(&page));
}

// ---- G3: tree positions follow the changes made since ----

#[test]
fn an_undone_delete_goes_back_among_its_siblings_after_a_sibling_moved() {
    let mut replica = replica();
    let (page, s) = outline(&mut replica, 4);
    let (a, b, c, d) = (&s[0], &s[1], &s[2], &s[3]);
    replica.transact(&person(), |tx| tx.delete(b)).unwrap();
    // The agent moves `a` from before `b` to the end.
    let a_node = node(&replica, &page, a);
    replica.transact(&agent(), |tx| tx.tree_move(&page, "outline", &a_node, None)).unwrap();
    assert_eq!(tree(&replica, &page), roots(&[c, d, a]));
    assert!(replica.undo().unwrap());
    assert_eq!(tree(&replica, &page), roots(&[b, c, d, a]));
}

#[test]
fn an_undone_move_goes_back_among_its_siblings_after_a_sibling_moved() {
    let mut replica = replica();
    let (page, s) = outline(&mut replica, 4);
    let (a, b, c, d) = (&s[0], &s[1], &s[2], &s[3]);
    let (a_node, b_node) = (node(&replica, &page, a), node(&replica, &page, b));
    replica.transact(&person(), |tx| tx.tree_move(&page, "outline", &b_node, None)).unwrap();
    assert_eq!(tree(&replica, &page), roots(&[a, c, d, b]));
    replica.transact(&agent(), |tx| tx.tree_move(&page, "outline", &a_node, None)).unwrap();
    assert_eq!(tree(&replica, &page), roots(&[c, d, b, a]));
    assert!(replica.undo().unwrap());
    assert_eq!(tree(&replica, &page), roots(&[b, c, d, a]));
}

#[test]
fn a_merge_is_refused_when_the_draft_deletes_a_node_of_a_tree_the_document_changed() {
    let mut live = replica();
    let (page, s) = outline(&mut live, 3);
    let base = live.version();
    let mut draft = live.fork(ActorId::from_u64(9).unwrap()).unwrap();
    // The draft deletes a node's object: that writes the outline. The document moves a node.
    draft.transact(&agent(), |tx| tx.delete(&s[1])).unwrap();
    let first = node(&live, &page, &s[0]);
    live.transact(&person(), |tx| tx.tree_move(&page, "outline", &first, None)).unwrap();
    let before = live.version();
    let error = live.merge_changes(&draft.export_changes(&base).unwrap(), &agent()).unwrap_err();
    assert!(matches!(error, KdmError::Stale(ref reason) if reason.contains("outline")), "{error:?}");
    assert_eq!(live.version(), before);
}

// ---- G4: imported and merged operations are checked against the schema ----

#[test]
fn an_import_the_schema_refuses_is_refused_whole() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    let (page, shape) = (page.as_str(), shape.as_str());
    let refused = [
        ("a set on a list field", json!([{ "op": "set", "id": page, "field": "shapes", "value": ["x"], "was": null }])),
        ("a set of another kind", json!([{ "op": "set", "id": shape, "field": "x", "value": "far", "was": null }])),
        ("a list insert into a text field", json!([{ "op": "listInsert", "id": shape, "field": "label", "index": 0, "item": page }])),
        ("a text insert into a register", json!([{ "op": "textInsert", "id": page, "field": "title", "index": 0, "text": "x" }])),
        ("an item of another type", json!([{ "op": "listInsert", "id": page, "field": "shapes", "index": 0, "item": page }])),
        ("an integer beyond 2^53", json!([{ "op": "set", "id": shape, "field": "transform", "value": { "n": 9_007_199_254_740_993_u64 }, "was": null }])),
        ("a map entry beyond 2^53", json!([{ "op": "create", "id": "s1", "object": { "$type": "Sheet", "cells": { "a": 9_007_199_254_740_993_u64 } } }])),
        (
            "a good operation, then a refused one",
            json!([
                { "op": "set", "id": page, "field": "title", "value": "Changed", "was": "One" },
                { "op": "mapSet", "id": page, "field": "title", "key": "k", "value": 1 }
            ]),
        ),
    ];
    for (what, ops) in refused {
        let before = (replica.version(), replica.state_json().unwrap());
        let error = replica.import_changes(&change(&replica, ops)).unwrap_err();
        assert!(matches!(error, KdmError::InvalidValue { .. }), "{what}: {error:?}");
        assert_eq!((replica.version(), replica.state_json().unwrap()), before, "{what}: a refused import changed the document");
    }
    // Accepted values are canonical: a whole double is an integer.
    replica.import_changes(&change(&replica, json!([{ "op": "set", "id": shape, "field": "x", "value": 5.0, "was": 10 }]))).unwrap();
    assert!(replica.get(&ObjectId::from_string(shape), "x").unwrap().is_i64());
    // A field and a type this schema does not declare (a newer schema's) pass as they are.
    replica
        .import_changes(&change(
            &replica,
            json!([
                { "op": "set", "id": shape, "field": "later", "value": [1], "was": null },
                { "op": "create", "id": "n1", "object": { "$type": "Note", "body": "hi" } }
            ]),
        ))
        .unwrap();
    assert!(replica.exists(&ObjectId::from_string("n1")));
}

#[test]
fn a_merge_the_schema_refuses_is_refused_whole() {
    let mut live = replica();
    let (page, _) = page_with_shape(&mut live);
    let before = (live.version(), live.state_json().unwrap());
    let draft = change(&live, json!([{ "op": "set", "id": page.as_str(), "field": "shapes", "value": [], "was": null }]));
    let error = live.merge_changes(&draft, &agent()).unwrap_err();
    assert!(matches!(error, KdmError::InvalidValue { .. }), "{error:?}");
    assert_eq!((live.version(), live.state_json().unwrap()), before);
}

// ---- A tree node names a live object ----

#[test]
fn a_transaction_places_no_node_for_an_object_that_does_not_exist() {
    let mut replica = replica();
    let (page, shapes) = outline(&mut replica, 1);
    let before = (replica.version(), replica.state_json().unwrap());
    let never = ObjectId::from_string("never-made");
    let error = replica.transact(&person(), |tx| tx.tree_create(&page, "outline", None, &never)).unwrap_err();
    assert!(matches!(error, KdmError::NotFound(ref found) if found == "never-made"), "{error:?}");
    // Deleted earlier in the same transaction: gone as well.
    let error = replica
        .transact(&person(), |tx| {
            let made = tx.create("Shape", fields(json!({ "kind": "rect", "x": 0, "y": 0 })))?;
            tx.delete(&made)?;
            tx.tree_create(&page, "outline", None, &made)
        })
        .unwrap_err();
    assert!(matches!(error, KdmError::NotFound(_)), "{error:?}");
    assert_eq!((replica.version(), replica.state_json().unwrap()), before, "a refused transaction changed the document");
    assert_eq!(tree(&replica, &page), roots(&[&shapes[0]]));
}

#[test]
fn an_import_placing_a_node_for_a_missing_object_is_refused_whole() {
    let mut replica = replica();
    let (page, shapes) = outline(&mut replica, 1);
    let page = page.as_str();
    let before = (replica.version(), replica.state_json().unwrap());
    let refused = [
        ("a node naming no object", json!([{ "op": "treeCreate", "id": page, "field": "outline", "node": "nowhere", "parent": null, "index": 1 }])),
        (
            "a node placed before its object is made",
            json!([
                { "op": "treeCreate", "id": page, "field": "outline", "node": "n1", "parent": null, "index": 1 },
                { "op": "create", "id": "n1", "object": { "$type": "Shape", "kind": "rect", "x": 0, "y": 0 } }
            ]),
        ),
    ];
    for (what, ops) in refused {
        let error = replica.import_changes(&change(&replica, ops)).unwrap_err();
        assert!(matches!(error, KdmError::Stale(ref reason) if reason.contains("does not exist")), "{what}: {error:?}");
        assert_eq!((replica.version(), replica.state_json().unwrap()), before, "{what}: a refused import changed the document");
    }
    // Made first in the same change, it is placed.
    replica
        .import_changes(&change(
            &replica,
            json!([
                { "op": "create", "id": "n1", "object": { "$type": "Shape", "kind": "rect", "x": 0, "y": 0 } },
                { "op": "treeCreate", "id": page, "field": "outline", "node": "n1", "parent": null, "index": 1 }
            ]),
        ))
        .unwrap();
    let made = ObjectId::from_string("n1");
    assert_eq!(tree(&replica, &ObjectId::from_string(page)), roots(&[&shapes[0], &made]));
}

#[test]
fn a_merge_placing_a_node_for_an_object_the_document_deleted_is_refused() {
    let mut live = replica();
    let (page, _) = outline(&mut live, 1);
    let loose = live.transact(&person(), |tx| tx.create("Shape", fields(json!({ "kind": "rect", "x": 5, "y": 5 })))).unwrap();
    let base = live.version();
    let mut draft = live.fork(ActorId::from_u64(9).unwrap()).unwrap();
    draft.transact(&agent(), |tx| tx.tree_create(&page, "outline", None, &loose).map(drop)).unwrap();
    live.transact(&person(), |tx| tx.delete(&loose)).unwrap();
    let before = (live.version(), live.state_json().unwrap());
    let error = live.merge_changes(&draft.export_changes(&base).unwrap(), &agent()).unwrap_err();
    assert!(matches!(error, KdmError::Stale(_)), "{error:?}");
    assert_eq!((live.version(), live.state_json().unwrap()), before, "a refused merge changed the document");
    assert!(!String::from_utf8(live.snapshot().unwrap()).unwrap().contains(loose.as_str()));
}

#[test]
fn an_undo_puts_back_no_node_for_an_object_deleted_since() {
    let mut replica = replica();
    let (page, shapes) = outline(&mut replica, 1);
    let shape = shapes[0].clone();
    let placed = node(&replica, &page, &shape);
    // The agent takes the shape out of the outline; then the person deletes the shape.
    replica.transact(&agent(), |tx| tx.tree_delete(&page, "outline", &placed)).unwrap();
    replica.transact(&person(), |tx| tx.delete(&shape)).unwrap();
    // Undoing the agent's step has no node to put back: the snapshot (which holds the state
    // exactly, data model C10) names the shape nowhere.
    replica.undo_in(kition_kdm::UndoScope::Agent).unwrap();
    assert!(!replica.exists(&shape));
    assert_eq!(tree(&replica, &page), Vec::new());
    assert!(!String::from_utf8(replica.snapshot().unwrap()).unwrap().contains(shape.as_str()));
}
