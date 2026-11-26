// Copied from kition-sdk crates/kition-kdm/src/merge.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A draft's merge into a document that changed since the draft was made (data model 6.6, rules
//! D1 to D9).
//!
//! The draft's operations (`theirs`, made on the state at version v) and the document's since v
//! (`ours`, applied in order to that state) are compared field by field, by what each side
//! changed in the end (rule D2): a field written and written back is unchanged. A register or a
//! map key both changed to different values, a text both changed, an item of a list or a node of
//! a tree both moved or removed, and an object one side deleted while the other changed it
//! collide; anything else merges. The draft's operations on a list or tree the document also
//! changed are carried over the document's operations on it ([`through_with`]): list and tree
//! operations address items by id and position, so its inserts land among the same neighbours,
//! after the document's items at one position (rule D6).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde_json::Value;

use crate::ObjectId;
use crate::store::op::{Name, Op, TreePlace};
use crate::store::scalar::Scalar;
use crate::store::transform::{Tie, through_with};
use crate::store::tree::Tree;
use crate::store::{Field, Object, Store};

/// Where in a field a merge conflict is.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum MergeAt {
    /// A key of a map field.
    Key(String),
    /// An item of a list field or a node of a tree field: the object it names.
    Item(ObjectId),
}

/// One collision that refuses a draft's merge ([`crate::Replica::merge_conflicts`]): the rule of
/// data model 6.6 it breaks, the object, the field and the key or item, and what both sides did.
/// Its text (`Display`) is how a refused merge names it: `<object>.<field>["<key>"] (<reason>;
/// rule <rule>)`.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct MergeConflict {
    pub rule: &'static str,
    pub object: ObjectId,
    pub field: Option<String>,
    pub at: Option<MergeAt>,
    pub reason: &'static str,
}

impl fmt::Display for MergeConflict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.object)?;
        if let Some(field) = &self.field {
            write!(f, ".{field}")?;
        }
        match &self.at {
            Some(MergeAt::Key(key)) => write!(f, "[{}]", Value::String(key.clone()))?,
            Some(MergeAt::Item(item)) => write!(f, " item {item}")?,
            None => {}
        }
        write!(f, " ({}; rule {})", self.reason, self.rule)
    }
}

fn conflict(rule: &'static str, object: &ObjectId, field: Option<&Name>, at: Option<MergeAt>, reason: &'static str) -> MergeConflict {
    MergeConflict { rule, object: object.clone(), field: field.map(ToString::to_string), at, reason }
}

/// The kind of field an operation writes, by the operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Register,
    Map,
    Text,
    List,
    Tree,
}

fn kind(op: &Op) -> Option<Kind> {
    Some(match op {
        Op::Set { .. } => Kind::Register,
        Op::MapSet { .. } => Kind::Map,
        Op::TextInsert { .. } | Op::TextDelete { .. } | Op::TextMark { .. } => Kind::Text,
        Op::ListInsert { .. } | Op::ListRemove { .. } | Op::ListMove { .. } => Kind::List,
        Op::TreeCreate { .. } | Op::TreeMove { .. } | Op::TreeDelete { .. } => Kind::Tree,
        Op::Create { .. } | Op::Delete { .. } | Op::SchemaVersion { .. } => return None,
    })
}

/// A field of an object.
type FieldKey = (ObjectId, Name);

/// What one side's operations wrote.
#[derive(Default)]
struct Side {
    created: BTreeSet<ObjectId>,
    deleted: BTreeSet<ObjectId>,
    /// The objects whose fields it wrote (a tree's owner when it placed or took a node with its
    /// object).
    written: BTreeSet<ObjectId>,
    fields: BTreeMap<FieldKey, Kind>,
    /// The keys it wrote in each map field.
    keys: BTreeMap<FieldKey, BTreeSet<String>>,
    /// The items (nodes) it removed or moved in each list (tree) field.
    taken: BTreeMap<FieldKey, BTreeSet<ObjectId>>,
    /// The items (nodes) it inserted, placed or moved in each list (tree) field.
    placed: BTreeMap<FieldKey, BTreeSet<ObjectId>>,
    /// The items (nodes) it removed from each list (tree) field.
    removed: BTreeMap<FieldKey, BTreeSet<ObjectId>>,
    /// The nodes it put nodes under in each tree field.
    parents: BTreeMap<FieldKey, BTreeSet<ObjectId>>,
    /// Every object it inserted in a list or placed in a tree.
    placed_anywhere: BTreeSet<ObjectId>,
}

