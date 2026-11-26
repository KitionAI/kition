// Copied from kition-sdk crates/kition-kdm/src/store/mod.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The document in memory (plan 2026-11-24, plain model, section 1.1): objects by id, each with
//! its type and the fields it holds. A field it does not hold reads as empty; a container field
//! (text, list, map, tree) exists only while it holds something.
//!
//! Every change goes through [`Store::apply`], one operation at a time ([`op::Op`]): it checks
//! the operation's preconditions against the state (the object exists, the positions are in
//! range, the list item at a position is the one named), changes nothing when they fail
//! ([`KdmError::Stale`]), and answers the operation as applied, with what its inverse
//! ([`op::inverse`]) needs.

pub(crate) mod check;
pub(crate) mod op;
pub(crate) mod scalar;
pub(crate) mod text;
pub(crate) mod transform;
pub(crate) mod tree;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::content::{self, Content, TYPE_KEY};
use crate::{DocId, Expand, FieldDef, FieldKind, KdmError, ObjectId, Result, Schema, TextRun};
use op::{Name, Op, TreePlace};
use scalar::{Entries, Key, Scalar};
use text::Text;
use tree::Tree;

/// One field an object holds. 24 bytes: a register's value inline, a container behind a box.
#[derive(Clone, Debug, PartialEq)]
// A boxed list keeps every field of every object at the size of a value (a `Vec` is 24 bytes and
// would make each field 32).
#[allow(clippy::box_collection)]
pub(crate) enum Field {
    /// A register: any field that is not a container, and any field the schema does not declare.
    Value(Scalar),
    Text(Box<Text>),
    List(Box<Vec<ObjectId>>),
    Map(Box<Entries>),
    Tree(Box<Tree>),
}

impl Field {
    /// Whether the field holds nothing: a container field is then left out.
    fn is_empty(&self) -> bool {
        match self {
            Self::Value(value) => value.is_null(),
            Self::Text(text) => text.is_empty(),
            Self::List(items) => items.is_empty(),
            Self::Map(entries) => entries.is_empty(),
            Self::Tree(tree) => tree.is_empty(),
        }
    }

    /// The field in its content form (data model 7.4, rule C8), as a change carries it; `None`
    /// when it is empty. It depends on the field alone, never on a schema: a text is a string
    /// exactly when no run carries a mark.
    pub(crate) fn content(&self) -> Option<Value> {
        match self {
            Self::Value(value) => (!value.is_null()).then(|| value.to_value()),
            Self::Text(text) if text.is_empty() => None,
            Self::Text(text) if text.has_marks() => Some(Value::Array(text.runs().iter().map(TextRun::to_json).collect())),
            Self::Text(text) => Some(Value::String(text.string())),
            Self::List(items) => (!items.is_empty()).then(|| Value::Array(items.iter().map(|item| Value::String(item.to_string())).collect())),
            Self::Map(entries) => (!entries.is_empty()).then(|| Value::Object(entries.iter().map(|(key, value)| (key.to_text(), value.to_value())).collect())),
            Self::Tree(tree) => {
                let nodes: Vec<Value> = tree
                    .flat(&|_: &ObjectId| true)
                    .into_iter()
                    .map(|(depth, node)| Value::Array(vec![Value::from(depth), Value::String(node.to_string())]))
                    .collect();
                (!nodes.is_empty()).then_some(Value::Array(nodes))
            }
        }
    }

    /// A field from its content form, as the schema declares it (`def`; `None`: a register).
    /// Refuses ([`KdmError::Encoding`]) a value of the wrong shape for its kind, a run with a key
    /// other than `insert` and `attributes`, a tree entry that is not `[depth, "<id>"]`, a map
    /// entry holding `null`, and an id (list item, tree node, ref) that is a UUID not in
    /// lowercase hyphenated form.
    pub(crate) fn from_content(name: &str, value: Value, def: Option<&FieldDef>) -> Result<Self> {
        let bad = |shape: &str| KdmError::Encoding(format!("not KDM content: field `{name}` is not {shape}"));
        Ok(match def.map(|def| def.kind) {
            Some(FieldKind::Text) => match value {
                Value::String(text) => Self::Text(Box::new(Text::plain(&text))),
                Value::Array(runs) => Self::Text(Box::new(Text::from_runs(&runs_from_content(&runs).ok_or_else(|| bad("a string or an array of runs"))?))),
                _ => return Err(bad("a string or an array of runs")),
            },
            Some(FieldKind::List) => {
                let Value::Array(items) = value else { return Err(bad("an array of object ids")) };
                Self::List(Box::new(
                    items.iter().map(|item| id_from_content(item).unwrap_or_else(|| Err(bad("an array of object ids")))).collect::<Result<Vec<_>>>()?,
                ))
            }
            Some(FieldKind::Map) => {
                let Value::Object(entries) = value else { return Err(bad("a JSON object")) };
                let ids = def.is_some_and(|def| def.of.is_some());
                let mut out = Vec::with_capacity(entries.len());
                for (key, entry) in entries {
                    if entry.is_null() {
                        return Err(KdmError::Encoding(format!("not KDM content: map entry `{key}` of field `{name}` holds null")));
                    }
                    if let (true, Value::String(id)) = (ids, &entry) {
                        content::check_id(id)?;
                    }
                    out.push((Key::new(&key), Scalar::from_value(entry)));
                }
                out.sort_by(|a, b| a.0.cmp(&b.0));
                Self::Map(Box::new(Entries::from_sorted(out)))
            }
            Some(FieldKind::Tree) => {
                let Value::Array(entries) = value else { return Err(bad("an array of [depth, id] entries")) };
                let mut nodes = Vec::with_capacity(entries.len());
                for entry in &entries {
                    let Some([depth, node]) = entry.as_array().map(Vec::as_slice) else { return Err(bad("an array of [depth, id] entries")) };
                    let depth = depth.as_u64().and_then(|depth| usize::try_from(depth).ok()).ok_or_else(|| bad("an array of [depth, id] entries"))?;
                    nodes.push((depth, id_from_content(node).unwrap_or_else(|| Err(bad("an array of [depth, id] entries")))?));
                }
                Self::Tree(Box::new(Tree::from_flat(nodes)?))
            }
            Some(FieldKind::Ref) => {
                if let Value::String(id) = &value {
                    content::check_id(id)?;
                }
                Self::Value(Scalar::from_value(value))
            }
            _ => Self::Value(Scalar::from_value(value)),
        })
    }
}

