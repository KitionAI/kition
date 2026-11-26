// Copied from kition-sdk crates/kition-kdm/tests/bulk_touches.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! A transaction that writes many objects (a table's whole column cleared, pasted or filled)
//! notes its undo footprint in time proportional to its writes (case
//! regressions/issue-kition-table-bulk-write). Before, each write was merged into the footprint
//! with a search and a sort of everything noted so far, so a 100,000-record write spent most of
//! its time there.

use std::time::Instant;

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, UndoScope};
use serde_json::json;

mod common;
use common::{fields, person, schema};

/// A replica holding `count` shapes, made before undo history starts, as an import makes them.
fn shapes(count: usize) -> (Replica, Vec<ObjectId>) {
    Replica::create_with(schema(), DocId::new(), ActorId::from_u64(1).unwrap(), &Origin::system("import"), |tx| {
        (0..count).map(|index| tx.create("Shape", fields(json!({ "kind": "rect", "x": index, "y": 0 })))).collect()
    })
    .unwrap()
}

/// Sets `x` and then `y` of every shape, the later shapes first, in one person's transaction.
fn write_every(replica: &mut Replica, ids: &[ObjectId], value: i64) {
    replica
        .transact(&person(), |tx| {
            for id in ids.iter().rev() {
                tx.set(id, "x", json!(value))?;
            }
            for id in ids.iter().rev() {
                tx.set(id, "y", json!(value))?;
            }
            Ok(())
        })
        .unwrap();
}

/// Seconds per written shape of [`write_every`] on `count` shapes, the fastest of two.
fn seconds_per_shape(count: usize) -> f64 {
    (0..2)
        .map(|round| {
            let (mut replica, ids) = shapes(count);
            let started = Instant::now();
            write_every(&mut replica, &ids, round);
            started.elapsed().as_secs_f64() / count as f64
        })
        .fold(f64::INFINITY, f64::min)
}

#[test]
fn a_large_transaction_notes_one_touch_per_object_with_every_field() {
    let (mut replica, ids) = shapes(500);
    write_every(&mut replica, &ids, 7);
    let touches = replica.undo_touches_in(UndoScope::Person);
    let mut expected: Vec<String> = ids.iter().map(ToString::to_string).collect();
    expected.sort();
    assert_eq!(touches.iter().map(|touch| touch.id.clone()).collect::<Vec<_>>(), expected, "one touch per object, sorted by id");
    for touch in &touches {
        let fields: Vec<&str> = touch.fields.as_ref().expect("fields, not the whole object").iter().map(String::as_str).collect();
        assert_eq!(fields, ["x", "y"], "{}", touch.id);
    }
    assert!(replica.undo().unwrap().is_done());
    assert!(ids.iter().enumerate().all(|(index, id)| replica.get(id, "x").unwrap() == json!(index) && replica.get(id, "y").unwrap() == json!(0)));
    assert!(replica.redo().unwrap().is_done());
    assert!(ids.iter().all(|id| replica.get(id, "x").unwrap() == json!(7) && replica.get(id, "y").unwrap() == json!(7)));
}

/// A write of eight times the objects costs about eight times as much: per object, at most
/// three times a small write's (a search and a sort per write made it eight times and more).
#[test]
fn a_large_transaction_costs_about_the_same_per_object_as_a_small_one() {
    let small = seconds_per_shape(1_500);
    let large = seconds_per_shape(12_000);
    println!("per shape, 12,000 against 1,500: {:.2}", large / small);
    assert!(large < small * 3.0, "a write of 12,000 shapes costs {:.1} times as much per shape as one of 1,500", large / small);
}

/// Merging undo groups (rule M12b) keeps one touch per object across the group's transactions.
#[test]
fn a_group_of_large_transactions_merges_its_touches() {
    let (mut replica, ids) = shapes(300);
    replica.begin_undo_group().unwrap();
    let (first, second) = ids.split_at(200);
    replica
        .transact(&person(), |tx| {
            for id in first.iter().rev() {
                tx.set(id, "x", json!(1))?;
            }
            Ok(())
        })
        .unwrap();
    replica
        .transact(&person(), |tx| {
            for id in ids[100..].iter().chain(second) {
                tx.set(id, "y", json!(2))?;
            }
            Ok(())
        })
        .unwrap();
    replica.end_undo_group();
    let touches = replica.undo_touches_in(UndoScope::Person);
    assert!(touches.windows(2).all(|pair| pair[0].id < pair[1].id), "sorted by id, one per object");
    assert_eq!(touches.len(), ids.len());
    for (index, id) in ids.iter().enumerate() {
        let touch = touches.iter().find(|touch| touch.id == id.as_str()).unwrap();
        let fields: Vec<&str> = touch.fields.as_ref().unwrap().iter().map(String::as_str).collect();
        let expected: &[&str] = if index < 100 {
            &["x"]
        } else if index < 200 {
            &["x", "y"]
        } else {
            &["y"]
        };
        assert_eq!(fields, expected, "{id}");
    }
}
