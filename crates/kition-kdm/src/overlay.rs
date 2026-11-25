// Copied from kition-sdk crates/kition-kdm/src/overlay.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The pending effects of one transaction. [`crate::Tx`] validates every operation against the
//! committed document plus this overlay, so a transaction sees its own earlier operations while
//! nothing is written to the store until it succeeds.
//!
//! The overlay never copies a whole field: a list keeps its length and its pending edits, a tree
//! keeps the parents of the nodes this transaction created or moved and asks the store for the
//! rest, a map keeps the latest write of each key it wrote.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::store::tree::Tree;
use crate::{KdmError, ObjectId, Result};

/// One field of one object. The field name is borrowed from the schema.
pub(crate) type FieldKey<'a> = (ObjectId, &'a str);

#[derive(Default)]
pub(crate) struct Overlay<'a> {
    /// Objects this transaction created: their type and the index of their `Create` operation.
    pub(crate) created: HashMap<ObjectId, (&'a str, usize)>,
    /// The ids of [`Overlay::created`] by type, in creation order (deleted ones included).
    pub(crate) created_by_type: HashMap<&'a str, Vec<ObjectId>>,
    pub(crate) deleted: HashSet<ObjectId>,
    /// Register writes: the index of the latest `Set` operation of each field.
    pub(crate) registers: HashMap<FieldKey<'a>, usize>,
    /// Text lengths in Unicode scalar values, loaded from the document on first touch.
    pub(crate) texts: HashMap<FieldKey<'a>, usize>,
    pub(crate) lists: HashMap<FieldKey<'a>, ListState>,
    pub(crate) trees: HashMap<FieldKey<'a>, TreeState<'a>>,
    /// Map writes: for each key written, the index of its latest `MapSet` operation, or `None`
    /// when the latest write deleted it.
    pub(crate) maps: HashMap<FieldKey<'a>, BTreeMap<String, Option<usize>>>,
}

impl Overlay<'_> {
    pub(crate) fn exists(&self, id: &ObjectId, in_document: impl FnOnce() -> bool) -> bool {
        !self.deleted.contains(id) && (self.created.contains_key(id) || in_document())
    }

    pub(crate) fn is_created(&self, id: &ObjectId) -> bool {
        self.created.contains_key(id)
    }
}

/// One pending change of a list, with the same index meaning as the store's operation.
pub(crate) enum ListEdit {
    Insert(usize, ObjectId),
    Move(usize, usize),
    Remove(usize),
}

/// A list as a transaction sees it: its current length (the store's on first touch plus this
/// transaction's edits) and the edits, replayed only when the items are read.
pub(crate) struct ListState {
    pub(crate) len: usize,
    pub(crate) edits: Vec<ListEdit>,
}

impl ListState {
    pub(crate) fn new(len: usize) -> Self {
        Self { len, edits: Vec::new() }
    }

    /// Applies the pending edits to the committed items, as the store will.
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

/// A tree as a transaction sees it: the store's tree (`None` when the object holds none yet) plus
/// the parents of the nodes this transaction created or moved, and the nodes it deleted.
pub(crate) struct TreeState<'a> {
    pub(crate) committed: Option<&'a Tree>,
    /// `None` as a value: the node is a root.
    pub(crate) parents: HashMap<ObjectId, Option<ObjectId>>,
    pub(crate) deleted: HashSet<ObjectId>,
}

impl<'a> TreeState<'a> {
    pub(crate) fn new(committed: Option<&'a Tree>) -> Self {
        Self { committed, parents: HashMap::new(), deleted: HashSet::new() }
    }

    /// The node's parent (`Some(None)`: a root), or `None` if the tree has no such node.
    pub(crate) fn parent(&self, node: &ObjectId) -> Option<Option<ObjectId>> {
        if self.deleted.contains(node) {
            return None;
        }
        if let Some(parent) = self.parents.get(node) {
            return Some(parent.clone());
        }
        self.committed?.parent(node).map(|parent| parent.cloned())
    }

    pub(crate) fn contains(&self, node: &ObjectId) -> bool {
        self.parent(node).is_some()
    }

    /// Whether making `parent` the parent of `node` would make `node` its own ancestor. Walks the
    /// ancestors of `parent`; a chain that loops (only possible in a corrupt tree) counts as a cycle.
    pub(crate) fn would_cycle(&self, node: &ObjectId, parent: &ObjectId) -> bool {
        let mut seen = HashSet::new();
        let mut current = Some(parent.clone());
        while let Some(at) = current {
            if at == *node || !seen.insert(at.clone()) {
                return true;
            }
            current = self.parent(&at).flatten();
        }
        false
    }
}
