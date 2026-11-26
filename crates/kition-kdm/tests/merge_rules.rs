// Copied from kition-sdk crates/kition-kdm/tests/merge_rules.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! A draft merged into a document that changed since the draft was made (data model 6.6, rules
//! D1 to D9): per field kind, the case that merges and the case that collides; seeded property
//! tests of disjoint edits on maps, lists and trees; and the two shapes kits hit (one shared map
//! written under different keys, as pdf's overlay; one shared list appended to by both, as cad's
//! model space).

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::{fields, person, schema};
use kition_kdm::diff::diff_states;
use kition_kdm::{ActorId, DocId, KdmError, MergeAt, NodeRef, ObjectId, Origin, Replica, TreeEntry};
use serde_json::{Value, json};

fn actor(n: u64) -> ActorId {
    ActorId::from_u64(n).expect("actor")
}

fn agent() -> Origin {
    Origin::agent("user:test")
}

fn live() -> Replica {
    Replica::create(schema(), DocId::new(), actor(1)).expect("create")
}

fn shape(tx: &mut kition_kdm::Tx<'_>, x: i64) -> kition_kdm::Result<ObjectId> {
    tx.create("Shape", fields(json!({ "kind": "rect", "x": x, "y": 0 })))
}

/// A page with `count` shapes in its `shapes` list and as roots of its outline, and a sheet with
/// cells `k0` to `k<count-1>`.
fn document(count: usize) -> (Replica, ObjectId, Vec<ObjectId>, ObjectId) {
    let mut live = live();
    let (page, shapes, sheet) = live
        .transact(&person(), |tx| {
            let page = tx.create("Page", fields(json!({ "title": "One" })))?;
            let sheet = tx.create("Sheet", fields(json!({})))?;
            let mut shapes = Vec::new();
            for at in 0..count {
                let made = shape(tx, i64::try_from(at).unwrap_or_default())?;
                tx.list_insert(&page, "shapes", at, &made)?;
                tx.tree_create(&page, "outline", None, &made)?;
                tx.map_set(&sheet, "cells", &format!("k{at}"), json!(at))?;
                shapes.push(made);
            }
            Ok((page, shapes, sheet))
        })
        .expect("document");
    (live, page, shapes, sheet)
}

/// Merges `draft`'s changes since `base` into `live`, checking rule D9: the preview equals the
/// merge, `merge_conflicts` is empty, and (when the merge changed something) one undo gives back
/// the state before.
fn merge(live: &mut Replica, draft: &Replica, base: &kition_kdm::Version) -> Value {
    let changes = draft.export_changes(base).expect("export");
    assert_eq!(live.merge_conflicts(&changes).expect("conflicts"), Vec::new());
    let before = live.state_json().expect("state");
    let preview = live.merged_state(&changes).expect("preview");
    assert_eq!(live.state_json().expect("state"), before, "a preview changes nothing");
    // The comparison read at the objects the merge writes is the comparison of the whole states.
    let compared = live.compare_changes(&changes).expect("compare").to_json();
    assert_eq!(compared, diff_states(&before, &preview).to_json(), "compare_changes");
    let since = live.version();
    live.merge_changes(&changes, &agent()).expect("merge");
    let merged = live.state_json().expect("state");
    assert_eq!(merged, preview, "the preview is the merge");
    assert_eq!(live.diff_since(&since).expect("diff since").to_json(), compared, "diff_since");
    if merged == before {
        // The draft's edits changed nothing here (a move to where the item was, a key both set
        // to one value): an undo passes over such a step (data model 6.5) to the person's own.
        return merged;
    }
    assert!(live.undo().expect("undo").is_done());
    assert_eq!(live.state_json().expect("state"), before, "one undo takes the merge back exactly");
    assert!(live.redo().expect("redo").is_done());
    assert_eq!(live.state_json().expect("state"), merged);
    merged
}

/// The refusal of merging `draft`'s changes since `base`: it changes nothing, and names `named`.
fn refused(live: &mut Replica, draft: &Replica, base: &kition_kdm::Version, named: &str) -> Vec<kition_kdm::MergeConflict> {
    let changes = draft.export_changes(base).expect("export");
    let before = (live.version(), live.state_json().expect("state"), live.can_undo(), live.can_redo());
    let error = live.merge_changes(&changes, &agent()).expect_err("refused");
    assert!(matches!(&error, KdmError::Stale(message) if message.contains(named)), "{error:?} names {named}");
    assert!(live.merged_state(&changes).is_err(), "the preview refuses it too");
    assert_eq!((live.version(), live.state_json().expect("state"), live.can_undo(), live.can_redo()), before, "a refused merge changes nothing");
    let conflicts = live.merge_conflicts(&changes).expect("conflicts");
    assert!(!conflicts.is_empty());
    conflicts
}

