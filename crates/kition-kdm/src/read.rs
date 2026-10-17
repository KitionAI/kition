// Copied from kition-sdk crates/kition-kdm/src/read.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Reads shared by [`crate::Replica`] and [`crate::Tx`].

use loro::{Container, LoroDoc, LoroMap, LoroMovableList, LoroText, LoroTree, LoroValue, ToJson, TreeID, TreeParentId, ValueOrContainer};
use serde_json::{Map, Value};

use crate::value::canonical;
use crate::{FieldKind, KdmError, ObjectId, Result, Schema};

pub(crate) const META: &str = "meta";
pub(crate) const OBJECTS: &str = "objects";
pub(crate) const TYPE_KEY: &str = "$type";
pub(crate) const NODE_OBJECT: &str = "object";

pub(crate) fn object_map(doc: &LoroDoc, id: &ObjectId) -> Result<LoroMap> {
    match doc.get_map(OBJECTS).get(id.as_str()) {
        Some(ValueOrContainer::Container(Container::Map(map))) => Ok(map),
        _ => Err(KdmError::NotFound(id.to_string())),
    }
}

pub(crate) fn type_of(map: &LoroMap, id: &ObjectId) -> Result<String> {
    match map.get(TYPE_KEY) {
        Some(ValueOrContainer::Value(value)) => value.to_json_value().as_str().map(str::to_owned).ok_or_else(|| KdmError::NotFound(id.to_string())),
        _ => Err(KdmError::NotFound(id.to_string())),
    }
}

pub(crate) fn object_type(doc: &LoroDoc, id: &ObjectId) -> Result<String> {
    type_of(&object_map(doc, id)?, id)
}

/// The container stored in `field` of an object, without schema checks.
pub(crate) fn field_container(doc: &LoroDoc, id: &ObjectId, field: &str) -> Result<Container> {
    match object_map(doc, id)?.get(field) {
        Some(ValueOrContainer::Container(found)) => Ok(found),
        _ => Err(KdmError::NotFound(format!("{id}.{field}"))),
    }
}

pub(crate) fn wrong_container(id: &ObjectId, field: &str) -> KdmError {
    KdmError::Engine(format!("{id}.{field} holds the wrong container"))
}

/// The error for using a field as a kind it is not.
pub(crate) fn wrong_kind(ty: &str, field: &str, kind: FieldKind) -> KdmError {
    KdmError::InvalidValue { ty: ty.to_owned(), field: field.to_owned(), reason: format!("is not a {kind:?} field").to_lowercase() }
}

/// A container field of an object, checked against the schema. `None` when the stored object
/// lacks the field: it was written under an older schema version, and the field reads as empty.
fn container(doc: &LoroDoc, schema: &Schema, id: &ObjectId, field: &str, kind: FieldKind) -> Result<Option<Container>> {
    let map = object_map(doc, id)?;
    let ty = type_of(&map, id)?;
    if schema.field(&ty, field)?.kind != kind {
        return Err(wrong_kind(&ty, field, kind));
    }
    match map.get(field) {
        Some(ValueOrContainer::Container(found)) => Ok(Some(found)),
        Some(ValueOrContainer::Value(_)) => Err(wrong_container(id, field)),
        None => Ok(None),
    }
}

pub(crate) fn text(doc: &LoroDoc, schema: &Schema, id: &ObjectId, field: &str) -> Result<Option<LoroText>> {
    match container(doc, schema, id, field, FieldKind::Text)? {
        Some(Container::Text(found)) => Ok(Some(found)),
        None => Ok(None),
        Some(_) => Err(wrong_container(id, field)),
    }
}

/// A text field's runs ([`crate::TextRun`]): one unmarked run for a field that declares no marks.
pub(crate) fn text_runs(doc: &LoroDoc, schema: &Schema, id: &ObjectId, field: &str) -> Result<Vec<crate::TextRun>> {
    let Some(found) = text(doc, schema, id, field)? else { return Ok(Vec::new()) };
    let def = schema.field(&object_type(doc, id)?, field)?;
    if def.has_marks() {
        return Ok(crate::marks::runs(&found, def));
    }
    let mut out = Vec::new();
    crate::marks::push_run(&mut out, found.to_string(), Default::default());
    Ok(out)
}

pub(crate) fn list(doc: &LoroDoc, schema: &Schema, id: &ObjectId, field: &str) -> Result<Option<LoroMovableList>> {
    match container(doc, schema, id, field, FieldKind::List)? {
        Some(Container::MovableList(found)) => Ok(Some(found)),
        None => Ok(None),
        Some(_) => Err(wrong_container(id, field)),
    }
}

pub(crate) fn tree(doc: &LoroDoc, schema: &Schema, id: &ObjectId, field: &str) -> Result<Option<LoroTree>> {
    match container(doc, schema, id, field, FieldKind::Tree)? {
        Some(Container::Tree(found)) => Ok(Some(found)),
        None => Ok(None),
        Some(_) => Err(wrong_container(id, field)),
    }
}

pub(crate) fn map(doc: &LoroDoc, schema: &Schema, id: &ObjectId, field: &str) -> Result<Option<LoroMap>> {
    match container(doc, schema, id, field, FieldKind::Map)? {
        Some(Container::Map(found)) => Ok(Some(found)),
        None => Ok(None),
        Some(_) => Err(wrong_container(id, field)),
    }
}