/// An id in content: `None` when it is not a string, an error when it is not a well-formed id.
fn id_from_content(value: &Value) -> Option<Result<ObjectId>> {
    let id = value.as_str()?;
    Some(content::check_id(id).map(|()| ObjectId::from_text(id)))
}

/// A text's runs from content: `None` when a run is not `{"insert": "<text>"}` with an optional
/// `"attributes"` object. Empty runs, adjacent runs with equal marks and `null` mark values are
/// read as they are; [`Text::from_runs`] drops and merges them.
fn runs_from_content(items: &[Value]) -> Option<Vec<TextRun>> {
    items
        .iter()
        .map(|item| {
            let run = item.as_object()?;
            if run.keys().any(|key| key != "insert" && key != "attributes") {
                return None;
            }
            let insert = run.get("insert")?.as_str()?.to_owned();
            let attributes = match run.get("attributes") {
                None => BTreeMap::new(),
                Some(Value::Object(marks)) => marks.iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
                Some(_) => return None,
            };
            Some(TextRun { insert, attributes })
        })
        .collect()
}

/// What objects of one type holding the same fields share: the type and the fields' names,
/// sorted. A store holds each once ([`Names::shape`]): a million cells of one type with the same
/// four fields hold one shape between them.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Shape {
    ty: Name,
    names: Box<[Name]>,
}

/// One object: its type and the fields it holds, sorted by name. Its shape names them; it holds
/// their values, 24 bytes each.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Object {
    shape: Arc<Shape>,
    /// The value of each field its shape names, in that order.
    values: Box<[Field]>,
}

impl Object {
    pub(crate) fn new(ty: Name) -> Self {
        Self { shape: Arc::new(Shape { ty, names: Box::default() }), values: Box::default() }
    }

    /// An object of type `ty` holding `fields` (each name once, in any order), its shape held once
    /// in `names`; empty fields are left out.
    pub(crate) fn of_fields(ty: Name, mut fields: Vec<(Name, Field)>, names: &mut Names) -> Self {
        fields.retain(|(_, field)| !field.is_empty());
        fields.sort_by(|a, b| a.0.cmp(&b.0));
        let (held, values): (Vec<Name>, Vec<Field>) = fields.into_iter().unzip();
        let shape = names.shape(&Arc::new(Shape { ty, names: held.into_boxed_slice() }));
        Self { shape, values: values.into_boxed_slice() }
    }

    /// The object's type.
    pub(crate) fn ty(&self) -> &Name {
        &self.shape.ty
    }

    fn position(&self, name: &str) -> std::result::Result<usize, usize> {
        self.shape.names.binary_search_by(|held| (**held).cmp(name))
    }

    pub(crate) fn get(&self, name: &str) -> Option<&Field> {
        self.position(name).ok().and_then(|at| self.values.get(at))
    }

    fn get_mut(&mut self, name: &str) -> Option<&mut Field> {
        let at = self.position(name).ok()?;
        self.values.get_mut(at)
    }

    /// Adds field `name` at `at` (its place among the names).
    fn insert(&mut self, at: usize, name: Name, field: Field) {
        let mut names = self.shape.names.to_vec();
        names.insert(at, name);
        let mut values = std::mem::take(&mut self.values).into_vec();
        values.insert(at, field);
        self.shape = Arc::new(Shape { ty: self.shape.ty.clone(), names: names.into_boxed_slice() });
        self.values = values.into_boxed_slice();
    }

    /// Sets a field; an empty one is removed.
    pub(crate) fn put(&mut self, name: Name, field: Field) {
        if field.is_empty() {
            self.take(&name);
            return;
        }
        match self.position(&name) {
            Ok(at) => {
                if let Some(slot) = self.values.get_mut(at) {
                    *slot = field;
                }
            }
            Err(at) => self.insert(at, name, field),
        }
    }

    fn take(&mut self, name: &str) -> Option<Field> {
        let at = self.position(name).ok()?;
        let mut names = self.shape.names.to_vec();
        names.remove(at);
        let mut values = std::mem::take(&mut self.values).into_vec();
        let taken = values.remove(at);
        self.shape = Arc::new(Shape { ty: self.shape.ty.clone(), names: names.into_boxed_slice() });
        self.values = values.into_boxed_slice();
        Some(taken)
    }

