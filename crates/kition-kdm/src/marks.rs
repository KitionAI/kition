// Copied from kition-sdk crates/kition-kdm/src/marks.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Marks on text (Standard 2.0 rule M19): rich-text run properties a `text` field declares in the
//! schema. Each mark key is its own last-writer-wins value over ranges of characters; the
//! schema's `expand` decides whether text typed at a marked range's ends takes the mark.

use std::collections::BTreeMap;

use loro::{ExpandType, LoroDoc, LoroText, StyleConfig, StyleConfigMap, TextDelta, ToJson};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::value::canonical;
use crate::{Expand, FieldDef, Schema};

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

fn expand_type(expand: Expand) -> ExpandType {
    match expand {
        Expand::After => ExpandType::After,
        Expand::Before => ExpandType::Before,
        Expand::Both => ExpandType::Both,
        Expand::None => ExpandType::None,
    }
}

/// Tells the engine every mark key of the schema and its expand. The configuration is local to a
/// replica (the engine does not replicate it); every replica of a document configures it from the
/// same schema before it marks anything. Only declared keys are configured, so the engine itself
/// refuses a mark of any other key.
pub(crate) fn configure(doc: &LoroDoc, schema: &Schema) {
    let mut styles = StyleConfigMap::new();
    for (key, expand) in schema.mark_expands() {
        // Schema::check refuses keys holding `:`, the one key the engine's map panics on.
        styles.insert(key.into(), StyleConfig { expand: expand_type(expand) });
    }
    doc.config_text_style(styles);
}

/// A text field's runs as the canonical state reads them: only `def`'s declared marks, null
/// values (unmarked) dropped, empty runs dropped, adjacent runs with equal marks merged.
pub(crate) fn runs(text: &LoroText, def: &FieldDef) -> Vec<TextRun> {
    let mut out: Vec<TextRun> = Vec::new();
    for delta in text.to_delta() {
        let TextDelta::Insert { insert, attributes } = delta else { continue };
        if insert.is_empty() {
            continue;
        }
        let mut marks = BTreeMap::new();
        for (key, value) in attributes.into_iter().flatten() {
            if !def.marks.contains_key(&key) {
                continue;
            }
            let value = canonical(value.to_json_value());
            if !value.is_null() {
                marks.insert(key, value);
            }
        }
        push_run(&mut out, insert, marks);
    }
    out
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
