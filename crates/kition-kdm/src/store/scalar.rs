// Copied from kition-sdk crates/kition-kdm/src/store/scalar.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Compact values for the store (plan 2026-11-24, plain model, section 1.1): what a register or a
//! map entry holds, a map's keys, and a map's entries.
//!
//! A large document is mostly small values in maps: a table's 100,000 records each hold 50 cells
//! keyed by field id, a sheet holds a million cells keyed `<row id>:<column id>`. A JSON value
//! costs 32 bytes plus an allocation for each string, and a `String` key 24 bytes plus its text
//! (36 bytes for a UUID, repeated in every record). Here a value is 24 bytes and needs no
//! allocation of its own when it is a number, a boolean, a UUID or a string of up to
//! [`INLINE`] bytes; a key is 24 bytes and needs none when it is a UUID or short; a map of up to
//! [`SMALL`] entries is one sorted array of them. Each converts to and from its JSON value
//! exactly: `Scalar::from_value(value).to_value() == value`, and two values are equal exactly when
//! their JSON values are.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde_json::{Number, Value};
use uuid::Uuid;

use crate::ids::is_lower_uuid;

/// The longest string (in UTF-8 bytes) a value or key holds inline.
pub(crate) const INLINE: usize = 22;

/// The most entries a map holds as one sorted array; a larger one is a B-tree.
pub(crate) const SMALL: usize = 512;

/// The 16 bytes of a UUID in lowercase hyphenated form; `None` for any other text.
fn uuid_bytes(text: &str) -> Option<[u8; 16]> {
    if !is_lower_uuid(text.as_bytes()) {
        return None;
    }
    Uuid::parse_str(text).ok().map(Uuid::into_bytes)
}

/// A UUID's lowercase hyphenated form (of its 16 `bytes`), written into the 36 bytes of `out`.
fn uuid_text(bytes: &[u8], out: &mut [u8]) {
    if let Ok(uuid) = Uuid::from_slice(bytes) {
        let _ = uuid.hyphenated().encode_lower(out);
    }
}

/// Up to [`INLINE`] bytes of a string, zero-padded (so equal strings are equal values).
fn inline(text: &str) -> Option<(u8, [u8; INLINE])> {
    if text.len() > INLINE {
        return None;
    }
    let mut bytes = [0_u8; INLINE];
    bytes.get_mut(..text.len())?.copy_from_slice(text.as_bytes());
    Some((u8::try_from(text.len()).ok()?, bytes))
}

/// The 32 bytes of two UUIDs in lowercase hyphenated form joined by `:` (`<row id>:<column
/// id>`); `None` for any other text.
fn pair_bytes(text: &str) -> Option<[u8; 32]> {
    if text.len() != PAIR_LEN || text.as_bytes().get(36) != Some(&b':') {
        return None;
    }
    let (row, column) = (text.get(..36).and_then(uuid_bytes)?, text.get(37..).and_then(uuid_bytes)?);
    let mut both = [0_u8; 32];
    let (first, second) = both.split_at_mut(16);
    first.copy_from_slice(&row);
    second.copy_from_slice(&column);
    Some(both)
}

/// Calls `f` with the text of a pair ([`pair_bytes`]).
fn with_pair<R>(both: &[u8; 32], f: impl FnOnce(&str) -> R) -> R {
    let mut out = [0_u8; PAIR_LEN];
    let (row, column) = both.split_at(16);
    let (first, rest) = out.split_at_mut(36);
    let (colon, second) = rest.split_at_mut(1);
    uuid_text(row, first);
    colon.copy_from_slice(b":");
    uuid_text(column, second);
    f(std::str::from_utf8(&out).unwrap_or_default())
}

/// The longest text a [`Key`] or a [`Scalar`] holds without its own allocation for its text: a
/// pair of UUIDs and `:` (32 bytes).
const PAIR_LEN: usize = 73;

/// The string an inline value holds.
fn inline_str(len: u8, bytes: &[u8; INLINE]) -> &str {
    // Copied from a `str` ([`inline`]), so always UTF-8.
    bytes.get(..usize::from(len)).and_then(|bytes| std::str::from_utf8(bytes).ok()).unwrap_or_default()
}

