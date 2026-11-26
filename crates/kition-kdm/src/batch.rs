// Copied from kition-sdk crates/kition-kdm/src/batch.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Object-model batches (`KitObjectModel 1.0`, Kition platform `docs/platform/sets/object-model.md`): the wire form scripts,
//! extensions, and embedders edit a document with, interpreted over a [`Tx`].
//!
//! A batch is `{ "origin"?, "ops": [...], "load"?: [...] }`. Runs of model operations become one
//! transaction each; `command` operations go to the kit between them ([`BatchTarget::command`]).
//! `$`-prefixed references bind the ids of objects the batch creates; a string equal to a bound
//! reference, anywhere in an operation's values or a command's parameters, becomes its id. Text
//! positions count Unicode scalar values (rule M18). Where the schema declares tool ids (rule OM9,
//! [`crate::tool_ids`]), objects are answered and taken by them. The TypeScript twin is `@kition/kdm`'s
//! `batch.ts`; both run the fixtures in `tests/fixtures/batch.json`.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde_json::{Map, Value, json};

use crate::tool_ids::{ToolIds, Unresolved};
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

/// Per-object limits, evaluated against the current registers and maps at a concrete path.
pub type ValueLimits = Box<dyn Fn(&Value, &str) -> Option<crate::NumberLimits>>;

