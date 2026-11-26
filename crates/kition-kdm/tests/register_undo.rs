// Copied from kition-sdk crates/kition-kdm/tests/register_undo.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Undo and redo of transactions that only write registers (register fields, keys of map fields):
//! the replica writes back the values they replaced, which it noted when they committed, instead
//! of asking the engine to look them up in the document's history (case
//! regressions/issue-kdm-bulk-undo-memory). Every other transaction stays the engine's undo step.
//! These tests hold the two kinds of steps to one behaviour: the same scripts give the same states
//! either way, replicas converge, and steps of both kinds group, keep later changes, and survive
//! an object's deletion and return.

use kition_kdm::testing::Rng;
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, UndoScope};
use serde_json::{Value, json};

mod common;
use common::{fields, person, schema};

fn agent() -> Origin {
    Origin::agent("user:test").with_label("ai/run")
}

fn id(name: &str) -> ObjectId {
    ObjectId::from_string(name.to_owned())
}

const SHEETS: [&str; 2] = ["s0", "s1"];
const SHAPES: [&str; 2] = ["h0", "h1"];

/// A document of two sheets with cells `k0`..`k2`, two shapes in a page, made before undo
/// history starts, on `count` replicas (actors 1, 2, ...).
fn replicas(count: u64) -> Vec<Replica> {
    let (first, ()) = Replica::create_with(schema(), DocId::new(), ActorId::from_u64(1).unwrap(), &Origin::system("import"), |tx| {
        let page = tx.create_with_id("Page", &id("p0"), fields(json!({ "title": "Page" })))?;
        for (index, shape) in SHAPES.iter().enumerate() {
            tx.create_with_id("Shape", &id(shape), fields(json!({ "kind": "rect", "x": index, "y": 0 })))?;
            tx.list_insert(&page, "shapes", index, &id(shape))?;
        }
        for sheet in SHEETS {
            tx.create_with_id("Sheet", &id(sheet), fields(json!({})))?;
            for key in 0..3 {
                tx.map_set(&id(sheet), "cells", &format!("k{key}"), json!(format!("{sheet}.{key}")))?;
            }
        }
        Ok(())
    })
    .unwrap();
    let snapshot = first.snapshot().unwrap();
    let mut all = vec![first];
    for actor in 2..=count {
        all.push(Replica::load(schema(), &snapshot, ActorId::from_u64(actor).unwrap()).unwrap());
    }
    all
}

fn objects(replica: &Replica) -> Value {
    replica.state_json().unwrap()["objects"].clone()
}

fn sync(replicas: &mut [Replica]) {
    for from in 0..replicas.len() {
        for to in 0..replicas.len() {
            if from != to {
                let bytes = replicas[from].export_changes(&replicas[to].version()).unwrap();
                replicas[to].import_changes(&bytes).unwrap();
            }
        }
    }
}

