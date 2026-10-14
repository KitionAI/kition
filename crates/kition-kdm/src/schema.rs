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
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TypeDef {
    pub fields: BTreeMap<String, FieldDef>,
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
        for (ty, def) in &self.types {
            if ty.starts_with('$') {
                return Err(KdmError::Schema(format!("type `{ty}`: names starting with `$` are reserved")));
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
            }
        }
        Ok(())
    }

    pub fn type_def(&self, ty: &str) -> Result<&TypeDef> {
        self.types.get(ty).ok_or_else(|| KdmError::UnknownType(ty.to_owned()))
    }

    pub fn field(&self, ty: &str, field: &str) -> Result<&FieldDef> {
        self.type_def(ty)?.fields.get(field).ok_or_else(|| KdmError::UnknownField { ty: ty.to_owned(), field: field.to_owned() })
    }

    /// Checks a value for a register field. Container fields take no value; use their operations.
    pub fn check_value(&self, ty: &str, field: &str, value: &Value) -> Result<()> {
        let def = self.field(ty, field)?;
        let invalid = |reason: String| KdmError::InvalidValue { ty: ty.to_owned(), field: field.to_owned(), reason };
        if def.kind.is_container() {
            return Err(invalid("is a container; use its operations".into()));
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
