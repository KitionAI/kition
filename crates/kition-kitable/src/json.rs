//! JSON helpers matching the legacy value semantics: numbers behave as
//! 64-bit floats, objects default to `{}`, and JSON strings passed where a
//! document is expected are validated and stored verbatim.

use serde_json::{Map, Value};

use crate::{KitableError, Result};

/// Parses a stored JSON object; anything else becomes an empty object.
pub fn object(raw: &str) -> Map<String, Value> {
    if raw.trim().is_empty() {
        return Map::new();
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Serializes `value` for storage. `null` becomes `empty`; a string is
/// treated as already-encoded JSON (blank becomes `empty`, invalid is an
/// error).
pub fn encode_default(value: &Value, empty: &str) -> Result<String> {
    match value {
        Value::Null => Ok(empty.to_owned()),
        Value::String(raw) => {
            let raw = raw.trim();
            if raw.is_empty() {
                return Ok(empty.to_owned());
            }
            if serde_json::from_str::<Value>(raw).is_err() {
                return Err(KitableError::invalid("invalid json string"));
            }
            Ok(raw.to_owned())
        }
        other => Ok(serde_json::to_string(other)?),
    }
}

/// A float as JSON, written as an integer when it has no fraction (the way
/// the legacy encoder printed whole floats).
pub fn number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e15 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::Bool(true) => 1.0,
        Value::String(text) => text.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Text form used by formulas, lookups, and link display values.
pub fn to_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(n) => format_float(n.as_f64().unwrap_or(0.0)),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(to_text).collect::<Vec<_>>().join(" ")
        ),
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            let body = entries
                .iter()
                .map(|(k, v)| format!("{k}:{}", to_text(v)))
                .collect::<Vec<_>>()
                .join(" ");
            format!("map[{body}]")
        }
    }
}

pub fn format_float(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.2e18 {
        (value as i64).to_string()
    } else {
        value.to_string()
    }
}

pub fn to_bool(value: &Value) -> bool {
    match value {
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(text) => !text.is_empty() && text.to_lowercase() != "false",
        _ => false,
    }
}

/// `null` or a blank string.
pub fn is_blank(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.trim().is_empty(),
        _ => false,
    }
}

/// Deep equality where numbers compare by value.
pub fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(l, r)| equal(l, r))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|other| equal(v, other)))
        }
        _ => a == b,
    }
}

/// An integer option that may be stored as a number or a decimal string.
pub fn int_option(options: &Map<String, Value>, key: &str) -> i64 {
    match options.get(key) {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0),
        Some(Value::String(text)) => crate::file::atoi(text),
        _ => 0,
    }
}

/// Lowercase identifier from a title: non-alphanumerics become `_`, and a
/// leading non-letter gets an `f_` prefix.
pub fn internal_name(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return "field".to_owned();
    }
    let mut out = String::new();
    let mut in_run = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    let mut out = out.trim_matches('_').to_owned();
    if out.is_empty() {
        out = "field".to_owned();
    }
    if !out.starts_with(|c: char| c.is_ascii_alphabetic()) {
        out = format!("f_{out}");
    }
    out.to_lowercase()
}

/// The trimmed value, or `fallback` when blank.
pub fn fallback(value: &str, fallback: &str) -> String {
    match value.trim() {
        "" => fallback.to_owned(),
        trimmed => trimmed.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn internal_names() {
        assert_eq!(internal_name("Due Date"), "due_date");
        assert_eq!(internal_name("  "), "field");
        assert_eq!(internal_name("1st place!"), "f_1st_place");
        assert_eq!(internal_name("Ωμέγα"), "field");
        assert_eq!(internal_name("a--b"), "a_b");
    }

    #[test]
    fn encodes_documents() {
        assert_eq!(encode_default(&Value::Null, "{}").unwrap_or_default(), "{}");
        assert_eq!(encode_default(&json!("  "), "{}").unwrap_or_default(), "{}");
        assert_eq!(
            encode_default(&json!("{\"a\":1}"), "{}").unwrap_or_default(),
            "{\"a\":1}"
        );
        assert!(encode_default(&json!("{nope"), "{}").is_err());
        assert_eq!(
            encode_default(&json!({"b": 2}), "{}").unwrap_or_default(),
            "{\"b\":2}"
        );
    }

    #[test]
    fn numbers_and_text() {
        assert_eq!(number(3.0), json!(3));
        assert_eq!(number(2.5), json!(2.5));
        assert_eq!(to_text(&json!(4.0)), "4");
        assert_eq!(to_text(&json!(1.25)), "1.25");
        assert_eq!(to_text(&json!(true)), "true");
        assert!(equal(&json!({"a": [1]}), &json!({"a": [1.0]})));
        assert!(!equal(&json!([1]), &json!([2])));
        assert_eq!(
            int_option(json!({"x": "12"}).as_object().unwrap_or(&Map::new()), "x"),
            12
        );
    }
}
