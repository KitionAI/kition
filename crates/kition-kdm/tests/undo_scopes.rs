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
fn list_footprints_follow_earlier_edits_and_new_owners() {
    let (mut replica, page, shape) = replica();
    let (second, third) = replica
        .transact(&Origin::system("fixture"), |tx| {
            let b = tx.create("Shape", fields(json!({"kind":"rect", "x":0, "y":0})))?;
            let c = tx.create("Shape", fields(json!({"kind":"rect", "x":0, "y":0})))?;
            tx.list_insert(&page, "shapes", 1, &b)?;
            tx.list_insert(&page, "shapes", 2, &c)?;
            Ok((b, c))
        })
        .unwrap();
    replica
        .transact(&agent(), |tx| {
            tx.list_remove(&page, "shapes", 0)?;
            tx.list_move(&page, "shapes", 0, 1)
        })
        .unwrap();
    let touches = replica.undo_touches_in(UndoScope::Agent);
    assert!(touches.iter().any(|touch| touch.id == shape.as_str() && touch.fields.as_ref().is_some_and(|fields| fields.is_empty())));
    assert!(touches.iter().any(|touch| touch.id == second.as_str() && touch.fields.as_ref().is_some_and(|fields| fields.is_empty())));
    assert!(!touches.iter().any(|touch| touch.id == third.as_str()));
    replica
        .transact(&agent(), |tx| {
            let owner = tx.create("Page", fields(json!({"title":"New"})))?;
            tx.list_insert(&owner, "shapes", 0, &shape)?;
            tx.list_move(&owner, "shapes", 0, 0)?;
            tx.list_remove(&owner, "shapes", 0)
        })
        .unwrap();
    assert!(replica.undo_touches_in(UndoScope::Agent).iter().any(|touch| touch.id == shape.as_str()));
}

#[test]
fn the_persons_undo_skips_the_agents_steps_and_keeps_their_text() {
    let (mut replica, _, shape) = replica();
    append(&mut replica, &person(), &shape, "Mine.");
    append(&mut replica, &agent(), &shape, " Agent.");
    assert!(replica.can_undo_in(UndoScope::Agent));

    assert!(replica.undo().unwrap().is_done());
    assert_eq!(label(&replica, &shape), " Agent.");
    assert!(replica.redo().unwrap().is_done());
    assert_eq!(label(&replica, &shape), "Mine. Agent.");
}

#[test]
fn the_agents_undo_takes_back_only_its_step_and_keeps_the_persons_later_typing() {
    let (mut replica, _, shape) = replica();
    append(&mut replica, &agent(), &shape, "Agent.");
    append(&mut replica, &person(), &shape, " Mine.");

    assert!(replica.undo_in(UndoScope::Agent).unwrap().is_done());
    assert_eq!(label(&replica, &shape), " Mine.");
    assert!(!replica.can_undo_in(UndoScope::Agent));
    assert!(replica.can_redo_in(UndoScope::Agent));
    assert!(replica.redo_in(UndoScope::Agent).unwrap().is_done());
    assert_eq!(label(&replica, &shape), "Agent. Mine.");
}

#[test]
fn an_undo_keeps_a_register_the_other_scope_wrote_later() {
    let (mut replica, page, _) = replica();
    set_title(&mut replica, &person(), &page, "Mine");
    set_title(&mut replica, &agent(), &page, "Agent");
    assert!(replica.undo().unwrap().is_done());
    assert_eq!(replica.get(&page, "title").unwrap(), json!("Agent"), "the agent wrote the title after the person");

    let (mut replica, page, _) = self::replica();
    set_title(&mut replica, &agent(), &page, "Agent");
    set_title(&mut replica, &person(), &page, "Mine");
    assert!(replica.undo_in(UndoScope::Agent).unwrap().is_done());
    assert_eq!(replica.get(&page, "title").unwrap(), json!("Mine"), "the person wrote the title after the agent");
    // The person's own undo still takes their title back.
    assert!(replica.undo().unwrap().is_done());
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

    assert!(replica.undo_in(UndoScope::Agent).unwrap().is_done());
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
    assert!(replica.undo().unwrap().is_done());
    assert_eq!(label(&replica, &shape), " Repair.");
}