/// A register's or a map entry's value.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Scalar {
    Null,
    Bool(bool),
    /// An integer that fits an `i64`.
    Int(i64),
    /// A positive integer beyond `i64`.
    Big(u64),
    /// A number that is not an integer (as JSON reads it: `5.0` written by a kit stays a double).
    Float(f64),
    /// A string of up to [`INLINE`] bytes that is not a UUID.
    Short {
        len: u8,
        bytes: [u8; INLINE],
    },
    /// A string that is a UUID in lowercase hyphenated form, as its 16 bytes.
    Uuid([u8; 16]),
    /// A string that is two of them joined by `:` (a sheet's `<row id>:<column id>`), as their 32
    /// bytes.
    Pair(Box<[u8; 32]>),
    /// Any other string.
    Str(Box<str>),
    /// An array or an object, as its text in the content encoding (data model 7.4: keys in byte
    /// order, numbers in their canonical form), which a save copies and a read parses: a fraction
    /// of what its JSON value holds (an object of three keys is a B-tree node of eleven).
    Json(Box<str>),
    /// An array or an object the content encoding refuses (an integer beyond ±2^53, nesting too
    /// deep), as its JSON value: a save refuses it then.
    Deep(Box<Value>),
}

impl Scalar {
    pub(crate) fn from_value(value: Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Bool(flag) => Self::Bool(flag),
            Value::Number(number) => Self::from_number(&number),
            Value::String(text) => Self::from_string(text),
            other => match crate::content::json_text(&other) {
                Some(text) => Self::Json(text),
                None => Self::Deep(Box::new(other)),
            },
        }
    }

    pub(crate) fn from_number(number: &Number) -> Self {
        if let Some(integer) = number.as_i64() {
            return Self::Int(integer);
        }
        if let Some(integer) = number.as_u64() {
            return Self::Big(integer);
        }
        Self::Float(number.as_f64().unwrap_or_default())
    }

    /// A string held without its own copy of the text: `None` unless it is short, a UUID or a pair.
    fn compact(text: &str) -> Option<Self> {
        if let Some(bytes) = uuid_bytes(text) {
            return Some(Self::Uuid(bytes));
        }
        if let Some(both) = pair_bytes(text) {
            return Some(Self::Pair(Box::new(both)));
        }
        inline(text).map(|(len, bytes)| Self::Short { len, bytes })
    }

    /// A string held as [`Scalar::from_string`] holds it, without taking ownership.
    pub(crate) fn of_str(text: &str) -> Self {
        Self::compact(text).unwrap_or_else(|| Self::Str(text.into()))
    }

    pub(crate) fn from_string(text: String) -> Self {
        Self::compact(&text).unwrap_or_else(|| Self::Str(text.into_boxed_str()))
    }

    pub(crate) fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }

    /// The value as JSON.
    pub(crate) fn to_value(&self) -> Value {
        match self {
            Self::Null => Value::Null,
            Self::Bool(flag) => Value::Bool(*flag),
            Self::Int(integer) => Value::from(*integer),
            Self::Big(integer) => Value::from(*integer),
            Self::Float(float) => Number::from_f64(*float).map_or(Value::Null, Value::Number),
            Self::Short { .. } | Self::Uuid(_) | Self::Pair(_) | Self::Str(_) => Value::String(self.with_str(|text| text.unwrap_or_default().to_owned())),
            Self::Json(text) => serde_json::from_str(text).unwrap_or(Value::Null),
            Self::Deep(value) => (**value).clone(),
        }
    }

    /// Calls `f` with the string the value holds, `None` when it is not a string.
    pub(crate) fn with_str<R>(&self, f: impl FnOnce(Option<&str>) -> R) -> R {
        match self {
            Self::Short { len, bytes } => f(Some(inline_str(*len, bytes))),
            Self::Uuid(bytes) => {
                let mut text = [0_u8; 36];
                uuid_text(bytes, &mut text);
                f(std::str::from_utf8(&text).ok())
            }
            Self::Pair(both) => with_pair(both, |text| f(Some(text))),
            Self::Str(text) => f(Some(text)),
            _ => f(None),
        }
    }

    /// Whether the value is `value` (as [`Scalar::to_value`] would answer, without building it).
    pub(crate) fn is(&self, value: &Value) -> bool {
        match (self, value) {
            (Self::Null, Value::Null) => true,
            (Self::Bool(a), Value::Bool(b)) => a == b,
            (Self::Int(_) | Self::Big(_) | Self::Float(_), Value::Number(number)) => *self == Self::from_number(number),
            (Self::Short { .. } | Self::Uuid(_) | Self::Pair(_) | Self::Str(_), Value::String(text)) => self.with_str(|held| held == Some(text.as_str())),
            (Self::Json(held), Value::Array(_) | Value::Object(_)) => serde_json::from_str::<Value>(held).is_ok_and(|held| held == *value),
            (Self::Deep(held), _) => **held == *value,
            _ => false,
        }
    }
}

