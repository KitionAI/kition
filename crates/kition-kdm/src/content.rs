// Copied from kition-sdk crates/kition-kdm/src/content.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The content encoding (data model 7.4): the bytes a kit writes into a person's file
//! (`content.json`), and, with a version, a replica's snapshot.
//!
//! This is the one part of the KDM that cannot change after the first public release: every rule
//! below is a test (`tests/content.rs`, fixtures `tests/fixtures/content/`). There is one writer:
//! [`crate::Replica::content_snapshot`] and [`crate::Replica::snapshot`] write the store with
//! [`write`]; [`crate::Replica::load`] reads it with [`read`] and [`decode`] into the store
//! ([`crate::store::Store::from_content`]).
//!
//! Both stream (plan 2026-11-24, plain model, section 10): [`read`] goes from the bytes straight
//! into the store's objects, a map field entry by entry, without a JSON tree of the document or of
//! an object (only a register's value, a list, a text or a tree is read as JSON before it is
//! held); [`write`] writes the store into one growing buffer. Loading a document costs about the
//! store it becomes, and saving one about the bytes it writes (`tests/large_documents.rs`).
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

use std::fmt;
use std::ops::Deref;
use std::sync::Arc;

use serde::de::{self, Deserialize, DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use uuid::Uuid;

use crate::ids::is_lower_uuid;
use crate::store::op::Name;
use crate::store::scalar::{Entries, Key, Scalar};
use crate::store::{Field, Names, Object, Store};
use crate::value::canonical;
use crate::{DocId, FieldDef, FieldKind, KDM_VERSION, KdmError, ObjectId, Result, Schema, TextRun};

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

/// A document's content as [`decode`] reads it: its header and its objects.
pub(crate) struct Content {
    pub(crate) kit: String,
    pub(crate) doc_id: DocId,
    /// The document's minimum schema version (rule M20).
    pub(crate) schema_version: u64,
    /// Only in a snapshot; never in a file's content.
    pub(crate) version: Option<ContentVersion>,
    pub(crate) objects: Objects,
}

/// The objects [`read`] read, each with `$type` and the fields it stores, read as the schema
/// declares them.
pub(crate) struct Objects {
    /// Sorted by id, each id once.
    list: Vec<(ObjectId, Arc<Object>)>,
    /// The type and field names and the objects' shapes, each held once.
    names: Names,
    /// `objects` is not a JSON object.
    not_object: bool,
    /// The first value the encoding refuses whatever the schema (an id not in its form, an object
    /// that is not a JSON object or has no string `$type`, a field holding `null`, an integer
    /// beyond ±2^53), refused before the header is checked against the schema.
    refused: Option<KdmError>,
    /// The first field of the wrong shape for its kind, refused after that check.
    misshapen: Option<KdmError>,
}

impl Objects {
    /// The objects and names, or the first field of the wrong shape.
    pub(crate) fn into_parts(self) -> Result<Parts> {
        match self.misshapen {
            Some(error) => Err(error),
            None => Ok((self.list, self.names)),
        }
    }

    fn not_object() -> Self {
        Self { list: Vec::new(), names: Names::default(), not_object: true, refused: None, misshapen: None }
    }
}

/// The objects read, sorted by id, and the type and field names they use.
pub(crate) type Parts = (Vec<(ObjectId, Arc<Object>)>, Names);

/// What [`read`] read: every top-level key but `objects` with its value, and the objects.
pub(crate) struct Read {
    /// `None` when the bytes are JSON but not a JSON object.
    pub(crate) top: Option<Map<String, Value>>,
    /// `None` when there is no `objects` key.
    pub(crate) objects: Option<Objects>,
}

/// The error for content that is not this encoding.
fn bad(reason: &str) -> KdmError {
    KdmError::Encoding(format!("not KDM content: {reason}"))
}

/// The error for a key written twice in one JSON object.
fn twice<E: de::Error>(key: &str) -> E {
    E::custom(format_args!("the key `{key}` is written twice in one object"))
}

/// Bytes read by the encoding's reading rules (`what` names them in errors), as content, a
/// snapshot or a change list: no byte order mark, valid JSON, no key twice in one object at any
/// depth ([`KdmError::Encoding`]). The objects, when there are, go straight into store objects,
/// each field as `schema` declares it; what the encoding refuses in them is answered by
/// [`decode`] and [`Store::from_content`], in the order the rules check them.
pub(crate) fn read(bytes: &[u8], what: &str, schema: &Schema) -> Result<Read> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(KdmError::Encoding(format!("not {what}: the bytes start with a byte order mark")));
    }
    let failed = |error: serde_json::Error| KdmError::Encoding(format!("not {what}: {error}"));
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let read = Top { schema }.deserialize(&mut deserializer).map_err(failed)?;
    deserializer.end().map_err(failed)?;
    Ok(read)
}

