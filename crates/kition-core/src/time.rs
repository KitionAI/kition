//! Timestamps.
//!
//! Every instant the runtime stores or returns is a Unix timestamp in
//! milliseconds (`i64`): SQLite columns, HTTP JSON, and files the runtime
//! writes. Text timestamps written by older runtimes are converted by the
//! startup migration; [`parse_legacy`] is the only place that reads them.
//! The clock and the layouts live in `kition-time`, which builds without the
//! runtime (for `wasm32` table documents); this module re-exports them.

pub use kition_time::{Millis, now_millis, parse_legacy, to_rfc3339};

/// Serde helpers for timestamps that may be stored as milliseconds or as
/// legacy RFC 3339 / driver text.
pub mod flexible {
    use serde::{Deserialize, Deserializer};
    use serde_json::Value;

    use super::{Millis, parse_legacy};

    fn from_value(value: Value) -> Option<Millis> {
        match value {
            Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
            Value::String(text) => match parse_legacy(&text) {
                // The legacy zero time meant "unset".
                Some(-62_135_596_800_000) | None => None,
                Some(millis) => Some(millis),
            },
            _ => None,
        }
    }

    /// Required timestamp; missing or unparseable becomes `0`.
    pub fn required<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Millis, D::Error> {
        Ok(from_value(Value::deserialize(deserializer)?).unwrap_or(0))
    }

    /// Optional timestamp.
    pub fn optional<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Millis>, D::Error> {
        Ok(from_value(Value::deserialize(deserializer)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flexible_deserialization() {
        #[derive(serde::Deserialize)]
        struct Row {
            #[serde(default, deserialize_with = "flexible::required")]
            a: Millis,
            #[serde(default, deserialize_with = "flexible::optional")]
            b: Option<Millis>,
        }
        let row: Row =
            serde_json::from_str(r#"{"a":"2026-10-09T03:57:06Z","b":"0001-01-01T00:00:00Z"}"#)
                .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!((row.a, row.b), (1_791_518_226_000, None));
        let row: Row =
            serde_json::from_str(r#"{"a":5,"b":7}"#).unwrap_or_else(|err| panic!("{err}"));
        assert_eq!((row.a, row.b), (5, Some(7)));
    }
}
