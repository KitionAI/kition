// Copied from kition-sdk crates/kition-kdm/src/store/check.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Operations from another replica (an import, a draft's merge) checked against the schema as a
//! transaction checks its own ([`crate::Tx`]): a field used as the kind the schema declares it
//! (no `set` on a list), values a transaction would accept (no integer beyond ±2^53, no nesting a
//! change cannot carry, a declared register's kind and limits), items and nodes of the declared
//! type, and values in their canonical form. An object of a type, or a field, the schema does not
//! declare (written under a newer schema, data model 7.4 C9) passes as it is, its values checked
//! for what every replica reads.

use serde_json::Value;

use super::op::Op;
use super::{Field, Object, Store};
use crate::value::canonical;
use crate::{FieldDef, FieldKind, KdmError, ObjectId, Result, Schema, read};

/// `op` checked against `schema` on the state `store` holds before it applies, its values
/// canonical; a refusal is the error a transaction gives ([`KdmError::InvalidValue`]).
pub(crate) fn checked(op: Op, store: &Store, schema: &Schema) -> Result<Op> {
    Ok(match op {
        Op::Create { id, object, trees } => Op::Create { id, object: Box::new(checked_object(*object, schema)?), trees },
        Op::Set { id, field, value, was } => {
            let value = match declared(store, schema, &id, &field) {
                Some((ty, def)) => {
                    crate::tx::nesting_refusal(ty, &field, &value)?;
                    schema.check_value(ty, &field, &value)?;
                    if let Some(target) = value.as_str() {
                        check_target(store, ty, &field, def, target)?;
                    }
                    canonical(value)
                }
                None => portable(store, &id, &field, value)?,
            };
            Op::Set { id, field, value, was }
        }
        Op::TextInsert { id, field, index, text, marks } => {
            kind(store, schema, &id, &field, FieldKind::Text)?;
            let marks = match marks {
                None => None,
                Some(marks) => Some(marks.into_iter().map(|(key, value)| Ok((key, portable(store, &id, &field, value)?))).collect::<Result<_>>()?),
            };
            Op::TextInsert { id, field, index, text, marks }
        }
        Op::TextDelete { ref id, ref field, .. } => {
            kind(store, schema, id, field, FieldKind::Text)?;
            op
        }
        Op::TextMark { id, field, start, end, key, value, was } => {
            kind(store, schema, &id, &field, FieldKind::Text)?;
            let value = if value.is_null() { value } else { portable(store, &id, &field, value)? };
            Op::TextMark { id, field, start, end, key, value, was }
        }
        Op::ListInsert { ref id, ref field, ref item, .. } => {
            if let Some((ty, def)) = kind(store, schema, id, field, FieldKind::List)? {
                check_target(store, ty, field, def, item.as_str())?;
            }
            op
        }
        Op::ListRemove { ref id, ref field, .. } | Op::ListMove { ref id, ref field, .. } => {
            kind(store, schema, id, field, FieldKind::List)?;
            op
        }
        Op::MapSet { id, field, key, value, was } => {
            let value = match (kind(store, schema, &id, &field, FieldKind::Map)?, value) {
                (_, None) => None,
                (Some((ty, def)), Some(value)) => {
                    crate::tx::nesting_refusal(ty, &field, &value)?;
                    schema.check_map_entry(ty, &field, &key, &value)?;
                    if let Some(reason) = crate::schema::unportable(&value) {
                        return Err(KdmError::InvalidValue { ty: ty.to_owned(), field: field.to_string(), reason: reason.into() });
                    }
                    if let Some(target) = value.as_str() {
                        check_target(store, ty, &field, def, target)?;
                    }
                    Some(canonical(value))
                }
                (None, Some(value)) => Some(portable(store, &id, &field, value)?),
            };
            Op::MapSet { id, field, key, value, was }
        }
        Op::TreeCreate { ref id, ref field, ref node, .. } => {
            // A node names a live object, as a transaction's does: the change made it before this
            // operation, or the document holds it.
            if !store.contains(node) {
                return Err(KdmError::Stale(format!("object `{node}` does not exist: a node of {id}.{field} names a live object")));
            }
            if let Some((ty, def)) = kind(store, schema, id, field, FieldKind::Tree)? {
                check_target(store, ty, field, def, node.as_str())?;
            }
            op
        }
        Op::TreeMove { ref id, ref field, .. } | Op::TreeDelete { ref id, ref field, .. } => {
            kind(store, schema, id, field, FieldKind::Tree)?;
            op
        }
        Op::Delete { .. } | Op::SchemaVersion { .. } => op,
    })
}

