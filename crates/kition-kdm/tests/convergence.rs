// Copied from kition-sdk crates/kition-kdm/tests/convergence.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The convergence suite subset of phase 1 (architecture section 16).

use kition_kdm::testing::{Network, Rng};
use serde_json::json;

mod common;
use common::{CHARACTER, QUARTER, fields, from_code_points, page_with_shape, person, schema};

fn network(count: usize, seed: u64) -> Network {
    Network::new(schema(), count, seed).unwrap()
}

#[test]
fn different_fields_of_one_object_both_survive() {
    let mut net = network(2, 1);
    let (_, shape) = page_with_shape(&mut net.replicas[0]);
    net.sync_all().unwrap();
    net.replicas[0].transact(&person(), |tx| tx.set(&shape, "x", json!(111))).unwrap();
    net.replicas[1].transact(&person(), |tx| tx.set(&shape, "fill", json!("#000000"))).unwrap();
    net.sync_all().unwrap();
    net.converged().unwrap();
    assert_eq!(net.replicas[1].get(&shape, "x").unwrap(), json!(111));
    assert_eq!(net.replicas[0].get(&shape, "fill").unwrap(), json!("#000000"));
}

#[test]
fn the_same_field_resolves_to_one_value_everywhere() {
    let mut net = network(3, 2);
    let (_, shape) = page_with_shape(&mut net.replicas[0]);
    net.sync_all().unwrap();
    for (index, value) in [1, 2, 3].into_iter().enumerate() {
        net.replicas[index].transact(&person(), |tx| tx.set(&shape, "x", json!(value))).unwrap();
    }
    net.sync_all().unwrap();
    net.converged().unwrap();
}

#[test]
fn concurrent_creation_produces_distinct_ids() {
    let mut net = network(2, 3);
    let (page, _) = page_with_shape(&mut net.replicas[0]);
    net.sync_all().unwrap();
    let mut created = Vec::new();
    for replica in &mut net.replicas {
        created.push(
            replica
                .transact(&person(), |tx| {
                    let shape = tx.create("Shape", fields(json!({ "kind": "rect", "x": 0, "y": 0 })))?;
                    tx.list_insert(&page, "shapes", 0, &shape)?;
                    Ok(shape)
                })
                .unwrap(),
        );
    }
    assert_ne!(created[0], created[1]);
    net.sync_all().unwrap();
    net.converged().unwrap();
    assert_eq!(net.replicas[0].list(&page, "shapes").unwrap().len(), 3);
}

#[test]
fn concurrent_text_at_one_position_keeps_both_insertions() {
    let mut net = network(2, 4);
    let (_, shape) = page_with_shape(&mut net.replicas[0]);
    net.replicas[0].transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "ab")).unwrap();
    net.sync_all().unwrap();
    net.replicas[0].transact(&person(), |tx| tx.text_insert(&shape, "label", 1, &format!("{}😀", from_code_points(&QUARTER)))).unwrap();
    net.replicas[1].transact(&person(), |tx| tx.text_insert(&shape, "label", 1, "XY")).unwrap();
    net.sync_all().unwrap();
    net.converged().unwrap();
    let text = net.replicas[0].text(&shape, "label").unwrap();
    assert!(text.contains(&format!("{}😀", from_code_points(&QUARTER))) && text.contains("XY") && text.starts_with('a') && text.ends_with('b'), "{text}");
}

#[test]
fn concurrent_reorders_never_duplicate_items() {
    let mut net = network(2, 5);
    let (page, _) = page_with_shape(&mut net.replicas[0]);
    net.replicas[0]
        .transact(&person(), |tx| {
            for index in 1..4 {
                let shape = tx.create("Shape", fields(json!({ "kind": "rect", "x": index, "y": 0 })))?;
                tx.list_insert(&page, "shapes", index, &shape)?;
            }
            Ok(())
        })
        .unwrap();
    net.sync_all().unwrap();
    net.replicas[0].transact(&person(), |tx| tx.list_move(&page, "shapes", 0, 3)).unwrap();
    net.replicas[1].transact(&person(), |tx| tx.list_move(&page, "shapes", 0, 1)).unwrap();
    net.sync_all().unwrap();
    net.converged().unwrap();
    let mut items = net.replicas[0].list(&page, "shapes").unwrap();
    items.sort();
    items.dedup();
    assert_eq!(items.len(), 4);
}