fn tree(replica: &Replica, page: &ObjectId) -> Vec<TreeEntry> {
    replica.tree(page, "outline").expect("tree")
}

fn node(replica: &Replica, page: &ObjectId, object: &ObjectId) -> NodeRef {
    tree(replica, page).into_iter().find(|entry| &entry.object == object).map(|entry| entry.node).expect("a node")
}

/// Each node's parent.
type Parents = BTreeMap<ObjectId, Option<ObjectId>>;
/// Each parent's children, in order.
type Children = BTreeMap<Option<ObjectId>, Vec<ObjectId>>;
/// Items a side took (moved or removed), removed, and made.
type ListEdits = (BTreeSet<ObjectId>, BTreeSet<ObjectId>, BTreeSet<ObjectId>);

/// The outline as each node's parent and the children of each parent in order.
fn shape_of(replica: &Replica, page: &ObjectId) -> (Parents, Children) {
    let mut parents = BTreeMap::new();
    let mut children: Children = BTreeMap::new();
    for entry in tree(replica, page) {
        let parent = entry.parent.map(|parent| parent.object().clone());
        children.entry(parent.clone()).or_default().push(entry.object.clone());
        parents.insert(entry.object, parent);
    }
    (parents, children)
}

// ---- D2, D3: registers ----

#[test]
fn d3_a_register_both_set_to_different_values_collides_and_one_value_or_one_side_merges() {
    let (mut live, page, shapes, _) = document(2);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    draft.transact(&agent(), |tx| tx.set(&page, "title", json!("Drafted"))).expect("draft");
    draft.transact(&agent(), |tx| tx.set(&shapes[0], "x", json!(5))).expect("draft");
    draft.transact(&agent(), |tx| tx.set(&shapes[1], "x", json!(7))).expect("draft");
    draft.transact(&agent(), |tx| tx.set(&shapes[1], "x", json!(1))).expect("draft: back to the value at the fork");
    // The document: the same value for shape 0's x, another for shape 1's x (the draft's net
    // change there is none), and the title set and undone.
    live.transact(&person(), |tx| tx.set(&shapes[0], "x", json!(5))).expect("live");
    live.transact(&person(), |tx| tx.set(&shapes[1], "x", json!(30))).expect("live");
    live.transact(&person(), |tx| tx.set(&page, "title", json!("Mine"))).expect("live");
    assert!(live.undo().expect("undo").is_done());
    merge(&mut live, &draft, &base);
    assert_eq!(live.get(&page, "title").expect("title"), json!("Drafted"), "D2: a title changed and undone is unchanged");
    assert_eq!(live.get(&shapes[0], "x").expect("x"), json!(5), "D3: both wrote the same value");
    assert_eq!(live.get(&shapes[1], "x").expect("x"), json!(30), "D3: the draft set it back; the document's value stays");

    let base = live.version();
    let mut draft = live.fork(actor(10)).expect("fork");
    draft.transact(&agent(), |tx| tx.set(&page, "title", json!("Theirs"))).expect("draft");
    live.transact(&person(), |tx| tx.set(&page, "title", json!("Mine"))).expect("live");
    let conflicts = refused(&mut live, &draft, &base, &format!("{page}.title"));
    assert_eq!(conflicts[0].rule, "D3");
    assert_eq!(conflicts[0].object, page);
    assert_eq!(conflicts[0].field.as_deref(), Some("title"));
}

// ---- D4: maps ----

/// pdf's shape: every edit writes one map (`Pdf.overlay`); a draft and the document writing
/// different keys merge.
#[test]
fn d4_one_shared_map_written_under_different_keys_merges() {
    let (mut live, _, _, sheet) = document(2);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    draft.transact(&agent(), |tx| tx.map_set(&sheet, "cells", "annotation-agent", json!({ "page": 1, "text": "Agent" }))).expect("draft");
    draft.transact(&agent(), |tx| tx.map_delete(&sheet, "cells", "k1")).expect("draft");
    live.transact(&person(), |tx| tx.map_set(&sheet, "cells", "annotation-person", json!({ "page": 2, "text": "Person" }))).expect("live");
    live.transact(&person(), |tx| tx.map_set(&sheet, "cells", "k0", json!("edited"))).expect("live");
    merge(&mut live, &draft, &base);
    let cells: BTreeMap<String, Value> = live.map_entries(&sheet, "cells").expect("cells").into_iter().collect();
    assert_eq!(
        cells,
        BTreeMap::from([
            ("annotation-agent".to_owned(), json!({ "page": 1, "text": "Agent" })),
            ("annotation-person".to_owned(), json!({ "page": 2, "text": "Person" })),
            ("k0".to_owned(), json!("edited")),
        ])
    );
}

