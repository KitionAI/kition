// Copied from kition-sdk crates/kition-kdm/src/batch.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Object-model batches (`KitObjectModel 1.0`, standard 2.0 section 10.2): the wire form scripts,
//! extensions, and embedders edit a document with, interpreted over a [`Tx`].
//!
//! A batch is `{ "origin"?, "ops": [...], "load"?: [...] }`. Runs of model operations become one
//! transaction each; `command` operations go to the kit between them ([`BatchTarget::command`]).
//! `$`-prefixed references bind the ids of objects the batch creates; a string equal to a bound
//! reference, anywhere in an operation's values or a command's parameters, becomes its id. Text
//! positions count Unicode scalar values (rule M18). The TypeScript twin is `@kition/kdm`'s
//! `batch.ts`; both run the fixtures in `tests/fixtures/batch.json`.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::{Map, Value, json};

use crate::{FieldKind, KdmError, ObjectId, Origin, OriginKind, Replica, Schema, Tx};

/// The capability set a batch implements.
pub const CAPABILITY: &str = "KitObjectModel 1.0";

/// Why a batch failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BatchErrorCode {
    /// The batch or an operation is malformed.
    InvalidOp,
    /// A target, reference, or object does not exist.
    NotFound,
    /// The KDM refused a value, a field, or an index.
    InvalidValue,
    /// The document is read-only and the batch writes, or an operation writes an object or a
    /// field the schema marks read-only (rule OM8).
    ReadOnly,
    /// A command failed.
    CommandFailed,
}

impl BatchErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidOp => "invalid-op",
            Self::NotFound => "not-found",
            Self::InvalidValue => "invalid-value",
            Self::ReadOnly => "read-only",
            Self::CommandFailed => "command-failed",
        }
    }
}

/// A failed batch: the code, the index of the operation that failed (none for the batch as a
/// whole or a `load` entry), and a message.
#[derive(Clone, Debug, PartialEq)]
pub struct BatchError {
    pub code: BatchErrorCode,
    pub index: Option<usize>,
    pub message: String,
}

impl BatchError {
    pub fn new(code: BatchErrorCode, index: Option<usize>, message: impl Into<String>) -> Self {
        Self { code, index, message: message.into() }
    }

    fn op(index: usize, message: impl Into<String>) -> Self {
        Self::new(BatchErrorCode::InvalidOp, Some(index), message)
    }

    fn kdm(index: Option<usize>, error: KdmError) -> Self {
        let code = if matches!(error, KdmError::NotFound(_)) { BatchErrorCode::NotFound } else { BatchErrorCode::InvalidValue };
        Self::new(code, index, error.to_string())
    }

    /// `{ "code", "index", "message" }`.
    pub fn to_json(&self) -> Value {
        json!({ "code": self.code.as_str(), "index": self.index, "message": self.message })
    }
}

impl fmt::Display for BatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.index {
            Some(index) => write!(f, "{} (op {index}): {}", self.code.as_str(), self.message),
            None => write!(f, "{}: {}", self.code.as_str(), self.message),
        }
    }
}

impl std::error::Error for BatchError {}

/// What a batch runs against: a replica that takes transactions, and a kit that runs commands.
pub trait BatchTarget {
    /// The replica reads come from, current with the document.
    fn replica(&mut self) -> Result<&Replica, BatchError>;
    /// Runs `write` as one transaction with `origin`; nothing changes when it fails.
    fn transact(&mut self, origin: &Origin, write: &mut dyn FnMut(&mut Tx<'_>) -> Result<(), BatchError>) -> Result<(), BatchError>;
    /// Runs a kit command as `origin`; answers its result.
    fn command(&mut self, id: &str, params: Value, origin: &Origin) -> Result<Value, String>;
    /// Whether the document refuses writes.
    fn read_only(&self) -> bool {
        false
    }
}

/// A [`Replica`] as a [`BatchTarget`] without commands (tests, servers holding a plain replica).
pub struct ReplicaTarget<'a>(pub &'a mut Replica);

impl BatchTarget for ReplicaTarget<'_> {
    fn replica(&mut self) -> Result<&Replica, BatchError> {
        Ok(self.0)
    }

