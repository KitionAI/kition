// Copied from kition-sdk crates/kition-kdm/tests/replica.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use kition_kdm::{ActorId, DocId, KdmError, NodeRef, ObjectId, Origin, Replica};
use serde_json::json;

mod common;
use common::{QUARTER, REVIEW, fields, from_code_points, page_with_shape, person, schema};

fn replica() -> Replica {
    Replica::create(schema(), DocId::new(), ActorId::from_u64(1).unwrap()).unwrap()
}

#[test]
fn lists_the_objects_of_a_type_in_code_point_order_without_deleted_ones_or_other_types() {
    let mut replica = replica();
    let id = |text: &str| ObjectId::from_string(text.to_owned());
    replica
        .transact(&person(), |tx| {
            for name in ["b", "B", "a", "gone"] {
                tx.create_with_id("Shape", &id(name), fields(json!({ "kind": "rect", "x": 1, "y": 2 })))?;
            }
            tx.create_with_id("Page", &id("A"), fields(json!({ "title": "One" })))?;
            Ok(())
        })
        .unwrap();
    replica.transact(&person(), |tx| tx.delete(&id("gone"))).unwrap();
    assert_eq!(replica.objects_of_type("Shape"), vec![id("B"), id("a"), id("b")]);
    assert_eq!(replica.objects_of_type("Page"), vec![id("A")]);
    assert!(replica.objects_of_type("Nope").is_empty());
}

#[test]
fn creates_reads_and_updates_objects() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    assert_eq!(replica.object_type(&shape).unwrap(), "Shape");
    assert_eq!(replica.get(&shape, "x").unwrap(), json!(10));
    assert_eq!(replica.list(&page, "shapes").unwrap(), vec![shape.clone()]);
    replica.transact(&person(), |tx| tx.set(&shape, "fill", json!("#5645d4"))).unwrap();
    assert_eq!(replica.get(&shape, "fill").unwrap(), json!("#5645d4"));
    assert_eq!(replica.objects_of_type("Shape"), vec![shape]);
}

#[test]
fn rejects_invalid_values_and_missing_required_fields() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    let error = replica.transact(&person(), |tx| tx.set(&shape, "kind", json!("star"))).unwrap_err();
    assert!(matches!(error, KdmError::InvalidValue { .. }));
    let error = replica.transact(&person(), |tx| tx.create("Shape", fields(json!({ "kind": "rect", "x": 1 })))).unwrap_err();
    assert!(matches!(error, KdmError::InvalidValue { field, .. } if field == "y"));
}

#[test]
fn a_failed_transaction_leaves_no_trace_and_cannot_be_undone_into_existence() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    let before = replica.state_hash().unwrap();
    let error = replica
        .transact(&person(), |tx| {
            tx.set(&shape, "x", json!(99))?;
            tx.text_insert(&shape, "label", 0, "partial")?;
            tx.set(&shape, "kind", json!("star"))
        })
        .unwrap_err();
    assert!(matches!(error, KdmError::InvalidValue { .. }));
    assert_eq!(replica.state_hash().unwrap(), before);
    assert!(replica.undo().unwrap());
    assert!(!replica.exists(&shape), "undo reverts the creation, not the rolled-back transaction");
}

#[test]
fn edits_text_by_unicode_scalar_values() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    replica.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, &format!("{}😀{}", from_code_points(&QUARTER), from_code_points(&REVIEW)))).unwrap();
    replica.transact(&person(), |tx| tx.text_insert(&shape, "label", 3, "!")).unwrap();
    assert_eq!(replica.text(&shape, "label").unwrap(), format!("{}😀!{}", from_code_points(&QUARTER), from_code_points(&REVIEW)));
    replica.transact(&person(), |tx| tx.text_delete(&shape, "label", 2, 2)).unwrap();
    assert_eq!(replica.text(&shape, "label").unwrap(), format!("{}{}", from_code_points(&QUARTER), from_code_points(&REVIEW)));
    let error = replica.transact(&person(), |tx| tx.text_insert(&shape, "label", 10, "x")).unwrap_err();
    assert_eq!(error, KdmError::OutOfRange { index: 10, len: 4 });
}

#[test]
fn moves_and_removes_list_items() {
    let mut replica = replica();
    let (page, a) = page_with_shape(&mut replica);
    let b = replica
        .transact(&person(), |tx| {
            let b = tx.create("Shape", fields(json!({ "kind": "ellipse", "x": 0, "y": 0 })))?;
            tx.list_insert(&page, "shapes", 1, &b)?;
            tx.list_move(&page, "shapes", 1, 0)?;
            Ok(b)
        })
        .unwrap();
    assert_eq!(replica.list(&page, "shapes").unwrap(), vec![b.clone(), a.clone()]);
    replica.transact(&person(), |tx| tx.list_remove(&page, "shapes", 0)).unwrap();
    assert_eq!(replica.list(&page, "shapes").unwrap(), vec![a]);
}

#[test]
fn builds_trees_and_refuses_cycles() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    let (parent, child) = replica
        .transact(&person(), |tx| {
            let parent = tx.tree_create(&page, "outline", None, &shape)?;
            let child = tx.tree_create(&page, "outline", Some(&parent), &shape)?;
            Ok((parent, child))
        })
        .unwrap();
    let error = replica.transact(&person(), |tx| tx.tree_move(&page, "outline", &parent, Some(&child))).unwrap_err();
    assert_eq!(error, KdmError::Cycle);
    let nodes = replica.tree(&page, "outline").unwrap();
    assert_eq!(nodes.len(), 2);
    assert_eq!(nodes[1].parent, Some(parent));
}

