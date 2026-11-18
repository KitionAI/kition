// Copied from kition-sdk crates/kition-kdm/src/tool_ids.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Tool ids (rule OM9 of `KitObjectModel`, Kition platform `docs/platform/sets/object-model.md`):
//! the ids a kit's own tools give its objects, which the object model answers and takes in place of
//! KDM object ids, so a document has one id space at the tool interface (KHP A47).
//!
//! A type declares `"toolId": { "field", "prefix"?, "parent"? }` ([`crate::ToolIdDef`]). An object
//! of it is named `<prefix><value>` (its read-only `field`), after its parent's tool id and a `/`
//! when the type declares a `parent`: the object of that type holding it in a `list`, `tree`, or
//! `ref` field. An object has a tool id when its field holds a value, it has exactly one holder of
//! its parent type that has a tool id, and no other live object renders the same id. Every other
//! object (an unannotated type, one the kit has not numbered yet, one whose id another shares)
//! answers its KDM object id. `@kition/kdm`'s `toolIds.ts` is the twin; both run
//! `tests/fixtures/tool-ids.json`.
//!
//! An object without a tool id of its own is a part of the nearest object holding it that has one
//! ([`ToolIds::attributed`]): held through a `list` or `tree` field or a `ref` or `map` declared
//! `owns` ([`crate::FieldDef::owning`]), one holder at each step. Change sets name its changes
//! under that object, at a path of field names, positions and map keys (`body.paragraphs.0`,
//! `table.cells.r1:c2.body`), the way the tools' `follow` paths read.

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;

use crate::{FieldKind, ObjectId, Replica, Schema, ToolIdDef};

/// How many candidates a refusal lists.
const CANDIDATES: usize = 8;

/// What the ids are read from: a replica, or a canonical state.
trait Source {
    /// Every object's id by its type, each group sorted.
    fn objects_by_type(&self) -> HashMap<String, Vec<ObjectId>>;
    /// A register's value (`null` when it holds none).
    fn register(&self, id: &ObjectId, field: &str) -> Value;
    /// The live objects a `list`, `tree`, or `ref` field of `owner` holds.
    fn held(&self, owner: &ObjectId, field: &str, kind: FieldKind) -> Vec<ObjectId>;
    /// A `map` field's entries, as an object.
    fn map(&self, owner: &ObjectId, field: &str) -> Value;
    /// Whether `id` names a live object.
    fn exists(&self, id: &str) -> bool;
}

impl Source for Replica {
    fn objects_by_type(&self) -> HashMap<String, Vec<ObjectId>> {
        Replica::objects_by_type(self)
    }

    fn register(&self, id: &ObjectId, field: &str) -> Value {
        self.get(id, field).unwrap_or(Value::Null)
    }

    fn held(&self, owner: &ObjectId, field: &str, kind: FieldKind) -> Vec<ObjectId> {
        match kind {
            FieldKind::List => self.list(owner, field).unwrap_or_default(),
            FieldKind::Tree => self.tree(owner, field).unwrap_or_default().into_iter().map(|entry| entry.object).filter(|object| self.exists(object)).collect(),
            FieldKind::Ref => self.get(owner, field).ok().and_then(|value| value.as_str().map(ObjectId::from_string)).into_iter().collect(),
            _ => Vec::new(),
        }
    }

    fn map(&self, owner: &ObjectId, field: &str) -> Value {
        Value::Object(self.map_entries(owner, field).unwrap_or_default().into_iter().collect())
    }

    fn exists(&self, id: &str) -> bool {
        Replica::exists(self, &ObjectId::from_string(id))
    }
}

/// A canonical state ([`Replica::state_json`]): `{ objects: { <id>: { $type, <field>... } } }`.
struct State<'a> {
    objects: &'a serde_json::Map<String, Value>,
}

