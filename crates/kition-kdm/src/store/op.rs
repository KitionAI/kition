// Copied from kition-sdk crates/kition-kdm/src/store/op.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A change (plan 2026-11-24, plain model, section 1.2): the operations of one transaction, each
//! addressed by object id, each carrying what its inverse needs once applied.
//!
//! An operation as a transaction stages it leaves its `was` parts empty (and a text insert's
//! marks, a tree insert's place unset); [`super::Store::apply`] fills them from the state it
//! applies to and answers the operation as applied. [`inverse`] of an applied operation undoes it.
//! A change travels between the replicas of one session as UTF-8 JSON ([`Change::to_json`]); it is
//! never written into a file.

use std::sync::Arc;

use serde_json::{Value, json};

use super::Object;
use super::text::{MarkSegment, Marks};
use crate::{ActorId, KdmError, ObjectId, Origin, Result, Schema, TextRun};

/// A type or field name, shared.
pub(crate) type Name = Arc<str>;

/// A node's place in a tree field of an object: the node is the object being created or deleted.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TreePlace {
    pub(crate) owner: ObjectId,
    pub(crate) field: Name,
    pub(crate) parent: Option<ObjectId>,
    pub(crate) index: usize,
}

/// A node's parent (`None`: a root) and its index among its siblings.
pub(crate) type Place = (Option<ObjectId>, usize);

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Op {
    /// Makes object `id` (its fields, containers included) and puts it in `trees`.
    Create {
        id: ObjectId,
        object: Box<Object>,
        trees: Vec<TreePlace>,
    },
    /// Deletes object `id`; `was` is the object and `trees` its places in trees, once applied.
    Delete {
        id: ObjectId,
        was: Option<Box<Object>>,
        trees: Vec<TreePlace>,
    },
    /// Sets a register (`null`: unsets it); `was` is its value before (`null`: none).
    Set {
        id: ObjectId,
        field: Name,
        value: Value,
        was: Value,
    },
    /// Inserts `text` at `index` (Unicode scalar values) with `marks` (set when applied: the marks
    /// the text takes from its neighbours, unless given).
    TextInsert {
        id: ObjectId,
        field: Name,
        index: usize,
        text: String,
        marks: Option<Marks>,
    },
    /// Deletes `count` characters at `index`; `was` holds them as runs, once applied.
    TextDelete {
        id: ObjectId,
        field: Name,
        index: usize,
        count: usize,
        was: Vec<TextRun>,
    },
    /// Sets mark `key` to `value` over `start..end` (`null`: removes it); `was` holds what the key
    /// held there before, once applied.
    TextMark {
        id: ObjectId,
        field: Name,
        start: usize,
        end: usize,
        key: String,
        value: Value,
        was: Vec<MarkSegment>,
    },
    ListInsert {
        id: ObjectId,
        field: Name,
        index: usize,
        item: ObjectId,
    },
    /// Removes the item at `index`; when `item` is given, it must be the one there.
    ListRemove {
        id: ObjectId,
        field: Name,
        index: usize,
        item: Option<ObjectId>,
    },
    /// Moves the item at `from` so it is at `to`; when `item` is given, it must be the one at `from`.
    ListMove {
        id: ObjectId,
        field: Name,
        from: usize,
        to: usize,
        item: Option<ObjectId>,
    },
    /// Sets key `key` of a map field (`None`: deletes it); `was` is its value before.
    MapSet {
        id: ObjectId,
        field: Name,
        key: String,
        value: Option<Value>,
        was: Option<Value>,
    },
    /// Puts `node` under `parent` at `index` (`None`: last; set when applied).
    TreeCreate {
        id: ObjectId,
        field: Name,
        node: ObjectId,
        parent: Option<ObjectId>,
        index: Option<usize>,
    },
    /// Moves `node` under `parent` at `index` (`None`: last); `was` is its place before.
    TreeMove {
        id: ObjectId,
        field: Name,
        node: ObjectId,
        parent: Option<ObjectId>,
        index: Option<usize>,
        was: Option<Place>,
    },
    /// Takes `node`, which has no children, out of the tree; `was` is its place.
    TreeDelete {
        id: ObjectId,
        field: Name,
        node: ObjectId,
        was: Option<Place>,
    },
    /// Sets the document's minimum schema version (rule M20); `was` is the one before.
    SchemaVersion {
        version: u64,
        was: u64,
    },
}