    fn transact(&mut self, origin: &Origin, write: &mut dyn FnMut(&mut Tx<'_>) -> Result<(), BatchError>) -> Result<(), BatchError> {
        transact_replica(self.0, origin, write)
    }

    fn command(&mut self, id: &str, _params: Value, _origin: &Origin) -> Result<Value, String> {
        Err(format!("unknown command `{id}`: this document runs no commands"))
    }
}

/// [`Replica::transact`] with a writer that fails with a [`BatchError`].
pub fn transact_replica(replica: &mut Replica, origin: &Origin, write: &mut dyn FnMut(&mut Tx<'_>) -> Result<(), BatchError>) -> Result<(), BatchError> {
    let mut failed = None;
    let result = replica.transact(origin, |tx| {
        write(tx).map_err(|error| {
            failed = Some(error);
            KdmError::Engine("the batch failed".into())
        })
    });
    match (result, failed) {
        (_, Some(error)) => Err(error),
        (Ok(()), None) => Ok(()),
        (Err(error), None) => Err(BatchError::kdm(None, error)),
    }
}

/// The operations a batch takes, by name, and whether each writes.
const OPS: &[(&str, bool)] = &[
    ("create", true),
    ("set", true),
    ("delete", true),
    ("text.insert", true),
    ("text.delete", true),
    ("text.set", true),
    ("text.mark", true),
    ("text.unmark", true),
    ("list.insert", true),
    ("list.move", true),
    ("list.remove", true),
    ("map.set", true),
    ("map.delete", true),
    ("tree.insert", true),
    ("tree.move", true),
    ("command", true),
];

/// The origin of a batch: `{ kind, principal, label? }`, `extension`/`script` when absent. Only
/// `person`, `agent`, and `extension` may write through the object model.
pub fn parse_origin(value: Option<&Value>) -> Result<Origin, BatchError> {
    let Some(value) = value.filter(|value| !value.is_null()) else { return Ok(Origin::new(OriginKind::Extension, "script")) };
    let bad = || BatchError::new(BatchErrorCode::InvalidOp, None, "origin is { kind: person | agent | extension, principal, label? }");
    let kind = value.get("kind").and_then(Value::as_str).and_then(OriginKind::parse).ok_or_else(bad)?;
    if !matches!(kind, OriginKind::Person | OriginKind::Agent | OriginKind::Extension) {
        return Err(bad());
    }
    let principal = value.get("principal").and_then(Value::as_str).ok_or_else(bad)?;
    let mut origin = Origin::new(kind, principal);
    match value.get("label") {
        None | Some(Value::Null) => {}
        Some(Value::String(label)) => origin = origin.with_label(label.clone()),
        Some(_) => return Err(bad()),
    }
    Ok(origin)
}

/// The references a batch bound, by name.
type Refs = BTreeMap<String, ObjectId>;

/// Runs a batch request against `target`; answers `{ refs, results, loaded }`.
pub fn run(target: &mut dyn BatchTarget, request: &Value) -> Result<Value, BatchError> {
    let request = request.as_object().ok_or_else(|| BatchError::new(BatchErrorCode::InvalidOp, None, "a batch is an object"))?;
    let origin = parse_origin(request.get("origin"))?;
    let ops = list(request.get("ops"), "ops")?;
    let loads = list(request.get("load"), "load")?;
    let mut writes = false;
    for (index, op) in ops.iter().enumerate() {
        let name = op_name(index, op)?;
        writes |= OPS.iter().any(|(known, write)| *known == name && *write);
    }
    if writes && target.read_only() {
        return Err(BatchError::new(BatchErrorCode::ReadOnly, None, "the document is read-only"));
    }
    let schema = target.replica()?.schema().clone();
    let mut refs = Refs::new();
    let mut results = vec![Value::Null; ops.len()];
    let mut index = 0;
    while index < ops.len() {
        let op = ops.get(index).ok_or_else(|| BatchError::op(index, "missing"))?;
        if op_name(index, op)? == "command" {
            let id = op.get("id").and_then(Value::as_str).ok_or_else(|| BatchError::op(index, "a command needs an `id`"))?;
            let params = op.get("params").map_or_else(|| Value::Object(Map::new()), |params| resolve_values(params, &refs));
            let result = target.command(id, params, &origin).map_err(|message| BatchError::new(BatchErrorCode::CommandFailed, Some(index), message))?;
            if let Some(slot) = results.get_mut(index) {
                *slot = result;
            }
            index += 1;
            continue;
        }
        let start = index;
        while ops.get(index).is_some_and(|op| op.get("op").and_then(Value::as_str) != Some("command")) {
            index += 1;
        }
        let mut staged_refs = refs.clone();
        let mut staged: Vec<Value> = Vec::new();
        let mut root: Option<ObjectId> = None;
        target.transact(&origin, &mut |tx| {
            staged.clear();
            staged_refs.clone_from(&refs);
            for at in start..index {
                let op = ops.get(at).ok_or_else(|| BatchError::op(at, "missing"))?;
                staged.push(apply(tx, &schema, at, op, &mut staged_refs, &mut root)?);
            }
            Ok(())
        })?;
        refs = staged_refs;
        for (offset, value) in staged.into_iter().enumerate() {
            if let Some(slot) = results.get_mut(start + offset) {
                *slot = value;
            }
        }
    }
    let replica = target.replica()?;
    let mut loaded = Vec::with_capacity(loads.len());
    for (at, entry) in loads.iter().enumerate() {
        loaded.push(load(replica, entry, &refs).map_err(|error| BatchError { message: format!("load {at}: {}", error.message), ..error })?);
    }
    let refs: Map<String, Value> = refs.into_iter().map(|(name, id)| (name, Value::String(id.to_string()))).collect();
    Ok(json!({ "refs": refs, "results": results, "loaded": loaded }))
}

fn list<'a>(value: Option<&'a Value>, name: &str) -> Result<&'a [Value], BatchError> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(BatchError::new(BatchErrorCode::InvalidOp, None, format!("`{name}` is an array"))),
    }
}

