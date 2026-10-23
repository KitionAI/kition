// Copied from kition-sdk crates/kition-kdm/tests/undo_scopes.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Undo scopes (rule M12a): on one replica, the person's undo and an agent's undo each take back
//! only their own steps and keep the other's, as undo keeps other replicas' changes.
//! `packages/kdm/test/undo-scopes.test.ts` is the TypeScript twin.

use kition_kdm::{ActorId, DocId, ObjectId, Origin, OriginKind, Replica, UndoScope};
use serde_json::json;

mod common;
use common::{fields, page_with_shape, person, schema};

fn agent() -> Origin {
    Origin::agent("user:test").with_label("ai/run")
}

fn replica() -> (Replica, ObjectId, ObjectId) {
    let mut replica = Replica::create(schema(), DocId::new(), ActorId::from_u64(1).unwrap()).unwrap();
    let (page, shape) = page_with_shape(&mut replica);
    (replica, page, shape)
}

fn label(replica: &Replica, shape: &ObjectId) -> String {
    replica.text(shape, "label").unwrap()
}

fn append(replica: &mut Replica, origin: &Origin, shape: &ObjectId, text: &str) {
    replica
        .transact(origin, |tx| {
            let at = tx.text_len(shape, "label")?;
            tx.text_insert(shape, "label", at, text)
        })
        .unwrap();
}

fn set_title(replica: &mut Replica, origin: &Origin, page: &ObjectId, title: &str) {
    replica.transact(origin, |tx| tx.set(page, "title", json!(title))).unwrap();
}

#[test]
fn the_persons_undo_skips_the_agents_steps_and_keeps_their_text() {
    let (mut replica, _, shape) = replica();
    append(&mut replica, &person(), &shape, "Mine.");
    append(&mut replica, &agent(), &shape, " Agent.");
    assert!(replica.can_undo_in(UndoScope::Agent));

    assert!(replica.undo().unwrap());
    assert_eq!(label(&replica, &shape), " Agent.");
    assert!(replica.redo().unwrap());
    assert_eq!(label(&replica, &shape), "Mine. Agent.");
}

#[test]
fn the_agents_undo_takes_back_only_its_step_and_keeps_the_persons_later_typing() {
    let (mut replica, _, shape) = replica();
    append(&mut replica, &agent(), &shape, "Agent.");
    append(&mut replica, &person(), &shape, " Mine.");

    assert!(replica.undo_in(UndoScope::Agent).unwrap());
    assert_eq!(label(&replica, &shape), " Mine.");
    assert!(!replica.can_undo_in(UndoScope::Agent));
    assert!(replica.can_redo_in(UndoScope::Agent));
    assert!(replica.redo_in(UndoScope::Agent).unwrap());
    assert_eq!(label(&replica, &shape), "Agent. Mine.");
}

#[test]
fn an_undo_keeps_a_register_the_other_scope_wrote_later() {
    let (mut replica, page, _) = replica();
    set_title(&mut replica, &person(), &page, "Mine");
    set_title(&mut replica, &agent(), &page, "Agent");
    assert!(replica.undo().unwrap());
    assert_eq!(replica.get(&page, "title").unwrap(), json!("Agent"), "the agent wrote the title after the person");

    let (mut replica, page, _) = self::replica();
    set_title(&mut replica, &agent(), &page, "Agent");
    set_title(&mut replica, &person(), &page, "Mine");
    assert!(replica.undo_in(UndoScope::Agent).unwrap());
    assert_eq!(replica.get(&page, "title").unwrap(), json!("Mine"), "the person wrote the title after the agent");
    // The person's own undo still takes their title back.
    assert!(replica.undo().unwrap());
    assert_ne!(replica.get(&page, "title").unwrap(), json!("Mine"));
}

#[test]
fn an_undo_group_makes_one_step_in_each_scope() {
    let (mut replica, _, shape) = replica();
    replica.begin_undo_group().unwrap();
    append(&mut replica, &agent(), &shape, "One.");
    append(&mut replica, &agent(), &shape, " Two.");
    replica.end_undo_group();
    append(&mut replica, &person(), &shape, " Mine.");

    assert!(replica.undo_in(UndoScope::Agent).unwrap());
    assert_eq!(label(&replica, &shape), " Mine.");
    assert!(!replica.can_undo_in(UndoScope::Agent));
}

#[test]
fn scripts_are_the_persons_steps_and_repairs_are_nobodys() {
    let (mut replica, _, shape) = replica();
    // `page_with_shape` was the person's first step.
    append(&mut replica, &Origin::new(OriginKind::Extension, "user:test"), &shape, "Script.");
    append(&mut replica, &Origin::system("repair"), &shape, " Repair.");
    assert!(!replica.can_undo_in(UndoScope::Agent));
    assert!(replica.undo().unwrap());
    assert_eq!(label(&replica, &shape), " Repair.");
}

#[test]
fn a_draft_the_agent_made_merges_as_the_persons_step() {
    let (mut replica, _, shape) = replica();
    let mut draft = replica.fork(ActorId::from_u64(9).unwrap()).unwrap();
    append(&mut draft, &agent(), &shape, "Drafted.");
    let since = replica.version();
    replica.merge_changes(&draft.export_changes(&since).unwrap(), &agent()).unwrap();
    assert_eq!(label(&replica, &shape), "Drafted.");
    assert!(!replica.can_undo_in(UndoScope::Agent));
    assert!(replica.undo().unwrap());
    assert_eq!(label(&replica, &shape), "");
}

#[test]
fn other_replicas_changes_survive_both_scopes_undo() {
    let (mut replica, page, shape) = replica();
    let mut other = Replica::load(schema(), &replica.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    append(&mut replica, &agent(), &shape, "Agent.");
    other.transact(&person(), |tx| tx.create("Shape", fields(json!({ "kind": "rect", "x": 0, "y": 0 }))).map(drop)).unwrap();
    set_title(&mut other, &person(), &page, "Theirs");
    replica.import_changes(&other.export_changes(&replica.version()).unwrap()).unwrap();

    assert!(replica.undo_in(UndoScope::Agent).unwrap());
    assert_eq!(label(&replica, &shape), "");
    assert_eq!(replica.get(&page, "title").unwrap(), json!("Theirs"));
}
