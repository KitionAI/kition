// Copied from kition-sdk crates/kition-kdm/tests/draft.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Drafts (standard 2.0 A12 to A15): a fork edited apart from the live replica, compared, and
//! merged back as one undo step, or discarded.

mod common;

use common::{fields, page_with_shape, person, schema};
use kition_kdm::diff::diff_states;
use kition_kdm::{ActorId, DocId, KdmError, Origin, Replica};
use serde_json::json;

fn actor(n: u64) -> ActorId {
    ActorId::from_u64(n).expect("actor")
}

fn agent() -> Origin {
    Origin::agent("user:test").with_label("Merged the agent's draft")
}

fn live() -> Replica {
    Replica::create(schema(), DocId::new(), actor(1)).expect("create")
}

#[test]
fn a_fork_holds_the_document_and_edits_apart() {
    let mut live = live();
    let (page, shape) = page_with_shape(&mut live);
    let mut draft = live.fork(actor(9)).expect("fork");
    assert_eq!(draft.state_json().expect("state"), live.state_json().expect("state"));
    assert_eq!(draft.actor(), actor(9));
    assert!(!draft.can_undo(), "a draft starts with no undo history");
    draft.transact(&Origin::agent("user:test"), |tx| tx.set(&shape, "x", json!(99))).expect("edit");
    draft.transact(&Origin::agent("user:test"), |tx| tx.set(&page, "title", json!("Draft"))).expect("edit");
    assert_eq!(live.get(&shape, "x").expect("x"), json!(10), "the live document is untouched");
    assert_eq!(draft.get(&shape, "x").expect("x"), json!(99));
}

#[test]
fn fork_at_starts_from_an_earlier_version_and_refuses_a_later_one() {
    let mut live = live();
    let (page, _) = page_with_shape(&mut live);
    let base = live.version();
    live.transact(&person(), |tx| tx.set(&page, "title", json!("Later"))).expect("edit");
    let draft = live.fork_at(&base, actor(9)).expect("fork");
    assert_eq!(draft.get(&page, "title").expect("title"), json!("One"));
    let ahead = draft.version();
    let other = live.fork(actor(10)).expect("fork");
    let mut moved = other;
    moved.transact(&person(), |tx| tx.set(&page, "title", json!("Elsewhere"))).expect("edit");
    let error = live.fork_at(&moved.version(), actor(11)).err().expect("refused");
    assert!(matches!(error, KdmError::InvalidValue { .. }), "{error:?}");
    assert!(live.version().includes(&ahead));
}

#[test]
fn a_merge_is_one_undo_step() {
    let mut live = live();
    let (page, shape) = page_with_shape(&mut live);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    let added = draft
        .transact(&Origin::agent("user:test"), |tx| {
            let added = tx.create("Shape", fields(json!({ "kind": "ellipse", "x": 1, "y": 2 })))?;
            tx.list_insert(&page, "shapes", 1, &added)?;
            tx.text_insert(&added, "label", 0, "Hello")?;
            Ok(added)
        })
        .expect("edit");
    draft.transact(&Origin::agent("user:test"), |tx| tx.set(&shape, "x", json!(42))).expect("edit");
    draft.transact(&Origin::agent("user:test"), |tx| tx.set(&page, "title", json!("Drafted"))).expect("edit");
    let changes = draft.export_changes(&base).expect("export");

    let mut follower = live.fork(actor(4)).expect("fork");
    let before = live.state_json().expect("state");
    let preview = live.merged_state(&changes).expect("preview");
    assert_eq!(live.state_json().expect("state"), before, "a preview changes nothing");
    live.take_changed();
    let changed = live.merge_changes(&changes, &agent()).expect("merge");
    assert!(changed.contains(&added) && changed.contains(&shape) && changed.contains(&page), "{changed:?}");
    assert_eq!(live.state_json().expect("state"), preview);
    assert_eq!(live.state_json().expect("state"), draft.state_json().expect("state"));
    assert_eq!(live.list(&page, "shapes").expect("list").len(), 2);
    assert_eq!(live.text(&added, "label").expect("text"), "Hello");

    // Undo takes the whole merge back in one step, and redo brings it back.
    assert!(live.undo().expect("undo"));
    assert_eq!(live.state_json().expect("state"), before);
    assert!(live.redo().expect("redo"));
    assert_eq!(live.state_json().expect("state"), preview);
    assert!(live.undo().expect("undo"));
    // The person's own edit before the draft is the next step.
    assert!(live.undo().expect("undo"));
    assert!(!live.exists(&page));

    // A replica that syncs with this one gets the merge as ordinary changes. (Never the draft's
    // own changes as well: a replica holding both would show the draft's effects twice.)
    assert!(live.redo().expect("redo") && live.redo().expect("redo"));
    follower.import_changes(&live.export_changes(&follower.version()).expect("export")).expect("import");
    assert_eq!(follower.state_json().expect("state"), live.state_json().expect("state"));
}