#[test]
fn concurrent_moves_that_would_form_a_cycle_converge_to_a_tree() {
    let mut net = network(2, 6);
    let (page, shape) = page_with_shape(&mut net.replicas[0]);
    let (a, b) = net.replicas[0]
        .transact(&person(), |tx| Ok((tx.tree_create(&page, "outline", None, &shape)?, tx.tree_create(&page, "outline", None, &shape)?)))
        .unwrap();
    net.sync_all().unwrap();
    net.replicas[0].transact(&person(), |tx| tx.tree_move(&page, "outline", &a, Some(&b))).unwrap();
    net.replicas[1].transact(&person(), |tx| tx.tree_move(&page, "outline", &b, Some(&a))).unwrap();
    net.sync_all().unwrap();
    net.converged().unwrap();
    let nodes = net.replicas[0].tree(&page, "outline").unwrap();
    assert_eq!(nodes.len(), 2, "both nodes remain reachable from the root");
    assert_eq!(nodes.iter().filter(|entry| entry.parent.is_none()).count(), 1);
}

#[test]
fn delete_wins_over_a_concurrent_edit() {
    let mut net = network(2, 7);
    let (_, shape) = page_with_shape(&mut net.replicas[0]);
    net.sync_all().unwrap();
    net.replicas[0].transact(&person(), |tx| tx.delete(&shape)).unwrap();
    net.replicas[1].transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
    net.sync_all().unwrap();
    net.converged().unwrap();
    assert!(!net.replicas[1].exists(&shape));
}

#[test]
fn undo_keeps_a_collaborators_later_change() {
    let mut net = network(2, 8);
    let (_, shape) = page_with_shape(&mut net.replicas[0]);
    net.sync_all().unwrap();
    net.replicas[0].transact(&person(), |tx| tx.set(&shape, "x", json!(50))).unwrap();
    net.sync_all().unwrap();
    net.replicas[1].transact(&person(), |tx| tx.set(&shape, "y", json!(70))).unwrap();
    net.sync_all().unwrap();
    assert!(net.replicas[0].undo().unwrap());
    net.sync_all().unwrap();
    net.converged().unwrap();
    assert_eq!(net.replicas[1].get(&shape, "x").unwrap(), json!(10));
    assert_eq!(net.replicas[1].get(&shape, "y").unwrap(), json!(70));
}

#[test]
fn undo_and_redo_keep_a_collaborators_later_write_to_the_same_field() {
    let mut net = network(2, 8);
    let (_, shape) = page_with_shape(&mut net.replicas[0]);
    net.sync_all().unwrap();
    net.replicas[0].transact(&person(), |tx| tx.set(&shape, "x", json!(50))).unwrap();
    net.replicas[0].transact(&person(), |tx| tx.set(&shape, "y", json!(60))).unwrap();
    net.sync_all().unwrap();
    net.replicas[1].transact(&person(), |tx| tx.set(&shape, "x", json!(70))).unwrap();
    net.sync_all().unwrap();
    // Undoing y reverts y alone; undoing x keeps the collaborator's later 70.
    assert!(net.replicas[0].undo().unwrap());
    assert!(net.replicas[0].undo().unwrap());
    net.sync_all().unwrap();
    net.converged().unwrap();
    assert_eq!(net.replicas[1].get(&shape, "x").unwrap(), json!(70));
    assert_eq!(net.replicas[1].get(&shape, "y").unwrap(), json!(20));
    // Redo restores the person's y, and still keeps the collaborator's x.
    assert!(net.replicas[0].redo().unwrap());
    assert!(net.replicas[0].redo().unwrap());
    net.sync_all().unwrap();
    net.converged().unwrap();
    assert_eq!(net.replicas[0].get(&shape, "x").unwrap(), json!(70));
    assert_eq!(net.replicas[0].get(&shape, "y").unwrap(), json!(60));
    // The kept value is not an undo step of its own.
    assert!(net.replicas[0].undo().unwrap());
    assert_eq!(net.replicas[0].get(&shape, "y").unwrap(), json!(20));
}