pub(crate) fn register(doc: &LoroDoc, schema: &Schema, id: &ObjectId, field: &str) -> Result<Value> {
    let map = object_map(doc, id)?;
    let ty = type_of(&map, id)?;
    if schema.field(&ty, field)?.kind.is_container() {
        return Err(KdmError::InvalidValue { ty, field: field.to_owned(), reason: "is a container; read it with its accessor".into() });
    }
    Ok(stored_value(map.get(field)))
}

/// A value read from the engine in canonical form; a missing value, or a container (in a map
/// field, only written outside the KDM), reads as `null`.
fn stored_value(found: Option<ValueOrContainer>) -> Value {
    match found {
        Some(ValueOrContainer::Value(value)) => canonical(value.to_json_value()),
        _ => Value::Null,
    }
}

/// One key of a map field, as [`stored_value`] reads it.
pub(crate) fn map_value(map: &LoroMap, key: &str) -> Value {
    stored_value(map.get(key))
}

/// A map field's keys and values as [`map_value`] reads them, sorted by key.
pub(crate) fn map_entries(map: &LoroMap) -> Vec<(String, Value)> {
    let mut entries = Vec::with_capacity(map.len());
    map.for_each(|key, value| entries.push((key.to_owned(), stored_value(Some(value)))));
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}

/// Ids of the objects of type `ty`, sorted. One pass over every object of the document.
pub(crate) fn objects_of_type(doc: &LoroDoc, ty: &str) -> Vec<ObjectId> {
    let mut ids = Vec::new();
    doc.get_map(OBJECTS).for_each(|key, value| {
        if let ValueOrContainer::Container(Container::Map(map)) = value {
            let id = ObjectId::from_string(key.to_string());
            if type_of(&map, &id).is_ok_and(|found| found == ty) {
                ids.push(id);
            }
        }
    });
    ids.sort();
    ids
}

/// A list's items. Every item of a KDM list is an object id; anything else was written outside
/// the KDM and is an [`KdmError::Encoding`] error, so indices never disagree with the engine's.
pub(crate) fn list_items(list: &LoroMovableList) -> Result<Vec<ObjectId>> {
    list.to_vec()
        .into_iter()
        .enumerate()
        .map(|(index, item)| match item {
            LoroValue::String(id) => Ok(ObjectId::from_string(id.to_string())),
            other => Err(KdmError::Encoding(format!("list item {index} is {other:?}, not an object id"))),
        })
        .collect()
}

/// The object a tree node names, or `None` for a node without one. Only a document written
/// outside the KDM can hold such a node; every tree read skips it with its subtree.
pub(crate) fn node_object(tree: &LoroTree, node: TreeID) -> Option<ObjectId> {
    match tree.get_meta(node).ok()?.get(NODE_OBJECT) {
        Some(ValueOrContainer::Value(value)) => value.to_json_value().as_str().map(ObjectId::from_string),
        _ => None,
    }
}

fn tree_json(tree: &LoroTree, parent: TreeParentId) -> Value {
    let children = tree.children(parent).unwrap_or_default();
    Value::Array(
        children
            .into_iter()
            .filter_map(|node| {
                let object = node_object(tree, node)?;
                Some(serde_json::json!({
                    "object": object.to_string(),
                    "children": tree_json(tree, TreeParentId::Node(node)),
                }))
            })
            .collect(),
    )
}

/// One object in canonical form: `$type` and every schema field. An object of a type the schema
/// does not declare (written under a newer schema version) is reported as its `$type` only, and a
/// container field the stored object lacks (an older one) reads as empty.
pub(crate) fn object_json(doc: &LoroDoc, schema: &Schema, id: &ObjectId) -> Result<Value> {
    let ty = object_type(doc, id)?;
    let mut out = Map::new();
    out.insert(TYPE_KEY.to_owned(), Value::String(ty.clone()));
    let Ok(def) = schema.type_def(&ty) else { return Ok(Value::Object(out)) };
    for (name, field) in &def.fields {
        let value = match field.kind {
            FieldKind::Text if field.has_marks() => {
                crate::marks::runs_json(&text(doc, schema, id, name)?.map(|text| crate::marks::runs(&text, field)).unwrap_or_default())
            }
            FieldKind::Text => Value::String(text(doc, schema, id, name)?.map(|text| text.to_string()).unwrap_or_default()),
            FieldKind::List => {
                let items = list(doc, schema, id, name)?.map(|list| list_items(&list)).transpose()?.unwrap_or_default();
                Value::Array(items.into_iter().map(|item| Value::String(item.to_string())).collect())
            }
            FieldKind::Tree => tree(doc, schema, id, name)?.map_or(Value::Array(Vec::new()), |tree| tree_json(&tree, TreeParentId::Root)),
            FieldKind::Map => map(doc, schema, id, name)?.map_or(Value::Object(Map::new()), |map| map.get_deep_value().to_json_value()),
            _ => register(doc, schema, id, name)?,
        };
        out.insert(name.clone(), value);
    }
    Ok(canonical(Value::Object(out)))
}

pub(crate) fn object_ids(doc: &LoroDoc) -> Vec<ObjectId> {
    let mut ids: Vec<ObjectId> = doc.get_map(OBJECTS).keys().map(|key| ObjectId::from_string(key.to_string())).collect();
    ids.sort();
    ids
}

/// The whole document in canonical form; equal on every replica that has the same changes.
pub(crate) fn state_json(doc: &LoroDoc, schema: &Schema) -> Result<Value> {
    let mut objects = Map::new();
    for id in object_ids(doc) {
        objects.insert(id.to_string(), object_json(doc, schema, &id)?);
    }
    Ok(canonical(serde_json::json!({
        "meta": doc.get_map(META).get_deep_value().to_json_value(),
        "objects": Value::Object(objects),
    })))
}