#[test]
fn discarding_a_draft_leaves_the_live_document_untouched() {
    let mut live = live();
    let (_, shape) = page_with_shape(&mut live);
    let before = (live.version(), live.state_json().expect("state"), live.can_undo());
    {
        let mut draft = live.fork(actor(9)).expect("fork");
        draft.transact(&Origin::agent("user:test"), |tx| tx.delete(&shape)).expect("edit");
        // Discard: the draft is dropped, nothing is exported.
    }
    assert_eq!((live.version(), live.state_json().expect("state"), live.can_undo()), before);
    assert!(live.exists(&shape));
}

#[test]
fn live_edits_made_during_a_draft_survive_its_merge_and_its_undo() {
    let mut live = live();
    let (page, shape) = page_with_shape(&mut live);
    live.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "ab")).expect("edit");
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    draft.transact(&Origin::agent("user:test"), |tx| tx.text_insert(&shape, "label", 2, "Z")).expect("draft text");
    draft.transact(&Origin::agent("user:test"), |tx| tx.set(&shape, "x", json!(42))).expect("draft x");

    // Meanwhile the person types at the start and moves the shape vertically, and a collaborator
    // renames the page.
    live.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "12")).expect("live text");
    live.transact(&person(), |tx| tx.set(&shape, "y", json!(7))).expect("live y");
    let mut collaborator = Replica::load(schema(), &live.snapshot().expect("snapshot"), actor(5)).expect("load");
    collaborator.transact(&person(), |tx| tx.set(&page, "title", json!("Theirs"))).expect("collaborator");
    live.import_changes(&collaborator.export_changes(&live.version()).expect("export")).expect("import");

    let changes = draft.export_changes(&base).expect("export");
    live.merge_changes(&changes, &agent()).expect("merge");
    assert_eq!(live.text(&shape, "label").expect("text"), "12abZ");
    assert_eq!(live.get(&shape, "x").expect("x"), json!(42));
    assert_eq!(live.get(&shape, "y").expect("y"), json!(7));
    assert_eq!(live.get(&page, "title").expect("title"), json!("Theirs"));

    // The merged state is what a CRDT import of the draft gives.
    let mut crdt = Replica::load(schema(), &collaborator.snapshot().expect("snapshot"), actor(7)).expect("load");
    crdt.import_changes(&live.export_changes(&base).expect("export")).expect("import");
    assert_eq!(crdt.state_json().expect("state"), live.state_json().expect("state"));

    // Undoing the merge keeps everyone else's edits, including a later one to the same object.
    live.import_changes(&{
        let mut later = Replica::load(schema(), &live.snapshot().expect("snapshot"), actor(8)).expect("load");
        later.transact(&person(), |tx| tx.set(&shape, "fill", json!("red"))).expect("later");
        later.export_changes(&live.version()).expect("export")
    })
    .expect("import");
    assert!(live.undo().expect("undo"));
    assert_eq!(live.text(&shape, "label").expect("text"), "12ab");
    assert_eq!(live.get(&shape, "x").expect("x"), json!(10));
    assert_eq!(live.get(&shape, "y").expect("y"), json!(7));
    assert_eq!(live.get(&shape, "fill").expect("fill"), json!("red"));
    assert_eq!(live.get(&page, "title").expect("title"), json!("Theirs"));
}

