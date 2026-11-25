// Copied from kition-sdk crates/kition-kdm/src/marks.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Marks on text (Standard 2.0 rule M19): rich-text run properties a `text` field declares in the
//! schema. Each mark key holds one value over ranges of characters; the schema's `expand` decides
//! whether text typed at a marked range's ends takes the mark (`store::text`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::value::canonical;

/// One run of a text field: characters that carry the same marks.
///
/// [`crate::Replica::text_delta`] reads a text field as runs in order; adjacent runs differ in
/// their marks, no run is empty, and `attributes` holds only the field's declared marks, keys
/// sorted, values in canonical form. A run without marks has empty `attributes`, which its JSON
/// form (`{ "insert": "..." }`) omits.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TextRun {
    pub insert: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attributes: BTreeMap<String, Value>,
}

impl TextRun {
    pub fn new(insert: impl Into<String>) -> Self {
        Self { insert: insert.into(), attributes: BTreeMap::new() }
    }

    /// The run with mark `key` set to `value`.
    pub fn with(mut self, key: impl Into<String>, value: Value) -> Self {
        self.attributes.insert(key.into(), value);
        self
    }

    /// The run's canonical JSON: `{ "insert": ..., "attributes": {...} }`, `attributes` omitted
    /// when the run has none.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        if !self.attributes.is_empty() {
            out.insert("attributes".into(), Value::Object(self.attributes.iter().map(|(key, value)| (key.clone(), value.clone())).collect()));
        }
        out.insert("insert".into(), Value::String(self.insert.clone()));
        canonical(Value::Object(out))
    }
}

/// Appends a run, merging it into the last one when their marks are equal.
pub(crate) fn push_run(out: &mut Vec<TextRun>, insert: String, attributes: BTreeMap<String, Value>) {
    if insert.is_empty() {
        return;
    }
    if let Some(last) = out.last_mut()
        && last.attributes == attributes
    {
        last.insert.push_str(&insert);
        return;
    }
    out.push(TextRun { insert, attributes });
}

/// The canonical JSON of a marked text field: its runs.
pub(crate) fn runs_json(runs: &[TextRun]) -> Value {
    Value::Array(runs.iter().map(TextRun::to_json).collect())
}
