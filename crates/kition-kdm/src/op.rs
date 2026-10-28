// Copied from kition-sdk crates/kition-kdm/src/op.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A transaction's buffered operations and their application to the engine.
//!
//! [`crate::Tx`] validates each operation when it is called and records it here; nothing reaches
//! the engine until the transaction's closure has succeeded. The engine cannot abort a transaction
//! (its operations take effect as they are applied), so staging is what makes a failed transaction
//! leave no operations behind.

use loro::{Container, LoroDoc, LoroMap, LoroMovableList, LoroText, LoroTree, TreeID, TreeParentId};
use serde_json::{Map, Value};

use crate::error::engine;
use crate::overlay::NodeKey;
use crate::read::{self, META, NODE_OBJECT, OBJECTS, SCHEMA_RAISES, SCHEMA_VERSION, TYPE_KEY};
use crate::value::to_loro;
use crate::{FieldKind, KdmError, ObjectId, Result, Schema};

#[cfg(test)]
thread_local! {
    /// Unit tests only: makes the next `apply` on this thread fail at this operation index, so the
    /// fallback that reverts a partly applied transaction can be exercised.
    pub(crate) static FAIL_AT: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

pub(crate) enum Op<'a> {
    Create {
        id: ObjectId,
        ty: &'a str,
        fields: Map<String, Value>,
    },
    Set {
        id: ObjectId,
        field: &'a str,
        value: Value,
    },
    Delete {
        id: ObjectId,
    },
    TextInsert {
        id: ObjectId,
        field: &'a str,
        index: usize,
        content: String,
    },
    TextDelete {
        id: ObjectId,
        field: &'a str,
        index: usize,
        count: usize,
    },
    /// Sets mark `key` to `value` over `start..end` (Unicode scalar values; never empty).
    TextMark {
        id: ObjectId,
        field: &'a str,
        start: usize,
        end: usize,
        key: &'a str,
        value: Value,
    },
    /// Removes mark `key` from `start..end` (never empty).
    TextUnmark {
        id: ObjectId,
        field: &'a str,
        start: usize,
        end: usize,
        key: &'a str,
    },
    ListInsert {
        id: ObjectId,
        field: &'a str,
        index: usize,
        item: ObjectId,
    },
    ListMove {
        id: ObjectId,
        field: &'a str,
        from: usize,
        to: usize,
    },
    ListRemove {
        id: ObjectId,
        field: &'a str,
        index: usize,
    },
    MapSet {
        id: ObjectId,
        field: &'a str,
        key: String,
        value: Value,
    },
    MapDelete {
        id: ObjectId,
        field: &'a str,
        key: String,
    },
    /// Creates the transaction's `node`-th node.
    TreeCreate {
        id: ObjectId,
        field: &'a str,
        parent: Option<NodeKey>,
        object: ObjectId,
        node: usize,
    },
    TreeMove {
        id: ObjectId,
        field: &'a str,
        node: NodeKey,
        parent: Option<NodeKey>,
    },
    /// Deletes a node that has no children: only [`crate::Tx::tree_dedupe`] makes it (M10b).
    TreeDelete {
        id: ObjectId,
        field: &'a str,
        node: NodeKey,
    },
    /// Raises the document's minimum schema version to `version` (rule M20); a no-op when it is
    /// already at least `version` when applied.
    RaiseSchema {
        version: u32,
    },
}

impl Op<'_> {
    /// The object whose state the operation changes; `None` for a change of the document's meta.
    pub(crate) fn object(&self) -> Option<&ObjectId> {
        Some(match self {
            Self::Create { id, .. }
            | Self::Set { id, .. }
            | Self::Delete { id }
            | Self::TextInsert { id, .. }
            | Self::TextDelete { id, .. }
            | Self::TextMark { id, .. }
            | Self::TextUnmark { id, .. }
            | Self::ListInsert { id, .. }
            | Self::ListMove { id, .. }
            | Self::ListRemove { id, .. }
            | Self::MapSet { id, .. }
            | Self::MapDelete { id, .. }
            | Self::TreeCreate { id, .. }
            | Self::TreeMove { id, .. }
            | Self::TreeDelete { id, .. } => id,
            Self::RaiseSchema { .. } => return None,
        })
    }
}

