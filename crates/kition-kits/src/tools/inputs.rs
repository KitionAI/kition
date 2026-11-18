// Copied from kition-sdk crates/kition-kits/src/tools/inputs.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! External input observations participate in revisions even when document bytes do not change.
use serde_json::{Map, Value};

use crate::manager::{DocumentView, KitManager};

pub(crate) async fn observe(kits: &KitManager, key: &str, view: &DocumentView) {
    observe_from(kits, key, super::guard::Reader::Kit(view)).await;
}

pub(crate) async fn observe_from(kits: &KitManager, key: &str, reader: super::guard::Reader<'_>) {
    let answer = reader.context(kits, "inputs", Map::new()).await;
    if matches!(answer, Ok(None)) {
        return;
    }
    let values = answer
        .ok()
        .flatten()
        .and_then(|answer| {
            let inputs = answer["inputs"].as_array()?;
            let mut values = Map::new();
            for input in inputs {
                let name = input["name"].as_str().filter(|name| !name.is_empty())?;
                let fingerprint = input.get("fingerprint")?;
                if !fingerprint.is_null() && !fingerprint.is_string() || values.contains_key(name) {
                    return None;
                }
                values.insert(name.to_owned(), fingerprint.clone());
            }
            Some(Value::Object(values))
        })
        .unwrap_or(Value::Null);
    kits.inner.journals.observe_inputs(key, values);
}
