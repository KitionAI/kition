// Copied from kition-sdk crates/kition-kdm/src/schema.rs by scripts/sync-kit-host.mjs; change it there, not here.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
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
    /// The field's wording in generated instructions (a boolean's positive state).
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub minimum: Option<serde_json::Number>,
    #[serde(default)]
    pub maximum: Option<serde_json::Number>,
    #[serde(default, rename = "multipleOf")]
    pub multiple_of: Option<serde_json::Number>,
    /// Numeric limits at JSON paths (`a.b`, `a[]`, `a[].b`). Scalar leaves require numbers.
    #[serde(default)]
    pub members: BTreeMap<String, NumberLimits>,
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
    /// A `ref` field whose object is part of the object holding it (a shape's text body), as the
    /// items of a `list` or `tree` field always are; a ref without it only points (a picture's
    /// shared media). A `map` field declared `owns` holds, under each key, the objects its value
    /// names ([`FieldDef::map_held`]): a table's cells, each value naming the cell's text body. Change sets attribute a change of an object without a tool id to the
    /// nearest object holding it, through `list` and `tree` fields and the refs and maps that own
    /// ([`crate::diff::StateDiff::with_tool_ids`]).
    #[serde(default)]
    pub owns: bool,
    /// Batch deletion of a node in this tree also deletes its descendants, child-first.
    #[serde(default)]
    pub cascade: bool,
    /// A field that says where its object is rather than what it is: a clip's `start` and
    /// `duration` on its track, a row's index. Agent tools treat its change as a move of the
    /// object (`relocated`), never as a change of its content, and a command declared
    /// position-independent is not refused for it.
    #[serde(default)]
    pub position: bool,
    /// How a person reads the field's value: `{ "kind": "time", "perSecond": <units in
    /// a second>, "fps"?: <frames a second> }` shows a tick count as a timecode (`00:00:05:00`,
    /// with `fps`) or a clock time (`00:00:05.000`). Training environments (`kition-env`) word
    /// their instructions with it; values in change sets and scores stay as stored.
    #[serde(default)]
    pub display: Option<Display>,
    /// Whether a training environment (`kition-env`) may sample an edit of the field:
    /// `false` for a field whose write is not what it says (an item's `kind`, whose change remakes
    /// the item). Every field may be when left out.
    #[serde(default)]
    pub sample: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct NumberLimits {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub nullable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum: Option<serde_json::Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum: Option<serde_json::Number>,
    #[serde(default, rename = "multipleOf", skip_serializing_if = "Option::is_none")]
    pub multiple_of: Option<serde_json::Number>,
}

/// How a person reads a field's value ([`FieldDef::display`]).
#[derive(Clone, Debug, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Display {
    /// `time`: a count of `per_second` units a second.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_second: Option<serde_json::Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<serde_json::Number>,
}

impl FieldDef {
    /// Whether the objects the field holds are parts of its object: a `list` or `tree` field, or a
    /// `ref` or `map` declared `owns`.
    pub fn owning(&self) -> bool {
        matches!(self.kind, FieldKind::List | FieldKind::Tree) || (matches!(self.kind, FieldKind::Ref | FieldKind::Map) && self.owns)
    }