#[test]
fn snapshots_reload_to_the_same_state() {
    let mut replica = replica();
    page_with_shape(&mut replica);
    let snapshot = replica.snapshot().unwrap();
    let reloaded = Replica::load(schema(), &snapshot, ActorId::from_u64(2).unwrap()).unwrap();
    assert_eq!(reloaded.state_hash().unwrap(), replica.state_hash().unwrap());
    assert_eq!(reloaded.doc_id(), replica.doc_id());
}

#[test]
fn refuses_a_document_of_another_kit() {
    let other =
        std::sync::Arc::new(kition_kdm::Schema::parse(r#"{"kdm":1,"kit":"kit.other","schemaVersion":1,"root":"A","types":{"A":{"fields":{}}}}"#).unwrap());
    let snapshot = replica().snapshot().unwrap();
    assert!(matches!(Replica::load(other, &snapshot, ActorId::random()), Err(KdmError::Schema(_))));
}

#[test]
fn deleting_removes_the_object() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    replica.transact(&Origin::agent("user:test"), |tx| tx.delete(&shape)).unwrap();
    assert!(!replica.exists(&shape));
    assert!(matches!(replica.get(&shape, "x"), Err(KdmError::NotFound(_))));
}

#[test]
fn origins_round_trip_through_their_encoding() {
    let origin = Origin::agent("user:42").with_label("slide.duplicate");
    assert_eq!(Origin::decode(&origin.encode()), Some(origin));
    assert_eq!(Origin::decode("not json"), None);
}

#[test]
fn transactions_report_the_objects_they_changed_and_failures_report_none() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    assert_eq!(replica.take_changed().into_iter().collect::<Vec<_>>(), {
        let mut both = vec![page, shape.clone()];
        both.sort();
        both
    });
    let _ = replica.transact(&person(), |tx| tx.set(&shape, "kind", json!("star")));
    assert!(replica.take_changed().is_empty());
}

#[test]
fn bulk_content_written_at_creation_is_not_undoable() {
    let origin = Origin::new(kition_kdm::OriginKind::Import, "user:test");
    let (mut replica, page) =
        Replica::create_with(schema(), DocId::new(), ActorId::from_u64(1).unwrap(), &origin, |tx| tx.create("Page", fields(json!({ "title": "Imported" }))))
            .unwrap();
    assert_eq!(replica.get(&page, "title").unwrap(), json!("Imported"));
    assert!(!replica.undo().unwrap());
    assert!(replica.exists(&page));
}

/// A failing transaction that tried a register, a text, a list, and an object deletion.
fn failing_edit(replica: &mut Replica, page: &kition_kdm::ObjectId, shape: &kition_kdm::ObjectId) -> KdmError {
    replica
        .transact(&person(), |tx| {
            tx.set(shape, "x", json!(99))?;
            tx.text_insert(shape, "label", 0, "partial")?;
            tx.list_remove(page, "shapes", 0)?;
            tx.delete(shape)?;
            tx.set(page, "title", json!(1))
        })
        .unwrap_err()
}

#[test]
fn a_failed_transaction_changes_neither_the_version_nor_the_exports() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    let snapshot = replica.snapshot().unwrap();
    let before = replica.version();
    assert!(matches!(failing_edit(&mut replica, &page, &shape), KdmError::InvalidValue { .. }));
    assert_eq!(replica.version(), before);
    let bytes = replica.export_changes(&before).unwrap();
    let mut fresh = Replica::load(schema(), &snapshot, ActorId::from_u64(2).unwrap()).unwrap();
    let fresh_hash = fresh.state_hash().unwrap();
    assert!(fresh.import_changes(&bytes).unwrap().is_empty());
    assert_eq!(fresh.version(), before, "the export holds no changes");
    assert_eq!(fresh.state_hash().unwrap(), fresh_hash);
}

#[test]
fn reads_inside_a_transaction_see_its_pending_effects() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    replica
        .transact(&person(), |tx| {
            let created = tx.create("Shape", fields(json!({ "kind": "ellipse", "x": 1, "y": 2 })))?;
            assert!(tx.exists(&created));
            assert_eq!(tx.get(&created, "x")?, json!(1));
            assert_eq!(tx.get(&created, "fill")?, json!(null));
            assert_eq!(tx.text_len(&created, "label")?, 0);
            tx.list_insert(&page, "shapes", 0, &created)?;
            assert_eq!(tx.list_items(&page, "shapes")?, vec![created.clone(), shape.clone()]);
            tx.list_move(&page, "shapes", 0, 1)?;
            assert_eq!(tx.list_items(&page, "shapes")?, vec![shape.clone(), created.clone()]);
            tx.list_remove(&page, "shapes", 0)?;
            assert_eq!(tx.list_items(&page, "shapes")?, vec![created.clone()]);
            tx.text_insert(&shape, "label", 0, &format!("{}😀", from_code_points(&QUARTER)))?;
            assert_eq!(tx.text_len(&shape, "label")?, 3);
            tx.text_delete(&shape, "label", 0, 1)?;
            assert_eq!(tx.text_len(&shape, "label")?, 2);
            tx.set(&shape, "x", json!(42))?;
            assert_eq!(tx.get(&shape, "x")?, json!(42));
            tx.delete(&shape)?;
            assert!(!tx.exists(&shape));
            assert!(matches!(tx.get(&shape, "x"), Err(KdmError::NotFound(_))));
            Ok(())
        })
        .unwrap();
    assert!(!replica.exists(&shape));
    assert_eq!(replica.list(&page, "shapes").unwrap().len(), 1);
}