fn op_name(index: usize, op: &Value) -> Result<&str, BatchError> {
    let name = op.get("op").and_then(Value::as_str).ok_or_else(|| BatchError::op(index, "an operation is an object with an `op`"))?;
    if OPS.iter().any(|(known, _)| *known == name) { Ok(name) } else { Err(BatchError::op(index, format!("unknown operation `{name}`"))) }
}

/// `value` with every string equal to a bound reference replaced by its id.
pub fn resolve_values(value: &Value, refs: &BTreeMap<String, ObjectId>) -> Value {
    match value {
        Value::String(text) => refs.get(text).map_or_else(|| value.clone(), |id| Value::String(id.to_string())),
        Value::Array(items) => Value::Array(items.iter().map(|item| resolve_values(item, refs)).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, item)| (key.clone(), resolve_values(item, refs))).collect()),
        other => other.clone(),
    }
}

/// The id a target names: `root`, a bound `$reference`, or an object id.
fn target_id(text: &str, refs: &Refs, root: impl FnOnce() -> Option<ObjectId>, index: Option<usize>) -> Result<ObjectId, BatchError> {
    if text == "root" {
        return root().ok_or_else(|| BatchError::new(BatchErrorCode::NotFound, index, "the document has no root object"));
    }
    if text.starts_with('$') {
        return refs.get(text).cloned().ok_or_else(|| BatchError::new(BatchErrorCode::NotFound, index, format!("`{text}` is not bound in this batch")));
    }
    if text.is_empty() {
        return Err(BatchError::new(BatchErrorCode::InvalidOp, index, "a target is not empty"));
    }
    Ok(ObjectId::from_string(text))
}

/// The root object: the first object of the schema's root type.
pub fn root_id(replica: &Replica) -> Option<ObjectId> {
    replica.objects_of_type(&replica.schema().root).into_iter().next()
}

fn str_field<'a>(index: usize, op: &'a Value, key: &str) -> Result<&'a str, BatchError> {
    op.get(key).and_then(Value::as_str).ok_or_else(|| BatchError::op(index, format!("`{key}` is a string")))
}