    /// Removes the field when it became empty.
    fn settle(&mut self, name: &str) {
        if self.get(name).is_some_and(Field::is_empty) {
            self.take(name);
        }
    }

    /// The fields the object holds, by name.
    pub(crate) fn fields(&self) -> impl Iterator<Item = (&Name, &Field)> {
        self.shape.names.iter().zip(self.values.iter())
    }

    /// The fields the object holds, by name, to change in place (none added or removed).
    pub(crate) fn fields_mut(&mut self) -> impl Iterator<Item = (&Name, &mut Field)> {
        self.shape.names.iter().zip(self.values.iter_mut())
    }

    /// The object's content form: `$type` and every field it holds (data model 7.4), as a change
    /// carries it.
    pub(crate) fn to_content(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert(TYPE_KEY.to_owned(), Value::String(self.ty().to_string()));
        for (name, field) in self.fields() {
            if let Some(value) = field.content() {
                out.insert(name.to_string(), value);
            }
        }
        out
    }

    /// An object from its content form (as a change carries it); each field as the schema
    /// declares it, a field it does not declare as a register. Refuses ([`KdmError::Encoding`]) a
    /// field holding `null` and a field of the wrong shape ([`Field::from_content`]); a container
    /// field written empty is left out.
    pub(crate) fn from_content(fields: &Map<String, Value>, schema: &Schema) -> Result<Self> {
        let ty = fields.get(TYPE_KEY).and_then(Value::as_str).ok_or_else(|| KdmError::Encoding("not KDM content: an object has no `$type`".into()))?;
        let def = schema.types.get(ty);
        let mut object = Self::new(Name::from(ty));
        for (name, value) in fields {
            if name == TYPE_KEY {
                continue;
            }
            if value.is_null() {
                return Err(KdmError::Encoding(format!("not KDM content: field `{name}` holds null (a field without a value is left out)")));
            }
            let field = def.and_then(|def| def.fields.get(name));
            object.put(Name::from(name.as_str()), Field::from_content(name, value.clone(), field)?);
        }
        Ok(object)
    }
}

/// The trees holding an object as a node: each owner and tree field.
type Holders = Vec<(ObjectId, Name)>;

/// One document's state.
///
/// Objects are held in id order (the order the content encoding writes them, data model 7.4 C3),
/// each behind an `Arc`: a copy of the store ([`crate::Replica::fork`], drafts, plans) shares every
/// object with the original and copies one only when either writes it.
#[derive(Clone, Debug)]
pub(crate) struct Store {
    pub(crate) doc_id: DocId,
    pub(crate) kit: String,
    /// The minimum schema version (rule M20).
    pub(crate) schema_version: u64,
    objects: BTreeMap<ObjectId, Arc<Object>>,
    /// For each object that is a node of a tree, the trees holding it.
    nodes: HashMap<ObjectId, Holders>,
    /// The type and field names and the shapes of objects in use, each held once.
    names: Names,
}

impl PartialEq for Store {
    fn eq(&self, other: &Self) -> bool {
        let sorted = |nodes: &HashMap<ObjectId, Holders>| -> BTreeMap<ObjectId, Vec<(ObjectId, String)>> {
            nodes
                .iter()
                .map(|(node, holders)| {
                    let mut holders: Vec<(ObjectId, String)> = holders.iter().map(|(owner, field)| (owner.clone(), field.to_string())).collect();
                    holders.sort();
                    (node.clone(), holders)
                })
                .collect()
        };
        self.doc_id == other.doc_id
            && self.kit == other.kit
            && self.schema_version == other.schema_version
            && self.objects == other.objects
            && sorted(&self.nodes) == sorted(&other.nodes)
    }
}

/// A precondition that does not hold.
fn stale(reason: impl Into<String>) -> KdmError {
    KdmError::Stale(reason.into())
}

/// The type and field names in use and the shapes of objects, each held once.
#[derive(Clone, Debug, Default)]
pub(crate) struct Names {
    names: HashSet<Name>,
    shapes: HashSet<Arc<Shape>>,
}

impl Names {
    /// `name` as held here.
    pub(crate) fn name(&mut self, name: &str) -> Name {
        if let Some(held) = self.names.get(name) {
            return held.clone();
        }
        let held = Name::from(name);
        self.names.insert(held.clone());
        held
    }

    /// `shape` as held here.
    pub(crate) fn shape(&mut self, shape: &Arc<Shape>) -> Arc<Shape> {
        if let Some(held) = self.shapes.get(&**shape) {
            return Arc::clone(held);
        }
        let held = Arc::new(Shape { ty: self.name(&shape.ty), names: shape.names.iter().map(|name| self.name(name)).collect() });
        self.shapes.insert(Arc::clone(&held));
        held
    }
}

/// The expand of mark `key` on field `field` of type `ty`.
fn expand_of(schema: &Schema, ty: &str, field: &str, key: &str) -> Option<Expand> {
    schema.types.get(ty)?.fields.get(field)?.marks.get(key).map(|mark| mark.expand)
}

