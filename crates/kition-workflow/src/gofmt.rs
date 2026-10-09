//! Formatting helpers that reproduce the legacy runtime's text output:
//! quoted strings and characters, float and value stringification, and
//! reference-layout date formatting.

use chrono::{DateTime, Datelike, FixedOffset, Timelike};
use serde_json::Value;

fn escape_char(c: char, quote: char, out: &mut String) {
    match c {
        '\x07' => out.push_str("\\a"),
        '\x08' => out.push_str("\\b"),
        '\x0c' => out.push_str("\\f"),
        '\n' => out.push_str("\\n"),
        '\r' => out.push_str("\\r"),
        '\t' => out.push_str("\\t"),
        '\x0b' => out.push_str("\\v"),
        '\\' => out.push_str("\\\\"),
        c if c == quote => {
            out.push('\\');
            out.push(c);
        }
        c if c.is_control() => {
            let code = c as u32;
            if code < 0x80 {
                out.push_str(&format!("\\x{code:02x}"));
            } else if code < 0x10000 {
                out.push_str(&format!("\\u{code:04x}"));
            } else {
                out.push_str(&format!("\\U{code:08x}"));
            }
        }
        c => out.push(c),
    }
}

/// `%q` of a string.
pub fn quote(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        escape_char(c, '"', &mut out);
    }
    out.push('"');
    out
}

/// `%q` of a single byte, read as the code point of the same value.
pub fn quote_byte(byte: u8) -> String {
    let mut out = String::from("'");
    escape_char(char::from(byte), '\'', &mut out);
    out.push('\'');
    out
}

/// Shortest decimal form without exponent (`'f', -1`).
pub fn format_float(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 {
            "+Inf".into()
        } else {
            "-Inf".into()
        };
    }
    if value == value.trunc() && value.abs() < 1e21 {
        return format!("{value:.0}");
    }
    let text = format!("{value}");
    if text.contains('e') {
        // Rust uses exponent notation for very small values; expand it.
        let digits = format!("{value:.20}");
        return digits
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned();
    }
    text
}

/// Stringifies a record value: text as-is, numbers without exponents,
/// booleans as words, `null` as empty, and anything else as compact JSON.
pub fn stringify_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => match (number.as_i64(), number.as_u64()) {
            (Some(int), _) => int.to_string(),
            (_, Some(int)) => int.to_string(),
            _ => format_float(number.as_f64().unwrap_or(0.0)),
        },
        other => other.to_string(),
    }
}

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const DAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

fn offset_text(seconds: i32, colon: bool, z_for_utc: bool) -> String {
    if z_for_utc && seconds == 0 {
        return "Z".into();
    }
    let sign = if seconds < 0 { '-' } else { '+' };
    let minutes = seconds.unsigned_abs() / 60;
    if colon {
        format!("{sign}{:02}:{:02}", minutes / 60, minutes % 60)
    } else {
        format!("{sign}{:02}{:02}", minutes / 60, minutes % 60)
    }
}

