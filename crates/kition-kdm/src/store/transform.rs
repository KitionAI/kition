// Copied from kition-sdk crates/kition-kdm/src/store/transform.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Position transforms for text and lists (plan 2026-11-24, section 1.5): an undo's operations
//! were made for the state right after its step; changes applied since moved the text and the
//! items they address. [`through`] carries them over those changes, one at a time: text inserted
//! before a position moves it on, text deleted around it takes it back, an undo's delete keeps
//! text inserted inside its range by others, and an undo's mark does not spread over it. The log
//! is one line, so this is a plain transform of one sequence of operations against another. A
//! draft's merge (`crate::merge`, data model 6.6) carries the draft's list and tree operations
//! over the document's changes since the draft was made the same way, with the document's items
//! first at one position ([`Tie::Merge`]).
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
use std::mem;

use super::op::{Name, Op, TreePlace, inverse};
use crate::{ObjectId, TextRun};

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

/// The text, list and tree fields `ops` edit the positions of.
pub(crate) fn sequences_of(ops: &[Op]) -> HashSet<(&ObjectId, &str)> {
    ops.iter().flat_map(sequences).collect()
}

/// Whether `op` edits the positions of one of `fields` ([`sequences_of`]): only such operations
/// move another operation on those fields.
pub(crate) fn edits_any(op: &Op, fields: &HashSet<(&ObjectId, &str)>) -> bool {
    sequences(op).iter().any(|field| fields.contains(field))
}

/// The inverses of applied `ops`, last first, with every position they free or take: as
/// [`super::op::inverse_all`], but the deletion undoing a creation names the creation's tree
/// places, the node deletion undoing a node creation its place, and the text deletion undoing an
/// insertion the text it takes. Applying a deletion finds those itself; a transform needs them
/// to carry other positions past it.
pub(crate) fn inverse_with_places<'a>(ops: impl DoubleEndedIterator<Item = &'a Op>) -> Vec<Op> {
    ops.rev()
        .flat_map(|op| {
            let back = inverse(op);
            let placed = match (op, back.as_slice()) {
                (Op::Create { object, trees, .. }, [Op::Delete { id, .. }]) => {
                    Some(Op::Delete { id: id.clone(), was: Some(object.clone()), trees: trees.clone() })
                }
                (Op::TreeCreate { parent, index: Some(index), .. }, [Op::TreeDelete { id, field, node, .. }]) => {
                    Some(Op::TreeDelete { id: id.clone(), field: field.clone(), node: node.clone(), was: Some((parent.clone(), *index)) })
                }
                (Op::TextInsert { text, marks, .. }, [Op::TextDelete { id, field, index, count, .. }]) => Some(Op::TextDelete {
                    id: id.clone(),
                    field: field.clone(),
                    index: *index,
                    count: *count,
                    was: vec![TextRun { insert: text.clone(), attributes: marks.clone().unwrap_or_default() }],
                }),
                _ => None,
            };
            placed.map_or(back, |op| vec![op])
        })
        .collect()
}

/// Takes the change `undone` (applied in order) out from under `later`, the changes applied after
/// it, each a sequence of operations applied in order: each becomes what it does on the state
/// without `undone`. The undo that cancelled a change and the change itself compose to nothing,
/// so an undo of an older step is carried over neither, instead of over a deletion and the
/// insertion that put the text back (which loses the positions inside it).
pub(crate) fn exclude(later: &mut [Vec<Op>], undone: &[Op]) {
    let mut back: Vec<Op> = inverse_with_places(undone.iter()).into_iter().flat_map(split_move).collect();
    for segment in later {
        if back.is_empty() {
            break;
        }
        if segment.is_empty() {
            continue;
        }
        let ops: Vec<Op> = mem::take(segment).into_iter().flat_map(split_move).collect();
        let (moved, rest) = xform(ops, back, Tie::Undo);
        *segment = moved;
        back = rest;
    }
}