/// One register write of a script.
#[derive(Clone, Debug)]
enum Write {
    Cell(usize, usize, Option<i64>),
    Field(usize, &'static str, i64),
}

/// One step of a script.
#[derive(Clone, Debug)]
enum Action {
    Write { replica: usize, agent: bool, writes: Vec<Write> },
    Undo { replica: usize, agent: bool },
    Redo { replica: usize, agent: bool },
    Group { replica: usize, open: bool },
}

fn script(seed: u64, replicas: usize, length: usize) -> Vec<Action> {
    let mut rng = Rng::new(seed);
    // Above every value the document starts with.
    let mut fresh = 100;
    (0..length)
        .map(|_| {
            let replica = rng.below(replicas);
            let agent = rng.below(4) == 0;
            match rng.below(10) {
                0..=4 => {
                    // A field set to a new value first (fields are only ever set), so every
                    // transaction changes something.
                    let mut writes = Vec::new();
                    for index in 0..1 + rng.below(3) {
                        fresh += 1;
                        writes.push(match rng.below(3) {
                            _ if index == 0 => Write::Field(rng.below(2), ["x", "y"][rng.below(2)], fresh),
                            0 => Write::Field(rng.below(2), ["x", "y"][rng.below(2)], fresh),
                            _ => Write::Cell(rng.below(2), rng.below(3), (rng.below(3) > 0).then_some(fresh)),
                        });
                    }
                    Action::Write { replica, agent, writes }
                }
                5 | 6 => Action::Undo { replica, agent },
                7 => Action::Redo { replica, agent },
                _ => Action::Group { replica, open: rng.below(2) == 0 },
            }
        })
        .collect()
}

/// Runs `actions` on `replicas`, syncing all after each when `sync_each`. With `engine`, each
/// write also inserts and removes a list item, which leaves the list as it was but makes the
/// transaction the engine's undo step. Answers what each undo and redo returned.
fn run(replicas: &mut [Replica], actions: &[Action], engine: bool, sync_each: bool) -> Vec<bool> {
    let mut answers = Vec::new();
    for action in actions {
        match action {
            Action::Write { replica, agent: by_agent, writes } => {
                let origin = if *by_agent { agent() } else { person() };
                replicas[*replica]
                    .transact(&origin, |tx| {
                        for write in writes {
                            match write {
                                Write::Cell(sheet, key, Some(value)) => tx.map_set(&id(SHEETS[*sheet]), "cells", &format!("k{key}"), json!(value))?,
                                Write::Cell(sheet, key, None) => tx.map_delete(&id(SHEETS[*sheet]), "cells", &format!("k{key}"))?,
                                Write::Field(shape, field, value) => tx.set(&id(SHAPES[*shape]), field, json!(value))?,
                            }
                        }
                        if engine {
                            tx.list_insert(&id("p0"), "shapes", 0, &id("h0"))?;
                            tx.list_remove(&id("p0"), "shapes", 0)?;
                        }
                        Ok(())
                    })
                    .unwrap();
            }
            Action::Undo { replica, agent } => {
                let scope = if *agent { UndoScope::Agent } else { UndoScope::Person };
                answers.push(replicas[*replica].undo_in(scope).unwrap().is_done());
            }
            Action::Redo { replica, agent } => {
                let scope = if *agent { UndoScope::Agent } else { UndoScope::Person };
                answers.push(replicas[*replica].redo_in(scope).unwrap().is_done());
            }
            Action::Group { replica, open: true } => {
                let _ = replicas[*replica].begin_undo_group();
            }
            Action::Group { replica, open: false } => replicas[*replica].end_undo_group(),
        }
        if sync_each {
            sync(replicas);
        }
    }
    answers
}

/// The same scripts give the same states and undo answers whether their writes are steps the
/// replica keeps or the engine's, with every change delivered to every replica between
/// actions: other replicas' and the other scope's later writes kept, groups one step, redo
/// symmetric.
#[test]
fn register_steps_undo_and_redo_as_the_engines_steps_do() {
    for seed in 0..40 {
        let actions = script(seed, 3, 40);
        let mut kept = replicas(3);
        let mut engine = replicas(3);
        for (at, action) in actions.iter().enumerate() {
            let answers = (run(&mut kept, std::slice::from_ref(action), false, true), run(&mut engine, std::slice::from_ref(action), true, true));
            let what = || format!("seed {seed}, after {:?}", &actions[..=at]);
            assert_eq!(answers.0, answers.1, "{}: undo and redo answers", what());
            for (index, (a, b)) in kept.iter().zip(&engine).enumerate() {
                assert_eq!(objects(a), objects(b), "{}: replica {index}", what());
                // A step the replica keeps is never missing from the engine's history. The engine
                // can hold one more: when a step's undo changes nothing it undoes the one before
                // it in the same call, and that one's own step is left with nothing to replay
                // (the next undo skips it, as the replica skips its empty steps).
                for scope in [UndoScope::Person, UndoScope::Agent] {
                    assert!(!a.can_undo_in(scope) || b.can_undo_in(scope), "{}: replica {index} can undo", what());
                    assert!(!a.can_redo_in(scope) || b.can_redo_in(scope), "{}: replica {index} can redo", what());
                }
            }
        }
    }
}

/// Two replicas write the same cell and different cells at once; one undoes. The cell the other
/// wrote later keeps its value, the rest goes back, and both replicas end equal.
#[test]
fn an_undo_keeps_the_cells_another_replica_wrote_later_and_converges() {
    let mut net = replicas(2);
    let sheet = id("s0");
    net[0]
        .transact(&person(), |tx| {
            tx.map_set(&sheet, "cells", "k0", json!("mine"))?;
            tx.map_set(&sheet, "cells", "k1", json!("mine"))
        })
        .unwrap();
    sync(&mut net);
    net[1]
        .transact(&person(), |tx| {
            tx.map_set(&sheet, "cells", "k1", json!("theirs"))?;
            tx.map_set(&sheet, "cells", "k2", json!("theirs"))
        })
        .unwrap();
    sync(&mut net);
    assert!(net[0].undo().unwrap().is_done());
    sync(&mut net);
    let cells = |replica: &Replica| ["k0", "k1", "k2"].map(|key| replica.map_get(&sheet, "cells", key).unwrap());
    assert_eq!(cells(&net[0]), [json!("s0.0"), json!("theirs"), json!("theirs")]);
    assert_eq!(cells(&net[1]), cells(&net[0]));
    assert!(net[0].redo().unwrap().is_done());
    sync(&mut net);
    assert_eq!(cells(&net[0]), [json!("mine"), json!("theirs"), json!("theirs")]);
    assert_eq!(objects(&net[1]), objects(&net[0]));
}

/// An undo group with register writes and other edits undoes and redoes as one step.
#[test]
fn a_group_of_register_writes_and_other_edits_is_one_step() {
    let mut replica = replicas(1).remove(0);
    let shape = id("h0");
    let before = objects(&replica);
    replica.begin_undo_group().unwrap();
    replica.transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
    replica.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "Hello")).unwrap();
    replica.transact(&person(), |tx| tx.map_set(&id("s1"), "cells", "k0", json!("grouped"))).unwrap();
    replica.end_undo_group();
    let after = objects(&replica);
    assert!(replica.undo().unwrap().is_done());
    assert_eq!(objects(&replica), before);
    assert!(!replica.can_undo());
    assert!(replica.redo().unwrap().is_done());
    assert_eq!(objects(&replica), after);
    assert!(replica.undo().unwrap().is_done());
    assert_eq!(objects(&replica), before);
}