/// [`read`] of the bytes `reader` yields, taken in chunks as the parser needs them, so the caller
/// need not hold the whole content beside the store it fills. A failure to read them is
/// [`KdmError::Encoding`].
pub(crate) fn read_from(mut reader: impl std::io::Read, what: &str, schema: &Schema) -> Result<Read> {
    let failed_io = |error: std::io::Error| KdmError::Encoding(format!("not {what}: {error}"));
    // The first three bytes, for the byte order mark.
    let mut head = [0u8; 3];
    let mut held = 0;
    while let Some(rest) = head.get_mut(held..).filter(|rest| !rest.is_empty()) {
        match reader.read(rest) {
            Ok(0) => break,
            Ok(count) => held += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(failed_io(error)),
        }
    }
    let start = head.get(..held).unwrap_or_default();
    if start == [0xEF, 0xBB, 0xBF] {
        return Err(KdmError::Encoding(format!("not {what}: the bytes start with a byte order mark")));
    }
    let failed = |error: serde_json::Error| KdmError::Encoding(format!("not {what}: {error}"));
    let bytes = std::io::BufReader::with_capacity(64 << 10, std::io::Read::chain(start, reader));
    let mut deserializer = serde_json::Deserializer::from_reader(bytes);
    let read = Top { schema }.deserialize(&mut deserializer).map_err(failed)?;
    deserializer.end().map_err(failed)?;
    Ok(read)
}

/// Content from what [`read`] read (a file's content, or a snapshot). Refuses
/// ([`KdmError::Encoding`]) what is not this encoding: an unknown or missing header key, a header
/// value of the wrong shape, a UUID not in lowercase hyphenated form, an object without a string
/// `$type`, a field holding `null`, and an integer beyond ±2^53; and ([`KdmError::Schema`]) a
/// `kdm` other than 1. The fields' shapes are refused by [`Store::from_content`].
pub(crate) fn decode(read: Read) -> Result<Content> {
    let Read { top, objects } = read;
    let Some(mut top) = top else { return Err(bad("not a JSON object")) };
    if let Some(key) = top.keys().find(|key| !matches!(key.as_str(), "kdm" | "kit" | "docId" | "version" | "schemaVersion")) {
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
    let Some(mut objects) = objects.filter(|objects| !objects.not_object) else { return Err(bad("`objects` is missing or not a JSON object")) };
    if let Some(error) = objects.refused.take() {
        return Err(error);
    }
    Ok(Content { kit, doc_id, schema_version, version, objects })
}

/// Bytes read as JSON by the encoding's reading rules (`what` names them in errors): no byte
/// order mark, and no key twice in one object at any depth ([`KdmError::Encoding`]). For change
/// lists, which are small; content is [`read`].
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
                return Err(twice(&key));
            }
            let Strict(value) = map.next_value::<Strict>()?;
            entries.insert(key, value);
        }
        Ok(Value::Object(entries))
    }
}

/// The visits of every JSON value but an object, for a reader that streams objects: each value is
/// read as [`StrictVisitor`] reads it and handed to the reader's `$other`.
macro_rules! other_values {
    ($other:ident, $de:lifetime) => {
        fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Self::Value, E> {
            let value = StrictVisitor.visit_bool::<E>(value)?;
            self.$other(value)
        }

        fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Self::Value, E> {
            let value = StrictVisitor.visit_i64::<E>(value)?;
            self.$other(value)
        }

        fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Self::Value, E> {
            let value = StrictVisitor.visit_u64::<E>(value)?;
            self.$other(value)
        }

        fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Self::Value, E> {
            let value = StrictVisitor.visit_f64::<E>(value)?;
            self.$other(value)
        }

        fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Self::Value, E> {
            let value = StrictVisitor.visit_str::<E>(value)?;
            self.$other(value)
        }

        fn visit_unit<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
            self.$other(Value::Null)
        }

        fn visit_none<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
            self.$other(Value::Null)
        }

        fn visit_seq<A: SeqAccess<$de>>(self, seq: A) -> std::result::Result<Self::Value, A::Error> {
            let value = StrictVisitor.visit_seq(seq)?;
            self.$other(value)
        }
    };
}

/// A key's text, borrowed from the bytes when it has no escapes.
enum KeyText<'de> {
    Borrowed(&'de str),
    Owned(String),
}

impl Deref for KeyText<'_> {
    type Target = str;

    fn deref(&self) -> &str {
        match self {
            Self::Borrowed(text) => text,
            Self::Owned(text) => text,
        }
    }
}

impl<'de> Deserialize<'de> for KeyText<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        deserializer.deserialize_str(KeyTextVisitor)
    }
}

struct KeyTextVisitor;