#[test]
fn a_merge_refuses_changes_it_cannot_take_and_changes_nothing() {
    let mut live = live();
    let (page, _) = page_with_shape(&mut live);
    let before = (live.version(), live.state_json().expect("state"));
    let other = Replica::create(schema(), DocId::new(), actor(2)).expect("create");
    let error = live.merge_changes(&other.export_changes(&kition_kdm::Version::empty()).expect("export"), &agent()).expect_err("other document");
    assert!(matches!(error, KdmError::WrongDocument { .. }), "{error:?}");
    // Changes made on top of something this replica lacks.
    let mut ahead = live.fork(actor(9)).expect("fork");
    ahead.transact(&person(), |tx| tx.set(&page, "title", json!("A"))).expect("edit");
    let gap = ahead.version();
    ahead.transact(&person(), |tx| tx.set(&page, "title", json!("B"))).expect("edit");
    let error = live.merge_changes(&ahead.export_changes(&gap).expect("export"), &agent()).expect_err("pending");
    assert!(matches!(error, KdmError::InvalidValue { .. }), "{error:?}");
    assert!(live.merge_changes(b"not a kdm export", &agent()).is_err());
    assert_eq!((live.version(), live.state_json().expect("state")), before);
    // An empty draft merges to nothing, with no undo step.
    let empty = live.fork(actor(10)).expect("fork");
    assert!(live.merge_changes(&empty.export_changes(&live.version()).expect("export"), &agent()).expect("merge").is_empty());
    assert_eq!(live.version(), before.0);
}

#[test]
fn the_comparison_lists_created_changed_and_deleted_objects_and_texts() {
    let mut live = live();
    let (page, shape) = page_with_shape(&mut live);
    let other = live
        .transact(&person(), |tx| {
            let other = tx.create("Shape", fields(json!({ "kind": "rect", "x": 0, "y": 0 })))?;
            tx.list_insert(&page, "shapes", 1, &other)?;
            tx.text_insert(&shape, "label", 0, "Old")?;
            Ok(other)
        })
        .expect("edit");
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    let added = draft
        .transact(&Origin::agent("user:test"), |tx| {
            let added = tx.create("Shape", fields(json!({ "kind": "ellipse", "x": 5, "y": 6 })))?;
            tx.list_insert(&page, "shapes", 0, &added)?;
            tx.text_insert(&added, "label", 0, "New")?;
            tx.text_delete(&shape, "label", 0, 3)?;
            tx.text_insert(&shape, "label", 0, "Renamed")?;
            tx.set(&shape, "x", json!(11))?;
            tx.list_remove(&page, "shapes", 2)?;
            tx.delete(&other)?;
            Ok(added)
        })
        .expect("edit");
    let summary = diff_states(&live.state_json().expect("state"), &live.merged_state(&draft.export_changes(&base).expect("export")).expect("merged"));
    assert_eq!(summary.created.len(), 1);
    assert_eq!(summary.created[0].id, added.to_string());
    assert_eq!(summary.created[0].ty, "Shape");
    assert_eq!(summary.created[0].fields, ["kind", "label", "x", "y"]);
    assert_eq!(summary.deleted.len(), 1);
    assert_eq!(summary.deleted[0].id, other.to_string());
    let changed: Vec<(&str, Vec<&str>)> =
        summary.changed.iter().map(|change| (change.ty.as_str(), change.fields.iter().map(String::as_str).collect())).collect();
    assert!(changed.contains(&("Page", vec!["shapes"])), "{changed:?}");
    assert!(changed.contains(&("Shape", vec!["label", "x"])), "{changed:?}");
    let texts: Vec<(&str, &str, &str)> = summary.texts.iter().map(|text| (text.field.as_str(), text.before.as_str(), text.after.as_str())).collect();
    assert!(texts.contains(&("label", "Old", "Renamed")) && texts.contains(&("label", "", "New")), "{texts:?}");
    assert!(!summary.is_empty());
    assert_eq!(summary.to_json()["created"][0]["type"], "Shape");
    assert!(diff_states(&live.state_json().expect("state"), &live.state_json().expect("state")).is_empty());
}