#[test]
fn a_cycle_formed_only_by_moves_inside_one_transaction_is_rejected_and_leaves_nothing() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    let (a, b) =
        replica.transact(&person(), |tx| Ok((tx.tree_create(&page, "outline", None, &shape)?, tx.tree_create(&page, "outline", None, &shape)?))).unwrap();
    let before = replica.version();
    let error = replica
        .transact(&person(), |tx| {
            tx.tree_move(&page, "outline", &a, Some(&b))?;
            tx.tree_move(&page, "outline", &b, Some(&a))
        })
        .unwrap_err();
    assert_eq!(error, KdmError::Cycle);
    assert_eq!(replica.version(), before);
    let error = replica
        .transact(&person(), |tx| {
            let c = tx.tree_create(&page, "outline", None, &shape)?;
            let d = tx.tree_create(&page, "outline", Some(&c), &shape)?;
            tx.tree_move(&page, "outline", &c, Some(&d))
        })
        .unwrap_err();
    assert_eq!(error, KdmError::Cycle);
    assert_eq!(replica.version(), before);
    assert_eq!(replica.tree(&page, "outline").unwrap().len(), 2);
}

#[test]
fn node_handles_resolve_when_their_transaction_commits() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    let (a, b) = replica
        .transact(&person(), |tx| {
            let a = tx.tree_create(&page, "outline", None, &shape)?;
            let b = tx.tree_create(&page, "outline", None, &shape)?;
            assert_eq!(a, a.clone());
            assert_ne!(a, b, "two unresolved handles are equal only if they are the same handle");
            tx.tree_move(&page, "outline", &b, Some(&a))?;
            Ok((a, b))
        })
        .unwrap();
    let nodes = replica.tree(&page, "outline").unwrap();
    assert_eq!(nodes.len(), 2);
    assert_eq!(nodes[0].node, a);
    assert_eq!(nodes[1].node, b);
    assert_eq!(nodes[1].parent.as_ref(), Some(&a));
}

#[test]
fn a_node_handle_from_a_failed_transaction_is_not_found() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    let mut leaked = None;
    let _ = replica.transact(&person(), |tx| {
        leaked = Some(tx.tree_create(&page, "outline", None, &shape)?);
        Err::<(), _>(KdmError::Cycle)
    });
    let leaked = leaked.unwrap();
    let error = replica.transact(&person(), |tx| tx.tree_move(&page, "outline", &leaked, None)).unwrap_err();
    assert!(matches!(error, KdmError::NotFound(_)), "{error:?}");
    let error = replica.transact(&person(), |tx| tx.tree_create(&page, "outline", Some(&leaked), &shape)).unwrap_err();
    assert!(matches!(error, KdmError::NotFound(_)), "{error:?}");
    assert!(replica.tree(&page, "outline").unwrap().is_empty());
}

#[test]
fn a_failed_operation_changes_nothing_so_the_transaction_can_continue() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    replica
        .transact(&person(), |tx| {
            assert!(tx.list_insert(&page, "shapes", 5, &shape).is_err());
            assert!(tx.text_delete(&shape, "label", 0, 1).is_err());
            tx.text_insert(&shape, "label", 0, "ok")
        })
        .unwrap();
    assert_eq!(replica.list(&page, "shapes").unwrap(), vec![shape.clone()]);
    assert_eq!(replica.text(&shape, "label").unwrap(), "ok");
}

#[test]
fn undo_and_redo_report_the_objects_they_change() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    replica.transact(&person(), |tx| tx.set(&shape, "x", json!(55))).unwrap();
    replica.take_changed();
    assert!(replica.undo().unwrap());
    assert_eq!(replica.get(&shape, "x").unwrap(), json!(10));
    assert_eq!(replica.take_changed().into_iter().collect::<Vec<_>>(), vec![shape.clone()]);
    assert!(replica.redo().unwrap());
    assert_eq!(replica.get(&shape, "x").unwrap(), json!(55));
    assert_eq!(replica.take_changed().into_iter().collect::<Vec<_>>(), vec![shape]);
}

#[test]
fn trees_list_their_nodes_parent_first_in_sibling_order() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    let (a, a1, b, b1) = replica
        .transact(&person(), |tx| {
            let a = tx.tree_create(&page, "outline", None, &shape)?;
            let b = tx.tree_create(&page, "outline", None, &shape)?;
            let a1 = tx.tree_create(&page, "outline", Some(&a), &shape)?;
            let b1 = tx.tree_create(&page, "outline", Some(&b), &shape)?;
            Ok((a, a1, b, b1))
        })
        .unwrap();
    let entries = replica.tree(&page, "outline").unwrap();
    let nodes: Vec<NodeRef> = entries.iter().map(|entry| entry.node.clone()).collect();
    assert_eq!(nodes, vec![a.clone(), a1, b.clone(), b1]);
    let parents: Vec<Option<NodeRef>> = entries.iter().map(|entry| entry.parent.clone()).collect();
    assert_eq!(parents, vec![None, Some(a), None, Some(b)]);
    assert!(entries.iter().all(|entry| entry.object == shape));
}

/// A document whose page outline holds a node without an object (with a child) next to a
/// normal node: written directly with the engine, as no KDM operation can produce it.
fn page_with_an_objectless_node() -> (Vec<u8>, String) {
    use loro::{LoroDoc, LoroMap, LoroMovableList, LoroText, LoroTree};
    let doc = LoroDoc::new();
    let meta = doc.get_map("meta");
    let doc_id = DocId::new();
    meta.insert("docId", doc_id.to_string()).unwrap();
    meta.insert("kit", "kit.test").unwrap();
    meta.insert("schemaVersion", 1).unwrap();
    meta.insert("kdm", 1).unwrap();
    let objects = doc.get_map("objects");
    let shape = objects.insert_container("s", LoroMap::new()).unwrap();
    for (key, value) in [("$type", "Shape"), ("kind", "rect")] {
        shape.insert(key, value).unwrap();
    }
    shape.insert("x", 1).unwrap();
    shape.insert("y", 2).unwrap();
    shape.insert_container("label", LoroText::new()).unwrap();
    let page = objects.insert_container("p", LoroMap::new()).unwrap();
    page.insert("$type", "Page").unwrap();
    page.insert("title", "T").unwrap();
    page.insert_container("shapes", LoroMovableList::new()).unwrap();
    let tree = page.insert_container("outline", LoroTree::new()).unwrap();
    let bare = tree.create(None).unwrap();
    let child = tree.create(bare).unwrap();
    tree.get_meta(child).unwrap().insert("object", "s").unwrap();
    let named = tree.create(None).unwrap();
    tree.get_meta(named).unwrap().insert("object", "s").unwrap();
    doc.commit();
    (common::envelope(&doc_id, &doc.export(loro::ExportMode::Snapshot).unwrap()), "p".into())
}