impl State<'_> {
    fn tree_objects(nodes: &Value, out: &mut Vec<ObjectId>) {
        for node in nodes.as_array().into_iter().flatten() {
            if let Some(object) = node.get("object").and_then(Value::as_str) {
                out.push(ObjectId::from_string(object));
            }
            Self::tree_objects(&node["children"], out);
        }
    }
}

impl Source for State<'_> {
    fn objects_by_type(&self) -> HashMap<String, Vec<ObjectId>> {
        let mut groups: HashMap<String, Vec<ObjectId>> = HashMap::new();
        for (id, object) in self.objects {
            if let Some(ty) = object.get("$type").and_then(Value::as_str) {
                groups.entry(ty.to_owned()).or_default().push(ObjectId::from_string(id.clone()));
            }
        }
        for ids in groups.values_mut() {
            ids.sort();
        }
        groups
    }

    fn register(&self, id: &ObjectId, field: &str) -> Value {
        self.objects.get(id.as_str()).and_then(|object| object.get(field)).cloned().unwrap_or(Value::Null)
    }

    fn held(&self, owner: &ObjectId, field: &str, kind: FieldKind) -> Vec<ObjectId> {
        let value = self.register(owner, field);
        let mut out = Vec::new();
        match kind {
            FieldKind::List => out.extend(value.as_array().into_iter().flatten().filter_map(Value::as_str).map(ObjectId::from_string)),
            FieldKind::Tree => Self::tree_objects(&value, &mut out),
            FieldKind::Ref => out.extend(value.as_str().map(ObjectId::from_string)),
            _ => {}
        }
        out.retain(|id| self.objects.contains_key(id.as_str()));
        out
    }

    fn map(&self, owner: &ObjectId, field: &str) -> Value {
        self.register(owner, field)
    }

    fn exists(&self, id: &str) -> bool {
        self.objects.contains_key(id)
    }
}

/// One object's tool id as rendered: its type, the id, and the value it ends with.
#[derive(Clone, Debug)]
struct Named {
    id: ObjectId,
    ty: String,
    value: String,
}

/// The tool ids of one document state.
#[derive(Clone, Debug, Default)]
pub struct ToolIds {
    /// Whether the schema declares any tool id; when not, every method answers object ids.
    active: bool,
    /// Each object's tool id, when it is its own.
    own: HashMap<ObjectId, String>,
    /// Every rendered tool id to the objects rendering it.
    named: BTreeMap<String, Vec<Named>>,
    /// Each object held through an owning field: its holders, with the field and, in a list or
    /// tree, its position (a tree's in depth-first order).
    owners: HashMap<ObjectId, Vec<Holder>>,
}

/// An object holding another through an owning field: the holder, the field, and the place in it:
/// a position in a list or tree, a map's key (and member), nothing for a ref.
#[derive(Clone, Debug)]
struct Holder {
    owner: ObjectId,
    field: String,
    at: Option<String>,
    /// The held object's name in its list, when its type declares a `pathName` ([`path_names`]).
    name: Option<String>,
}

/// The names the items of one list (`items`, with their types) have in a path, when their type
/// declares a `pathName`: the value of that field (`name`), or of a member of its json
/// value (`meta.match`); `#<n>` (its place from 1) when that is empty, a number, or holds `/`, `.`,
/// `#` or `@`; and `<name>#<n>` for the n-th item of one name after the first.
fn path_names(schema: &Schema, source: &dyn Source, items: &[(ObjectId, Option<&String>)]) -> Vec<Option<String>> {
    let raw: Vec<Option<Option<String>>> = items
        .iter()
        .map(|(id, ty)| {
            let declared = schema.types.get(ty.map(String::as_str)?)?.path_name.as_deref()?;
            let mut members = declared.split('.');
            let mut value = source.register(id, members.next()?);
            for member in members {
                value = value.get(member).cloned().unwrap_or(Value::Null);
            }
            Some(value.as_str().map(str::to_owned))
        })
        .collect();
    raw.iter()
        .enumerate()
        .map(|(index, name)| {
            let name = name.as_ref()?;
            let safe = name.as_deref().filter(|name| !name.is_empty() && !name.contains(['/', '.', '#', '@']) && name.parse::<u64>().is_err());
            Some(match safe {
                None => format!("#{}", index + 1),
                Some(name) => {
                    let before = raw.iter().take(index).filter(|other| other.as_ref().and_then(Option::as_deref) == Some(name)).count();
                    if before == 0 { name.to_owned() } else { format!("{name}#{}", before + 1) }
                }
            })
        })
        .collect()
}