fn usize_field(index: usize, op: &Value, key: &str) -> Result<usize, BatchError> {
    op.get(key).and_then(Value::as_u64).and_then(|value| usize::try_from(value).ok()).ok_or_else(|| BatchError::op(index, format!("`{key}` is a whole number")))
}

/// `"end"`, absent, or an index; `len` is the list's length.
fn position(index: usize, value: Option<&Value>, len: usize) -> Result<usize, BatchError> {
    match value {
        None | Some(Value::Null) => Ok(len),
        Some(Value::String(end)) if end == "end" => Ok(len),
        Some(value) => value.as_u64().and_then(|at| usize::try_from(at).ok()).ok_or_else(|| BatchError::op(index, "`at` is \"end\" or a whole number")),
    }
}

/// Refuses (`read-only`) a write to `id`, or to its `field`, that the schema keeps from the
/// object model (rule OM8): a read-only type, an object its `readOnlyWhen` names, or a read-only
/// field. An unknown object or field is left to the operation, which reports it.
fn guard(tx: &Tx<'_>, schema: &Schema, index: usize, id: &ObjectId, field: Option<&str>) -> Result<(), BatchError> {
    let Ok(ty) = tx.object_type(id) else { return Ok(()) };
    let Ok(def) = schema.type_def(&ty) else { return Ok(()) };
    if def.object_read_only(|name| tx.get(id, name).ok()) {
        return Err(BatchError::new(BatchErrorCode::ReadOnly, Some(index), format!("`{id}` is a read-only `{ty}`: the kit keeps it as it is")));
    }
    if let Some(field) = field
        && def.fields.get(field).is_some_and(|def| def.read_only)
    {
        return Err(BatchError::new(BatchErrorCode::ReadOnly, Some(index), format!("`{ty}.{field}` is read-only: the kit keeps it as it is")));
    }
    Ok(())
}

/// Refuses (`read-only`) a new object of type `ty` with `fields` that would be read-only, or
/// that gives a read-only field a value (rule OM8).
fn guard_new(schema: &Schema, index: usize, ty: &str, fields: &Map<String, Value>) -> Result<(), BatchError> {
    let Ok(def) = schema.type_def(ty) else { return Ok(()) };
    if def.object_read_only(|name| fields.get(name).cloned()) {
        return Err(BatchError::new(BatchErrorCode::ReadOnly, Some(index), format!("a new `{ty}` would be read-only: only the kit makes one")));
    }
    if let Some((name, _)) = fields.iter().find(|(name, value)| !value.is_null() && def.fields.get(name.as_str()).is_some_and(|def| def.read_only)) {
        return Err(BatchError::new(BatchErrorCode::ReadOnly, Some(index), format!("`{ty}.{name}` is read-only: the kit keeps it as it is")));
    }
    Ok(())
}