impl<'de> Visitor<'de> for KeyTextVisitor {
    type Value = KeyText<'de>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a key")
    }

    fn visit_borrowed_str<E: de::Error>(self, value: &'de str) -> std::result::Result<Self::Value, E> {
        Ok(KeyText::Borrowed(value))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Self::Value, E> {
        Ok(KeyText::Owned(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Self::Value, E> {
        Ok(KeyText::Owned(value))
    }
}

/// The top level of content, a snapshot or a change list.
struct Top<'s> {
    schema: &'s Schema,
}

impl<'de> DeserializeSeed<'de> for Top<'_> {
    type Value = Read;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> std::result::Result<Read, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Top<'_> {
    type Value = Read;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Read, A::Error> {
        let mut top = Map::new();
        let mut objects = None;
        while let Some(key) = map.next_key::<String>()? {
            if top.contains_key(&key) || (key == "objects" && objects.is_some()) {
                return Err(twice(&key));
            }
            if key == "objects" {
                objects = Some(map.next_value_seed(ObjectsSeed { schema: self.schema })?);
            } else {
                let Strict(value) = map.next_value::<Strict>()?;
                top.insert(key, value);
            }
        }
        Ok(Read { top: Some(top), objects })
    }

    other_values!(other, 'de);
}

impl Top<'_> {
    fn other<E: de::Error>(self, _value: Value) -> std::result::Result<Read, E> {
        Ok(Read { top: None, objects: None })
    }
}

/// What the objects of one document collect while they are read.
struct Loading<'s> {
    schema: &'s Schema,
    names: Names,
    refused: Option<KdmError>,
    misshapen: Option<KdmError>,
}

impl Loading<'_> {
    fn refuse(&mut self, error: KdmError) {
        if self.refused.is_none() {
            self.refused = Some(error);
        }
    }

    fn misshape(&mut self, error: KdmError) {
        if self.misshapen.is_none() {
            self.misshapen = Some(error);
        }
    }

    /// Field `name` of object `id` from its JSON value, as the schema declares it (`def`):
    /// `None` when it is refused (noted) or empty.
    fn field(&mut self, id: &str, name: &str, value: Value, def: Option<&FieldDef>) -> Option<Field> {
        if value.is_null() {
            self.refuse(bad(&format!("field `{name}` of `{id}` holds null (a field without a value is left out)")));
            return None;
        }
        if let Err(error) = check_portable(&value) {
            self.refuse(error);
            return None;
        }
        match Field::from_content(name, canonical(value), def) {
            Ok(field) => Some(field),
            Err(error) => {
                self.misshape(error);
                None
            }
        }
    }
}

/// The `objects` of content: each object read into a store object as it comes.
struct ObjectsSeed<'s> {
    schema: &'s Schema,
}

impl<'de> DeserializeSeed<'de> for ObjectsSeed<'_> {
    type Value = Objects;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> std::result::Result<Objects, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for ObjectsSeed<'_> {
    type Value = Objects;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the objects")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Objects, A::Error> {
        let mut loading = Loading { schema: self.schema, names: Names::default(), refused: None, misshapen: None };
        let mut list = Vec::new();
        while let Some(id) = map.next_key::<KeyText<'de>>()? {
            if let Err(error) = check_id(&id) {
                loading.refuse(error);
            }
            let object = map.next_value_seed(ObjectSeed { loading: &mut loading, id: &id })?;
            list.push((ObjectId::from_text(&id), Arc::new(object)));
        }
        list.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        if let Some(((id, _), _)) = list.iter().zip(list.iter().skip(1)).find(|(a, b)| a.0 == b.0) {
            return Err(twice(id.as_str()));
        }
        Ok(Objects { list, names: loading.names, not_object: false, refused: loading.refused, misshapen: loading.misshapen })
    }

    other_values!(other, 'de);
}

impl ObjectsSeed<'_> {
    fn other<E: de::Error>(self, _value: Value) -> std::result::Result<Objects, E> {
        Ok(Objects::not_object())
    }
}

/// One object of content, read into a store object. Its fields are read as its type declares
/// them; those before `$type` (keys in another order than the encoding's) wait for it as JSON.
struct ObjectSeed<'a, 's> {
    loading: &'a mut Loading<'s>,
    id: &'a str,
}

