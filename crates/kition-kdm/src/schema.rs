// Copied from kition-sdk crates/kition-kdm/src/schema.rs by scripts/sync-kit-host.mjs; change it there, not here.
use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use crate::{KdmError, Result};

/// The KDM schema format version this build reads.
pub const KDM_VERSION: u32 = 1;

/// The largest integer magnitude an `integer` field holds: every KDM implementation, including
/// JavaScript's doubles, represents integers up to ±2^53 exactly.
const MAX_SAFE_INTEGER: u64 = 1 << 53;

/// What a field holds. Registers hold one value (last writer wins); containers merge their
/// contents (text characters, list items, tree nodes).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum FieldKind {
    String,
    Number,
    /// A whole number within ±2^53.
    Integer,
    Boolean,
    Enum,
    /// Any JSON value, replaced as a whole: use it for coupled values (a transform).
    Json,
    /// `{ "hash": "<sha256 hex>", "mime": "...", "size": n }`.
    Blob,
    /// The id of another object of type `of`.
    Ref,
    Text,
    /// An ordered list of ids of objects of type `of`, with moves.
    List,
    /// A movable tree whose nodes name objects of type `of`.
    Tree,
    /// String keys to JSON values; each key is its own register (sheet cells by row and column).
    Map,
}

impl FieldKind {
    pub fn is_container(self) -> bool {
        matches!(self, Self::Text | Self::List | Self::Tree | Self::Map)
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldDef {
    pub kind: FieldKind,
    #[serde(default)]
    pub of: Option<String>,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub optional: bool,
    /// The marks a `text` field takes (rich-text run properties), by key. A field without marks
    /// reads as a plain string in the canonical state; one with marks reads as its runs.
    #[serde(default)]
    pub marks: BTreeMap<String, MarkDef>,
    /// Content the kit keeps verbatim but does not model (rule OM8): the object model reads the
    /// field and never writes it. The kit's own transactions and commands still do.
    #[serde(default, rename = "readOnly")]
    pub read_only: bool,
}

impl FieldDef {
    /// Whether this is a `text` field that declares marks.
    pub fn has_marks(&self) -> bool {
        self.kind == FieldKind::Text && !self.marks.is_empty()
    }
}

/// How a mark grows when text is inserted at one of its ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Expand {
    /// Text typed right after the marked range takes the mark (bold, italic).
    After,
    /// Text typed right before the marked range takes the mark.
    Before,
    /// Text typed at either end takes the mark.
    Both,
    /// Text typed at either end does not take the mark (links, object anchors).
    None,
}

impl Expand {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::After => "after",
            Self::Before => "before",
            Self::Both => "both",
            Self::None => "none",
        }
    }
}

/// One mark a `text` field declares: `{ "expand": "after" | "before" | "both" | "none" }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkDef {
    pub expand: Expand,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TypeDef {
    pub fields: BTreeMap<String, FieldDef>,
    /// Every object of the type is read-only through the object model (rule OM8): content the
    /// kit preserves without modelling it.
    #[serde(default, rename = "readOnly")]
    pub read_only: bool,
    /// The objects of the type whose enum field holds one of `values` are read-only through the
    /// object model (rule OM8), such as a shape of kind `opaque`.
    #[serde(default, rename = "readOnlyWhen")]
    pub read_only_when: Option<ReadOnlyWhen>,
}

/// `{ "field": "<an enum field of the type>", "values": [...] }`: the objects holding one of the
/// values in the field are read-only through the object model.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadOnlyWhen {
    pub field: String,
    pub values: Vec<String>,
}

impl TypeDef {
    /// Whether the object model may write an object of this type whose fields read `field`.
    /// `field` answers a register's value (for [`ReadOnlyWhen`]).
    pub fn object_read_only(&self, field: impl FnOnce(&str) -> Option<Value>) -> bool {
        if self.read_only {
            return true;
        }
        self.read_only_when
            .as_ref()
            .is_some_and(|when| field(&when.field).as_ref().and_then(Value::as_str).is_some_and(|value| when.values.iter().any(|kept| kept == value)))
    }
}

/// A kit's document schema (`model/schema.json` in its package). Built only by [`Schema::parse`]
/// or by deserializing one with serde, and both check it; its fields are readable.
///
/// ```compile_fail
/// let schema = kition_kdm::Schema { kdm: 1, kit: "k".into(), schema_version: 1, root: "A".into(), types: Default::default() };
/// ```
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(try_from = "RawSchema")]
#[non_exhaustive]
pub struct Schema {
    pub kdm: u32,
    pub kit: String,
    pub schema_version: u32,
    pub root: String,
    pub types: BTreeMap<String, TypeDef>,
}

/// The schema file as written, before [`Schema::check`].
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawSchema {
    kdm: u32,
    kit: String,
    schema_version: u32,
    root: String,
    types: BTreeMap<String, TypeDef>,
}

