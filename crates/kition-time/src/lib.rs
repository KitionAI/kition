//! Millisecond timestamps.
//!
//! Every instant Kition stores or returns is a Unix timestamp in milliseconds
//! (`i64`): SQLite columns, HTTP JSON, and files Kition writes. Text
//! timestamps written by older runtimes are read only by [`parse_legacy`].
//!
//! This crate has no runtime dependencies, so table documents
//! (`kition-kitable`) build for `wasm32-unknown-unknown`.

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};

/// Milliseconds since the Unix epoch.
pub type Millis = i64;

/// The current time in Unix milliseconds.
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
pub fn now_millis() -> Millis {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(elapsed) => Millis::try_from(elapsed.as_millis()).unwrap_or(Millis::MAX),
        Err(before) => Millis::try_from(before.duration().as_millis())
            .map(|millis| -millis)
            .unwrap_or(Millis::MIN),
    }
}

/// The current time in Unix milliseconds, from the page's `Date.now()`.
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub fn now_millis() -> Millis {
    js_sys::Date::now() as Millis
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
    fn formats_rfc3339() {
        assert_eq!(to_rfc3339(1_791_518_226_334), "2026-10-09T03:57:06.334Z");
    }

    #[test]
    fn now_is_milliseconds() {
        let now = now_millis();
        assert!(now > 1_700_000_000_000 && now < 10_000_000_000_000);
    }
}
