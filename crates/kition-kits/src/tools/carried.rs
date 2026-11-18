// Copied from kition-sdk crates/kition-kits/src/tools/carried.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! What a change carries with it that is no stored change: a parent's move
//! carries its descendants in world space, a layer's shift its keys in comp time. The kit answers
//! it (`model.carried`, `KitDocument::carried`), asked once per change set for the objects the set
//! names as changed or moved; each answer goes on the object's change as `carries: { count, what }`,
//! which receipts, `others` and the journal keep. A place whose kit answers `covers` with the field
//! `carries` has such an object asked about too (its move may move what is under the place).

use serde_json::{Map, Value, json};

use crate::manager::{Caller, KitManager};

fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Adds `carries` to the changes of `changes` the kit says carry something. A kit that does not
/// answer `model.carried` leaves the set as it is.
pub(crate) async fn mark(kits: &KitManager, kit_id: &str, document_id: &str, changes: &mut Value) {
    mark_from(kits, super::receipts::Source::Kit { kit_id, document_id }, changes).await;
}

pub(crate) async fn mark_from(kits: &KitManager, source: super::receipts::Source<'_>, changes: &mut Value) {
    let mut ids: Vec<String> = Vec::new();
    for list in ["changed", "moved"] {
        for item in changes[list].as_array().into_iter().flatten() {
            if let Some(id) = id_text(&item["id"])
                && !ids.contains(&id)
            {
                ids.push(id);
            }
        }
    }
    if ids.is_empty() {
        return;
    }
    let mut params = Map::new();
    params.insert("ids".into(), json!(ids));
    params.insert(
        "changes".into(),
        Value::Array(["changed", "moved"].iter().flat_map(|list| changes[*list].as_array().into_iter().flatten().cloned()).collect()),
    );
    let answer = match source {
        super::receipts::Source::Kit { kit_id, document_id } => kits.model(Caller::Agent, kit_id, document_id, "model.carried", params).await.ok(),
        super::receipts::Source::Editor(document) if document.can("premises") => {
            kits.bridge().call(document, "premise", json!({"method":"carried","params":params})).await.ok()
        }
        super::receipts::Source::Editor(_) => None,
    };
    let Some(answer) = answer else { return };
    for found in answer["objects"].as_array().into_iter().flatten() {
        let (Some(id), Some(carries)) = (id_text(&found["id"]), found.get("carries").filter(|carries| carries.is_object())) else { continue };
        let mut placed = false;
        for list in ["changed", "moved"] {
            for item in changes.get_mut(list).and_then(Value::as_array_mut).into_iter().flatten() {
                if id_text(&item["id"]).as_deref() == Some(id.as_str()) && !placed {
                    item["carries"] = carries.clone();
                    placed = true;
                }
            }
        }
    }
}