#[test]
fn tree_reads_skip_a_node_without_an_object_and_its_subtree() {
    let (snapshot, page) = page_with_an_objectless_node();
    let replica = Replica::load(schema(), &snapshot, ActorId::from_u64(2).unwrap()).unwrap();
    let page = kition_kdm::ObjectId::from_string(page);
    let entries = replica.tree(&page, "outline").unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].object.as_str(), "s");
    assert_eq!(entries[0].parent, None);
    let state = replica.state_json().unwrap();
    assert_eq!(state["objects"]["p"]["outline"], json!([{ "children": [], "object": "s" }]));
}

#[test]
fn a_text_deletion_past_the_largest_index_is_out_of_range() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    replica.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "abc")).unwrap();
    let error = replica.transact(&person(), |tx| tx.text_delete(&shape, "label", 1, usize::MAX)).unwrap_err();
    assert_eq!(error, KdmError::OutOfRange { index: 1, len: 3 });
    assert_eq!(replica.text(&shape, "label").unwrap(), "abc");
}

#[test]
fn documents_record_the_kdm_version_next_to_the_schema_version() {
    let state = replica().state_json().unwrap();
    assert_eq!(state["meta"]["kdm"], json!(1));
    assert_eq!(state["meta"]["schemaVersion"], json!(1));
}

#[test]
fn load_refuses_another_kdm_version_and_a_newer_schema() {
    assert!(Replica::load(schema(), &common::raw_snapshot(1, 1), ActorId::random()).is_ok());
    assert!(matches!(Replica::load(schema(), &common::raw_snapshot(2, 1), ActorId::random()), Err(KdmError::Schema(_))));
    let newer = Replica::create(common::schema_v2(), DocId::new(), ActorId::from_u64(1).unwrap()).unwrap();
    let error = Replica::load(schema(), &newer.snapshot().unwrap(), ActorId::random()).err().unwrap();
    assert!(matches!(&error, KdmError::Schema(message) if message.contains("schema version 2")), "{error:?}");
    assert!(Replica::load(common::schema_v2(), &replica().snapshot().unwrap(), ActorId::random()).is_ok());
}

#[test]
fn reads_tolerate_types_and_fields_from_other_schema_versions() {
    let mut old = replica();
    let (_, shape) = page_with_shape(&mut old);
    let mut new = Replica::load(common::schema_v2(), &old.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    // An object written before `caption` existed reads it as empty; writing it is refused.
    assert_eq!(new.text(&shape, "caption").unwrap(), "");
    assert_eq!(new.state_json().unwrap()["objects"][shape.as_str()]["caption"], json!(""));
    let error = new.transact(&person(), |tx| tx.text_insert(&shape, "caption", 0, "x")).unwrap_err();
    assert!(matches!(error, KdmError::NotFound(_)), "{error:?}");
    assert_eq!(new.transact(&person(), |tx| tx.text_len(&shape, "caption")).unwrap(), 0);
    // A type the older schema does not declare reads as its type only.
    let note = new.transact(&person(), |tx| tx.create("Note", fields(json!({ "body": "hi" })))).unwrap();
    let bytes = new.export_changes(&old.version()).unwrap();
    old.import_changes(&bytes).unwrap();
    assert_eq!(old.state_json().unwrap()["objects"][note.as_str()], json!({ "$type": "Note" }));
    old.state_hash().unwrap();
}

#[test]
fn malformed_bytes_are_encoding_errors() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    let snapshot = replica.snapshot().unwrap();
    assert_eq!(&snapshot[..4], b"KDM\x01");
    let engine_only = snapshot[20..].to_vec();
    let truncated = snapshot[..10].to_vec();
    let mut wrong_magic = snapshot.clone();
    wrong_magic[3] = 2;
    for bytes in [b"garbage".to_vec(), Vec::new(), engine_only, truncated, wrong_magic] {
        assert!(matches!(Replica::load(schema(), &bytes, ActorId::random()), Err(KdmError::Encoding(_))));
        let before = replica.version();
        assert!(matches!(replica.import_changes(&bytes), Err(KdmError::Encoding(_))));
        assert_eq!(replica.version(), before);
    }
    assert!(replica.exists(&shape));
}

#[test]
fn importing_another_documents_changes_fails_and_changes_nothing() {
    let mut first = replica();
    page_with_shape(&mut first);
    let mut second = replica();
    let (_, other_shape) = page_with_shape(&mut second);
    let before = (first.version(), first.state_hash().unwrap());
    let error = first.import_changes(&second.export_changes(&kition_kdm::Version::empty()).unwrap()).unwrap_err();
    assert!(matches!(error, KdmError::WrongDocument { .. }), "{error:?}");
    assert_eq!((first.version(), first.state_hash().unwrap()), before);
    assert!(!first.exists(&other_shape));
}

