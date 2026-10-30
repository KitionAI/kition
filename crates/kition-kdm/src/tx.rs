// Copied from kition-sdk crates/kition-kdm/src/tx.rs by scripts/sync-kit-host.mjs; change it there, not here.
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use loro::{Container, LoroDoc, ToJson, ValueOrContainer};
use serde_json::{Map, Value};

use crate::ids::{NodeInner, PendingNode};
use crate::op::{self, Op};
use crate::overlay::{ListEdit, ListState, NodeKey, Overlay, TreeState};
use crate::read;
use crate::value::{canonical, to_loro};
use crate::{FieldDef, FieldKind, KdmError, NodeRef, ObjectId, Result, Schema};

/// The form of an object id a host chooses (generated ids are UUID v7, which also match).
const OBJECT_ID_PATTERN: &str = "[A-Za-z0-9][A-Za-z0-9:_-]{0,127}";

/// Whether `id` matches [`OBJECT_ID_PATTERN`].
fn is_object_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    bytes.next().is_some_and(|first| first.is_ascii_alphanumeric())
        && id.len() <= 128
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
}

/// A value in the canonical form the engine stores and reads it in.
fn stored_form(value: &Value) -> Value {
    canonical(to_loro(value.clone()).to_json_value())
}

/// Distinguishes transactions, so a node handle from one is never taken for another's.
static NEXT_SERIAL: AtomicU64 = AtomicU64::new(1);

/// The operations of one transaction.
///
/// Nothing is written to the document while the transaction runs. Every operation validates
/// against the committed document plus the transaction's own earlier operations, and is buffered;
/// reads on `Tx` see those pending effects. [`crate::Replica::transact`] applies the buffer only
/// if the whole transaction succeeds, so a failed transaction produces no change at all. An
/// operation that fails changes nothing, so a transaction may also recover from it and continue.
pub struct Tx<'a> {
    doc: &'a LoroDoc,
    schema: &'a Schema,
    serial: u64,
    ops: Vec<Op<'a>>,
    overlay: Overlay<'a>,
    nodes: Vec<Arc<PendingNode>>,
    /// The largest schema version this transaction raised the document to.
    raised: Option<u32>,
}

/// A successful transaction's operations, ready to apply.
pub(crate) struct Staged<'a> {
    ops: Vec<Op<'a>>,
    nodes: Vec<Arc<PendingNode>>,
}

impl Staged<'_> {
    pub(crate) fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    /// Whether the transaction raises the document's minimum schema version.
    pub(crate) fn raises_schema(&self) -> bool {
        self.ops.iter().any(|op| matches!(op, Op::RaiseSchema { .. }))
    }

    /// The registers the operations write: `(object, map field, key, value)`, the map field `None`
    /// for an object's own register field, the value `None` for a deleted map key.
    pub(crate) fn register_writes(&self) -> Vec<(ObjectId, Option<String>, String, Option<Value>)> {
        self.ops
            .iter()
            .filter_map(|op| match op {
                Op::Set { id, field, value } => Some((id.clone(), None, (*field).to_owned(), Some(value.clone()))),
                Op::MapSet { id, field, key, value } => Some((id.clone(), Some((*field).to_owned()), key.clone(), Some(value.clone()))),
                Op::MapDelete { id, field, key } => Some((id.clone(), Some((*field).to_owned()), key.clone(), None)),
                _ => None,
            })
            .collect()
    }

    /// Applies the operations without committing, calling `touched` with each changed object.
    /// On success the transaction's node handles resolve.
    pub(crate) fn apply(self, doc: &LoroDoc, schema: &Schema, touched: impl FnMut(&ObjectId)) -> Result<()> {
        let ids = op::apply(doc, schema, self.ops, self.nodes.len(), touched)?;
        for (pending, id) in self.nodes.iter().zip(ids) {
            if let Some(id) = id {
                // Set exactly once: this transaction is the only writer.
                let _ = pending.id.set(id);
            }
        }
        Ok(())
    }
}

impl<'a> Tx<'a> {
    pub(crate) fn new(doc: &'a LoroDoc, schema: &'a Schema) -> Self {
        Self { doc, schema, serial: NEXT_SERIAL.fetch_add(1, Ordering::Relaxed), ops: Vec::new(), overlay: Overlay::default(), nodes: Vec::new(), raised: None }
    }