#[test]
fn undo_reverts_a_field_another_replica_put_back_to_this_replicas_value() {
    let mut net = network(2, 8);
    let (_, shape) = page_with_shape(&mut net.replicas[0]);
    net.sync_all().unwrap();
    net.replicas[0].transact(&person(), |tx| tx.set(&shape, "x", json!(50))).unwrap();
    net.sync_all().unwrap();
    // Replica 1 writes x and takes it back: the value is replica 0's own again.
    net.replicas[1].transact(&person(), |tx| tx.set(&shape, "x", json!(70))).unwrap();
    assert!(net.replicas[1].undo().unwrap());
    net.sync_all().unwrap();
    assert_eq!(net.replicas[0].get(&shape, "x").unwrap(), json!(50));
    assert!(net.replicas[0].undo().unwrap());
    net.sync_all().unwrap();
    net.converged().unwrap();
    assert_eq!(net.replicas[1].get(&shape, "x").unwrap(), json!(10));
}

#[test]
fn undo_still_reverts_a_field_nobody_else_wrote_later() {
    let mut net = network(2, 8);
    let (_, shape) = page_with_shape(&mut net.replicas[0]);
    net.sync_all().unwrap();
    net.replicas[1].transact(&person(), |tx| tx.set(&shape, "x", json!(70))).unwrap();
    net.sync_all().unwrap();
    net.replicas[0].transact(&person(), |tx| tx.set(&shape, "x", json!(80))).unwrap();
    assert!(net.replicas[0].undo().unwrap());
    assert_eq!(net.replicas[0].get(&shape, "x").unwrap(), json!(70));
}

#[test]
fn import_reports_the_changed_objects() {
    let mut net = network(2, 9);
    let (page, shape) = page_with_shape(&mut net.replicas[0]);
    net.replicas[0].take_changed();
    let bytes = net.replicas[0].export_changes(&net.replicas[1].version()).unwrap();
    let changed = net.replicas[1].import_changes(&bytes).unwrap();
    assert!(changed.contains(&page) && changed.contains(&shape), "{changed:?}");
    net.sync_all().unwrap();
    net.replicas[0].transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "x")).unwrap();
    let bytes = net.replicas[0].export_changes(&net.replicas[1].version()).unwrap();
    assert_eq!(net.replicas[1].import_changes(&bytes).unwrap().into_iter().collect::<Vec<_>>(), vec![shape]);
}

/// Random edits on three replicas with partial delivery between rounds, for many seeds.
#[test]
fn random_edits_converge_in_any_delivery_order() {
    for seed in 0..25 {
        let mut net = network(3, seed);
        let (page, _) = page_with_shape(&mut net.replicas[0]);
        net.sync_all().unwrap();
        let mut rng = Rng::new(seed + 1000);
        for _round in 0..8 {
            for index in 0..net.replicas.len() {
                let shapes = net.replicas[index].list(&page, "shapes").unwrap();
                let pick = rng.below(4);
                let n = rng.below(1000);
                let target = shapes[rng.below(shapes.len())].clone();
                let at = rng.below(shapes.len());
                net.replicas[index]
                    .transact(&person(), |tx| match pick {
                        0 => {
                            let shape = tx.create("Shape", fields(json!({ "kind": "rect", "x": n, "y": 0 })))?;
                            tx.list_insert(&page, "shapes", at, &shape)
                        }
                        1 => tx.set(&target, "x", json!(n)),
                        2 => tx.text_insert(&target, "label", 0, &format!("{n}{}", from_code_points(&CHARACTER))),
                        _ => tx.list_move(&page, "shapes", at, 0),
                    })
                    .unwrap();
            }
            let from = rng.below(3);
            let to = (from + 1 + rng.below(2)) % 3;
            net.deliver(from, to).unwrap();
        }
        net.sync_all().unwrap();
        net.converged().unwrap_or_else(|difference| panic!("seed {seed}: {difference}"));
    }
}

