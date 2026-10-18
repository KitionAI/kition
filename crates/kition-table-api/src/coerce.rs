//! Lenient JSON readers, matching the runtime's (`kition_core::coerce`), and the id and paging
//! parameters every route shares.

use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::{ApiError, ApiResult};

/// Deserializes `null` (and a missing field, with `#[serde(default)]`) as the default value.
pub(crate) fn nullable<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// The string value, or `""` for anything else.
pub(crate) fn as_str(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

/// `true` only for the JSON boolean `true`.
pub(crate) fn as_bool(value: &Value) -> bool {
    value.as_bool().unwrap_or(false)
}

/// Integers, truncated floats, and decimal strings; `0` otherwise.
pub(crate) fn as_i64(value: &Value) -> i64 {
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|float| float as i64))
            .unwrap_or_default(),
        Value::String(text) => text.parse().unwrap_or_default(),
        _ => 0,
    }
}

/// A positive integer id (a route's path segment).
pub fn parse_id(value: &str) -> ApiResult<i64> {
    match value.parse::<i64>() {
        Ok(id) if id > 0 => Ok(id),
        _ => Err(ApiError::bad_request("Invalid ID parameter")),
    }
}

/// `limit` and `offset` query values: non-negative, limit capped at 5000.
pub fn list_window(limit: Option<&str>, offset: Option<&str>) -> (i64, i64) {
    let parse = |value: Option<&str>| {
        value
            .and_then(|v| v.trim().parse::<i64>().ok())
            .unwrap_or(0)
            .max(0)
    };
    (parse(limit).min(5000), parse(offset))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_windows() {
        assert_eq!(list_window(Some("10"), Some("-3")), (10, 0));
        assert_eq!(list_window(Some("9999"), None), (5000, 0));
        assert_eq!(list_window(Some("x"), Some("4")), (0, 4));
    }

    #[test]
    fn ids() {
        assert_eq!(parse_id("7"), Ok(7));
        assert!(parse_id("0").is_err());
        assert!(parse_id("x").is_err());
    }
}
