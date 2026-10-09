//! Timestamps.
//!
//! Every instant the runtime stores or returns is a Unix timestamp in
//! milliseconds (`i64`): SQLite columns, HTTP JSON, and files the runtime
//! writes. Text timestamps written by older runtimes are converted by the
//! startup migration; [`parse_legacy`] is the only place that reads them.

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};

/// Milliseconds since the Unix epoch.
pub type Millis = i64;

/// The current time in Unix milliseconds.
pub fn now_millis() -> Millis {
    Utc::now().timestamp_millis()
}

/// Parses a timestamp in any layout older runtimes stored or emitted
/// (SQLite driver layouts and RFC 3339) and returns Unix milliseconds.
/// Layouts without an offset are UTC.
pub fn parse_legacy(raw: &str) -> Option<Millis> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.timestamp_millis());
    }
    let value = trimmed.strip_suffix('Z').unwrap_or(trimmed);
    for layout in ["%Y-%m-%d %H:%M:%S%.f%:z", "%Y-%m-%dT%H:%M:%S%.f%:z"] {
        if let Ok(parsed) = DateTime::parse_from_str(value, layout) {
            return Some(parsed.timestamp_millis());
        }
    }
    for layout in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
    ] {
        if let Ok(parsed) = NaiveDateTime::parse_from_str(value, layout) {
            return Some(Utc.from_utc_datetime(&parsed).timestamp_millis());
        }
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|naive| Utc.from_utc_datetime(&naive).timestamp_millis())
}

/// Formats milliseconds as RFC 3339 in UTC, for logs and external services
/// that require text.
pub fn to_rfc3339(millis: Millis) -> String {
    Utc.timestamp_millis_opt(millis)
        .single()
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

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
    fn parses_every_legacy_layout() {
        let utc = 1_791_518_226_000_i64; // 2026-10-09T03:57:06Z
        let cases = [
            ("2026-10-09 11:57:06.334767+08:00", utc + 334),
            ("2026-10-09T11:57:06+08:00", utc),
            ("2026-10-09T03:57:06Z", utc),
            ("2026-10-09 03:57:06.25", utc + 250),
            ("2026-10-09 03:57:06", utc),
            ("2026-10-09 03:57", utc - 6_000),
            ("2026-10-09", utc - (3 * 3600 + 57 * 60 + 6) * 1000),
            ("0001-01-01 00:00:00+00:00", -62_135_596_800_000),
        ];
        for (raw, want) in cases {
            assert_eq!(parse_legacy(raw), Some(want), "{raw}");
        }
        assert_eq!(parse_legacy("not a time"), None);
        assert_eq!(parse_legacy(""), None);
    }

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

    #[test]
    fn formats_rfc3339() {
        assert_eq!(to_rfc3339(1_791_518_226_334), "2026-10-09T03:57:06.334Z");
    }

    #[test]
    fn now_is_milliseconds() {
        let now = now_millis();
        assert!(now > 1_700_000_000_000 && now < 10_000_000_000_000);
    }
}