impl Op {
    /// The object whose state the operation changes; `None` for the document's schema version.
    pub(crate) fn object(&self) -> Option<&ObjectId> {
        match self {
            Self::Create { id, .. }
            | Self::Delete { id, .. }
            | Self::Set { id, .. }
            | Self::TextInsert { id, .. }
            | Self::TextDelete { id, .. }
            | Self::TextMark { id, .. }
            | Self::ListInsert { id, .. }
            | Self::ListRemove { id, .. }
            | Self::ListMove { id, .. }
            | Self::MapSet { id, .. }
            | Self::TreeCreate { id, .. }
            | Self::TreeMove { id, .. }
            | Self::TreeDelete { id, .. } => Some(id),
            Self::SchemaVersion { .. } => None,
        }
    }

    /// The field the operation changes; `None` for a whole object or the schema version.
    pub(crate) fn field(&self) -> Option<&Name> {
        match self {
            Self::Set { field, .. }
            | Self::TextInsert { field, .. }
            | Self::TextDelete { field, .. }
            | Self::TextMark { field, .. }
            | Self::ListInsert { field, .. }
            | Self::ListRemove { field, .. }
            | Self::ListMove { field, .. }
            | Self::MapSet { field, .. }
            | Self::TreeCreate { field, .. }
            | Self::TreeMove { field, .. }
            | Self::TreeDelete { field, .. } => Some(field),
            Self::Create { .. } | Self::Delete { .. } | Self::SchemaVersion { .. } => None,
        }
    }
}

/// The operations that undo `op`, which was applied (its `was` parts are set), in the order they
/// apply.
pub(crate) fn inverse(op: &Op) -> Vec<Op> {
    match op {
        Op::Create { id, .. } => vec![Op::Delete { id: id.clone(), was: None, trees: Vec::new() }],
        Op::Delete { id, was: Some(object), trees } => vec![Op::Create { id: id.clone(), object: object.clone(), trees: trees.clone() }],
        Op::Delete { was: None, .. } => Vec::new(),
        Op::Set { id, field, value, was } => vec![Op::Set { id: id.clone(), field: field.clone(), value: was.clone(), was: value.clone() }],
        Op::TextInsert { id, field, index, text, .. } => {
            vec![Op::TextDelete { id: id.clone(), field: field.clone(), index: *index, count: text.chars().count(), was: Vec::new() }]
        }
        Op::TextDelete { id, field, index, was, .. } => {
            let mut at = *index;
            was.iter()
                .map(|run| {
                    let insert =
                        Op::TextInsert { id: id.clone(), field: field.clone(), index: at, text: run.insert.clone(), marks: Some(run.attributes.clone()) };
                    at += run.insert.chars().count();
                    insert
                })
                .collect()
        }
        Op::TextMark { id, field, key, was, .. } => was
            .iter()
            .map(|(start, end, value)| Op::TextMark {
                id: id.clone(),
                field: field.clone(),
                start: *start,
                end: *end,
                key: key.clone(),
                value: value.clone(),
                was: Vec::new(),
            })
            .collect(),
        Op::ListInsert { id, field, index, item } => vec![Op::ListRemove { id: id.clone(), field: field.clone(), index: *index, item: Some(item.clone()) }],
        Op::ListRemove { id, field, index, item: Some(item) } => {
            vec![Op::ListInsert { id: id.clone(), field: field.clone(), index: *index, item: item.clone() }]
        }
        Op::ListRemove { item: None, .. } => Vec::new(),
        Op::ListMove { id, field, from, to, item } => vec![Op::ListMove { id: id.clone(), field: field.clone(), from: *to, to: *from, item: item.clone() }],
        Op::MapSet { id, field, key, value, was } => {
            vec![Op::MapSet { id: id.clone(), field: field.clone(), key: key.clone(), value: was.clone(), was: value.clone() }]
        }
        Op::TreeCreate { id, field, node, .. } => vec![Op::TreeDelete { id: id.clone(), field: field.clone(), node: node.clone(), was: None }],
        Op::TreeMove { id, field, node, parent, index, was: Some((was_parent, was_index)) } => vec![Op::TreeMove {
            id: id.clone(),
            field: field.clone(),
            node: node.clone(),
            parent: was_parent.clone(),
            index: Some(*was_index),
            was: Some((parent.clone(), index.unwrap_or_default())),
        }],
        Op::TreeMove { was: None, .. } => Vec::new(),
        Op::TreeDelete { id, field, node, was: Some((parent, index)) } => {
            vec![Op::TreeCreate { id: id.clone(), field: field.clone(), node: node.clone(), parent: parent.clone(), index: Some(*index) }]
        }
        Op::TreeDelete { was: None, .. } => Vec::new(),
        Op::SchemaVersion { version, was } => vec![Op::SchemaVersion { version: *was, was: *version }],
    }
}