/// `ops` (applied in order on a state) carried over `later` (applied in order on that same
/// state), so they apply in order after `later`; and whether any of `later` moved them. List
/// moves come out as the removal and the insertion they are.
pub(crate) fn through(ops: Vec<Op>, later: &[Op]) -> (Vec<Op>, bool) {
    through_with(ops, later, Tie::Undo)
}

/// Which side's item comes first when two operations made on one state insert a list item or a
/// tree node at one position.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tie {
    /// The operation carried over comes first: an undo puts an item back where it was, before
    /// what others inserted there since.
    Undo,
    /// The operations it is carried over come first: a draft's item inserted where the document
    /// inserted one since comes after the document's (data model 6.6, rule D6).
    Merge,
}

/// [`through`], with `tie` deciding the order of two items inserted at one list or tree position.
pub(crate) fn through_with(ops: Vec<Op>, later: &[Op], tie: Tie) -> (Vec<Op>, bool) {
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
        let (moved, _) = xform(ops, split_move(op.clone()), tie);
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
fn xform(a: Vec<Op>, b: Vec<Op>, tie: Tie) -> (Vec<Op>, Vec<Op>) {
    let mut b = b;
    let mut out = Vec::with_capacity(a.len());
    for op in a {
        let (pieces, moved) = through_one(op, b, tie);
        out.extend(pieces);
        b = moved;
    }
    (out, b)
}

/// One operation carried through the sequence `b`: the operation (perhaps in pieces) to apply
/// after `b`, and `b` to apply after it.
fn through_one(op: Op, b: Vec<Op>, tie: Tie) -> (Vec<Op>, Vec<Op>) {
    let mut pieces = vec![op];
    let mut moved = Vec::with_capacity(b.len());
    for other in b {
        let (next, others) = pieces_against(pieces, other, tie);
        pieces = next;
        moved.extend(others);
    }
    (pieces, moved)
}

/// The pieces of one operation (a sequence) against one other operation.
fn pieces_against(mut pieces: Vec<Op>, other: Op, tie: Tie) -> (Vec<Op>, Vec<Op>) {
    if pieces.len() == 1
        && let Some(piece) = pieces.pop()
    {
        return pair(piece, other, tie);
    }
    let mut others = vec![other];
    let mut out = Vec::with_capacity(pieces.len());
    for piece in pieces {
        let (moved, rest) = through_one(piece, others, tie);
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
/// to apply after `a`. At one position, `b`'s text comes first, and `a`'s list item does
/// ([`Tie::Undo`]) or `b`'s ([`Tie::Merge`]). Answers none for an operation left with nothing to do.
fn pair(a: Op, b: Op, tie: Tie) -> (Vec<Op>, Vec<Op>) {
    if tie == Tie::Merge
        && let Some(both) = both_removed(&a, &b)
    {
        return both;
    }
    if share_a_tree(&a, &b) {
        let (a, b) = tree_pair(a, b, tie);
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
                    Op::TextDelete { id: bid.clone(), field: bfield.clone(), index: j, count: i - j, was: runs_between(&was, 0, i - j) },
                    Op::TextDelete { id: bid, field: bfield, index: j + n, count: j + m - i, was: runs_between(&was, i - j, m) },
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
                    Op::TextDelete { id: id.clone(), field: field.clone(), index: i, count: j - i, was: runs_between(&was, 0, j - i) },
                    Op::TextDelete { id, field, index: i + m, count: i + n - j, was: runs_between(&was, j - i, n) },
                ];
                (nonempty(deletes), vec![Op::TextInsert { id: bid, field: bfield, index: i, text: t, marks }])
            }
        }
        (Op::TextDelete { id, field, index: i, count: n, was }, Op::TextDelete { id: bid, field: bfield, index: j, count: m, was: bwas }) => {
            let overlap = (i + n).min(j + m).saturating_sub(i.max(j));
            let before_a = if j < i { m.min(i - j) } else { 0 };
            let before_b = if i < j { n.min(j - i) } else { 0 };
            // What each still deletes: its own characters but those the other deleted too.
            let (was, bwas) = if overlap == 0 {
                (was, bwas)
            } else {
                let (from, bfrom) = (i.max(j) - i, i.max(j) - j);
                let mut kept = runs_between(&was, 0, from);
                kept.extend(runs_between(&was, from + overlap, n));
                let mut bkept = runs_between(&bwas, 0, bfrom);
                bkept.extend(runs_between(&bwas, bfrom + overlap, m));
                (kept, bkept)
            };
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
            if i < j || (i == j && tie == Tie::Undo) {
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

/// For a merge ([`Tie::Merge`]): two operations made on one state that both remove one list
/// item, one tree node, or one object, transformed against each other. What remains of each is
/// what the other did not do already: nothing for the same removal, and an object's deletion
/// without its place in a tree the other side took the node out of.
fn both_removed(a: &Op, b: &Op) -> Option<(Vec<Op>, Vec<Op>)> {
    let without_place = |op: &Op, owner: &ObjectId, field: &Name| match op {
        Op::Delete { id, was, trees } => Op::Delete {
            id: id.clone(),
            was: was.clone(),
            trees: trees.iter().filter(|place| !(place.owner == *owner && place.field == *field)).cloned().collect(),
        },
        other => other.clone(),
    };
    match (a, b) {
        (Op::ListRemove { id, field, item: Some(x), .. }, Op::ListRemove { id: other, field: other_field, item: Some(y), .. })
            if id == other && field == other_field && x == y =>
        {
            Some((Vec::new(), Vec::new()))
        }
        (Op::TreeDelete { id, field, node, .. }, Op::TreeDelete { id: other, field: other_field, node: other_node, .. })
            if id == other && field == other_field && node == other_node =>
        {
            Some((Vec::new(), Vec::new()))
        }
        (Op::Delete { id, .. }, Op::Delete { id: other, .. }) if id == other => Some((Vec::new(), Vec::new())),
        (Op::TreeDelete { id, field, node, .. }, Op::Delete { id: object, trees, .. })
            if node == object && trees.iter().any(|place| place.owner == *id && place.field == *field) =>
        {
            Some((Vec::new(), vec![without_place(b, id, field)]))
        }
        (Op::Delete { id: object, trees, .. }, Op::TreeDelete { id, field, node, .. })
            if node == object && trees.iter().any(|place| place.owner == *id && place.field == *field) =>
        {
            Some((vec![without_place(a, id, field)], Vec::new()))
        }
        _ => None,
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

/// The characters `from..to` of the runs a deletion took, as runs. A deletion that names none
/// (one not applied) names none in its pieces either.
fn runs_between(was: &[TextRun], from: usize, to: usize) -> Vec<TextRun> {
    let mut out = Vec::new();
    let mut at = 0;
    for run in was {
        let len = chars(&run.insert);
        let (start, end) = (from.max(at), to.min(at + len));
        if start < end {
            out.push(TextRun { insert: run.insert.chars().skip(start - at).take(end - start).collect(), attributes: run.attributes.clone() });
        }
        at += len;
    }
    out
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
/// do. At one position, `a`'s node comes first ([`Tie::Undo`]) or `b`'s ([`Tie::Merge`]).
fn tree_pair(a: Op, b: Op, tie: Tie) -> (Op, Op) {
    let mut mine = slots(&a);
    let mut theirs = slots(&b);
    for one in &mut mine {
        for other in &mut theirs {
            shift(one, other, tie);
        }
    }
    (with_slots(a, mine.into_iter().map(|slot| slot.index).collect()), with_slots(b, theirs.into_iter().map(|slot| slot.index).collect()))
}

/// Two positions among one parent's children, made on one state, carried past each other.
fn shift(a: &mut Slot, b: &mut Slot, tie: Tie) {
    if a.owner != b.owner || a.field != b.field || a.parent != b.parent {
        return;
    }
    let (i, j) = (a.index, b.index);
    match (a.insert, b.insert) {
        (true, true) if i < j || (i == j && tie == Tie::Undo) => b.index = j + 1,
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