fn apply(tx: &mut Tx<'_>, schema: &Schema, index: usize, op: &Value, refs: &mut Refs, root: &mut Option<ObjectId>) -> Result<Value, BatchError> {
    let kdm = |error: KdmError| BatchError::kdm(Some(index), error);
    let mut target = |key: &str, refs: &Refs, tx: &Tx<'_>| -> Result<ObjectId, BatchError> {
        let text = str_field(index, op, key)?;
        target_id(
            text,
            refs,
            || {
                if root.is_none() {
                    *root = tx.objects_of_type(&schema.root).into_iter().next();
                }
                root.clone()
            },
            Some(index),
        )
    };
    let name = op_name(index, op)?;
    match name {
        "create" => {
            let ty = str_field(index, op, "type")?;
            let fields = match op.get("fields") {
                None | Some(Value::Null) => Map::new(),
                Some(Value::Object(fields)) => fields.iter().map(|(key, value)| (key.clone(), resolve_values(value, refs))).collect(),
                Some(_) => return Err(BatchError::op(index, "`fields` is an object")),
            };
            let reference = match op.get("ref") {
                None | Some(Value::Null) => None,
                Some(Value::String(name)) if name.len() > 1 && name.starts_with('$') => Some(name.clone()),
                Some(_) => return Err(BatchError::op(index, "`ref` is a name starting with `$`")),
            };
            let container = match op.get("in") {
                None | Some(Value::Null) => None,
                Some(Value::String(path)) => {
                    let (owner, field) = path.rsplit_once('.').ok_or_else(|| BatchError::op(index, "`in` is \"<target>.<field>\""))?;
                    let resolved = target_id(
                        owner,
                        refs,
                        || {
                            if root.is_none() {
                                *root = tx.objects_of_type(&schema.root).into_iter().next();
                            }
                            root.clone()
                        },
                        Some(index),
                    )?;
                    Some((resolved, field.to_owned()))
                }
                Some(_) => return Err(BatchError::op(index, "`in` is \"<target>.<field>\"")),
            };
            guard_new(schema, index, ty, &fields)?;
            let id = match op.get("id") {
                None | Some(Value::Null) => tx.create(ty, fields).map_err(kdm)?,
                Some(Value::String(id)) => tx.create_with_id(ty, &ObjectId::from_string(id.clone()), fields).map_err(kdm)?,
                Some(_) => return Err(BatchError::op(index, "`id` is a string")),
            };
            if let Some((owner, field)) = container {
                let owner_type = tx.object_type(&owner).map_err(kdm)?;
                let def = schema.field(&owner_type, &field).map_err(kdm)?;
                guard(tx, schema, index, &owner, Some(&field))?;
                match def.kind {
                    FieldKind::List => {
                        let len = tx.list_items(&owner, &field).map_err(kdm)?.len();
                        let at = position(index, op.get("at"), len)?;
                        tx.list_insert(&owner, &field, at, &id).map_err(kdm)?;
                    }
                    FieldKind::Tree => {
                        if !matches!(op.get("at"), None | Some(Value::Null)) && op.get("at").and_then(Value::as_str) != Some("end") {
                            return Err(BatchError::op(index, "`at` places items in lists; a tree adds a node last among its siblings"));
                        }
                        let parent = tree_parent(tx, refs, root, schema, index, op, &owner, &field)?;
                        tx.tree_create(&owner, &field, parent.as_ref(), &id).map_err(kdm)?;
                    }
                    _ => return Err(BatchError::op(index, format!("`{owner_type}.{field}` is not a list or a tree; create objects in lists and trees"))),
                }
            } else if !matches!(op.get("parent"), None | Some(Value::Null)) {
                return Err(BatchError::op(index, "`parent` places an object in a tree: give `in` too"));
            }
            if let Some(reference) = reference {
                refs.insert(reference, id.clone());
            }
            Ok(Value::String(id.to_string()))
        }
        "set" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            let value = op.get("value").map_or(Value::Null, |value| resolve_values(value, refs));
            guard(tx, schema, index, &id, Some(field))?;
            // A value that would make the object read-only is the kit's to write.
            if let Ok(ty) = tx.object_type(&id)
                && let Ok(def) = schema.type_def(&ty)
                && def.read_only_when.as_ref().is_some_and(|when| when.field == field)
                && def.object_read_only(|name| if name == field { Some(value.clone()) } else { tx.get(&id, name).ok() })
            {
                return Err(BatchError::new(BatchErrorCode::ReadOnly, Some(index), format!("`{ty}.{field}` would make `{id}` read-only: only the kit does")));
            }
            tx.set(&id, field, value).map_err(kdm)?;
            Ok(Value::Null)
        }
        "delete" => {
            let id = target("target", refs, tx)?;
            let ty = tx.object_type(&id).map_err(kdm)?;
            guard(tx, schema, index, &id, None)?;
            // Drop the object from every list holding it, so no list keeps a dangling entry.
            for (owner_type, def) in &schema.types {
                for (field, field_def) in &def.fields {
                    if field_def.kind != FieldKind::List || field_def.of.as_deref() != Some(ty.as_str()) {
                        continue;
                    }
                    for owner in tx.objects_of_type(owner_type) {
                        let items = tx.list_items(&owner, field).map_err(kdm)?;
                        if items.contains(&id) {
                            guard(tx, schema, index, &owner, Some(field))?;
                        }
                        for at in items.iter().enumerate().filter(|(_, item)| **item == id).map(|(at, _)| at).rev().collect::<Vec<_>>() {
                            tx.list_remove(&owner, field, at).map_err(kdm)?;
                        }
                    }
                }
            }
            // A tree keeps the node of a deleted object (readers skip it), but not over live children.
            for (owner_type, def) in &schema.types {
                for (field, field_def) in &def.fields {
                    if field_def.kind != FieldKind::Tree || field_def.of.as_deref().is_some_and(|of| of != ty) {
                        continue;
                    }
                    for owner in tx.objects_of_type(owner_type) {
                        let entries = tx.tree(&owner, field).map_err(kdm)?;
                        let mine: Vec<&crate::NodeRef> = entries.iter().filter(|entry| entry.object == id).map(|entry| &entry.node).collect();
                        if entries.iter().any(|entry| entry.parent.as_ref().is_some_and(|parent| mine.contains(&parent)) && tx.exists(&entry.object)) {
                            return Err(BatchError::new(
                                BatchErrorCode::InvalidValue,
                                Some(index),
                                format!("`{id}` has children in `{owner}.{field}`: delete or move them first"),
                            ));
                        }
                    }
                }
            }
            tx.delete(&id).map_err(kdm)?;
            Ok(Value::Null)
        }
        "tree.insert" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, index, &id, Some(field))?;
            let item = target("item", refs, tx)?;
            if live_node(tx, &id, field, &item).map_err(kdm)?.is_some() {
                return Err(BatchError::new(
                    BatchErrorCode::InvalidValue,
                    Some(index),
                    format!("`{item}` is already in `{id}.{field}`: move it with tree.move"),
                ));
            }
            let parent = tree_parent(tx, refs, root, schema, index, op, &id, field)?;
            tx.tree_create(&id, field, parent.as_ref(), &item).map_err(kdm)?;
            Ok(Value::Null)
        }
        "tree.move" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, index, &id, Some(field))?;
            let item = target("item", refs, tx)?;
            let node = live_node(tx, &id, field, &item)
                .map_err(kdm)?
                .ok_or_else(|| BatchError::new(BatchErrorCode::NotFound, Some(index), format!("`{item}` is not in `{id}.{field}`")))?;
            let parent = tree_parent(tx, refs, root, schema, index, op, &id, field)?;
            tx.tree_move(&id, field, &node, parent.as_ref()).map_err(kdm)?;
            Ok(Value::Null)
        }
        "text.insert" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, index, &id, Some(field))?;
            tx.text_insert(&id, field, usize_field(index, op, "index")?, str_field(index, op, "text")?).map_err(kdm)?;
            Ok(Value::Null)
        }
        "text.delete" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, index, &id, Some(field))?;
            tx.text_delete(&id, field, usize_field(index, op, "index")?, usize_field(index, op, "count")?).map_err(kdm)?;
            Ok(Value::Null)
        }
        "text.set" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, index, &id, Some(field))?;
            let text = str_field(index, op, "text")?;
            let len = tx.text_len(&id, field).map_err(kdm)?;
            if len > 0 {
                tx.text_delete(&id, field, 0, len).map_err(kdm)?;
            }
            if !text.is_empty() {
                tx.text_insert(&id, field, 0, text).map_err(kdm)?;
            }
            Ok(Value::Null)
        }
        "text.mark" | "text.unmark" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, index, &id, Some(field))?;
            let (start, end) = (usize_field(index, op, "start")?, usize_field(index, op, "end")?);
            let key = str_field(index, op, "key")?;
            if name == "text.mark" {
                let value = op.get("value").cloned().unwrap_or(Value::Null);
                tx.text_mark(&id, field, start, end, key, value).map_err(kdm)?;
            } else {
                tx.text_unmark(&id, field, start, end, key).map_err(kdm)?;
            }
            Ok(Value::Null)
        }
        "list.insert" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, index, &id, Some(field))?;
            let item = target("item", refs, tx)?;
            let len = tx.list_items(&id, field).map_err(kdm)?.len();
            let at = position(index, op.get("index"), len)?;
            tx.list_insert(&id, field, at, &item).map_err(kdm)?;
            Ok(Value::Null)
        }
        "list.move" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, index, &id, Some(field))?;
            tx.list_move(&id, field, usize_field(index, op, "from")?, usize_field(index, op, "to")?).map_err(kdm)?;
            Ok(Value::Null)
        }
        "list.remove" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, index, &id, Some(field))?;
            tx.list_remove(&id, field, usize_field(index, op, "index")?).map_err(kdm)?;
            Ok(Value::Null)
        }
        "map.set" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, index, &id, Some(field))?;
            let value = op.get("value").map_or(Value::Null, |value| resolve_values(value, refs));
            tx.map_set(&id, field, str_field(index, op, "key")?, value).map_err(kdm)?;
            Ok(Value::Null)
        }
        "map.delete" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, index, &id, Some(field))?;
            tx.map_delete(&id, field, str_field(index, op, "key")?).map_err(kdm)?;
            Ok(Value::Null)
        }
        other => Err(BatchError::op(index, format!("`{other}` is not a model operation"))),
    }
}