/// The operations that undo `ops` (applied in order): their inverses, last first.
pub(crate) fn inverse_all<'a>(ops: impl DoubleEndedIterator<Item = &'a Op>) -> Vec<Op> {
    ops.rev().flat_map(inverse).collect()
}

/// One transaction's operations as one replica applied them, with who made it and why.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Change {
    /// Its number on the document's line: the first change after a load or a creation is the
    /// version's `seq` plus one.
    pub(crate) seq: u64,
    pub(crate) actor: ActorId,
    pub(crate) origin: Origin,
    /// The schema version of the replica that made it (rule M5a).
    pub(crate) schema_version: u32,
    pub(crate) ops: Vec<Op>,
}

fn id_json(id: &ObjectId) -> Value {
    Value::String(id.to_string())
}

fn option_id_json(id: &Option<ObjectId>) -> Value {
    id.as_ref().map_or(Value::Null, id_json)
}

fn place_json(place: &TreePlace) -> Value {
    json!({ "id": id_json(&place.owner), "field": &*place.field, "parent": option_id_json(&place.parent), "index": place.index })
}

/// Sets `key` of a JSON object.
fn put(out: &mut Value, key: &str, value: Value) {
    if let Some(fields) = out.as_object_mut() {
        fields.insert(key.to_owned(), value);
    }
}

fn runs_json(runs: &[TextRun]) -> Value {
    Value::Array(runs.iter().map(TextRun::to_json).collect())
}

impl Op {
    /// The operation's JSON (plan 2026-11-24, section 1.2). Objects are in their content form.
    pub(crate) fn to_json(&self) -> Value {
        match self {
            Self::Create { id, object, trees } => {
                let mut out = json!({ "op": "create", "id": id_json(id), "object": Value::Object(object.to_content()) });
                if !trees.is_empty() {
                    put(&mut out, "trees", Value::Array(trees.iter().map(place_json).collect()));
                }
                out
            }
            Self::Delete { id, was, trees } => {
                let mut out = json!({ "op": "delete", "id": id_json(id) });
                if let Some(object) = was {
                    put(&mut out, "was", Value::Object(object.to_content()));
                }
                if !trees.is_empty() {
                    put(&mut out, "trees", Value::Array(trees.iter().map(place_json).collect()));
                }
                out
            }
            Self::Set { id, field, value, was } => json!({ "op": "set", "id": id_json(id), "field": &**field, "value": value, "was": was }),
            Self::TextInsert { id, field, index, text, marks } => {
                let mut out = json!({ "op": "textInsert", "id": id_json(id), "field": &**field, "index": index, "text": text });
                if let Some(marks) = marks {
                    put(&mut out, "marks", Value::Object(marks.iter().map(|(key, value)| (key.clone(), value.clone())).collect()));
                }
                out
            }
            Self::TextDelete { id, field, index, count, was } => {
                json!({ "op": "textDelete", "id": id_json(id), "field": &**field, "index": index, "count": count, "was": runs_json(was) })
            }
            Self::TextMark { id, field, start, end, key, value, was } => json!({
                "op": "textMark", "id": id_json(id), "field": &**field, "start": start, "end": end, "key": key, "value": value,
                "was": Value::Array(was.iter().map(|(start, end, value)| json!([start, end, value])).collect()),
            }),
            Self::ListInsert { id, field, index, item } => {
                json!({ "op": "listInsert", "id": id_json(id), "field": &**field, "index": index, "item": id_json(item) })
            }
            Self::ListRemove { id, field, index, item } => {
                json!({ "op": "listRemove", "id": id_json(id), "field": &**field, "index": index, "item": option_id_json(item) })
            }
            Self::ListMove { id, field, from, to, item } => {
                json!({ "op": "listMove", "id": id_json(id), "field": &**field, "from": from, "to": to, "item": option_id_json(item) })
            }
            Self::MapSet { id, field, key, value, was } => {
                let mut out = json!({ "op": if value.is_some() { "mapSet" } else { "mapDelete" }, "id": id_json(id), "field": &**field, "key": key });
                if let Some(value) = value {
                    put(&mut out, "value", value.clone());
                }
                if let Some(was) = was {
                    put(&mut out, "was", was.clone());
                }
                out
            }
            Self::TreeCreate { id, field, node, parent, index } => {
                json!({ "op": "treeCreate", "id": id_json(id), "field": &**field, "node": id_json(node), "parent": option_id_json(parent), "index": index })
            }
            Self::TreeMove { id, field, node, parent, index, was } => {
                let mut out =
                    json!({ "op": "treeMove", "id": id_json(id), "field": &**field, "node": id_json(node), "parent": option_id_json(parent), "index": index });
                if let Some((parent, index)) = was {
                    put(&mut out, "wasParent", option_id_json(parent));
                    put(&mut out, "wasIndex", json!(index));
                }
                out
            }
            Self::TreeDelete { id, field, node, was } => {
                let mut out = json!({ "op": "treeDelete", "id": id_json(id), "field": &**field, "node": id_json(node) });
                if let Some((parent, index)) = was {
                    put(&mut out, "wasParent", option_id_json(parent));
                    put(&mut out, "wasIndex", json!(index));
                }
                out
            }
            Self::SchemaVersion { version, was } => json!({ "op": "raiseSchema", "version": version, "was": was }),
        }
    }