/// The type (as the schema names it) of object `id` and the schema's definition of its field
/// `field`; `None` when the object does not exist (the store refuses the operation) or the schema
/// declares no such type or field.
fn declared<'s>(store: &Store, schema: &'s Schema, id: &ObjectId, field: &str) -> Option<(&'s str, &'s FieldDef)> {
    let object = store.object(id)?;
    let (ty, def) = schema.types.get_key_value(&*object.ty)?;
    Some((ty.as_str(), def.fields.get(field)?))
}

/// Refuses an operation of kind `kind` on a field the schema declares as another kind; answers
/// the declaration, when there is one.
fn kind<'s>(store: &Store, schema: &'s Schema, id: &ObjectId, field: &str, kind: FieldKind) -> Result<Option<(&'s str, &'s FieldDef)>> {
    match declared(store, schema, id, field) {
        Some((ty, def)) if def.kind != kind => Err(read::wrong_kind(ty, field, kind)),
        found => Ok(found),
    }
}

/// Refuses an item, node or reference of another type than the field declares (`of`), as
/// [`crate::Tx`] does; one naming no object passes.
fn check_target(store: &Store, ty: &str, field: &str, def: &FieldDef, target: &str) -> Result<()> {
    let Some(of) = &def.of else { return Ok(()) };
    match store.object(&ObjectId::from_string(target)) {
        Some(object) if &*object.ty != of.as_str() => Err(KdmError::InvalidValue {
            ty: ty.to_owned(),
            field: field.to_owned(),
            reason: format!("expects an object of type `{of}`, and `{target}` is a `{}`", object.ty),
        }),
        _ => Ok(()),
    }
}

/// A value of a field the schema does not declare (or a mark value): refused when it nests deeper
/// than a change carries or holds an integer beyond ±2^53; canonical otherwise.
fn portable(store: &Store, id: &ObjectId, field: &str, value: Value) -> Result<Value> {
    let ty = store.object(id).map_or_else(|| id.to_string(), |object| object.ty.to_string());
    crate::tx::nesting_refusal(&ty, field, &value)?;
    if let Some(reason) = crate::schema::unportable(&value) {
        return Err(KdmError::InvalidValue { ty, field: field.to_owned(), reason: reason.into() });
    }
    Ok(canonical(value))
}

/// A created object's registers and map entries checked as [`checked`] checks a `set` and a
/// `map_set`, canonical; its list items as a `list_insert`'s. Its container fields were read as
/// the schema declares them ([`Object::from_content`]).
fn checked_object(mut object: Object, schema: &Schema) -> Result<Object> {
    let def = schema.types.get(&*object.ty);
    let ty = object.ty.to_string();
    for (name, field) in &mut object.fields {
        let declared = def.and_then(|def| def.fields.get(&**name));
        match field {
            Field::Value(value) => {
                crate::tx::nesting_refusal(&ty, name, value)?;
                match declared {
                    Some(_) => schema.check_value(&ty, name, value)?,
                    None => {
                        if let Some(reason) = crate::schema::unportable(value) {
                            return Err(KdmError::InvalidValue { ty, field: name.to_string(), reason: reason.into() });
                        }
                    }
                }
                *value = canonical(std::mem::take(value));
            }
            Field::Map(entries) => {
                for value in entries.values_mut() {
                    crate::tx::nesting_refusal(&ty, name, value)?;
                    if let Some(reason) = crate::schema::unportable(value) {
                        return Err(KdmError::InvalidValue { ty, field: name.to_string(), reason: reason.into() });
                    }
                    *value = canonical(std::mem::take(value));
                }
            }
            Field::Text(_) | Field::List(_) | Field::Tree(_) => {}
        }
    }
    Ok(object)
}