#[test]
fn references_lists_and_trees_refuse_an_existing_target_of_another_type() {
    let schema = std::sync::Arc::new(
        kition_kdm::Schema::parse(
            r#"{"kdm":1,"kit":"kit.of","schemaVersion":1,"root":"A","types":{
                "A":{"fields":{"r":{"kind":"ref","of":"B","optional":true},"l":{"kind":"list","of":"B"},"t":{"kind":"tree","of":"B"}}},
                "B":{"fields":{}}}}"#,
        )
        .unwrap(),
    );
    let mut replica = Replica::create(schema, DocId::new(), ActorId::from_u64(1).unwrap()).unwrap();
    let (a, b, other) = replica
        .transact(&person(), |tx| {
            let b = tx.create("B", fields(json!({})))?;
            let other = tx.create("A", fields(json!({})))?;
            let a = tx.create("A", fields(json!({ "r": b.as_str() })))?;
            Ok((a, b, other))
        })
        .unwrap();
    let wrong = |error: KdmError| matches!(error, KdmError::InvalidValue { .. });
    assert!(wrong(replica.transact(&person(), |tx| tx.set(&a, "r", json!(other.as_str()))).unwrap_err()));
    assert!(wrong(replica.transact(&person(), |tx| tx.create("A", fields(json!({ "r": other.as_str() })))).unwrap_err()));
    assert!(wrong(replica.transact(&person(), |tx| tx.list_insert(&a, "l", 0, &other)).unwrap_err()));
    assert!(wrong(replica.transact(&person(), |tx| tx.tree_create(&a, "t", None, &other)).unwrap_err()));
    // An object created earlier in the same transaction is checked too.
    assert!(wrong(
        replica
            .transact(&person(), |tx| {
                let fresh = tx.create("A", fields(json!({})))?;
                tx.list_insert(&a, "l", 0, &fresh)
            })
            .unwrap_err()
    ));
    // Matching and missing targets are accepted: a dangling reference is a validation state.
    let missing = kition_kdm::ObjectId::new();
    replica
        .transact(&person(), |tx| {
            tx.set(&a, "r", json!(missing.as_str()))?;
            tx.list_insert(&a, "l", 0, &b)?;
            tx.list_insert(&a, "l", 1, &missing)?;
            tx.tree_create(&a, "t", None, &b)?;
            tx.tree_create(&a, "t", None, &missing)?;
            Ok(())
        })
        .unwrap();
    assert_eq!(replica.list(&a, "l").unwrap(), vec![b, missing]);
}

/// A page whose `shapes` list holds a shape id and a number: written directly with the engine,
/// as no KDM operation can produce it. Answers the snapshot, the page id, and the shape id.
fn page_with_a_corrupt_list() -> (Vec<u8>, kition_kdm::ObjectId, kition_kdm::ObjectId) {
    use loro::{LoroDoc, LoroMap, LoroMovableList, LoroText, LoroTree};
    let doc = LoroDoc::new();
    let meta = doc.get_map("meta");
    let doc_id = DocId::new();
    meta.insert("docId", doc_id.to_string()).unwrap();
    meta.insert("kit", "kit.test").unwrap();
    meta.insert("schemaVersion", 1).unwrap();
    meta.insert("kdm", 1).unwrap();
    let objects = doc.get_map("objects");
    let shape = objects.insert_container("s", LoroMap::new()).unwrap();
    shape.insert("$type", "Shape").unwrap();
    shape.insert("kind", "rect").unwrap();
    shape.insert("x", 1).unwrap();
    shape.insert("y", 2).unwrap();
    shape.insert_container("label", LoroText::new()).unwrap();
    let page = objects.insert_container("p", LoroMap::new()).unwrap();
    page.insert("$type", "Page").unwrap();
    page.insert("title", "T").unwrap();
    let shapes = page.insert_container("shapes", LoroMovableList::new()).unwrap();
    shapes.push("s").unwrap();
    shapes.push(5).unwrap();
    page.insert_container("outline", LoroTree::new()).unwrap();
    doc.commit();
    let snapshot = common::envelope(&doc_id, &doc.export(loro::ExportMode::Snapshot).unwrap());
    (snapshot, kition_kdm::ObjectId::from_string("p"), kition_kdm::ObjectId::from_string("s"))
}

#[test]
fn a_list_item_that_is_not_an_id_is_an_error_and_indices_stay_the_engines() {
    let (snapshot, page, shape) = page_with_a_corrupt_list();
    let mut replica = Replica::load(schema(), &snapshot, ActorId::from_u64(2).unwrap()).unwrap();
    assert!(matches!(replica.list(&page, "shapes"), Err(KdmError::Encoding(_))));
    assert!(matches!(replica.state_json(), Err(KdmError::Encoding(_))));
    let error = replica.transact(&person(), |tx| tx.list_insert(&page, "shapes", 3, &shape)).unwrap_err();
    assert_eq!(error, KdmError::OutOfRange { index: 3, len: 2 });
    let error = replica.transact(&person(), |tx| tx.list_items(&page, "shapes")).unwrap_err();
    assert!(matches!(error, KdmError::Encoding(_)), "{error:?}");
    // Validation counts the engine's items, so an index past the bad item lands where asked.
    replica.transact(&person(), |tx| tx.list_insert(&page, "shapes", 2, &shape)).unwrap();
    replica.transact(&person(), |tx| tx.list_remove(&page, "shapes", 1)).unwrap();
    assert_eq!(replica.list(&page, "shapes").unwrap(), vec![shape.clone(), shape]);
}

/// Random list edits in one transaction against a plain vector model, reading the items in the
/// middle of the transaction (`observe`) or never; the engine must end where the model does.
fn list_edits_match_a_model(observe: bool) {
    for seed in 0..20 {
        let mut replica = replica();
        let (page, _) = page_with_shape(&mut replica);
        let mut rng = kition_kdm::testing::Rng::new(seed);
        let model = replica
            .transact(&person(), |tx| {
                let mut model = tx.list_items(&page, "shapes")?;
                for _ in 0..60 {
                    let len = model.len();
                    match rng.below(3) {
                        0 => {
                            let shape = tx.create("Shape", fields(json!({ "kind": "rect", "x": 0, "y": 0 })))?;
                            let at = rng.below(len + 1);
                            tx.list_insert(&page, "shapes", at, &shape)?;
                            model.insert(at, shape);
                        }
                        1 if len > 0 => {
                            let (from, to) = (rng.below(len), rng.below(len));
                            tx.list_move(&page, "shapes", from, to)?;
                            let item = model.remove(from);
                            model.insert(to, item);
                        }
                        _ if len > 0 => {
                            let at = rng.below(len);
                            tx.list_remove(&page, "shapes", at)?;
                            model.remove(at);
                        }
                        _ => {}
                    }
                    if observe && rng.below(3) == 0 {
                        assert_eq!(tx.list_items(&page, "shapes")?, model, "seed {seed}");
                    }
                    assert!(tx.list_insert(&page, "shapes", model.len() + 1, &page).is_err());
                }
                Ok(model)
            })
            .unwrap();
        assert_eq!(replica.list(&page, "shapes").unwrap(), model, "seed {seed}");
    }
}