fn add(sets: &mut BTreeMap<FieldKey, BTreeSet<ObjectId>>, key: &FieldKey, item: &ObjectId) {
    sets.entry(key.clone()).or_default().insert(item.clone());
}

impl Side {
    fn of(ops: &[Op]) -> Self {
        let mut side = Self::default();
        for op in ops {
            match op {
                Op::Create { id, trees, .. } => {
                    side.created.insert(id.clone());
                    for place in trees {
                        let key = (place.owner.clone(), place.field.clone());
                        side.written.insert(place.owner.clone());
                        side.fields.entry(key.clone()).or_insert(Kind::Tree);
                        side.placed_anywhere.insert(id.clone());
                        add(&mut side.placed, &key, id);
                        if let Some(parent) = &place.parent {
                            add(&mut side.parents, &key, parent);
                        }
                    }
                }
                Op::Delete { id, trees, .. } => {
                    side.deleted.insert(id.clone());
                    for place in trees {
                        let key = (place.owner.clone(), place.field.clone());
                        side.written.insert(place.owner.clone());
                        side.fields.entry(key.clone()).or_insert(Kind::Tree);
                        add(&mut side.taken, &key, id);
                        add(&mut side.removed, &key, id);
                    }
                }
                Op::SchemaVersion { .. } => {}
                op => {
                    let (Some(id), Some(field), Some(kind)) = (op.object(), op.field(), kind(op)) else { continue };
                    let key = (id.clone(), field.clone());
                    side.written.insert(id.clone());
                    side.fields.entry(key.clone()).or_insert(kind);
                    match op {
                        Op::MapSet { key: name, .. } => {
                            side.keys.entry(key).or_default().insert(name.clone());
                        }
                        Op::ListInsert { item, .. } => {
                            side.placed_anywhere.insert(item.clone());
                            add(&mut side.placed, &key, item);
                        }
                        Op::ListRemove { item: Some(item), .. } => {
                            add(&mut side.taken, &key, item);
                            add(&mut side.removed, &key, item);
                        }
                        Op::ListMove { item: Some(item), .. } => {
                            add(&mut side.taken, &key, item);
                            add(&mut side.placed, &key, item);
                        }
                        Op::TreeCreate { node, parent, .. } => {
                            side.placed_anywhere.insert(node.clone());
                            add(&mut side.placed, &key, node);
                            if let Some(parent) = parent {
                                add(&mut side.parents, &key, parent);
                            }
                        }
                        Op::TreeMove { node, parent, .. } => {
                            add(&mut side.taken, &key, node);
                            add(&mut side.placed, &key, node);
                            if let Some(parent) = parent {
                                add(&mut side.parents, &key, parent);
                            }
                        }
                        Op::TreeDelete { node, .. } => {
                            add(&mut side.taken, &key, node);
                            add(&mut side.removed, &key, node);
                        }
                        _ => {}
                    }
                }
            }
        }
        side
    }
}

/// The items both sets hold.
fn both<'a>(a: Option<&'a BTreeSet<ObjectId>>, b: Option<&'a BTreeSet<ObjectId>>) -> Vec<&'a ObjectId> {
    match (a, b) {
        (Some(a), Some(b)) => a.intersection(b).collect(),
        _ => Vec::new(),
    }
}

/// Whether a register holds `value` (`null`: nothing).
fn same_register(held: Option<&Field>, value: &Value) -> bool {
    match held {
        None => value.is_null(),
        Some(Field::Value(scalar)) => scalar.is(value),
        Some(_) => false,
    }
}

/// The value of key `key` of a map field.
fn entry<'a>(field: Option<&'a Field>, key: &str) -> Option<&'a Scalar> {
    match field {
        Some(Field::Map(entries)) => entries.get_text(key),
        _ => None,
    }
}

