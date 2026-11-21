// Copied from kition-sdk crates/kition-kdm/tests/undo_nothing.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! An undo step whose changes come to nothing (Enter then Backspace in one typing group, a value
//! written and written back) changes nothing when undone, so undo and redo pass over it: the same
//! undo takes back the step before it, as Loro's undo did with its own steps before the replica
//! kept its steps itself (case regressions/issue-kdm-undo-step-that-changed-nothing). Before, the
//! replica undid such a group as a step of its own: an Undo that changed nothing, and the
//! person's typing before it stayed.

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica};
use serde_json::json;

mod common;
use common::{fields, person, schema};

fn shape() -> ObjectId {
    ObjectId::from_string("h0".to_owned())
}

/// A shape labelled "start" at x 10, made before undo history starts.
fn replica() -> Replica {
    let (replica, ()) = Replica::create_with(schema(), DocId::new(), ActorId::from_u64(1).unwrap(), &Origin::system("import"), |tx| {
        tx.create_with_id("Shape", &shape(), fields(json!({ "kind": "rect", "x": 10, "y": 20 })))?;
        tx.text_insert(&shape(), "label", 0, "start")
    })
    .unwrap();
    replica
}

/// The label and x, then whether the person can undo and redo.
fn state(replica: &Replica) -> (String, i64, bool, bool) {
    let x = replica.get(&shape(), "x").unwrap().as_i64().unwrap();
    (replica.text(&shape(), "label").unwrap(), x, replica.can_undo(), replica.can_redo())
}

fn type_text(replica: &mut Replica, at: usize, text: &str) {
    replica.transact(&person(), |tx| tx.text_insert(&shape(), "label", at, text)).unwrap();
}

/// The ways a step comes to nothing.
#[derive(Clone, Copy, Debug)]
enum Nothing {
    /// Enter, then Backspace, in one undo group.
    TextGroup,
    /// A line break inserted and deleted in one transaction.
    TextTransaction,
    /// x set to 1, then back to 10, in one undo group.
    RegisterGroup,
    /// x set to 1, then back to 10, in one transaction.
    RegisterTransaction,
    /// A line break typed, x set to 1, the line break deleted and x set back, in one group.
    MixedGroup,
}

const ALL: [Nothing; 5] = [Nothing::TextGroup, Nothing::TextTransaction, Nothing::RegisterGroup, Nothing::RegisterTransaction, Nothing::MixedGroup];

fn nothing(replica: &mut Replica, kind: Nothing) {
    let line_break = |replica: &mut Replica| type_text(replica, 0, "\n");
    let backspace = |replica: &mut Replica| replica.transact(&person(), |tx| tx.text_delete(&shape(), "label", 0, 1)).unwrap();
    let x = |replica: &mut Replica, value: i64| replica.transact(&person(), |tx| tx.set(&shape(), "x", json!(value))).unwrap();
    match kind {
        Nothing::TextGroup => {
            replica.begin_undo_group().unwrap();
            line_break(replica);
            backspace(replica);
            replica.end_undo_group();
        }
        Nothing::TextTransaction => replica
            .transact(&person(), |tx| {
                tx.text_insert(&shape(), "label", 0, "\n")?;
                tx.text_delete(&shape(), "label", 0, 1)
            })
            .unwrap(),
        Nothing::RegisterGroup => {
            replica.begin_undo_group().unwrap();
            x(replica, 1);
            x(replica, 10);
            replica.end_undo_group();
        }
        Nothing::RegisterTransaction => replica
            .transact(&person(), |tx| {
                tx.set(&shape(), "x", json!(1))?;
                tx.set(&shape(), "x", json!(10))
            })
            .unwrap(),
        Nothing::MixedGroup => {
            replica.begin_undo_group().unwrap();
            line_break(replica);
            x(replica, 1);
            backspace(replica);
            x(replica, 10);
            replica.end_undo_group();
        }
    }
}

#[test]
fn one_undo_after_a_step_that_changed_nothing_takes_back_the_step_before() {
    for kind in ALL {
        let mut replica = replica();
        type_text(&mut replica, 5, "x");
        nothing(&mut replica, kind);
        assert_eq!(state(&replica), ("startx".into(), 10, true, false), "{kind:?}");
        assert!(replica.undo().unwrap(), "{kind:?}");
        assert_eq!(state(&replica), ("start".into(), 10, false, true), "{kind:?}: the typing is undone and no step is left");
        assert!(!replica.undo().unwrap(), "{kind:?}");
        assert!(replica.redo().unwrap(), "{kind:?}");
        assert_eq!(state(&replica), ("startx".into(), 10, true, false), "{kind:?}: one redo puts the typing back, and no step is left");
        assert!(!replica.redo().unwrap(), "{kind:?}");
        // Undo and redo again: the step that changed nothing stays out of both.
        assert!(replica.undo().unwrap(), "{kind:?}");
        assert_eq!(state(&replica), ("start".into(), 10, false, true), "{kind:?}");
        assert!(replica.redo().unwrap(), "{kind:?}");
        assert_eq!(state(&replica), ("startx".into(), 10, true, false), "{kind:?}");
    }
}

