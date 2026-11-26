// Copied from kition-sdk crates/kition-kdm/tests/undo_sequences.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Undo and redo over sequences of steps (plan 2026-11-24, plain model, section 1.5): an undo of
//! an older step is carried over neither a later step nor the undo that took that step back, so
//! N steps of one scope followed by N undos give back the state before them exactly, and N redos
//! the state after them, for any mix of text inserts, deletes and marks, list, tree, map and
//! register edits. With another scope's edits interleaved, each undo takes back its own step only.
//!
//! The sequences are random but seeded: each seed is one fixed sequence, the same on every run.

use std::collections::BTreeMap;
use std::sync::Arc;

use kition_kdm::{ActorId, DocId, KdmError, NodeRef, ObjectId, Origin, Replica, Schema, UndoScope};
use serde_json::{Map, Value, json};

const SCHEMA: &str = r#"{
  "kdm": 1,
  "kit": "kit.sequences",
  "schemaVersion": 1,
  "root": "Doc",
  "types": {
    "Doc": {
      "fields": {
        "title": { "kind": "string" },
        "body": { "kind": "text", "marks": { "bold": { "expand": "after" } } },
        "items": { "kind": "list", "of": "Item" },
        "outline": { "kind": "tree", "of": "Item" },
        "vars": { "kind": "map" }
      }
    },
    "Item": {
      "fields": {
        "name": { "kind": "string" }
      }
    }
  }
}"#;

/// A deterministic random sequence (xorshift64).
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// A number in `0..n` (`0` for `n == 0`).
    fn below(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { (self.next() % n as u64) as usize }
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

/// One edit of the document, with its positions and items chosen.
#[derive(Clone, Debug)]
enum Edit {
    Title(String),
    Insert(usize, String),
    Delete(usize, usize),
    Mark(usize, usize, bool),
    ListInsert(usize, ObjectId),
    ListRemove(usize),
    ListMove(usize, usize),
    TreeCreate(ObjectId, Option<ObjectId>),
    TreeMove(ObjectId, Option<ObjectId>),
    TreeDelete(ObjectId),
    MapSet(String, i64),
    MapDelete(String),
}

/// What an edit changes: the text (and its marks), the list, the tree, the map or the register.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Text,
    List,
    Tree,
    Map,
    Register,
}

const ALL: [Kind; 5] = [Kind::Text, Kind::List, Kind::Tree, Kind::Map, Kind::Register];

struct Doc {
    replica: Replica,
    doc: ObjectId,
    items: Vec<ObjectId>,
}

fn person() -> Origin {
    Origin::person("user:test")
}

fn agent() -> Origin {
    Origin::agent("agent:test")
}

fn origin(scope: UndoScope) -> Origin {
    if scope == UndoScope::Agent { agent() } else { person() }
}

fn setup() -> Doc {
    let schema = Arc::new(Schema::parse(SCHEMA).unwrap());
    let mut replica = Replica::create(schema, DocId::new(), ActorId::from_u64(1).unwrap()).unwrap();
    let (doc, items) = replica
        .transact(&Origin::system("fixture"), |tx| {
            let mut title = Map::new();
            title.insert("title".into(), json!("T"));
            let doc = tx.create("Doc", title)?;
            tx.text_insert(&doc, "body", 0, "seed text")?;
            let mut items = Vec::new();
            for n in 0..6 {
                let mut name = Map::new();
                name.insert("name".into(), json!(format!("i{n}")));
                items.push(tx.create("Item", name)?);
            }
            Ok((doc, items))
        })
        .unwrap();
    Doc { replica, doc, items }
}

fn letters(rng: &mut Rng) -> String {
    (0..=rng.below(3)).map(|_| char::from(b'a' + rng.below(26) as u8)).collect()
}

