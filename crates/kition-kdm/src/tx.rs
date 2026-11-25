// Copied from kition-sdk crates/kition-kdm/src/tx.rs by scripts/sync-kit-host.mjs; change it there, not here.
use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value};

use crate::overlay::{ListEdit, ListState, Overlay, TreeState};
use crate::read;
use crate::store::op::{Name, Op};
use crate::store::{Field, Object, Store};
use crate::value::canonical;
use crate::{FieldDef, FieldKind, KdmError, NodeRef, ObjectId, Result, Schema};

/// The form of an object id a host chooses (generated ids are UUID v7, which also match).
const OBJECT_ID_PATTERN: &str = "[A-Za-z0-9][A-Za-z0-9:_-]{0,127}";

/// The deepest nesting of arrays and objects in a value a transaction writes (a register, a map
/// entry, a mark value). Changes and content nest at most [`crate::content::MAX_DEPTH`] (127)
/// levels (data model 7.4, C14), and a change carries a value at most 9 levels in: the change
/// list, `changes`, a change, `ops`, an operation, a deleted object (`was`), a text field's runs,
/// a run, its `attributes`, with the mark value on the 10th level. So 127 - 9 = 118.
const VALUE_DEPTH: usize = crate::content::MAX_DEPTH - 9;

/// The refusal of a value nested deeper than [`VALUE_DEPTH`], checked without recursion (before
/// anything that walks the value recursively).
pub(crate) fn nesting_refusal(ty: &str, field: &str, value: &Value) -> Result<()> {
    let mut open = vec![(value, 1_usize)];
    while let Some((value, depth)) = open.pop() {
        match value {
            Value::Array(items) if depth <= VALUE_DEPTH => open.extend(items.iter().map(|item| (item, depth + 1))),
            Value::Object(entries) if depth <= VALUE_DEPTH => open.extend(entries.values().map(|item| (item, depth + 1))),
            Value::Array(_) | Value::Object(_) => {
                return Err(KdmError::InvalidValue {
                    ty: ty.to_owned(),
                    field: field.to_owned(),
                    reason: format!("nests arrays and objects deeper than {VALUE_DEPTH} levels, more than a change or a file holds"),
                });
            }
            _ => {}
        }
    }
    Ok(())
}

/// Whether `id` matches [`OBJECT_ID_PATTERN`].
fn is_object_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    bytes.next().is_some_and(|first| first.is_ascii_alphanumeric())
        && id.len() <= 128
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
}

/// The operations of one transaction.
///
/// Nothing is written to the document while the transaction runs. Every operation validates
/// against the committed document plus the transaction's own earlier operations, and is buffered;
/// reads on `Tx` see those pending effects. [`crate::Replica::transact`] applies the buffer only
/// if the whole transaction succeeds, so a failed transaction produces no change at all. An
/// operation that fails changes nothing, so a transaction may also recover from it and continue.
pub struct Tx<'a> {
    store: &'a Store,
    schema: &'a Schema,
    ops: Vec<Op>,
    overlay: Overlay<'a>,
    /// The largest schema version this transaction raised the document to.
    raised: Option<u32>,
    /// The schema's type and field names as the operations hold them, made once each.
    names: HashMap<&'a str, Name>,
}

/// A tree as a transaction sees it: each parent's children in order, and each node's parent.
type TreeView = (HashMap<Option<ObjectId>, Vec<ObjectId>>, HashMap<ObjectId, Option<ObjectId>>);

impl<'a> Tx<'a> {
    pub(crate) fn new(store: &'a Store, schema: &'a Schema) -> Self {
        Self { store, schema, ops: Vec::new(), overlay: Overlay::default(), raised: None, names: HashMap::new() }
    }

    /// The transaction's operations, to apply.
    pub(crate) fn finish(self) -> Vec<Op> {
        self.ops
    }

    fn name(&mut self, name: &'a str) -> Name {
        self.names.entry(name).or_insert_with(|| Name::from(name)).clone()
    }

