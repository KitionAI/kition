// Copied from kition-sdk crates/kition-kdm/src/content.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The content encoding (data model 7.4): the bytes a kit writes into a person's file
//! (`content.json`), and, with a version, a replica's snapshot.
//!
//! This is the one part of the KDM that cannot change after the first public release: every rule
//! below is a test (`tests/content.rs`, fixtures `tests/fixtures/content/`). There is one writer:
//! [`crate::Replica::content_snapshot`] and [`crate::Replica::snapshot`] write the store's content
//! ([`crate::store::Store::to_content`]) with [`encode`]; [`crate::Replica::load`] reads it with
//! [`parse`] and [`decode_value`] into the store ([`crate::store::Store::from_content`]).
//!
//! ```text
//! {"kdm":1,"kit":"kit.board","docId":"…","schemaVersion":1,"objects":{
//! "<id>":{"$type":"Board","outline":[[0,"<id>"],[1,"<id>"]],"pages":["<id>"],"title":"Q4"},
//! "<id>":{"$type":"Page","name":"Page 1"}
//! }}
//! ```
//!
//! - UTF-8 without a byte order mark; lines end with `\n`, the last one too.
//! - The first line is the header: `kdm`, `kit`, `docId`, then (a snapshot only) `version` as
//!   `{"lineage":"<uuid>","seq":<n>}` (and `"authorSchemaVersion":<n>` when known), then
//!   `schemaVersion`, then `"objects":{`, in this order.
//! - Then one line per object, `"<id>":{…}`, a `,` after each but the last, ids in ascending
//!   order of their UTF-8 bytes; then the line `}}`. No other whitespace anywhere.
//! - Inside an object, at every depth, keys are in ascending order of their UTF-8 bytes.
//! - A field holding `null`, an empty text, an empty list, an empty map or an empty tree is left
//!   out. A register holding `""`, `[]`, `{}`, `0` or `false` is written.
//! - A number that is whole and within ±2^53 is written as an integer (`-0` as `0`, `5.0` as `5`);
//!   an integer beyond ±2^53 is refused; any other number is written in its shortest round-trip
//!   digits, laid out by [`write_double`] (`0.1`, `123456789.125`, `1e21`, `1.5e-7`).
//! - In strings only `"`, `\` and U+0000 to U+001F are escaped (`\b`, `\f`, `\n`, `\r`, `\t`, else
//!   `\u00xx` in lower case); every other character is written as itself, outside the BMP too.
//! - A text field is a string when no run carries a mark, else its runs,
//!   `[{"attributes":{…},"insert":"…"}]` (`attributes` left out of a run without marks). A list is
//!   an array of ids, a map an object, a tree its nodes in pre-order as `[depth,"<id>"]` pairs
//!   (roots at depth 0), and a blob the value `{"hash","mime","size"}`. None of it depends on the
//!   schema that writes it.
//! - In a file's content, a list item or tree node naming no object of the document is left out
//!   (a node with its subtree); a snapshot holds the state exactly.
//! - Arrays and objects nest at most [`MAX_DEPTH`] deep, the outer object counted.
//! - No version (outside a snapshot), lineage, actor, origin or time.
//!
//! Reading refuses a key written twice in one object, a UUID not in lowercase hyphenated form, an
//! unknown key in the header, a wrong shape, and a byte order mark; what it accepts besides the
//! canonical form is listed in data model 7.4 (rule C13).

use std::collections::BTreeMap;
use std::fmt;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use uuid::Uuid;

use crate::value::canonical;
use crate::{DocId, KDM_VERSION, KdmError, Result};

/// The largest integer magnitude the encoding writes: every reader, JavaScript's doubles
/// included, holds integers up to ±2^53 exactly.
const MAX_SAFE_INTEGER: u64 = 1 << 53;

/// The deepest nesting of arrays and objects in the encoding, the outer object counted as 1: what
/// a reader holding a recursion limit of 128 (serde_json's) parses.
pub(crate) const MAX_DEPTH: usize = 127;