    /// The objects a `map` field's value `map` holds when it owns them, each with its place in the
    /// map: the value under a key when it is a string naming an object (place `<key>`), else each
    /// member of an object value that is one (`<key>.<member>`), keys and members in order.
    /// `exists` answers whether an id names an object of the document.
    pub fn map_held(map: &Value, exists: impl Fn(&str) -> bool) -> Vec<(String, String)> {
        let names = |value: &Value| value.as_str().filter(|id| !id.is_empty() && exists(id)).map(str::to_owned);
        let mut out = Vec::new();
        let Some(entries) = map.as_object() else { return out };
        let mut keys: Vec<(&String, &Value)> = entries.iter().collect();
        keys.sort_by(|a, b| a.0.cmp(b.0));
        for (key, value) in keys {
            if let Some(id) = names(value) {
                out.push((id, key.clone()));
            } else if let Some(members) = value.as_object() {
                let mut members: Vec<(&String, &Value)> = members.iter().collect();
                members.sort_by(|a, b| a.0.cmp(b.0));
                for (member, value) in members {
                    if let Some(id) = names(value) {
                        out.push((id, format!("{key}.{member}")));
                    }
                }
            }
        }
        out
    }

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

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StructuralConsequence {
    pub container: String,
    pub on: Vec<String>,
    pub fields: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TypeDef {
    pub fields: BTreeMap<String, FieldDef>,
    /// Computed by the kit for each document state, never created in a replica.
    #[serde(default)]
    pub projected: bool,
    /// Object-model operations routed through kit commands. A key may include a field (`set.text`).
    #[serde(default, rename = "projectedOps")]
    pub projected_ops: BTreeMap<String, ProjectedCommand>,
    /// Premise contract for stored batch operations, keyed by operation or operation.field.
    #[serde(default, rename = "batchOps")]
    pub batch_ops: BTreeMap<String, BatchOperation>,
    /// A valid creation seed and, optionally, a kit command that ingests its fixture bytes.
    #[serde(default)]
    pub creation: Option<Creation>,
    /// Position field paths regenerated by a move, including on owned descendants.
    #[serde(default, rename = "moveConsequences")]
    pub move_consequences: Vec<String>,
    /// Stored field consequences of an edit within a particular ancestor/container instance.
    #[serde(default, rename = "structuralConsequences")]
    pub structural_consequences: Vec<StructuralConsequence>,
    /// Raw field writes depend only on identity and the written fields, not placement.
    #[serde(default, rename = "batchIndependent")]
    pub batch_independent: bool,
    /// Every object of the type is read-only through the object model (rule OM8): content the
    /// kit preserves without modelling it.
    #[serde(default, rename = "readOnly")]
    pub read_only: bool,
    /// The objects of the type whose enum field holds one of `values` are read-only through the
    /// object model (rule OM8), such as a shape of kind `opaque`.
    #[serde(default, rename = "readOnlyWhen")]
    pub read_only_when: Option<ReadOnlyWhen>,
    /// The type's tool id (rule OM9): the field holding the id the kit's own tools give its
    /// objects, which the object model then answers and takes as their `id`.
    #[serde(default, rename = "toolId")]
    pub tool_id: Option<ToolIdDef>,
    /// How an object of the type is named in a path, as the kit's commands name it: a
    /// field (`"name"`), or a member of a json field (`"meta.match"`), whose text names the object
    /// among the items of its list. Change sets then give each edit inside a held object `named`
    /// besides its positional `field` (`transform/opacity.value` beside
    /// `props.children.2.children.7.value`, [`crate::tool_ids::ToolIds::named_path`]).
    #[serde(default, rename = "pathName")]
    pub path_name: Option<String>,
    /// What names an object of the type to a person: a field (`"name"`) or a member of a
    /// json field (`"props.name"`) holding its text. Training environments (`kition-env`) quote
    /// it; without it they guess from the field names.
    #[serde(default)]
    pub label: Option<String>,
    /// Values the kit computes for an object of the type on request and never stores:
    /// a mesh's topology, its local bounds. Change sets name a derived value `~<name>`
    /// (`~topology`) beside the stored fields, and a premise may name it; it is no field of the
    /// replica, the file or a load.
    #[serde(default)]
    pub derived: BTreeMap<String, DerivedDef>,
    /// A field or JSON member path containing this object's displayed text.
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BatchOperation {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub direct: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Creation {
    #[serde(default)]
    pub fields: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<ProjectedCommand>,
    #[serde(default)]
    pub fixtures: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectedCommand {
    pub command: String,
    /// Command parameter names mapped to paths in the object-model operation.
    #[serde(default)]
    pub params: BTreeMap<String, String>,
}

/// One derived value a type declares ([`TypeDef::derived`]): what it says, for the agent.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DerivedDef {
    #[serde(default)]
    pub description: Option<String>,
    /// Comparable by the guard, omitted from public changes and snapshots.
    #[serde(default, rename = "premiseOnly")]
    pub premise_only: bool,
    /// Compare only pending holds via the kit's content callback and a retained basis model.
    #[serde(default, rename = "onDemand")]
    pub on_demand: bool,
}

/// `{ "field", "prefix"?, "parent"? }`: an object of the type is named at the tool interface by
/// `prefix` and the value of its read-only `integer` or `string` `field` (`item:` and `10` give
/// `item:10`), after its `parent`'s tool id and a `/` when the type's values are unique only
/// within a parent (`story:11/table:2`). The rendered id is unique in the document: types that
/// share a prefix and a parent type share one domain of values (rule OM9, [`crate::tool_ids`]).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolIdDef {
    pub field: String,
    #[serde(default)]
    pub prefix: String,
    /// The type whose object holds an object of this type in a `list`, `tree`, or `ref` field.
    #[serde(default)]
    pub parent: Option<String>,
}

/// The longest tool-id prefix a schema declares.
const MAX_PREFIX: usize = 32;

/// Why `prefix` cannot start a tool id, or `None` when it can: ASCII letters, digits, `_`, `-`,
/// `:`, and `/`, at most [`MAX_PREFIX`] of them, starting with a letter. A `.` would split a
/// batch's `in` (`<target>.<field>`); a `$` names a batch's references.
fn bad_prefix(prefix: &str) -> Option<&'static str> {
    if prefix.is_empty() {
        return None;
    }
    if prefix.len() > MAX_PREFIX {
        return Some("a prefix has at most 32 characters");
    }
    if !prefix.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return Some("a prefix starts with a letter");
    }
    if !prefix.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ':' | '/')) {
        return Some("a prefix holds ASCII letters, digits, `_`, `-`, `:`, and `/` only");
    }
    None
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
        if self.types.get(&self.root).is_some_and(|def| def.projected) {
            return Err(KdmError::Schema("the root type cannot be projected".into()));
        }
        let mut expands: BTreeMap<&str, Expand> = BTreeMap::new();
        for (ty, def) in &self.types {
            for (op, mapping) in &def.batch_ops {
                if op.is_empty()
                    || mapping.direct == mapping.command.is_some()
                    || mapping.command.as_ref().is_some_and(String::is_empty)
                    || mapping.direct && !mapping.params.is_empty()
                    || mapping.params.iter().any(|(name, path)| name.is_empty() || path.split('.').any(str::is_empty))
                {
                    return Err(KdmError::Schema(format!("`{ty}`: batchOps needs direct:true or a command and parameter paths")));
                }
            }
            if !def.projected && !def.projected_ops.is_empty() {
                return Err(KdmError::Schema(format!("`{ty}`: projectedOps requires projected:true")));
            }
            for (op, mapping) in &def.projected_ops {
                if op.is_empty()
                    || mapping.command.is_empty()
                    || mapping.params.iter().any(|(name, path)| name.is_empty() || path.split('.').any(str::is_empty))
                {
                    return Err(KdmError::Schema(format!("`{ty}`: projectedOps needs an operation, command and parameter paths")));
                }
            }
            for rule in &def.structural_consequences {
                if !self.types.contains_key(&rule.container)
                    || rule.on.is_empty()
                    || rule.on.iter().any(|action| {
                        !matches!(action.as_str(), "create" | "delete" | "move" | "rename")
                            && !(action == "set" && self.types.values().any(|def| def.projected))
                    })
                    || rule.fields.is_empty()
                    || rule.fields.iter().any(|path| {
                        path.split('.').any(str::is_empty)
                            || !def
                                .fields
                                .get(path.split('.').next().unwrap_or_default())
                                .is_some_and(|field| !path.contains('.') || matches!(field.kind, FieldKind::Json | FieldKind::Map))
                    })
                {
                    return Err(KdmError::Schema(format!(
                        "type `{ty}`: structuralConsequences needs a declared container, structural actions and stored field paths"
                    )));
                }
            }
            for path in &def.move_consequences {
                let root = path.split('.').next().unwrap_or_default();
                let valid = !path.split('.').any(str::is_empty)
                    && def.fields.get(root).is_some_and(|field| field.position && (!path.contains('.') || field.kind == FieldKind::Json));
                if !valid {
                    return Err(KdmError::Schema(format!("type `{ty}`: moveConsequences `{path}` must name a position field or its JSON member")));
                }
            }
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
            if let Some(tool) = &def.tool_id {
                self.check_tool_id(ty, tool)?;
            }
            if let Some(path) = &def.path_name {
                let field = path.split('.').next().unwrap_or_default();
                let kind = def.fields.get(field).map(|field| field.kind);
                let fits = match kind {
                    Some(FieldKind::String | FieldKind::Enum) => !path.contains('.'),
                    Some(FieldKind::Json) => true,
                    _ => false,
                };
                if !fits {
                    return Err(KdmError::Schema(format!("type `{ty}`: `pathName` `{path}` names no string or enum field, nor a member of a json field")));
                }
            }
            for (name, path) in [("label", &def.label), ("text", &def.text)].into_iter().filter_map(|(name, path)| path.as_ref().map(|path| (name, path))) {
                let field = path.split('.').next().unwrap_or_default();
                let fits = match def.fields.get(field).map(|field| field.kind) {
                    Some(FieldKind::String | FieldKind::Text | FieldKind::Enum) => !path.contains('.'),
                    Some(FieldKind::Json) => true,
                    _ => false,
                };
                if !fits {
                    return Err(KdmError::Schema(format!("type `{ty}`: `{name}` `{path}` names no string, text or enum field, nor a member of a json field")));
                }
            }
            if let Some((name, display)) = def.fields.iter().find_map(|(name, field)| field.display.as_ref().map(|display| (name, display))) {
                let fits = display.kind == "time"
                    && display.per_second.as_ref().and_then(serde_json::Number::as_f64).is_some_and(|units| units.is_finite() && units > 0.0)
                    && display.fps.as_ref().is_none_or(|fps| fps.as_f64().is_some_and(|fps| fps.is_finite() && fps > 0.0));
                if !fits {
                    return Err(KdmError::Schema(format!("`{ty}.{name}`: `display` is {{ kind: \"time\", perSecond, fps? }} with positive numbers")));
                }
            }
            if let Some(name) = def.derived.keys().find(|name| name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')) {
                return Err(KdmError::Schema(format!("type `{ty}`: derived `{name}` is no name (ASCII letters, digits and `_`)")));
            }
            if def.derived.values().any(|fact| fact.on_demand && !fact.premise_only) {
                return Err(KdmError::Schema(format!("type `{ty}`: onDemand derived facts require premiseOnly")));
            }
            for (name, field) in &def.fields {
                if (field.minimum.is_some() || field.maximum.is_some() || field.multiple_of.is_some())
                    && (!matches!(field.kind, FieldKind::Number | FieldKind::Integer | FieldKind::Json)
                        || field.minimum.as_ref().zip(field.maximum.as_ref()).is_some_and(|(min, max)| min.as_f64() > max.as_f64())
                        || field.multiple_of.as_ref().is_some_and(|step| step.as_f64().is_none_or(|step| !step.is_finite() || step <= 0.0)))
                {
                    return Err(KdmError::Schema(format!(
                        "`{ty}.{name}`: numeric limits require a number or integer, minimum <= maximum, and positive multipleOf"
                    )));
                }
                if !field.members.is_empty() && !matches!(field.kind, FieldKind::Json | FieldKind::Map) {
                    return Err(KdmError::Schema(format!("`{ty}.{name}`: members requires json or map")));
                }
                for (path, limits) in &field.members {
                    if path.split('.').any(|segment| {
                        let mut name = segment;
                        while let Some(rest) = name.strip_suffix("[]") {
                            name = rest;
                        }
                        name.is_empty() || name.contains(['[', ']'])
                    }) {
                        return Err(KdmError::Schema(format!("`{ty}.{name}`: invalid member path `{path}`")));
                    }
                    if limits.minimum.as_ref().zip(limits.maximum.as_ref()).is_some_and(|(min, max)| min.as_f64() > max.as_f64())
                        || limits.multiple_of.as_ref().is_some_and(|step| step.as_f64().is_none_or(|step| !step.is_finite() || step <= 0.0))
                    {
                        return Err(KdmError::Schema(format!("`{ty}.{name}`: members require minimum <= maximum and positive multipleOf")));
                    }
                }
                if name.starts_with('$') || name.starts_with('~') {
                    return Err(KdmError::Schema(format!("`{ty}.{name}`: names starting with `$` or `~` are reserved")));
                }
                let takes_of = matches!(field.kind, FieldKind::Ref | FieldKind::List | FieldKind::Tree) || (field.kind == FieldKind::Map && field.owns);
                if field.of.is_some() && !takes_of {
                    return Err(KdmError::Schema(format!("`{ty}.{name}`: only ref, list, and tree fields take `of`")));
                }
                if field.owns && matches!(field.kind, FieldKind::List | FieldKind::Tree) {
                    return Err(KdmError::Schema(format!("`{ty}.{name}`: only ref fields take `owns` (list and tree fields always own their items)")));
                }
                if field.owns && !matches!(field.kind, FieldKind::Ref | FieldKind::Map) {
                    return Err(KdmError::Schema(format!("`{ty}.{name}`: only ref and map fields take `owns`")));
                }
                if field.cascade && field.kind != FieldKind::Tree {
                    return Err(KdmError::Schema(format!("`{ty}.{name}`: cascade requires a tree")));
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
                    FieldKind::Map => {
                        if let Some(of) = &field.of
                            && !self.types.contains_key(of)
                        {
                            return Err(KdmError::Schema(format!("`{ty}.{name}` refers to undeclared type `{of}`")));
                        }
                    }
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

    /// Checks a type's `toolId` (rule OM9): a read-only `integer` or `string` field of the type,
    /// a prefix [`bad_prefix`] accepts, and a parent type that declares a tool id itself, holds
    /// this type in a `list`, `tree`, or `ref` field, and is not this type or one of its children.
    fn check_tool_id(&self, ty: &str, tool: &ToolIdDef) -> Result<()> {
        let bad = |reason: String| Err(KdmError::Schema(format!("type `{ty}`: `toolId` {reason}")));
        let Some(field) = self.types.get(ty).and_then(|def| def.fields.get(&tool.field)) else {
            return bad(format!("names undeclared field `{}`", tool.field));
        };
        if !matches!(field.kind, FieldKind::Integer | FieldKind::String) {
            return bad(format!("names `{}`, which is not an integer or a string", tool.field));
        }
        if !field.read_only {
            return bad(format!("names `{}`, which is not `readOnly`: only the kit writes an object's tool id", tool.field));
        }
        if let Some(reason) = bad_prefix(&tool.prefix) {
            return bad(format!("prefix `{}`: {reason}", tool.prefix));
        }
        let Some(parent) = &tool.parent else { return Ok(()) };
        let Some(parent_def) = self.types.get(parent) else {
            return bad(format!("names undeclared parent type `{parent}`"));
        };
        if parent_def.tool_id.is_none() {
            return bad(format!("names parent `{parent}`, which declares no `toolId`"));
        }
        let holds = parent_def.fields.values().any(|field| {
            (matches!(field.kind, FieldKind::List | FieldKind::Tree | FieldKind::Ref) || (field.kind == FieldKind::Map && field.owns))
                && field.of.as_deref() == Some(ty)
        });
        if !holds {
            return bad(format!("names parent `{parent}`, which has no list, tree, or ref field of `{ty}`"));
        }
        // A chain of parents that comes back to this type; a loop elsewhere is its own types' error.
        let mut seen: Vec<&str> = Vec::new();
        let mut next = Some(parent.as_str());
        while let Some(current) = next {
            if current == ty {
                return bad(format!("parent `{parent}` leads back to `{ty}`: parents form no cycle"));
            }
            if seen.contains(&current) {
                break;
            }
            seen.push(current);
            next = self.types.get(current).and_then(|def| def.tool_id.as_ref()).and_then(|tool| tool.parent.as_deref());
        }
        Ok(())
    }

    /// Whether any type declares a tool id (rule OM9). A schema without one answers object-model
    /// ids everywhere, as before the rule.
    pub fn has_tool_ids(&self) -> bool {
        self.types.values().any(|def| def.tool_id.is_some())
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
        let has_limits = def.minimum.is_some() || def.maximum.is_some() || def.multiple_of.is_some();
        let bad_number = has_limits && value.as_f64().is_some_and(|number| !def.accepts_number(number));
        let bad_members = def.members.iter().any(|(path, limits)| member_values(value, path).iter().any(|value| !limits.accepts_value(value)));
        if ok && (bad_number || bad_members) {
            Err(invalid("is outside minimum/maximum or is not a multipleOf the declared step".into()))
        } else if ok {
            Ok(())
        } else if def.kind == FieldKind::Enum {
            Err(invalid(enum_refusal(&def.values, value)))
        } else {
            let kind = format!("{:?}", def.kind).to_lowercase();
            let article = if kind.starts_with(['a', 'e', 'i', 'o', 'u']) { "an" } else { "a" };
            Err(invalid(format!("expects {article} {kind} value")))
        }
    }
}

impl NumberLimits {
    pub fn accepts_value(&self, value: &Value) -> bool {
        match value {
            Value::Array(_) | Value::Object(_) => true,
            Value::Null => self.nullable,
            _ => value.as_f64().is_some_and(|number| accepts_number(number, &self.minimum, &self.maximum, &self.multiple_of)),
        }
    }
}

impl Schema {
    /// Validate just the affected map entry, without copying the rest of the map.
    pub fn check_map_entry(&self, ty: &str, field: &str, key: &str, value: &Value) -> Result<()> {
        let def = self.field(ty, field)?;
        if let Some(of) = &def.of
            && !value.as_str().is_some_and(|id| !id.is_empty())
        {
            return Err(KdmError::InvalidValue { ty: ty.into(), field: field.into(), reason: format!("map entry `{key}` expects the id of a `{of}`") });
        }
        let entry = serde_json::json!({key: value});
        for (path, limits) in &def.members {
            if member_values(&entry, path).iter().any(|value| !limits.accepts_value(value)) {
                return Err(KdmError::InvalidValue {
                    ty: ty.into(),
                    field: field.into(),
                    reason: format!("map entry `{key}` violates numeric member limits at `{path}`"),
                });
            }
        }
        Ok(())
    }
}

fn member_values<'a>(value: &'a Value, path: &str) -> Vec<&'a Value> {
    if path.is_empty() {
        return vec![value];
    }
    let end = path.find(['.', '[']).unwrap_or(path.len());
    if end > 0 {
        if &path[..end] == "*" {
            return value.as_object().into_iter().flat_map(|map| map.values()).flat_map(|value| member_values(value, &path[end..])).collect();
        }
        return value.get(&path[..end]).map(|value| member_values(value, &path[end..])).unwrap_or_default();
    }
    if let Some(rest) = path.strip_prefix("[]") {
        return value.as_array().into_iter().flatten().flat_map(|value| member_values(value, rest)).collect();
    }
    path.strip_prefix('.').map(|rest| member_values(value, rest)).unwrap_or_default()
}

