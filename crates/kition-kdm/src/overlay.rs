// Copied from kition-sdk crates/kition-kdm/src/overlay.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The pending effects of one transaction. [`crate::Tx`] validates every operation against the
//! committed document plus this overlay, so a transaction sees its own earlier operations while
//! nothing is written to the engine until it succeeds.
//!
//! The overlay never copies a whole container: a list keeps its length and its pending edits, a
//! tree keeps the parents of the nodes this transaction created or moved and asks the engine for
//! the rest. Validation is O(1) per list operation and O(depth) per tree move.

use std::collections::{HashMap, HashSet};

use loro::{LoroTree, TreeID, TreeParentId};

use crate::{KdmError, ObjectId, Result};

/// A tree node as a transaction sees it: one in the document, or the n-th one it created.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum NodeKey {
    Committed(TreeID),
    Pending(usize),
}

/// One field of one object. The field name is borrowed from the schema.
pub(crate) type FieldKey<'a> = (ObjectId, &'a str);

#[derive(Default)]
pub(crate) struct Overlay<'a> {
    /// Objects this transaction created: their type and the index of their `Create` operation,
    /// whose fields hold the initial register values.
    pub(crate) created: HashMap<ObjectId, (&'a str, usize)>,
    pub(crate) deleted: HashSet<ObjectId>,
    /// Register writes: the index of the latest `Set` operation of each field.
    pub(crate) registers: HashMap<FieldKey<'a>, usize>,
    /// Text lengths in Unicode scalar values, loaded from the document on first touch.
    pub(crate) texts: HashMap<FieldKey<'a>, usize>,
    pub(crate) lists: HashMap<FieldKey<'a>, ListState>,
    pub(crate) trees: HashMap<FieldKey<'a>, TreeState>,
}

impl Overlay<'_> {
    pub(crate) fn exists(&self, id: &ObjectId, in_document: impl FnOnce() -> bool) -> bool {
        !self.deleted.contains(id) && (self.created.contains_key(id) || in_document())
    }

    pub(crate) fn is_created(&self, id: &ObjectId) -> bool {
        self.created.contains_key(id)
    }
}

/// One pending change of a list, with the same index meaning as the engine's operation.
pub(crate) enum ListEdit {
    Insert(usize, ObjectId),
    Move(usize, usize),
    Remove(usize),
}

/// A list as a transaction sees it: its current length (the engine's length on first touch plus
/// this transaction's edits) and the edits, replayed only when the items are read.
pub(crate) struct ListState {
    pub(crate) len: usize,
    pub(crate) edits: Vec<ListEdit>,
}

impl ListState {
    pub(crate) fn new(len: usize) -> Self {
        Self { len, edits: Vec::new() }
    }

    /// Applies the pending edits to the committed items, as the engine will.
    pub(crate) fn replay(&self, items: &mut Vec<ObjectId>) -> Result<()> {
        let inconsistent = || KdmError::Engine("a staged list edit does not fit the list".into());
        for edit in &self.edits {
            match edit {
                ListEdit::Insert(index, item) if *index <= items.len() => items.insert(*index, item.clone()),
                ListEdit::Move(from, to) if *from < items.len() && *to < items.len() => {
                    let item = items.remove(*from);
                    items.insert(*to, item);
                }
                ListEdit::Remove(index) if *index < items.len() => {
                    items.remove(*index);
                }
                _ => return Err(inconsistent()),
            }
        }
        Ok(())
    }
}

/// A tree as a transaction sees it: the engine's tree (`None` for one created by this
/// transaction) plus the parents of the nodes this transaction created or moved.
pub(crate) struct TreeState {
    pub(crate) committed: Option<LoroTree>,
    /// `None` as a value: the node is a root.
    pub(crate) parents: HashMap<NodeKey, Option<NodeKey>>,
}

impl TreeState {
    pub(crate) fn new(committed: Option<LoroTree>) -> Self {
        Self { committed, parents: HashMap::new() }
    }

    /// The node's parent (`Some(None)`: a root), or `None` if the tree has no such live node.
    pub(crate) fn parent(&self, node: NodeKey) -> Option<Option<NodeKey>> {
        if let Some(parent) = self.parents.get(&node) {
            return Some(*parent);
        }
        let NodeKey::Committed(id) = node else { return None };
        match self.committed.as_ref()?.parent(id)? {
            TreeParentId::Node(parent) => Some(Some(NodeKey::Committed(parent))),
            TreeParentId::Root => Some(None),
            TreeParentId::Deleted | TreeParentId::Unexist => None,
        }
    }

    pub(crate) fn contains(&self, node: NodeKey) -> bool {
        self.parent(node).is_some()
    }

    /// Whether making `parent` the parent of `node` would make `node` its own ancestor. Walks the
    /// ancestors of `parent`; a chain that loops (only possible in a corrupt tree) counts as a cycle.
    pub(crate) fn would_cycle(&self, node: NodeKey, parent: NodeKey) -> bool {
        let mut seen = HashSet::new();
        let mut current = Some(parent);
        while let Some(at) = current {
            if at == node || !seen.insert(at) {
                return true;
            }
            current = self.parent(at).flatten();
        }
        false
    }
}