/// Whether a map key holds `value` (`None`: the key is absent).
fn same_entry(held: Option<&Scalar>, value: Option<&Value>) -> bool {
    match (held, value) {
        (None, None) => true,
        (Some(scalar), Some(value)) => scalar.is(value),
        _ => false,
    }
}

/// The value the draft's last `set` of a register writes.
fn last_set<'a>(ops: &'a [Op], key: &FieldKey) -> Option<&'a Value> {
    ops.iter().rev().find_map(|op| match op {
        Op::Set { id, field, value, .. } if *id == key.0 && *field == key.1 => Some(value),
        _ => None,
    })
}

/// The value the draft's last write of a map key leaves (`Some(None)`: it deleted the key).
fn last_entry<'a>(ops: &'a [Op], key: &FieldKey, name: &str) -> Option<Option<&'a Value>> {
    ops.iter().rev().find_map(|op| match op {
        Op::MapSet { id, field, key: written, value, .. } if *id == key.0 && *field == key.1 && written == name => {
            Some(value.as_ref().filter(|value| !value.is_null()))
        }
        _ => None,
    })
}

/// The tree field of an object, if it holds one.
fn tree_of<'a>(store: &'a Store, key: &FieldKey) -> Option<&'a Tree> {
    match store.field(&key.0, &key.1) {
        Some(Field::Tree(tree)) => Some(tree),
        _ => None,
    }
}