/// A map's key: text, ordered by its UTF-8 bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Key {
    /// A UUID in lowercase hyphenated form, as its 16 bytes.
    Uuid([u8; 16]),
    /// Two of them joined by `:` (`<row id>:<column id>`), as their 32 bytes.
    Pair(Box<[u8; 32]>),
    /// Up to [`INLINE`] bytes of any other text.
    Short {
        len: u8,
        bytes: [u8; INLINE],
    },
    Text(Box<str>),
}

impl Key {
    pub(crate) fn new(text: &str) -> Self {
        if let Some(bytes) = uuid_bytes(text) {
            return Self::Uuid(bytes);
        }
        if let Some(both) = pair_bytes(text) {
            return Self::Pair(Box::new(both));
        }
        match inline(text) {
            Some((len, bytes)) => Self::Short { len, bytes },
            None => Self::Text(text.into()),
        }
    }

    /// Calls `f` with the key's text.
    pub(crate) fn with_str<R>(&self, f: impl FnOnce(&str) -> R) -> R {
        match self {
            Self::Uuid(bytes) => {
                let mut text = [0_u8; 36];
                uuid_text(bytes, &mut text);
                f(std::str::from_utf8(&text).unwrap_or_default())
            }
            Self::Pair(both) => with_pair(both, f),
            Self::Short { len, bytes } => f(inline_str(*len, bytes)),
            Self::Text(text) => f(text),
        }
    }

    pub(crate) fn to_text(&self) -> String {
        self.with_str(str::to_owned)
    }
}

impl PartialOrd for Key {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// By the keys' UTF-8 bytes. A UUID's lowercase hex digits sort as its bytes do and its hyphens
/// stand at the same places, so two UUIDs (or two pairs) compare by their bytes.
impl Ord for Key {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Uuid(a), Self::Uuid(b)) => a.cmp(b),
            (Self::Pair(a), Self::Pair(b)) => a.cmp(b),
            (Self::Short { len: a, bytes: x }, Self::Short { len: b, bytes: y }) => inline_str(*a, x).cmp(inline_str(*b, y)),
            (Self::Text(a), Self::Text(b)) => a.cmp(b),
            _ => self.with_str(|a| other.with_str(|b| a.as_bytes().cmp(b.as_bytes()))),
        }
    }
}

/// A map field's entries, sorted by key: one sorted array up to [`SMALL`] entries, a B-tree beyond.
#[derive(Clone, Debug)]
pub(crate) enum Entries {
    Small(Vec<(Key, Scalar)>),
    Large(BTreeMap<Key, Scalar>),
}

impl Default for Entries {
    fn default() -> Self {
        Self::Small(Vec::new())
    }
}

impl PartialEq for Entries {
    /// Entries are equal when they hold the same keys and values, however they are held.
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().eq(other.iter())
    }
}

impl Entries {
    /// Entries from pairs sorted by key, each key once.
    pub(crate) fn from_sorted(mut entries: Vec<(Key, Scalar)>) -> Self {
        if entries.len() <= SMALL {
            entries.shrink_to_fit();
            Self::Small(entries)
        } else {
            Self::Large(entries.into_iter().collect())
        }
    }