#[test]
fn list_edits_read_back_mid_transaction_match_the_engine() {
    list_edits_match_a_model(true);
}

#[test]
fn list_edits_never_read_back_match_the_engine() {
    list_edits_match_a_model(false);
}

#[test]
fn tree_cycle_checks_see_earlier_moves_of_the_same_transaction() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    let (a, b, c) = replica
        .transact(&person(), |tx| {
            let a = tx.tree_create(&page, "outline", None, &shape)?;
            let b = tx.tree_create(&page, "outline", Some(&a), &shape)?;
            let c = tx.tree_create(&page, "outline", Some(&b), &shape)?;
            Ok((a, b, c))
        })
        .unwrap();
    replica
        .transact(&person(), |tx| {
            // In the committed tree `a` is an ancestor of `c`; after this move it no longer is.
            tx.tree_move(&page, "outline", &c, None)?;
            tx.tree_move(&page, "outline", &a, Some(&c))?;
            assert_eq!(tx.tree_move(&page, "outline", &c, Some(&b)), Err(KdmError::Cycle));
            let d = tx.tree_create(&page, "outline", Some(&b), &shape)?;
            assert_eq!(tx.tree_move(&page, "outline", &c, Some(&d)), Err(KdmError::Cycle));
            tx.tree_move(&page, "outline", &d, None)
        })
        .unwrap();
    let entries = replica.tree(&page, "outline").unwrap();
    let parent_of = |node: &NodeRef| entries.iter().find(|entry| entry.node == *node).unwrap().parent.clone();
    assert_eq!(parent_of(&c), None);
    assert_eq!(parent_of(&a), Some(c.clone()));
    assert_eq!(parent_of(&b), Some(a));
    assert_eq!(entries.len(), 4);
}

#[test]
fn loading_a_changes_only_export_says_it_is_not_a_snapshot() {
    let mut replica = replica();
    let since = replica.version();
    page_with_shape(&mut replica);
    let error = Replica::load(schema(), &replica.export_changes(&since).unwrap(), ActorId::random()).err().unwrap();
    assert!(matches!(&error, KdmError::Encoding(message) if message.contains("not a snapshot")), "{error:?}");
}