#[test]
fn d4_one_key_both_set_to_different_values_collides_and_names_the_key() {
    let (mut live, _, _, sheet) = document(2);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    draft.transact(&agent(), |tx| tx.map_set(&sheet, "cells", "k0", json!("theirs"))).expect("draft");
    draft.transact(&agent(), |tx| tx.map_set(&sheet, "cells", "k1", json!("same"))).expect("draft");
    live.transact(&person(), |tx| tx.map_set(&sheet, "cells", "k0", json!("mine"))).expect("live");
    live.transact(&person(), |tx| tx.map_set(&sheet, "cells", "k1", json!("same"))).expect("live");
    let conflicts = refused(&mut live, &draft, &base, &format!("{sheet}.cells[\"k0\"]"));
    assert_eq!(conflicts.len(), 1, "the key both set to one value merges: {conflicts:?}");
    assert_eq!(conflicts[0].rule, "D4");
    assert_eq!(conflicts[0].at, Some(MergeAt::Key("k0".into())));
}

// ---- D5: texts ----

#[test]
fn d5_a_text_both_changed_collides_and_one_changed_and_undone_merges() {
    let (mut live, _, shapes, _) = document(1);
    let label = &shapes[0];
    live.transact(&person(), |tx| tx.text_insert(label, "label", 0, "ab")).expect("label");
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    draft.transact(&agent(), |tx| tx.text_insert(label, "label", 1, "Z")).expect("draft");
    live.transact(&person(), |tx| tx.text_insert(label, "label", 0, "12")).expect("live");
    assert!(live.undo().expect("undo").is_done());
    merge(&mut live, &draft, &base);
    assert_eq!(live.text(label, "label").expect("text"), "aZb");

    let base = live.version();
    let mut draft = live.fork(actor(10)).expect("fork");
    draft.transact(&agent(), |tx| tx.text_insert(label, "label", 0, "Q")).expect("draft");
    live.transact(&person(), |tx| tx.text_insert(label, "label", 3, "!")).expect("live");
    let conflicts = refused(&mut live, &draft, &base, &format!("{label}.label"));
    assert_eq!(conflicts[0].rule, "D5");
}

// ---- D6: lists ----

/// cad's shape: all model-space entities are one list; a draft that appends a line while the
/// person appended one merges, the person's first.
#[test]
fn d6_one_shared_list_appended_to_by_both_merges_with_the_documents_item_first() {
    let (mut live, page, shapes, _) = document(2);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    let drafted = draft
        .transact(&agent(), |tx| {
            let line = shape(tx, 100)?;
            tx.list_insert(&page, "shapes", 2, &line)?;
            Ok(line)
        })
        .expect("draft");
    let mine = live
        .transact(&person(), |tx| {
            let line = shape(tx, 200)?;
            tx.list_insert(&page, "shapes", 2, &line)?;
            Ok(line)
        })
        .expect("live");
    merge(&mut live, &draft, &base);
    assert_eq!(live.list(&page, "shapes").expect("list"), vec![shapes[0].clone(), shapes[1].clone(), mine, drafted]);
}

#[test]
fn d6_moves_and_removals_of_different_items_merge_among_the_same_neighbours() {
    let (mut live, page, s, _) = document(5);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    // The draft moves s1 to the end and puts a new item between s2 and s3.
    draft.transact(&agent(), |tx| tx.list_move(&page, "shapes", 1, 4)).expect("draft");
    let drafted = draft
        .transact(&agent(), |tx| {
            let made = shape(tx, 9)?;
            tx.list_insert(&page, "shapes", 2, &made)?;
            Ok(made)
        })
        .expect("draft");
    assert_eq!(draft.list(&page, "shapes").expect("list"), vec![s[0].clone(), s[2].clone(), drafted.clone(), s[3].clone(), s[4].clone(), s[1].clone()]);
    // The document removes s0 and moves s4 to the front.
    live.transact(&person(), |tx| tx.list_remove(&page, "shapes", 0)).expect("live");
    live.transact(&person(), |tx| tx.list_move(&page, "shapes", 3, 0)).expect("live");
    merge(&mut live, &draft, &base);
    assert_eq!(live.list(&page, "shapes").expect("list"), vec![s[4].clone(), s[2].clone(), drafted, s[3].clone(), s[1].clone()]);
}