impl Store {
    pub(crate) fn new(doc_id: DocId, kit: String, schema_version: u64) -> Self {
        Self { doc_id, kit, schema_version, objects: BTreeMap::new(), nodes: HashMap::new(), names: Names::default() }
    }

    /// The state that content holds (data model 7.4), read by [`content::read`] and
    /// [`content::decode`]. Refuses ([`KdmError::Encoding`]) a field of the wrong shape for its
    /// kind (the first one the reader met), and a file's content (no version) whose list item or
    /// tree node names no object of it (the writer leaves them out, [`content::write`]); a snapshot
    /// holds the state exactly, such entries included.
    pub(crate) fn from_content(content: Content) -> Result<Self> {
        let Content { kit, doc_id, schema_version, version, objects } = content;
        let (list, names) = objects.into_parts()?;
        let mut store = Self { doc_id, kit, schema_version, objects: list.into_iter().collect(), nodes: HashMap::new(), names };
        for (owner, object) in &store.objects {
            for (field, held) in object.fields() {
                let Field::Tree(tree) = held else { continue };
                for (node, _) in tree.nodes() {
                    store.nodes.entry(node.clone()).or_default().push((owner.clone(), field.clone()));
                }
            }
        }
        if version.is_none() {
            for (id, object) in &store.objects {
                for (name, field) in object.fields() {
                    let missing = match field {
                        Field::List(items) => items.iter().find(|item| !store.objects.contains_key(*item)),
                        Field::Tree(tree) => tree.nodes().map(|(node, _)| node).find(|node| !store.objects.contains_key(*node)),
                        _ => None,
                    };
                    if let Some(missing) = missing {
                        return Err(KdmError::Encoding(format!("not KDM content: {id}.{name} names `{missing}`, which is no object of the document")));
                    }
                }
            }
        }
        Ok(store)
    }

    /// A store of only the objects `ids` (those it holds), shared with this one, and the nodes of
    /// their trees: what changes to those objects alone can be taken back in.
    pub(crate) fn subset(&self, ids: &std::collections::BTreeSet<ObjectId>) -> Self {
        let mut out = Self::new(self.doc_id, self.kit.clone(), self.schema_version);
        let held: Vec<(ObjectId, Arc<Object>)> = ids.iter().filter_map(|id| self.objects.get(id).map(|object| (id.clone(), Arc::clone(object)))).collect();
        for (id, object) in held {
            out.index_trees(&id, &object, true);
            out.objects.insert(id, object);
        }
        out
    }

    /// Whether both stores hold one document's same objects (the tree index follows from them).
    pub(crate) fn same_objects(&self, other: &Self) -> bool {
        self.doc_id == other.doc_id && self.kit == other.kit && self.schema_version == other.schema_version && self.objects == other.objects
    }

    pub(crate) fn object(&self, id: &ObjectId) -> Option<&Object> {
        self.objects.get(id).map(|object| &**object)
    }

    pub(crate) fn contains(&self, id: &ObjectId) -> bool {
        self.objects.contains_key(id)
    }

    /// The objects in id order.
    pub(crate) fn objects(&self) -> impl Iterator<Item = (&ObjectId, &Object)> {
        self.objects.iter().map(|(id, object)| (id, &**object))
    }

    /// The trees (owner and field) holding `id` as a node.
    pub(crate) fn holders(&self, id: &ObjectId) -> &[(ObjectId, Name)] {
        self.nodes.get(id).map(Vec::as_slice).unwrap_or_default()
    }

    /// A field of an object, or `None` when the object does not exist or holds no such field.
    pub(crate) fn field(&self, id: &ObjectId, name: &str) -> Option<&Field> {
        self.objects.get(id)?.get(name)
    }