#[test]
fn map_values_refuse_integers_beyond_the_exact_range() {
    let schema = std::sync::Arc::new(
        kition_kdm::Schema::parse(r#"{"kdm":1,"kit":"kit.map","schemaVersion":1,"root":"S","types":{"S":{"fields":{"cells":{"kind":"map"}}}}}"#).unwrap(),
    );
    let mut replica = Replica::create(schema, DocId::new(), ActorId::from_u64(1).unwrap()).unwrap();
    let sheet = replica.transact(&person(), |tx| tx.create("S", fields(json!({})))).unwrap();
    let before = replica.version();
    for bad in [json!(9_007_199_254_740_993_i64), json!({ "v": [u64::MAX] })] {
        let error = replica.transact(&person(), |tx| tx.map_set(&sheet, "cells", "a", bad.clone())).unwrap_err();
        assert!(matches!(error, KdmError::InvalidValue { .. }), "{bad}: {error:?}");
    }
    assert_eq!(replica.version(), before);
    replica.transact(&person(), |tx| tx.map_set(&sheet, "cells", "a", json!({ "v": 9_007_199_254_740_992_i64, "w": 1e16 }))).unwrap();
    assert_eq!(replica.map_get(&sheet, "cells", "a").unwrap(), json!({ "v": 9_007_199_254_740_992_i64, "w": 1e16 }));
}

/// The TypeScript engine loses a `__proto__` key inside a value on read, so no implementation
/// writes one. A map key named `__proto__` is read key by key, so it is kept, as in TypeScript.
#[test]
fn values_refuse_proto_keys_at_any_depth() {
    let schema = std::sync::Arc::new(
        kition_kdm::Schema::parse(r#"{"kdm":1,"kit":"kit.map","schemaVersion":1,"root":"S","types":{"S":{"fields":{"cells":{"kind":"map"}}}}}"#).unwrap(),
    );
    let mut cells = Replica::create(schema, DocId::new(), ActorId::from_u64(1).unwrap()).unwrap();
    let sheet = cells.transact(&person(), |tx| tx.create("S", fields(json!({})))).unwrap();
    let before = cells.version();
    for bad in [json!({ "__proto__": 1 }), json!([1, { "a": { "__proto__": null } }])] {
        let error = cells.transact(&person(), |tx| tx.map_set(&sheet, "cells", "a", bad.clone())).unwrap_err();
        assert!(matches!(error, KdmError::InvalidValue { .. }), "{bad}: {error:?}");
    }
    assert_eq!(cells.version(), before);
    cells.transact(&person(), |tx| tx.map_set(&sheet, "cells", "__proto__", json!({ "a": 1 }))).unwrap();
    assert_eq!(cells.map_get(&sheet, "cells", "__proto__").unwrap(), json!({ "a": 1 }));

    let mut doc = replica();
    let (_, shape) = page_with_shape(&mut doc);
    let before = doc.version();
    for (field, bad) in [("transform", json!({ "a": [{ "__proto__": 1 }] })), ("image", json!({ "hash": "ab", "mime": "x/y", "size": 1, "__proto__": {} }))] {
        let error = doc.transact(&person(), |tx| tx.set(&shape, field, bad.clone())).unwrap_err();
        assert!(matches!(error, KdmError::InvalidValue { .. }), "{bad}: {error:?}");
        let created = doc.transact(&person(), |tx| tx.create("Shape", fields(json!({ "kind": "rect", "x": 0, "y": 0, field: bad.clone() })))).unwrap_err();
        assert!(matches!(created, KdmError::InvalidValue { .. }), "{bad}: {created:?}");
    }
    assert_eq!(doc.version(), before);
}

/// The canonical text of numbers, shared with the TypeScript `canonicalText` (its test pins the
/// same strings): `serde_json`'s shortest round-trip form, whole doubles within ±2^53 as integers.
#[test]
fn canonical_state_writes_numbers_as_every_implementation_does() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    let values = json!([1e16, 9.1e15, -0.0, 1e-6, 0.00001, 1.5e300, 0.1 + 0.2, 12.5, 9_007_199_254_740_992_i64, 1e-7, 1.25e-5, 123e18, -1e16, 5e-324]);
    replica.transact(&person(), |tx| tx.set(&shape, "transform", values)).unwrap();
    let expected = "[1e+16,9100000000000000.0,0,1e-6,0.00001,1.5e+300,0.30000000000000004,12.5,9007199254740992,1e-7,0.0000125,1.23e+20,-1e+16,5e-324]";
    assert!(replica.state_json().unwrap().to_string().contains(&format!(r#""transform":{expected}"#)), "{}", replica.state_json().unwrap());
}

#[test]
fn creates_an_object_under_a_caller_id_and_refuses_a_taken_or_malformed_one() {
    let mut replica = replica();
    let main = ObjectId::from_string("page:main");
    let id = replica.transact(&person(), |tx| tx.create_with_id("Page", &main, fields(json!({ "title": "A" })))).unwrap();
    assert_eq!(id, main);
    assert_eq!(replica.get(&main, "title").unwrap(), json!("A"));
    let before = replica.version();
    let error = replica.transact(&person(), |tx| tx.create_with_id("Page", &main, fields(json!({ "title": "B" })))).unwrap_err();
    assert_eq!(error.to_string(), "field `$id` of `Page` cannot be `page:main`: that object id is taken");
    let bad = ObjectId::from_string("bad id!");
    let error = replica.transact(&person(), |tx| tx.create_with_id("Page", &bad, fields(json!({ "title": "B" })))).unwrap_err();
    assert_eq!(error.to_string(), "field `$id` of `Page` cannot be `bad id!`: an object id matches `[A-Za-z0-9][A-Za-z0-9:_-]{0,127}`");
    assert_eq!(replica.version(), before);
}

#[test]
fn refuses_the_same_caller_id_twice_in_one_transaction() {
    let mut replica = replica();
    let p1 = ObjectId::from_string("p1");
    let error = replica
        .transact(&person(), |tx| {
            tx.create_with_id("Page", &p1, fields(json!({ "title": "A" })))?;
            tx.create_with_id("Page", &p1, fields(json!({ "title": "B" })))
        })
        .unwrap_err();
    assert!(matches!(error, KdmError::InvalidValue { .. }));
    assert!(!replica.exists(&p1));
}

#[test]
fn caller_ids_follow_the_pattern_and_stay_taken_after_a_delete_in_the_transaction() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    let long = "a".repeat(129);
    for bad in ["", "-a", ":a", "a b", "a/b", "é", long.as_str()] {
        let id = ObjectId::from_string(bad);
        let error = replica.transact(&person(), |tx| tx.create_with_id("Page", &id, fields(json!({ "title": "A" })))).unwrap_err();
        assert!(matches!(error, KdmError::InvalidValue { .. }), "{bad:?}");
    }
    let longest = "a".repeat(128);
    for good in ["a", "0", "A:b_c-d", longest.as_str()] {
        let id = ObjectId::from_string(good);
        assert_eq!(replica.transact(&person(), |tx| tx.create_with_id("Page", &id, fields(json!({ "title": "A" })))).unwrap(), id);
    }
    let error = replica
        .transact(&person(), |tx| {
            tx.delete(&shape)?;
            tx.create_with_id("Shape", &shape, fields(json!({ "kind": "rect", "x": 1, "y": 2 })))
        })
        .unwrap_err();
    assert!(matches!(error, KdmError::InvalidValue { .. }));
    assert_eq!(replica.get(&shape, "x").unwrap(), json!(10));
    let id = ObjectId::from_string("p2");
    let error = replica.transact(&person(), |tx| tx.create_with_id("Page", &id, fields(json!({})))).unwrap_err();
    assert!(matches!(error, KdmError::InvalidValue { field, .. } if field == "title"));
}

#[test]
fn reports_undo_availability() {
    let mut replica = replica();
    assert!(!replica.can_undo());
    assert!(!replica.can_redo());
    page_with_shape(&mut replica);
    assert!(replica.can_undo());
    replica.undo().unwrap();
    assert!(!replica.can_undo());
    assert!(replica.can_redo());
    replica.redo().unwrap();
    assert!(!replica.can_redo());
}

#[test]
fn system_transactions_are_not_undo_steps() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    replica.undo().unwrap();
    assert!(!replica.can_undo());
    let repaired = replica
        .transact(&Origin::system("repair"), |tx| {
            let page = tx.create("Page", fields(json!({ "title": "Two" })))?;
            let made = tx.create("Shape", fields(json!({ "kind": "rect", "x": 1, "y": 2 })))?;
            tx.list_insert(&page, "shapes", 0, &made)?;
            Ok(made)
        })
        .unwrap();
    assert!(!replica.can_undo());
    assert!(!replica.exists(&shape));

    replica.transact(&person(), |tx| tx.set(&repaired, "x", json!(5))).unwrap();
    replica.transact(&Origin::system("migrate"), |tx| tx.set(&repaired, "y", json!(9))).unwrap();
    assert!(replica.undo().unwrap());
    assert_eq!(replica.get(&repaired, "x").unwrap(), json!(1));
    assert_eq!(replica.get(&repaired, "y").unwrap(), json!(9));
    assert!(!replica.can_undo());
}

#[test]
fn import_transactions_are_not_undo_steps() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    let imported = Origin::new(kition_kdm::OriginKind::Import, "file");
    replica.transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
    replica.transact(&imported, |tx| tx.set(&shape, "y", json!(9))).unwrap();
    assert!(replica.undo().unwrap());
    assert_eq!(replica.get(&shape, "x").unwrap(), json!(10));
    assert_eq!(replica.get(&shape, "y").unwrap(), json!(9));
    // The only step left is the person's creation of the shape; the import is never one.
    assert!(replica.undo().unwrap());
    assert!(!replica.exists(&shape));
    assert!(!replica.can_undo());
}

#[test]
fn undoes_a_group_of_transactions_as_one_step() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    replica.begin_undo_group().unwrap();
    replica.transact(&person(), |tx| tx.set(&shape, "x", json!(1))).unwrap();
    replica.transact(&person(), |tx| tx.set(&shape, "y", json!(2))).unwrap();
    replica.end_undo_group();
    assert!(replica.undo().unwrap());
    assert_eq!(replica.get(&shape, "x").unwrap(), json!(10));
    assert_eq!(replica.get(&shape, "y").unwrap(), json!(20));
    replica.begin_undo_group().unwrap();
    let error = replica.begin_undo_group().unwrap_err();
    assert_eq!(error.to_string(), "field `group` of `$undo` is already open");
    replica.end_undo_group();
    replica.end_undo_group();
    replica.begin_undo_group().unwrap();
    replica.end_undo_group();
}