    /// Raises the document's minimum schema version to `version` (rule M20): replicas whose
    /// schema is older then refuse to load the document or import its changes
    /// ([`KdmError::NewerSchema`]). A migration raises the version in the transaction that rewrites
    /// the document into the new form. Answers whether the version rose: raising to a version the
    /// document already has, or a lower one, changes nothing.
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
        self.ops.push(Op::SchemaVersion { version: u64::from(version), was: 0 });
        Ok(true)
    }

    /// The document's minimum schema version (rule M20), including this transaction's raises.
    pub fn min_schema_version(&self) -> u64 {
        self.store.schema_version.max(self.raised.map_or(0, u64::from))
    }

    /// Creates an object of type `ty` with its register fields; container fields start empty.
    /// Its id is a new UUID v7.
    pub fn create(&mut self, ty: &str, fields: Map<String, Value>) -> Result<ObjectId> {
        self.create_as(ty, None, fields)
    }

    /// [`Tx::create`] under an id the host chose. The id matches
    /// `[A-Za-z0-9][A-Za-z0-9:_-]{0,127}`, is written in lowercase hyphenated form when it reads
    /// as a UUID (data model 7.4, C12), and names no object of the document or of this transaction
    /// (one it deleted included); otherwise [`KdmError::InvalidValue`].
    pub fn create_with_id(&mut self, ty: &str, id: &ObjectId, fields: Map<String, Value>) -> Result<ObjectId> {
        self.create_as(ty, Some(id), fields)
    }

    fn create_as(&mut self, ty: &str, chosen: Option<&ObjectId>, fields: Map<String, Value>) -> Result<ObjectId> {
        let schema: &'a Schema = self.schema;
        let (ty, def) = schema.types.get_key_value(ty).ok_or_else(|| KdmError::UnknownType(ty.to_owned()))?;
        if def.projected {
            return Err(KdmError::InvalidValue {
                ty: ty.clone(),
                field: "$type".into(),
                reason: "projected objects are computed by the kit, never stored".into(),
            });
        }
        for (name, value) in &fields {
            nesting_refusal(ty, name, value)?;
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
        let mut object = Object::new(self.name(ty));
        for (name, value) in fields {
            // `check_value` accepted only declared fields.
            let Some((name, _)) = def.fields.get_key_value(&name) else { continue };
            let name = self.name(name);
            object.put(name, Field::Value(canonical(value)));
        }
        self.overlay.created.insert(id.clone(), (ty.as_str(), self.ops.len()));
        self.overlay.created_by_type.entry(ty.as_str()).or_default().push(id.clone());
        self.ops.push(Op::Create { id: id.clone(), object: Box::new(object), trees: Vec::new() });
        Ok(id)
    }

    /// Sets one register field.
    pub fn set(&mut self, id: &ObjectId, field: &str, value: Value) -> Result<()> {
        let (ty, name, def) = self.field(id, field)?;
        nesting_refusal(ty, name, &value)?;
        self.schema.check_value(ty, field, &value)?;
        if let Some(target) = value.as_str() {
            self.check_of(ty, name, def, &ObjectId::from_string(target))?;
        }
        self.overlay.registers.insert((id.clone(), name), self.ops.len());
        let field = self.name(name);
        self.ops.push(Op::Set { id: id.clone(), field, value: canonical(value), was: Value::Null });
        Ok(())
    }

    /// Deletes an object. References to it dangle; kits treat that as a validation state. Its
    /// nodes leave every tree that holds it; an object whose node has children is not deleted
    /// ([`KdmError::InvalidValue`]): delete or move them first (in one transaction, children
    /// before their parent), as the batch's `delete` says. A list keeps its entry: remove it with
    /// [`Tx::list_remove`].
    pub fn delete(&mut self, id: &ObjectId) -> Result<()> {
        if !self.exists(id) {
            return Err(KdmError::NotFound(id.to_string()));
        }
        self.refuse_live_children(id)?;
        self.overlay.deleted.insert(id.clone());
        // Its nodes leave the trees this transaction holds open, as the store will take them out.
        for tree in self.overlay.trees.values_mut() {
            if tree.contains(id) {
                tree.parents.remove(id);
                tree.deleted.insert(id.clone());
            }
        }
        self.ops.push(Op::Delete { id: id.clone(), was: None, trees: Vec::new() });
        Ok(())
    }

    /// Refuses to delete `id` when a node naming it, in any tree field that holds it, has a live
    /// child. Looks only at the trees that hold `id`: those of the document (the store's index of
    /// tree members) and those this transaction staged, so deleting `k` objects costs about `k`
    /// lookups, not `k` passes over the document.
    fn refuse_live_children(&self, id: &ObjectId) -> Result<()> {
        let mut trees: Vec<(ObjectId, &'a str)> = Vec::new();
        for (owner, field) in self.store.holders(id) {
            if let Ok((_, name, _)) = self.field(owner, field) {
                trees.push((owner.clone(), name));
            }
        }
        trees.extend(self.overlay.trees.iter().filter(|(_, state)| state.contains(id)).map(|((owner, name), _)| (owner.clone(), *name)));
        trees.sort_unstable();
        trees.dedup();
        let live = |child: &ObjectId| child != id && self.exists(child);
        for (owner, name) in trees {
            if !self.exists(&owner) {
                continue;
            }
            let has_child = match self.overlay.trees.get(&(owner.clone(), name)) {
                Some(state) => {
                    let under = |child: &ObjectId| state.parent(child).flatten().as_ref() == Some(id);
                    state.committed.is_some_and(|tree| tree.children(Some(id)).iter().any(|child| under(child) && live(child)))
                        || state.parents.iter().any(|(child, parent)| parent.as_ref() == Some(id) && under(child) && live(child))
                }
                None => matches!(self.store.field(&owner, name), Some(Field::Tree(tree)) if tree.children(Some(id)).iter().any(live)),
            };
            if has_child {
                return Err(KdmError::InvalidValue {
                    ty: self.type_of(&owner)?.to_owned(),
                    field: name.to_owned(),
                    reason: format!("`{id}` has children in the tree: delete or move them first"),
                });
            }
        }
        Ok(())
    }

    pub fn exists(&self, id: &ObjectId) -> bool {
        self.overlay.exists(id, || self.store.contains(id))
    }

    pub(crate) fn was_deleted(&self, id: &ObjectId) -> bool {
        self.overlay.deleted.contains(id)
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
            None => read::register(self.store, self.schema, id, field),
        }
    }

    /// Inserts `content` at `index`, counted in Unicode scalar values.
    pub fn text_insert(&mut self, id: &ObjectId, field: &str, index: usize, content: &str) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::Text)?;
        let len = self.text_length(id, name)?;
        if index > len {
            return Err(KdmError::OutOfRange { index, len });
        }
        self.overlay.texts.insert((id.clone(), name), len.saturating_add(content.chars().count()));
        let field = self.name(name);
        self.ops.push(Op::TextInsert { id: id.clone(), field, index, text: content.to_owned(), marks: None });
        Ok(())
    }

    /// The length of a text field in Unicode scalar values.
    pub fn text_len(&self, id: &ObjectId, field: &str) -> Result<usize> {
        let name = self.container_field(id, field, FieldKind::Text)?;
        self.text_length(id, name)
    }

    /// Deletes `count` Unicode scalar values starting at `index`.
    pub fn text_delete(&mut self, id: &ObjectId, field: &str, index: usize, count: usize) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::Text)?;
        let len = self.text_length(id, name)?;
        let end = index.checked_add(count).ok_or(KdmError::OutOfRange { index, len })?;
        if end > len {
            return Err(KdmError::OutOfRange { index: end, len });
        }
        self.overlay.texts.insert((id.clone(), name), len - count);
        let field = self.name(name);
        self.ops.push(Op::TextDelete { id: id.clone(), field, index, count, was: Vec::new() });
        Ok(())
    }

    /// Sets mark `key` to `value` over the characters `start..end` (Unicode scalar values) of a
    /// text field (rule M19). The field declares `key` in its schema `marks`; `value` is plain
    /// JSON and not `null` (remove a mark with [`Tx::text_unmark`]). An empty range changes
    /// nothing.
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
        let (ty, _, _) = self.field(id, field)?;
        nesting_refusal(ty, name, &value)?;
        if let Some(reason) = crate::schema::unportable(&value) {
            return Err(KdmError::InvalidValue { ty: ty.to_owned(), field: name.to_owned(), reason: format!("mark `{key}` {reason}") });
        }
        if !self.mark_range(id, name, start, end)? {
            return Ok(());
        }
        let field = self.name(name);
        self.ops.push(Op::TextMark { id: id.clone(), field, start, end, key: key.to_owned(), value: canonical(value), was: Vec::new() });
        Ok(())
    }

    /// Removes mark `key` from the characters `start..end` of a text field. Characters without
    /// the mark are left as they are; an empty range changes nothing.
    pub fn text_unmark(&mut self, id: &ObjectId, field: &str, start: usize, end: usize, key: &str) -> Result<()> {
        let (name, key) = self.mark_key(id, field, key)?;
        if !self.mark_range(id, name, start, end)? {
            return Ok(());
        }
        let field = self.name(name);
        self.ops.push(Op::TextMark { id: id.clone(), field, start, end, key: key.to_owned(), value: Value::Null, was: Vec::new() });
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
        let field = self.name(name);
        self.ops.push(Op::ListInsert { id: id.clone(), field, index, item: item.clone() });
        Ok(())
    }

    pub fn list_move(&mut self, id: &ObjectId, field: &str, from: usize, to: usize) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::List)?;
        let list = self.list_mut(id, name)?;
        if from >= list.len || to >= list.len {
            return Err(KdmError::OutOfRange { index: from.max(to), len: list.len });
        }
        list.edits.push(ListEdit::Move(from, to));
        let field = self.name(name);
        self.ops.push(Op::ListMove { id: id.clone(), field, from, to, item: None });
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
        let field = self.name(name);
        self.ops.push(Op::ListRemove { id: id.clone(), field, index, item: None });
        Ok(())
    }

    /// The list's items including this transaction's edits. Reads the whole list: validation
    /// never needs it, so call it only when the items themselves are wanted.
    pub fn list_items(&self, id: &ObjectId, field: &str) -> Result<Vec<ObjectId>> {
        let name = self.container_field(id, field, FieldKind::List)?;
        let mut items = if self.overlay.is_created(id) { Vec::new() } else { read::list(self.store, self.schema, id, name)?.to_vec() };
        if let Some(list) = self.overlay.lists.get(&(id.clone(), name)) {
            list.replay(&mut items)?;
        }
        Ok(items)
    }

    /// Sets `key` of a map field. Values hold no integer beyond ±2^53 and no `__proto__` key, at
    /// any depth ([`KdmError::InvalidValue`]).
    /// Sets key `key` of a map field; a `null` value deletes the key ([`Tx::map_delete`]): a map
    /// holds no `null` (data model C5).
    pub fn map_set(&mut self, id: &ObjectId, field: &str, key: &str, value: Value) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::Map)?;
        let (ty, _, def) = self.field(id, field)?;
        nesting_refusal(ty, name, &value)?;
        self.schema.check_map_entry(ty, field, key, &value)?;
        if value.is_null() {
            return self.map_delete(id, field, key);
        }
        if let Some(target) = value.as_str() {
            self.check_of(ty, field, def, &ObjectId::from_string(target))?;
        }
        if let Some(reason) = crate::schema::unportable(&value) {
            return Err(KdmError::InvalidValue { ty: ty.to_owned(), field: name.to_owned(), reason: reason.into() });
        }
        self.overlay.maps.entry((id.clone(), name)).or_default().insert(key.to_owned(), Some(self.ops.len()));
        let field = self.name(name);
        self.ops.push(Op::MapSet { id: id.clone(), field, key: key.to_owned(), value: Some(canonical(value)), was: None });
        Ok(())
    }

    pub fn map_delete(&mut self, id: &ObjectId, field: &str, key: &str) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::Map)?;
        self.overlay.maps.entry((id.clone(), name)).or_default().insert(key.to_owned(), None);
        let field = self.name(name);
        self.ops.push(Op::MapSet { id: id.clone(), field, key: key.to_owned(), value: None, was: None });
        Ok(())
    }

    /// One key of a map field including this transaction's writes, or `null`, as
    /// [`crate::Replica::map_get`] reads it.
    pub fn map_get(&self, id: &ObjectId, field: &str, key: &str) -> Result<Value> {
        let name = self.container_field(id, field, FieldKind::Map)?;
        if let Some(write) = self.overlay.maps.get(&(id.clone(), name)).and_then(|keys| keys.get(key)) {
            return Ok(write.map_or(Value::Null, |index| self.pending_map_value(index)));
        }
        if self.overlay.is_created(id) {
            return Ok(Value::Null);
        }
        Ok(read::map(self.store, self.schema, id, name)?.and_then(|entries| entries.get(key)).cloned().unwrap_or(Value::Null))
    }

    /// A map field's keys and values including this transaction's writes, sorted by key (code
    /// point order, as in the canonical state), each as [`Tx::map_get`] reads it.
    pub fn map_entries(&self, id: &ObjectId, field: &str) -> Result<Vec<(String, Value)>> {
        let name = self.container_field(id, field, FieldKind::Map)?;
        let mut entries: BTreeMap<String, Value> =
            if self.overlay.is_created(id) { BTreeMap::new() } else { read::map(self.store, self.schema, id, name)?.cloned().unwrap_or_default() };
        if let Some(writes) = self.overlay.maps.get(&(id.clone(), name)) {
            for (key, write) in writes {
                match write {
                    Some(index) => entries.insert(key.clone(), self.pending_map_value(*index)),
                    None => entries.remove(key),
                };
            }
        }
        Ok(entries.into_iter().collect())
    }

    /// Ids of the live objects of type `ty`, including those this transaction created and without
    /// those it deleted, sorted as [`crate::Replica::objects_of_type`] sorts them.
    pub fn objects_of_type(&self, ty: &str) -> Vec<ObjectId> {
        let deleted = &self.overlay.deleted;
        let mut ids = read::objects_of_type(self.store, ty);
        if !deleted.is_empty() {
            ids.retain(|id| !deleted.contains(id));
        }
        if let Some(created) = self.overlay.created_by_type.get(ty) {
            ids.extend(created.iter().filter(|id| !deleted.contains(*id)).cloned());
            ids.sort();
        }
        ids
    }

    /// Adds the node of `object` under `parent` (`None`: a root), last among its siblings. A tree
    /// holds an object once: a second node for it is refused ([`KdmError::InvalidValue`]). A node
    /// names a live object: one that does not exist (never made, or deleted) is refused
    /// ([`KdmError::NotFound`]); create it first, in this transaction or an earlier one.
    pub fn tree_create(&mut self, id: &ObjectId, field: &str, parent: Option<&NodeRef>, object: &ObjectId) -> Result<NodeRef> {
        let name = self.container_field(id, field, FieldKind::Tree)?;
        self.check_item(id, name, object)?;
        if !self.exists(object) {
            return Err(KdmError::NotFound(object.to_string()));
        }
        let (ty, _, _) = self.field(id, field)?;
        let tree = self.tree_mut(id, name)?;
        if let Some(parent) = parent
            && !tree.contains(&parent.0)
        {
            return Err(KdmError::NotFound(format!("parent node in {id}.{name}")));
        }
        if tree.contains(object) {
            return Err(KdmError::InvalidValue {
                ty: ty.to_owned(),
                field: name.to_owned(),
                reason: format!("holds `{object}` already: a tree holds an object once"),
            });
        }
        let parent = parent.map(|parent| parent.0.clone());
        tree.parents.insert(object.clone(), parent.clone());
        tree.deleted.remove(object);
        let field = self.name(name);
        self.ops.push(Op::TreeCreate { id: id.clone(), field, node: object.clone(), parent, index: None });
        Ok(NodeRef(object.clone()))
    }

    /// Moves `node` under `parent`, last among its new siblings. A move that would make a node
    /// its own ancestor (counting this transaction's earlier moves) fails with [`KdmError::Cycle`].
    pub fn tree_move(&mut self, id: &ObjectId, field: &str, node: &NodeRef, parent: Option<&NodeRef>) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::Tree)?;
        let tree = self.tree_mut(id, name)?;
        if !tree.contains(&node.0) || parent.is_some_and(|parent| !tree.contains(&parent.0)) {
            return Err(KdmError::NotFound(format!("node in {id}.{name}")));
        }
        if parent.is_some_and(|parent| tree.would_cycle(&node.0, &parent.0)) {
            return Err(KdmError::Cycle);
        }
        let parent = parent.map(|parent| parent.0.clone());
        tree.parents.insert(node.0.clone(), parent.clone());
        let field = self.name(name);
        self.ops.push(Op::TreeMove { id: id.clone(), field, node: node.0.clone(), parent, index: None, was: None });
        Ok(())
    }

    /// Deletes `node` and the nodes under it. The objects they name stay: a tree only arranges
    /// objects that other fields own. Move the children to keep out first.
    pub fn tree_delete(&mut self, id: &ObjectId, field: &str, node: &NodeRef) -> Result<()> {
        let name = self.container_field(id, field, FieldKind::Tree)?;
        if !self.tree_mut(id, name)?.contains(&node.0) {
            return Err(KdmError::NotFound(format!("node in {id}.{name}")));
        }
        let (children, _) = self.tree_view(id, name)?;
        // The subtree, each node after its descendants.
        let mut order = Vec::new();
        let mut stack = vec![(node.0.clone(), false)];
        while let Some((at, expanded)) = stack.pop() {
            if expanded {
                order.push(at);
                continue;
            }
            stack.push((at.clone(), true));
            for child in children.get(&Some(at)).into_iter().flatten() {
                stack.push((child.clone(), false));
            }
        }
        let field_name = self.name(name);
        let tree = self.tree_mut(id, name)?;
        for at in &order {
            tree.parents.remove(at);
            tree.deleted.insert(at.clone());
        }
        for at in order {
            self.ops.push(Op::TreeDelete { id: id.clone(), field: field_name.clone(), node: at, was: None });
        }
        Ok(())
    }

    /// The tree as this transaction sees it: the document's nodes plus the nodes it created, each
    /// node it created or moved last among its new siblings, without the nodes it deleted.
    fn tree_view(&self, id: &ObjectId, name: &str) -> Result<TreeView> {
        let mut children: HashMap<Option<ObjectId>, Vec<ObjectId>> = HashMap::new();
        let mut parent_of: HashMap<ObjectId, Option<ObjectId>> = HashMap::new();
        if !self.overlay.is_created(id)
            && let Some(tree) = read::tree(self.store, self.schema, id, name)?
        {
            for (node, parent) in tree.preorder() {
                children.entry(parent.clone()).or_default().push(node.clone());
                parent_of.insert(node, parent);
            }
        }
        let detach = |children: &mut HashMap<Option<ObjectId>, Vec<ObjectId>>, parent_of: &mut HashMap<ObjectId, Option<ObjectId>>, node: &ObjectId| {
            if let Some(old) = parent_of.remove(node) {
                children.entry(old).or_default().retain(|child| child != node);
            }
        };
        for op in &self.ops {
            match op {
                Op::TreeCreate { id: owner, field, node, parent, .. } if owner == id && &**field == name => {
                    children.entry(parent.clone()).or_default().push(node.clone());
                    parent_of.insert(node.clone(), parent.clone());
                }
                Op::TreeMove { id: owner, field, node, parent, .. } if owner == id && &**field == name => {
                    detach(&mut children, &mut parent_of, node);
                    children.entry(parent.clone()).or_default().push(node.clone());
                    parent_of.insert(node.clone(), parent.clone());
                }
                Op::TreeDelete { id: owner, field, node, .. } if owner == id && &**field == name => detach(&mut children, &mut parent_of, node),
                Op::Delete { id: deleted, .. } if parent_of.contains_key(deleted) => detach(&mut children, &mut parent_of, deleted),
                _ => {}
            }
        }
        Ok((children, parent_of))
    }

    /// The tree's nodes in pre-order as this transaction sees it: the document's nodes plus the
    /// nodes it created, each node it created or moved last among its new siblings, as they will
    /// be once it applies. A node naming an object that does not exist is skipped with its
    /// subtree, as in [`crate::Replica::tree`]. Reads the whole tree.
    pub fn tree(&self, id: &ObjectId, field: &str) -> Result<Vec<crate::TreeEntry>> {
        let name = self.container_field(id, field, FieldKind::Tree)?;
        let (children, _) = self.tree_view(id, name)?;
        let mut out = Vec::new();
        let mut stack: Vec<(ObjectId, Option<NodeRef>)> = children.get(&None).into_iter().flatten().rev().map(|node| (node.clone(), None)).collect();
        while let Some((node, parent)) = stack.pop() {
            if !self.exists(&node) {
                continue;
            }
            let handle = NodeRef(node.clone());
            stack.extend(children.get(&Some(node.clone())).into_iter().flatten().rev().map(|child| (child.clone(), Some(handle.clone()))));
            out.push(crate::TreeEntry { node: handle, object: node, parent });
        }
        Ok(out)
    }

    /// Checks an id the host chose for a new object of type `ty`.
    fn free_id(&self, ty: &str, id: &ObjectId) -> Result<ObjectId> {
        let invalid = |reason: String| KdmError::InvalidValue { ty: ty.to_owned(), field: "$id".into(), reason };
        if !is_object_id(id.as_str()) {
            return Err(invalid(format!("cannot be `{id}`: an object id matches `{OBJECT_ID_PATTERN}`")));
        }
        // One object, one way to write its id (data model 7.4, C12): a file refuses the others.
        if crate::content::check_id(id.as_str()).is_err() {
            return Err(invalid(format!("cannot be `{id}`: an object id that is a UUID is written in lowercase hyphenated form")));
        }
        if self.overlay.is_created(id) || self.overlay.deleted.contains(id) || self.store.contains(id) {
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
        let object = self.store.object(id).ok_or_else(|| KdmError::NotFound(id.to_string()))?;
        let schema: &'a Schema = self.schema;
        schema.types.get_key_value(&*object.ty).map(|(name, _)| name.as_str()).ok_or_else(|| KdmError::UnknownType(object.ty.to_string()))
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
            read::object_type(self.store, target).ok()
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

    /// The value of the `MapSet` operation at `index`.
    fn pending_map_value(&self, index: usize) -> Value {
        match self.ops.get(index) {
            Some(Op::MapSet { value: Some(value), .. }) => value.clone(),
            _ => Value::Null,
        }
    }

    fn pending_register(&self, id: &ObjectId, name: &str) -> Option<Value> {
        if let Some(Op::Set { value, .. }) = self.overlay.registers.get(&(id.clone(), name)).and_then(|index| self.ops.get(*index)) {
            return Some(value.clone());
        }
        let (_, index) = self.overlay.created.get(id)?;
        match self.ops.get(*index) {
            Some(Op::Create { object, .. }) => Some(match object.get(name) {
                Some(Field::Value(value)) => value.clone(),
                _ => Value::Null,
            }),
            _ => None,
        }
    }

    fn text_length(&self, id: &ObjectId, name: &'a str) -> Result<usize> {
        if let Some(len) = self.overlay.texts.get(&(id.clone(), name)) {
            return Ok(*len);
        }
        if self.overlay.is_created(id) {
            return Ok(0);
        }
        Ok(read::text(self.store, self.schema, id, name)?.map_or(0, |text| text.len()))
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
        let len = self.text_length(id, name)?;
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
            let len = if self.overlay.is_created(id) { 0 } else { read::list(self.store, self.schema, id, name)?.len() };
            self.overlay.lists.insert(key.clone(), ListState::new(len));
        }
        self.overlay.lists.get_mut(&key).ok_or_else(|| KdmError::Engine(format!("{id}.{name} was not staged")))
    }

    fn tree_mut(&mut self, id: &ObjectId, name: &'a str) -> Result<&mut TreeState<'a>> {
        let key = (id.clone(), name);
        if !self.overlay.trees.contains_key(&key) {
            let committed = if self.overlay.is_created(id) { None } else { read::tree(self.store, self.schema, id, name)? };
            let mut state = TreeState::new(committed);
            // Nodes of objects this transaction deleted left the tree with them.
            for deleted in &self.overlay.deleted {
                if state.contains(deleted) {
                    state.deleted.insert(deleted.clone());
                }
            }
            self.overlay.trees.insert(key.clone(), state);
        }
        self.overlay.trees.get_mut(&key).ok_or_else(|| KdmError::Engine(format!("{id}.{name} was not staged")))
    }
}
