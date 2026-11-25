// Copied from kition-sdk crates/kition-kdm/src/store/tree.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A tree field: its nodes are object ids, one node per object, each under a parent (`None`: a
//! root) at a place among its siblings.

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::{KdmError, ObjectId, Result};

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Tree {
    parent: HashMap<ObjectId, Option<ObjectId>>,
    /// Each parent's children in order; a parent without children has no entry.
    children: HashMap<Option<ObjectId>, Vec<ObjectId>>,
}

impl Tree {
    pub(crate) fn is_empty(&self) -> bool {
        self.parent.is_empty()
    }

    pub(crate) fn contains(&self, node: &ObjectId) -> bool {
        self.parent.contains_key(node)
    }

    /// The node's parent (`Some(None)`: a root), or `None` when the tree has no such node.
    pub(crate) fn parent(&self, node: &ObjectId) -> Option<Option<&ObjectId>> {
        self.parent.get(node).map(Option::as_ref)
    }

    /// The children of `parent` (`None`: the roots), in order.
    pub(crate) fn children(&self, parent: Option<&ObjectId>) -> &[ObjectId] {
        self.children.get(&parent.cloned()).map(Vec::as_slice).unwrap_or_default()
    }

    /// Every node, each with its parent.
    pub(crate) fn nodes(&self) -> impl Iterator<Item = (&ObjectId, Option<&ObjectId>)> {
        self.parent.iter().map(|(node, parent)| (node, parent.as_ref()))
    }

    /// The node's parent and its place among its siblings.
    pub(crate) fn place(&self, node: &ObjectId) -> Option<(Option<ObjectId>, usize)> {
        let parent = self.parent.get(node)?.clone();
        let index = self.children(parent.as_ref()).iter().position(|child| child == node)?;
        Some((parent, index))
    }

    /// Whether putting `node` under `parent` would make it its own ancestor.
    pub(crate) fn would_cycle(&self, node: &ObjectId, parent: &ObjectId) -> bool {
        let mut at = Some(parent);
        let mut steps = 0;
        while let Some(current) = at {
            if current == node || steps > self.parent.len() {
                return true;
            }
            steps += 1;
            at = self.parent.get(current).and_then(Option::as_ref);
        }
        false
    }

    /// Adds `node` under `parent` at `index` (at most the number of its children). The caller
    /// checked that the node is not in the tree and the parent is.
    pub(crate) fn insert(&mut self, node: ObjectId, parent: Option<ObjectId>, index: usize) {
        let siblings = self.children.entry(parent.clone()).or_default();
        siblings.insert(index.min(siblings.len()), node.clone());
        self.parent.insert(node, parent);
    }

    /// Takes `node` out of its parent's children (its own children stay under it); answers its
    /// parent and place.
    pub(crate) fn detach(&mut self, node: &ObjectId) -> Option<(Option<ObjectId>, usize)> {
        let (parent, index) = self.place(node)?;
        if let Some(siblings) = self.children.get_mut(&parent) {
            siblings.remove(index);
            if siblings.is_empty() {
                self.children.remove(&parent);
            }
        }
        self.parent.remove(node);
        Some((parent, index))
    }

    /// The nodes in pre-order (each parent before its children, siblings in order), each with its
    /// parent.
    pub(crate) fn preorder(&self) -> Vec<(ObjectId, Option<ObjectId>)> {
        let mut out = Vec::with_capacity(self.parent.len());
        let mut stack: Vec<(&ObjectId, Option<&ObjectId>)> = self.children(None).iter().rev().map(|node| (node, None)).collect();
        while let Some((node, parent)) = stack.pop() {
            out.push((node.clone(), parent.cloned()));
            stack.extend(self.children(Some(node)).iter().rev().map(|child| (child, Some(node))));
        }
        out
    }

    /// The nodes in pre-order (each parent before its children, siblings in order), each with its
    /// depth (a root's is 0). A node `keep` refuses is left out with its subtree. Iterative, so a
    /// tree of any depth.
    pub(crate) fn flat(&self, keep: &dyn Fn(&ObjectId) -> bool) -> Vec<(usize, &ObjectId)> {
        let mut out = Vec::with_capacity(self.parent.len());
        let mut stack: Vec<(usize, &ObjectId)> = self.children(None).iter().rev().map(|node| (0, node)).collect();
        while let Some((depth, node)) = stack.pop() {
            if !keep(node) {
                continue;
            }
            out.push((depth, node));
            stack.extend(self.children(Some(node)).iter().rev().map(|child| (depth + 1, child)));
        }
        out
    }

