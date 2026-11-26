// Copied from kition-sdk crates/kition-kdm/src/read.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Reads shared by [`crate::Replica`] and [`crate::Tx`], over the store.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Map, Value};

use crate::store::scalar::Entries;
use crate::store::text::Text;
use crate::store::tree::Tree;
use crate::store::{Field, Store};
use crate::{FieldDef, FieldKind, KDM_VERSION, KdmError, ObjectId, Result, Schema, TextRun};

pub(crate) const TYPE_KEY: &str = "$type";

/// Refuses projected objects, and projected membership, in a stored document.
pub(crate) fn check_projected_storage(store: &Store, schema: &Schema) -> Result<()> {
    if !schema.types.values().any(|def| def.projected) {
        return Ok(());
    }
    for (id, object) in store.objects() {
        let Some(def) = schema.types.get(&**object.ty()) else { continue };
        if def.projected {
            return Err(KdmError::InvalidValue {
                ty: object.ty().to_string(),
                field: "$type".into(),
                reason: "projected objects are computed by the kit, never stored".into(),
            });
        }
        for (field, field_def) in &def.fields {
            if !field_def.of.as_ref().is_some_and(|of| schema.types.get(of).is_some_and(|def| def.projected)) {
                continue;
            }
            if store.field(id, field).is_some() {
                return Err(KdmError::InvalidValue {
                    ty: object.ty().to_string(),
                    field: field.clone(),
                    reason: "projected membership is computed by the kit, never stored".into(),
                });
            }
        }
    }
    Ok(())
}

pub(crate) fn object_type(store: &Store, id: &ObjectId) -> Result<String> {
    store.object(id).map(|object| object.ty().to_string()).ok_or_else(|| KdmError::NotFound(id.to_string()))
}

/// The error for a field that holds another kind than the schema declares (written outside the
/// KDM).
pub(crate) fn wrong_container(id: &ObjectId, field: &str) -> KdmError {
    KdmError::Engine(format!("{id}.{field} holds the wrong kind of value"))
}

/// The error for using a field as a kind it is not.
pub(crate) fn wrong_kind(ty: &str, field: &str, kind: FieldKind) -> KdmError {
    KdmError::InvalidValue { ty: ty.to_owned(), field: field.to_owned(), reason: format!("is not a {kind:?} field").to_lowercase() }
}

/// A field of an object, checked against the schema to be of `kind`. `None` when the object holds
/// nothing there: the field reads as empty.
fn container<'a>(store: &'a Store, schema: &Schema, id: &ObjectId, field: &str, kind: FieldKind) -> Result<Option<&'a Field>> {
    let object = store.object(id).ok_or_else(|| KdmError::NotFound(id.to_string()))?;
    if schema.field(object.ty(), field)?.kind != kind {
        return Err(wrong_kind(object.ty(), field, kind));
    }
    Ok(object.get(field))
}

pub(crate) fn text<'a>(store: &'a Store, schema: &Schema, id: &ObjectId, field: &str) -> Result<Option<&'a Text>> {
    match container(store, schema, id, field, FieldKind::Text)? {
        None => Ok(None),
        Some(Field::Text(text)) => Ok(Some(text)),
        Some(_) => Err(wrong_container(id, field)),
    }
}

/// A text field's runs ([`crate::TextRun`]): only the field's declared marks, adjacent runs with
/// equal marks merged; one unmarked run for a field that declares no marks.
pub(crate) fn text_runs(store: &Store, schema: &Schema, id: &ObjectId, field: &str) -> Result<Vec<TextRun>> {
    let Some(found) = text(store, schema, id, field)? else { return Ok(Vec::new()) };
    let ty = object_type(store, id)?;
    let def = schema.field(&ty, field)?;
    Ok(runs_of(found, def))
}

/// The runs of a text as the field `def` reads them.
pub(crate) fn runs_of(text: &Text, def: &FieldDef) -> Vec<TextRun> {
    let mut out = Vec::new();
    if !def.has_marks() {
        crate::marks::push_run(&mut out, text.string(), BTreeMap::new());
        return out;
    }
    for run in text.runs() {
        let marks = run.attributes.into_iter().filter(|(key, value)| def.marks.contains_key(key) && !value.is_null()).collect();
        crate::marks::push_run(&mut out, run.insert, marks);
    }
    out
}

pub(crate) fn list<'a>(store: &'a Store, schema: &Schema, id: &ObjectId, field: &str) -> Result<&'a [ObjectId]> {
    match container(store, schema, id, field, FieldKind::List)? {
        None => Ok(&[]),
        Some(Field::List(items)) => Ok(items.as_slice()),
        Some(_) => Err(wrong_container(id, field)),
    }
}

pub(crate) fn tree<'a>(store: &'a Store, schema: &Schema, id: &ObjectId, field: &str) -> Result<Option<&'a Tree>> {
    match container(store, schema, id, field, FieldKind::Tree)? {
        None => Ok(None),
        Some(Field::Tree(tree)) => Ok(Some(tree)),
        Some(_) => Err(wrong_container(id, field)),
    }
}

pub(crate) fn map<'a>(store: &'a Store, schema: &Schema, id: &ObjectId, field: &str) -> Result<Option<&'a Entries>> {
    match container(store, schema, id, field, FieldKind::Map)? {
        None => Ok(None),
        Some(Field::Map(entries)) => Ok(Some(&**entries)),
        Some(_) => Err(wrong_container(id, field)),
    }
}

