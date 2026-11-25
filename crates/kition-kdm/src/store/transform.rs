// Copied from kition-sdk crates/kition-kdm/src/store/transform.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Position transforms for text and lists (plan 2026-11-24, section 1.5): an undo's operations
//! were made for the state right after its step; changes applied since moved the text and the
//! items they address. [`through`] carries them over those changes, one at a time: text inserted
//! before a position moves it on, text deleted around it takes it back, an undo's delete keeps
//! text inserted inside its range by others, and an undo's mark does not spread over it. The log
//! is one line, so this is a plain transform of one sequence of operations against another, not a
//! merge.
//!
//! Tree positions are carried the same way: a node's place among its siblings is a position in
//! the sequence of the parent's children, which tree operations, and creations and deletions of
//! objects that are nodes, insert into and remove from ([`tree_pair`]).
//!
//! Only operations on the same text, list or tree field affect each other; any other operation
//! passes unchanged. Positions that no longer fit are fitted when the undo applies
//! ([`super::Store::fit`]). The transform walks the operations with loops, not recursion, so a
//! change of any length transforms in time linear in its length for each operation since that
//! touches its fields.

use std::collections::HashSet;

use super::op::{Name, Op, TreePlace};
use crate::ObjectId;

/// The text, list or tree fields an operation edits the positions of: its own field for a text,
/// list or tree operation, and the trees it places its object in for a creation or deletion.
fn sequences(op: &Op) -> Vec<(&ObjectId, &str)> {
    match op {
        Op::Create { trees, .. } | Op::Delete { trees, .. } => trees.iter().map(|place| (&place.owner, &*place.field)).collect(),
        Op::TreeCreate { id, field, .. } | Op::TreeMove { id, field, .. } | Op::TreeDelete { id, field, .. } => vec![(id, &**field)],
        op if is_sequence_edit(op) => op.object().zip(op.field()).map(|(id, field)| (id, &**field)).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// `ops` (applied in order on a state) carried over `later` (applied in order on that same
/// state), so they apply in order after `later`; and whether any of `later` moved them. List
/// moves come out as the removal and the insertion they are.
pub(crate) fn through(ops: Vec<Op>, later: &[Op]) -> (Vec<Op>, bool) {
    let fields: HashSet<(&ObjectId, &str)> = ops.iter().flat_map(sequences).collect();
    let touching: Vec<&Op> = later.iter().filter(|op| sequences(op).iter().any(|field| fields.contains(field))).collect();
    if touching.is_empty() {
        return (ops, false);
    }
    let mut ops: Vec<Op> = ops.into_iter().flat_map(split_move).collect();
    for op in touching {
        if ops.is_empty() {
            break;
        }
        let (moved, _) = xform(ops, split_move(op.clone()));
        ops = moved;
    }
    (ops, true)
}

/// Whether both operations edit one text or one list field.
fn addresses_same_sequence(a: &Op, b: &Op) -> bool {
    is_sequence_edit(a) && is_sequence_edit(b) && a.object() == b.object() && a.field() == b.field()
}

fn is_sequence_edit(op: &Op) -> bool {
    matches!(op, Op::TextInsert { .. } | Op::TextDelete { .. } | Op::TextMark { .. } | Op::ListInsert { .. } | Op::ListRemove { .. } | Op::ListMove { .. })
}

/// A list move as the removal and the insertion it is, for transforming.
fn split_move(op: Op) -> Vec<Op> {
    match op {
        Op::ListMove { id, field, from, to, item: Some(item) } => {
            vec![Op::ListRemove { id: id.clone(), field: field.clone(), index: from, item: Some(item.clone()) }, Op::ListInsert { id, field, index: to, item }]
        }
        other => vec![other],
    }
}

/// Two sequences of operations made on one state (neither holding a list move), transformed
/// against each other: `a` to apply after `b`, and `b` to apply after `a` ([`pair`]). Each
/// operation of `a` passes through all of `b` in a loop; only an operation [`pair`] cut in pieces
/// goes round again, for its pieces.
fn xform(a: Vec<Op>, b: Vec<Op>) -> (Vec<Op>, Vec<Op>) {
    let mut b = b;
    let mut out = Vec::with_capacity(a.len());
    for op in a {
        let (pieces, moved) = through_one(op, b);
        out.extend(pieces);
        b = moved;
    }
    (out, b)
}

/// One operation carried through the sequence `b`: the operation (perhaps in pieces) to apply
/// after `b`, and `b` to apply after it.
fn through_one(op: Op, b: Vec<Op>) -> (Vec<Op>, Vec<Op>) {
    let mut pieces = vec![op];
    let mut moved = Vec::with_capacity(b.len());
    for other in b {
        let (next, others) = pieces_against(pieces, other);
        pieces = next;
        moved.extend(others);
    }
    (pieces, moved)
}

/// The pieces of one operation (a sequence) against one other operation.
fn pieces_against(mut pieces: Vec<Op>, other: Op) -> (Vec<Op>, Vec<Op>) {
    if pieces.len() == 1
        && let Some(piece) = pieces.pop()
    {
        return pair(piece, other);
    }
    let mut others = vec![other];
    let mut out = Vec::with_capacity(pieces.len());
    for piece in pieces {
        let (moved, rest) = through_one(piece, others);
        out.extend(moved);
        others = rest;
    }
    (out, others)
}

/// The number of characters of an insertion.
fn chars(text: &str) -> usize {
    text.chars().count()
}

/// Two operations made on one state, transformed against each other: `a` to apply after `b`, `b`
/// to apply after `a`. At one position, `b`'s text comes first and `a`'s list item does. Answers
/// none for an operation left with nothing to do.
fn pair(a: Op, b: Op) -> (Vec<Op>, Vec<Op>) {
    if share_a_tree(&a, &b) {
        let (a, b) = tree_pair(a, b);
        return (vec![a], vec![b]);
    }
    if !addresses_same_sequence(&a, &b) {
        return (vec![a], vec![b]);
    }
    match (a, b) {
        (Op::TextInsert { id, field, index: i, text: s, marks }, b @ Op::TextInsert { .. }) => {
            let Op::TextInsert { index: j, ref text, .. } = b else { return (Vec::new(), vec![b]) };
            let (n, m) = (chars(&s), chars(text));
            // At one position the other text comes first: text taken back and put back loses its
            // place among what was typed at that point, and what was typed after it stays after.
            if i < j {
                (vec![Op::TextInsert { id, field, index: i, text: s, marks }], vec![with_index(b, j + n)])
            } else {
                (vec![Op::TextInsert { id, field, index: i + m, text: s, marks }], vec![b])
            }
        }
        (Op::TextInsert { id, field, index: i, text: s, marks }, Op::TextDelete { id: bid, field: bfield, index: j, count: m, was }) => {
            let n = chars(&s);
            if i <= j {
                (vec![Op::TextInsert { id, field, index: i, text: s, marks }], vec![Op::TextDelete { id: bid, field: bfield, index: j + n, count: m, was }])
            } else if i >= j + m {
                (vec![Op::TextInsert { id, field, index: i - m, text: s, marks }], vec![Op::TextDelete { id: bid, field: bfield, index: j, count: m, was }])
            } else {
                // Inserted inside the deleted range: the insertion stays, at the range's start.
                let deletes = vec![
                    Op::TextDelete { id: bid.clone(), field: bfield.clone(), index: j, count: i - j, was: Vec::new() },
                    Op::TextDelete { id: bid, field: bfield, index: j + n, count: j + m - i, was: Vec::new() },
                ];
                (vec![Op::TextInsert { id, field, index: j, text: s, marks }], nonempty(deletes))
            }
        }
        (Op::TextDelete { id, field, index: i, count: n, was }, Op::TextInsert { id: bid, field: bfield, index: j, text: t, marks }) => {
            let m = chars(&t);
            if j <= i {
                (vec![Op::TextDelete { id, field, index: i + m, count: n, was }], vec![Op::TextInsert { id: bid, field: bfield, index: j, text: t, marks }])
            } else if j >= i + n {
                (vec![Op::TextDelete { id, field, index: i, count: n, was }], vec![Op::TextInsert { id: bid, field: bfield, index: j - n, text: t, marks }])
            } else {
                // The other text, inserted inside this range, is kept.
                let deletes = vec![
                    Op::TextDelete { id: id.clone(), field: field.clone(), index: i, count: j - i, was: Vec::new() },
                    Op::TextDelete { id, field, index: i + m, count: i + n - j, was: Vec::new() },
                ];
                (nonempty(deletes), vec![Op::TextInsert { id: bid, field: bfield, index: i, text: t, marks }])
            }
        }
        (Op::TextDelete { id, field, index: i, count: n, was }, Op::TextDelete { id: bid, field: bfield, index: j, count: m, was: bwas }) => {
            let overlap = (i + n).min(j + m).saturating_sub(i.max(j));
            let before_a = if j < i { m.min(i - j) } else { 0 };
            let before_b = if i < j { n.min(j - i) } else { 0 };
            (
                nonempty(vec![Op::TextDelete { id, field, index: i - before_a, count: n - overlap, was }]),
                nonempty(vec![Op::TextDelete { id: bid, field: bfield, index: j - before_b, count: m - overlap, was: bwas }]),
            )
        }
        (Op::TextMark { id, field, start, end, key, value, was }, b @ Op::TextInsert { .. }) => {
            let Op::TextInsert { index: j, ref text, .. } = b else { return (Vec::new(), vec![b]) };
            let m = chars(text);
            let marks = if j <= start {
                vec![Op::TextMark { id, field, start: start + m, end: end + m, key, value, was }]
            } else if j >= end {
                vec![Op::TextMark { id, field, start, end, key, value, was }]
            } else {
                // Not spread over the other text inserted inside the range.
                vec![
                    Op::TextMark { id: id.clone(), field: field.clone(), start, end: j, key: key.clone(), value: value.clone(), was: Vec::new() },
                    Op::TextMark { id, field, start: j + m, end: end + m, key, value, was: Vec::new() },
                ]
            };
            (marks, vec![b])
        }
        (Op::TextMark { id, field, start, end, key, value, was }, b @ Op::TextDelete { .. }) => {
            let Op::TextDelete { index: j, count: m, .. } = b else { return (Vec::new(), vec![b]) };
            let map = |at: usize| if at > j { at - (at - j).min(m) } else { at };
            let (start, end) = (map(start), map(end));
            let marks = if start < end { vec![Op::TextMark { id, field, start, end, key, value, was }] } else { Vec::new() };
            (marks, vec![b])
        }
        (a @ (Op::TextInsert { .. } | Op::TextDelete { .. } | Op::TextMark { .. }), b @ Op::TextMark { .. }) => (vec![a], vec![b]),
        (Op::ListInsert { id, field, index: i, item }, b @ Op::ListInsert { .. }) => {
            let Op::ListInsert { index: j, .. } = b else { return (Vec::new(), vec![b]) };
            if i <= j {
                (vec![Op::ListInsert { id, field, index: i, item }], vec![with_index(b, j + 1)])
            } else {
                (vec![Op::ListInsert { id, field, index: i + 1, item }], vec![b])
            }
        }
        (Op::ListInsert { id, field, index: i, item }, b @ Op::ListRemove { .. }) => {
            let Op::ListRemove { index: j, .. } = b else { return (Vec::new(), vec![b]) };
            if i <= j {
                (vec![Op::ListInsert { id, field, index: i, item }], vec![with_index(b, j + 1)])
            } else {
                (vec![Op::ListInsert { id, field, index: i - 1, item }], vec![b])
            }
        }
        (Op::ListRemove { id, field, index: i, item }, b @ Op::ListInsert { .. }) => {
            let Op::ListInsert { index: j, .. } = b else { return (Vec::new(), vec![b]) };
            if j <= i {
                (vec![Op::ListRemove { id, field, index: i + 1, item }], vec![b])
            } else {
                (vec![Op::ListRemove { id, field, index: i, item }], vec![with_index(b, j - 1)])
            }
        }
        (Op::ListRemove { id, field, index: i, item }, b @ Op::ListRemove { .. }) => {
            let Op::ListRemove { index: j, .. } = b else { return (Vec::new(), vec![b]) };
            if i == j {
                // The same item: an undo's removal stays, to find the item wherever a move put it
                // (`Store::fit` skips it when the item is gone).
                (vec![Op::ListRemove { id, field, index: i, item }], Vec::new())
            } else if j < i {
                (vec![Op::ListRemove { id, field, index: i - 1, item }], vec![b])
            } else {
                (vec![Op::ListRemove { id, field, index: i, item }], vec![with_index(b, j - 1)])
            }
        }
        (a, b) => (vec![a], vec![b]),
    }
}

/// The operation with its position set to `index`.
fn with_index(op: Op, index: usize) -> Op {
    match op {
        Op::TextInsert { id, field, text, marks, .. } => Op::TextInsert { id, field, index, text, marks },
        Op::TextDelete { id, field, count, was, .. } => Op::TextDelete { id, field, index, count, was },
        Op::ListInsert { id, field, item, .. } => Op::ListInsert { id, field, index, item },
        Op::ListRemove { id, field, item, .. } => Op::ListRemove { id, field, index, item },
        other => other,
    }
}

/// Drops deletions of no characters.
fn nonempty(ops: Vec<Op>) -> Vec<Op> {
    ops.into_iter().filter(|op| !matches!(op, Op::TextDelete { count: 0, .. })).collect()
}

/// One position a tree operation inserts a node at, or removes one from: the tree (its owner and
/// field), the parent (`None`: the roots) and the index among the parent's children.
struct Slot {
    owner: ObjectId,
    field: Name,
    parent: Option<ObjectId>,
    index: usize,
    insert: bool,
}

/// The positions `op` removes nodes from and inserts them at, in the order it does: a move
/// removes, then inserts.
fn slots(op: &Op) -> Vec<Slot> {
    let slot = |owner: &ObjectId, field: &Name, parent: &Option<ObjectId>, index: usize, insert: bool| Slot {
        owner: owner.clone(),
        field: field.clone(),
        parent: parent.clone(),
        index,
        insert,
    };
    match op {
        Op::TreeCreate { id, field, parent, index: Some(index), .. } => vec![slot(id, field, parent, *index, true)],
        Op::TreeDelete { id, field, was: Some((parent, index)), .. } => vec![slot(id, field, parent, *index, false)],
        Op::TreeMove { id, field, parent, index, was, .. } => {
            let removed = was.as_ref().map(|(from, at)| slot(id, field, from, *at, false));
            let inserted = index.map(|at| slot(id, field, parent, at, true));
            removed.into_iter().chain(inserted).collect()
        }
        Op::Create { trees, .. } => trees.iter().map(|place| slot(&place.owner, &place.field, &place.parent, place.index, true)).collect(),
        Op::Delete { trees, .. } => trees.iter().map(|place| slot(&place.owner, &place.field, &place.parent, place.index, false)).collect(),
        _ => Vec::new(),
    }
}

/// `op` with the indexes of its [`slots`] set to `indexes`, in the same order.
fn with_slots(op: Op, indexes: Vec<usize>) -> Op {
    let mut next = indexes.into_iter();
    let mut take = |index: usize| next.next().unwrap_or(index);
    match op {
        Op::TreeCreate { id, field, node, parent, index } => Op::TreeCreate { id, field, node, parent, index: index.map(&mut take) },
        Op::TreeDelete { id, field, node, was } => Op::TreeDelete { id, field, node, was: was.map(|(parent, index)| (parent, take(index))) },
        Op::TreeMove { id, field, node, parent, index, was } => {
            let was = was.map(|(from, at)| (from, take(at)));
            Op::TreeMove { id, field, node, parent, index: index.map(&mut take), was }
        }
        Op::Create { id, object, trees } => {
            Op::Create { id, object, trees: trees.into_iter().map(|place| TreePlace { index: take(place.index), ..place }).collect() }
        }
        Op::Delete { id, was, trees } => {
            Op::Delete { id, was, trees: trees.into_iter().map(|place| TreePlace { index: take(place.index), ..place }).collect() }
        }
        other => other,
    }
}

/// Whether both operations place nodes in one tree.
fn share_a_tree(a: &Op, b: &Op) -> bool {
    let theirs = slots(b);
    slots(a).iter().any(|mine| theirs.iter().any(|other| mine.owner == other.owner && mine.field == other.field))
}

/// Two operations made on one state that place nodes in one tree, transformed against each
/// other: each position of `a` (in order) passes through each position of `b`, as list positions
/// do. At one position, `a`'s node comes first.
fn tree_pair(a: Op, b: Op) -> (Op, Op) {
    let mut mine = slots(&a);
    let mut theirs = slots(&b);
    for one in &mut mine {
        for other in &mut theirs {
            shift(one, other);
        }
    }
    (with_slots(a, mine.into_iter().map(|slot| slot.index).collect()), with_slots(b, theirs.into_iter().map(|slot| slot.index).collect()))
}

/// Two positions among one parent's children, made on one state, carried past each other.
fn shift(a: &mut Slot, b: &mut Slot) {
    if a.owner != b.owner || a.field != b.field || a.parent != b.parent {
        return;
    }
    let (i, j) = (a.index, b.index);
    match (a.insert, b.insert) {
        (true, true) if i <= j => b.index = j + 1,
        (true, true) => a.index = i + 1,
        (true, false) if i <= j => b.index = j + 1,
        (true, false) => a.index = i - 1,
        (false, true) if j <= i => a.index = i + 1,
        (false, true) => b.index = j - 1,
        // Both took the node at one place (each names its node, so neither moves the other).
        (false, false) if i == j => {}
        (false, false) if j < i => a.index = i - 1,
        (false, false) => b.index = j - 1,
    }
}