    pub(crate) fn len(&self) -> usize {
        match self {
            Self::Small(entries) => entries.len(),
            Self::Large(entries) => entries.len(),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub(crate) fn get(&self, key: &Key) -> Option<&Scalar> {
        match self {
            Self::Small(entries) => entries.binary_search_by(|(held, _)| held.cmp(key)).ok().and_then(|at| entries.get(at)).map(|(_, value)| value),
            Self::Large(entries) => entries.get(key),
        }
    }

    /// The value of the key `key` names.
    pub(crate) fn get_text(&self, key: &str) -> Option<&Scalar> {
        self.get(&Key::new(key))
    }

    /// Sets `key`; answers the value it replaced.
    pub(crate) fn insert(&mut self, key: Key, value: Scalar) -> Option<Scalar> {
        match self {
            Self::Small(entries) => match entries.binary_search_by(|(held, _)| held.cmp(&key)) {
                Ok(at) => entries.get_mut(at).map(|(_, held)| std::mem::replace(held, value)),
                Err(at) => {
                    entries.insert(at, (key, value));
                    if entries.len() > SMALL {
                        *self = Self::Large(std::mem::take(entries).into_iter().collect());
                    }
                    None
                }
            },
            Self::Large(entries) => entries.insert(key, value),
        }
    }

    /// Removes `key`; answers the value it held.
    pub(crate) fn remove(&mut self, key: &Key) -> Option<Scalar> {
        match self {
            Self::Small(entries) => {
                let at = entries.binary_search_by(|(held, _)| held.cmp(key)).ok()?;
                Some(entries.remove(at).1)
            }
            Self::Large(entries) => entries.remove(key),
        }
    }

    /// The entries in key order.
    pub(crate) fn iter(&self) -> Iter<'_> {
        match self {
            Self::Small(entries) => Iter::Small(entries.iter()),
            Self::Large(entries) => Iter::Large(entries.iter()),
        }
    }

    /// Each value, to change in place (keys stay).
    pub(crate) fn values_mut(&mut self) -> Box<dyn Iterator<Item = &mut Scalar> + '_> {
        match self {
            Self::Small(entries) => Box::new(entries.iter_mut().map(|(_, value)| value)),
            Self::Large(entries) => Box::new(entries.values_mut()),
        }
    }
}