#[test]
fn a_draft_the_agent_made_merges_as_the_persons_step() {
    let (mut replica, _, shape) = replica();
    let mut draft = replica.fork(ActorId::from_u64(9).unwrap()).unwrap();
    append(&mut draft, &agent(), &shape, "Drafted.");
    let since = replica.version();
    let merged = replica.merge_changes(&draft.export_changes(&since).unwrap(), &agent()).unwrap();
    // The answer names the scope the step went to, so a kit with an undo history of its own
    // records it there: the person's, though the origin is the agent's.
    assert_eq!(agent().kind, OriginKind::Agent);
    assert_eq!(merged.scope, Some(UndoScope::Person));
    assert!(merged.objects.contains(&shape));
    assert_eq!(label(&replica, &shape), "Drafted.");
    assert!(!replica.can_undo_in(UndoScope::Agent));
    assert!(replica.undo().unwrap().is_done());
    assert_eq!(label(&replica, &shape), "");
    // A merge recorded with a `system` origin is no step: no scope.
    let mut draft = replica.fork(ActorId::from_u64(10).unwrap()).unwrap();
    append(&mut draft, &agent(), &shape, "Again.");
    let since = replica.version();
    let merged = replica.merge_changes(&draft.export_changes(&since).unwrap(), &Origin::system("sync")).unwrap();
    assert_eq!((merged.scope, label(&replica, &shape).as_str()), (None, "Again."));
}

#[test]
fn next_history_step_exposes_fields_without_changing_state_or_history() {
    let (mut replica, page, shape) = replica();
    assert!(replica.undo_touches_in(UndoScope::Agent).is_empty());
    replica.begin_undo_group().unwrap();
    append(&mut replica, &agent(), &shape, "Agent");
    set_title(&mut replica, &agent(), &page, "Title");
    replica.end_undo_group();
    append(&mut replica, &person(), &shape, " Person");
    let before = replica.version();
    let touches = replica.undo_touches_in(UndoScope::Agent);
    assert_eq!(touches.len(), 2);
    assert!(touches.iter().any(|touch| touch.id == shape.as_str() && touch.fields.as_ref().unwrap().contains("label")));
    assert!(touches.iter().any(|touch| touch.id == page.as_str() && touch.fields.as_ref().unwrap().contains("title")));
    assert_eq!(replica.version(), before);
    assert_eq!(replica.undo_touches_in(UndoScope::Agent), touches);
    assert!(replica.undo_in(UndoScope::Agent).unwrap().is_done());
    assert!(replica.undo_touches_in(UndoScope::Agent).is_empty());
    assert_eq!(replica.redo_touches_in(UndoScope::Agent), touches);
    assert!(replica.redo_in(UndoScope::Agent).unwrap().is_done());
    assert_eq!(replica.undo_touches_in(UndoScope::Agent), touches);
}

/// A kit that keeps an undo label of its own per step keeps as many as `undo_depth` answers: an
/// undo group (a `model/batch`) is one step however many transactions joined it.
#[test]
fn undo_depth_counts_steps_and_a_group_is_one() {
    let (mut replica, page, shape) = replica();
    let start = replica.undo_depth(UndoScope::Person);
    assert!(!replica.in_undo_group());
    replica.begin_undo_group().unwrap();
    assert!(replica.in_undo_group());
    append(&mut replica, &person(), &shape, "a");
    set_title(&mut replica, &person(), &page, "T");
    assert_eq!(replica.undo_depth(UndoScope::Person), start + 1);
    replica.end_undo_group();
    assert!(!replica.in_undo_group());
    append(&mut replica, &agent(), &shape, "b");
    assert_eq!((replica.undo_depth(UndoScope::Person), replica.undo_depth(UndoScope::Agent)), (start + 1, 1));
    assert!(replica.undo().unwrap().is_done());
    assert_eq!((replica.undo_depth(UndoScope::Person), replica.redo_depth(UndoScope::Person)), (start, 1));
}