/// Formats `time` with a reference layout (`2006-01-02 15:04:05`, `Jan`,
/// `Monday`, `PM`, `-07:00`, ...), like the legacy runtime.
pub fn format_layout(time: &DateTime<FixedOffset>, layout: &str) -> String {
    let tokens: [(&str, u8); 31] = [
        ("January", 0),
        ("Jan", 1),
        ("Monday", 2),
        ("Mon", 3),
        ("MST", 4),
        ("2006", 5),
        ("Z07:00", 6),
        ("Z0700", 7),
        ("-07:00", 8),
        ("-0700", 9),
        ("-07", 10),
        ("Z07", 11),
        ("002", 12),
        ("01", 13),
        ("02", 14),
        ("03", 15),
        ("04", 16),
        ("05", 17),
        ("06", 18),
        ("_2", 19),
        ("15", 20),
        ("PM", 21),
        ("pm", 22),
        (".000000000", 23),
        (".000000", 24),
        (".000", 25),
        ("1", 26),
        ("2", 27),
        ("3", 28),
        ("4", 29),
        ("5", 30),
    ];
    let offset = time.offset().local_minus_utc();
    let mut out = String::new();
    let mut rest = layout;
    'outer: while !rest.is_empty() {
        for (token, kind) in tokens {
            if !rest.starts_with(token) {
                continue;
            }
            // `Jan`/`Mon` only count when not followed by a lowercase letter.
            if matches!(kind, 1 | 3)
                && rest[token.len()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_lowercase())
            {
                continue;
            }
            let text = match kind {
                0 => MONTHS[time.month0() as usize].to_owned(),
                1 => MONTHS[time.month0() as usize][..3].to_owned(),
                2 => DAYS[time.weekday().num_days_from_sunday() as usize].to_owned(),
                3 => DAYS[time.weekday().num_days_from_sunday() as usize][..3].to_owned(),
                4 => {
                    if offset == 0 {
                        "UTC".into()
                    } else {
                        offset_text(offset, false, false)
                    }
                }
                5 => format!("{:04}", time.year()),
                6 => offset_text(offset, true, true),
                7 => offset_text(offset, false, true),
                8 => offset_text(offset, true, false),
                9 => offset_text(offset, false, false),
                10 => offset_text(offset, false, false)[..3].to_owned(),
                11 => {
                    if offset == 0 {
                        "Z".into()
                    } else {
                        offset_text(offset, false, false)[..3].to_owned()
                    }
                }
                12 => format!("{:03}", time.ordinal()),
                13 => format!("{:02}", time.month()),
                14 => format!("{:02}", time.day()),
                15 => format!("{:02}", hour12(time.hour())),
                16 => format!("{:02}", time.minute()),
                17 => format!("{:02}", time.second()),
                18 => format!("{:02}", time.year() % 100),
                19 => format!("{:>2}", time.day()),
                20 => format!("{:02}", time.hour()),
                21 => if time.hour() >= 12 { "PM" } else { "AM" }.into(),
                22 => if time.hour() >= 12 { "pm" } else { "am" }.into(),
                23 => format!(".{:09}", time.nanosecond() % 1_000_000_000),
                24 => format!(".{:06}", time.nanosecond() / 1000 % 1_000_000),
                25 => format!(".{:03}", time.nanosecond() / 1_000_000 % 1000),
                26 => time.month().to_string(),
                27 => time.day().to_string(),
                28 => hour12(time.hour()).to_string(),
                29 => time.minute().to_string(),
                _ => time.second().to_string(),
            };
            out.push_str(&text);
            rest = &rest[token.len()..];
            continue 'outer;
        }
        let c = rest.chars().next().unwrap_or_default();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

fn hour12(hour: u32) -> u32 {
    match hour % 12 {
        0 => 12,
        h => h,
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;
    use serde_json::json;

    use super::*;

    #[test]
    fn quotes_like_the_legacy_runtime() {
        assert_eq!(quote("a\"b\n"), "\"a\\\"b\\n\"");
        assert_eq!(quote_byte(b'#'), "'#'");
        assert_eq!(quote_byte(b'\''), "'\\''");
        assert_eq!(quote_byte(0), "'\\x00'");
    }

    #[test]
    fn stringifies_values() {
        assert_eq!(stringify_value(&json!(1.5)), "1.5");
        assert_eq!(stringify_value(&json!(3.0)), "3");
        assert_eq!(stringify_value(&json!(1e-7)), "0.0000001");
        assert_eq!(stringify_value(&json!(null)), "");
        assert_eq!(stringify_value(&json!(["a"])), "[\"a\"]");
        assert_eq!(format_float(1e21), "1000000000000000000000");
    }

    #[test]
    fn formats_reference_layouts() {
        let time = FixedOffset::east_opt(8 * 3600)
            .and_then(|tz| tz.with_ymd_and_hms(2026, 3, 5, 14, 7, 9).single())
            .unwrap_or_default();
        assert_eq!(
            format_layout(&time, "2006-01-02 15:04:05"),
            "2026-03-05 14:07:09"
        );
        assert_eq!(
            format_layout(&time, "Mon Jan _2 3:04PM -07:00"),
            "Thu Mar  5 2:07PM +08:00"
        );
        assert_eq!(
            format_layout(&time, "Monday, January 2"),
            "Thursday, March 5"
        );
        assert_eq!(format_layout(&time, "Month"), "Month");
    }
}

/// Compact JSON like the legacy encoder: object keys sorted at every level
/// and `<`, `>`, `&`, U+2028, U+2029 escaped.
pub fn go_json(value: &Value) -> String {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                out.push('{');
                for (i, key) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_string(key, out);
                    out.push(':');
                    write(&map[*key], out);
                }
                out.push('}');
            }
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(item, out);
                }
                out.push(']');
            }
            Value::String(text) => write_string(text, out),
            other => out.push_str(&other.to_string()),
        }
    }
    fn write_string(text: &str, out: &mut String) {
        let encoded = Value::String(text.to_owned()).to_string();
        for c in encoded.chars() {
            match c {
                '<' => out.push_str("\\u003c"),
                '>' => out.push_str("\\u003e"),
                '&' => out.push_str("\\u0026"),
                '\u{2028}' => out.push_str("\\u2028"),
                '\u{2029}' => out.push_str("\\u2029"),
                c => out.push(c),
            }
        }
    }
    let mut out = String::new();
    write(value, &mut out);
    out
}

#[cfg(test)]
mod json_tests {
    use serde_json::json;

    use super::go_json;

    #[test]
    fn encodes_like_the_legacy_runtime() {
        assert_eq!(
            go_json(&json!({"b": 1, "a": {"y": "<x>", "x": [true, null]}})),
            r#"{"a":{"x":[true,null],"y":"\u003cx\u003e"},"b":1}"#
        );
    }
}