#[test]
fn d6_an_item_both_moved_or_removed_collides_and_names_the_item() {
    let (mut live, page, s, _) = document(3);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    draft.transact(&agent(), |tx| tx.list_move(&page, "shapes", 1, 2)).expect("draft");
    live.transact(&person(), |tx| tx.list_remove(&page, "shapes", 1)).expect("live");
    let conflicts = refused(&mut live, &draft, &base, &format!("{page}.shapes item {}", s[1]));
    assert_eq!(conflicts[0].rule, "D6");
    assert_eq!(conflicts[0].at, Some(MergeAt::Item(s[1].clone())));
}

// ---- D7: trees ----

#[test]
fn d7_nodes_made_under_one_parent_merge_with_the_documents_first() {
    let (mut live, page, s, _) = document(2);
    let parent = node(&live, &page, &s[0]);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    let drafted = draft
        .transact(&agent(), |tx| {
            let made = shape(tx, 1)?;
            tx.tree_create(&page, "outline", Some(&parent), &made)?;
            Ok(made)
        })
        .expect("draft");
    let mine = live
        .transact(&person(), |tx| {
            let made = shape(tx, 2)?;
            tx.tree_create(&page, "outline", Some(&parent), &made)?;
            Ok(made)
        })
        .expect("live");
    // And the document moves s1 under s0 first of all: a move of another node.
    let moved = node(&live, &page, &s[1]);
    live.transact(&person(), |tx| tx.tree_move(&page, "outline", &moved, Some(&parent))).expect("live");
    merge(&mut live, &draft, &base);
    let (_, children) = shape_of(&live, &page);
    assert_eq!(children.get(&Some(s[0].clone())).cloned().unwrap_or_default(), vec![mine, s[1].clone(), drafted]);
}

#[test]
fn d7_a_draft_deleting_one_node_merges_with_a_document_that_moved_another() {
    let (mut live, page, s, _) = document(3);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    draft.transact(&agent(), |tx| tx.delete(&s[1])).expect("draft");
    let first = node(&live, &page, &s[0]);
    live.transact(&person(), |tx| tx.tree_move(&page, "outline", &first, None)).expect("live");
    merge(&mut live, &draft, &base);
    let roots: Vec<ObjectId> = tree(&live, &page).into_iter().map(|entry| entry.object).collect();
    assert_eq!(roots, vec![s[2].clone(), s[0].clone()]);
}

#[test]
fn d7_a_node_both_moved_a_parent_the_document_took_out_and_a_cycle_collide() {
    // Both move one node.
    let (mut live, page, s, _) = document(3);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    let (a, b) = (node(&live, &page, &s[0]), node(&live, &page, &s[1]));
    draft.transact(&agent(), |tx| tx.tree_move(&page, "outline", &a, Some(&b))).expect("draft");
    let c = node(&live, &page, &s[2]);
    live.transact(&person(), |tx| tx.tree_move(&page, "outline", &a, Some(&c))).expect("live");
    let conflicts = refused(&mut live, &draft, &base, &format!("{page}.outline item {}", s[0]));
    assert_eq!(conflicts[0].rule, "D7");

    // The draft puts a node under a node the document deleted.
    let (mut live, page, s, _) = document(2);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    let parent = node(&draft, &page, &s[0]);
    draft
        .transact(&agent(), |tx| {
            let made = shape(tx, 1)?;
            tx.tree_create(&page, "outline", Some(&parent), &made).map(drop)
        })
        .expect("draft");
    let gone = node(&live, &page, &s[0]);
    live.transact(&person(), |tx| tx.tree_delete(&page, "outline", &gone)).expect("live");
    let conflicts = refused(&mut live, &draft, &base, &format!("{page}.outline item {}", s[0]));
    assert!(conflicts.iter().all(|conflict| conflict.rule == "D7"), "{conflicts:?}");

    // The document moves s0 under s1; the draft moves s1 under s0: a cycle.
    let (mut live, page, s, _) = document(2);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    let (a, b) = (node(&live, &page, &s[0]), node(&live, &page, &s[1]));
    draft.transact(&agent(), |tx| tx.tree_move(&page, "outline", &b, Some(&a))).expect("draft");
    live.transact(&person(), |tx| tx.tree_move(&page, "outline", &a, Some(&b))).expect("live");
    let conflicts = refused(&mut live, &draft, &base, &format!("{page}.outline item {}", s[1]));
    assert_eq!(conflicts[0].rule, "D7");
}

// ---- D8: objects ----