/// A failing transaction on replica 0 that touched `shape` and the page's list.
fn fail_on_first(net: &mut kition_kdm::testing::Network, edit: impl FnOnce(&mut kition_kdm::Tx<'_>) -> kition_kdm::Result<()>) {
    let error = net.replicas[0]
        .transact(&person(), |tx| {
            edit(tx)?;
            tx.create("Shape", fields(json!({ "kind": "star", "x": 0, "y": 0 }))).map(|_| ())
        })
        .unwrap_err();
    assert!(matches!(error, kition_kdm::KdmError::InvalidValue { .. }));
}

#[test]
fn a_failed_transaction_does_not_overwrite_a_concurrent_register_write() {
    let mut net = network(2, 10);
    let (_, shape) = page_with_shape(&mut net.replicas[0]);
    net.sync_all().unwrap();
    net.replicas[1].transact(&person(), |tx| tx.set(&shape, "x", json!(50))).unwrap();
    fail_on_first(&mut net, |tx| tx.set(&shape, "x", json!(99)));
    net.sync_all().unwrap();
    net.converged().unwrap();
    assert_eq!(net.replicas[0].get(&shape, "x").unwrap(), json!(50));
}

#[test]
fn a_failed_delete_keeps_a_collaborators_edits_to_the_object() {
    let mut net = network(2, 11);
    let (_, shape) = page_with_shape(&mut net.replicas[0]);
    net.sync_all().unwrap();
    net.replicas[1]
        .transact(&person(), |tx| {
            tx.text_insert(&shape, "label", 0, "kept")?;
            tx.set(&shape, "y", json!(77))
        })
        .unwrap();
    fail_on_first(&mut net, |tx| tx.delete(&shape));
    net.sync_all().unwrap();
    net.converged().unwrap();
    assert_eq!(net.replicas[0].text(&shape, "label").unwrap(), "kept");
    assert_eq!(net.replicas[0].get(&shape, "y").unwrap(), json!(77));
}

#[test]
fn a_failed_list_removal_does_not_resurrect_a_concurrently_removed_item() {
    let mut net = network(2, 12);
    let (page, _) = page_with_shape(&mut net.replicas[0]);
    net.sync_all().unwrap();
    net.replicas[1].transact(&person(), |tx| tx.list_remove(&page, "shapes", 0)).unwrap();
    fail_on_first(&mut net, |tx| tx.list_remove(&page, "shapes", 0));
    net.sync_all().unwrap();
    net.converged().unwrap();
    assert!(net.replicas[0].list(&page, "shapes").unwrap().is_empty());
}

#[test]
fn the_test_network_reports_bad_input_instead_of_panicking() {
    assert!(Network::new(schema(), 0, 1).is_err());
    let mut net = network(2, 13);
    assert!(net.deliver(0, 2).is_err());
    assert!(net.deliver(5, 0).is_err());
    net.replicas.clear();
    assert!(net.converged().is_err());
    assert!(net.sync_all().is_ok());
    assert_eq!(Rng::new(1).below(0), 0);
}

/// The objects a tree names more than once, with how many nodes name each.
fn named_twice(replica: &kition_kdm::Replica, page: &kition_kdm::ObjectId) -> Vec<(kition_kdm::ObjectId, usize)> {
    let mut counts: std::collections::BTreeMap<kition_kdm::ObjectId, usize> = std::collections::BTreeMap::new();
    for entry in replica.tree(page, "outline").unwrap() {
        *counts.entry(entry.object).or_default() += 1;
    }
    counts.into_iter().filter(|(_, count)| *count > 1).collect()
}

/// A redo that recreates a node another replica's concurrent move kept alive (the engine's redo
/// of a create makes a new node when the old one is deleted locally): after the merge two nodes
/// name one object, and `tree_dedupe` (M10b) leaves one on every replica, the same one, with the
/// other node's children under it.
#[test]
fn a_redo_concurrent_with_a_move_names_its_object_once_after_the_repair() {
    let mut net = network(2, 9);
    let (page, shape) = page_with_shape(&mut net.replicas[0]);
    let (frame, child) = net.replicas[0]
        .transact(&person(), |tx| {
            let frame = tx.create("Shape", fields(json!({ "kind": "rect", "x": 0, "y": 0 })))?;
            let child = tx.create("Shape", fields(json!({ "kind": "ellipse", "x": 1, "y": 1 })))?;
            let node = tx.tree_create(&page, "outline", None, &frame)?;
            tx.tree_create(&page, "outline", None, &shape)?;
            tx.tree_create(&page, "outline", Some(&node), &child)?;
            Ok((frame, child))
        })
        .unwrap();
    // Replica 0's next step: a new node for a new shape, and the child moved under it.
    let added = net.replicas[0]
        .transact(&person(), |tx| {
            let added = tx.create("Shape", fields(json!({ "kind": "rect", "x": 2, "y": 2 })))?;
            let node = tx.tree_create(&page, "outline", None, &added)?;
            let entries = tx.tree(&page, "outline")?;
            let child_node = entries.iter().find(|e| e.object == child).map(|e| e.node.clone()).unwrap();
            tx.tree_move(&page, "outline", &child_node, Some(&node))?;
            Ok(added)
        })
        .unwrap();
    net.sync_all().unwrap();
    // Replica 0 undoes it (its node is deleted); replica 1, not having seen the undo, moves that
    // node under the frame, after enough writes that its move is the later one.
    assert!(net.replicas[0].undo().unwrap());
    for x in 0..4 {
        net.replicas[1].transact(&person(), |tx| tx.set(&shape, "x", json!(x))).unwrap();
    }
    net.replicas[1]
        .transact(&person(), |tx| {
            let entries = tx.tree(&page, "outline")?;
            let node = entries.iter().find(|e| e.object == added).map(|e| e.node.clone()).unwrap();
            let target = entries.iter().find(|e| e.object == frame).map(|e| e.node.clone()).unwrap();
            tx.tree_move(&page, "outline", &node, Some(&target))
        })
        .unwrap();
    // Replica 0 redoes: its engine makes a new node for the shape and moves the child under it.
    assert!(net.replicas[0].redo().unwrap());
    net.sync_all().unwrap();
    net.converged().unwrap();
    assert_eq!(named_twice(&net.replicas[0], &page), vec![(added.clone(), 2)], "the merge names the redone shape twice");

    // Both replicas repair the same state concurrently; their repairs agree.
    for replica in &mut net.replicas {
        let removed = replica.transact(&kition_kdm::Origin::system("repair"), |tx| tx.tree_dedupe(&page, "outline")).unwrap();
        assert_eq!(removed, 1);
    }
    net.sync_all().unwrap();
    net.converged().unwrap();
    for replica in &net.replicas {
        assert!(named_twice(replica, &page).is_empty());
        let entries = replica.tree(&page, "outline").unwrap();
        let kept = entries.iter().find(|e| e.object == added).map(|e| e.node.clone()).unwrap();
        let under = entries.iter().find(|e| e.object == child).and_then(|e| e.parent.clone());
        assert_eq!(under, Some(kept), "the removed node's child moves under the kept node");
        assert_eq!(entries.len(), 4);
    }
    // A repaired tree needs no repair.
    let again = net.replicas[0].transact(&kition_kdm::Origin::system("repair"), |tx| tx.tree_dedupe(&page, "outline")).unwrap();
    assert_eq!(again, 0);
}