    /// The object to change: copied first when a copy of the store shares it.
    fn object_mut<'a>(objects: &'a mut BTreeMap<ObjectId, Arc<Object>>, id: &ObjectId) -> Option<&'a mut Object> {
        objects.get_mut(id).map(Arc::make_mut)
    }

    /// Holds the object's shape (its type and field names) once.
    fn intern_object(&mut self, object: &mut Object) {
        object.shape = self.names.shape(&object.shape);
    }

    /// Holds the shape of object `id` once again after a field was added to it or taken from it.
    fn reshape(&mut self, id: &ObjectId) {
        let Some(object) = self.objects.get(id) else { return };
        let shared = self.names.shape(&object.shape);
        if !Arc::ptr_eq(&shared, &object.shape)
            && let Some(object) = Self::object_mut(&mut self.objects, id)
        {
            object.shape = shared;
        }
    }

    /// Adds (or removes) the nodes of `object`'s own tree fields to the index of tree members.
    fn index_trees(&mut self, owner: &ObjectId, object: &Object, add: bool) {
        for (field, held) in object.fields() {
            let Field::Tree(tree) = held else { continue };
            for (node, _) in tree.nodes() {
                if add {
                    self.nodes.entry(node.clone()).or_default().push((owner.clone(), field.clone()));
                } else {
                    self.unindex(node, owner, field);
                }
            }
        }
    }

    fn unindex(&mut self, node: &ObjectId, owner: &ObjectId, field: &str) {
        if let Some(holders) = self.nodes.get_mut(node) {
            holders.retain(|(held, name)| !(held == owner && &**name == field));
            if holders.is_empty() {
                self.nodes.remove(node);
            }
        }
    }

    /// The tree field `field` of `id`: `Ok(None)` when the object holds none.
    fn tree(&self, id: &ObjectId, field: &str) -> Result<Option<&Tree>> {
        let object = self.objects.get(id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
        match object.get(field) {
            None => Ok(None),
            Some(Field::Tree(tree)) => Ok(Some(tree)),
            Some(_) => Err(stale(format!("{id}.{field} is not a tree"))),
        }
    }

    /// Checks that `node` can go to `place`.
    fn check_place(&self, place: &TreePlace, node: &ObjectId) -> Result<()> {
        let tree = self.tree(&place.owner, &place.field)?;
        let siblings = match (tree, &place.parent) {
            (Some(tree), _) if tree.contains(node) => return Err(stale(format!("`{node}` is in {}.{} already", place.owner, place.field))),
            (Some(tree), Some(parent)) if !tree.contains(parent) => return Err(stale(format!("no node `{parent}` in {}.{}", place.owner, place.field))),
            (Some(tree), parent) => tree.children(parent.as_ref()).len(),
            (None, None) => 0,
            (None, Some(parent)) => return Err(stale(format!("no node `{parent}` in {}.{}", place.owner, place.field))),
        };
        if place.index > siblings {
            return Err(stale(format!("index {} is beyond {siblings} siblings", place.index)));
        }
        Ok(())
    }

    /// Puts `node` at `place` (checked).
    fn attach(&mut self, place: &TreePlace, node: &ObjectId) {
        let field = self.names.name(&place.field);
        let Some(object) = Self::object_mut(&mut self.objects, &place.owner) else { return };
        // An empty tree is not kept (`put` drops it), so a first node makes its field here.
        if let Err(at) = object.position(&field) {
            object.insert(at, field.clone(), Field::Tree(Box::default()));
        }
        if let Some(Field::Tree(tree)) = object.get_mut(&field) {
            tree.insert(node.clone(), place.parent.clone(), place.index);
        }
        self.nodes.entry(node.clone()).or_default().push((place.owner.clone(), field));
    }

    /// Applies one operation, or changes nothing and answers [`KdmError::Stale`] when its
    /// preconditions do not hold. Answers the operation as applied.
    pub(crate) fn apply(&mut self, op: Op, schema: &Schema) -> Result<Op> {
        let done = self.apply_op(op, schema)?;
        // An object whose fields came or went holds its new shape once (a created object's own
        // shape is held when it is made).
        if let Op::Create { trees, .. } | Op::Delete { trees, .. } = &done {
            for place in trees {
                self.reshape(&place.owner);
            }
        }
        if let Some(id) = done.object() {
            self.reshape(id);
        }
        Ok(done)
    }

    fn apply_op(&mut self, op: Op, schema: &Schema) -> Result<Op> {
        match op {
            Op::Create { id, object, trees } => {
                if self.objects.contains_key(&id) {
                    return Err(stale(format!("object `{id}` exists already")));
                }
                let mut stored = (*object).clone();
                self.intern_object(&mut stored);
                self.index_trees(&id, &stored, true);
                self.objects.insert(id.clone(), Arc::new(stored));
                if let Some(error) = trees.iter().find_map(|place| self.check_place(place, &id).err()) {
                    if let Some(stored) = self.objects.remove(&id) {
                        self.index_trees(&id, &stored, false);
                    }
                    return Err(error);
                }
                for place in &trees {
                    self.attach(place, &id);
                }
                Ok(Op::Create { id, object, trees })
            }
            Op::Delete { id, .. } => {
                if !self.objects.contains_key(&id) {
                    return Err(stale(format!("object `{id}` does not exist")));
                }
                let holders = self.nodes.get(&id).cloned().unwrap_or_default();
                for (owner, field) in &holders {
                    if self.tree(owner, field)?.is_some_and(|tree| !tree.children(Some(&id)).is_empty()) {
                        return Err(stale(format!("`{id}` has children in {owner}.{field}")));
                    }
                }
                let mut trees = Vec::with_capacity(holders.len());
                for (owner, field) in holders {
                    let Some(object) = Self::object_mut(&mut self.objects, &owner) else { continue };
                    let Some(Field::Tree(tree)) = object.get_mut(&field) else { continue };
                    if let Some((parent, index)) = tree.detach(&id) {
                        trees.push(TreePlace { owner: owner.clone(), field: field.clone(), parent, index });
                    }
                    object.settle(&field);
                }
                self.nodes.remove(&id);
                let Some(object) = self.objects.remove(&id) else { return Err(stale(format!("object `{id}` does not exist"))) };
                let object = Arc::unwrap_or_clone(object);
                self.index_trees(&id, &object, false);
                Ok(Op::Delete { id, was: Some(Box::new(object)), trees })
            }
            Op::Set { id, field, value, .. } => {
                let name = self.names.name(&field);
                let object = Self::object_mut(&mut self.objects, &id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let was = match object.get(&field) {
                    None => Value::Null,
                    Some(Field::Value(value)) => value.to_value(),
                    Some(_) => return Err(stale(format!("{id}.{field} is a container"))),
                };
                object.put(name, Field::Value(Scalar::from_value(value.clone())));
                Ok(Op::Set { id, field, value, was })
            }
            Op::TextInsert { id, field, index, text, marks } => {
                let name = self.names.name(&field);
                let object = Self::object_mut(&mut self.objects, &id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let ty = object.ty().clone();
                let held = match object.get(&field) {
                    None => None,
                    Some(Field::Text(text)) => Some(text),
                    Some(_) => return Err(stale(format!("{id}.{field} is not a text"))),
                };
                let len = held.map_or(0, |text| text.len());
                if index > len {
                    return Err(stale(format!("index {index} is beyond {id}.{field}'s {len} characters")));
                }
                let marks = match marks {
                    Some(marks) => marks,
                    None => held.map(|text| text.inserted_marks(index, |key| expand_of(schema, &ty, &field, key))).unwrap_or_default(),
                };
                if !text.is_empty() {
                    match object.get_mut(&field) {
                        Some(Field::Text(held)) => held.insert(index, &text, marks.clone()),
                        _ => {
                            let mut made = Text::default();
                            made.insert(0, &text, marks.clone());
                            object.put(name, Field::Text(Box::new(made)));
                        }
                    }
                }
                Ok(Op::TextInsert { id, field, index, text, marks: Some(marks) })
            }
            Op::TextDelete { id, field, index, count, .. } => {
                let object = Self::object_mut(&mut self.objects, &id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let len = match object.get(&field) {
                    None => 0,
                    Some(Field::Text(text)) => text.len(),
                    Some(_) => return Err(stale(format!("{id}.{field} is not a text"))),
                };
                if index.checked_add(count).is_none_or(|end| end > len) {
                    return Err(stale(format!("{index}+{count} is beyond {id}.{field}'s {len} characters")));
                }
                let was = match object.get_mut(&field) {
                    Some(Field::Text(text)) if count > 0 => text.delete(index, count),
                    _ => Vec::new(),
                };
                object.settle(&field);
                Ok(Op::TextDelete { id, field, index, count, was })
            }
            Op::TextMark { id, field, start, end, key, value, .. } => {
                let object = Self::object_mut(&mut self.objects, &id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let len = match object.get(&field) {
                    None => 0,
                    Some(Field::Text(text)) => text.len(),
                    Some(_) => return Err(stale(format!("{id}.{field} is not a text"))),
                };
                if start > end || end > len {
                    return Err(stale(format!("{start}..{end} is not within {id}.{field}'s {len} characters")));
                }
                let was = match object.get_mut(&field) {
                    Some(Field::Text(text)) if start < end => text.mark(start, end, &key, &value),
                    _ => Vec::new(),
                };
                Ok(Op::TextMark { id, field, start, end, key, value, was })
            }
            Op::ListInsert { id, field, index, item } => {
                let name = self.names.name(&field);
                let object = Self::object_mut(&mut self.objects, &id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let len = match object.get(&field) {
                    None => 0,
                    Some(Field::List(items)) => items.len(),
                    Some(_) => return Err(stale(format!("{id}.{field} is not a list"))),
                };
                if index > len {
                    return Err(stale(format!("index {index} is beyond {id}.{field}'s {len} items")));
                }
                match object.get_mut(&field) {
                    Some(Field::List(items)) => items.insert(index, item.clone()),
                    _ => object.put(name, Field::List(Box::new(vec![item.clone()]))),
                }
                Ok(Op::ListInsert { id, field, index, item })
            }
            Op::ListRemove { id, field, index, item } => {
                let object = Self::object_mut(&mut self.objects, &id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let Some(Field::List(items)) = object.get_mut(&field) else { return Err(stale(format!("{id}.{field} holds no item {index}"))) };
                match items.get(index) {
                    None => return Err(stale(format!("{id}.{field} holds no item {index}"))),
                    Some(found) if item.as_ref().is_some_and(|item| item != found) => {
                        return Err(stale(format!("item {index} of {id}.{field} is `{found}`, not the one named")));
                    }
                    Some(_) => {}
                }
                let removed = items.remove(index);
                object.settle(&field);
                Ok(Op::ListRemove { id, field, index, item: Some(removed) })
            }
            Op::ListMove { id, field, from, to, item } => {
                let object = Self::object_mut(&mut self.objects, &id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let Some(Field::List(items)) = object.get_mut(&field) else { return Err(stale(format!("{id}.{field} holds no item {from}"))) };
                let len = items.len();
                match items.get(from) {
                    _ if to >= len => return Err(stale(format!("index {to} is beyond {id}.{field}'s {len} items"))),
                    None => return Err(stale(format!("{id}.{field} holds no item {from}"))),
                    Some(found) if item.as_ref().is_some_and(|item| item != found) => {
                        return Err(stale(format!("item {from} of {id}.{field} is `{found}`, not the one named")));
                    }
                    Some(_) => {}
                }
                let moved = items.remove(from);
                items.insert(to, moved.clone());
                Ok(Op::ListMove { id, field, from, to, item: Some(moved) })
            }
            Op::MapSet { id, field, key, value, .. } => {
                // Setting a key to `null` deletes it: a map holds no `null` (data model 7.4, C5).
                let value = value.filter(|value| !value.is_null());
                let name = self.names.name(&field);
                let object = Self::object_mut(&mut self.objects, &id).ok_or_else(|| stale(format!("object `{id}` does not exist")))?;
                let held = Key::new(&key);
                let was = match object.get_mut(&field) {
                    None => None,
                    Some(Field::Map(entries)) => match &value {
                        Some(value) => entries.insert(held, Scalar::from_value(value.clone())),
                        None => entries.remove(&held),
                    },
                    Some(_) => return Err(stale(format!("{id}.{field} is not a map"))),
                }
                .map(|was| was.to_value());
                if object.get(&field).is_none()
                    && let Some(value) = &value
                {
                    object.put(name, Field::Map(Box::new(Entries::from_sorted(vec![(Key::new(&key), Scalar::from_value(value.clone()))]))));
                }
                object.settle(&field);
                Ok(Op::MapSet { id, field, key, value, was })
            }
            Op::TreeCreate { id, field, node, parent, index } => {
                let siblings = match self.tree(&id, &field)? {
                    Some(tree) if tree.contains(&node) => return Err(stale(format!("`{node}` is in {id}.{field} already"))),
                    Some(tree) if parent.as_ref().is_some_and(|parent| !tree.contains(parent)) => return Err(stale(format!("no parent node in {id}.{field}"))),
                    Some(tree) => tree.children(parent.as_ref()).len(),
                    None if parent.is_some() => return Err(stale(format!("no parent node in {id}.{field}"))),
                    None => 0,
                };
                let index = index.unwrap_or(siblings);
                if index > siblings {
                    return Err(stale(format!("index {index} is beyond {siblings} siblings")));
                }
                self.attach(&TreePlace { owner: id.clone(), field: field.clone(), parent: parent.clone(), index }, &node);
                Ok(Op::TreeCreate { id, field, node, parent, index: Some(index) })
            }
            Op::TreeMove { id, field, node, parent, index, .. } => {
                let tree = self.tree(&id, &field)?.ok_or_else(|| stale(format!("no node `{node}` in {id}.{field}")))?;
                let Some((was_parent, was_index)) = tree.place(&node) else { return Err(stale(format!("no node `{node}` in {id}.{field}"))) };
                if let Some(parent) = &parent {
                    if !tree.contains(parent) {
                        return Err(stale(format!("no parent node `{parent}` in {id}.{field}")));
                    }
                    if tree.would_cycle(&node, parent) {
                        return Err(KdmError::Cycle);
                    }
                }
                let siblings = tree.children(parent.as_ref()).len() - usize::from(was_parent == parent);
                let index = index.unwrap_or(siblings);
                if index > siblings {
                    return Err(stale(format!("index {index} is beyond {siblings} siblings")));
                }
                if let Some(Field::Tree(tree)) = Self::object_mut(&mut self.objects, &id).and_then(|object| object.get_mut(&field)) {
                    tree.detach(&node);
                    tree.insert(node.clone(), parent.clone(), index);
                }
                Ok(Op::TreeMove { id, field, node, parent, index: Some(index), was: Some((was_parent, was_index)) })
            }
            Op::TreeDelete { id, field, node, .. } => {
                let tree = self.tree(&id, &field)?.ok_or_else(|| stale(format!("no node `{node}` in {id}.{field}")))?;
                if !tree.contains(&node) {
                    return Err(stale(format!("no node `{node}` in {id}.{field}")));
                }
                if !tree.children(Some(&node)).is_empty() {
                    return Err(stale(format!("`{node}` has children in {id}.{field}")));
                }
                let mut was = None;
                if let Some(object) = Self::object_mut(&mut self.objects, &id) {
                    if let Some(Field::Tree(tree)) = object.get_mut(&field) {
                        was = tree.detach(&node);
                    }
                    object.settle(&field);
                }
                self.unindex(&node, &id, &field);
                Ok(Op::TreeDelete { id, field, node, was })
            }
            Op::SchemaVersion { version, .. } => {
                let was = self.schema_version;
                self.schema_version = version;
                Ok(Op::SchemaVersion { version, was })
            }
        }
    }

    /// Applies `ops` in order as one change: all of them, or (when one fails) none, the error
    /// answered. Answers the operations as applied.
    pub(crate) fn apply_all(&mut self, ops: Vec<Op>, schema: &Schema) -> Result<Vec<Op>> {
        self.apply_each(ops, schema, |store, op| store.apply(op, schema))
    }

    /// [`Store::apply_all`] for operations from another replica: each checked against the schema
    /// on the state it applies to ([`check::checked`]) before it applies.
    pub(crate) fn apply_all_checked(&mut self, ops: Vec<Op>, schema: &Schema) -> Result<Vec<Op>> {
        self.apply_each(ops, schema, |store, op| check::checked(op, store, schema).and_then(|op| store.apply(op, schema)))
    }

    /// Applies `ops` in order with `apply`, each answer in its operation's place (no second list of
    /// them: a bulk import's change holds millions); when one fails, reverts those before it.
    fn apply_each(&mut self, mut ops: Vec<Op>, schema: &Schema, apply: impl Fn(&mut Self, Op) -> Result<Op>) -> Result<Vec<Op>> {
        for at in 0..ops.len() {
            let Some(slot) = ops.get_mut(at) else { break };
            let op = std::mem::replace(slot, Op::SchemaVersion { version: 0, was: 0 });
            match apply(self, op) {
                Ok(done) => *slot = done,
                Err(error) => {
                    self.revert(ops.get(..at).unwrap_or_default(), schema);
                    return Err(error);
                }
            }
        }
        Ok(ops)
    }

    /// Undoes applied operations, last first.
    pub(crate) fn revert(&mut self, applied: &[Op], schema: &Schema) {
        for op in op::inverse_all(applied.iter()) {
            // The inverse of an operation applied just now always applies.
            let _ = self.apply(op, schema);
        }
    }

    /// `op` fitted to the current state, for an undo that keeps later changes: positions clamped
    /// to the field, a list item found where it is now, and `None` for an operation that has
    /// nothing left to act on (its object, node or item gone).
    pub(crate) fn fit(&self, op: Op) -> Option<Op> {
        match op {
            Op::Create { id, object, trees } => {
                if self.contains(&id) {
                    return None;
                }
                // Each place fitted as a `TreeCreate`'s is: a parent no longer in the tree makes a
                // root, the index is clamped to the siblings, and a tree whose owner is gone is
                // left out.
                let trees = trees
                    .into_iter()
                    .filter_map(|place| {
                        let tree = self.tree(&place.owner, &place.field).ok()?;
                        let parent = place.parent.filter(|parent| tree.is_some_and(|tree| tree.contains(parent)));
                        let siblings = tree.map_or(0, |tree| tree.children(parent.as_ref()).len());
                        Some(TreePlace { index: place.index.min(siblings), parent, owner: place.owner, field: place.field })
                    })
                    .collect();
                Some(Op::Create { id, object, trees })
            }
            Op::Delete { ref id, .. } => {
                let free = self
                    .holders(id)
                    .iter()
                    .all(|(owner, field)| matches!(self.field(owner, field), Some(Field::Tree(tree)) if tree.children(Some(id)).is_empty()));
                (self.contains(id) && free).then_some(op)
            }
            Op::Set { ref id, .. } | Op::MapSet { ref id, .. } => self.object(id).is_some().then_some(op),
            Op::TextInsert { id, field, index, text, marks } => {
                let len = match self.object(&id)?.get(&field) {
                    None => 0,
                    Some(Field::Text(held)) => held.len(),
                    Some(_) => return None,
                };
                Some(Op::TextInsert { id, field, index: index.min(len), text, marks })
            }
            Op::TextDelete { id, field, index, count, was } => {
                let Some(Field::Text(held)) = self.object(&id)?.get(&field) else { return None };
                let end = index.saturating_add(count).min(held.len());
                (index < end).then(|| Op::TextDelete { id, field, index, count: end - index, was })
            }
            Op::TextMark { id, field, start, end, key, value, was } => {
                let Some(Field::Text(held)) = self.object(&id)?.get(&field) else { return None };
                let end = end.min(held.len());
                (start < end).then_some(Op::TextMark { id, field, start, end, key, value, was })
            }
            Op::ListInsert { id, field, index, item } => {
                let len = match self.object(&id)?.get(&field) {
                    None => 0,
                    Some(Field::List(items)) => items.len(),
                    Some(_) => return None,
                };
                Some(Op::ListInsert { id, field, index: index.min(len), item })
            }
            Op::ListRemove { id, field, index, item } => {
                let Some(Field::List(items)) = self.object(&id)?.get(&field) else { return None };
                let index = match &item {
                    Some(item) if items.get(index) != Some(item) => items.iter().position(|found| found == item)?,
                    _ if index < items.len() => index,
                    _ => return None,
                };
                Some(Op::ListRemove { id, field, index, item })
            }
            Op::ListMove { id, field, from, to, item } => {
                let Some(Field::List(items)) = self.object(&id)?.get(&field) else { return None };
                let from = match &item {
                    Some(item) if items.get(from) != Some(item) => items.iter().position(|found| found == item)?,
                    _ if from < items.len() => from,
                    _ => return None,
                };
                Some(Op::ListMove { id, field, from, to: to.min(items.len().saturating_sub(1)), item })
            }
            Op::TreeCreate { id, field, node, parent, index } => {
                let tree = self.tree(&id, &field).ok()?;
                // A node of an object deleted since has nothing to name.
                if !self.contains(&node) || tree.is_some_and(|tree| tree.contains(&node)) {
                    return None;
                }
                let parent = parent.filter(|parent| tree.is_some_and(|tree| tree.contains(parent)));
                let siblings = tree.map_or(0, |tree| tree.children(parent.as_ref()).len());
                Some(Op::TreeCreate { id, field, node, parent, index: index.map(|index| index.min(siblings)) })
            }
            Op::TreeMove { id, field, node, parent, index, was } => {
                let tree = self.tree(&id, &field).ok()??;
                let (now, _) = tree.place(&node)?;
                let parent = parent.filter(|parent| tree.contains(parent));
                if parent.as_ref().is_some_and(|parent| tree.would_cycle(&node, parent)) {
                    return None;
                }
                let siblings = tree.children(parent.as_ref()).len() - usize::from(now == parent);
                Some(Op::TreeMove { id, field, node, parent, index: index.map(|index| index.min(siblings)), was })
            }
            Op::TreeDelete { ref id, ref field, ref node, .. } => {
                let tree = self.tree(id, field).ok()??;
                (tree.contains(node) && tree.children(Some(node)).is_empty()).then_some(op)
            }
            Op::SchemaVersion { .. } => Some(op),
        }
    }
}
