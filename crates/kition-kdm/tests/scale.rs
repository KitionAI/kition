// Copied from kition-sdk crates/kition-kdm/tests/scale.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Costs that grow with the document or the change, not with their square (plan 2026-11-24, plain
//! model, review fix G5). Each bound is generous for a debug build, and far below what the
//! quadratic code took: deleting 20,000 objects of 200,000 read every object once per deletion
//! (4·10^9 steps), an undo of a 100,000-operation change recursed once per operation (a stack
//! overflow), and text of 100,000 runs re-merged every run once per run (10^10 steps).

mod common;

use std::time::{Duration, Instant};

use common::{fields, person, schema};
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica};
use serde_json::json;

fn replica() -> Replica {
    Replica::create(schema(), DocId::new(), ActorId::from_u64(1).unwrap()).unwrap()
}

#[track_caller]
fn within(started: Instant, bound: Duration, what: &str) {
    let took = started.elapsed();
    assert!(took < bound, "{what} took {took:?}, more than {bound:?}");
}

#[test]
fn deleting_20000_objects_of_200000_is_linear() {
    let (mut replica, shapes) = Replica::create_with(schema(), DocId::new(), ActorId::from_u64(1).unwrap(), &Origin::system("import"), |tx| {
        (0..200_000).map(|n| tx.create("Shape", fields(json!({ "kind": "rect", "x": n, "y": 0 })))).collect::<kition_kdm::Result<Vec<ObjectId>>>()
    })
    .unwrap();
    let started = Instant::now();
    replica
        .transact(&person(), |tx| {
            for shape in shapes.iter().step_by(10) {
                tx.delete(shape)?;
            }
            Ok(())
        })
        .unwrap();
    within(started, Duration::from_secs(30), "deleting 20,000 objects");
    assert!(!replica.exists(&shapes[0]) && replica.exists(&shapes[1]));
}

#[test]
fn undoing_a_100000_operation_change_carried_over_a_later_edit_is_linear() {
    let mut replica = replica();
    let shape = replica.transact(&person(), |tx| tx.create("Shape", fields(json!({ "kind": "rect", "x": 0, "y": 0 })))).unwrap();
    replica
        .transact(&person(), |tx| {
            for n in 0..100_000 {
                tx.text_insert(&shape, "label", n, "a")?;
            }
            Ok(())
        })
        .unwrap();
    // Another scope's edit to the same text: the undo's 100,000 deletions are carried over it.
    replica.transact(&Origin::agent("agent:writer"), |tx| tx.text_insert(&shape, "label", 0, "X")).unwrap();
    let started = Instant::now();
    assert!(replica.undo().unwrap().is_done());
    within(started, Duration::from_secs(30), "the undo");
    assert_eq!(replica.text(&shape, "label").unwrap(), "X");
}

#[test]
fn text_of_100000_runs_loads_in_linear_time() {
    let runs: Vec<String> =
        (0..100_000).map(|n| if n % 2 == 0 { r#"{"attributes":{"bold":true},"insert":"a"}"#.to_owned() } else { r#"{"insert":"b"}"#.to_owned() }).collect();
    let schema = std::sync::Arc::new(
        kition_kdm::Schema::parse(
            r#"{"kdm":1,"kit":"kit.runs","schemaVersion":1,"root":"Doc","types":{"Doc":{"fields":{"body":{"kind":"text","marks":{"bold":{"expand":"after"}}}}}}}"#,
        )
        .unwrap(),
    );
    let content = format!(
        "{{\"kdm\":1,\"kit\":\"kit.runs\",\"docId\":\"0193a5c4-0000-7000-8000-000000000001\",\"schemaVersion\":1,\"objects\":{{\n\"d\":{{\"$type\":\"Doc\",\"body\":[{}]}}\n}}}}\n",
        runs.join(",")
    );
    let started = Instant::now();
    let replica = Replica::load(schema, content.as_bytes(), ActorId::from_u64(2).unwrap()).unwrap();
    assert_eq!(replica.text_delta(&ObjectId::from_string("d"), "body").unwrap().len(), 100_000);
    assert_eq!(replica.content_snapshot().unwrap(), content.into_bytes());
    within(started, Duration::from_secs(30), "loading and saving 100,000 runs");
}