impl TryFrom<RawSchema> for Schema {
    type Error = KdmError;

    fn try_from(raw: RawSchema) -> Result<Self> {
        let schema = Schema { kdm: raw.kdm, kit: raw.kit, schema_version: raw.schema_version, root: raw.root, types: raw.types };
        schema.check()?;
        Ok(schema)
    }
}

impl Schema {
    pub fn parse(json: &str) -> Result<Self> {
        let raw: RawSchema = serde_json::from_str(json).map_err(|error| KdmError::Schema(error.to_string()))?;
        Schema::try_from(raw)
    }

    fn check(&self) -> Result<()> {
        if self.kdm != KDM_VERSION {
            return Err(KdmError::Schema(format!("kdm {} is not supported; this build reads {KDM_VERSION}", self.kdm)));
        }
        if !self.types.contains_key(&self.root) {
            return Err(KdmError::Schema(format!("root type `{}` is not declared", self.root)));
        }
        let mut expands: BTreeMap<&str, Expand> = BTreeMap::new();
        for (ty, def) in &self.types {
            if ty.starts_with('$') {
                return Err(KdmError::Schema(format!("type `{ty}`: names starting with `$` are reserved")));
            }
            if let Some(when) = &def.read_only_when {
                if def.read_only {
                    return Err(KdmError::Schema(format!("type `{ty}`: `readOnly` and `readOnlyWhen` exclude each other")));
                }
                let Some(field) = def.fields.get(&when.field) else {
                    return Err(KdmError::Schema(format!("type `{ty}`: `readOnlyWhen` names undeclared field `{}`", when.field)));
                };
                if field.kind != FieldKind::Enum {
                    return Err(KdmError::Schema(format!("type `{ty}`: `readOnlyWhen` names `{}`, which is not an enum", when.field)));
                }
                if when.values.is_empty() {
                    return Err(KdmError::Schema(format!("type `{ty}`: `readOnlyWhen` needs `values`")));
                }
                if let Some(value) = when.values.iter().find(|value| !field.values.contains(value)) {
                    return Err(KdmError::Schema(format!("type `{ty}`: `readOnlyWhen` value `{value}` is not a value of `{ty}.{}`", when.field)));
                }
            }
            for (name, field) in &def.fields {
                if name.starts_with('$') {
                    return Err(KdmError::Schema(format!("`{ty}.{name}`: names starting with `$` are reserved")));
                }
                let takes_of = matches!(field.kind, FieldKind::Ref | FieldKind::List | FieldKind::Tree);
                if field.of.is_some() && !takes_of {
                    return Err(KdmError::Schema(format!("`{ty}.{name}`: only ref, list, and tree fields take `of`")));
                }
                if !field.values.is_empty() && field.kind != FieldKind::Enum {
                    return Err(KdmError::Schema(format!("`{ty}.{name}`: only enum fields take `values`")));
                }
                match field.kind {
                    FieldKind::Enum if field.values.is_empty() => {
                        return Err(KdmError::Schema(format!("`{ty}.{name}`: an enum needs `values`")));
                    }
                    FieldKind::Ref | FieldKind::List | FieldKind::Tree => match &field.of {
                        Some(of) if self.types.contains_key(of) => {}
                        Some(of) => return Err(KdmError::Schema(format!("`{ty}.{name}` refers to undeclared type `{of}`"))),
                        None => return Err(KdmError::Schema(format!("`{ty}.{name}` needs `of`"))),
                    },
                    _ => {}
                }
                if !field.marks.is_empty() && field.kind != FieldKind::Text {
                    return Err(KdmError::Schema(format!("`{ty}.{name}`: only text fields take `marks`")));
                }
                for (key, mark) in &field.marks {
                    if let Some(reason) = bad_mark_key(key) {
                        return Err(KdmError::Schema(format!("`{ty}.{name}` mark `{key}`: {reason}")));
                    }
                    match expands.get(key.as_str()) {
                        Some(&other) if other != mark.expand => {
                            return Err(KdmError::Schema(format!(
                                "`{ty}.{name}` mark `{key}` expands `{}`, but it is declared elsewhere expanding `{}`; a mark key has one expand in a schema",
                                mark.expand.as_str(),
                                other.as_str()
                            )));
                        }
                        _ => {
                            expands.insert(key.as_str(), mark.expand);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Every mark key the schema declares with its expand: each key has one expand in a schema.
    pub fn mark_expands(&self) -> BTreeMap<&str, Expand> {
        let mut out = BTreeMap::new();
        for def in self.types.values() {
            for field in def.fields.values() {
                for (key, mark) in &field.marks {
                    out.insert(key.as_str(), mark.expand);
                }
            }
        }
        out
    }

    pub fn type_def(&self, ty: &str) -> Result<&TypeDef> {
        self.types.get(ty).ok_or_else(|| KdmError::UnknownType(ty.to_owned()))
    }

    pub fn field(&self, ty: &str, field: &str) -> Result<&FieldDef> {
        self.type_def(ty)?.fields.get(field).ok_or_else(|| self.unknown_field(ty, field))
    }

    /// The error for `field`, which `ty` does not have, naming the fields it has.
    pub fn unknown_field(&self, ty: &str, field: &str) -> KdmError {
        let names: Vec<&str> = self.types.get(ty).map(|def| def.fields.keys().map(String::as_str).collect()).unwrap_or_default();
        let mut hint = String::new();
        if field.contains('.') || field.contains('/') {
            hint.push_str("; a field is one name, not a path: load the nested object and set its own fields");
        }
        if !names.is_empty() {
            let shown: Vec<&str> = names.iter().copied().take(40).collect();
            hint.push_str(&format!("; its fields: {}{}", shown.join(", "), if names.len() > shown.len() { ", …" } else { "" }));
        }
        KdmError::UnknownField { ty: ty.to_owned(), field: field.to_owned(), hint }
    }

    /// Checks a value for a register field. Container fields take no value; use their operations.
    pub fn check_value(&self, ty: &str, field: &str, value: &Value) -> Result<()> {
        let def = self.field(ty, field)?;
        let invalid = |reason: String| KdmError::InvalidValue { ty: ty.to_owned(), field: field.to_owned(), reason };
        if def.kind.is_container() {
            let ops = match def.kind {
                FieldKind::Text => "text.insert, text.delete, text.set, text.mark, text.unmark",
                FieldKind::List => "list.insert, list.move, list.remove",
                FieldKind::Tree => "tree.insert, tree.move",
                FieldKind::Map => "map.set, map.delete",
                _ => "its operations",
            };
            return Err(invalid(format!("is a container, not a value: change it with {ops}, or set the fields of the objects it holds")));
        }
        if value.is_null() {
            return if def.optional { Ok(()) } else { Err(invalid("is required".into())) };
        }
        if let Some(reason) = unportable(value) {
            return Err(invalid(reason.into()));
        }
        let ok = match def.kind {
            FieldKind::String | FieldKind::Ref => value.is_string(),
            FieldKind::Number => value.is_number(),
            FieldKind::Integer => value.as_i64().is_some_and(|integer| integer.unsigned_abs() <= MAX_SAFE_INTEGER),
            FieldKind::Boolean => value.is_boolean(),
            FieldKind::Enum => value.as_str().is_some_and(|text| def.values.iter().any(|allowed| allowed == text)),
            FieldKind::Json => true,
            FieldKind::Blob => {
                value.get("hash").is_some_and(Value::is_string)
                    && value.get("mime").is_some_and(Value::is_string)
                    && value.get("size").is_some_and(Value::is_u64)
            }
            FieldKind::Text | FieldKind::List | FieldKind::Tree | FieldKind::Map => false,
        };
        if ok { Ok(()) } else { Err(invalid(format!("expects a {:?} value", def.kind).to_lowercase())) }
    }
}

/// Why `key` cannot name a mark, or `None` when it can. The engine reserves `:` in style keys, and
/// a `__proto__` attribute is lost by the TypeScript engine's reads.
fn bad_mark_key(key: &str) -> Option<&'static str> {
    if key.is_empty() {
        Some("a mark key is not empty")
    } else if key.starts_with('$') {
        Some("names starting with `$` are reserved")
    } else if key.contains(':') {
        Some("a mark key holds no `:`")
    } else if key == "__proto__" {
        Some("`__proto__` is not a mark key")
    } else {
        None
    }
}

/// Why `value` cannot enter a document, or `None` when every implementation reads it back exactly.
///
/// An integer beyond ±2^53, at any depth, would reach JavaScript implementations rounded; whole
/// doubles of any size are fine, as every implementation reads a double exactly. A `__proto__`
/// key, at any depth, is lost by the TypeScript engine's reads (assigning it changes a prototype).
pub(crate) fn unportable(value: &Value) -> Option<&'static str> {
    match value {
        Value::Number(number) => {
            let exact = match (number.as_i64(), number.as_u64()) {
                (Some(integer), _) => integer.unsigned_abs() <= MAX_SAFE_INTEGER,
                (None, Some(integer)) => integer <= MAX_SAFE_INTEGER,
                (None, None) => true,
            };
            (!exact).then_some("holds an integer beyond ±2^53, which not every implementation reads exactly")
        }
        Value::Array(items) => items.iter().find_map(unportable),
        Value::Object(fields) => {
            if fields.contains_key("__proto__") {
                return Some("holds a `__proto__` key, which not every implementation reads");
            }
            fields.values().find_map(unportable)
        }
        _ => None,
    }
}
