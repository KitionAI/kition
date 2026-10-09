//! Template rendering, record value lookup across key spaces, and the
//! deterministic record transforms.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::gofmt::{quote, stringify_value};
use crate::types::{BodyTemplate, FieldRef, FieldSchema};

/// Renders a template; unknown field references render as `{fieldId}` and
/// are reported.
pub fn render(template: &BodyTemplate, values: &HashMap<String, String>) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut missing = Vec::new();
    for part in template.parts.iter() {
        match part.kind.as_str() {
            "text" => out.push_str(&part.text),
            "newline" => out.push('\n'),
            "field_ref" => {
                let Some(field) = &part.field_ref else {
                    continue;
                };
                match values.get(&field.field_id) {
                    Some(value) => out.push_str(value),
                    None => {
                        out.push('{');
                        out.push_str(&field.field_id);
                        out.push('}');
                        missing.push(field.field_id.clone());
                    }
                }
            }
            _ => {}
        }
    }
    (out, missing)
}

/// Distinct field references in order.
pub fn field_refs(template: &BodyTemplate) -> Vec<FieldRef> {
    let mut seen = HashSet::new();
    template
        .parts
        .iter()
        .filter(|p| p.kind == "field_ref")
        .filter_map(|p| p.field_ref.clone())
        .filter(|r| seen.insert(format!("{}:{}", r.node_id, r.field_id)))
        .collect()
}

static NON_KEY_CHARS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("[^a-z0-9]+").unwrap_or_else(|_| unreachable!("valid pattern")));

/// Lowercase ASCII alphanumerics only (`New property 2` → `newproperty2`).
pub fn normalize_field_key(key: &str) -> String {
    NON_KEY_CHARS
        .replace_all(&key.trim().to_lowercase(), "")
        .into_owned()
}

/// Lowercase letters and digits of any script.
pub fn normalize_record_field_name(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Record values keyed by field ID, matched by ID, then name, then
/// normalized name.
pub fn by_field_id(raw: &Map<String, Value>, fields: &[FieldSchema]) -> Map<String, Value> {
    let normalized: HashMap<String, &Value> = raw
        .iter()
        .map(|(k, v)| (normalize_field_key(k), v))
        .collect();
    let mut out = Map::new();
    for field in fields {
        let value = raw
            .get(&field.id)
            .or_else(|| raw.get(&field.name))
            .or_else(|| normalized.get(&normalize_field_key(&field.name)).copied());
        if let Some(value) = value {
            out.insert(field.id.clone(), value.clone());
        }
    }
    out
}

/// Every raw key stringified, plus schema field IDs resolved like
/// [`by_field_id`].
pub fn stringify_record_values(
    raw: &Map<String, Value>,
    fields: &[FieldSchema],
) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let mut normalized: HashMap<String, String> = HashMap::new();
    for (key, value) in raw {
        let text = stringify_value(value);
        normalized.insert(normalize_field_key(key), text.clone());
        out.insert(key.clone(), text);
    }
    for field in fields {
        if let Some(value) = raw.get(&field.id).or_else(|| raw.get(&field.name)) {
            out.insert(field.id.clone(), stringify_value(value));
        } else if let Some(value) = normalized.get(&normalize_field_key(&field.name)) {
            out.insert(field.id.clone(), value.clone());
        }
    }
    out
}

/// Values supplied for a test run: text as-is, `null` empty, others JSON.
pub fn stringify_trigger_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// A record value by field ID, falling back to the field's name.
pub fn record_field_value(
    values: &Map<String, Value>,
    fields: &[FieldSchema],
    field_id: &str,
) -> Option<Value> {
    if let Some(value) = values.get(field_id) {
        return Some(value.clone());
    }
    let field = fields.iter().find(|f| f.id == field_id)?;
    if let Some(value) = values.get(&field.name) {
        return Some(value.clone());
    }
    let wanted = normalize_record_field_name(&field.name);
    values
        .iter()
        .find(|(key, _)| normalize_record_field_name(key) == wanted)
        .map(|(_, v)| v.clone())
}

