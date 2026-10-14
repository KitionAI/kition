//! Object references inside option JSON.
//!
//! The relational API names tables and fields in field options and dashboard configs by their
//! integer ids (`target_table_id: 3`). The KDM document stores object ids instead, under keys
//! without the `_id` suffix (`target_table: "<object id>"`), because integer ids are local to one
//! SQLite projection. [`ID_KEYS`] is the one list of such keys; [`options_to_kdm`] and
//! [`options_from_kdm`] convert between the two forms.

use serde_json::{Map, Value};

use kition_kdm::ObjectId;

use crate::{KitableError, Result};

/// What an id-valued option names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IdKind {
    Table,
    Field,
}

/// One id-valued option: `relational` in the relational form, `kdm` in the document, inside the
/// object at key `parent` (`None`: the top level).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdKey {
    pub parent: Option<&'static str>,
    pub relational: &'static str,
    pub kdm: &'static str,
    pub kind: IdKind,
}

const fn key(
    parent: Option<&'static str>,
    relational: &'static str,
    kdm: &'static str,
    kind: IdKind,
) -> IdKey {
    IdKey {
        parent,
        relational,
        kdm,
        kind,
    }
}

/// Every id-valued key of field options (`link_to_record`, `lookup`, `rollup`, AI fields) and of
/// dashboard configs.
pub const ID_KEYS: [IdKey; 6] = [
    // link_to_record
    key(None, "target_table_id", "target_table", IdKind::Table),
    key(None, "symmetric_field_id", "symmetric_field", IdKind::Field),
    // lookup and rollup
    key(None, "link_field_id", "link_field", IdKind::Field),
    key(None, "target_field_id", "target_field", IdKind::Field),
    // AI fields
    key(
        Some("ai_config"),
        "source_field_id",
        "source_field",
        IdKind::Field,
    ),
    // dashboards
    key(None, "source_table_id", "source_table", IdKind::Table),
];

/// The KDM form of relational options: every key of [`ID_KEYS`] present is replaced by its KDM
/// key holding the object id `resolve` answers. `null`, `0`, and blank ids become `null`. An id
/// `resolve` does not know, or a value that is not an id, is [`KitableError::Invalid`]. Values
/// other than objects are returned unchanged.
pub fn options_to_kdm(
    options: &Value,
    resolve: impl Fn(IdKind, i64) -> Option<ObjectId>,
) -> Result<Value> {
    let mut out = options.clone();
    for id_key in ID_KEYS {
        let Some(map) = target(&mut out, id_key.parent) else {
            continue;
        };
        let Some(raw) = map.remove(id_key.relational) else {
            continue;
        };
        let value = match local_id(&raw)? {
            None => Value::Null,
            Some(id) => match resolve(id_key.kind, id) {
                Some(object) => Value::String(object.to_string()),
                None => {
                    return Err(KitableError::invalid(format!(
                        "option {} names an unknown {} id {id}",
                        id_key.relational,
                        kind_name(id_key.kind)
                    )));
                }
            },
        };
        map.insert(id_key.kdm.to_owned(), value);
    }
    Ok(out)
}

/// The relational form of KDM options: every KDM key of [`ID_KEYS`] present is replaced by its
/// relational key holding the integer id `local` answers, or `null` when the object is gone (a
/// reference left dangling by a concurrent delete).
pub fn options_from_kdm(options: &Value, local: impl Fn(&ObjectId) -> Option<i64>) -> Value {
    let mut out = options.clone();
    for id_key in ID_KEYS {
        let Some(map) = target(&mut out, id_key.parent) else {
            continue;
        };
        let Some(raw) = map.remove(id_key.kdm) else {
            continue;
        };
        let value = raw
            .as_str()
            .and_then(|id| local(&ObjectId::from_string(id)))
            .map_or(Value::Null, Value::from);
        map.insert(id_key.relational.to_owned(), value);
    }
    out
}

/// The first relational key of [`ID_KEYS`] present in `options`, if any.
pub fn relational_key(options: &Value) -> Option<&'static str> {
    ID_KEYS.iter().find_map(|id_key| {
        let map = options.as_object()?;
        let map = match id_key.parent {
            None => map,
            Some(parent) => map.get(parent)?.as_object()?,
        };
        map.contains_key(id_key.relational)
            .then_some(id_key.relational)
    })
}

fn target<'a>(value: &'a mut Value, parent: Option<&str>) -> Option<&'a mut Map<String, Value>> {
    let map = value.as_object_mut()?;
    match parent {
        None => Some(map),
        Some(parent) => map.get_mut(parent)?.as_object_mut(),
    }
}

/// A relational id as the legacy readers accept it: a number or a decimal string; `0`, blank,
/// and `null` are no id.
fn local_id(value: &Value) -> Result<Option<i64>> {
    let invalid = || KitableError::invalid(format!("option value {value} is not an id"));
    let id = match value {
        Value::Null => return Ok(None),
        Value::Number(number) => number
            .as_i64()
            .or_else(|| {
                number
                    .as_f64()
                    .filter(|float| float.fract() == 0.0)
                    .map(|float| float as i64)
            })
            .ok_or_else(invalid)?,
        Value::String(text) if text.trim().is_empty() => return Ok(None),
        Value::String(text) => text.trim().parse().map_err(|_| invalid())?,
        _ => return Err(invalid()),
    };
    Ok((id != 0).then_some(id))
}

fn kind_name(kind: IdKind) -> &'static str {
    match kind {
        IdKind::Table => "table",
        IdKind::Field => "field",
    }
}