    /// An operation from its JSON ([`Op::to_json`]).
    pub(crate) fn from_json(value: &Value, schema: &Schema) -> Result<Self> {
        let bad = |what: &str| KdmError::Encoding(format!("a change's operation has no valid `{what}`"));
        let string = |key: &str| value.get(key).and_then(Value::as_str).ok_or_else(|| bad(key));
        let number = |key: &str| value.get(key).and_then(Value::as_u64).and_then(|n| usize::try_from(n).ok()).ok_or_else(|| bad(key));
        let id = |key: &str| string(key).map(ObjectId::from_string);
        let option_id = |key: &str| match value.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(id)) => Ok(Some(ObjectId::from_string(id.clone()))),
            Some(_) => Err(bad(key)),
        };
        let field = || string("field").map(Name::from);
        let object = |key: &str| -> Result<Option<Box<Object>>> {
            match value.get(key) {
                None => Ok(None),
                Some(Value::Object(fields)) => Ok(Some(Box::new(Object::from_content(fields, schema)?))),
                Some(_) => Err(bad(key)),
            }
        };
        let trees = || -> Result<Vec<TreePlace>> {
            let Some(places) = value.get("trees") else { return Ok(Vec::new()) };
            places
                .as_array()
                .ok_or_else(|| bad("trees"))?
                .iter()
                .map(|place| {
                    Ok(TreePlace {
                        owner: ObjectId::from_string(place.get("id").and_then(Value::as_str).ok_or_else(|| bad("trees"))?),
                        field: Name::from(place.get("field").and_then(Value::as_str).ok_or_else(|| bad("trees"))?),
                        parent: place.get("parent").and_then(Value::as_str).map(ObjectId::from_string),
                        index: place.get("index").and_then(Value::as_u64).and_then(|n| usize::try_from(n).ok()).ok_or_else(|| bad("trees"))?,
                    })
                })
                .collect()
        };
        let was_place = || -> Result<Option<Place>> {
            match value.get("wasIndex") {
                None => Ok(None),
                Some(_) => Ok(Some((option_id("wasParent")?, number("wasIndex")?))),
            }
        };
        let index = || match value.get("index") {
            None | Some(Value::Null) => Ok(None),
            Some(_) => number("index").map(Some),
        };
        Ok(match string("op")? {
            "create" => Self::Create { id: id("id")?, object: object("object")?.ok_or_else(|| bad("object"))?, trees: trees()? },
            "delete" => Self::Delete { id: id("id")?, was: object("was")?, trees: trees()? },
            "set" => Self::Set {
                id: id("id")?,
                field: field()?,
                value: value.get("value").cloned().unwrap_or(Value::Null),
                was: value.get("was").cloned().unwrap_or(Value::Null),
            },
            "textInsert" => Self::TextInsert {
                id: id("id")?,
                field: field()?,
                index: number("index")?,
                text: string("text")?.to_owned(),
                marks: match value.get("marks") {
                    None => None,
                    Some(Value::Object(marks)) => {
                        Some(marks.iter().filter(|(_, value)| !value.is_null()).map(|(key, value)| (key.clone(), value.clone())).collect())
                    }
                    Some(_) => return Err(bad("marks")),
                },
            },
            "textDelete" => Self::TextDelete {
                id: id("id")?,
                field: field()?,
                index: number("index")?,
                count: number("count")?,
                was: match value.get("was") {
                    None => Vec::new(),
                    Some(runs) => serde_json::from_value(runs.clone()).map_err(|_| bad("was"))?,
                },
            },
            "textMark" => Self::TextMark {
                id: id("id")?,
                field: field()?,
                start: number("start")?,
                end: number("end")?,
                key: string("key")?.to_owned(),
                value: value.get("value").cloned().unwrap_or(Value::Null),
                was: match value.get("was") {
                    None => Vec::new(),
                    Some(Value::Array(segments)) => segments
                        .iter()
                        .map(|segment| {
                            let start = segment.get(0).and_then(Value::as_u64).and_then(|n| usize::try_from(n).ok()).ok_or_else(|| bad("was"))?;
                            let end = segment.get(1).and_then(Value::as_u64).and_then(|n| usize::try_from(n).ok()).ok_or_else(|| bad("was"))?;
                            Ok((start, end, segment.get(2).cloned().unwrap_or(Value::Null)))
                        })
                        .collect::<Result<Vec<_>>>()?,
                    Some(_) => return Err(bad("was")),
                },
            },
            "listInsert" => Self::ListInsert { id: id("id")?, field: field()?, index: number("index")?, item: id("item")? },
            "listRemove" => Self::ListRemove { id: id("id")?, field: field()?, index: number("index")?, item: option_id("item")? },
            "listMove" => Self::ListMove { id: id("id")?, field: field()?, from: number("from")?, to: number("to")?, item: option_id("item")? },
            "mapSet" | "mapDelete" => Self::MapSet {
                id: id("id")?,
                field: field()?,
                key: string("key")?.to_owned(),
                value: if string("op")? == "mapSet" { Some(value.get("value").cloned().unwrap_or(Value::Null)) } else { None },
                was: value.get("was").cloned(),
            },
            "treeCreate" => Self::TreeCreate { id: id("id")?, field: field()?, node: id("node")?, parent: option_id("parent")?, index: index()? },
            "treeMove" => {
                Self::TreeMove { id: id("id")?, field: field()?, node: id("node")?, parent: option_id("parent")?, index: index()?, was: was_place()? }
            }
            "treeDelete" => Self::TreeDelete { id: id("id")?, field: field()?, node: id("node")?, was: was_place()? },
            "raiseSchema" => Self::SchemaVersion {
                version: value.get("version").and_then(Value::as_u64).ok_or_else(|| bad("version"))?,
                was: value.get("was").and_then(Value::as_u64).unwrap_or(0),
            },
            other => return Err(KdmError::Encoding(format!("unknown operation `{other}`"))),
        })
    }
}