#[test]
fn an_undo_of_only_a_step_that_changed_nothing_changes_nothing_and_answers_false() {
    for kind in ALL {
        let mut replica = replica();
        nothing(&mut replica, kind);
        assert!(!replica.undo().unwrap(), "{kind:?}");
        assert_eq!(state(&replica), ("start".into(), 10, false, false), "{kind:?}");
        assert!(!replica.redo().unwrap(), "{kind:?}");
    }
}

#[test]
fn undo_and_redo_pass_over_a_step_that_changed_nothing_between_two_others() {
    for kind in ALL {
        let mut replica = replica();
        type_text(&mut replica, 5, "a");
        nothing(&mut replica, kind);
        type_text(&mut replica, 6, "b");
        assert!(replica.undo().unwrap(), "{kind:?}");
        assert_eq!(state(&replica), ("starta".into(), 10, true, true), "{kind:?}");
        assert!(replica.undo().unwrap(), "{kind:?}");
        assert_eq!(state(&replica), ("start".into(), 10, false, true), "{kind:?}");
        assert!(replica.redo().unwrap(), "{kind:?}");
        assert_eq!(state(&replica), ("starta".into(), 10, true, true), "{kind:?}");
        assert!(replica.redo().unwrap(), "{kind:?}");
        assert_eq!(state(&replica), ("startab".into(), 10, true, false), "{kind:?}");
        assert!(replica.undo().unwrap(), "{kind:?}");
        assert!(replica.undo().unwrap(), "{kind:?}");
        assert_eq!(state(&replica), ("start".into(), 10, false, true), "{kind:?}");
    }
}

/// A group that changes something besides what cancels out stays a step: its undo takes back
/// only that.
#[test]
fn a_group_that_changed_something_besides_what_cancels_out_is_a_step() {
    let mut replica = replica();
    type_text(&mut replica, 5, "x");
    replica.begin_undo_group().unwrap();
    type_text(&mut replica, 0, "\n");
    replica.transact(&person(), |tx| tx.set(&shape(), "x", json!(1))).unwrap();
    replica.transact(&person(), |tx| tx.text_delete(&shape(), "label", 0, 1)).unwrap();
    replica.end_undo_group();
    assert!(replica.undo().unwrap());
    assert_eq!(state(&replica), ("startx".into(), 10, true, true));
    assert!(replica.redo().unwrap());
    assert_eq!(state(&replica), ("startx".into(), 1, true, false));
    assert!(replica.undo().unwrap());
    assert!(replica.undo().unwrap());
    assert_eq!(state(&replica), ("start".into(), 10, false, true));
}

/// A step that changed nothing still clears the steps to redo, as a new step does.
#[test]
fn a_step_that_changed_nothing_clears_the_redo_steps() {
    for kind in [Nothing::TextGroup, Nothing::TextTransaction, Nothing::RegisterGroup, Nothing::MixedGroup] {
        let mut replica = replica();
        type_text(&mut replica, 5, "x");
        assert!(replica.undo().unwrap());
        nothing(&mut replica, kind);
        assert!(!replica.can_redo(), "{kind:?}");
        assert!(!replica.redo().unwrap(), "{kind:?}");
        assert_eq!(replica.text(&shape(), "label").unwrap(), "start", "{kind:?}");
    }
}

/// A group whose changes another replica then took back (it deleted the text the group typed) has
/// nothing left to replay: undo passes over it as well, as before.
#[test]
fn a_group_whose_changes_another_replica_took_back_is_passed_over() {
    let mut mine = replica();
    let mut theirs = Replica::load(schema(), &mine.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    mine.transact(&person(), |tx| tx.set(&shape(), "x", json!(50))).unwrap();
    mine.begin_undo_group().unwrap();
    type_text(&mut mine, 5, "a");
    type_text(&mut mine, 6, "b");
    mine.end_undo_group();
    theirs.import_changes(&mine.export_changes(&theirs.version()).unwrap()).unwrap();
    theirs.transact(&person(), |tx| tx.text_delete(&shape(), "label", 5, 2)).unwrap();
    mine.import_changes(&theirs.export_changes(&mine.version()).unwrap()).unwrap();
    assert_eq!(state(&mine), ("start".into(), 50, true, false));
    assert!(mine.undo().unwrap());
    assert_eq!(state(&mine), ("start".into(), 10, false, true));
    assert!(mine.redo().unwrap());
    assert_eq!(state(&mine), ("start".into(), 50, true, false));
}