/// Case-insensitive comparison of stringified, trimmed values.
pub fn equal_lookup_value(left: &Value, right: &Value) -> bool {
    stringify_value(left).trim().to_lowercase() == stringify_value(right).trim().to_lowercase()
}

/// A deterministic transform of `source`.
pub fn apply_transform(operation: &str, source: &str, argument: &str) -> Result<Value, String> {
    Ok(match operation.trim() {
        "trim" => Value::String(source.trim().to_owned()),
        "lowercase" => Value::String(source.trim().to_lowercase()),
        "uppercase" => Value::String(source.trim().to_uppercase()),
        "digits_only" => Value::String(source.chars().filter(char::is_ascii_digit).collect()),
        "domain_from_email" => {
            let parts: Vec<&str> = source.trim().split('@').collect();
            if parts.len() != 2 || parts[1].is_empty() {
                Value::String(String::new())
            } else {
                Value::String(parts[1].to_lowercase())
            }
        }
        "concat" => Value::String(format!("{source}{argument}")),
        "number_add" | "number_multiply" => {
            let left: f64 = source
                .trim()
                .parse()
                .map_err(|_| format!("{operation} requires a numeric source"))?;
            let right: f64 = argument
                .trim()
                .parse()
                .map_err(|_| format!("{operation} requires a numeric argument"))?;
            let result = if operation.trim() == "number_add" {
                left + right
            } else {
                left * right
            };
            json_number(result)
        }
        _ => {
            return Err(format!(
                "unsupported transform operation {}",
                quote(operation)
            ));
        }
    })
}

/// A float as JSON the way the legacy encoder wrote it: whole values
/// without a fraction.
pub fn json_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return Value::from(value as i64);
    }
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::types::BodyPart;

    #[test]
    fn renders_and_resolves_values() {
        let template = BodyTemplate {
            parts: vec![
                BodyPart::text("Hi "),
                BodyPart {
                    kind: "field_ref".into(),
                    text: String::new(),
                    field_ref: Some(FieldRef {
                        node_id: "t".into(),
                        field_id: "1".into(),
                    }),
                },
                BodyPart {
                    kind: "newline".into(),
                    ..Default::default()
                },
                BodyPart {
                    kind: "field_ref".into(),
                    text: String::new(),
                    field_ref: Some(FieldRef {
                        node_id: "t".into(),
                        field_id: "9".into(),
                    }),
                },
            ]
            .into(),
        };
        let raw = json!({"New Name": "Ada", "n": 2.5})
            .as_object()
            .cloned()
            .unwrap_or_default();
        let fields = vec![FieldSchema {
            id: "1".into(),
            name: "new_name".into(),
            field_type: "text".into(),
        }];
        let values = stringify_record_values(&raw, &fields);
        assert_eq!(
            render(&template, &values),
            ("Hi Ada\n{9}".to_owned(), vec!["9".to_owned()])
        );
        assert_eq!(by_field_id(&raw, &fields).get("1"), Some(&json!("Ada")));
        assert_eq!(values.get("n").map(String::as_str), Some("2.5"));
        assert_eq!(field_refs(&template).len(), 2);
    }

    #[test]
    fn transforms() {
        assert_eq!(
            apply_transform("domain_from_email", " A@Example.COM", ""),
            Ok(json!("example.com"))
        );
        assert_eq!(apply_transform("number_add", "1.5", "2"), Ok(json!(3.5)));
        assert_eq!(
            apply_transform("number_add", "x", "2"),
            Err("number_add requires a numeric source".into())
        );
        assert_eq!(
            apply_transform("nope", "x", ""),
            Err("unsupported transform operation \"nope\"".into())
        );
        assert_eq!(
            apply_transform("digits_only", "+1 (555)", ""),
            Ok(json!("1555"))
        );
        assert!(equal_lookup_value(&json!(" ADA "), &json!("ada")));
        assert_eq!(normalize_record_field_name("Prénom 2"), "prénom2");
    }
}
