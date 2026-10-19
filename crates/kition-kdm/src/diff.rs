// Copied from kition-sdk crates/kition-kdm/src/diff.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The object-level difference between two canonical states of one document (standard 2.0 A13):
//! what a draft created, changed, and deleted, for the comparison a person reviews before merging
//! it. `@kition/kdm`'s `diffStates` answers the same for the same states.

use serde::Serialize;
use serde_json::{Map, Value};

/// One object in a [`StateDiff`]: its id, its type, and the fields concerned (sorted).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ObjectChange {
    pub id: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub fields: Vec<String>,
}

/// A text-like field (a `text` field, or a string) a draft changed, as plain text before and after.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TextChange {
    pub id: String,
    pub field: String,
    pub before: String,
    pub after: String,
}

/// What changed between two canonical states, each list sorted by object id (then field).
///
/// - `created`: objects only `after` has; `fields` are those holding a value (not null, not
///   empty).
/// - `changed`: objects both have whose fields differ; `fields` are the differing ones.
/// - `deleted`: objects only `before` has; `fields` is empty.
/// - `texts`: the text-like fields of created and changed objects whose text differs.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct StateDiff {
    pub created: Vec<ObjectChange>,
    pub changed: Vec<ObjectChange>,
    pub deleted: Vec<ObjectChange>,
    pub texts: Vec<TextChange>,
}

impl StateDiff {
    pub fn is_empty(&self) -> bool {
        self.created.is_empty() && self.changed.is_empty() && self.deleted.is_empty()
    }

    /// As JSON: `{ created, changed, deleted, texts }`, objects as `{ id, type, fields }`.
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

const TYPE_KEY: &str = "$type";

fn objects(state: &Value) -> Map<String, Value> {
    state.get("objects").and_then(Value::as_object).cloned().unwrap_or_default()
}

fn type_of(object: &Value) -> String {
    object.get(TYPE_KEY).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn fields_of(object: &Value) -> Map<String, Value> {
    let mut fields = object.as_object().cloned().unwrap_or_default();
    fields.remove(TYPE_KEY);
    fields
}

fn holds_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
        _ => true,
    }
}

/// A field's text: a string, or a marked text's runs (`[{ insert, attributes? }]`) joined.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(runs) if !runs.is_empty() && runs.iter().all(|run| run.get("insert").is_some_and(Value::is_string)) => {
            Some(runs.iter().filter_map(|run| run.get("insert").and_then(Value::as_str)).collect())
        }
        _ => None,
    }
}

/// The difference `before → after` of two canonical states ([`crate::Replica::state_json`]).
pub fn diff_states(before: &Value, after: &Value) -> StateDiff {
    let (old, new) = (objects(before), objects(after));
    let mut diff = StateDiff::default();
    let mut ids: Vec<&String> = old.keys().chain(new.keys()).collect();
    ids.sort();
    ids.dedup();
    for id in ids {
        match (old.get(id), new.get(id)) {
            (None, Some(object)) => {
                let fields = fields_of(object);
                // Sorted here: a `serde_json` built with `preserve_order` keeps insertion order.
                let mut held: Vec<String> = fields.iter().filter(|(_, value)| holds_value(value)).map(|(name, _)| name.clone()).collect();
                held.sort();
                for name in &held {
                    if let Some(text) = fields.get(name).and_then(text_of).filter(|text| !text.is_empty()) {
                        diff.texts.push(TextChange { id: id.clone(), field: name.clone(), before: String::new(), after: text });
                    }
                }
                diff.created.push(ObjectChange { id: id.clone(), ty: type_of(object), fields: held });
            }
            (Some(object), None) => diff.deleted.push(ObjectChange { id: id.clone(), ty: type_of(object), fields: Vec::new() }),
            (Some(was), Some(now)) if was != now => {
                let (was_fields, now_fields) = (fields_of(was), fields_of(now));
                let mut names: Vec<&String> = was_fields.keys().chain(now_fields.keys()).collect();
                names.sort();
                names.dedup();
                let mut fields = Vec::new();
                for name in names {
                    let (a, b) = (was_fields.get(name).unwrap_or(&Value::Null), now_fields.get(name).unwrap_or(&Value::Null));
                    if a == b {
                        continue;
                    }
                    fields.push(name.clone());
                    let text = |value: &Value| if value.is_null() { Some(String::new()) } else { text_of(value) };
                    if let (Some(before), Some(after)) = (text(a), text(b))
                        && before != after
                    {
                        diff.texts.push(TextChange { id: id.clone(), field: name.clone(), before, after });
                    }
                }
                let ty = if type_of(now).is_empty() { type_of(was) } else { type_of(now) };
                diff.changed.push(ObjectChange { id: id.clone(), ty, fields });
            }
            _ => {}
        }
    }
    diff
}