/// [`Entries::iter`].
pub(crate) enum Iter<'a> {
    Small(std::slice::Iter<'a, (Key, Scalar)>),
    Large(std::collections::btree_map::Iter<'a, Key, Scalar>),
}

impl<'a> Iterator for Iter<'a> {
    type Item = (&'a Key, &'a Scalar);

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Small(entries) => entries.next().map(|(key, value)| (key, value)),
            Self::Large(entries) => entries.next(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn values_and_keys_are_small() {
        // 64-bit targets; on wasm32 they are smaller still.
        if cfg!(target_pointer_width = "64") {
            assert_eq!(std::mem::size_of::<Scalar>(), 24);
            assert_eq!(std::mem::size_of::<Key>(), 24);
            assert_eq!(std::mem::size_of::<crate::ObjectId>(), 40);
            // A field is a value, or a box: an object's fields cost 24 bytes each.
            assert_eq!(std::mem::size_of::<crate::store::Field>(), 24);
        }
    }

    #[test]
    fn a_value_converts_to_and_from_json_exactly() {
        let uuid = "0193a5c4-0000-7000-8000-0000000000a1";
        for value in [
            json!(null),
            json!(true),
            json!(0),
            json!(-7),
            json!(9_007_199_254_740_993_u64),
            json!(u64::MAX),
            json!(i64::MIN),
            json!(0.5),
            json!(-2.5e-10),
            json!(5.0),
            json!(""),
            json!("short"),
            json!("exactly twenty-two by"),
            json!("twenty-three bytes long"),
            json!(&*format!("{} alpha", [0x9879, 0x76ee, 0x8fdb, 0x5ea6].into_iter().filter_map(char::from_u32).collect::<String>())),
            json!(uuid),
            json!(uuid.to_uppercase()),
            json!(format!("{uuid}:{uuid}")),
            json!([1, "two", { "three": 3 }]),
            json!({ "a": [] }),
            json!([u64::MAX, { "b": -0.25 }]),
        ] {
            let scalar = Scalar::from_value(value.clone());
            assert_eq!(scalar.to_value(), value, "{value}");
            assert!(scalar.is(&value), "{value}");
            assert_eq!(Scalar::of_str(value.as_str().unwrap_or("x")), Scalar::from_string(value.as_str().unwrap_or("x").to_owned()));
        }
        assert!(matches!(Scalar::from_value(json!(uuid)), Scalar::Uuid(_)));
        assert!(matches!(Scalar::from_value(json!("short")), Scalar::Short { .. }));
        assert!(matches!(Scalar::from_value(json!(format!("{uuid}:{uuid}"))), Scalar::Pair(_)));
        // An array or object is held as its text in the encoding, unless the encoding refuses it.
        let Scalar::Json(text) = Scalar::from_value(json!({ "size": 3, "hash": "x", "list": [0.5, 1e21] })) else { panic!("not text") };
        assert_eq!(&*text, r#"{"hash":"x","list":[0.5,1e21],"size":3}"#);
        assert!(matches!(Scalar::from_value(json!([u64::MAX])), Scalar::Deep(_)));
        assert!(!Scalar::from_value(json!(5)).is(&json!(5.0)), "JSON tells 5 from 5.0");
        assert!(!Scalar::from_value(json!("5")).is(&json!(5)));
    }

    #[test]
    fn keys_keep_their_text_and_sort_by_its_bytes() {
        let a = "0193a5c4-0000-7000-8000-0000000000a1";
        let b = "0193a5c4-0000-7000-8000-0000000000b2";
        let texts = [
            String::new(),
            "k1".into(),
            "k10".into(),
            "k2".into(),
            a.into(),
            format!("{a}:{b}"),
            format!("{a}:{a}"),
            format!("{a}x"),
            b.into(),
            format!("{b}:{a}"),
            a.to_uppercase(),
            "\u{ff5a}".into(),
            "\u{1f600}".into(),
            "a key that is longer than twenty-two bytes".into(),
        ];
        let mut keys: Vec<Key> = texts.iter().map(|text| Key::new(text)).collect();
        for (key, text) in keys.iter().zip(&texts) {
            assert_eq!(&key.to_text(), text);
        }
        assert!(matches!(Key::new(a), Key::Uuid(_)) && matches!(Key::new(&format!("{a}:{b}")), Key::Pair(_)));
        keys.sort();
        let mut sorted = texts.to_vec();
        sorted.sort_by(|x, y| x.as_bytes().cmp(y.as_bytes()));
        assert_eq!(keys.iter().map(Key::to_text).collect::<Vec<_>>(), sorted);
    }

    #[test]
    fn entries_stay_sorted_small_or_large() {
        let mut small = Entries::default();
        let mut large = Entries::default();
        for n in (0..2 * SMALL).rev() {
            assert!(large.insert(Key::new(&format!("k{n:05}")), Scalar::Int(i64::try_from(n).unwrap_or_default())).is_none());
        }
        assert!(matches!(large, Entries::Large(_)));
        for n in 0..SMALL {
            small.insert(Key::new(&format!("k{n:05}")), Scalar::Int(0));
        }
        assert!(matches!(small, Entries::Small(_)));
        let keys: Vec<String> = large.iter().map(|(key, _)| key.to_text()).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted);
        assert_eq!(large.insert(Key::new("k00003"), Scalar::Int(9)), Some(Scalar::Int(3)));
        assert_eq!(large.remove(&Key::new("k00003")), Some(Scalar::Int(9)));
        assert_eq!(large.get_text("k00004"), Some(&Scalar::Int(4)));
        // Equal entries compare equal however they are held.
        let mut shrunk = large.clone();
        for n in SMALL..2 * SMALL {
            shrunk.remove(&Key::new(&format!("k{n:05}")));
        }
        let mut fresh = Entries::default();
        for n in (0..SMALL).filter(|n| *n != 3) {
            fresh.insert(Key::new(&format!("k{n:05}")), Scalar::Int(i64::try_from(n).unwrap_or_default()));
        }
        assert_eq!(shrunk, fresh);
    }
}