/// The nesting depth of a field's value: inside the outer object, `objects` and its object.
const FIELD_DEPTH: usize = 4;

/// The key of an object's type.
pub(crate) const TYPE_KEY: &str = "$type";

/// A snapshot's version (data model, "Versions"): the line of changes (`lineage`) and how many
/// changes of it the state holds (`seq`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ContentVersion {
    pub(crate) lineage: [u8; 16],
    pub(crate) seq: u64,
    /// The newest schema version a change of the replica's session was written under (rule
    /// M5a), which a replica loaded from the snapshot answers on (`authorSchemaVersion`).
    pub(crate) author_schema_version: Option<u64>,
}

/// A document's content as the encoding holds it: its header and its objects, each object with
/// `$type` and the fields it stores, in their content form.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Content {
    pub(crate) kit: String,
    pub(crate) doc_id: DocId,
    /// The document's minimum schema version (rule M20).
    pub(crate) schema_version: u64,
    /// Only in a snapshot; never in a file's content.
    pub(crate) version: Option<ContentVersion>,
    /// Each object's id and its fields, `$type` included, sorted by id.
    pub(crate) objects: BTreeMap<String, Map<String, Value>>,
}

/// The content's bytes. Refuses ([`KdmError::Encoding`]) an object without a string `$type`, an
/// integer beyond ±2^53 and a value nested deeper than [`MAX_DEPTH`]; leaves out fields holding
/// `null`.
pub(crate) fn encode(content: &Content) -> Result<Vec<u8>> {
    let mut out = String::with_capacity(128 + content.objects.len() * 96);
    out.push_str("{\"kdm\":");
    out.push_str(&KDM_VERSION.to_string());
    out.push_str(",\"kit\":");
    write_string(&mut out, &content.kit);
    out.push_str(",\"docId\":");
    write_string(&mut out, &content.doc_id.to_string());
    if let Some(version) = &content.version {
        out.push_str(",\"version\":{\"lineage\":");
        write_string(&mut out, &Uuid::from_bytes(version.lineage).to_string());
        out.push_str(",\"seq\":");
        out.push_str(&version.seq.to_string());
        if let Some(author) = version.author_schema_version {
            out.push_str(",\"authorSchemaVersion\":");
            out.push_str(&author.to_string());
        }
        out.push('}');
    }
    out.push_str(",\"schemaVersion\":");
    out.push_str(&content.schema_version.to_string());
    out.push_str(",\"objects\":{\n");
    let mut first = true;
    for (id, fields) in &content.objects {
        if !fields.get(TYPE_KEY).is_some_and(Value::is_string) {
            return Err(KdmError::Encoding(format!("object `{id}` has no `$type`")));
        }
        if !first {
            out.push_str(",\n");
        }
        first = false;
        write_string(&mut out, id);
        out.push(':');
        write_fields(&mut out, fields)?;
    }
    if !first {
        out.push('\n');
    }
    out.push_str("}}\n");
    Ok(out.into_bytes())
}

/// Bytes read as JSON by the encoding's reading rules (`what` names them in errors): no byte
/// order mark, and no key twice in one object at any depth ([`KdmError::Encoding`]).
pub(crate) fn parse(bytes: &[u8], what: &str) -> Result<Value> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(KdmError::Encoding(format!("not {what}: the bytes start with a byte order mark")));
    }
    serde_json::from_slice::<Strict>(bytes).map(|strict| strict.0).map_err(|error| KdmError::Encoding(format!("not {what}: {error}")))
}

/// A JSON value read without accepting a key twice in one object.
struct Strict(Value);

impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor).map(Strict)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Value, E> {
        Ok(Value::from(value))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Value, E> {
        Ok(Value::from(value))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Value, E> {
        Number::from_f64(value).map(Value::Number).ok_or_else(|| E::custom("a number that is not finite"))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Value, E> {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Value, E> {
        Ok(Value::String(value))
    }

    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(Strict(item)) = seq.next_element::<Strict>()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Value, A::Error> {
        let mut entries = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if entries.contains_key(&key) {
                return Err(de::Error::custom(format_args!("the key `{key}` is written twice in one object")));
            }
            let Strict(value) = map.next_value::<Strict>()?;
            entries.insert(key, value);
        }
        Ok(Value::Object(entries))
    }
}

/// Refuses a UUID not written in lowercase hyphenated form; `what` names it in errors.
fn uuid_text(text: &str, what: &str) -> Result<Uuid> {
    match Uuid::parse_str(text) {
        Ok(uuid) if uuid.to_string() == text => Ok(uuid),
        _ => Err(KdmError::Encoding(format!("not KDM content: {what} `{text}` is not a UUID in lowercase hyphenated form"))),
    }
}

/// Refuses an object id that is empty, or that reads as a UUID but is not written in lowercase
/// hyphenated form (one object, one way to write its id).
pub(crate) fn check_id(id: &str) -> Result<()> {
    if id.is_empty() {
        return Err(KdmError::Encoding("not KDM content: an object id is empty".into()));
    }
    match Uuid::parse_str(id) {
        Ok(uuid) if uuid.to_string() != id => {
            Err(KdmError::Encoding(format!("not KDM content: the object id `{id}` is a UUID not in lowercase hyphenated form")))
        }
        _ => Ok(()),
    }
}

/// Content from JSON read by [`parse`] (a file's content, or a snapshot). Refuses
/// ([`KdmError::Encoding`]) what is not this encoding: an unknown or missing header key, a header
/// value of the wrong shape, a UUID not in lowercase hyphenated form, an object without a string
/// `$type`, a field holding `null`, and an integer beyond ±2^53; and ([`KdmError::Schema`]) a
/// `kdm` other than 1. The fields' kinds are checked by the store that reads them.
pub(crate) fn decode_value(value: Value) -> Result<Content> {
    let bad = |reason: &str| KdmError::Encoding(format!("not KDM content: {reason}"));
    let Value::Object(mut top) = value else { return Err(bad("not a JSON object")) };
    if let Some(key) = top.keys().find(|key| !matches!(key.as_str(), "kdm" | "kit" | "docId" | "version" | "schemaVersion" | "objects")) {
        return Err(bad(&format!("unknown key `{key}`")));
    }
    match top.get("kdm").and_then(Value::as_u64) {
        Some(kdm) if kdm == u64::from(KDM_VERSION) => {}
        Some(kdm) => return Err(KdmError::Schema(format!("the document uses kdm {kdm}; this build reads {KDM_VERSION}"))),
        None => return Err(bad("`kdm` is missing")),
    }
    let kit = top.get("kit").and_then(Value::as_str).ok_or_else(|| bad("`kit` is missing"))?.to_owned();
    let doc_text = top.get("docId").and_then(Value::as_str).ok_or_else(|| bad("`docId` is missing"))?;
    uuid_text(doc_text, "`docId`")?;
    let doc_id = DocId::parse(doc_text)?;
    let schema_version = top.get("schemaVersion").and_then(Value::as_u64).ok_or_else(|| bad("`schemaVersion` is missing"))?;
    let version = match top.remove("version") {
        None => None,
        Some(Value::Object(version)) => {
            if let Some(key) = version.keys().find(|key| !matches!(key.as_str(), "lineage" | "seq" | "authorSchemaVersion")) {
                return Err(bad(&format!("unknown key `version.{key}`")));
            }
            let lineage = uuid_text(version.get("lineage").and_then(Value::as_str).ok_or_else(|| bad("`version.lineage` is missing"))?, "`version.lineage`")?;
            let seq = version.get("seq").and_then(Value::as_u64).ok_or_else(|| bad("`version.seq`"))?;
            let author_schema_version = match version.get("authorSchemaVersion") {
                None => None,
                Some(author) => Some(author.as_u64().ok_or_else(|| bad("`version.authorSchemaVersion`"))?),
            };
            Some(ContentVersion { lineage: *lineage.as_bytes(), seq, author_schema_version })
        }
        Some(_) => return Err(bad("`version` is not {lineage, seq}")),
    };
    let Some(Value::Object(stored)) = top.remove("objects") else { return Err(bad("`objects` is missing or not a JSON object")) };
    let mut objects = BTreeMap::new();
    for (id, object) in stored {
        check_id(&id)?;
        let Value::Object(fields) = object else { return Err(bad(&format!("object `{id}` is not a JSON object"))) };
        if !fields.get(TYPE_KEY).is_some_and(Value::is_string) {
            return Err(bad(&format!("object `{id}` has no `$type`")));
        }
        let mut kept = Map::new();
        for (name, value) in fields {
            if value.is_null() {
                return Err(bad(&format!("field `{name}` of `{id}` holds null (a field without a value is left out)")));
            }
            check_portable(&value)?;
            kept.insert(name, canonical(value));
        }
        objects.insert(id, kept);
    }
    Ok(Content { kit, doc_id, schema_version, version, objects })
}

/// Refuses an integer beyond ±2^53 at any depth.
fn check_portable(value: &Value) -> Result<()> {
    match value {
        Value::Number(number) => {
            let fits = match (number.as_i64(), number.as_u64()) {
                (Some(integer), _) => integer.unsigned_abs() <= MAX_SAFE_INTEGER,
                (None, Some(integer)) => integer <= MAX_SAFE_INTEGER,
                (None, None) => true,
            };
            if fits { Ok(()) } else { Err(KdmError::Encoding(format!("the integer {number} is beyond ±2^53"))) }
        }
        Value::Array(items) => items.iter().try_for_each(check_portable),
        Value::Object(entries) => entries.values().try_for_each(check_portable),
        _ => Ok(()),
    }
}

/// An object's fields, `null` ones left out, keys in byte order.
fn write_fields(out: &mut String, fields: &Map<String, Value>) -> Result<()> {
    let mut entries: Vec<(&String, &Value)> = fields.iter().filter(|(_, value)| !value.is_null()).collect();
    entries.sort_unstable_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    out.push('{');
    for (index, (key, value)) in entries.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_string(out, key);
        out.push(':');
        write_value(out, value, FIELD_DEPTH)?;
    }
    out.push('}');
    Ok(())
}

/// The error for a value nested deeper than [`MAX_DEPTH`].
fn too_deep() -> KdmError {
    KdmError::Encoding(format!("a value nests arrays and objects deeper than the encoding's {MAX_DEPTH} levels"))
}

/// One JSON value in the canonical form: keys in byte order, numbers by [`write_number`]. `depth`
/// is the nesting depth of the value when it is an array or an object.
fn write_value(out: &mut String, value: &Value, depth: usize) -> Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => write_number(out, number)?,
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            if depth > MAX_DEPTH {
                return Err(too_deep());
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item, depth + 1)?;
            }
            out.push(']');
        }
        Value::Object(entries) => {
            if depth > MAX_DEPTH {
                return Err(too_deep());
            }
            let mut sorted: Vec<(&String, &Value)> = entries.iter().collect();
            sorted.sort_unstable_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            out.push('{');
            for (index, (key, item)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item, depth + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// A number: an integer when whole and within ±2^53 (`-0` is `0`); an integer beyond is refused;
/// any other double by [`write_double`].
fn write_number(out: &mut String, number: &serde_json::Number) -> Result<()> {
    if let Some(integer) = number.as_i64() {
        if integer.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(KdmError::Encoding(format!("the integer {integer} is beyond ±2^53")));
        }
        out.push_str(&integer.to_string());
        return Ok(());
    }
    if let Some(integer) = number.as_u64() {
        if integer > MAX_SAFE_INTEGER {
            return Err(KdmError::Encoding(format!("the integer {integer} is beyond ±2^53")));
        }
        out.push_str(&integer.to_string());
        return Ok(());
    }
    let Some(float) = number.as_f64().filter(|float| float.is_finite()) else {
        return Err(KdmError::Encoding(format!("the number {number} is not finite")));
    };
    if float.fract() == 0.0 && float.abs() <= MAX_SAFE_INTEGER as f64 {
        out.push_str(&(float as i64).to_string());
        return Ok(());
    }
    write_double(out, float);
    Ok(())
}

/// A double that is not a whole number within ±2^53, in its shortest round-trip digits (the
/// fewest decimal digits that read back as the same double, as Rust's float formatting finds
/// them), laid out by where its decimal point falls (`point`: the value is `0.<digits> × 10^point`):
///
/// - `0 <= point - digits` and `point <= 16`: the digits, zeros, `.0` (`9007199254740994.0`);
/// - `0 < point <= 16`: the digits with a decimal point (`123456789.125`, `0.5` is `point` 0, below);
/// - `-5 < point <= 0`: `0.`, zeros, the digits (`0.1`, `0.0001`);
/// - otherwise an exponent without `+`: `1e21`, `1e16`, `1.5e-7`, `5e-324`.
fn write_double(out: &mut String, float: f64) {
    let scientific = format!("{:e}", float.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((scientific.as_str(), "0"));
    let exponent: i64 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let count = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    let point = exponent + 1;
    if float < 0.0 {
        out.push('-');
    }
    if 0 <= point - count && point <= 16 {
        out.push_str(&digits);
        out.push_str(&"0".repeat(usize::try_from(point - count).unwrap_or(0)));
        out.push_str(".0");
    } else if 0 < point && point <= 16 {
        let (whole, fraction) = digits.split_at(usize::try_from(point).unwrap_or(0).min(digits.len()));
        out.push_str(whole);
        out.push('.');
        out.push_str(fraction);
    } else if -5 < point && point <= 0 {
        out.push_str("0.");
        out.push_str(&"0".repeat(usize::try_from(-point).unwrap_or(0)));
        out.push_str(&digits);
    } else {
        let (first, rest) = digits.split_at(1.min(digits.len()));
        out.push_str(first);
        if !rest.is_empty() {
            out.push('.');
            out.push_str(rest);
        }
        out.push('e');
        out.push_str(&(point - 1).to_string());
    }
}

/// A string as serde_json writes it: `"` and `\` escaped, U+0000 to U+001F escaped (`\b`, `\f`,
/// `\n`, `\r`, `\t`, else `\u00xx`), everything else as itself.
fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", control as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number(value: Value) -> String {
        let mut out = String::new();
        let Value::Number(number) = value else { panic!("not a number") };
        write_number(&mut out, &number).unwrap();
        out
    }

    #[test]
    fn numbers_are_written_by_the_rules() {
        assert_eq!(number(serde_json::json!(5.0)), "5");
        assert_eq!(number(serde_json::json!(-0.0)), "0");
        assert_eq!(number(serde_json::json!(9_007_199_254_740_992.0)), "9007199254740992");
        assert_eq!(number(serde_json::json!(-9_007_199_254_740_992i64)), "-9007199254740992");
        assert_eq!(number(serde_json::json!(1e16)), "1e16");
        assert_eq!(number(serde_json::json!(1e21)), "1e21");
        assert_eq!(number(serde_json::json!(0.1)), "0.1");
        assert_eq!(number(serde_json::json!(0.1 + 0.2)), "0.30000000000000004");
        assert_eq!(number(serde_json::json!(1.5e-7)), "1.5e-7");
        assert_eq!(number(serde_json::json!(0.0001)), "0.0001");
        assert_eq!(number(serde_json::json!(-2.5)), "-2.5");
        assert_eq!(number(serde_json::json!(0.5)), "0.5");
        assert_eq!(number(serde_json::json!(123_456_789.125)), "123456789.125");
        assert_eq!(number(serde_json::json!(9_007_199_254_740_994.0)), "9007199254740994.0");
        assert_eq!(number(serde_json::json!(1e-5)), "0.00001");
        assert_eq!(number(serde_json::json!(1e-6)), "1e-6");
        assert_eq!(number(serde_json::json!(1.5e-6)), "1.5e-6");
        assert_eq!(number(serde_json::json!(1e-7)), "1e-7");
        assert_eq!(number(serde_json::json!(5e-324)), "5e-324");
        assert_eq!(number(serde_json::json!(-2.5e-10)), "-2.5e-10");
        assert_eq!(number(serde_json::json!(1.7976931348623157e308)), "1.7976931348623157e308");
        let mut out = String::new();
        let Value::Number(big) = serde_json::json!(9_007_199_254_740_993u64) else { unreachable!() };
        assert!(write_number(&mut out, &big).is_err());
    }

    #[test]
    fn strings_escape_quotes_backslashes_and_controls_only() {
        let mut out = String::new();
        write_string(&mut out, "a\"b\\c\n\t\u{1}\u{1f}\u{7f}/\u{2028}\u{e9}\u{1f600}");
        assert_eq!(out, "\"a\\\"b\\\\c\\n\\t\\u0001\\u001f\u{7f}/\u{2028}\u{e9}\u{1f600}\"");
        // serde_json writes the same.
        assert_eq!(out, serde_json::to_string("a\"b\\c\n\t\u{1}\u{1f}\u{7f}/\u{2028}\u{e9}\u{1f600}").unwrap());
    }

    fn one_page(fields: Value) -> Content {
        let mut object = fields.as_object().cloned().unwrap();
        object.insert(TYPE_KEY.into(), Value::String("Page".into()));
        Content { kit: "kit.content".into(), doc_id: DocId::new(), schema_version: 1, version: None, objects: [("p".to_owned(), object)].into_iter().collect() }
    }

    /// `levels` arrays nested in each other.
    fn nested(levels: usize) -> Value {
        let mut value = Value::Array(Vec::new());
        for _ in 1..levels {
            value = Value::Array(vec![value]);
        }
        value
    }

    #[test]
    fn encode_refuses_integers_beyond_two_to_the_53_and_values_nested_too_deep() {
        assert!(matches!(encode(&one_page(serde_json::json!({ "box": { "deep": [u64::MAX] } }))), Err(KdmError::Encoding(_))));
        // A field's value sits at depth 4: 124 levels reach the limit, 125 pass it.
        let at_limit = encode(&one_page(serde_json::json!({ "box": nested(MAX_DEPTH - FIELD_DEPTH + 1) }))).unwrap();
        assert!(parse(&at_limit, "KDM content").is_ok(), "serde_json reads what the writer writes at the limit");
        assert!(matches!(encode(&one_page(serde_json::json!({ "box": nested(MAX_DEPTH - FIELD_DEPTH + 2) }))), Err(KdmError::Encoding(_))));
        // `encode` leaves out a field holding null.
        let written = String::from_utf8(encode(&one_page(serde_json::json!({ "kind": null, "name": "x" }))).unwrap()).unwrap();
        assert!(written.contains("\"p\":{\"$type\":\"Page\",\"name\":\"x\"}\n"), "{written}");
    }

    #[test]
    fn parse_refuses_a_key_written_twice_at_any_depth_and_a_byte_order_mark() {
        assert!(parse(br#"{"a":{"b":[{"c":1,"d":2}]}}"#, "x").is_ok());
        let twice_cases: [&[u8]; 3] = [br#"{"a":1,"a":2}"#, br#"{"a":{"b":[{"c":1,"c":1}]}}"#, br#"{"a":1,"\u0061":2}"#];
        for twice in twice_cases {
            assert!(matches!(parse(twice, "x"), Err(KdmError::Encoding(_))), "{}", String::from_utf8_lossy(twice));
        }
        assert!(matches!(parse(b"\xEF\xBB\xBF{}", "x"), Err(KdmError::Encoding(_))));
    }
}