    /// A tree from its nodes in pre-order with their depths ([`Tree::flat`]): a node's parent is
    /// the last node before it one level up. Refuses ([`KdmError::Encoding`]) a depth more than
    /// one below the node before (a root's is 0) and a node named twice.
    pub(crate) fn from_flat(nodes: Vec<(usize, ObjectId)>) -> Result<Self> {
        let mut tree = Self::default();
        // The node at each depth on the way down to the last node read.
        let mut path: Vec<ObjectId> = Vec::new();
        for (depth, node) in nodes {
            if depth > path.len() {
                return Err(KdmError::Encoding(format!("the tree puts `{node}` at depth {depth}, more than one below the node before it")));
            }
            if tree.contains(&node) {
                return Err(KdmError::Encoding(format!("the tree names `{node}` twice")));
            }
            path.truncate(depth);
            let parent = path.last().cloned();
            let index = tree.children(parent.as_ref()).len();
            tree.insert(node.clone(), parent, index);
            path.push(node);
        }
        Ok(tree)
    }

    /// The tree as reads report it: `[{"children":[...],"object":"<id>"}]`, siblings in order. A
    /// node `keep` refuses is left out with its subtree. Built from [`Tree::flat`] with an explicit
    /// stack, without recursion.
    pub(crate) fn to_json(&self, keep: &dyn Fn(&ObjectId) -> bool) -> Value {
        // The nodes from a root down to the last node read, each with its children so far.
        let mut open: Vec<(&ObjectId, Vec<Value>)> = Vec::new();
        let mut roots = Vec::new();
        for (depth, node) in self.flat(keep) {
            while open.len() > depth {
                close_node(&mut open, &mut roots);
            }
            open.push((node, Vec::new()));
        }
        while !open.is_empty() {
            close_node(&mut open, &mut roots);
        }
        Value::Array(roots)
    }
}

/// Ends the last open node of [`Tree::to_json`]: its JSON goes to its parent's children, or to the
/// roots.
fn close_node(open: &mut Vec<(&ObjectId, Vec<Value>)>, roots: &mut Vec<Value>) {
    let Some((node, children)) = open.pop() else { return };
    let mut entry = Map::new();
    entry.insert("children".into(), Value::Array(children));
    entry.insert("object".into(), Value::String(node.to_string()));
    match open.last_mut() {
        Some((_, siblings)) => siblings.push(Value::Object(entry)),
        None => roots.push(Value::Object(entry)),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn id(name: &str) -> ObjectId {
        ObjectId::from_string(name)
    }

    #[test]
    fn nodes_keep_their_places_and_read_in_pre_order() {
        let mut tree = Tree::default();
        tree.insert(id("a"), None, 0);
        tree.insert(id("b"), None, 1);
        tree.insert(id("c"), Some(id("a")), 0);
        tree.insert(id("d"), Some(id("a")), 0);
        assert_eq!(tree.preorder(), vec![(id("a"), None), (id("d"), Some(id("a"))), (id("c"), Some(id("a"))), (id("b"), None)]);
        assert!(tree.would_cycle(&id("a"), &id("c")));
        assert!(!tree.would_cycle(&id("b"), &id("c")));
        let json = tree.to_json(&|_| true);
        assert_eq!(
            json,
            json!([{ "children": [{ "children": [], "object": "d" }, { "children": [], "object": "c" }], "object": "a" }, { "children": [], "object": "b" }])
        );
        let flat: Vec<(usize, ObjectId)> = tree.flat(&|_| true).into_iter().map(|(depth, node)| (depth, node.clone())).collect();
        assert_eq!(flat, vec![(0, id("a")), (1, id("d")), (1, id("c")), (0, id("b"))]);
        assert_eq!(Tree::from_flat(flat).unwrap(), tree);
        // A node left out goes with its subtree.
        assert_eq!(tree.flat(&|node: &ObjectId| node != &id("a")), vec![(0, &id("b"))]);
        assert_eq!(tree.to_json(&|node: &ObjectId| node != &id("a")), json!([{ "children": [], "object": "b" }]));
        assert_eq!(tree.detach(&id("d")), Some((Some(id("a")), 0)));
        assert_eq!(tree.place(&id("c")), Some((Some(id("a")), 0)));
        assert!(Tree::from_flat(vec![(0, id("a")), (1, id("a"))]).is_err());
        assert!(Tree::from_flat(vec![(1, id("a"))]).is_err());
        assert!(Tree::from_flat(vec![(0, id("a")), (2, id("b"))]).is_err());
    }
}