/// A random edit of one of `kinds`, chosen against the document as it is.
fn edit(rng: &mut Rng, doc: &Doc, kinds: &[Kind]) -> Edit {
    let replica = &doc.replica;
    let len = replica.text(&doc.doc, "body").unwrap().chars().count();
    let list = replica.list(&doc.doc, "items").unwrap();
    let tree: Vec<ObjectId> = replica.tree(&doc.doc, "outline").unwrap().into_iter().map(|entry| entry.object).collect();
    let kind = kinds[rng.below(kinds.len())];
    match kind {
        Kind::Text => match rng.below(3) {
            0 if len > 0 => {
                let at = rng.below(len);
                Edit::Delete(at, 1 + rng.below((len - at).min(4)))
            }
            1 if len > 0 => {
                let start = rng.below(len);
                Edit::Mark(start, start + 1 + rng.below((len - start).min(5)), rng.chance(70))
            }
            _ => Edit::Insert(rng.below(len + 1), letters(rng)),
        },
        Kind::List => {
            let outside: Vec<&ObjectId> = doc.items.iter().filter(|item| !list.contains(item)).collect();
            match rng.below(3) {
                0 if !list.is_empty() => Edit::ListRemove(rng.below(list.len())),
                1 if list.len() > 1 => Edit::ListMove(rng.below(list.len()), rng.below(list.len())),
                _ if !outside.is_empty() => Edit::ListInsert(rng.below(list.len() + 1), outside[rng.below(outside.len())].clone()),
                _ => Edit::ListRemove(rng.below(list.len())),
            }
        }
        Kind::Tree => {
            let outside: Vec<&ObjectId> = doc.items.iter().filter(|item| !tree.contains(item)).collect();
            let parent = |rng: &mut Rng| if tree.is_empty() || rng.chance(40) { None } else { Some(tree[rng.below(tree.len())].clone()) };
            match rng.below(3) {
                0 if !tree.is_empty() => Edit::TreeDelete(tree[rng.below(tree.len())].clone()),
                1 if !tree.is_empty() => {
                    let node = tree[rng.below(tree.len())].clone();
                    Edit::TreeMove(node, parent(rng))
                }
                _ if !outside.is_empty() => {
                    let object = outside[rng.below(outside.len())].clone();
                    Edit::TreeCreate(object, parent(rng))
                }
                _ => Edit::TreeDelete(tree[rng.below(tree.len())].clone()),
            }
        }
        Kind::Map => {
            let key = format!("k{}", rng.below(4));
            if rng.chance(30) { Edit::MapDelete(key) } else { Edit::MapSet(key, rng.below(100) as i64) }
        }
        Kind::Register => Edit::Title(letters(rng)),
    }
}

/// Applies `edits` as one transaction of `origin`; answers whether it was taken (a refused edit
/// refuses the whole transaction, and nothing changes).
fn apply(replica: &mut Replica, doc: &ObjectId, origin: &Origin, edits: &[Edit]) -> bool {
    let nodes: BTreeMap<ObjectId, NodeRef> = replica.tree(doc, "outline").unwrap().into_iter().map(|entry| (entry.object, entry.node)).collect();
    let node = |object: &ObjectId| nodes.get(object).cloned().ok_or_else(|| KdmError::NotFound(object.to_string()));
    replica
        .transact(origin, |tx| {
            for edit in edits {
                match edit {
                    Edit::Title(title) => tx.set(doc, "title", json!(title))?,
                    Edit::Insert(at, text) => tx.text_insert(doc, "body", *at, text)?,
                    Edit::Delete(at, count) => tx.text_delete(doc, "body", *at, *count)?,
                    Edit::Mark(start, end, true) => tx.text_mark(doc, "body", *start, *end, "bold", json!(true))?,
                    Edit::Mark(start, end, false) => tx.text_unmark(doc, "body", *start, *end, "bold")?,
                    Edit::ListInsert(at, item) => tx.list_insert(doc, "items", *at, item)?,
                    Edit::ListRemove(at) => tx.list_remove(doc, "items", *at)?,
                    Edit::ListMove(from, to) => tx.list_move(doc, "items", *from, *to)?,
                    Edit::TreeCreate(object, parent) => {
                        let parent = parent.as_ref().map(&node).transpose()?;
                        tx.tree_create(doc, "outline", parent.as_ref(), object)?;
                    }
                    Edit::TreeMove(object, parent) => {
                        let parent = parent.as_ref().map(&node).transpose()?;
                        tx.tree_move(doc, "outline", &node(object)?, parent.as_ref())?;
                    }
                    Edit::TreeDelete(object) => tx.tree_delete(doc, "outline", &node(object)?)?,
                    Edit::MapSet(key, value) => tx.map_set(doc, "vars", key, json!(value))?,
                    Edit::MapDelete(key) => tx.map_delete(doc, "vars", key)?,
                }
            }
            Ok(())
        })
        .is_ok()
}

/// One step: one or two random edits in one transaction.
fn step(rng: &mut Rng, doc: &mut Doc, origin: &Origin, kinds: &[Kind]) -> Vec<Edit> {
    let mut edits = vec![edit(rng, doc, kinds)];
    if rng.chance(25) {
        edits.push(edit(rng, doc, kinds));
    }
    if apply(&mut doc.replica, &doc.doc, origin, &edits) { edits } else { Vec::new() }
}

