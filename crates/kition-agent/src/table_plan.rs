//! The `table_plan` summary of a table turn: the fenced JSON block the
//! model appends in preview/apply mode, merged with what the turn's table
//! tools actually did.

use std::sync::LazyLock;

use serde_json::{Map, Value, json};

use crate::store::AgentToolCall;

static BLOCK: LazyLock<Option<regex::Regex>> =
    LazyLock::new(|| regex::Regex::new(r"(?s)```table_plan\s*(\{.*?\})\s*```").ok());

pub fn strip_block(content: &str) -> String {
    match BLOCK.as_ref() {
        Some(re) => re.replace_all(content, "").trim().to_owned(),
        None => content.trim().to_owned(),
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text.trim().to_owned()),
                Value::Null => None,
                other => Some(other.to_string()),
            })
            .filter(|text| !text.is_empty())
            .collect(),
        Some(Value::String(text)) if !text.trim().is_empty() => vec![text.trim().to_owned()],
        _ => Vec::new(),
    }
}

fn merge(base: &mut Vec<String>, extra: Vec<String>) {
    for item in extra {
        if !base.contains(&item) {
            base.push(item);
        }
    }
}

fn int(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn extract(content: &str) -> (String, Map<String, Value>) {
    let Some(re) = BLOCK.as_ref() else {
        return (content.trim().to_owned(), Map::new());
    };
    let Some(raw) = re
        .captures(content)
        .and_then(|captures| serde_json::from_str::<Map<String, Value>>(&captures[1]).ok())
    else {
        return (content.trim().to_owned(), Map::new());
    };
    let mut plan = Map::new();
    for key in ["summary", "source_scope", "entity_name"] {
        let value = text(raw.get(key));
        if !value.is_empty() {
            plan.insert(key.into(), json!(value));
        }
    }
    for key in ["proposed_fields", "risks", "notes"] {
        let list = strings(raw.get(key));
        if !list.is_empty() {
            plan.insert(key.into(), json!(list));
        }
    }
    let unique = strings(
        raw.get("recommended_unique_by")
            .or_else(|| raw.get("unique_by")),
    );
    if !unique.is_empty() {
        plan.insert("recommended_unique_by".into(), json!(unique));
    }
    let counts = raw.get("estimated_counts");
    for (key, short) in [
        ("estimated_create", "create"),
        ("estimated_update", "update"),
        ("estimated_skip", "skip"),
    ] {
        let value = int(raw.get(key)).max(int(counts.and_then(|c| c.get(short))));
        if value > 0 {
            plan.insert(key.into(), json!(value));
        }
    }
    (strip_block(content), plan)
}

const TABLE_TOOLS: &[&str] = &[
    "data_table_record_draft",
    "data_table_add_fields",
    "data_table_add_records",
    "table_upsert_records",
];

/// The reply without its plan block, and the merged plan when the turn
/// planned or wrote table data.
pub fn finalize(content: &str, mode: &str, calls: &[AgentToolCall]) -> (String, Option<Value>) {
    let (clean, mut plan) = extract(content);
    if plan.is_empty()
        && !calls
            .iter()
            .any(|call| TABLE_TOOLS.contains(&call.tool_name.as_str()))
    {
        return (clean, None);
    }
    let mut proposed = strings(plan.get("proposed_fields"));
    let mut unique = strings(plan.get("recommended_unique_by"));
    let mut created_fields = Vec::new();
    let mut final_unique = Vec::new();
    let mut estimated_create = int(plan.get("estimated_create"));
    let (mut created, mut updated, mut skipped, mut wrote) = (0, 0, 0, false);
    for call in calls {
        let output = &call.output_data;
        match call.tool_name.as_str() {
            "data_table_record_draft" => {
                merge(
                    &mut proposed,
                    output["missing_fields"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|field| text(field.get("title")))
                        .filter(|title| !title.is_empty())
                        .collect(),
                );
                merge(&mut unique, strings(output.get("recommended_unique_by")));
                if estimated_create == 0 {
                    estimated_create = int(output.get("record_draft_count"));
                }
            }
            "data_table_add_fields" => created_fields.extend(
                output["created"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|field| text(field.get("title")))
                    .filter(|title| !title.is_empty()),
            ),
            "data_table_add_records" | "table_upsert_records" => {
                wrote = true;
                created = int(output.get("created"));
                updated = int(output.get("updated"));
                skipped = int(output.get("skipped"));
                final_unique = strings(output.get("unique_by"));
                if final_unique.is_empty() {
                    final_unique = strings(call.input_data.get("unique_by"));
                }
            }
            _ => {}
        }
    }
    merge(&mut proposed, created_fields.clone());
    if unique.is_empty() {
        unique = final_unique.clone();
    }
    let mut set = |key: &str, list: &Vec<String>| {
        if !list.is_empty() {
            plan.insert(key.into(), json!(list));
        }
    };
    set("proposed_fields", &proposed);
    set("created_field_titles", &created_fields);
    set("recommended_unique_by", &unique);
    set("final_unique_by", &final_unique);
    if estimated_create > 0 {
        plan.insert("estimated_create".into(), json!(estimated_create));
    }
    let report = wrote && mode == "apply";
    for (key, value) in [
        ("actual_created", created),
        ("actual_updated", updated),
        ("actual_skipped", skipped),
    ] {
        if value > 0 || report {
            plan.insert(key.into(), json!(value));
        }
    }
    if text(plan.get("summary")).is_empty() {
        let mut parts = Vec::new();
        if !created_fields.is_empty() {
            parts.push(format!("Added fields: {}", created_fields.join(", ")));
        }
        if created > 0 || updated > 0 || skipped > 0 {
            parts.push(format!(
                "Record changes: created {created}, updated {updated}, skipped {skipped}"
            ));
        }
        if parts.is_empty() && mode == "preview" && estimated_create > 0 {
            let scope = text(plan.get("source_scope"));
            parts.push(format!(
                "Drafted {estimated_create} table-ready records from {}",
                if scope.is_empty() {
                    "current source"
                } else {
                    &scope
                }
            ));
        }
        if !parts.is_empty() {
            plan.insert("summary".into(), json!(parts.join("; ")));
        }
    }
    if plan.is_empty() {
        return (clean, None);
    }
    plan.insert("execution_mode".into(), json!(mode));
    plan.insert("event_source".into(), json!("table_plan"));
    match mode {
        "preview" => {
            plan.insert("requires_apply_confirmation".into(), json!(true));
        }
        "apply" => {
            plan.insert("applied".into(), json!(true));
        }
        _ => {}
    }
    (clean, Some(Value::Object(plan)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_and_merges_plans() {
        let content = "Done.\n```table_plan\n{\"summary\":\"Import posts\",\"estimated_counts\":{\"create\":3}}\n```";
        let calls = vec![AgentToolCall {
            tool_name: "data_table_add_records".into(),
            output_data: json!({ "created": 2, "updated": 1, "skipped": 0, "unique_by": ["url"] }),
            ..AgentToolCall::default()
        }];
        let (clean, plan) = finalize(content, "apply", &calls);
        assert_eq!(clean, "Done.");
        let plan = plan.unwrap_or_default();
        assert_eq!(plan["summary"], "Import posts");
        assert_eq!(plan["estimated_create"], 3);
        assert_eq!(plan["actual_created"], 2);
        assert_eq!(plan["final_unique_by"], json!(["url"]));
        assert_eq!(plan["applied"], true);
        assert_eq!(finalize("plain", "apply", &[]), ("plain".to_owned(), None));
    }
}