/// Applies validated operations in order, calling `touched` with each one's object. Answers the
/// engine ids of the created nodes, by creation index. Does not commit.
pub(crate) fn apply(doc: &LoroDoc, schema: &Schema, ops: Vec<Op<'_>>, node_count: usize, mut touched: impl FnMut(&ObjectId)) -> Result<Vec<Option<TreeID>>> {
    let mut nodes: Vec<Option<TreeID>> = vec![None; node_count];
    for (index, op) in ops.into_iter().enumerate() {
        fail_if_forced(index)?;
        if let Some(id) = op.object() {
            touched(id);
        }
        apply_one(doc, schema, op, &mut nodes)?;
    }
    Ok(nodes)
}

#[cfg(test)]
fn fail_if_forced(index: usize) -> Result<()> {
    if FAIL_AT.with(|at| at.get()) == Some(index) {
        FAIL_AT.with(|at| at.set(None));
        return Err(KdmError::Engine("forced failure".into()));
    }
    Ok(())
}

#[cfg(not(test))]
#[inline(always)]
fn fail_if_forced(_index: usize) -> Result<()> {
    Ok(())
}

fn apply_one(doc: &LoroDoc, schema: &Schema, op: Op<'_>, nodes: &mut [Option<TreeID>]) -> Result<()> {
    match op {
        Op::Create { id, ty, fields } => {
            let map = doc.get_map(OBJECTS).insert_container(id.as_str(), LoroMap::new()).map_err(engine)?;
            map.insert(TYPE_KEY, ty).map_err(engine)?;
            for (name, value) in fields {
                map.insert(&name, to_loro(value)).map_err(engine)?;
            }
            for (name, field) in &schema.type_def(ty)?.fields {
                match field.kind {
                    FieldKind::Text => map.insert_container(name, LoroText::new()).map(drop),
                    FieldKind::List => map.insert_container(name, LoroMovableList::new()).map(drop),
                    FieldKind::Tree => map.insert_container(name, LoroTree::new()).map(drop),
                    FieldKind::Map => map.insert_container(name, LoroMap::new()).map(drop),
                    _ => Ok(()),
                }
                .map_err(engine)?;
            }
        }
        Op::Set { id, field, value } => read::object_map(doc, &id)?.insert(field, to_loro(value)).map_err(engine)?,
        Op::Delete { id } => doc.get_map(OBJECTS).delete(id.as_str()).map_err(engine)?,
        Op::TextInsert { id, field, index, content } => insert_in_pieces(&text(doc, &id, field)?, index, &content)?,
        Op::TextDelete { id, field, index, count } => text(doc, &id, field)?.delete(index, count).map_err(engine)?,
        Op::TextMark { id, field, start, end, key, value } => text(doc, &id, field)?.mark(start..end, key, to_loro(value)).map_err(engine)?,
        Op::TextUnmark { id, field, start, end, key } => text(doc, &id, field)?.unmark(start..end, key).map_err(engine)?,
        Op::ListInsert { id, field, index, item } => list(doc, &id, field)?.insert(index, item.as_str()).map_err(engine)?,
        Op::ListMove { id, field, from, to } => list(doc, &id, field)?.mov(from, to).map_err(engine)?,
        Op::ListRemove { id, field, index } => list(doc, &id, field)?.delete(index, 1).map_err(engine)?,
        Op::MapSet { id, field, key, value } => map(doc, &id, field)?.insert(&key, to_loro(value)).map_err(engine)?,
        Op::MapDelete { id, field, key } => map(doc, &id, field)?.delete(&key).map_err(engine)?,
        Op::TreeCreate { id, field, parent, object, node } => {
            let tree = tree(doc, &id, field)?;
            let parent = parent_id(nodes, parent)?;
            let created = tree.create(parent).map_err(engine)?;
            tree.get_meta(created).map_err(engine)?.insert(NODE_OBJECT, object.as_str()).map_err(engine)?;
            match nodes.get_mut(node) {
                Some(slot) => *slot = Some(created),
                None => return Err(KdmError::Engine(format!("tree node {node} was not staged"))),
            }
        }
        Op::TreeMove { id, field, node, parent } => {
            let tree = tree(doc, &id, field)?;
            let parent = parent_id(nodes, parent)?;
            tree.mov(node_id(nodes, node)?, parent).map_err(engine)?;
        }
        Op::TreeDelete { id, field, node } => tree(doc, &id, field)?.delete(node_id(nodes, node)?).map_err(engine)?,
        Op::RaiseSchema { version } => {
            if read::min_schema_version(doc).is_some_and(|current| current >= u64::from(version)) {
                return Ok(());
            }
            let meta = doc.get_map(META);
            // The register is what builds before rule M20 check; the map is what keeps the
            // largest of concurrent raises.
            meta.insert(SCHEMA_VERSION, i64::from(version)).map_err(engine)?;
            doc.get_map(SCHEMA_RAISES).insert(&version.to_string(), true).map_err(engine)?;
        }
    }
    Ok(())
}