#[test]
fn d8_an_object_one_side_deleted_and_the_other_changed_collides() {
    let (mut live, page, s, _) = document(2);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    draft
        .transact(&agent(), |tx| {
            tx.list_remove(&page, "shapes", 0)?;
            tx.delete(&s[0])
        })
        .expect("draft");
    live.transact(&person(), |tx| tx.set(&s[0], "x", json!(44))).expect("live");
    let conflicts = refused(&mut live, &draft, &base, &format!("{} (the draft deleted it", s[0]));
    assert_eq!(conflicts[0].rule, "D8");

    // Deleting an object the other side did not change merges.
    let base = live.version();
    let mut draft = live.fork(actor(10)).expect("fork");
    draft
        .transact(&agent(), |tx| {
            tx.list_remove(&page, "shapes", 1)?;
            tx.delete(&s[1])
        })
        .expect("draft");
    live.transact(&person(), |tx| tx.set(&s[0], "y", json!(3))).expect("live");
    merge(&mut live, &draft, &base);
    assert!(!live.exists(&s[1]));
    assert_eq!(live.list(&page, "shapes").expect("list"), vec![s[0].clone()]);
}

/// The same change on both sides is no collision (D4, D6, D7, D8): both deleted one object (its
/// list entry and its outline node with it), both removed one list item, both took one node out of
/// the outline, both deleted one map key; the draft's other edits around them land where it meant.
#[test]
fn d6_d7_d8_the_same_removal_on_both_sides_merges() {
    let (mut live, page, s, sheet) = document(4);
    let base = live.version();
    let mut draft = live.fork(actor(9)).expect("fork");
    let remove_and_delete = |tx: &mut kition_kdm::Tx<'_>, index: usize, object: &ObjectId| -> kition_kdm::Result<()> {
        tx.list_remove(&page, "shapes", index)?;
        tx.delete(object)
    };
    // The draft writes to s0 and then deletes it; it also inserts a new item where s0 was.
    draft.transact(&agent(), |tx| tx.set(&s[0], "x", json!(77))).expect("draft");
    draft.transact(&agent(), |tx| remove_and_delete(tx, 0, &s[0])).expect("draft");
    let drafted = draft
        .transact(&agent(), |tx| {
            let made = shape(tx, 5)?;
            tx.list_insert(&page, "shapes", 0, &made)?;
            Ok(made)
        })
        .expect("draft");
    // Both remove s1 from the list, and both take s2 out of the outline.
    draft.transact(&agent(), |tx| tx.list_remove(&page, "shapes", 1)).expect("draft");
    let s2 = node(&draft, &page, &s[2]);
    draft.transact(&agent(), |tx| tx.tree_delete(&page, "outline", &s2)).expect("draft");
    draft.transact(&agent(), |tx| tx.map_delete(&sheet, "cells", "k3")).expect("draft");

    live.transact(&person(), |tx| remove_and_delete(tx, 0, &s[0])).expect("live");
    live.transact(&person(), |tx| tx.list_remove(&page, "shapes", 0)).expect("live");
    let s2 = node(&live, &page, &s[2]);
    live.transact(&person(), |tx| tx.tree_delete(&page, "outline", &s2)).expect("live");
    live.transact(&person(), |tx| tx.map_delete(&sheet, "cells", "k3")).expect("live");

    merge(&mut live, &draft, &base);
    assert!(!live.exists(&s[0]));
    assert_eq!(live.list(&page, "shapes").expect("list"), vec![drafted, s[2].clone(), s[3].clone()]);
    let outline: Vec<ObjectId> = tree(&live, &page).into_iter().map(|entry| entry.object).collect();
    assert_eq!(outline, vec![s[1].clone(), s[3].clone()]);
    assert_eq!(live.map_get(&sheet, "cells", "k3").expect("k3"), Value::Null);

    // Still a collision: the draft moves an item the document removed (D6).
    let base = live.version();
    let mut draft = live.fork(actor(10)).expect("fork");
    draft.transact(&agent(), |tx| tx.list_move(&page, "shapes", 1, 0)).expect("draft");
    live.transact(&person(), |tx| tx.list_remove(&page, "shapes", 1)).expect("live");
    refused(&mut live, &draft, &base, "D6");
}

// ---- Seeded property tests ----

/// A small seeded generator (xorshift64*), so every run tests the same cases.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        let next = self.0.wrapping_mul(0x2545_F491_4F6C_DD1D);
        usize::try_from(next >> 33).unwrap_or_default() % n.max(1)
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() { None } else { items.get(self.below(items.len())) }
    }
}