/// The node of a tree field naming `object`, when `object` exists (the node of a deleted object
/// is skipped, as readers skip it).
fn live_node(tx: &Tx<'_>, id: &ObjectId, field: &str, object: &ObjectId) -> Result<Option<crate::NodeRef>, KdmError> {
    if !tx.exists(object) {
        return Ok(None);
    }
    Ok(tx.tree(id, field)?.into_iter().find(|entry| entry.object == *object).map(|entry| entry.node))
}

/// The node an operation's `parent` names in a tree (`None`: absent or `null`, a root).
#[allow(clippy::too_many_arguments)]
fn tree_parent(
    tx: &Tx<'_>,
    refs: &Refs,
    root: &mut Option<ObjectId>,
    schema: &Schema,
    index: usize,
    op: &Value,
    id: &ObjectId,
    field: &str,
) -> Result<Option<crate::NodeRef>, BatchError> {
    let text = match op.get("parent") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(text)) => text,
        Some(_) => return Err(BatchError::op(index, "`parent` is an object or null")),
    };
    let parent = target_id(
        text,
        refs,
        || {
            if root.is_none() {
                *root = tx.objects_of_type(&schema.root).into_iter().next();
            }
            root.clone()
        },
        Some(index),
    )?;
    live_node(tx, id, field, &parent)
        .map_err(|error| BatchError::kdm(Some(index), error))?
        .map(Some)
        .ok_or_else(|| BatchError::new(BatchErrorCode::NotFound, Some(index), format!("the parent `{parent}` is not in `{id}.{field}`")))
}