fn state(replica: &Replica) -> Value {
    replica.state_json().unwrap()
}

/// `states` without the repeats in a row: a step that changes nothing is passed over by the undo
/// of the step below it.
fn distinct(states: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for state in states {
        if out.last() != Some(&state) {
            out.push(state);
        }
    }
    out
}

/// Undoes every step of `scope`; answers the states after each undo.
fn undo_all(replica: &mut Replica, scope: UndoScope) -> Vec<Value> {
    let mut states = Vec::new();
    while replica.undo_in(scope).unwrap().is_done() {
        states.push(state(replica));
    }
    states
}

/// Redoes every undone step of `scope`; answers the states after each redo.
fn redo_all(replica: &mut Replica, scope: UndoScope) -> Vec<Value> {
    let mut states = Vec::new();
    while replica.redo_in(scope).unwrap().is_done() {
        states.push(state(replica));
    }
    states
}

const SEEDS: u64 = 60;

/// N steps of one scope (some of them undo groups of two transactions), then N undos: each undo
/// gives back the state before its step exactly, the last one the state before all of them; then
/// N redos give back each state after a step, the last one the state after all of them.
#[test]
fn undos_of_one_scope_give_back_each_earlier_state_exactly_and_redos_each_later_one() {
    for seed in 0..SEEDS {
        let mut rng = Rng::new(seed);
        let mut doc = setup();
        let scope = if seed % 2 == 0 { UndoScope::Person } else { UndoScope::Agent };
        let origin = origin(scope);
        let mut states = vec![state(&doc.replica)];
        for _ in 0..30 {
            if rng.chance(15) {
                doc.replica.begin_undo_group().unwrap();
                step(&mut rng, &mut doc, &origin, &ALL);
                step(&mut rng, &mut doc, &origin, &ALL);
                doc.replica.end_undo_group();
            } else {
                step(&mut rng, &mut doc, &origin, &ALL);
            }
            states.push(state(&doc.replica));
        }
        let states = distinct(states);
        let back: Vec<Value> = states.iter().rev().skip(1).cloned().collect();
        assert_eq!(undo_all(&mut doc.replica, scope), back, "seed {seed}: the undos give back each earlier state in turn");
        let forward: Vec<Value> = states.iter().skip(1).cloned().collect();
        assert_eq!(redo_all(&mut doc.replica, scope), forward, "seed {seed}: the redos give back each later state in turn");
    }
}

/// The person and an agent edit the same text, list, tree, map and register in turn. Undoing all
/// the person's steps and redoing them gives back the state before the undos exactly; so does
/// the same for the agent's afterwards.
#[test]
fn undoing_and_redoing_all_of_one_scope_among_another_scopes_edits_gives_back_the_state() {
    for seed in 0..SEEDS {
        let mut rng = Rng::new(1000 + seed);
        let mut doc = setup();
        for _ in 0..30 {
            let origin = if rng.chance(50) { person() } else { agent() };
            step(&mut rng, &mut doc, &origin, &ALL);
        }
        let after = state(&doc.replica);
        for scope in [UndoScope::Person, UndoScope::Agent] {
            undo_all(&mut doc.replica, scope);
            assert!(!doc.replica.can_undo_in(scope), "seed {seed}: every step is undone");
            redo_all(&mut doc.replica, scope);
            assert_eq!(state(&doc.replica), after, "seed {seed}: undoing and redoing all of a scope gives back the state");
        }
    }
}

/// The person edits the text, its marks and the list; an agent, in between, the tree, the map and
/// the register. Undoing all the person's steps leaves exactly what the agent's edits alone make;
/// then undoing all the agent's gives back the state before both.
#[test]
fn each_undo_takes_back_its_own_steps_effect_among_another_scopes_edits() {
    let mine = [Kind::Text, Kind::List];
    let theirs = [Kind::Tree, Kind::Map, Kind::Register];
    for seed in 0..SEEDS {
        let mut rng = Rng::new(2000 + seed);
        let mut doc = setup();
        let before = state(&doc.replica);
        // The agent's edits alone, on a copy of the document.
        let mut alone = doc.replica.fork(ActorId::from_u64(2).unwrap()).unwrap();
        for _ in 0..30 {
            if rng.chance(50) {
                step(&mut rng, &mut doc, &person(), &mine);
            } else {
                let edits = step(&mut rng, &mut doc, &agent(), &theirs);
                if !edits.is_empty() {
                    assert!(apply(&mut alone, &doc.doc, &agent(), &edits), "seed {seed}: the agent's edit applies alone");
                }
            }
        }
        undo_all(&mut doc.replica, UndoScope::Person);
        assert_eq!(state(&doc.replica), state(&alone), "seed {seed}: the person's undos leave the agent's edits alone");
        undo_all(&mut doc.replica, UndoScope::Agent);
        assert_eq!(state(&doc.replica), before, "seed {seed}: the agent's undos then give back the state before both");
    }
}