pub(crate) fn register(store: &Store, schema: &Schema, id: &ObjectId, field: &str) -> Result<Value> {
    let object = store.object(id).ok_or_else(|| KdmError::NotFound(id.to_string()))?;
    if schema.field(object.ty(), field)?.kind.is_container() {
        return Err(KdmError::InvalidValue {
            ty: object.ty().to_string(),
            field: field.to_owned(),
            reason: "is a container; read it with its accessor".into(),
        });
    }
    Ok(match object.get(field) {
        Some(Field::Value(value)) => value.to_value(),
        _ => Value::Null,
    })
}

/// Ids of the objects of type `ty`, sorted. One pass over every object of the document.
pub(crate) fn objects_of_type(store: &Store, ty: &str) -> Vec<ObjectId> {
    let mut ids: Vec<ObjectId> = store.objects().filter(|(_, object)| &**object.ty() == ty).map(|(id, _)| id.clone()).collect();
    ids.sort();
    ids
}

/// Every object's id grouped by its type, each group sorted.
pub(crate) fn objects_by_type(store: &Store) -> HashMap<String, Vec<ObjectId>> {
    let mut groups: HashMap<String, Vec<ObjectId>> = HashMap::new();
    for (id, object) in store.objects() {
        groups.entry(object.ty().to_string()).or_default().push(id.clone());
    }
    for ids in groups.values_mut() {
        ids.sort();
    }
    groups
}

/// A tree's JSON as reads see it: a node naming no object of the document is left out with its
/// subtree.
fn tree_json(tree: &Tree, live: &dyn Fn(&ObjectId) -> bool) -> Value {
    tree.to_json(live)
}

/// One object in canonical form: `$type` and every schema field. An object of a type the schema
/// does not declare (written under a newer schema version) is reported as its `$type` only, and a
/// field the stored object lacks reads as empty.
pub(crate) fn object_json(store: &Store, schema: &Schema, id: &ObjectId) -> Result<Value> {
    object_json_in(store, schema, id, &|node: &ObjectId| store.contains(node))
}

/// [`object_json`] with `live` saying which objects exist (a tree's nodes naming none are left
/// out): a store holding only some of a state's objects reads them as the whole state does.
pub(crate) fn object_json_in(store: &Store, schema: &Schema, id: &ObjectId, live: &dyn Fn(&ObjectId) -> bool) -> Result<Value> {
    let ty = object_type(store, id)?;
    let mut out = Map::new();
    out.insert(TYPE_KEY.to_owned(), Value::String(ty.clone()));
    let Ok(def) = schema.type_def(&ty) else { return Ok(Value::Object(out)) };
    for (name, field) in &def.fields {
        out.insert(name.clone(), field_json_in(store, schema, id, name, field, live)?);
    }
    Ok(Value::Object(out))
}

/// Field `name` (declared as `field`) of object `id`, as [`object_json`] reports it.
pub(crate) fn field_json(store: &Store, schema: &Schema, id: &ObjectId, name: &str, field: &FieldDef) -> Result<Value> {
    field_json_in(store, schema, id, name, field, &|node: &ObjectId| store.contains(node))
}

/// [`field_json`] with `live` saying which objects exist ([`object_json_in`]).
fn field_json_in(store: &Store, schema: &Schema, id: &ObjectId, name: &str, field: &FieldDef, live: &dyn Fn(&ObjectId) -> bool) -> Result<Value> {
    Ok(match field.kind {
        FieldKind::Text if field.has_marks() => crate::marks::runs_json(&text(store, schema, id, name)?.map(|text| runs_of(text, field)).unwrap_or_default()),
        FieldKind::Text => Value::String(text(store, schema, id, name)?.map(Text::string).unwrap_or_default()),
        FieldKind::List => Value::Array(list(store, schema, id, name)?.iter().map(|item| Value::String(item.to_string())).collect()),
        FieldKind::Tree => tree(store, schema, id, name)?.map_or(Value::Array(Vec::new()), |tree| tree_json(tree, live)),
        FieldKind::Map => Value::Object(
            map(store, schema, id, name)?.map(|entries| entries.iter().map(|(key, value)| (key.to_text(), value.to_value())).collect()).unwrap_or_default(),
        ),
        _ => register(store, schema, id, name)?,
    })
}

/// The document's meta in canonical form.
pub(crate) fn meta_json(store: &Store) -> Value {
    let mut meta = Map::new();
    meta.insert("docId".into(), Value::String(store.doc_id.to_string()));
    meta.insert("kdm".into(), Value::from(KDM_VERSION));
    meta.insert("kit".into(), Value::String(store.kit.clone()));
    meta.insert("schemaVersion".into(), Value::from(store.schema_version));
    Value::Object(meta)
}

/// The whole document in canonical form: `{meta, objects}`, keys sorted.
pub(crate) fn state_json(store: &Store, schema: &Schema) -> Result<Value> {
    let mut ids: Vec<&ObjectId> = store.objects().map(|(id, _)| id).collect();
    ids.sort();
    let mut objects = Map::new();
    for id in ids {
        objects.insert(id.to_string(), object_json(store, schema, id)?);
    }
    let mut out = Map::new();
    out.insert("meta".into(), meta_json(store));
    out.insert("objects".into(), Value::Object(objects));
    Ok(Value::Object(out))
}