/// One `load` entry: `{ target, fields? }` → `{ id, type, fields }`.
fn load(replica: &Replica, entry: &Value, refs: &Refs) -> Result<Value, BatchError> {
    let text = entry.get("target").and_then(Value::as_str).ok_or_else(|| BatchError::new(BatchErrorCode::InvalidOp, None, "`target` is a string"))?;
    let id = target_id(text, refs, || root_id(replica), None)?;
    let ty = replica.object_type(&id).map_err(|error| BatchError::kdm(None, error))?;
    let def = replica.schema().type_def(&ty).map_err(|error| BatchError::kdm(None, error))?;
    let names: Vec<String> = match entry.get("fields") {
        None | Some(Value::Null) => def.fields.keys().cloned().collect(),
        Some(Value::Array(names)) => names
            .iter()
            .map(|name| name.as_str().map(str::to_owned).ok_or_else(|| BatchError::new(BatchErrorCode::InvalidOp, None, "`fields` lists names")))
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(BatchError::new(BatchErrorCode::InvalidOp, None, "`fields` lists names")),
    };
    let mut fields = Map::new();
    for name in names {
        if name == "id" || name == "type" {
            continue;
        }
        fields.insert(name.clone(), read_field(replica, &id, &ty, &name)?);
    }
    Ok(json!({ "id": id.to_string(), "type": ty, "fields": fields }))
}