#[test]
fn undo_while_grouping_ends_the_group_and_reverts_it_as_one_step() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    replica.begin_undo_group().unwrap();
    replica.transact(&person(), |tx| tx.set(&shape, "x", json!(1))).unwrap();
    replica.transact(&person(), |tx| tx.set(&shape, "y", json!(2))).unwrap();
    replica.transact(&person(), |tx| tx.set(&shape, "fill", json!("#000"))).unwrap();
    assert!(replica.undo().unwrap());
    let state = [replica.get(&shape, "x").unwrap(), replica.get(&shape, "y").unwrap(), replica.get(&shape, "fill").unwrap()];
    assert_eq!(state, [json!(10), json!(20), json!(null)]);
    replica.begin_undo_group().unwrap();
    replica.end_undo_group();
    assert!(replica.exists(&shape));
}

#[test]
fn redo_while_grouping_ends_the_group_first() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    replica.transact(&person(), |tx| tx.set(&shape, "x", json!(1))).unwrap();
    assert!(replica.undo().unwrap());
    replica.begin_undo_group().unwrap();
    assert!(replica.redo().unwrap());
    assert_eq!(replica.get(&shape, "x").unwrap(), json!(1));
    replica.transact(&person(), |tx| tx.set(&shape, "y", json!(2))).unwrap();
    assert!(replica.undo().unwrap());
    assert_eq!([replica.get(&shape, "x").unwrap(), replica.get(&shape, "y").unwrap()], [json!(1), json!(20)]);
    replica.begin_undo_group().unwrap();
    replica.end_undo_group();
}

#[test]
fn an_import_that_changes_what_the_group_changed_splits_the_group_into_two_undo_steps() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    let mut other = Replica::load(schema(), &replica.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    let since = other.version();
    other.transact(&person(), |tx| tx.set(&shape, "fill", json!("#111"))).unwrap();
    replica.begin_undo_group().unwrap();
    replica.transact(&person(), |tx| tx.set(&shape, "x", json!(1))).unwrap();
    replica.import_changes(&other.export_changes(&since).unwrap()).unwrap();
    replica.transact(&person(), |tx| tx.set(&shape, "y", json!(2))).unwrap();
    replica.transact(&person(), |tx| tx.set(&shape, "kind", json!("ellipse"))).unwrap();
    replica.end_undo_group();
    let state = |replica: &Replica| ["x", "y", "kind", "fill"].map(|field| replica.get(&shape, field).unwrap());
    assert!(replica.undo().unwrap());
    assert_eq!(state(&replica), [json!(1), json!(20), json!("rect"), json!("#111")]);
    assert!(replica.undo().unwrap());
    assert_eq!(state(&replica), [json!(10), json!(20), json!("rect"), json!("#111")]);
    replica.begin_undo_group().unwrap();
    replica.end_undo_group();
}

#[test]
fn an_import_that_leaves_the_group_alone_keeps_the_group_one_undo_step() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    let mut other = Replica::load(schema(), &replica.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    let since = other.version();
    let page = other.transact(&person(), |tx| tx.create("Page", fields(json!({ "title": "Theirs" })))).unwrap();
    replica.begin_undo_group().unwrap();
    replica.transact(&person(), |tx| tx.set(&shape, "x", json!(1))).unwrap();
    replica.import_changes(&other.export_changes(&since).unwrap()).unwrap();
    replica.transact(&person(), |tx| tx.set(&shape, "y", json!(2))).unwrap();
    replica.end_undo_group();
    assert!(replica.undo().unwrap());
    assert_eq!([replica.get(&shape, "x").unwrap(), replica.get(&shape, "y").unwrap()], [json!(10), json!(20)]);
    assert!(replica.exists(&page));
    replica.begin_undo_group().unwrap();
    replica.end_undo_group();
}