/// What a batch runs against: a replica that takes transactions, and a kit that runs commands.
pub trait BatchTarget {
    /// Complete computed objects for the current state, using their public tool ids.
    fn projected_objects(&mut self) -> Result<Vec<crate::projection::ProjectedObject>, BatchError> {
        Err(BatchError::new(BatchErrorCode::InvalidValue, None, "this adapter cannot read declared projected objects"))
    }
    /// An owned callback evaluated against each edited object's current registers and maps.
    fn value_limits(&mut self) -> Option<ValueLimits> {
        None
    }
    /// The replica reads come from, current with the document.
    fn replica(&mut self) -> Result<&Replica, BatchError>;
    /// Runs `write` as one transaction with `origin`; nothing changes when it fails.
    fn transact(&mut self, origin: &Origin, write: &mut dyn FnMut(&mut Tx<'_>) -> Result<(), BatchError>) -> Result<(), BatchError>;
    /// Runs a kit command as `origin`; answers its result.
    fn command(&mut self, id: &str, params: Value, origin: &Origin) -> Result<Value, String>;
    /// Runs a command with explicit editor context. Adapters must apply it or refuse it.
    fn command_at(&mut self, id: &str, params: Value, context: &Value, origin: &Origin) -> Result<Value, String> {
        if context.as_object().is_some_and(|context| !context.is_empty()) {
            return Err("this batch adapter cannot apply explicit command context".into());
        }
        self.command(id, params, origin)
    }
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
    if request.get("objects").is_some_and(|value| !value.is_boolean()) {
        return Err(BatchError::new(BatchErrorCode::InvalidOp, None, "`objects` is a boolean"));
    }
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
    // Tool ids (rule OM9): objects are named as the kit's tools name them, read again before each
    // run of operations and after the last, since the kit numbers what a batch creates (the
    // replica reads them once per state, `Replica::tool_ids`).
    let tool_ids = schema.has_tool_ids();
    let names_of = |target: &mut dyn BatchTarget| -> Result<std::sync::Arc<ToolIds>, BatchError> {
        Ok(if tool_ids { target.replica()?.tool_ids() } else { std::sync::Arc::new(ToolIds::default()) })
    };
    let mut refs = Refs::new();
    let mut results = vec![Value::Null; ops.len()];
    let projections = crate::projection::declared(&schema);
    let projected_route = |target: &mut dyn BatchTarget, op: &Value, refs: &Refs| -> Result<Option<crate::projection::Routed>, BatchError> {
        if !projections || op["op"] == "command" {
            return Ok(None);
        }
        let objects = target.projected_objects()?;
        let replica = target.replica()?;
        let names = replica.tool_ids();
        let root = root_id(replica).map(|id| names.show(&id)).unwrap_or_default();
        let view = crate::projection::View::read(replica, objects)?;
        crate::projection::route(&schema, &view, &root, &resolve_values(op, refs))
    };
    let mut index = 0;
    while index < ops.len() {
        let op = ops.get(index).ok_or_else(|| BatchError::op(index, "missing"))?;
        if let Some(routed) = projected_route(target, op, &refs).map_err(|error| BatchError { index: Some(index), ..error })? {
            if routed.creates.is_some()
                && op.get("ref").is_some_and(|value| value.as_str().is_none_or(|name| !name.starts_with('$') || refs.contains_key(name)))
            {
                return Err(BatchError::op(index, "a projected create ref starts with $ and is unique"));
            }
            let result = target
                .command(&routed.command, routed.params, &origin)
                .map_err(|message| BatchError::new(BatchErrorCode::CommandFailed, Some(index), message))?;
            if let Some(ty) = routed.creates {
                let id = result
                    .as_str()
                    .or_else(|| result.get("id").and_then(Value::as_str))
                    .ok_or_else(|| BatchError::op(index, "a projected create command must return its id"))?;
                if !target.projected_objects()?.iter().any(|object| object.id == id && object.ty == ty) {
                    return Err(BatchError::op(index, "a projected create command returned no live object of its type"));
                }
                if let Some(name) = op.get("ref").and_then(Value::as_str) {
                    refs.insert(name.to_owned(), ObjectId::from_string(id));
                }
            }
            if let Some(slot) = results.get_mut(index) {
                *slot = result;
            }
            index += 1;
            continue;
        }
        if op_name(index, op)? == "command" {
            let id = op.get("id").and_then(Value::as_str).ok_or_else(|| BatchError::op(index, "a command needs an `id`"))?;
            let params = match op.get("params") {
                None => Value::Object(Map::new()),
                // A command takes the kit's own ids: a bound reference becomes the object's tool id.
                Some(params) if tool_ids && !refs.is_empty() => {
                    let names = names_of(target)?;
                    let shown: Refs = refs.iter().map(|(name, id)| (name.clone(), ObjectId::from_string(names.show(id)))).collect();
                    resolve_values(params, &shown)
                }
                Some(params) => resolve_values(params, &refs),
            };
            let mut context = Map::new();
            let context_refs = if tool_ids && !refs.is_empty() {
                let names = names_of(target)?;
                refs.iter().map(|(name, id)| (name.clone(), ObjectId::from_string(names.show(id)))).collect()
            } else {
                refs.clone()
            };
            if let Some(on) = op.get("on") {
                context.insert("on".into(), resolve_values(on, &context_refs));
            }
            for key in ["part", "time"] {
                if let Some(value) = op.get("at").and_then(|at| at.get(key)) {
                    context.insert(key.into(), resolve_values(value, &context_refs));
                }
            }
            let result = target
                .command_at(id, params, &Value::Object(context), &origin)
                .map_err(|message| BatchError::new(BatchErrorCode::CommandFailed, Some(index), message))?;
            if let Some(reference) = op.get("ref").and_then(Value::as_str) {
                let id = result
                    .as_str()
                    .or_else(|| result.get("id").and_then(Value::as_str))
                    .ok_or_else(|| BatchError::op(index, "a bound command must return its object id"))?;
                let replica = target.replica()?;
                let resolved =
                    replica.tool_ids().resolve(id, |id| replica.exists(id)).map_err(|_| BatchError::op(index, "a bound command returned no live object"))?;
                refs.insert(reference.to_owned(), resolved);
            }
            if let Some(slot) = results.get_mut(index) {
                *slot = result;
            }
            index += 1;
            continue;
        }
        let start = index;
        while let Some(op) = ops.get(index) {
            if op["op"] == "command" || projected_route(target, op, &refs)?.is_some() {
                break;
            }
            index += 1;
        }
        let names = names_of(target)?;
        let mut staged_refs = refs.clone();
        let mut staged: Vec<Value> = Vec::new();
        let mut root: Option<ObjectId> = None;
        let limits = target.value_limits();
        target.transact(&origin, &mut |tx| {
            staged.clear();
            staged_refs.clone_from(&refs);
            for at in start..index {
                let op = ops.get(at).ok_or_else(|| BatchError::op(at, "missing"))?;
                staged.push(apply(tx, &schema, &names, at, op, &mut staged_refs, &mut root, limits.as_ref())?);
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
    let names = names_of(target)?;
    let projected = if crate::projection::declared(&schema) {
        let objects = target.projected_objects()?;
        Some(crate::projection::View::read(target.replica()?, objects)?)
    } else {
        None
    };
    let limits = target.value_limits();
    let replica = target.replica()?;
    let mut loaded = Vec::with_capacity(loads.len());
    for (at, entry) in loads.iter().enumerate() {
        let read = |entry: &Value| match &projected {
            Some(view) => {
                let text =
                    entry["target"].as_str().ok_or_else(|| BatchError::new(BatchErrorCode::InvalidOp, None, not_a_string("target", entry.get("target"))))?;
                let id = refs.get(text).map_or_else(|| text.to_owned(), ToString::to_string);
                let root = root_id(replica).map(|id| ObjectId::from_string(names.show(&id)));
                view.load(root.as_ref(), &id, entry.get("fields"))
            }
            None => load(replica, &names, entry, &refs),
        };
        let mut object = read(entry).map_err(|error| BatchError { message: format!("load {at}: {}", error.message), ..error })?;
        if let Some(limits) = &limits {
            let full = read(&json!({"target":entry.get("target")}))?;
            let declared: Map<String, Value> = value_paths(object.get("fields").unwrap_or(&Value::Null), "")
                .into_iter()
                .filter_map(|(path, _)| limits(&full, &path).map(|limits| (path, json!(limits))))
                .collect();
            if !declared.is_empty()
                && let Some(object) = object.as_object_mut()
            {
                object.insert("limits".into(), json!(declared));
            }
        }
        loaded.push(object);
    }
    if names.is_active() {
        for result in &mut results {
            *result = names.show_json(result);
        }
    }
    let refs: Map<String, Value> = refs.into_iter().map(|(name, id)| (name, Value::String(names.show(&id)))).collect();
    let mut answer = json!({ "refs": refs, "results": results, "loaded": loaded });
    if request.get("objects") == Some(&Value::Bool(true)) {
        let mut objects = Vec::new();
        for ty in schema.types.keys() {
            objects.extend(replica.objects_of_type(ty).into_iter().map(|id| json!({"id":names.show(&id),"type":ty})));
        }
        if let Some(view) = &projected {
            objects.extend(view.objects.values().map(|object| json!({"id":object.id,"type":object.ty,"projected":true,"at":object.at})));
        }
        objects.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        if let Some(answer) = answer.as_object_mut() {
            answer.insert("objects".into(), json!(objects));
        }
    }
    Ok(answer)
}

/// Concrete scalar paths used for per-object validation and sampling metadata.
pub fn value_paths<'a>(value: &'a Value, prefix: &str) -> Vec<(String, &'a Value)> {
    let path = |part: &str| if prefix.is_empty() { part.to_owned() } else { format!("{prefix}.{part}") };
    match value {
        Value::Object(map) => map.iter().flat_map(|(key, value)| value_paths(value, &path(key))).collect(),
        Value::Array(items) => items.iter().enumerate().flat_map(|(at, value)| value_paths(value, &path(&at.to_string()))).collect(),
        _ => vec![(prefix.to_owned(), value)],
    }
}

fn validate_limits(tx: &Tx<'_>, schema: &Schema, names: &ToolIds, index: usize, id: &ObjectId, limits: Option<&ValueLimits>) -> Result<(), BatchError> {
    let Some(limits) = limits else { return Ok(()) };
    let ty = tx.object_type(id).map_err(|e| BatchError::kdm(Some(index), e))?;
    let mut fields = Map::new();
    for (field, def) in &schema.type_def(&ty).map_err(|e| BatchError::kdm(Some(index), e))?.fields {
        let value = match def.kind {
            FieldKind::Map => tx.map_entries(id, field).map(|entries| json!(entries.into_iter().collect::<Map<_, _>>())),
            kind if kind.is_container() => continue,
            _ => tx.get(id, field),
        }
        .map_err(|e| BatchError::kdm(Some(index), e))?;
        fields.insert(field.clone(), value);
    }
    let object = json!({"id":names.show(id),"type":ty,"fields":fields});
    for (path, value) in value_paths(object.get("fields").unwrap_or(&Value::Null), "") {
        if limits(&object, &path).is_some_and(|limits| !limits.accepts_value(value)) {
            return Err(BatchError::new(
                BatchErrorCode::InvalidValue,
                Some(index),
                format!("`{}.{path}` violates the kit's per-object numeric limits", names.show(id)),
            ));
        }
    }
    Ok(())
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

/// The id a target names: `root`, a bound `$reference`, a tool id (rule OM9), or an object id
/// (for which `exists` holds, when the schema declares tool ids).
fn target_id(
    text: &str,
    refs: &Refs,
    names: &ToolIds,
    exists: impl Fn(&ObjectId) -> bool,
    root: impl FnOnce() -> Option<ObjectId>,
    index: Option<usize>,
) -> Result<ObjectId, BatchError> {
    if text == "root" {
        return root().ok_or_else(|| BatchError::new(BatchErrorCode::NotFound, index, "the document has no root object"));
    }
    if text.starts_with('$') {
        return refs.get(text).cloned().ok_or_else(|| BatchError::new(BatchErrorCode::NotFound, index, format!("`{text}` is not bound in this batch")));
    }
    if text.is_empty() {
        return Err(BatchError::new(BatchErrorCode::InvalidOp, index, "a target is not empty"));
    }
    names.resolve(text, exists).map_err(|unresolved| refused(index, unresolved))
}

/// A target that names no object (`not-found`) or several (`invalid-op`), saying which it may mean
/// (KHP A44, A48).
fn refused(index: Option<usize>, unresolved: Unresolved) -> BatchError {
    match unresolved {
        Unresolved::NotFound(message) => BatchError::new(BatchErrorCode::NotFound, index, message),
        Unresolved::Ambiguous(message) => BatchError::new(BatchErrorCode::InvalidOp, index, message),
    }
}

/// A `ref` field's value given as a tool id, as the object id it names (rule OM9). A value naming
/// no object is left for [`check_refs`] to refuse; one naming several is refused here.
fn ref_value(tx: &Tx<'_>, schema: &Schema, names: &ToolIds, index: usize, ty: &str, field: &str, value: Value) -> Result<Value, BatchError> {
    let Value::String(text) = &value else { return Ok(value) };
    if !names.is_active()
        || text.is_empty()
        || !schema.field(ty, field).is_ok_and(|def| def.kind == FieldKind::Ref || (def.kind == FieldKind::Map && def.of.is_some()))
    {
        return Ok(value);
    }
    match names.resolve(text, |id| tx.exists(id)) {
        Ok(id) => Ok(Value::String(id.to_string())),
        Err(Unresolved::NotFound(_)) => Ok(value),
        Err(unresolved) => Err(refused(Some(index), unresolved)),
    }
}

/// Objects owned by `id`, children before holders; non-owning references are left alone.
fn deletion_order(tx: &Tx<'_>, schema: &Schema, id: &ObjectId, index: usize) -> Result<Vec<ObjectId>, BatchError> {
    let mut pending = vec![(id.clone(), false)];
    let mut seen = BTreeSet::new();
    let mut order = Vec::new();
    while let Some((id, visited)) = pending.pop() {
        if visited {
            order.push(id);
            continue;
        }
        if !tx.exists(&id) || !seen.insert(id.clone()) {
            continue;
        }
        let ty = tx.object_type(&id).map_err(|error| BatchError::kdm(Some(index), error))?;
        pending.push((id.clone(), true));
        for (owner_type, def) in &schema.types {
            for (field, field_def) in &def.fields {
                if !field_def.cascade {
                    continue;
                }
                for owner in tx.objects_of_type(owner_type) {
                    let entries = tx.tree(&owner, field).map_err(|error| BatchError::kdm(Some(index), error))?;
                    let mine: Vec<_> = entries.iter().filter(|entry| entry.object == id).map(|entry| &entry.node).collect();
                    pending.extend(
                        entries
                            .iter()
                            .filter(|entry| entry.parent.as_ref().is_some_and(|parent| mine.contains(&parent)))
                            .map(|entry| (entry.object.clone(), false)),
                    );
                }
            }
        }
        for (field, def) in &schema.type_def(&ty).map_err(|error| BatchError::kdm(Some(index), error))?.fields {
            if !def.owning() {
                continue;
            }
            let held = match def.kind {
                FieldKind::List => tx.list_items(&id, field),
                FieldKind::Tree => tx.tree(&id, field).map(|entries| entries.into_iter().map(|entry| entry.object).collect()),
                FieldKind::Ref => tx.get(&id, field).map(|value| value.as_str().map(ObjectId::from_string).into_iter().collect()),
                FieldKind::Map => tx.map_entries(&id, field).map(|entries| {
                    let value = Value::Object(entries.into_iter().collect());
                    crate::FieldDef::map_held(&value, |id| tx.exists(&ObjectId::from_string(id))).into_iter().map(|(id, _)| ObjectId::from_string(id)).collect()
                }),
                _ => unreachable!(),
            }
            .map_err(|error| BatchError::kdm(Some(index), error))?;
            // Tree traversal is preorder, so the stack visits descendants before their parents.
            pending.extend(held.into_iter().map(|id| (id, false)));
        }
    }
    Ok(order)
}

/// A loaded field with the ids it holds as tool ids (rule OM9): a `ref`, a `list`'s items, and a
/// `tree`'s objects and parents.
fn show_ids(names: &ToolIds, kind: FieldKind, value: Value) -> Value {
    if !names.is_active() {
        return value;
    }
    let show = |item: Value| match item {
        Value::String(id) => Value::String(names.show(&ObjectId::from_string(id))),
        other => other,
    };
    match (kind, value) {
        (FieldKind::Text, value) => names.show_text(&value),
        (FieldKind::Ref, value) => show(value),
        (FieldKind::List, Value::Array(items)) => Value::Array(items.into_iter().map(show).collect()),
        (FieldKind::Tree, Value::Array(entries)) => Value::Array(
            entries
                .into_iter()
                .map(|mut entry| {
                    for key in ["object", "parent"] {
                        if let Some(slot) = entry.get_mut(key) {
                            *slot = show(slot.take());
                        }
                    }
                    entry
                })
                .collect(),
        ),
        (FieldKind::Map | FieldKind::Json, value) => names.show_json(&value),
        (_, value) => value,
    }
}

/// The root object: the first object of the schema's root type.
pub fn root_id(replica: &Replica) -> Option<ObjectId> {
    replica.root_id()
}

fn str_field<'a>(index: usize, op: &'a Value, key: &str) -> Result<&'a str, BatchError> {
    op.get(key).and_then(Value::as_str).ok_or_else(|| BatchError::op(index, not_a_string(key, op.get(key))))
}

/// Why `key` was refused: it takes a string, and what it was given instead. An id given as a
/// number (`target: 1`, as receipts show an integer tool id) is the same id as a string here:
/// the agent tools pass it so; a direct `model.batch` caller writes `"1"`.
fn not_a_string(key: &str, given: Option<&Value>) -> String {
    let id = matches!(key, "target" | "item" | "node" | "parent" | "id");
    match given {
        None | Some(Value::Null) => format!("`{key}` is missing: give a string{}", if id { " naming an object by its id" } else { "" }),
        Some(Value::Number(number)) if id && number.is_u64() => {
            format!("`{key}` names an object by its id as a string: give \"{number}\" for the number {number}")
        }
        Some(Value::Number(number)) => format!("`{key}` is a string; got the number {number}"),
        Some(Value::Bool(value)) => format!("`{key}` is a string; got {value}"),
        Some(Value::Array(_)) => format!("`{key}` is a string; got an array"),
        Some(Value::Object(_)) => format!("`{key}` is a string; got an object"),
        Some(Value::String(_)) => format!("`{key}` is a string"),
    }
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

/// A `set` or text operation's field given as a path from its target: through owning fields
/// (a ref or map declared `owns`, a list by index) to a field of a held object without a tool id
/// of its own (`props.children.2.children.7.value.v`), or the same in the kit's words where the
/// types on the way declare `pathName` (`transform/opacity.value.v`); past a `json` field, the rest
/// is a path inside its value (`value.v`). Answers the held object, its field and that inner path.
/// A plain field (`text`) answers the target itself. Refused (`invalid-op`): a path through a ref
/// that does not own, into an object with a tool id of its own (name it by its id), past a list's
/// end, through a tree, or to no field.
fn held_path(
    tx: &Tx<'_>,
    schema: &Schema,
    names: &ToolIds,
    index: usize,
    target: &ObjectId,
    path: &str,
) -> Result<(ObjectId, String, Vec<String>), BatchError> {
    let refuse = |why: String| BatchError::op(index, format!("`field` `{path}`: {why}"));
    // In the kit's words: the held object whose named path the field starts with, the longest.
    let (mut at, rest): (ObjectId, String) = if path.split('.').next().is_some_and(|first| first.contains(['/', '#'])) {
        let mut found: Option<(ObjectId, usize)> = None;
        let mut frontier = vec![target.clone()];
        let mut seen: BTreeSet<ObjectId> = BTreeSet::new();
        while let Some(object) = frontier.pop() {
            if !seen.insert(object.clone()) || seen.len() > 100_000 {
                continue;
            }
            if let Some(named) = names.named_path(&object)
                && let Some(after) = path.strip_prefix(named.as_str())
                && (after.is_empty() || after.starts_with('.'))
                && found.as_ref().is_none_or(|(_, len)| named.len() > *len)
            {
                found = Some((object.clone(), named.len()));
            }
            let Ok(ty) = tx.object_type(&object) else { continue };
            let Ok(def) = schema.type_def(&ty) else { continue };
            for (name, field) in def.fields.iter().filter(|(_, field)| field.owning()) {
                match field.kind {
                    FieldKind::List => frontier.extend(tx.list_items(&object, name).unwrap_or_default()),
                    FieldKind::Ref => frontier.extend(tx.get(&object, name).ok().and_then(|value| value.as_str().map(ObjectId::from_string))),
                    _ => {}
                }
            }
        }
        let Some((object, len)) = found else { return Err(refuse("no object the target holds has that name in the kit's words".to_owned())) };
        (object, path.get(len..).unwrap_or_default().trim_start_matches('.').to_owned())
    } else {
        (target.clone(), path.to_owned())
    };
    let segments: Vec<&str> = rest.split('.').collect();
    let mut position = 0;
    while let Some(&name) = segments.get(position) {
        let ty = tx.object_type(&at).map_err(|error| refuse(error.to_string()))?;
        let def = schema.field(&ty, name).map_err(|_| refuse(format!("`{ty}` has no field `{name}`")))?;
        if position + 1 == segments.len() || !matches!(def.kind, FieldKind::Ref | FieldKind::List | FieldKind::Map | FieldKind::Tree) {
            let inner: Vec<String> = segments.iter().skip(position + 1).map(|segment| (*segment).to_owned()).collect();
            if !inner.is_empty() && def.kind != FieldKind::Json {
                return Err(refuse(format!("`{ty}.{name}` is no json value to go into")));
            }
            return Ok((at, name.to_owned(), inner));
        }
        let next = match def.kind {
            FieldKind::Ref if def.owns => tx.get(&at, name).ok().and_then(|value| value.as_str().map(ObjectId::from_string)),
            FieldKind::List => {
                position += 1;
                let item = segments
                    .get(position)
                    .and_then(|segment| segment.parse::<usize>().ok())
                    .ok_or_else(|| refuse(format!("`{name}` is a list: give an index after it")))?;
                let items = tx.list_items(&at, name).map_err(|error| refuse(error.to_string()))?;
                Some(items.get(item).cloned().ok_or_else(|| refuse(format!("`{name}` has {} items, not {}", items.len(), item + 1)))?)
            }
            FieldKind::Map if def.owns => {
                position += 1;
                let key = segments.get(position).ok_or_else(|| refuse(format!("`{name}` is a map: give a key after it")))?;
                tx.map_get(&at, name, key).ok().and_then(|value| value.as_str().map(ObjectId::from_string))
            }
            FieldKind::Ref | FieldKind::Map => return Err(refuse(format!("`{ty}.{name}` does not own what it names: a path goes through owning fields only"))),
            _ => return Err(refuse(format!("`{ty}.{name}` is a tree: a path does not go through trees"))),
        };
        let next = next.ok_or_else(|| refuse(format!("`{ty}.{name}` holds nothing there")))?;
        if names.tool_id(&next).is_some() {
            return Err(refuse(format!("it reaches `{}`, which has a tool id of its own: target it by that id", names.show(&next))));
        }
        at = next;
        position += 1;
    }
    Err(refuse("it names no field".to_owned()))
}

fn container_field(tx: &Tx<'_>, schema: &Schema, names: &ToolIds, index: usize, target: &ObjectId, path: &str) -> Result<(ObjectId, String), BatchError> {
    let (id, field, inner) = held_path(tx, schema, names, index, target, path)?;
    if !inner.is_empty() {
        return Err(BatchError::op(index, "a container operation requires a container field, not a JSON member"));
    }
    Ok((id, field))
}

fn text_field(tx: &Tx<'_>, schema: &Schema, names: &ToolIds, index: usize, target: &ObjectId, path: &str, op: &str) -> Result<(ObjectId, String), BatchError> {
    if !path.contains(['.', '/']) {
        return Ok((target.clone(), path.to_owned()));
    }
    let (id, field, inner) = held_path(tx, schema, names, index, target, path)?;
    if !inner.is_empty() {
        let verb = if op == "text.set" { "replaces" } else { "edits" };
        return Err(BatchError::op(index, format!("`field` `{path}`: `{op}` {verb} a text field, not a path inside a value")));
    }
    Ok((id, field))
}

/// `value` with `inner` (a path of object members and array indexes) set to `new`.
fn set_inside(value: &mut Value, inner: &[String], new: Value) -> Result<(), String> {
    let Some((last, way)) = inner.split_last() else {
        *value = new;
        return Ok(());
    };
    let mut at = value;
    for key in way {
        at = match key.parse::<usize>() {
            Ok(index) if at.is_array() => at.get_mut(index).ok_or_else(|| format!("no item {index} at `{key}`"))?,
            _ => at.as_object_mut().ok_or_else(|| format!("`{key}` is in no object"))?.entry(key.clone()).or_insert(Value::Null),
        };
    }
    match last.parse::<usize>() {
        Ok(index) if at.is_array() => {
            let slot = at.get_mut(index).ok_or_else(|| format!("no item {index}"))?;
            *slot = new;
        }
        _ => {
            at.as_object_mut().ok_or_else(|| format!("`{last}` is in no object"))?.insert(last.clone(), new);
        }
    }
    Ok(())
}

/// Refuses (`read-only`) a write to `id`, or to its `field`, that the schema keeps from the
/// object model (rule OM8): a read-only type, an object its `readOnlyWhen` names, or a read-only
/// field. An unknown object or field is left to the operation, which reports it.
fn guard(tx: &Tx<'_>, schema: &Schema, names: &ToolIds, index: usize, id: &ObjectId, field: Option<&str>) -> Result<(), BatchError> {
    let Ok(ty) = tx.object_type(id) else { return Ok(()) };
    let Ok(def) = schema.type_def(&ty) else { return Ok(()) };
    if def.object_read_only(|name| tx.get(id, name).ok()) {
        return Err(BatchError::new(BatchErrorCode::ReadOnly, Some(index), format!("`{}` is a read-only `{ty}`: the kit keeps it as it is", names.show(id))));
    }
    if let Some(field) = field
        && def.fields.get(field).is_some_and(|def| def.read_only)
    {
        return Err(BatchError::new(BatchErrorCode::ReadOnly, Some(index), format!("`{ty}.{field}` is read-only: the kit keeps it as it is")));
    }
    Ok(())
}

/// Refuses a new object whose type or discriminator makes the object read-only (OM8).
/// Read-only registers may be initialized here; later operations still go through `guard`.
fn guard_new(schema: &Schema, index: usize, ty: &str, fields: &Map<String, Value>) -> Result<(), BatchError> {
    let Ok(def) = schema.type_def(ty) else { return Ok(()) };
    if def.object_read_only(|name| fields.get(name).cloned()) {
        return Err(BatchError::new(BatchErrorCode::ReadOnly, Some(index), format!("a new `{ty}` would be read-only: only the kit makes one")));
    }
    Ok(())
}

/// Refuses (`not-found`) a reference field of a `ty` given the id of no object: the object model
/// writes references to objects that exist (KHP A48 says what to give instead). A reference may
/// still dangle later, when its object is deleted; the data model allows that (M4a).
fn check_refs<'v>(tx: &Tx<'_>, schema: &Schema, index: usize, ty: &str, fields: impl IntoIterator<Item = (&'v str, &'v Value)>) -> Result<(), BatchError> {
    let Ok(def) = schema.type_def(ty) else { return Ok(()) };
    for (name, value) in fields {
        let (Some(field), Some(id)) = (def.fields.get(name), value.as_str()) else { continue };
        if !(field.kind == FieldKind::Ref || (field.kind == FieldKind::Map && field.of.is_some())) || tx.exists(&ObjectId::from_string(id)) {
            continue;
        }
        let of = field.of.as_deref().unwrap_or("object");
        return Err(BatchError::new(
            BatchErrorCode::NotFound,
            Some(index),
            format!(
                "`{ty}.{name}` holds the id of a `{of}`, and no object has the id `{id}`: give the id of an existing `{of}` (a load or query answers them), or create one earlier in the batch and use its `$name`"
            ),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply(
    tx: &mut Tx<'_>,
    schema: &Schema,
    names: &ToolIds,
    index: usize,
    op: &Value,
    refs: &mut Refs,
    root: &mut Option<ObjectId>,
    limits: Option<&ValueLimits>,
) -> Result<Value, BatchError> {
    let kdm = |error: KdmError| BatchError::kdm(Some(index), error);
    let mut target = |key: &str, refs: &Refs, tx: &Tx<'_>| -> Result<ObjectId, BatchError> {
        let text = str_field(index, op, key)?;
        target_id(
            text,
            refs,
            names,
            |id| tx.exists(id) || (op.get("op").and_then(Value::as_str) == Some("delete") && tx.was_deleted(id)),
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
                    let (owner, field) = path.split_once('.').ok_or_else(|| BatchError::op(index, "`in` is \"<target>.<field>\""))?;
                    let resolved = target_id(
                        owner,
                        refs,
                        names,
                        |id| tx.exists(id),
                        || {
                            if root.is_none() {
                                *root = tx.objects_of_type(&schema.root).into_iter().next();
                            }
                            root.clone()
                        },
                        Some(index),
                    )?;
                    Some(container_field(tx, schema, names, index, &resolved, field)?)
                }
                Some(_) => return Err(BatchError::op(index, "`in` is \"<target>.<field>\"")),
            };
            let mut given: Vec<(String, Value)> = fields.into_iter().collect();
            given.sort_by(|(a, _), (b, _)| a.cmp(b));
            let fields = given
                .into_iter()
                .map(|(name, value)| Ok((name.clone(), ref_value(tx, schema, names, index, ty, &name, value)?)))
                .collect::<Result<Map<_, _>, BatchError>>()?;
            guard_new(schema, index, ty, &fields)?;
            let mut named: Vec<(&str, &Value)> = fields.iter().map(|(name, value)| (name.as_str(), value)).collect();
            named.sort_unstable_by_key(|(name, _)| *name);
            check_refs(tx, schema, index, ty, named)?;
            let id = match op.get("id") {
                None | Some(Value::Null) => tx.create(ty, fields).map_err(kdm)?,
                Some(Value::String(id)) => tx.create_with_id(ty, &ObjectId::from_string(id.clone()), fields).map_err(kdm)?,
                Some(given) => return Err(BatchError::op(index, not_a_string("id", Some(given)))),
            };
            if let Some((owner, field)) = container {
                let owner_type = tx.object_type(&owner).map_err(kdm)?;
                let def = schema.field(&owner_type, &field).map_err(kdm)?;
                guard(tx, schema, names, index, &owner, Some(&field))?;
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
                        let parent = tree_parent(tx, refs, names, root, schema, index, op, &owner, &field)?;
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
            validate_limits(tx, schema, names, index, &id, limits)?;
            Ok(Value::String(id.to_string()))
        }
        "set" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            let value = op.get("value").map_or(Value::Null, |value| resolve_values(value, refs));
            // A path to a field of a held object.
            let (id, field, value) = match field.contains(['.', '/']) {
                true => {
                    let (held, name, inner) = held_path(tx, schema, names, index, &id, field)?;
                    let value = if inner.is_empty() {
                        value
                    } else {
                        let mut whole = tx.get(&held, &name).unwrap_or(Value::Null);
                        set_inside(&mut whole, &inner, value).map_err(|why| BatchError::op(index, format!("`field` `{field}`: {why}")))?;
                        whole
                    };
                    (held, name, value)
                }
                false => (id, field.to_owned(), value),
            };
            let field = field.as_str();
            let value = match tx.object_type(&id) {
                Ok(ty) => ref_value(tx, schema, names, index, &ty, field, value)?,
                Err(_) => value,
            };
            guard(tx, schema, names, index, &id, Some(field))?;
            // A value that would make the object read-only is the kit's to write.
            if let Ok(ty) = tx.object_type(&id)
                && let Ok(def) = schema.type_def(&ty)
                && def.read_only_when.as_ref().is_some_and(|when| when.field == field)
                && def.object_read_only(|name| if name == field { Some(value.clone()) } else { tx.get(&id, name).ok() })
            {
                return Err(BatchError::new(
                    BatchErrorCode::ReadOnly,
                    Some(index),
                    format!("`{ty}.{field}` would make `{}` read-only: only the kit does", names.show(&id)),
                ));
            }
            if let Ok(ty) = tx.object_type(&id) {
                check_refs(tx, schema, index, &ty, [(field, &value)])?;
            }
            tx.set(&id, field, value).map_err(kdm)?;
            validate_limits(tx, schema, names, index, &id, limits)?;
            Ok(Value::Null)
        }
        "delete" => {
            let id = target("target", refs, tx)?;
            if !tx.exists(&id) && !tx.was_deleted(&id) {
                return Err(BatchError::new(BatchErrorCode::NotFound, Some(index), format!("object `{id}` not found")));
            }
            for id in deletion_order(tx, schema, &id, index)? {
                let ty = tx.object_type(&id).map_err(kdm)?;
                guard(tx, schema, names, index, &id, None)?;
                // Drop the object from every list holding it, so no list keeps a dangling entry.
                for (owner_type, def) in &schema.types {
                    for (field, field_def) in &def.fields {
                        if field_def.kind != FieldKind::List || field_def.of.as_deref() != Some(ty.as_str()) {
                            continue;
                        }
                        for owner in tx.objects_of_type(owner_type) {
                            let items = tx.list_items(&owner, field).map_err(kdm)?;
                            if items.contains(&id) {
                                guard(tx, schema, names, index, &owner, Some(field))?;
                            }
                            for at in items.iter().enumerate().filter(|(_, item)| **item == id).map(|(at, _)| at).rev().collect::<Vec<_>>() {
                                tx.list_remove(&owner, field, at).map_err(kdm)?;
                            }
                        }
                    }
                }
                // `Tx::delete` takes the object's node out of every tree  and refuses one with
                // live children; refused here first, in the batch's words.
                for (owner_type, def) in &schema.types {
                    for (field, field_def) in &def.fields {
                        if field_def.kind != FieldKind::Tree || field_def.of.as_deref().is_some_and(|of| of != ty) {
                            continue;
                        }
                        for owner in tx.objects_of_type(owner_type) {
                            let entries = tx.tree(&owner, field).map_err(kdm)?;
                            let mine: Vec<&crate::NodeRef> = entries.iter().filter(|entry| entry.object == id).map(|entry| &entry.node).collect();
                            if !mine.is_empty() {
                                guard(tx, schema, names, index, &owner, Some(field))?;
                            }
                            if entries.iter().any(|entry| entry.parent.as_ref().is_some_and(|parent| mine.contains(&parent)) && tx.exists(&entry.object)) {
                                return Err(BatchError::new(
                                    BatchErrorCode::InvalidValue,
                                    Some(index),
                                    format!(
                                        "`{}` has children in `{}.{field}`: delete them child-first or move them, before deleting this node in the same batch",
                                        names.show(&id),
                                        names.show(&owner)
                                    ),
                                ));
                            }
                        }
                    }
                }
                tx.delete(&id).map_err(kdm)?;
            }
            Ok(Value::Null)
        }
        "tree.insert" => {
            let id = target("target", refs, tx)?;
            let (id, field) = container_field(tx, schema, names, index, &id, str_field(index, op, "field")?)?;
            let field = field.as_str();
            guard(tx, schema, names, index, &id, Some(field))?;
            let item = target("item", refs, tx)?;
            if live_node(tx, &id, field, &item).map_err(kdm)?.is_some() {
                return Err(BatchError::new(
                    BatchErrorCode::InvalidValue,
                    Some(index),
                    format!("`{}` is already in `{}.{field}`: move it with tree.move", names.show(&item), names.show(&id)),
                ));
            }
            let parent = tree_parent(tx, refs, names, root, schema, index, op, &id, field)?;
            tx.tree_create(&id, field, parent.as_ref(), &item).map_err(kdm)?;
            Ok(Value::Null)
        }
        "tree.move" => {
            let id = target("target", refs, tx)?;
            let (id, field) = container_field(tx, schema, names, index, &id, str_field(index, op, "field")?)?;
            let field = field.as_str();
            guard(tx, schema, names, index, &id, Some(field))?;
            let item = target("item", refs, tx)?;
            let node = live_node(tx, &id, field, &item).map_err(kdm)?.ok_or_else(|| {
                BatchError::new(BatchErrorCode::NotFound, Some(index), format!("`{}` is not in `{}.{field}`", names.show(&item), names.show(&id)))
            })?;
            let parent = tree_parent(tx, refs, names, root, schema, index, op, &id, field)?;
            tx.tree_move(&id, field, &node, parent.as_ref()).map_err(kdm)?;
            Ok(Value::Null)
        }
        "text.insert" => {
            let id = target("target", refs, tx)?;
            let (id, field) = text_field(tx, schema, names, index, &id, str_field(index, op, "field")?, name)?;
            let field = field.as_str();
            guard(tx, schema, names, index, &id, Some(field))?;
            tx.text_insert(&id, field, usize_field(index, op, "index")?, str_field(index, op, "text")?).map_err(kdm)?;
            Ok(Value::Null)
        }
        "text.delete" => {
            let id = target("target", refs, tx)?;
            let (id, field) = text_field(tx, schema, names, index, &id, str_field(index, op, "field")?, name)?;
            let field = field.as_str();
            guard(tx, schema, names, index, &id, Some(field))?;
            tx.text_delete(&id, field, usize_field(index, op, "index")?, usize_field(index, op, "count")?).map_err(kdm)?;
            Ok(Value::Null)
        }
        "text.set" => {
            let id = target("target", refs, tx)?;
            let (id, field) = text_field(tx, schema, names, index, &id, str_field(index, op, "field")?, name)?;
            let field = field.as_str();
            guard(tx, schema, names, index, &id, Some(field))?;
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
            guard(tx, schema, names, index, &id, Some(field))?;
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
            let (id, field) = container_field(tx, schema, names, index, &id, str_field(index, op, "field")?)?;
            let field = field.as_str();
            guard(tx, schema, names, index, &id, Some(field))?;
            let item = target("item", refs, tx)?;
            let len = tx.list_items(&id, field).map_err(kdm)?.len();
            let at = position(index, op.get("index"), len)?;
            tx.list_insert(&id, field, at, &item).map_err(kdm)?;
            Ok(Value::Null)
        }
        "list.move" => {
            let id = target("target", refs, tx)?;
            let (id, field) = container_field(tx, schema, names, index, &id, str_field(index, op, "field")?)?;
            let field = field.as_str();
            guard(tx, schema, names, index, &id, Some(field))?;
            let from = usize_field(index, op, "from")?;
            let to = usize_field(index, op, "to")?;
            // Raw destinations name a gap in the list before removing the source.
            tx.list_move(&id, field, from, if to > from { to - 1 } else { to }).map_err(kdm)?;
            Ok(Value::Null)
        }
        "list.remove" => {
            let id = target("target", refs, tx)?;
            let (id, field) = container_field(tx, schema, names, index, &id, str_field(index, op, "field")?)?;
            let field = field.as_str();
            guard(tx, schema, names, index, &id, Some(field))?;
            tx.list_remove(&id, field, usize_field(index, op, "index")?).map_err(kdm)?;
            Ok(Value::Null)
        }
        "map.set" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, names, index, &id, Some(field))?;
            let value = op.get("value").map_or(Value::Null, |value| resolve_values(value, refs));
            let ty = tx.object_type(&id).map_err(kdm)?;
            let value = ref_value(tx, schema, names, index, &ty, field, value)?;
            check_refs(tx, schema, index, &ty, [(field, &value)])?;
            tx.map_set(&id, field, str_field(index, op, "key")?, value).map_err(kdm)?;
            validate_limits(tx, schema, names, index, &id, limits)?;
            Ok(Value::Null)
        }
        "map.delete" => {
            let id = target("target", refs, tx)?;
            let field = str_field(index, op, "field")?;
            guard(tx, schema, names, index, &id, Some(field))?;
            tx.map_delete(&id, field, str_field(index, op, "key")?).map_err(kdm)?;
            validate_limits(tx, schema, names, index, &id, limits)?;
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
    names: &ToolIds,
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
        names,
        |id| tx.exists(id),
        || {
            if root.is_none() {
                *root = tx.objects_of_type(&schema.root).into_iter().next();
            }
            root.clone()
        },
        Some(index),
    )?;
    live_node(tx, id, field, &parent).map_err(|error| BatchError::kdm(Some(index), error))?.map(Some).ok_or_else(|| {
        BatchError::new(BatchErrorCode::NotFound, Some(index), format!("the parent `{}` is not in `{}.{field}`", names.show(&parent), names.show(id)))
    })
}

/// One `load` entry: `{ target, fields? }` → `{ id, type, fields }`.
fn load(replica: &Replica, names: &ToolIds, entry: &Value, refs: &Refs) -> Result<Value, BatchError> {
    let text = entry
        .get("target")
        .and_then(Value::as_str)
        .ok_or_else(|| BatchError::new(BatchErrorCode::InvalidOp, None, not_a_string("target", entry.get("target"))))?;
    let id = target_id(text, refs, names, |id| replica.exists(id), || root_id(replica), None)?;
    let ty = replica.object_type(&id).map_err(|error| BatchError::kdm(None, error))?;
    let def = replica.schema().type_def(&ty).map_err(|error| BatchError::kdm(None, error))?;
    let wanted: Vec<String> = match entry.get("fields") {
        None | Some(Value::Null) => def.fields.keys().cloned().collect(),
        Some(Value::Array(names)) => names
            .iter()
            .map(|name| name.as_str().map(str::to_owned).ok_or_else(|| BatchError::new(BatchErrorCode::InvalidOp, None, "`fields` lists names")))
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(BatchError::new(BatchErrorCode::InvalidOp, None, "`fields` lists names")),
    };
    let mut fields = Map::new();
    // Every field the schema declares is in `fields`, one named `id` or `type` too (a tool id's
    // field may be named `id`): the answer's own `id` and `type` are members beside `fields`.
    for name in wanted {
        let value = read_field(replica, &id, &ty, &name)?;
        let kind = def.fields.get(&name).map_or(FieldKind::Json, |field| field.kind);
        fields.insert(name.clone(), show_ids(names, kind, value));
    }
    Ok(json!({ "id": names.show(&id), "type": ty, "fields": fields }))
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
/// `{ capability, kit, schemaVersion, root, rootId, types }`; a type's `toolId` says how its
/// objects are named (rule OM9).
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
                    if let Some(label) = &field.label {
                        out.insert("label".into(), json!(label));
                    }
                    for (key, value) in [("minimum", &field.minimum), ("maximum", &field.maximum), ("multipleOf", &field.multiple_of)] {
                        if let Some(value) = value {
                            out.insert(key.into(), json!(value));
                        }
                    }
                    if let Some(of) = &field.of {
                        out.insert("of".into(), Value::String(of.clone()));
                    }
                    if !field.members.is_empty() {
                        out.insert("members".into(), json!(field.members));
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
                    if field.owns {
                        out.insert("owns".into(), Value::Bool(true));
                    }
                    if field.cascade {
                        out.insert("cascade".into(), Value::Bool(true));
                    }
                    if field.position {
                        out.insert("position".into(), Value::Bool(true));
                    }
                    if let Some(display) = &field.display {
                        out.insert("display".into(), serde_json::to_value(display).unwrap_or(Value::Null));
                    }
                    if let Some(sample) = field.sample {
                        out.insert("sample".into(), Value::Bool(sample));
                    }
                    (name.clone(), Value::Object(out))
                })
                .collect();
            let mut out = Map::new();
            out.insert("fields".into(), Value::Object(fields));
            if def.projected {
                out.insert("projected".into(), json!(true));
            }
            if !def.projected_ops.is_empty() {
                out.insert("projectedOps".into(), json!(def.projected_ops));
            }
            if def.read_only {
                out.insert("readOnly".into(), Value::Bool(true));
            }
            if let Some(when) = &def.read_only_when {
                out.insert("readOnlyWhen".into(), json!({ "field": when.field, "values": when.values }));
            }
            if let Some(tool) = &def.tool_id {
                let mut declared = Map::new();
                declared.insert("field".into(), Value::String(tool.field.clone()));
                declared.insert("prefix".into(), Value::String(tool.prefix.clone()));
                if let Some(parent) = &tool.parent {
                    declared.insert("parent".into(), Value::String(parent.clone()));
                }
                out.insert("toolId".into(), Value::Object(declared));
            }
            if let Some(path) = &def.path_name {
                out.insert("pathName".into(), Value::String(path.clone()));
            }
            if let Some(path) = &def.label {
                out.insert("label".into(), Value::String(path.clone()));
            }
            if let Some(path) = &def.text {
                out.insert("text".into(), Value::String(path.clone()));
            }
            if !def.batch_ops.is_empty() {
                out.insert("batchOps".into(), json!(def.batch_ops));
            }
            if let Some(creation) = &def.creation {
                out.insert("creation".into(), json!(creation));
            }
            if def.batch_independent {
                out.insert("batchIndependent".into(), json!(true));
            }
            if !def.move_consequences.is_empty() {
                out.insert("moveConsequences".into(), json!(def.move_consequences));
            }
            if !def.structural_consequences.is_empty() {
                out.insert("structuralConsequences".into(), json!(def.structural_consequences));
            }
            if !def.derived.is_empty() {
                let derived: Map<String, Value> = def
                    .derived
                    .iter()
                    .map(|(name, derived)| {
                        let mut value = Map::new();
                        if let Some(description) = &derived.description {
                            value.insert("description".into(), json!(description));
                        }
                        if derived.premise_only {
                            value.insert("premiseOnly".into(), json!(true));
                        }
                        if derived.on_demand {
                            value.insert("onDemand".into(), json!(true));
                        }
                        (name.clone(), Value::Object(value))
                    })
                    .collect();
                out.insert("derived".into(), Value::Object(derived));
            }
            (ty.clone(), Value::Object(out))
        })
        .collect();
    json!({
        "capability": CAPABILITY,
        "kit": schema.kit,
        "schemaVersion": schema.schema_version,
        "root": schema.root,
        "rootId": root_id(replica).map(|id| if schema.has_tool_ids() { replica.tool_ids_of(&std::collections::BTreeSet::from([id.clone()])).show(&id) } else { id.to_string() }),
        "types": types,
    })
}