impl<'de> DeserializeSeed<'de> for ObjectSeed<'_, '_> {
    type Value = Object;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> std::result::Result<Object, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for ObjectSeed<'_, '_> {
    type Value = Object;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Object, A::Error> {
        let Self { loading, id } = self;
        let schema = loading.schema;
        let mut ty: Option<Name> = None;
        let mut typed = false;
        let mut def = None;
        let mut pending: Vec<(Name, Value)> = Vec::new();
        let mut fields: Vec<(Name, Field)> = Vec::new();
        let mut seen: Vec<Name> = Vec::new();
        while let Some(key) = map.next_key::<KeyText<'de>>()? {
            if &*key == TYPE_KEY {
                if typed {
                    return Err(twice(TYPE_KEY));
                }
                typed = true;
                let Strict(value) = map.next_value::<Strict>()?;
                if let Value::String(name) = value {
                    let name = loading.names.name(&name);
                    def = schema.types.get(&*name);
                    for (field, value) in pending.drain(..) {
                        let declared = def.and_then(|def| def.fields.get(&*field));
                        if let Some(held) = loading.field(id, &field, value, declared) {
                            fields.push((field, held));
                        }
                    }
                    ty = Some(name);
                }
                continue;
            }
            let name = loading.names.name(&key);
            seen.push(name.clone());
            let declared = def.and_then(|def| def.fields.get(&*name));
            match (&ty, declared) {
                (Some(_), Some(declared)) if declared.kind == FieldKind::Map => {
                    if let Some(held) = map.next_value_seed(MapSeed { loading: &mut *loading, id, name: &name, def: declared })? {
                        fields.push((name, held));
                    }
                }
                (Some(_), declared) => {
                    let Strict(value) = map.next_value::<Strict>()?;
                    if let Some(held) = loading.field(id, &name, value, declared) {
                        fields.push((name, held));
                    }
                }
                (None, _) => {
                    let Strict(value) = map.next_value::<Strict>()?;
                    pending.push((name, value));
                }
            }
        }
        seen.sort_unstable();
        if let Some((name, _)) = seen.iter().zip(seen.iter().skip(1)).find(|(a, b)| a == b) {
            return Err(twice(name));
        }
        let Some(ty) = ty else {
            loading.refuse(bad(&format!("object `{id}` has no `$type`")));
            return Ok(Object::new(Name::from("")));
        };
        Ok(Object::of_fields(ty, fields, &mut loading.names))
    }

    other_values!(other, 'de);
}

impl ObjectSeed<'_, '_> {
    fn other<E: de::Error>(self, _value: Value) -> std::result::Result<Object, E> {
        self.loading.refuse(bad(&format!("object `{}` is not a JSON object", self.id)));
        Ok(Object::new(Name::from("")))
    }
}

/// A map field, read entry by entry into its entries: `None` when it is empty or refused (noted).
struct MapSeed<'a, 's> {
    loading: &'a mut Loading<'s>,
    id: &'a str,
    name: &'a str,
    def: &'a FieldDef,
}

impl<'de> DeserializeSeed<'de> for MapSeed<'_, '_> {
    type Value = Option<Field>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> std::result::Result<Option<Field>, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for MapSeed<'_, '_> {
    type Value = Option<Field>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a map")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Option<Field>, A::Error> {
        let Self { loading, name, def, .. } = self;
        let ids = def.of.is_some();
        let mut entries: Vec<(Key, Scalar)> = Vec::new();
        while let Some(key) = map.next_key::<KeyText<'de>>()? {
            let value = map.next_value_seed(EntrySeed { loading: &mut *loading })?;
            if value.is_null() {
                loading.misshape(KdmError::Encoding(format!("not KDM content: map entry `{}` of field `{name}` holds null", &*key)));
            }
            if ids && let Some(Err(error)) = value.with_str(|text| text.map(check_id)) {
                loading.misshape(error);
            }
            entries.push((Key::new(&key), value));
        }
        entries.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        if let Some(((key, _), _)) = entries.iter().zip(entries.iter().skip(1)).find(|(a, b)| a.0 == b.0) {
            return Err(twice(&key.to_text()));
        }
        Ok((!entries.is_empty()).then(|| Field::Map(Box::new(Entries::from_sorted(entries)))))
    }