/// Why a target names no single object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unresolved {
    /// No object has this id, nor an object id like it.
    NotFound(String),
    /// More than one object renders this id.
    Ambiguous(String),
}

/// A field value as the end of a tool id: an integer's digits, or a non-empty string.
fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => number.as_i64().map(|n| n.to_string()).or_else(|| number.as_f64().filter(|n| n.fract() == 0.0).map(|n| format!("{n:.0}"))),
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

/// The value a typed id ends with: what follows its last `:` or `/`.
fn value_part(text: &str) -> &str {
    text.rsplit([':', '/']).next().unwrap_or(text)
}

/// `a`, `b`, and `c`, each in backticks.
fn listed(items: &[String]) -> String {
    let quoted: Vec<String> = items.iter().map(|item| format!("`{item}`")).collect();
    match quoted.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

impl ToolIds {
    /// The tool ids of a replica's current state.
    pub fn of_replica(replica: &Replica) -> Self {
        Self::build(replica.schema(), replica)
    }

    /// The tool ids of a canonical state ([`Replica::state_json`]) read with `schema`.
    pub fn of_state(schema: &Schema, state: &Value) -> Self {
        let empty = serde_json::Map::new();
        let objects = state.get("objects").and_then(Value::as_object).unwrap_or(&empty);
        Self::build(schema, &State { objects })
    }

    fn build(schema: &Schema, source: &dyn Source) -> Self {
        let declared: Vec<(&String, &ToolIdDef)> = schema.types.iter().filter_map(|(ty, def)| def.tool_id.as_ref().map(|tool| (ty, tool))).collect();
        if declared.is_empty() {
            return Self::default();
        }
        // The document's objects by type, read once.
        let by_type = source.objects_by_type();
        let of_type = |ty: &str| by_type.get(ty).cloned().unwrap_or_default();
        // Each numbered object's own part (`<prefix><value>`), its type and value.
        let mut parts: HashMap<ObjectId, (&String, &ToolIdDef, String)> = HashMap::new();
        for (ty, tool) in &declared {
            for id in of_type(ty) {
                if let Some(value) = value_text(&source.register(&id, &tool.field)) {
                    parts.insert(id, (*ty, *tool, value));
                }
            }
        }
        // The holders of each object of a type that names a parent.
        let mut holders: HashMap<ObjectId, Vec<ObjectId>> = HashMap::new();
        for (ty, tool) in &declared {
            let Some(parent) = tool.parent.as_deref() else { continue };
            let Some(parent_def) = schema.types.get(parent) else { continue };
            for (field, def) in &parent_def.fields {
                if !matches!(def.kind, FieldKind::List | FieldKind::Tree | FieldKind::Ref) || def.of.as_deref() != Some(ty.as_str()) {
                    continue;
                }
                for owner in of_type(parent) {
                    for child in source.held(&owner, field, def.kind) {
                        let entry = holders.entry(child).or_default();
                        if !entry.contains(&owner) {
                            entry.push(owner.clone());
                        }
                    }
                }
            }
        }
        let mut full: HashMap<ObjectId, Option<String>> = HashMap::new();
        let mut ids: Vec<&ObjectId> = parts.keys().collect();
        ids.sort();
        for id in ids {
            rendered(id, &parts, &holders, &mut full, 0);
        }
        let mut named: BTreeMap<String, Vec<Named>> = BTreeMap::new();
        for (id, text) in full.iter().filter_map(|(id, text)| Some((id, text.clone()?))) {
            if let Some((ty, _, value)) = parts.get(id) {
                named.entry(text).or_default().push(Named { id: id.clone(), ty: (*ty).clone(), value: value.clone() });
            }
        }
        let mut own = HashMap::new();
        for (text, objects) in &mut named {
            objects.sort_by(|a, b| (a.ty.as_str(), &a.id).cmp(&(b.ty.as_str(), &b.id)));
            if let [one] = objects.as_slice() {
                own.insert(one.id.clone(), text.clone());
            }
        }
        // The holders of every object held through an owning field.
        let mut owners: HashMap<ObjectId, Vec<Holder>> = HashMap::new();
        let named_types = schema.types.values().any(|def| def.path_name.is_some());
        let type_of: HashMap<&ObjectId, &String> =
            if named_types { by_type.iter().flat_map(|(ty, ids)| ids.iter().map(move |id| (id, ty))).collect() } else { HashMap::new() };
        for (ty, def) in &schema.types {
            for (field, field_def) in def.fields.iter().filter(|(_, field_def)| field_def.owning()) {
                for owner in of_type(ty) {
                    let held: Vec<(ObjectId, Option<String>)> = match field_def.kind {
                        FieldKind::Map => crate::FieldDef::map_held(&source.map(&owner, field), |id| source.exists(id))
                            .into_iter()
                            .map(|(child, at)| (ObjectId::from_string(child), Some(at)))
                            .collect(),
                        FieldKind::Ref => source.held(&owner, field, field_def.kind).into_iter().map(|child| (child, None)).collect(),
                        _ => {
                            source.held(&owner, field, field_def.kind).into_iter().enumerate().map(|(index, child)| (child, Some(index.to_string()))).collect()
                        }
                    };
                    let names = if named_types && field_def.kind == FieldKind::List {
                        let items: Vec<(ObjectId, Option<&String>)> = held.iter().map(|(child, _)| (child.clone(), type_of.get(child).copied())).collect();
                        path_names(schema, source, &items)
                    } else {
                        Vec::new()
                    };
                    for (index, (child, at)) in held.into_iter().enumerate() {
                        let entry = owners.entry(child).or_default();
                        if !entry.iter().any(|known| known.owner == owner && known.field == *field) {
                            entry.push(Holder { owner: owner.clone(), field: field.clone(), at, name: names.get(index).cloned().flatten() });
                        }
                    }
                }
            }
        }
        // A map's key made of object ids (`<row id>:<column id>`, a holder's place `<key>` or
        // `<key>.<member>`) names, in a path, each object by what the tools use: its tool id, else
        // its position in the list holding it (`0:1`), when the whole key or every segment names
        // such an object; any other key stays as it is.
        let name = |id: &str| -> Option<String> {
            let id = ObjectId::from_string(id);
            if let Some(tool) = own.get(&id) {
                return Some(tool.clone());
            }
            match owners.get(&id).map(Vec::as_slice) {
                Some([holder]) if holder.at.as_deref().is_some_and(|index| index.parse::<usize>().is_ok()) => holder.at.clone(),
                _ => None,
            }
        };
        let shown = |at: &str| -> Option<String> {
            let (key, member) = match at.split_once('.') {
                Some((key, member)) => (key, Some(member)),
                None => (at, None),
            };
            let key = match name(key) {
                Some(whole) => whole,
                None => key.split(':').map(name).collect::<Option<Vec<_>>>()?.join(":"),
            };
            Some(member.map_or_else(|| key.clone(), |member| format!("{key}.{member}")))
        };
        let renamed: Vec<(ObjectId, usize, String)> = owners
            .iter()
            .flat_map(|(child, holders)| holders.iter().enumerate().map(move |(at, holder)| (child, at, holder)))
            .filter_map(|(child, at, holder)| Some((child.clone(), at, shown(holder.at.as_deref()?)?)))
            .collect();
        for (child, at, shown) in renamed {
            if let Some(holder) = owners.get_mut(&child).and_then(|holders| holders.get_mut(at)) {
                holder.at = Some(shown);
            }
        }
        Self { active: true, own, named, owners }
    }

    /// For an object without a tool id of its own, the nearest object holding it that has one (its
    /// tool id) and the path from that object to it: field names and positions joined by `.`
    /// (`body.paragraphs.0`). `None` for an object with a tool id, without tool ids in the schema,
    /// or when some object on the way has no single holder through an owning field.
    pub fn attributed(&self, id: &ObjectId) -> Option<(String, String)> {
        if !self.active || self.own.contains_key(id) {
            return None;
        }
        let mut segments: Vec<String> = Vec::new();
        let mut current = id.clone();
        for _ in 0..64 {
            let [holder] = self.owners.get(&current)?.as_slice() else { return None };
            if let Some(at) = &holder.at {
                segments.push(at.clone());
            }
            segments.push(holder.field.clone());
            if let Some(tool) = self.own.get(&holder.owner) {
                segments.reverse();
                return Some((tool.clone(), segments.join(".")));
            }
            current = holder.owner.clone();
        }
        None
    }

    /// [`ToolIds::attributed`]'s path in the words of the kit's commands: the names of
    /// the objects on the way whose type declares a `pathName`, joined by `/`, then the path below
    /// the last of them (`transform/opacity`, `transform/opacity.keys.0`); the fields leading to
    /// the first and between them are not written. `None` when no object on the way is named so.
    pub fn named_path(&self, id: &ObjectId) -> Option<String> {
        if !self.active || self.own.contains_key(id) {
            return None;
        }
        let mut names: Vec<String> = Vec::new();
        let mut below: Vec<String> = Vec::new();
        let mut current = id.clone();
        for _ in 0..64 {
            let [holder] = self.owners.get(&current)?.as_slice() else { return None };
            match &holder.name {
                Some(name) => names.push(name.clone()),
                None if names.is_empty() => {
                    if let Some(at) = &holder.at {
                        below.push(at.clone());
                    }
                    below.push(holder.field.clone());
                }
                None => {}
            }
            if self.own.contains_key(&holder.owner) {
                if names.is_empty() {
                    return None;
                }
                names.reverse();
                below.reverse();
                let mut out = names.join("/");
                if !below.is_empty() {
                    out.push('.');
                    out.push_str(&below.join("."));
                }
                return Some(out);
            }
            current = holder.owner.clone();
        }
        None
    }

    /// The type of the object a tool id names, when it names one.
    pub fn type_of(&self, tool_id: &str) -> Option<&str> {
        match self.named.get(tool_id).map(Vec::as_slice) {
            Some([one]) => Some(one.ty.as_str()),
            _ => None,
        }
    }

    /// Whether the schema declares tool ids.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// The object's tool id, when it has one of its own.
    pub fn tool_id(&self, id: &ObjectId) -> Option<&str> {
        self.own.get(id).map(String::as_str)
    }

    /// How the object is named at the tool interface: its tool id, else its object id.
    pub fn show(&self, id: &ObjectId) -> String {
        self.tool_id(id).map_or_else(|| id.to_string(), str::to_owned)
    }

    /// References nested in JSON/maps use the same names as direct references. Only exact
    /// known object ids are replaced; arbitrary text containing an id stays literal.
    pub fn show_json(&self, value: &Value) -> Value {
        let key = |key: &str| {
            if let Some(id) = self.tool_id(&ObjectId::from_string(key)) {
                id.to_owned()
            } else {
                key.split(':').map(|part| self.show(&ObjectId::from_string(part))).collect::<Vec<_>>().join(":")
            }
        };
        match value {
            Value::String(id) => Value::String(self.show(&ObjectId::from_string(id))),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.show_json(item)).collect()),
            Value::Object(members) => Value::Object(members.iter().map(|(name, value)| (key(name), self.show_json(value))).collect()),
            other => other.clone(),
        }
    }

    /// Names references in text marks while preserving every inserted character literally.
    pub fn show_text(&self, value: &Value) -> Value {
        let Value::Array(runs) = value else { return value.clone() };
        Value::Array(
            runs.iter()
                .map(|run| {
                    let mut run = run.clone();
                    if let Some(attributes) = run.get_mut("attributes") {
                        *attributes = self.show_json(attributes);
                    }
                    run
                })
                .collect(),
        )
    }

    /// The object `text` names: a tool id, else an object id for which `exists` holds. Without
    /// declared tool ids, `text` as an object id.
    pub fn resolve(&self, text: &str, exists: impl Fn(&ObjectId) -> bool) -> Result<ObjectId, Unresolved> {
        if !self.active {
            return Ok(ObjectId::from_string(text));
        }
        match self.named.get(text).map(Vec::as_slice) {
            Some([one]) => return Ok(one.id.clone()),
            Some(many) if many.len() > 1 => {
                let objects: Vec<String> = many.iter().map(|named| format!("the `{}` `{}`", named.ty, named.id)).collect();
                let objects = match objects.as_slice() {
                    [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
                    [] => String::new(),
                };
                return Err(Unresolved::Ambiguous(format!(
                    "`{text}` names {} objects ({objects}), so it names none of them: give one of their object ids, which they answer until the kit gives each an id of its own",
                    many.len()
                )));
            }
            _ => {}
        }
        let id = ObjectId::from_string(text);
        if exists(&id) {
            return Ok(id);
        }
        Err(Unresolved::NotFound(self.not_found(text)))
    }

    /// Why `text` names no object, with the ids it may have meant (KHP A44, A48).
    pub fn not_found(&self, text: &str) -> String {
        let value = value_part(text);
        let same_value: Vec<String> =
            self.named.iter().filter(|(_, objects)| objects.iter().any(|named| named.value == value)).map(|(id, _)| id.clone()).collect();
        if !same_value.is_empty() {
            let shown: Vec<String> = same_value.iter().take(CANDIDATES).cloned().collect();
            let more = if same_value.len() > shown.len() { format!(", and {} more", same_value.len() - shown.len()) } else { String::new() };
            return format!(
                "no object has the id `{text}`; these end in `{value}`: {}{more} (an id is written whole, as query and load answer it)",
                listed(&shown)
            );
        }
        let head = text.strip_suffix(value).unwrap_or_default();
        if !head.is_empty() {
            let domain: Vec<&String> = self.named.keys().filter(|id| id.starts_with(head)).collect();
            if !domain.is_empty() && domain.len() <= CANDIDATES {
                let shown: Vec<String> = domain.into_iter().cloned().collect();
                return format!("no object has the id `{text}`; the ids starting `{head}` are {}", listed(&shown));
            }
            if !domain.is_empty() {
                return format!("no object has the id `{text}`; {} ids start `{head}`: query or load answers them", domain.len());
            }
        }
        format!("no object has the id `{text}`: give an id that query or load answers, `root`, or the `$name` of an object created earlier in the batch")
    }
}

/// The rendered tool id of `id` (memoized in `full`): its own part, after its one holder's when
/// its type names a parent. `depth` stops a holder cycle the schema check cannot see.
fn rendered(
    id: &ObjectId,
    parts: &HashMap<ObjectId, (&String, &ToolIdDef, String)>,
    holders: &HashMap<ObjectId, Vec<ObjectId>>,
    full: &mut HashMap<ObjectId, Option<String>>,
    depth: usize,
) -> Option<String> {
    if let Some(known) = full.get(id) {
        return known.clone();
    }
    let text = parts.get(id).and_then(|(_, tool, value)| {
        let own = format!("{}{value}", tool.prefix);
        if tool.parent.is_none() {
            return Some(own);
        }
        let [holder] = holders.get(id).map(Vec::as_slice)? else { return None };
        if depth > 64 {
            return None;
        }
        let parent = rendered(holder, parts, holders, full, depth + 1)?;
        Some(format!("{parent}/{own}"))
    });
    full.insert(id.clone(), text.clone());
    text
}