/// One field as `load` answers it.
pub fn read_field(replica: &Replica, id: &ObjectId, ty: &str, name: &str) -> Result<Value, BatchError> {
    let error = |error: KdmError| BatchError::kdm(None, error);
    let def = replica.schema().field(ty, name).map_err(error)?;
    Ok(match def.kind {
        FieldKind::Text if def.has_marks() => Value::Array(replica.text_delta(id, name).map_err(error)?.iter().map(crate::TextRun::to_json).collect()),
        FieldKind::Text => Value::String(replica.text(id, name).map_err(error)?),
        FieldKind::List => Value::Array(replica.list(id, name).map_err(error)?.into_iter().map(|item| Value::String(item.to_string())).collect()),
        FieldKind::Map => Value::Object(replica.map_entries(id, name).map_err(error)?.into_iter().collect()),
        FieldKind::Tree => {
            // The nodes of deleted objects are skipped with their subtrees, as kits read them.
            let mut entries: Vec<crate::TreeEntry> = Vec::new();
            for entry in replica.tree(id, name).map_err(error)? {
                let parent_kept = entry.parent.as_ref().is_none_or(|parent| entries.iter().any(|kept| kept.node == *parent));
                if parent_kept && replica.exists(&entry.object) {
                    entries.push(entry);
                }
            }
            let object_of = |node: &crate::NodeRef| entries.iter().find(|entry| entry.node == *node).map(|entry| Value::String(entry.object.to_string()));
            Value::Array(
                entries
                    .iter()
                    .map(|entry| json!({ "object": entry.object.to_string(), "parent": entry.parent.as_ref().and_then(object_of).unwrap_or(Value::Null) }))
                    .collect(),
            )
        }
        _ => replica.get(id, name).map_err(error)?,
    })
}

fn kind_name(kind: FieldKind) -> &'static str {
    match kind {
        FieldKind::String => "string",
        FieldKind::Number => "number",
        FieldKind::Integer => "integer",
        FieldKind::Boolean => "boolean",
        FieldKind::Enum => "enum",
        FieldKind::Json => "json",
        FieldKind::Blob => "blob",
        FieldKind::Ref => "ref",
        FieldKind::Text => "text",
        FieldKind::List => "list",
        FieldKind::Tree => "tree",
        FieldKind::Map => "map",
    }
}

/// The schema as `model/describe` answers it, without the commands (the kit adds them):
/// `{ capability, kit, schemaVersion, root, rootId, types }`.
pub fn describe(replica: &Replica) -> Value {
    let schema = replica.schema();
    let types: Map<String, Value> = schema
        .types
        .iter()
        .map(|(ty, def)| {
            let fields: Map<String, Value> = def
                .fields
                .iter()
                .map(|(name, field)| {
                    let mut out = Map::new();
                    out.insert("kind".into(), Value::String(kind_name(field.kind).into()));
                    if let Some(of) = &field.of {
                        out.insert("of".into(), Value::String(of.clone()));
                    }
                    if !field.values.is_empty() {
                        out.insert("values".into(), json!(field.values));
                    }
                    if field.optional {
                        out.insert("optional".into(), Value::Bool(true));
                    }
                    if !field.marks.is_empty() {
                        out.insert("marks".into(), json!(field.marks.keys().collect::<Vec<_>>()));
                    }
                    if field.read_only {
                        out.insert("readOnly".into(), Value::Bool(true));
                    }
                    (name.clone(), Value::Object(out))
                })
                .collect();
            let mut out = Map::new();
            out.insert("fields".into(), Value::Object(fields));
            if def.read_only {
                out.insert("readOnly".into(), Value::Bool(true));
            }
            if let Some(when) = &def.read_only_when {
                out.insert("readOnlyWhen".into(), json!({ "field": when.field, "values": when.values }));
            }
            (ty.clone(), Value::Object(out))
        })
        .collect();
    json!({
        "capability": CAPABILITY,
        "kit": schema.kit,
        "schemaVersion": schema.schema_version,
        "root": schema.root,
        "rootId": root_id(replica).map(|id| id.to_string()),
        "types": types,
    })
}