/// The agent edits first, then the person, on the same fields. Undoing all the person's steps
/// gives back the state after the agent's, undoing all the agent's then the state before both;
/// redoing the agent's and then the person's gives back each state after them.
#[test]
fn undos_of_one_scope_after_another_scopes_steps_give_back_each_state_exactly() {
    for seed in 0..SEEDS {
        let mut rng = Rng::new(3000 + seed);
        let mut doc = setup();
        let before = state(&doc.replica);
        for _ in 0..15 {
            step(&mut rng, &mut doc, &agent(), &ALL);
        }
        let agents = state(&doc.replica);
        for _ in 0..15 {
            step(&mut rng, &mut doc, &person(), &ALL);
        }
        let after = state(&doc.replica);
        undo_all(&mut doc.replica, UndoScope::Person);
        assert_eq!(state(&doc.replica), agents, "seed {seed}: the person's undos give back the state after the agent's steps");
        undo_all(&mut doc.replica, UndoScope::Agent);
        assert_eq!(state(&doc.replica), before, "seed {seed}: the agent's undos give back the state before both");
        redo_all(&mut doc.replica, UndoScope::Agent);
        assert_eq!(state(&doc.replica), agents, "seed {seed}: the agent's redos give back the state after its steps");
        redo_all(&mut doc.replica, UndoScope::Person);
        assert_eq!(state(&doc.replica), after, "seed {seed}: the person's redos give back the state after both");
    }
}

/// A note's table commands reduced to the text they edit (kition-note `table_structure_commands_
/// and_undo`): inserts and deletes at overlapping places and a mark, each one step, undone one by
/// one. An undo of an older step was carried over a later deletion and the undo that put the text
/// back, which took the text apart at the wrong places.
#[test]
fn undos_in_turn_of_overlapping_text_edits_give_back_each_earlier_text() {
    let mut doc = setup();
    let edits = [
        Edit::Insert(9, " | a | b |".into()),
        Edit::Delete(2, 5),
        Edit::Insert(3, "XY".into()),
        Edit::Delete(1, 4),
        Edit::Mark(0, 3, true),
        Edit::Insert(0, "Z".into()),
        Edit::Delete(0, 2),
        Edit::Insert(4, "row".into()),
    ];
    let mut texts = vec![(doc.replica.text_delta(&doc.doc, "body").unwrap(), state(&doc.replica))];
    for edit in &edits {
        assert!(apply(&mut doc.replica, &doc.doc, &person(), std::slice::from_ref(edit)), "{edit:?} applies");
        texts.push((doc.replica.text_delta(&doc.doc, "body").unwrap(), state(&doc.replica)));
    }
    for (n, (text, state_before)) in texts.iter().rev().skip(1).enumerate() {
        assert!(doc.replica.undo().unwrap().is_done());
        assert_eq!(&doc.replica.text_delta(&doc.doc, "body").unwrap(), text, "undo {}", n + 1);
        assert_eq!(&state(&doc.replica), state_before, "undo {}", n + 1);
    }
    assert!(!doc.replica.can_undo());
    for (n, (text, _)) in texts.iter().skip(1).enumerate() {
        assert!(doc.replica.redo().unwrap().is_done());
        assert_eq!(&doc.replica.text_delta(&doc.doc, "body").unwrap(), text, "redo {}", n + 1);
    }
}