impl Change {
    /// The change's JSON: `{"seq", "actor", "origin": [kind, principal, label, schemaVersion], "ops"}`.
    pub(crate) fn to_json(&self) -> Value {
        let origin: Value = serde_json::from_str(&self.origin.encode_commit(self.schema_version)).unwrap_or(Value::Null);
        json!({
            "seq": self.seq,
            "actor": format!("{:016x}", self.actor.get()),
            "origin": origin,
            "ops": Value::Array(self.ops.iter().map(Op::to_json).collect()),
        })
    }

    pub(crate) fn from_json(value: &Value, schema: &Schema) -> Result<Self> {
        let bad = |what: &str| KdmError::Encoding(format!("a change has no valid `{what}`"));
        let seq = value.get("seq").and_then(Value::as_u64).ok_or_else(|| bad("seq"))?;
        let actor = value.get("actor").and_then(Value::as_str).and_then(|hex| u64::from_str_radix(hex, 16).ok()).ok_or_else(|| bad("actor"))?;
        let origin_json = value.get("origin").ok_or_else(|| bad("origin"))?;
        let (origin, schema_version) = Origin::decode_commit(&origin_json.to_string()).ok_or_else(|| bad("origin"))?;
        let ops =
            value.get("ops").and_then(Value::as_array).ok_or_else(|| bad("ops"))?.iter().map(|op| Op::from_json(op, schema)).collect::<Result<Vec<_>>>()?;
        Ok(Self { seq, actor: ActorId::from_u64(actor)?, origin, schema_version: schema_version.unwrap_or_default(), ops })
    }
}