/// The draft's operations `theirs` (made on the state at version v) as they apply to `now`, the
/// document after `ours` (its changes since v, applied in order to `before`, the state at v,
/// each naming the positions it frees or takes); or every collision (rules D2 to D8).
pub(crate) fn plan(theirs: Vec<Op>, ours: &[Op], before: &Store, now: &Store) -> Result<Vec<Op>, Vec<MergeConflict>> {
    let draft = Side::of(&theirs);
    let doc = Side::of(ours);
    let mut conflicts = Vec::new();
    // D8: objects.
    for id in draft.created.intersection(&doc.created) {
        conflicts.push(conflict("D8", id, None, None, "both created it"));
    }
    let deleted_by_doc = |id: &ObjectId| before.contains(id) && !now.contains(id);
    // Objects both deleted: the outcome both asked for, so the draft's deletion and its writes to
    // them do nothing.
    let mut deleted_by_both: BTreeSet<ObjectId> = BTreeSet::new();
    for id in doc.deleted.iter().filter(|id| deleted_by_doc(id)) {
        if draft.deleted.contains(id) {
            deleted_by_both.insert(id.clone());
            continue;
        }
        if draft.written.contains(id) || draft.placed_anywhere.contains(id) {
            conflicts.push(conflict("D8", id, None, None, "the draft changes it; the document deleted it"));
        }
    }
    for id in draft.deleted.iter().filter(|id| before.contains(id) && now.contains(id)) {
        if before.object(id) != now.object(id) || doc.placed_anywhere.contains(id) {
            conflicts.push(conflict("D8", id, None, None, "the draft deleted it; the document changed it"));
        }
    }

    // D3 to D7: fields both sides changed.
    let mut drop_registers: BTreeSet<FieldKey> = BTreeSet::new();
    let mut drop_keys: BTreeSet<(FieldKey, String)> = BTreeSet::new();
    let mut carried: BTreeMap<FieldKey, Kind> = BTreeMap::new();
    for (key, kind) in &draft.fields {
        let (id, field) = key;
        // A field of an object the draft made, deleted, or the document deleted (D8).
        if draft.created.contains(id) || draft.deleted.contains(id) || !before.contains(id) || !now.contains(id) {
            continue;
        }
        if !doc.fields.contains_key(key) && !doc.deleted.contains(id) {
            continue;
        }
        let (was, held) = (before.field(id, field), now.field(id, field));
        match kind {
            Kind::Register => {
                let Some(value) = last_set(&theirs, key) else { continue };
                if was == held {
                    continue;
                }
                if same_register(held, value) || same_register(was, value) {
                    drop_registers.insert(key.clone());
                } else {
                    conflicts.push(conflict("D3", id, Some(field), None, "both set it to different values"));
                }
            }
            Kind::Map => {
                let Some(names) = draft.keys.get(key) else { continue };
                for name in names {
                    let (at_v, now_v) = (entry(was, name), entry(held, name));
                    if at_v == now_v {
                        continue;
                    }
                    let Some(value) = last_entry(&theirs, key, name) else { continue };
                    if same_entry(now_v, value) || same_entry(at_v, value) {
                        drop_keys.insert((key.clone(), name.clone()));
                    } else {
                        conflicts.push(conflict("D4", id, Some(field), Some(MergeAt::Key(name.clone())), "both set the key to different values"));
                    }
                }
            }
            Kind::Text => {
                if was != held {
                    conflicts.push(conflict("D5", id, Some(field), None, "both edited the text"));
                }
            }
            Kind::List | Kind::Tree => {
                if was != held {
                    carried.insert(key.clone(), *kind);
                }
            }
        }
    }
    for (key, kind) in &carried {
        let (id, field) = key;
        let (rule, taken, placed) = match kind {
            Kind::Tree => ("D7", "both moved or deleted the node", "both placed the node"),
            _ => ("D6", "both moved or removed the item", "both inserted the item"),
        };
        // An item (node) both only removed is the outcome both asked for: the draft's removal
        // does nothing ([`Tie::Merge`]).
        let removed_only = |side: &Side, item: &ObjectId| {
            side.removed.get(key).is_some_and(|items| items.contains(item)) && !side.placed.get(key).is_some_and(|items| items.contains(item))
        };
        let taken_by_both: Vec<&ObjectId> =
            both(draft.taken.get(key), doc.taken.get(key)).into_iter().filter(|item| !(removed_only(&draft, item) && removed_only(&doc, item))).collect();
        for item in &taken_by_both {
            conflicts.push(conflict(rule, id, Some(field), Some(MergeAt::Item((*item).clone())), taken));
        }
        let all_taken = both(draft.taken.get(key), doc.taken.get(key));
        for item in both(draft.placed.get(key), doc.placed.get(key)) {
            if !all_taken.contains(&item) {
                conflicts.push(conflict(rule, id, Some(field), Some(MergeAt::Item(item.clone())), placed));
            }
        }
        if *kind != Kind::Tree {
            continue;
        }
        let (at_v, now_tree) = (tree_of(before, key), tree_of(now, key));
        for parent in both(draft.parents.get(key), doc.removed.get(key)) {
            if !now_tree.is_some_and(|tree| tree.contains(parent)) {
                conflicts.push(conflict(
                    "D7",
                    id,
                    Some(field),
                    Some(MergeAt::Item(parent.clone())),
                    "the draft puts a node under it; the document took it out",
                ));
            }
        }
        for parent in draft.removed.get(key).into_iter().flatten() {
            let Some(tree) = now_tree.filter(|tree| tree.contains(parent)) else { continue };
            let placed_since = tree.children(Some(parent)).iter().any(|child| at_v.and_then(|at_v| at_v.parent(child)) != Some(Some(parent)));
            if placed_since {
                conflicts.push(conflict(
                    "D7",
                    id,
                    Some(field),
                    Some(MergeAt::Item(parent.clone())),
                    "the draft takes it out; the document put a node under it",
                ));
            }
        }
    }
    if !conflicts.is_empty() {
        return Err(conflicts);
    }

    let kept: Vec<Op> = if drop_registers.is_empty() && drop_keys.is_empty() {
        theirs
    } else {
        theirs
            .into_iter()
            .filter(|op| match op {
                Op::Set { id, field, .. } => !drop_registers.contains(&(id.clone(), field.clone())),
                Op::MapSet { id, field, key, .. } => !drop_keys.contains(&((id.clone(), field.clone()), key.clone())),
                _ => true,
            })
            .collect()
    };
    // The draft's deletions of objects the document deleted too, and its writes to them, do
    // nothing (after the transform, which cancels the two deletions' places in a tree).
    let without_deleted = |ops: Vec<Op>| -> Vec<Op> {
        if deleted_by_both.is_empty() {
            return ops;
        }
        ops.into_iter().filter(|op| !op.object().is_some_and(|id| deleted_by_both.contains(id))).collect()
    };
    if carried.is_empty() {
        return Ok(without_deleted(kept));
    }
    let later: Vec<Op> = ours.iter().filter_map(|op| carried_part(op, &carried)).collect();
    let (ops, _) = through_with(kept, &later, Tie::Merge);
    let ops = without_deleted(ops);
    let cycles = cycles(&ops, &carried, now);
    if cycles.is_empty() { Ok(ops) } else { Err(cycles) }
}