/// The person types, an agent types inside that text, the person deletes part of it and undoes
/// both steps: the agent's text stays, alone.
#[test]
fn undos_in_turn_keep_what_another_scope_typed_inside_the_text() {
    let mut doc = setup();
    let delete_all = Edit::Delete(0, 9);
    assert!(apply(&mut doc.replica, &doc.doc, &Origin::system("fixture"), &[delete_all]));
    assert!(apply(&mut doc.replica, &doc.doc, &person(), &[Edit::Insert(0, "abc".into())]));
    assert!(apply(&mut doc.replica, &doc.doc, &agent(), &[Edit::Insert(1, "X".into())]));
    assert!(apply(&mut doc.replica, &doc.doc, &person(), &[Edit::Delete(2, 1)]));
    assert_eq!(doc.replica.text(&doc.doc, "body").unwrap(), "aXc");
    assert!(doc.replica.undo().unwrap().is_done());
    assert_eq!(doc.replica.text(&doc.doc, "body").unwrap(), "aXbc");
    assert!(doc.replica.undo().unwrap().is_done());
    assert_eq!(doc.replica.text(&doc.doc, "body").unwrap(), "X");
}

/// Undoes every step of `scope` and redoes them all, one call at a time; answers the states
/// after each undo and after each redo.
fn undo_and_redo_one_by_one(replica: &mut Replica) -> (Vec<Value>, Vec<Value>) {
    let mut undone = Vec::new();
    while replica.undo().unwrap().is_done() {
        undone.push(state(replica));
    }
    let mut redone = Vec::new();
    while replica.redo().unwrap().is_done() {
        redone.push(state(replica));
    }
    (undone, redone)
}

/// Kit commands that each make one object and append it (kition-vector's shapes under one
/// group, a list's new item, typing at the end): N steps, N undos and N redos give back each
/// state in turn, the siblings in their order. Before, a redo was carried over the undos and
/// redos after it and put the siblings back reversed ([2, 3, 4] came back [4, 3, 2]).
#[test]
fn appended_objects_and_text_come_back_in_order_after_undoing_and_redoing_them_all() {
    for count in [3, 5, 8] {
        let mut doc = setup();
        let group = doc.items[0].clone();
        assert!(apply(&mut doc.replica, &doc.doc, &Origin::system("fixture"), &[Edit::TreeCreate(group.clone(), None)]));
        let mut states = vec![state(&doc.replica)];
        for n in 0..count {
            let target = doc.doc.clone();
            let parent = doc.replica.tree(&target, "outline").unwrap().into_iter().find(|entry| entry.object == group).unwrap().node;
            doc.replica
                .transact(&person(), |tx| {
                    let mut name = Map::new();
                    name.insert("name".into(), json!(format!("made {n}")));
                    let made = tx.create("Item", name)?;
                    tx.tree_create(&target, "outline", Some(&parent), &made)?;
                    let end = tx.list_items(&target, "items")?.len();
                    tx.list_insert(&target, "items", end, &made)?;
                    let len = tx.text_len(&target, "body")?;
                    tx.text_insert(&target, "body", len, &format!(" {n}"))
                })
                .unwrap();
            states.push(state(&doc.replica));
        }
        let (undone, redone) = undo_and_redo_one_by_one(&mut doc.replica);
        assert_eq!(undone, states.iter().rev().skip(1).cloned().collect::<Vec<_>>(), "{count} objects: each undo");
        assert_eq!(redone, states.iter().skip(1).cloned().collect::<Vec<_>>(), "{count} objects: each redo, the siblings in order");
    }
}

/// kition-layout's tracked changes: in "The catdog sat" (a tracked deletion of "cat", a tracked
/// insertion of "dog"), accepting the deletion takes "cat" out and rejecting the insertion takes
/// "dog" out, both at index 4; undoing both gives back "The catdog sat". Before, the undo of the
/// first was carried over the second and its undo, and the tie at index 4 put "cat" after "dog".
#[test]
fn undoing_two_deletions_at_one_place_puts_the_text_back_in_its_order() {
    let mut doc = setup();
    let all = doc.replica.text(&doc.doc, "body").unwrap().chars().count();
    assert!(apply(&mut doc.replica, &doc.doc, &Origin::system("fixture"), &[Edit::Delete(0, all), Edit::Insert(0, "The catdog sat".into())]));
    assert!(apply(&mut doc.replica, &doc.doc, &person(), &[Edit::Delete(4, 3)]));
    assert!(apply(&mut doc.replica, &doc.doc, &person(), &[Edit::Delete(4, 3)]));
    assert_eq!(doc.replica.text(&doc.doc, "body").unwrap(), "The  sat");
    assert!(doc.replica.undo().unwrap().is_done());
    assert_eq!(doc.replica.text(&doc.doc, "body").unwrap(), "The dog sat");
    assert!(doc.replica.undo().unwrap().is_done());
    assert_eq!(doc.replica.text(&doc.doc, "body").unwrap(), "The catdog sat");
}