    other_values!(other, 'de);
}

impl MapSeed<'_, '_> {
    /// A map field holding another JSON value: refused as [`Loading::field`] refuses it.
    fn other<E: de::Error>(self, value: Value) -> std::result::Result<Option<Field>, E> {
        Ok(self.loading.field(self.id, self.name, value, Some(self.def)))
    }
}

/// One map entry's value, held as it is read.
struct EntrySeed<'a, 's> {
    loading: &'a mut Loading<'s>,
}

impl<'de> DeserializeSeed<'de> for EntrySeed<'_, '_> {
    type Value = Scalar;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> std::result::Result<Scalar, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl EntrySeed<'_, '_> {
    /// An array or object value: refused when it holds an integer beyond ±2^53 (noted), canonical.
    fn json(self, value: Value) -> Scalar {
        if let Err(error) = check_portable(&value) {
            self.loading.refuse(error);
        }
        Scalar::from_value(canonical(value))
    }
}

impl<'de> Visitor<'de> for EntrySeed<'_, '_> {
    type Value = Scalar;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a value")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Scalar, E> {
        Ok(Scalar::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Scalar, E> {
        if value.unsigned_abs() > MAX_SAFE_INTEGER {
            self.loading.refuse(beyond(value));
        }
        Ok(Scalar::Int(value))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Scalar, E> {
        if value > MAX_SAFE_INTEGER {
            self.loading.refuse(beyond(value));
        }
        Ok(i64::try_from(value).map_or(Scalar::Big(value), Scalar::Int))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Scalar, E> {
        let Value::Number(number) = canonical(StrictVisitor.visit_f64::<E>(value)?) else { return Ok(Scalar::Null) };
        Ok(Scalar::from_number(&number))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Scalar, E> {
        Ok(Scalar::of_str(value))
    }

    fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Scalar, E> {
        Ok(Scalar::from_string(value))
    }

    fn visit_unit<E: de::Error>(self) -> std::result::Result<Scalar, E> {
        Ok(Scalar::Null)
    }

    fn visit_none<E: de::Error>(self) -> std::result::Result<Scalar, E> {
        Ok(Scalar::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> std::result::Result<Scalar, A::Error> {
        let value = StrictVisitor.visit_seq(seq)?;
        Ok(self.json(value))
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> std::result::Result<Scalar, A::Error> {
        let value = StrictVisitor.visit_map(map)?;
        Ok(self.json(value))
    }
}

/// The refusal of an integer beyond ±2^53.
fn beyond(integer: impl fmt::Display) -> KdmError {
    KdmError::Encoding(format!("the integer {integer} is beyond ±2^53"))
}

/// Refuses a UUID not written in lowercase hyphenated form; `what` names it in errors.
fn uuid_text(text: &str, what: &str) -> Result<Uuid> {
    match Uuid::parse_str(text) {
        Ok(uuid) if is_lower_uuid(text.as_bytes()) => Ok(uuid),
        _ => Err(KdmError::Encoding(format!("not KDM content: {what} `{text}` is not a UUID in lowercase hyphenated form"))),
    }
}

/// Refuses an object id that is empty, or that reads as a UUID but is not written in lowercase
/// hyphenated form (one object, one way to write its id).
pub(crate) fn check_id(id: &str) -> Result<()> {
    if id.is_empty() {
        return Err(KdmError::Encoding("not KDM content: an object id is empty".into()));
    }
    if is_lower_uuid(id.as_bytes()) {
        return Ok(());
    }
    match Uuid::parse_str(id) {
        Ok(_) => Err(KdmError::Encoding(format!("not KDM content: the object id `{id}` is a UUID not in lowercase hyphenated form"))),
        Err(_) => Ok(()),
    }
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
            if fits { Ok(()) } else { Err(beyond(number)) }
        }
        Value::Array(items) => items.iter().try_for_each(check_portable),
        Value::Object(entries) => entries.values().try_for_each(check_portable),
        _ => Ok(()),
    }
}

/// The bytes being written: grown by a quarter at a time (not doubled), so a save holds little
/// more than what it writes.
#[derive(Default)]
pub(crate) struct Out(Vec<u8>);

impl Out {
    fn push(&mut self, bytes: &[u8]) {
        if self.0.capacity() - self.0.len() < bytes.len() {
            self.0.reserve_exact(bytes.len().max(self.0.len() / 4).max(64));
        }
        self.0.extend_from_slice(bytes);
    }

    fn push_str(&mut self, text: &str) {
        self.push(text.as_bytes());
    }

    fn byte(&mut self, byte: u8) {
        self.push(&[byte]);
    }

    fn finish(mut self) -> Vec<u8> {
        self.0.shrink_to_fit();
        self.0
    }

    #[cfg(test)]
    fn text(self) -> String {
        String::from_utf8(self.0).unwrap_or_default()
    }
}

/// The store's content in this encoding: a file's (`version` `None`), or a snapshot's. Written
/// from the store as it is, object by object, into one buffer. Refuses ([`KdmError::Encoding`])
/// an integer beyond ±2^53 and a value nested deeper than [`MAX_DEPTH`].
///
/// In a file's content, list items and tree nodes naming no object of the document (a deleted
/// object's list entries, which stay until the kit removes them) are left out, a node with its
/// subtree, as reads skip them: a file never names a missing object. A snapshot holds the state
/// exactly, so that a replica loaded from it at its version holds the same state and takes the
/// same later changes (a `list_remove` of such an entry included).
pub(crate) fn write(store: &Store, version: Option<ContentVersion>) -> Result<Vec<u8>> {
    let exact = version.is_some();
    let keep = |id: &ObjectId| exact || store.contains(id);
    let mut out = Out::default();
    out.push(b"{\"kdm\":");
    out.push_str(&KDM_VERSION.to_string());
    out.push(b",\"kit\":");
    write_string(&mut out, &store.kit);
    out.push(b",\"docId\":");
    write_string(&mut out, &store.doc_id.to_string());
    if let Some(version) = &version {
        out.push(b",\"version\":{\"lineage\":");
        write_string(&mut out, &Uuid::from_bytes(version.lineage).to_string());
        out.push(b",\"seq\":");
        out.push_str(&version.seq.to_string());
        if let Some(author) = version.author_schema_version {
            out.push(b",\"authorSchemaVersion\":");
            out.push_str(&author.to_string());
        }
        out.byte(b'}');
    }
    out.push(b",\"schemaVersion\":");
    out.push_str(&store.schema_version.to_string());
    out.push(b",\"objects\":{\n");
    let mut first = true;
    for (id, object) in store.objects() {
        if !first {
            out.push(b",\n");
        }
        first = false;
        write_string(&mut out, id.as_str());
        out.byte(b':');
        write_object(&mut out, object, &keep)?;
    }
    if !first {
        out.byte(b'\n');
    }
    out.push(b"}}\n");
    Ok(out.finish())
}

/// A key of a JSON object and its `:`, after a `,` unless it is the first.
fn write_key(out: &mut Out, first: &mut bool, key: &str) {
    if !*first {
        out.byte(b',');
    }
    *first = false;
    write_string(out, key);
    out.byte(b':');
}

/// An object: `$type` and its fields, keys in byte order, empty fields left out.
fn write_object(out: &mut Out, object: &Object, keep: &dyn Fn(&ObjectId) -> bool) -> Result<()> {
    out.byte(b'{');
    let mut first = true;
    let mut typed = false;
    for (name, field) in object.fields() {
        if !typed && name.as_bytes() > TYPE_KEY.as_bytes() {
            write_key(out, &mut first, TYPE_KEY);
            write_string(out, object.ty());
            typed = true;
        }
        write_field(out, &mut first, name, field, keep)?;
    }
    if !typed {
        write_key(out, &mut first, TYPE_KEY);
        write_string(out, object.ty());
    }
    out.byte(b'}');
    Ok(())
}

/// One field in its content form (data model 7.4, rule C8), unless it is empty.
fn write_field(out: &mut Out, first: &mut bool, name: &str, field: &Field, keep: &dyn Fn(&ObjectId) -> bool) -> Result<()> {
    match field {
        Field::Value(value) => {
            if !value.is_null() {
                write_key(out, first, name);
                write_scalar(out, value, FIELD_DEPTH)?;
            }
        }
        Field::Text(text) => {
            if text.is_empty() {
                return Ok(());
            }
            write_key(out, first, name);
            if text.has_marks() {
                write_value(out, &Value::Array(text.runs().iter().map(TextRun::to_json).collect()), FIELD_DEPTH)?;
            } else {
                write_string(out, &text.string());
            }
        }
        Field::List(items) => {
            if !items.iter().any(keep) {
                return Ok(());
            }
            write_key(out, first, name);
            out.byte(b'[');
            for (index, item) in items.iter().filter(|item| keep(item)).enumerate() {
                if index > 0 {
                    out.byte(b',');
                }
                write_string(out, item.as_str());
            }
            out.byte(b']');
        }
        Field::Map(entries) => {
            if entries.is_empty() {
                return Ok(());
            }
            write_key(out, first, name);
            out.byte(b'{');
            for (index, (key, value)) in entries.iter().enumerate() {
                if index > 0 {
                    out.byte(b',');
                }
                key.with_str(|text| write_string(out, text));
                out.byte(b':');
                write_scalar(out, value, FIELD_DEPTH + 1)?;
            }
            out.byte(b'}');
        }
        Field::Tree(tree) => {
            let nodes = tree.flat(keep);
            if nodes.is_empty() {
                return Ok(());
            }
            write_key(out, first, name);
            out.byte(b'[');
            for (index, (depth, node)) in nodes.into_iter().enumerate() {
                if index > 0 {
                    out.byte(b',');
                }
                out.byte(b'[');
                out.push_str(&depth.to_string());
                out.byte(b',');
                write_string(out, node.as_str());
                out.byte(b']');
            }
            out.byte(b']');
        }
    }
    Ok(())
}

/// A register's or a map entry's value; `depth` as in [`write_value`].
fn write_scalar(out: &mut Out, value: &Scalar, depth: usize) -> Result<()> {
    match value {
        Scalar::Null => out.push(b"null"),
        Scalar::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Scalar::Int(integer) => write_integer(out, *integer)?,
        Scalar::Big(integer) => return Err(beyond(integer)),
        Scalar::Float(float) => write_float(out, *float)?,
        Scalar::Short { .. } | Scalar::Uuid(_) | Scalar::Pair(_) | Scalar::Str(_) => value.with_str(|text| write_string(out, text.unwrap_or_default())),
        Scalar::Json(text) => out.push_str(text),
        Scalar::Deep(json) => write_value(out, json, depth)?,
    }
    Ok(())
}

/// An array's or an object's text in this encoding, as a map entry's value (the deepest a value
/// sits); `None` when the encoding refuses it there (an integer beyond ±2^53, nesting too deep).
pub(crate) fn json_text(value: &Value) -> Option<Box<str>> {
    let mut out = Out::default();
    write_value(&mut out, value, FIELD_DEPTH + 1).ok()?;
    String::from_utf8(out.0).ok().map(String::into_boxed_str)
}

/// The error for a value nested deeper than [`MAX_DEPTH`].
fn too_deep() -> KdmError {
    KdmError::Encoding(format!("a value nests arrays and objects deeper than the encoding's {MAX_DEPTH} levels"))
}

/// One JSON value in the canonical form: keys in byte order, numbers by [`write_number`]. `depth`
/// is the nesting depth of the value when it is an array or an object.
fn write_value(out: &mut Out, value: &Value, depth: usize) -> Result<()> {
    match value {
        Value::Null => out.push(b"null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => write_number(out, number)?,
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            if depth > MAX_DEPTH {
                return Err(too_deep());
            }
            out.byte(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.byte(b',');
                }
                write_value(out, item, depth + 1)?;
            }
            out.byte(b']');
        }
        Value::Object(entries) => {
            if depth > MAX_DEPTH {
                return Err(too_deep());
            }
            let mut sorted: Vec<(&String, &Value)> = entries.iter().collect();
            sorted.sort_unstable_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            out.byte(b'{');
            for (index, (key, item)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    out.byte(b',');
                }
                write_string(out, key);
                out.byte(b':');
                write_value(out, item, depth + 1)?;
            }
            out.byte(b'}');
        }
    }
    Ok(())
}

/// An integer, refused beyond ±2^53.
fn write_integer(out: &mut Out, integer: i64) -> Result<()> {
    if integer.unsigned_abs() > MAX_SAFE_INTEGER {
        return Err(beyond(integer));
    }
    out.push_str(&integer.to_string());
    Ok(())
}

/// A number: an integer when whole and within ±2^53 (`-0` is `0`); an integer beyond is refused;
/// any other double by [`write_double`].
fn write_number(out: &mut Out, number: &Number) -> Result<()> {
    if let Some(integer) = number.as_i64() {
        return write_integer(out, integer);
    }
    if let Some(integer) = number.as_u64() {
        return Err(beyond(integer));
    }
    match number.as_f64() {
        Some(float) => write_float(out, float),
        None => Err(KdmError::Encoding(format!("the number {number} is not finite"))),
    }
}

/// A double: an integer when whole and within ±2^53, else [`write_double`].
fn write_float(out: &mut Out, float: f64) -> Result<()> {
    if !float.is_finite() {
        return Err(KdmError::Encoding(format!("the number {float} is not finite")));
    }
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
fn write_double(out: &mut Out, float: f64) {
    let scientific = format!("{:e}", float.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((scientific.as_str(), "0"));
    let exponent: i64 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let count = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    let point = exponent + 1;
    if float < 0.0 {
        out.byte(b'-');
    }
    if 0 <= point - count && point <= 16 {
        out.push_str(&digits);
        out.push_str(&"0".repeat(usize::try_from(point - count).unwrap_or(0)));
        out.push_str(".0");
    } else if 0 < point && point <= 16 {
        let (whole, fraction) = digits.split_at(usize::try_from(point).unwrap_or(0).min(digits.len()));
        out.push_str(whole);
        out.byte(b'.');
        out.push_str(fraction);
    } else if -5 < point && point <= 0 {
        out.push_str("0.");
        out.push_str(&"0".repeat(usize::try_from(-point).unwrap_or(0)));
        out.push_str(&digits);
    } else {
        let (first, rest) = digits.split_at(1.min(digits.len()));
        out.push_str(first);
        if !rest.is_empty() {
            out.byte(b'.');
            out.push_str(rest);
        }
        out.byte(b'e');
        out.push_str(&(point - 1).to_string());
    }
}

/// A string as serde_json writes it: `"` and `\` escaped, U+0000 to U+001F escaped (`\b`, `\f`,
/// `\n`, `\r`, `\t`, else `\u00xx`), everything else as itself. Runs without escapes are copied
/// whole.
fn write_string(out: &mut Out, text: &str) {
    out.byte(b'"');
    let bytes = text.as_bytes();
    let mut start = 0;
    for (at, byte) in bytes.iter().enumerate() {
        let escape: &[u8] = match byte {
            b'"' => b"\\\"",
            b'\\' => b"\\\\",
            0x08 => b"\\b",
            0x0C => b"\\f",
            b'\n' => b"\\n",
            b'\r' => b"\\r",
            b'\t' => b"\\t",
            0x00..=0x1F => b"",
            _ => continue,
        };
        out.push(bytes.get(start..at).unwrap_or_default());
        if escape.is_empty() {
            out.push_str(&format!("\\u{byte:04x}"));
        } else {
            out.push(escape);
        }
        start = at + 1;
    }
    out.push(bytes.get(start..).unwrap_or_default());
    out.byte(b'"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::op::Op;

    fn number(value: Value) -> String {
        let mut out = Out::default();
        let Value::Number(number) = value else { panic!("not a number") };
        write_number(&mut out, &number).unwrap();
        out.text()
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
        let mut out = Out::default();
        let Value::Number(big) = serde_json::json!(9_007_199_254_740_993u64) else { unreachable!() };
        assert!(write_number(&mut out, &big).is_err());
    }

    #[test]
    fn strings_escape_quotes_backslashes_and_controls_only() {
        let mut out = Out::default();
        write_string(&mut out, "a\"b\\c\n\t\u{1}\u{1f}\u{7f}/\u{2028}\u{e9}\u{1f600}");
        let out = out.text();
        assert_eq!(out, "\"a\\\"b\\\\c\\n\\t\\u0001\\u001f\u{7f}/\u{2028}\u{e9}\u{1f600}\"");
        // serde_json writes the same.
        assert_eq!(out, serde_json::to_string("a\"b\\c\n\t\u{1}\u{1f}\u{7f}/\u{2028}\u{e9}\u{1f600}").unwrap());
    }

    fn schema() -> Schema {
        Schema::parse(include_str!("../tests/fixtures/content/schema.json")).unwrap()
    }

    /// A store holding one page `p` with `fields`.
    fn one_page(fields: Value) -> Store {
        let schema = schema();
        let mut object = fields.as_object().cloned().unwrap();
        object.insert(TYPE_KEY.into(), Value::String("Page".into()));
        let mut store = Store::new(DocId::new(), "kit.content".into(), 1);
        let page = Object::from_content(&object, &schema).unwrap();
        store.apply(Op::Create { id: ObjectId::from_string("p"), object: Box::new(page), trees: Vec::new() }, &schema).unwrap();
        store
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
    fn write_refuses_integers_beyond_two_to_the_53_and_values_nested_too_deep() {
        assert!(matches!(write(&one_page(serde_json::json!({ "box": { "deep": [u64::MAX] } })), None), Err(KdmError::Encoding(_))));
        // A field's value sits at depth 4: 124 levels reach the limit, 125 pass it.
        let at_limit = write(&one_page(serde_json::json!({ "box": nested(MAX_DEPTH - FIELD_DEPTH + 1) })), None).unwrap();
        assert!(parse(&at_limit, "KDM content").is_ok(), "serde_json reads what the writer writes at the limit");
        assert!(matches!(write(&one_page(serde_json::json!({ "box": nested(MAX_DEPTH - FIELD_DEPTH + 2) })), None), Err(KdmError::Encoding(_))));
        // A field holding null is no field: the store drops it and the writer leaves it out.
        let mut store = one_page(serde_json::json!({ "name": "x" }));
        store.apply(Op::Set { id: ObjectId::from_string("p"), field: Name::from("kind"), value: Value::Null, was: Value::Null }, &schema()).unwrap();
        let written = String::from_utf8(write(&store, None).unwrap()).unwrap();
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

    #[test]
    fn read_refuses_a_key_written_twice_in_a_streamed_map_or_object() {
        let schema = schema();
        let file = |object: &str| {
            format!(
                "{{\"kdm\":1,\"kit\":\"kit.content\",\"docId\":\"0193a5c4-0000-7000-8000-000000000001\",\"schemaVersion\":2,\"objects\":{{\n{object}\n}}}}\n"
            )
        };
        let fine = file(r#""b":{"$type":"Board","title":"T","vars":{"a":1,"b":2}}"#);
        assert!(read(fine.as_bytes(), "KDM content", &schema).is_ok());
        for twice in [
            file(r#""b":{"$type":"Board","title":"T","vars":{"a":1,"a":2}}"#),
            file(r#""b":{"$type":"Board","title":"T","title":"U"}"#),
            file(r#""b":{"title":"T","$type":"Board","title":"U"}"#),
            file(r#""b":{"$type":"Board","$type":"Board","title":"T"}"#),
        ] {
            assert!(matches!(read(twice.as_bytes(), "KDM content", &schema), Err(KdmError::Encoding(_))), "{twice}");
        }
    }
}