/// A register step undone after the object was deleted and brought back by an undo (the engine
/// makes its maps anew) writes back into the object as it is now.
#[test]
fn a_register_step_undoes_into_an_object_deleted_and_brought_back() {
    let mut replica = replicas(1).remove(0);
    let (shape, sheet) = (id("h1"), id("s0"));
    replica.transact(&person(), |tx| tx.set(&shape, "x", json!(50))).unwrap();
    replica.transact(&person(), |tx| tx.map_set(&sheet, "cells", "k0", json!("changed"))).unwrap();
    let written = objects(&replica);
    replica
        .transact(&person(), |tx| {
            tx.delete(&shape)?;
            tx.delete(&sheet)
        })
        .unwrap();
    assert!(!replica.exists(&shape));
    assert!(replica.undo().unwrap().is_done());
    assert_eq!(objects(&replica), written);
    assert!(replica.undo().unwrap().is_done());
    assert!(replica.undo().unwrap().is_done());
    assert_eq!(replica.get(&shape, "x").unwrap(), json!(1));
    assert_eq!(replica.map_get(&sheet, "cells", "k0").unwrap(), json!("s0.0"));
    assert!(replica.redo().unwrap().is_done());
    assert!(replica.redo().unwrap().is_done());
    assert_eq!(objects(&replica), written);
}

/// Another replica deletes an object after this one wrote it: the undo leaves the object deleted
/// and still writes back the rest.
#[test]
fn an_undo_after_another_replica_deleted_the_object_writes_back_the_rest() {
    let mut net = replicas(2);
    let (gone, kept) = (id("s0"), id("s1"));
    net[0]
        .transact(&person(), |tx| {
            tx.map_set(&gone, "cells", "k0", json!(1))?;
            tx.map_set(&kept, "cells", "k0", json!(2))
        })
        .unwrap();
    sync(&mut net);
    net[1].transact(&person(), |tx| tx.delete(&gone)).unwrap();
    sync(&mut net);
    assert!(net[0].undo().unwrap().is_done());
    sync(&mut net);
    assert!(!net[0].exists(&gone));
    assert_eq!(net[0].map_get(&kept, "cells", "k0").unwrap(), json!("s1.0"));
    assert_eq!(objects(&net[1]), objects(&net[0]));
}

/// The person's register step keeps a cell the agent wrote later, and the agent's keeps the
/// person's (M12a); each scope's redo puts back only its own.
#[test]
fn register_steps_keep_the_other_scopes_later_writes() {
    let mut replica = replicas(1).remove(0);
    let sheet = id("s0");
    let cell = |replica: &Replica, key: &str| replica.map_get(&sheet, "cells", key).unwrap();
    replica.transact(&person(), |tx| tx.map_set(&sheet, "cells", "k0", json!("person"))).unwrap();
    replica
        .transact(&agent(), |tx| {
            tx.map_set(&sheet, "cells", "k0", json!("agent"))?;
            tx.map_set(&sheet, "cells", "k1", json!("agent"))
        })
        .unwrap();
    assert!(replica.undo().unwrap().is_done());
    assert_eq!([cell(&replica, "k0"), cell(&replica, "k1")], [json!("agent"), json!("agent")]);
    assert!(replica.undo_in(UndoScope::Agent).unwrap().is_done());
    // The agent's undo writes back what its step replaced: the person's value, which nothing
    // wrote since (the person's undo kept the agent's value instead of writing its own).
    assert_eq!([cell(&replica, "k0"), cell(&replica, "k1")], [json!("person"), json!("s0.1")]);
    assert!(replica.redo_in(UndoScope::Agent).unwrap().is_done());
    assert_eq!([cell(&replica, "k0"), cell(&replica, "k1")], [json!("agent"), json!("agent")]);
}

/// A step with nothing left to write back (another replica deleted every object it wrote) is
/// dropped, and the same undo takes back the step before it, as the engine does with its own.
#[test]
fn an_undo_skips_a_step_whose_objects_are_all_gone() {
    let mut net = replicas(2);
    let (shape, sheet) = (id("h0"), id("s0"));
    net[0].transact(&person(), |tx| tx.set(&shape, "x", json!(50))).unwrap();
    net[0].transact(&person(), |tx| tx.map_set(&sheet, "cells", "k0", json!("gone soon"))).unwrap();
    sync(&mut net);
    net[1].transact(&person(), |tx| tx.delete(&sheet)).unwrap();
    sync(&mut net);
    assert!(net[0].undo().unwrap().is_done());
    assert_eq!(net[0].get(&shape, "x").unwrap(), json!(0));
    assert!(!net[0].can_undo());
    assert!(net[0].redo().unwrap().is_done());
    assert_eq!(net[0].get(&shape, "x").unwrap(), json!(50));
    assert!(!net[0].redo().unwrap().is_done(), "the dropped step has nothing to redo");
}
