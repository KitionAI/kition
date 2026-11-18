//! Lenient readers for loosely typed JSON request fields.

use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// Deserializes `null` as the type's default, the way the legacy decoder
/// left fields untouched on `null`. Use with `#[serde(default, deserialize_with = "nullable")]`.
pub fn nullable<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// The string value, or `""` for anything else.
pub fn as_str(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

/// `true` only for the JSON boolean `true`.
pub fn as_bool(value: &Value) -> bool {
    value.as_bool().unwrap_or(false)
}

/// Integers, truncated floats, and decimal strings; `0` otherwise.
pub fn as_i64(value: &Value) -> i64 {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|float| float as i64))
            .unwrap_or_default(),
        Value::String(text) => text.parse().unwrap_or_default(),
        _ => 0,
    }
}

/// The first value that is not blank, returned untrimmed; `""` if none.
pub fn first_non_empty<'a>(values: &[&'a str]) -> &'a str {
    values
        .iter()
        .copied()
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
}

/// A positive integer from a query string, or `fallback`.
pub fn parse_positive_or(value: Option<&str>, fallback: i64) -> i64 {
    value
        .and_then(|text| text.parse::<i64>().ok())
        .filter(|parsed| *parsed > 0)
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn coerces_like_legacy_helpers() {
        assert_eq!(as_str(&json!("x")), "x");
        assert_eq!(as_str(&json!(1)), "");
        assert!(as_bool(&json!(true)));
        assert!(!as_bool(&json!("true")));
        assert_eq!(as_i64(&json!(3.9)), 3);
        assert_eq!(as_i64(&json!("42")), 42);
        assert_eq!(as_i64(&json!("x")), 0);
        assert_eq!(first_non_empty(&["  ", " a ", "b"]), " a ");
        assert_eq!(first_non_empty(&["", " "]), "");
        assert_eq!(parse_positive_or(Some("0"), 20), 20);
        assert_eq!(parse_positive_or(Some("7"), 20), 7);
        assert_eq!(parse_positive_or(None, 1), 1);
    }
}