    pub(crate) fn finish(self) -> Staged<'a> {
        Staged { ops: self.ops, nodes: self.nodes }
    }

    /// Raises the document's minimum schema version to `version` (rule M20): replicas whose
    /// schema is older then refuse to load the document or import its changes
    /// ([`KdmError::NewerSchema`]). A migration raises the version in the transaction that rewrites
    /// the document into the new form. Answers whether the version rose: raising to a version the
    /// document already has, or a lower one, changes nothing. Concurrent raises keep the largest.
    ///
    /// Only a `system` transaction raises the version, so it is never an undo step
    /// ([`crate::Replica::transact`] refuses others with [`KdmError::InvalidValue`]). `version` is
    /// at most the transaction's schema version: a build cannot require a schema it does not read.
    pub fn raise_schema_version(&mut self, version: u32) -> Result<bool> {
        if version > self.schema.schema_version {
            return Err(KdmError::InvalidValue {
                ty: "$meta".into(),
                field: "schemaVersion".into(),
                reason: format!("cannot be raised to {version}: this kit reads schema versions up to {}", self.schema.schema_version),
            });
        }
        if u64::from(version) <= self.min_schema_version() {
            return Ok(false);
        }
        self.raised = Some(version);
        self.ops.push(Op::RaiseSchema { version });
        Ok(true)
    }

    /// The document's minimum schema version (rule M20), including this transaction's raises.
    pub fn min_schema_version(&self) -> u64 {
        read::min_schema_version(self.doc).unwrap_or(0).max(self.raised.map_or(0, u64::from))
    }

    /// Creates an object of type `ty` with its register fields; container fields start empty.
    /// Its id is a new UUID v7.
    pub fn create(&mut self, ty: &str, fields: Map<String, Value>) -> Result<ObjectId> {
        self.create_as(ty, None, fields)
    }

    /// [`Tx::create`] under an id the host chose. The id matches
    /// `[A-Za-z0-9][A-Za-z0-9:_-]{0,127}` and names no object of the document or of this
    /// transaction (one it deleted included); otherwise [`KdmError::InvalidValue`]. Replicas that
    /// create one id concurrently keep one of the objects.
    pub fn create_with_id(&mut self, ty: &str, id: &ObjectId, fields: Map<String, Value>) -> Result<ObjectId> {
        self.create_as(ty, Some(id), fields)
    }

    fn create_as(&mut self, ty: &str, chosen: Option<&ObjectId>, fields: Map<String, Value>) -> Result<ObjectId> {
        let schema: &'a Schema = self.schema;
        let (ty, def) = schema.types.get_key_value(ty).ok_or_else(|| KdmError::UnknownType(ty.to_owned()))?;
        for (name, value) in &fields {
            schema.check_value(ty, name, value)?;
            if let (Some(field), Some(target)) = (def.fields.get(name), value.as_str()) {
                self.check_of(ty, name, field, &ObjectId::from_string(target))?;
            }
        }
        for (name, field) in &def.fields {
            if !field.kind.is_container() && !field.optional && !fields.contains_key(name) {
                return Err(KdmError::InvalidValue { ty: ty.clone(), field: name.clone(), reason: "is required".into() });
            }
        }
        let id = match chosen {
            None => ObjectId::new(),
            Some(id) => self.free_id(ty, id)?,
        };
        self.overlay.created.insert(id.clone(), (ty.as_str(), self.ops.len()));
        self.overlay.created_by_type.entry(ty.as_str()).or_default().push(id.clone());
        self.ops.push(Op::Create { id: id.clone(), ty, fields });
        Ok(id)
    }

    /// Sets one register field. Concurrent sets of the same field resolve to one winner;
    /// sets of different fields of one object both survive.
    pub fn set(&mut self, id: &ObjectId, field: &str, value: Value) -> Result<()> {
        let (ty, name, def) = self.field(id, field)?;
        self.schema.check_value(ty, field, &value)?;
        if let Some(target) = value.as_str() {
            self.check_of(ty, name, def, &ObjectId::from_string(target))?;
        }
        self.overlay.registers.insert((id.clone(), name), self.ops.len());
        self.ops.push(Op::Set { id: id.clone(), field: name, value });
        Ok(())
    }

    /// Deletes an object. References to it dangle; kits treat that as a validation state.
    pub fn delete(&mut self, id: &ObjectId) -> Result<()> {
        if !self.exists(id) {
            return Err(KdmError::NotFound(id.to_string()));
        }
        self.overlay.deleted.insert(id.clone());
        self.ops.push(Op::Delete { id: id.clone() });
        Ok(())
    }

    pub fn exists(&self, id: &ObjectId) -> bool {
        self.overlay.exists(id, || read::object_map(self.doc, id).is_ok())
    }

    /// The type of a live object, including one this transaction created; [`KdmError::NotFound`]
    /// for an object it deleted or that does not exist.
    pub fn object_type(&self, id: &ObjectId) -> Result<String> {
        self.type_of(id).map(str::to_owned)
    }

    pub fn get(&self, id: &ObjectId, field: &str) -> Result<Value> {
        let (ty, name, def) = self.field(id, field)?;
        if def.kind.is_container() {
            return Err(KdmError::InvalidValue { ty: ty.to_owned(), field: name.to_owned(), reason: "is a container; read it with its accessor".into() });
        }
        match self.pending_register(id, name) {
            Some(value) => Ok(value),
            None => read::register(self.doc, self.schema, id, field),
        }
    }

    /// Inserts `content` at `index`, counted in Unicode scalar values.
    pub fn text_insert(&mut self, id: &ObjectId, field: &str, index: usize, content: &str) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::Text)?;
        let len = self.text_length(id, name, true)?;
        if index > len {
            return Err(KdmError::OutOfRange { index, len });
        }
        self.overlay.texts.insert((id.clone(), name), len.saturating_add(content.chars().count()));
        self.ops.push(Op::TextInsert { id: id.clone(), field: name, index, content: content.to_owned() });
        Ok(())
    }

    /// The length of a text field in Unicode scalar values.
    pub fn text_len(&self, id: &ObjectId, field: &str) -> Result<usize> {
        let name = self.container_field(id, field, FieldKind::Text)?;
        self.text_length(id, name, false)
    }

    /// Deletes `count` Unicode scalar values starting at `index`.
    pub fn text_delete(&mut self, id: &ObjectId, field: &str, index: usize, count: usize) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::Text)?;
        let len = self.text_length(id, name, true)?;
        let end = index.checked_add(count).ok_or(KdmError::OutOfRange { index, len })?;
        if end > len {
            return Err(KdmError::OutOfRange { index: end, len });
        }
        self.overlay.texts.insert((id.clone(), name), len - count);
        self.ops.push(Op::TextDelete { id: id.clone(), field: name, index, count });
        Ok(())
    }

    /// Sets mark `key` to `value` over the characters `start..end` (Unicode scalar values) of a
    /// text field (rule M19). The field declares `key` in its schema `marks`; `value` is plain
    /// JSON and not `null` (remove a mark with [`Tx::text_unmark`]). An empty range changes
    /// nothing. Concurrent marks of one key over overlapping ranges resolve to one value per
    /// character; marks of different keys all apply.
    pub fn text_mark(&mut self, id: &ObjectId, field: &str, start: usize, end: usize, key: &str, value: Value) -> Result<()> {
        let (name, key) = self.mark_key(id, field, key)?;
        if value.is_null() {
            let (ty, _, _) = self.field(id, field)?;
            return Err(KdmError::InvalidValue {
                ty: ty.to_owned(),
                field: name.to_owned(),
                reason: format!("mark `{key}` takes a value; remove a mark with text_unmark"),
            });
        }
        if let Some(reason) = crate::schema::unportable(&value) {
            let (ty, _, _) = self.field(id, field)?;
            return Err(KdmError::InvalidValue { ty: ty.to_owned(), field: name.to_owned(), reason: format!("mark `{key}` {reason}") });
        }
        if !self.mark_range(id, name, start, end)? {
            return Ok(());
        }
        self.ops.push(Op::TextMark { id: id.clone(), field: name, start, end, key, value });
        Ok(())
    }

    /// Removes mark `key` from the characters `start..end` of a text field. Characters without
    /// the mark are left as they are; an empty range changes nothing.
    pub fn text_unmark(&mut self, id: &ObjectId, field: &str, start: usize, end: usize, key: &str) -> Result<()> {
        let (name, key) = self.mark_key(id, field, key)?;
        if !self.mark_range(id, name, start, end)? {
            return Ok(());
        }
        self.ops.push(Op::TextUnmark { id: id.clone(), field: name, start, end, key });
        Ok(())
    }

    pub fn list_insert(&mut self, id: &ObjectId, field: &str, index: usize, item: &ObjectId) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::List)?;
        self.check_item(id, name, item)?;
        let list = self.list_mut(id, name)?;
        if index > list.len {
            return Err(KdmError::OutOfRange { index, len: list.len });
        }
        list.len += 1;
        list.edits.push(ListEdit::Insert(index, item.clone()));
        self.ops.push(Op::ListInsert { id: id.clone(), field: name, index, item: item.clone() });
        Ok(())
    }

    pub fn list_move(&mut self, id: &ObjectId, field: &str, from: usize, to: usize) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::List)?;
        let list = self.list_mut(id, name)?;
        if from >= list.len || to >= list.len {
            return Err(KdmError::OutOfRange { index: from.max(to), len: list.len });
        }
        list.edits.push(ListEdit::Move(from, to));
        self.ops.push(Op::ListMove { id: id.clone(), field: name, from, to });
        Ok(())
    }

    pub fn list_remove(&mut self, id: &ObjectId, field: &str, index: usize) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::List)?;
        let list = self.list_mut(id, name)?;
        if index >= list.len {
            return Err(KdmError::OutOfRange { index, len: list.len });
        }
        list.len -= 1;
        list.edits.push(ListEdit::Remove(index));
        self.ops.push(Op::ListRemove { id: id.clone(), field: name, index });
        Ok(())
    }

    /// The list's items including this transaction's edits. Reads the whole list: validation
    /// never needs it, so call it only when the items themselves are wanted.
    pub fn list_items(&self, id: &ObjectId, field: &str) -> Result<Vec<ObjectId>> {
        let name = self.container_field(id, field, FieldKind::List)?;
        let mut items = match self.stored(id, name, false)? {
            None => Vec::new(),
            Some(Container::MovableList(list)) => read::list_items(&list)?,
            Some(_) => return Err(read::wrong_container(id, name)),
        };
        if let Some(list) = self.overlay.lists.get(&(id.clone(), name)) {
            list.replay(&mut items)?;
        }
        Ok(items)
    }

    /// Sets `key` of a map field. Concurrent sets of one key resolve to one winner.
    /// Values hold no integer beyond ±2^53 and no `__proto__` key, at any depth
    /// ([`KdmError::InvalidValue`]).
    pub fn map_set(&mut self, id: &ObjectId, field: &str, key: &str, value: Value) -> Result<()> {
        let name = self.writable_map(id, field)?;
        if let Some(reason) = crate::schema::unportable(&value) {
            let (ty, _, _) = self.field(id, field)?;
            return Err(KdmError::InvalidValue { ty: ty.to_owned(), field: name.to_owned(), reason: reason.into() });
        }
        self.overlay.maps.entry((id.clone(), name)).or_default().insert(key.to_owned(), Some(self.ops.len()));
        self.ops.push(Op::MapSet { id: id.clone(), field: name, key: key.to_owned(), value });
        Ok(())
    }

    pub fn map_delete(&mut self, id: &ObjectId, field: &str, key: &str) -> Result<()> {
        let name = self.writable_map(id, field)?;
        self.overlay.maps.entry((id.clone(), name)).or_default().insert(key.to_owned(), None);
        self.ops.push(Op::MapDelete { id: id.clone(), field: name, key: key.to_owned() });
        Ok(())
    }

    /// One key of a map field including this transaction's writes, or `null`, as
    /// [`crate::Replica::map_get`] reads it. Costs one lookup in the transaction's writes of the
    /// field and at most one in the document, however large the transaction.
    pub fn map_get(&self, id: &ObjectId, field: &str, key: &str) -> Result<Value> {
        let name = self.container_field(id, field, FieldKind::Map)?;
        if let Some(write) = self.overlay.maps.get(&(id.clone(), name)).and_then(|keys| keys.get(key)) {
            return Ok(write.map_or(Value::Null, |index| self.pending_map_value(index)));
        }
        Ok(match self.stored(id, name, false)? {
            None => Value::Null,
            Some(Container::Map(map)) => read::map_value(&map, key),
            Some(_) => return Err(read::wrong_container(id, name)),
        })
    }

    /// A map field's keys and values including this transaction's writes, sorted by key (code
    /// point order, as in the canonical state), each as [`Tx::map_get`] reads it. Reads the whole
    /// map and sorts the result on every call, O(n log n) in its keys: call it only when every
    /// entry is wanted.
    pub fn map_entries(&self, id: &ObjectId, field: &str) -> Result<Vec<(String, Value)>> {
        let name = self.container_field(id, field, FieldKind::Map)?;
        let committed = match self.stored(id, name, false)? {
            None => Vec::new(),
            Some(Container::Map(map)) => read::map_entries(&map),
            Some(_) => return Err(read::wrong_container(id, name)),
        };
        let Some(writes) = self.overlay.maps.get(&(id.clone(), name)) else { return Ok(committed) };
        let mut entries: BTreeMap<String, Value> = committed.into_iter().collect();
        for (key, write) in writes {
            match write {
                Some(index) => entries.insert(key.clone(), self.pending_map_value(*index)),
                None => entries.remove(key),
            };
        }
        Ok(entries.into_iter().collect())
    }

    /// Ids of the live objects of type `ty`, including those this transaction created and without
    /// those it deleted, sorted as [`crate::Replica::objects_of_type`] sorts them. One pass over
    /// every object of the document, O(objects) per call, plus this transaction's creations of `ty`;
    /// when it created any, the whole result is sorted again, O(n log n) per call.
    pub fn objects_of_type(&self, ty: &str) -> Vec<ObjectId> {
        let deleted = &self.overlay.deleted;
        let mut ids = read::objects_of_type(self.doc, ty);
        if !deleted.is_empty() {
            ids.retain(|id| !deleted.contains(id));
        }
        if let Some(created) = self.overlay.created_by_type.get(ty) {
            ids.extend(created.iter().filter(|id| !deleted.contains(*id)).cloned());
            ids.sort();
        }
        ids
    }

    /// Adds a node naming `object` under `parent` (`None`: a root), last among its siblings.
    /// The returned handle resolves when the transaction commits.
    pub fn tree_create(&mut self, id: &ObjectId, field: &str, parent: Option<&NodeRef>, object: &ObjectId) -> Result<NodeRef> {
        let name = self.container_field(id, field, FieldKind::Tree)?;
        self.check_item(id, name, object)?;
        let parent = parent.map(|parent| self.node_key(parent)).transpose()?;
        let index = self.nodes.len();
        let tree = self.tree_mut(id, name)?;
        if parent.is_some_and(|parent| !tree.contains(parent)) {
            return Err(KdmError::NotFound(format!("parent node in {id}.{name}")));
        }
        tree.parents.insert(NodeKey::Pending(index), parent);
        let pending = Arc::new(PendingNode { tx: self.serial, index, id: OnceLock::new() });
        self.nodes.push(Arc::clone(&pending));
        self.ops.push(Op::TreeCreate { id: id.clone(), field: name, parent, object: object.clone(), node: index });
        Ok(NodeRef(NodeInner::Pending(pending)))
    }

    /// Moves `node` under `parent`. A move that would make a node its own ancestor (counting this
    /// transaction's earlier moves) fails with [`KdmError::Cycle`]; concurrent moves that would
    /// form a cycle are resolved by the engine.
    pub fn tree_move(&mut self, id: &ObjectId, field: &str, node: &NodeRef, parent: Option<&NodeRef>) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::Tree)?;
        let node = self.node_key(node)?;
        let parent = parent.map(|parent| self.node_key(parent)).transpose()?;
        let tree = self.tree_mut(id, name)?;
        if !tree.contains(node) || parent.is_some_and(|parent| !tree.contains(parent)) {
            return Err(KdmError::NotFound(format!("node in {id}.{name}")));
        }
        if parent.is_some_and(|parent| tree.would_cycle(node, parent)) {
            return Err(KdmError::Cycle);
        }
        tree.parents.insert(node, parent);
        self.ops.push(Op::TreeMove { id: id.clone(), field: name, node, parent });
        Ok(())
    }

    /// Rule M10b: leaves every object of the tree named by one node. For each object that several
    /// of the document's nodes name (a redo made a new node for it while another replica's
    /// concurrent move kept the old one alive), the node kept is the least by engine id (peer,
    /// then counter) among those with no ancestor naming the same object; every other node naming
    /// it has its children moved, in order, to the end of the kept node's children, and is then
    /// deleted. The choice depends on the state alone, so replicas that repair one state
    /// concurrently make the same moves and deletes. Nodes this transaction created are not
    /// considered. Answers how many nodes it deleted; 0 writes nothing. Run it in a kit's repair
    /// (engine contract E14, a `system` transaction) for every tree field.
    pub fn tree_dedupe(&mut self, id: &ObjectId, field: &str) -> Result<usize> {
        let name = self.container_field(id, field, FieldKind::Tree)?;
        let mut deleted = 0;
        // One node at a time, each chosen on the tree as the earlier ones left it, so a move never
        // forms a cycle: the kept node has no ancestor naming its object, so it is never under the
        // node that goes, nor under one of that node's children.
        while let Some((keep, other)) = self.tree_duplicate(id, name)? {
            let (kept, node) = (NodeRef::committed(keep), NodeRef::committed(other));
            let children: Vec<NodeRef> =
                self.tree(id, name)?.into_iter().filter(|entry| entry.parent.as_ref() == Some(&node)).map(|entry| entry.node).collect();
            for child in &children {
                self.tree_move(id, name, child, Some(&kept))?;
            }
            // Children that name no object (only a document written outside the KDM has them) go
            // with the node.
            let key = NodeKey::Committed(other);
            let tree = self.tree_mut(id, name)?;
            tree.parents.remove(&key);
            tree.deleted.insert(key);
            self.ops.push(Op::TreeDelete { id: id.clone(), field: name, node: key });
            deleted += 1;
        }
        Ok(deleted)
    }

    /// The first object in pre-order that several of the document's nodes name (M10b): the node
    /// to keep and the first other one in pre-order.
    fn tree_duplicate(&self, id: &ObjectId, name: &str) -> Result<Option<(loro::TreeID, loro::TreeID)>> {
        let entries = self.tree(id, name)?;
        let mut by_object: HashMap<&ObjectId, Vec<loro::TreeID>> = HashMap::new();
        let mut parent_of: HashMap<loro::TreeID, Option<loro::TreeID>> = HashMap::new();
        let mut first: Option<&ObjectId> = None;
        for entry in &entries {
            let Some(node) = entry.node.resolved() else { continue };
            parent_of.insert(node, entry.parent.as_ref().and_then(NodeRef::resolved));
            let nodes = by_object.entry(&entry.object).or_default();
            nodes.push(node);
            if nodes.len() == 2 && first.is_none() {
                first = Some(&entry.object);
            }
        }
        let Some(nodes) = first.and_then(|object| by_object.get(object)) else { return Ok(None) };
        let outermost = |node: loro::TreeID| {
            let mut at = parent_of.get(&node).copied().flatten();
            while let Some(parent) = at {
                if nodes.contains(&parent) {
                    return false;
                }
                at = parent_of.get(&parent).copied().flatten();
            }
            true
        };
        let Some(keep) = nodes.iter().copied().filter(|node| outermost(*node)).min() else { return Ok(None) };
        Ok(nodes.iter().copied().find(|node| *node != keep).map(|other| (keep, other)))
    }

    /// The tree's nodes in pre-order as this transaction sees it: the document's nodes plus the
    /// nodes it created, each node it created or moved last among its new siblings, as they will
    /// be once it applies. A node that names no object is skipped with its subtree, as in
    /// [`crate::Replica::tree`]. Reads the whole tree: O(nodes + this transaction's operations).
    pub fn tree(&self, id: &ObjectId, field: &str) -> Result<Vec<crate::TreeEntry>> {
        let name = self.container_field(id, field, FieldKind::Tree)?;
        let committed = match self.stored(id, name, false)? {
            None => None,
            Some(Container::Tree(tree)) => Some(tree),
            Some(_) => return Err(read::wrong_container(id, name)),
        };
        let mut children: HashMap<Option<NodeKey>, Vec<NodeKey>> = HashMap::new();
        let mut parent_of: HashMap<NodeKey, Option<NodeKey>> = HashMap::new();
        let mut objects: HashMap<NodeKey, Option<ObjectId>> = HashMap::new();
        if let Some(tree) = &committed {
            let mut stack = vec![(loro::TreeParentId::Root, None)];
            while let Some((parent, key)) = stack.pop() {
                for node in tree.children(parent).unwrap_or_default() {
                    let child = NodeKey::Committed(node);
                    children.entry(key).or_default().push(child);
                    parent_of.insert(child, key);
                    objects.insert(child, read::node_object(tree, node));
                    stack.push((loro::TreeParentId::Node(node), Some(child)));
                }
            }
        }
        for op in &self.ops {
            match op {
                Op::TreeCreate { id: owner, field: of, parent, object, node } if owner == id && *of == name => {
                    let child = NodeKey::Pending(*node);
                    children.entry(*parent).or_default().push(child);
                    parent_of.insert(child, *parent);
                    objects.insert(child, Some(object.clone()));
                }
                Op::TreeMove { id: owner, field: of, node, parent } if owner == id && *of == name => {
                    if let Some(old) = parent_of.insert(*node, *parent) {
                        children.entry(old).or_default().retain(|child| child != node);
                    }
                    children.entry(*parent).or_default().push(*node);
                }
                Op::TreeDelete { id: owner, field: of, node } if owner == id && *of == name => {
                    if let Some(old) = parent_of.remove(node) {
                        children.entry(old).or_default().retain(|child| child != node);
                    }
                }
                _ => {}
            }
        }
        let handle = |key: NodeKey| -> Result<NodeRef> {
            match key {
                NodeKey::Committed(node) => Ok(NodeRef::committed(node)),
                NodeKey::Pending(index) => self
                    .nodes
                    .get(index)
                    .map(|pending| NodeRef(NodeInner::Pending(Arc::clone(pending))))
                    .ok_or_else(|| KdmError::Engine(format!("tree node {index} was not staged"))),
            }
        };
        let mut out = Vec::new();
        let mut stack: Vec<(NodeKey, Option<NodeRef>)> = children.get(&None).into_iter().flatten().rev().map(|key| (*key, None)).collect();
        while let Some((key, parent)) = stack.pop() {
            let Some(Some(object)) = objects.get(&key) else { continue };
            let node = handle(key)?;
            out.push(crate::TreeEntry { node: node.clone(), object: object.clone(), parent });
            stack.extend(children.get(&Some(key)).into_iter().flatten().rev().map(|child| (*child, Some(node.clone()))));
        }
        Ok(out)
    }

    /// Checks an id the host chose for a new object of type `ty`.
    fn free_id(&self, ty: &str, id: &ObjectId) -> Result<ObjectId> {
        let invalid = |reason: String| KdmError::InvalidValue { ty: ty.to_owned(), field: "$id".into(), reason };
        if !is_object_id(id.as_str()) {
            return Err(invalid(format!("cannot be `{id}`: an object id matches `{OBJECT_ID_PATTERN}`")));
        }
        if self.overlay.is_created(id) || self.overlay.deleted.contains(id) || self.doc.get_map(read::OBJECTS).get(id.as_str()).is_some() {
            return Err(invalid(format!("cannot be `{id}`: that object id is taken")));
        }
        Ok(id.clone())
    }

    /// The type of a live object, as the schema's own string.
    fn type_of(&self, id: &ObjectId) -> Result<&'a str> {
        if self.overlay.deleted.contains(id) {
            return Err(KdmError::NotFound(id.to_string()));
        }
        if let Some((ty, _)) = self.overlay.created.get(id) {
            return Ok(ty);
        }
        let ty = read::object_type(self.doc, id)?;
        let schema: &'a Schema = self.schema;
        schema.types.get_key_value(ty.as_str()).map(|(name, _)| name.as_str()).ok_or(KdmError::UnknownType(ty))
    }

    /// The object's type, and the schema's name and definition of `field`.
    fn field(&self, id: &ObjectId, field: &str) -> Result<(&'a str, &'a str, &'a FieldDef)> {
        let ty = self.type_of(id)?;
        let schema: &'a Schema = self.schema;
        let (name, def) = schema.type_def(ty)?.fields.get_key_value(field).ok_or_else(|| schema.unknown_field(ty, field))?;
        Ok((ty, name.as_str(), def))
    }

    /// Refuses a target that exists but is not of the field's `of` type. A missing target is
    /// accepted: a dangling reference is a validation state, not an error.
    fn check_of(&self, ty: &str, name: &str, def: &FieldDef, target: &ObjectId) -> Result<()> {
        let Some(of) = &def.of else { return Ok(()) };
        let found = if self.overlay.deleted.contains(target) {
            None
        } else if let Some((found, _)) = self.overlay.created.get(target) {
            Some((*found).to_owned())
        } else {
            read::object_type(self.doc, target).ok()
        };
        match found {
            Some(found) if found != *of => Err(KdmError::InvalidValue {
                ty: ty.to_owned(),
                field: name.to_owned(),
                reason: format!("expects an object of type `{of}`, and `{target}` is a `{found}`"),
            }),
            _ => Ok(()),
        }
    }

    /// [`Tx::check_of`] for an item of a list or tree field.
    fn check_item(&self, id: &ObjectId, name: &str, item: &ObjectId) -> Result<()> {
        let (ty, name, def) = self.field(id, name)?;
        self.check_of(ty, name, def, item)
    }

    fn container_field(&self, id: &ObjectId, field: &str, kind: FieldKind) -> Result<&'a str> {
        let (ty, name, def) = self.field(id, field)?;
        if def.kind != kind {
            return Err(read::wrong_kind(ty, field, kind));
        }
        Ok(name)
    }

    /// The document's container for a field, or `None` when it starts empty: the object was
    /// created by this transaction, or (for reads) it predates the field. Writes to a field the
    /// stored object lacks fail with [`KdmError::NotFound`].
    fn stored(&self, id: &ObjectId, name: &str, write: bool) -> Result<Option<Container>> {
        if self.overlay.is_created(id) {
            return Ok(None);
        }
        match read::object_map(self.doc, id)?.get(name) {
            Some(ValueOrContainer::Container(found)) => Ok(Some(found)),
            Some(ValueOrContainer::Value(_)) => Err(read::wrong_container(id, name)),
            None if write => Err(KdmError::NotFound(format!("{id}.{name}"))),
            None => Ok(None),
        }
    }

    /// The value of the `MapSet` operation at `index`, as the engine will store it.
    fn pending_map_value(&self, index: usize) -> Value {
        match self.ops.get(index) {
            Some(Op::MapSet { value, .. }) => stored_form(value),
            _ => Value::Null,
        }
    }

    fn pending_register(&self, id: &ObjectId, name: &str) -> Option<Value> {
        if let Some(Op::Set { value, .. }) = self.overlay.registers.get(&(id.clone(), name)).and_then(|index| self.ops.get(*index)) {
            return Some(stored_form(value));
        }
        let (_, index) = self.overlay.created.get(id)?;
        match self.ops.get(*index) {
            Some(Op::Create { fields, .. }) => Some(fields.get(name).map_or(Value::Null, stored_form)),
            _ => None,
        }
    }

    fn text_length(&self, id: &ObjectId, name: &'a str, write: bool) -> Result<usize> {
        if let Some(len) = self.overlay.texts.get(&(id.clone(), name)) {
            return Ok(*len);
        }
        match self.stored(id, name, write)? {
            None => Ok(0),
            Some(Container::Text(text)) => Ok(text.len_unicode()),
            Some(_) => Err(read::wrong_container(id, name)),
        }
    }

    /// The schema's names of a text field and of one of its declared mark keys.
    fn mark_key(&self, id: &ObjectId, field: &str, key: &str) -> Result<(&'a str, &'a str)> {
        let (ty, name, def) = self.field(id, field)?;
        if def.kind != FieldKind::Text {
            return Err(read::wrong_kind(ty, field, FieldKind::Text));
        }
        match def.marks.get_key_value(key) {
            Some((key, _)) => Ok((name, key.as_str())),
            None => Err(KdmError::InvalidValue { ty: ty.to_owned(), field: name.to_owned(), reason: format!("declares no mark `{key}`") }),
        }
    }

    /// Checks a mark's range against the text's length including this transaction's edits;
    /// answers whether the range holds any character.
    fn mark_range(&self, id: &ObjectId, name: &'a str, start: usize, end: usize) -> Result<bool> {
        let len = self.text_length(id, name, true)?;
        if end > len {
            return Err(KdmError::OutOfRange { index: end, len });
        }
        if start > end {
            return Err(KdmError::OutOfRange { index: start, len: end });
        }
        Ok(start < end)
    }

    fn list_mut(&mut self, id: &ObjectId, name: &'a str) -> Result<&mut ListState> {
        let key = (id.clone(), name);
        if !self.overlay.lists.contains_key(&key) {
            let len = match self.stored(id, name, true)? {
                None => 0,
                Some(Container::MovableList(list)) => list.len(),
                Some(_) => return Err(read::wrong_container(id, name)),
            };
            self.overlay.lists.insert(key.clone(), ListState::new(len));
        }
        self.overlay.lists.get_mut(&key).ok_or_else(|| KdmError::Engine(format!("{id}.{name} was not staged")))
    }

    fn writable_map(&self, id: &ObjectId, field: &str) -> Result<&'a str> {
        let name = self.container_field(id, field, FieldKind::Map)?;
        match self.stored(id, name, true)? {
            None | Some(Container::Map(_)) => Ok(name),
            Some(_) => Err(read::wrong_container(id, name)),
        }
    }

    fn tree_mut(&mut self, id: &ObjectId, name: &'a str) -> Result<&mut TreeState> {
        let key = (id.clone(), name);
        if !self.overlay.trees.contains_key(&key) {
            let committed = match self.stored(id, name, true)? {
                None => None,
                Some(Container::Tree(tree)) => Some(tree),
                Some(_) => return Err(read::wrong_container(id, name)),
            };
            self.overlay.trees.insert(key.clone(), TreeState::new(committed));
        }
        self.overlay.trees.get_mut(&key).ok_or_else(|| KdmError::Engine(format!("{id}.{name} was not staged")))
    }

    /// A handle as this transaction sees it. A handle created by another transaction that never
    /// applied (it failed) names no node.
    fn node_key(&self, node: &NodeRef) -> Result<NodeKey> {
        if let Some(id) = node.resolved() {
            return Ok(NodeKey::Committed(id));
        }
        match &node.0 {
            NodeInner::Pending(pending) if pending.tx == self.serial => Ok(NodeKey::Pending(pending.index)),
            _ => Err(KdmError::NotFound("a tree node from a transaction that did not commit".into())),
        }
    }
}