/// One side's random edits of the `shapes` list: inserts of new items, and moves and removals of
/// the items it owns. Answers the items it took (moved or removed), removed, and made.
fn list_edits(replica: &mut Replica, origin: &Origin, page: &ObjectId, owned: &[ObjectId], rng: &mut Rng) -> ListEdits {
    let (mut taken, mut removed, mut made) = (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
    let mut owned: Vec<ObjectId> = owned.to_vec();
    for _ in 0..1 + rng.below(5) {
        let items = replica.list(page, "shapes").expect("list");
        match rng.below(3) {
            0 => {
                let at = rng.below(items.len() + 1);
                let new = replica
                    .transact(origin, |tx| {
                        let new = shape(tx, 0)?;
                        tx.list_insert(page, "shapes", at, &new)?;
                        Ok(new)
                    })
                    .expect("insert");
                owned.push(new.clone());
                made.insert(new);
            }
            kind => {
                let Some(item) = rng.pick(&owned).cloned() else { continue };
                let Some(from) = items.iter().position(|held| *held == item) else { continue };
                if kind == 1 {
                    replica
                        .transact(origin, |tx| {
                            tx.list_remove(page, "shapes", from)?;
                            tx.delete(&item)
                        })
                        .expect("remove");
                    owned.retain(|held| *held != item);
                    if !made.contains(&item) {
                        removed.insert(item.clone());
                    }
                } else {
                    let to = rng.below(items.len());
                    replica.transact(origin, |tx| tx.list_move(page, "shapes", from, to)).expect("move");
                }
                if !made.contains(&item) {
                    taken.insert(item);
                }
            }
        }
    }
    made.retain(|item| owned.contains(item));
    (taken, removed, made)
}

/// `items` without those in `out`.
fn without(items: &[ObjectId], out: &BTreeSet<ObjectId>) -> Vec<ObjectId> {
    items.iter().filter(|item| !out.contains(*item)).cloned().collect()
}

/// Random disjoint edits of one list by the document and a draft merge to what the document
/// holds with the draft's intent: the items both keep and each side's new ones, each once, every
/// item a live object; the order of each side's items as that side left it (leaving out those
/// the other side moved or removed); and one undo gives back the state before.
#[test]
fn property_disjoint_list_edits_merge_keeping_each_sides_order() {
    for seed in 0..300 {
        let mut rng = Rng::new(seed);
        let (mut live, page, s, _) = document(8);
        let (mine, theirs): (Vec<ObjectId>, Vec<ObjectId>) = (s.iter().step_by(2).cloned().collect(), s.iter().skip(1).step_by(2).cloned().collect());
        let base = live.version();
        let mut draft = live.fork(actor(9)).expect("fork");
        let (draft_taken, draft_removed, draft_made) = list_edits(&mut draft, &agent(), &page, &theirs, &mut rng);
        let (doc_taken, _, _) = list_edits(&mut live, &person(), &page, &mine, &mut rng);
        let (doc_final, draft_final) = (live.list(&page, "shapes").expect("list"), draft.list(&page, "shapes").expect("list"));
        merge(&mut live, &draft, &base);
        let merged = live.list(&page, "shapes").expect("list");
        let held: BTreeSet<ObjectId> = merged.iter().cloned().collect();
        assert_eq!(held.len(), merged.len(), "seed {seed}: no item twice: {merged:?}");
        let mut expected: BTreeSet<ObjectId> = doc_final.iter().filter(|item| !draft_removed.contains(*item)).cloned().collect();
        expected.extend(draft_made.iter().cloned());
        assert_eq!(held, expected, "seed {seed}: the items");
        assert!(merged.iter().all(|item| live.exists(item)), "seed {seed}: every item names an object");
        assert_eq!(without(&merged, &without_set(&merged, &doc_final, &draft_taken)), without(&doc_final, &draft_taken), "seed {seed}: the document's order");
        assert_eq!(without(&merged, &without_set(&merged, &draft_final, &doc_taken)), without(&draft_final, &doc_taken), "seed {seed}: the draft's order");
    }
}

/// The items of `merged` that are not among `side`'s, or that `taken` holds: what a side's order
/// check leaves out.
fn without_set(merged: &[ObjectId], side: &[ObjectId], taken: &BTreeSet<ObjectId>) -> BTreeSet<ObjectId> {
    let side: BTreeSet<&ObjectId> = side.iter().collect();
    merged.iter().filter(|item| !side.contains(item) || taken.contains(*item)).cloned().collect()
}

/// One side's random edits of the outline: new nodes under the shared roots or its own nodes,
/// moves of its own nodes under those, and deletions of its own leaves. Answers the nodes it
/// moved or deleted and those it made.
fn tree_edits(
    replica: &mut Replica,
    origin: &Origin,
    page: &ObjectId,
    shared: &[ObjectId],
    owned: &[ObjectId],
    rng: &mut Rng,
) -> (BTreeSet<ObjectId>, BTreeSet<ObjectId>) {
    let (mut taken, mut made) = (BTreeSet::new(), BTreeSet::new());
    let mut owned: Vec<ObjectId> = owned.to_vec();
    for _ in 0..1 + rng.below(5) {
        let mut parents: Vec<ObjectId> = shared.to_vec();
        parents.extend(owned.iter().cloned());
        let Some(parent) = rng.pick(&parents).cloned() else { continue };
        let parent_node = node(replica, page, &parent);
        match rng.below(3) {
            0 => {
                let new = replica
                    .transact(origin, |tx| {
                        let new = shape(tx, 0)?;
                        tx.tree_create(page, "outline", Some(&parent_node), &new)?;
                        Ok(new)
                    })
                    .expect("create");
                owned.push(new.clone());
                made.insert(new);
            }
            1 => {
                let Some(moved) = rng.pick(&owned).cloned() else { continue };
                let moved_node = node(replica, page, &moved);
                // A move under its own subtree is refused as a cycle and changes nothing.
                if replica.transact(origin, |tx| tx.tree_move(page, "outline", &moved_node, Some(&parent_node))).is_ok() && !made.contains(&moved) {
                    taken.insert(moved);
                }
            }
            _ => {
                let (_, children) = shape_of(replica, page);
                let leaves: Vec<ObjectId> = owned.iter().filter(|held| !children.contains_key(&Some((*held).clone()))).cloned().collect();
                let Some(leaf) = rng.pick(&leaves).cloned() else { continue };
                replica.transact(origin, |tx| tx.delete(&leaf)).expect("delete");
                owned.retain(|held| *held != leaf);
                if !made.remove(&leaf) {
                    taken.insert(leaf);
                }
            }
        }
    }
    (taken, made)
}

/// Random disjoint edits of one tree merge to what the document holds with the draft's intent:
/// each node once, every node a live object, each node under the parent the side that last placed
/// it chose, and each side's sibling order kept (leaving out the nodes the other side moved or
/// deleted); one undo gives back the state before.
#[test]
fn property_disjoint_tree_edits_merge_keeping_each_sides_places() {
    for seed in 0..300 {
        let mut rng = Rng::new(seed);
        let mut live = live();
        let (page, shared, mine, theirs) = live
            .transact(&person(), |tx| {
                let page = tx.create("Page", fields(json!({ "title": "T" })))?;
                let (mut shared, mut mine, mut theirs) = (Vec::new(), Vec::new(), Vec::new());
                for _ in 0..3 {
                    let root = shape(tx, 0)?;
                    tx.tree_create(&page, "outline", None, &root)?;
                    shared.push(root);
                }
                for at in 0..6 {
                    let made = shape(tx, 1)?;
                    let parent = tx
                        .tree(&page, "outline")?
                        .into_iter()
                        .find(|entry| Some(&entry.object) == shared.get(at % 3))
                        .map(|entry| entry.node)
                        .ok_or_else(|| KdmError::NotFound("root".into()))?;
                    tx.tree_create(&page, "outline", Some(&parent), &made)?;
                    if at % 2 == 0 { mine.push(made) } else { theirs.push(made) }
                }
                Ok((page, shared, mine, theirs))
            })
            .expect("document");
        let base = live.version();
        let mut draft = live.fork(actor(9)).expect("fork");
        let (draft_taken, draft_made) = tree_edits(&mut draft, &agent(), &page, &shared, &theirs, &mut rng);
        let (doc_taken, _) = tree_edits(&mut live, &person(), &page, &shared, &mine, &mut rng);
        let ((doc_parents, doc_children), (draft_parents, draft_children)) = (shape_of(&live, &page), shape_of(&draft, &page));
        merge(&mut live, &draft, &base);
        let entries = tree(&live, &page);
        let (parents, children) = shape_of(&live, &page);
        assert_eq!(parents.len(), entries.len(), "seed {seed}: no node twice");
        let draft_moved: BTreeSet<ObjectId> = draft_taken.iter().filter(|held| draft_parents.contains_key(*held)).cloned().collect();
        let draft_deleted: BTreeSet<ObjectId> = draft_taken.iter().filter(|held| !draft_parents.contains_key(*held)).cloned().collect();
        let mut expected: BTreeSet<ObjectId> = doc_parents.keys().filter(|held| !draft_deleted.contains(*held)).cloned().collect();
        expected.extend(draft_made.iter().cloned());
        assert_eq!(parents.keys().cloned().collect::<BTreeSet<_>>(), expected, "seed {seed}: the nodes");
        for (held, parent) in &parents {
            assert!(live.exists(held), "seed {seed}: every node names an object");
            let chosen = if draft_moved.contains(held) || draft_made.contains(held) { draft_parents.get(held) } else { doc_parents.get(held) };
            assert_eq!(Some(parent), chosen, "seed {seed}: the parent of {held}");
        }
        for (side, taken) in [(&doc_children, &draft_taken), (&draft_children, &doc_taken)] {
            for (parent, kids) in side {
                let kept = without(kids, taken);
                let merged_kids = children.get(parent).cloned().unwrap_or_default();
                let kept_set: BTreeSet<&ObjectId> = kept.iter().collect();
                let ordered: Vec<ObjectId> = merged_kids.into_iter().filter(|kid| kept_set.contains(kid)).collect();
                assert_eq!(ordered, kept, "seed {seed}: the order under {parent:?}");
            }
        }
    }
}

/// Random edits of one map by both sides on disjoint keys, plus a key both set to one value (or
/// the draft wrote and took back) and keys the document changed and changed back, merge to the
/// document's map with the draft's changed keys written over it, never refused; one undo gives
/// back the state before.
#[test]
fn property_disjoint_map_edits_merge_key_by_key() {
    for seed in 0..200 {
        let mut rng = Rng::new(seed);
        let (mut live, _, _, sheet) = document(10);
        let base = live.version();
        let mut draft = live.fork(actor(9)).expect("fork");
        let mut draft_keys = BTreeSet::new();
        for round in 0..1 + rng.below(6) {
            let key = match rng.below(3) {
                0 => format!("t{round}"),
                1 => "same".to_owned(),
                _ => format!("k{}", 1 + 2 * rng.below(5)),
            };
            if rng.below(4) == 0 {
                draft.transact(&agent(), |tx| tx.map_delete(&sheet, "cells", &key)).expect("draft");
            } else {
                let value = if key == "same" { json!("one") } else { json!(rng.below(100)) };
                draft.transact(&agent(), |tx| tx.map_set(&sheet, "cells", &key, value)).expect("draft");
            }
            draft_keys.insert(key);
        }
        for round in 0..1 + rng.below(6) {
            match rng.below(4) {
                0 => {
                    live.transact(&person(), |tx| tx.map_set(&sheet, "cells", "same", json!("one"))).expect("live");
                }
                1 => {
                    // An odd (the draft's) key changed and changed back.
                    let key = format!("k{}", 1 + 2 * rng.below(5));
                    let was = live.map_get(&sheet, "cells", &key).expect("get");
                    live.transact(&person(), |tx| tx.map_set(&sheet, "cells", &key, json!("passing"))).expect("live");
                    live.transact(&person(), |tx| tx.map_set(&sheet, "cells", &key, was)).expect("live");
                }
                2 => {
                    let key = format!("k{}", 2 * rng.below(5));
                    live.transact(&person(), |tx| tx.map_delete(&sheet, "cells", &key)).expect("live");
                }
                _ => {
                    let key = if rng.below(2) == 0 { format!("d{round}") } else { format!("k{}", 2 * rng.below(5)) };
                    live.transact(&person(), |tx| tx.map_set(&sheet, "cells", &key, json!(round))).expect("live");
                }
            }
        }
        // Each key the draft wrote holds its value, unless the draft left it as it was at the fork
        // (D2: written and written back, or deleted where it was absent): then the document's.
        let at_fork: BTreeMap<String, Value> = (0..10).map(|at| (format!("k{at}"), json!(at))).collect();
        let draft_cells: BTreeMap<String, Value> = draft.map_entries(&sheet, "cells").expect("cells").into_iter().collect();
        let mut expected: BTreeMap<String, Value> = live.map_entries(&sheet, "cells").expect("cells").into_iter().collect();
        for key in &draft_keys {
            match draft_cells.get(key) {
                value if value == at_fork.get(key) => {}
                Some(value) => {
                    expected.insert(key.clone(), value.clone());
                }
                None => {
                    expected.remove(key);
                }
            }
        }
        merge(&mut live, &draft, &base);
        let merged: BTreeMap<String, Value> = live.map_entries(&sheet, "cells").expect("cells").into_iter().collect();
        assert_eq!(merged, expected, "seed {seed}");
    }
}
