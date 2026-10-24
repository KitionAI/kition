//! Design pane support: the bounded context the client attaches, and
//! patch proposals the user reviews (the client previews
//! them from the streamed tool arguments and the logged result meta).
//! The client validates each patch strictly before previewing it; the
//! runtime checks the envelope, operations, identifiers, and references.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::run::{Run, ToolOutput, ToolResult};
use crate::workspace::clean_path;

const DESIGN_OPS: &[&str] = &[
    "text.set",
    "style.set",
    "layer.create",
    "layer.move",
    "layer.resize",
    "layer.reorder",
    "layer.delete",
    "layout.align",
    "layout.distribute",
    "artboard.background",
];

fn identifier(value: &str) -> bool {
    let mut chars = value.chars();
    (1..=128).contains(&value.len())
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
}

fn portable_path(value: &str) -> bool {
    !value.contains(['\\', '\0']) && clean_path(value, false).is_ok_and(|cleaned| cleaned == value)
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn items<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// Checks a `design.context` payload.
pub fn validate_design_context(context: &Value) -> Result<(), String> {
    let design = &context["design"];
    let artboard = &context["artboard"];
    let dimension = |key: &str| {
        artboard[key]
            .as_f64()
            .is_some_and(|n| (1.0..=100_000.0).contains(&n))
    };
    let ok = text(context, "type") == "design.context"
        && context["schema_version"].as_i64() == Some(1)
        && identifier(text(design, "id"))
        && portable_path(text(design, "path"))
        && (1..=500).contains(&text(design, "title").trim().chars().count())
        && dimension("width")
        && dimension("height")
        && items(context, "layers").len() <= 500
        && items(context, "selected_layer_ids").len() <= 100
        && items(context, "recent_operations").len() <= 50
        && items(context, "layers")
            .iter()
            .all(|layer| identifier(text(layer, "id")));
    if ok {
        Ok(())
    } else {
        Err("invalid design context".into())
    }
}

pub fn design_prompt(context: &Value) -> String {
    format!(
        "Active Kition design context (pane = design):\nCoordinates are artboard pixels from the top-left corner. Layer ids are authoritative, roles are hints, and locked layers must not be edited. Selected ids identify the user's current focus.\n{context}"
    )
}

fn patch_envelope<'a>(
    input: &'a Value,
    kind: &str,
    max_ops: usize,
    ops: &[&str],
) -> Result<&'a [Value], String> {
    let operations = items(input, "operations");
    let summary = text(input, "summary").trim().chars().count();
    if text(input, "type") != kind
        || input["schema_version"].as_i64() != Some(1)
        || !(1..=2000).contains(&summary)
        || operations.is_empty()
        || operations.len() > max_ops
    {
        return Err(format!(
            "invalid {kind}: check type, schema_version, summary, and operations"
        ));
    }
    if let Some(bad) = operations.iter().find(|op| !ops.contains(&text(op, "op"))) {
        return Err(format!("unsupported operation {:?}", text(bad, "op")));
    }
    Ok(operations)
}

fn check_design(input: &Value, context: &Value) -> Result<usize, String> {
    let operations = patch_envelope(input, "design.patch", 100, DESIGN_OPS)?;
    let mut kinds: HashMap<String, String> = HashMap::new();
    let mut locked = HashSet::new();
    for layer in items(context, "layers") {
        kinds.insert(text(layer, "id").to_owned(), text(layer, "kind").to_owned());
        if layer["locked"].as_bool() == Some(true) {
            locked.insert(text(layer, "id").to_owned());
        }
    }
    let existing = |kinds: &HashMap<String, String>, id: &str| -> Result<(), String> {
        if !kinds.contains_key(id) {
            return Err(format!("design patch references unknown layer {id:?}"));
        }
        if locked.contains(id) {
            return Err(format!("design patch edits locked layer {id:?}"));
        }
        Ok(())
    };
    for operation in operations {
        let ids: Vec<&str> = items(operation, "layer_ids")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        match text(operation, "op") {
            "layer.create" => {
                let layer = &operation["layer"];
                let id = text(layer, "id");
                if !identifier(id)
                    || !["text", "rectangle", "ellipse", "line"].contains(&text(layer, "kind"))
                {
                    return Err("design patch creates an invalid layer".into());
                }
                if kinds
                    .insert(id.to_owned(), text(layer, "kind").to_owned())
                    .is_some()
                {
                    return Err(format!("design patch reuses an existing id {id:?}"));
                }
            }
            "text.set" => {
                let id = text(operation, "layer_id");
                existing(&kinds, id)?;
                if kinds.get(id).map(String::as_str) != Some("text") {
                    return Err(format!("design layer {id:?} is not a text layer"));
                }
            }
            "layer.resize" | "layer.reorder" => existing(&kinds, text(operation, "layer_id"))?,
            "layer.delete" => {
                for id in &ids {
                    existing(&kinds, id)?;
                }
                for id in ids {
                    kinds.remove(id);
                }
            }
            "style.set" | "layer.move" | "layout.align" | "layout.distribute" => {
                if ids.is_empty() {
                    return Err("design operation needs layer_ids".into());
                }
                for id in ids {
                    existing(&kinds, id)?;
                }
            }
            _ => {}
        }
    }
    Ok(operations.len())
}

pub async fn propose_design_patch(run: &Run, input: &Value) -> ToolResult {
    let context = match (&run.design, run.pane.as_str()) {
        (Some(context), "design") => context,
        _ => return Err("design context is unavailable for this turn".into()),
    };
    let count = check_design(input, context)?;
    let summary = text(input, "summary").to_owned();
    Ok(ToolOutput::new(
        format!("Proposed {count} design change(s) for user review: {summary}"),
        json!({ "awaiting_user_review": true, "operation_count": count, "summary": summary }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_design_patches() {
        let context = json!({
            "type": "design.context", "schema_version": 1,
            "design": { "id": "d1", "path": "a.kidesign", "title": "A" },
            "artboard": { "width": 800, "height": 600, "background": "#ffffff" },
            "selected_layer_ids": [], "recent_operations": [],
            "layers": [{ "id": "t1", "kind": "text" }, { "id": "bg", "kind": "rectangle", "locked": true }],
        });
        assert!(validate_design_context(&context).is_ok());
        let patch = |ops: Value| json!({ "type": "design.patch", "schema_version": 1, "summary": "s", "operations": ops });
        assert_eq!(
            check_design(
                &patch(json!([{ "op": "text.set", "layer_id": "t1", "text": "Hi" }])),
                &context
            ),
            Ok(1)
        );
        assert!(
            check_design(
                &patch(json!([{ "op": "layer.delete", "layer_ids": ["bg"] }])),
                &context
            )
            .is_err()
        );
        assert!(
            check_design(
                &patch(json!([{ "op": "text.set", "layer_id": "bg", "text": "x" }])),
                &context
            )
            .is_err()
        );
    }
}