/// The part of the document's operation `op` on the lists and trees in `carried`, for carrying
/// the draft's operations over it: a creation or deletion with only its places in those trees.
fn carried_part(op: &Op, carried: &BTreeMap<FieldKey, Kind>) -> Option<Op> {
    let inside = |place: &&TreePlace| carried.contains_key(&(place.owner.clone(), place.field.clone()));
    match op {
        Op::Create { id, object, trees } => {
            let trees: Vec<TreePlace> = trees.iter().filter(inside).cloned().collect();
            (!trees.is_empty()).then(|| Op::Create { id: id.clone(), object: Box::new(Object::new(object.ty().clone())), trees })
        }
        Op::Delete { id, trees, .. } => {
            let trees: Vec<TreePlace> = trees.iter().filter(inside).cloned().collect();
            (!trees.is_empty()).then(|| Op::Delete { id: id.clone(), was: None, trees })
        }
        op => match (op.object(), op.field(), kind(op)) {
            (Some(id), Some(field), Some(Kind::List | Kind::Tree)) if carried.contains_key(&(id.clone(), field.clone())) => Some(op.clone()),
            _ => None,
        },
    }
}

/// The tree `key` as the draft's operations so far leave it, starting from the document's.
fn tree_at<'a>(trees: &'a mut BTreeMap<FieldKey, Tree>, now: &Store, key: &FieldKey) -> &'a mut Tree {
    trees.entry(key.clone()).or_insert_with(|| tree_of(now, key).cloned().unwrap_or_default())
}

/// D7: the draft's moves (carried over the document's changes) in a tree both changed that would
/// make a node its own ancestor, as the document's moves left the tree.
fn cycles(ops: &[Op], carried: &BTreeMap<FieldKey, Kind>, now: &Store) -> Vec<MergeConflict> {
    let moving: BTreeSet<FieldKey> = ops
        .iter()
        .filter_map(|op| match op {
            Op::TreeMove { id, field, .. } if carried.contains_key(&(id.clone(), field.clone())) => Some((id.clone(), field.clone())),
            _ => None,
        })
        .collect();
    let mut out = Vec::new();
    if moving.is_empty() {
        return out;
    }
    let mut trees: BTreeMap<FieldKey, Tree> = BTreeMap::new();
    for op in ops {
        match op {
            Op::TreeCreate { id, field, node, parent, index } => {
                let key = (id.clone(), field.clone());
                if moving.contains(&key) {
                    tree_at(&mut trees, now, &key).insert(node.clone(), parent.clone(), index.unwrap_or(usize::MAX));
                }
            }
            Op::TreeMove { id, field, node, parent, index, .. } => {
                let key = (id.clone(), field.clone());
                if !moving.contains(&key) {
                    continue;
                }
                let tree = tree_at(&mut trees, now, &key);
                if let Some(parent) = parent
                    && tree.would_cycle(node, parent)
                {
                    out.push(conflict("D7", id, Some(field), Some(MergeAt::Item(node.clone())), "the draft moves it under a node the document moved under it"));
                    continue;
                }
                tree.detach(node);
                tree.insert(node.clone(), parent.clone(), index.unwrap_or(usize::MAX));
            }
            Op::TreeDelete { id, field, node, .. } => {
                let key = (id.clone(), field.clone());
                if moving.contains(&key) {
                    tree_at(&mut trees, now, &key).detach(node);
                }
            }
            Op::Create { id, trees: places, .. } => {
                for place in places {
                    let key = (place.owner.clone(), place.field.clone());
                    if moving.contains(&key) {
                        tree_at(&mut trees, now, &key).insert(id.clone(), place.parent.clone(), place.index);
                    }
                }
            }
            Op::Delete { id, .. } => {
                for key in &moving {
                    tree_at(&mut trees, now, key).detach(id);
                }
            }
            _ => {}
        }
    }
    out
}