/// The most characters one engine text element is given by an insert.
///
/// The engine keeps a text as elements of inserted runs, and editing inside an element that holds
/// non-ASCII text scans it from its start (loro 1.16.2 `TextChunk::delete_by_entity_index` and
/// `Sliceable::_slice`), so an edit costs the length of its element, not of the edit. A file
/// imported in one insert would make every later edit cost the whole file. Inserting longer
/// content in pieces, last piece first, keeps each piece its own element: a piece placed before
/// the one inserted just before it is never merged with it, in the replica or in its snapshots.
/// The text and every replica's result are the same; the history holds one insert per piece.
pub(crate) const TEXT_PIECE: usize = 1024;

/// Inserts `content` at `index` (Unicode scalar values) in pieces of at most [`TEXT_PIECE`]
/// characters, last piece first.
fn insert_in_pieces(text: &LoroText, index: usize, content: &str) -> Result<()> {
    let mut end = content.len();
    let starts: Vec<usize> = content.char_indices().step_by(TEXT_PIECE).map(|(at, _)| at).collect();
    for &start in starts.iter().rev() {
        text.insert(index, &content[start..end]).map_err(engine)?;
        end = start;
    }
    if starts.is_empty() {
        text.insert(index, content).map_err(engine)?;
    }
    Ok(())
}

fn node_id(nodes: &[Option<TreeID>], key: NodeKey) -> Result<TreeID> {
    match key {
        NodeKey::Committed(id) => Ok(id),
        NodeKey::Pending(index) => nodes.get(index).copied().flatten().ok_or_else(|| KdmError::Engine(format!("tree node {index} is used before it exists"))),
    }
}

fn parent_id(nodes: &[Option<TreeID>], parent: Option<NodeKey>) -> Result<TreeParentId> {
    Ok(match parent {
        Some(key) => TreeParentId::Node(node_id(nodes, key)?),
        None => TreeParentId::Root,
    })
}

fn text(doc: &LoroDoc, id: &ObjectId, field: &str) -> Result<LoroText> {
    match read::field_container(doc, id, field)? {
        Container::Text(found) => Ok(found),
        _ => Err(read::wrong_container(id, field)),
    }
}

fn list(doc: &LoroDoc, id: &ObjectId, field: &str) -> Result<LoroMovableList> {
    match read::field_container(doc, id, field)? {
        Container::MovableList(found) => Ok(found),
        _ => Err(read::wrong_container(id, field)),
    }
}

fn map(doc: &LoroDoc, id: &ObjectId, field: &str) -> Result<LoroMap> {
    match read::field_container(doc, id, field)? {
        Container::Map(found) => Ok(found),
        _ => Err(read::wrong_container(id, field)),
    }
}

fn tree(doc: &LoroDoc, id: &ObjectId, field: &str) -> Result<LoroTree> {
    match read::field_container(doc, id, field)? {
        Container::Tree(found) => Ok(found),
        _ => Err(read::wrong_container(id, field)),
    }
}