impl FieldDef {
    pub fn accepts_number(&self, value: f64) -> bool {
        accepts_number(value, &self.minimum, &self.maximum, &self.multiple_of)
    }
}

fn accepts_number(value: f64, minimum: &Option<serde_json::Number>, maximum: &Option<serde_json::Number>, multiple_of: &Option<serde_json::Number>) -> bool {
    value.is_finite()
        && minimum.as_ref().and_then(serde_json::Number::as_f64).is_none_or(|min| value >= min)
        && maximum.as_ref().and_then(serde_json::Number::as_f64).is_none_or(|max| value <= max)
        && multiple_of.as_ref().and_then(serde_json::Number::as_f64).is_none_or(|step| {
            let units = value / step;
            units.is_finite() && (units - units.round()).abs() <= 1e-9
        })
}

/// How many of an enum's values a refusal lists before it counts the rest.
const ENUM_VALUES_SHOWN: usize = 20;

/// Why `value` is not one of an enum's `values`, naming them (KHP A48): `takes one of `a`, `b`,
/// not `c``. `@kition/kdm`'s `enumRefusal` answers the same text.
fn enum_refusal(values: &[String], value: &Value) -> String {
    let shown: Vec<String> = values.iter().take(ENUM_VALUES_SHOWN).map(|value| format!("`{value}`")).collect();
    let more = values.len().saturating_sub(ENUM_VALUES_SHOWN);
    let rest = if more > 0 { format!(", and {more} more (`describe` lists them all)") } else { String::new() };
    let given = match value {
        Value::String(text) => format!("`{text}`"),
        Value::Number(_) => "a number".to_owned(),
        Value::Bool(_) => "a boolean".to_owned(),
        Value::Array(_) => "an array".to_owned(),
        Value::Object(_) => "an object".to_owned(),
        Value::Null => "null".to_owned(),
    };
    format!("takes one of {}{rest}, not {given}", shown.join(", "))
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
