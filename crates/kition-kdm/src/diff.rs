// Copied from kition-sdk crates/kition-kdm/src/diff.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The object-level difference between two states of one document (standard 2.0 A13): what a
//! change created, changed, moved, and deleted. One description serves both readers of it:
//!
//! - a draft's comparison, which a person reviews before merging it ([`diff_states`], over two
//!   canonical states, with the full `texts`);
//! - a write's receipt, which answers an agent's `<prefix>_run` and `<prefix>_batch`
//!   ([`crate::Replica::changes_since`], from the objects a replica changed since a version, with
//!   values cut to excerpts and no `texts`).
//!
//! Both read the same state shapes and answer the same for the same change. `@kition/kdm`'s
//! `diffStates` and `Replica.changesSince` answer the same for the same states.

use serde::Serialize;
use serde_json::{Map, Value, json};

use std::collections::{BTreeMap, BTreeSet};

use crate::tool_ids::ToolIds;
use crate::{FieldKind, ObjectId, Schema};

/// The most characters a text value of a change shows; a longer one is an excerpt with its length.
pub const EXCERPT_CHARS: usize = 80;
/// How many unchanged characters an excerpt of a changed text keeps before the first difference.
const EXCERPT_LEAD: usize = 20;
/// At most how many edits a `json` value's change is told in, down to its changed leaves
/// ([`StateDiff::with_leaf_edits`]); more, and it is told whole.
pub const LEAF_EDITS: usize = 16;
const ELLIPSIS: char = '…';

/// Where an object sits: the object whose list or tree field holds it (for a tree, the object of
/// its parent node, or the tree's owner for a root node), that field, and its index among its
/// siblings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Position {
    pub parent: String,
    pub field: String,
    pub index: usize,
}

/// One field a change changed: its value before and after, as [`shown_value`] gives them. `named`
/// is the same place in the words of the kit's commands, when the objects on the way declare a
/// `pathName` (`transform/opacity.value`, [`crate::tool_ids::ToolIds::named_path`]).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FieldEdit {
    pub field: String,
    pub before: Value,
    pub after: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub named: Option<String>,
}

/// One object in a [`StateDiff`]: its id, its type, and the fields concerned (sorted).
///
/// A created object also gives `values` (each field holding a value, list and tree fields left
/// out: their items are objects of their own) and `at`, where it was put when a list or tree holds
/// it; a deleted one gives `at`, where it was when a list or tree held it; a changed one gives `edits`, each changed field's value before and after (a list or tree
/// field's change is told by `moved`, `created` and `deleted` instead).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ObjectChange {
    pub id: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub fields: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<Position>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edits: Option<Vec<FieldEdit>>,
}

/// An object whose place changed: in its list or tree, or to another one. `from` is `null` for an
/// object no changed list held before, `to` for one no list holds after.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Move {
    pub id: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub from: Option<Position>,
    pub to: Option<Position>,
}

/// A text-like field (a `text` field, or a string) a draft changed, as plain text before and after.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TextChange {
    pub id: String,
    pub field: String,
    pub before: String,
    pub after: String,
}

/// What changed between two states of one document, each list sorted by object id (then field).
///
/// - `created`: objects only `after` has; `fields` are those holding a value (not null, not
///   empty), with `values` and `at`.
/// - `changed`: objects both have whose fields differ; `fields` are the differing ones, with
///   `edits`.
/// - `moved`: objects both have whose place in a list or tree changed (an object both moved and
///   changed is in both lists). Of the items a list keeps, the fewest that explain the new order
///   moved.
/// - `deleted`: objects only `before` has; `fields` is empty, with `at` where a list or tree held
///   them before.
/// - `texts`: the text-like fields of created and changed objects whose text differs, in full; only
///   a draft's comparison ([`diff_states`]) has them, a receipt ([`crate::Replica::changes_since`])
///   leaves the member out.
/// - `footprint`: a shift of many objects stated once (`[{ parent, field, from, count, shift: {
///   field, by } }]`), which agent tools write into the change sets they answer
///   ([`crate::footprint::with_footprint`]); a diff never fills it, and leaves it out.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct StateDiff {
    pub created: Vec<ObjectChange>,
    pub changed: Vec<ObjectChange>,
    pub moved: Vec<Move>,
    pub deleted: Vec<ObjectChange>,
    pub texts: Vec<TextChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footprint: Option<Value>,
    /// The changes of objects no agent can name, counted by type and list (`{ "Media": { "changed":
    /// 1 } }`) instead of listed: in two reads of a file whose object ids were minted again, the
    /// objects that have no tool id and no holder with one ([`crate::reread::diff_read_again`]).
    /// Empty and left out otherwise.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub unnamed: BTreeMap<String, BTreeMap<String, usize>>,
    /// In two reads of a file, the tool ids another program moved between objects
    /// ([`crate::reread::pair`]): what changed in those objects cannot be told, so they are in no
    /// list. Empty and left out otherwise.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub renumbered: Vec<String>,
    /// Whether `texts` belongs to the answer: false for a receipt.
    #[serde(skip)]
    full_texts: bool,
    /// The values of the deleted objects, as a created object's are given: what an attributed
    /// deletion shows as `before` ([`StateDiff::with_tool_ids`]).
    #[serde(skip)]
    gone: BTreeMap<String, Map<String, Value>>,
    /// Unnamed objects still determine list positions. Retained only in journal JSON.
    #[serde(skip)]
    unnamed_objects: BTreeMap<String, Vec<Value>>,
    /// Complete text/formatting before values for guard callbacks, never public receipts.
    #[serde(skip)]
    text_basis: BTreeMap<String, Map<String, Value>>,
    #[serde(skip)]
    spans: BTreeMap<String, Map<String, Value>>,
}

impl StateDiff {
    pub fn is_empty(&self) -> bool {
        self.created.is_empty() && self.changed.is_empty() && self.moved.is_empty() && self.deleted.is_empty()
    }

    /// Whether the answer carries `texts` (a draft's comparison) or not (a receipt).
    pub fn has_texts(&self) -> bool {
        self.full_texts
    }

    /// The difference with objects named as the tool interface names them (rule OM9): created,
    /// changed and moved objects by their tool ids in `after`, deleted ones by theirs in `before`;
    /// the parents of positions the same way (`from` in `before`, `to` and `at` in `after`), and the
    /// value of a `ref` field (the id it holds) too; each list sorted again by id. A schema without
    /// tool ids leaves it as it is.
    ///
    /// An object without a tool id of its own that a nearer object with one holds
    /// ([`ToolIds::attributed`]: through `list` and `tree` fields and refs declared `owns`) is no
    /// entry of its own: its change is told as an edit of that object, at the path from it
    /// (`body.paragraphs.0`):
    ///
    /// - a changed field `f`: `{ field: "<path>.f", before, after }`, as the object's own edits;
    ///   a changed list or tree field is named in `fields` only, as an object's own are;
    /// - created: `{ field: "<path>", before: null, after: <its values> }`;
    /// - deleted: `{ field: "<path>", before: <its values>, after: null }`;
    /// - moved: `{ field: "<path of its list>", before: "<path before>", after: "<path after>" }`,
    ///   each side under its own holder (`null` on the side another holder has);
    /// - inside an object created by the same change, its values join that object's `values` at
    ///   their paths (`body.paragraphs.0.text`); inside one deleted by it, it is left out.
    ///
    /// Each such path is in `fields`, and the edits are sorted by field. A position whose parent
    /// is such an object names its holder and the path to the field (`{ parent: "shape:3", field:
    /// "body.paragraphs" }`), and a ref to one reads `<tool id>.<path>` (`shape:3.body`). A ref to
    /// an object no tool id names, held by none that has one (a layout, shared media), reads
    /// `{ "unnamed": "<type>" }` (the type the ref field declares): its object id is no name an
    /// agent can use, since a kit may mint it again on every read. A path through a map whose key
    /// is made of object ids (`<row id>:<column id>`) names each by its tool id, else its index in
    /// the list holding it (`table.cells.0:1`, [`ToolIds::attributed`]), when every one names such
    /// an object. Other objects with no
    /// holder that has a tool id keep their object ids.
    pub fn with_tool_ids(mut self, schema: &Schema, before: &ToolIds, after: &ToolIds) -> Self {
        if !before.is_active() && !after.is_active() {
            return self;
        }
        let mut text_basis = BTreeMap::<String, Map<String, Value>>::new();
        for (id, fields) in std::mem::take(&mut self.text_basis) {
            let object = ObjectId::from_string(&id);
            let (holder, path) =
                after.attributed(&object).map(|(holder, path)| (holder, format!("{path}."))).unwrap_or_else(|| (after.show(&object), String::new()));
            for (field, value) in fields {
                text_basis.entry(holder.clone()).or_default().insert(format!("{path}{field}"), before.show_text(&value));
            }
        }
        self.text_basis = text_basis;
        let mut spans = BTreeMap::<String, Map<String, Value>>::new();
        for (id, fields) in std::mem::take(&mut self.spans) {
            let object = ObjectId::from_string(&id);
            let (holder, path) =
                after.attributed(&object).map(|(holder, path)| (holder, format!("{path}."))).unwrap_or_else(|| (after.show(&object), String::new()));
            for (field, value) in fields {
                spans.entry(holder.clone()).or_default().insert(format!("{path}{field}"), value);
            }
        }
        self.spans = spans;
        let show = |names: &ToolIds, id: &str| {
            let object = ObjectId::from_string(id);
            match (names.tool_id(&object), names.attributed(&object)) {
                (None, Some((holder, path))) => format!("{holder}.{path}"),
                _ => names.show(&object),
            }
        };
        // A ref's value: the tool id, else `<tool id>.<path>` of a held object, else (an object no
        // tool id names, whose object id a kit may mint again on every read) `{ "unnamed": <its
        // type> }`.
        let show_value = |names: &ToolIds, value: &mut Value, of: Option<&str>| {
            if let Value::String(id) = value
                && !id.is_empty()
            {
                let object = ObjectId::from_string(id.as_str());
                match (names.tool_id(&object), names.attributed(&object)) {
                    (None, None) => *value = json!({ "unnamed": of.unwrap_or("object") }),
                    _ => *id = show(names, id),
                }
            }
        };
        let place = |names: &ToolIds, position: &mut Position| {
            let parent = ObjectId::from_string(position.parent.as_str());
            match (names.tool_id(&parent), names.attributed(&parent)) {
                (None, Some((holder, path))) => {
                    position.field = format!("{path}.{}", position.field);
                    position.parent = holder;
                }
                _ => position.parent = names.show(&parent),
            }
        };
        let types: BTreeMap<String, String> = self.created.iter().chain(self.changed.iter()).map(|change| (change.id.clone(), change.ty.clone())).collect();
        let is_ref = |ty: &str, field: &str| schema.field(ty, field).ok().is_some_and(|def| def.kind == FieldKind::Ref);
        let nested_refs = |ty: &str, field: &str| {
            schema.field(ty, field.split('.').next().unwrap_or(field)).ok().is_some_and(|def| matches!(def.kind, FieldKind::Json | FieldKind::Map))
        };
        let ref_of = |ty: &str, field: &str| schema.field(ty, field).ok().and_then(|def| def.of.clone());
        for text in &mut self.texts {
            if types.get(&text.id).is_some_and(|ty| is_ref(ty, &text.field)) {
                for (names, value) in [(before, &mut text.before), (after, &mut text.after)] {
                    if !value.is_empty() {
                        *value = show(names, value);
                    }
                }
            }
            if let Some((holder, path)) = after.attributed(&ObjectId::from_string(text.id.as_str())) {
                text.field = format!("{path}.{}", text.field);
                text.id = holder;
            } else {
                text.id = show(after, &text.id);
            }
        }
        for change in &mut self.created {
            for (field, value) in change.values.iter_mut().flatten() {
                if is_ref(&change.ty, field) {
                    show_value(after, value, ref_of(&change.ty, field).as_deref());
                } else if nested_refs(&change.ty, field) {
                    *value = after.show_json(value);
                }
            }
            if let Some(at) = &mut change.at {
                place(after, at);
            }
        }
        for change in &mut self.changed {
            for edit in change.edits.iter_mut().flatten() {
                if is_ref(&change.ty, &edit.field) {
                    let of = ref_of(&change.ty, &edit.field);
                    show_value(before, &mut edit.before, of.as_deref());
                    show_value(after, &mut edit.after, of.as_deref());
                } else if nested_refs(&change.ty, &edit.field) {
                    edit.before = before.show_json(&edit.before);
                    edit.after = after.show_json(&edit.after);
                }
            }
            // A ref to a held object reads as its path (`shape:3.body`): one replaced by another at
            // the same path reads the same, and is told by the held objects' own changes.
            let same: BTreeSet<String> = change
                .edits
                .iter()
                .flatten()
                .filter(|edit| is_ref(&change.ty, &edit.field) && edit.before.is_string() && edit.before == edit.after)
                .map(|edit| edit.field.clone())
                .collect();
            if !same.is_empty() {
                change.edits.get_or_insert_with(Vec::new).retain(|edit| !same.contains(&edit.field));
                change.fields.retain(|field| !same.contains(field));
            }
        }
        self.changed.retain(|change| !change.fields.is_empty());
        // The objects without tool ids their holders tell, taken out of the lists.
        let attributed = |names: &ToolIds, id: &str| names.attributed(&ObjectId::from_string(id));
        let created_ids: BTreeSet<String> = self.created.iter().map(|change| after.show(&ObjectId::from_string(change.id.as_str()))).collect();
        let deleted_ids: BTreeSet<String> = self.deleted.iter().map(|change| before.show(&ObjectId::from_string(change.id.as_str()))).collect();
        let mut told: BTreeMap<String, Told> = BTreeMap::new();
        let mut kept = Vec::new();
        for change in std::mem::take(&mut self.changed) {
            let Some((holder, path)) = attributed(after, &change.id) else {
                kept.push(change);
                continue;
            };
            let entry = told.entry(holder.clone()).or_default();
            entry.ty = after.type_of(&holder).unwrap_or_default().to_owned();
            if created_ids.contains(&holder) {
                for edit in change.edits.into_iter().flatten() {
                    entry.values.insert(format!("{path}.{}", edit.field), edit.after);
                }
                entry.fields.extend(change.fields.iter().map(|field| format!("{path}.{field}")));
                continue;
            }
            entry.fields.extend(change.fields.iter().map(|field| format!("{path}.{field}")));
            let named = after.named_path(&ObjectId::from_string(change.id.as_str()));
            entry.edits.extend(change.edits.into_iter().flatten().map(|edit| FieldEdit {
                field: format!("{path}.{}", edit.field),
                named: named.as_ref().map(|named| format!("{named}.{}", edit.field)),
                ..edit
            }));
        }
        self.changed = kept;
        let mut kept = Vec::new();
        for change in std::mem::take(&mut self.created) {
            let Some((holder, path)) = attributed(after, &change.id) else {
                kept.push(change);
                continue;
            };
            let entry = told.entry(holder.clone()).or_default();
            entry.ty = after.type_of(&holder).unwrap_or_default().to_owned();
            let values = change.values.unwrap_or_default();
            if created_ids.contains(&holder) {
                entry.fields.extend(change.fields.iter().map(|field| format!("{path}.{field}")));
                for (field, value) in values {
                    entry.values.insert(format!("{path}.{field}"), value);
                }
                continue;
            }
            entry.fields.push(path.clone());
            let named = after.named_path(&ObjectId::from_string(change.id.as_str()));
            entry.edits.push(FieldEdit { field: path, before: Value::Null, after: Value::Object(values), named });
        }
        self.created = kept;
        let mut kept = Vec::new();
        for change in std::mem::take(&mut self.deleted) {
            let Some((holder, path)) = attributed(before, &change.id) else {
                kept.push(change);
                continue;
            };
            if deleted_ids.contains(&holder) {
                continue;
            }
            let entry = told.entry(holder.clone()).or_default();
            entry.ty = before.type_of(&holder).unwrap_or_default().to_owned();
            let values = self.gone.get(&change.id).cloned().unwrap_or_default();
            entry.fields.push(path.clone());
            let named = before.named_path(&ObjectId::from_string(change.id.as_str()));
            entry.edits.push(FieldEdit { field: path, before: Value::Object(values), after: Value::Null, named });
        }
        self.deleted = kept;
        let list_of = |path: &str| -> String {
            match path.rsplit_once('.') {
                Some((list, index)) if index.parse::<usize>().is_ok() => list.to_owned(),
                _ => path.to_owned(),
            }
        };
        let mut kept = Vec::new();
        for moved in std::mem::take(&mut self.moved) {
            let (from, to) = (attributed(before, &moved.id), attributed(after, &moved.id));
            if from.is_none() && to.is_none() {
                kept.push(moved);
                continue;
            }
            match (from, to) {
                (Some((was, from)), Some((now, to))) if was == now => {
                    if !created_ids.contains(&now) {
                        let entry = told.entry(now.clone()).or_default();
                        entry.ty = after.type_of(&now).unwrap_or_default().to_owned();
                        entry.fields.push(list_of(&to));
                        entry.edits.push(FieldEdit { field: list_of(&to), before: Value::String(from), after: Value::String(to), named: None });
                    }
                }
                (from, to) => {
                    if let Some((was, from)) = from
                        && !deleted_ids.contains(&was)
                    {
                        let entry = told.entry(was.clone()).or_default();
                        entry.ty = before.type_of(&was).unwrap_or_default().to_owned();
                        entry.fields.push(list_of(&from));
                        entry.edits.push(FieldEdit { field: list_of(&from), before: Value::String(from), after: Value::Null, named: None });
                    }
                    if let Some((now, to)) = to
                        && !created_ids.contains(&now)
                    {
                        let entry = told.entry(now.clone()).or_default();
                        entry.ty = after.type_of(&now).unwrap_or_default().to_owned();
                        entry.fields.push(list_of(&to));
                        entry.edits.push(FieldEdit { field: list_of(&to), before: Value::Null, after: Value::String(to), named: None });
                    }
                }
            }
        }
        self.moved = kept;
        for told in told.values_mut() {
            told.replaced_in_place();
        }
        for change in self.created.iter_mut().chain(self.changed.iter_mut()) {
            change.id = after.show(&ObjectId::from_string(change.id.as_str()));
        }
        for change in &mut self.deleted {
            let shown = before.show(&ObjectId::from_string(change.id.as_str()));
            if let Some(values) = self.gone.remove(&change.id) {
                self.gone.insert(shown.clone(), values);
            }
            change.id = shown;
            if let Some(at) = &mut change.at {
                place(before, at);
            }
        }
        for moved in &mut self.moved {
            moved.id = after.show(&ObjectId::from_string(moved.id.as_str()));
            if let Some(from) = &mut moved.from {
                place(before, from);
            }
            if let Some(to) = &mut moved.to {
                place(after, to);
            }
        }
        // What the held objects changed, as their holders' own.
        for (holder, told) in told {
            if let Some(created) = self.created.iter_mut().find(|change| change.id == holder) {
                created.fields.extend(told.fields);
                created.fields.sort();
                created.fields.dedup();
                created.values.get_or_insert_with(Map::new).extend(told.values);
                continue;
            }
            if told.fields.is_empty() && told.edits.is_empty() {
                continue;
            }
            let index = match self.changed.iter().position(|change| change.id == holder) {
                Some(index) => index,
                None => {
                    self.changed.push(ObjectChange { id: holder, ty: told.ty, edits: Some(Vec::new()), ..ObjectChange::default() });
                    self.changed.len() - 1
                }
            };
            if let Some(change) = self.changed.get_mut(index) {
                change.fields.extend(told.fields);
                change.fields.sort();
                change.fields.dedup();
                let edits = change.edits.get_or_insert_with(Vec::new);
                edits.extend(told.edits);
                edits.sort_by(|a, b| a.field.cmp(&b.field));
            }
        }
        for list in [&mut self.created, &mut self.changed, &mut self.deleted] {
            list.sort_by(|a, b| a.id.cmp(&b.id));
        }
        self.moved.sort_by(|a, b| a.id.cmp(&b.id));
        self.texts.sort_by(|a, b| (&a.id, &a.field).cmp(&(&b.id, &b.field)));
        self
    }

    /// The difference with a changed `map` or `json` field told where it changed: a
    /// `map` field (one that does not own its objects) by key, one edit per changed key
    /// (`{ field: "attrs.stretch", before: 100, after: 200 }`, `null` for a key added or taken
    /// out); a `json` value, and each changed key's value of a map, down to its changed leaves
    /// (object members, the items of two arrays of one length: `look.kind.start`) when that is
    /// at most [`LEAF_EDITS`] edits and fewer bytes than the value whole, else whole. Each edit's
    /// path replaces the field in `fields`. Apply it before [`StateDiff::with_tool_ids`], which
    /// puts a held object's paths under its holder.
    pub fn with_leaf_edits(mut self, schema: &Schema) -> Self {
        for change in &mut self.changed {
            let Some(edits) = change.edits.as_mut() else { continue };
            let mut split: BTreeMap<String, Vec<FieldEdit>> = BTreeMap::new();
            for edit in edits.iter() {
                let Ok(def) = schema.field(&change.ty, &edit.field) else { continue };
                let finer = match def.kind {
                    FieldKind::Map if !def.owns => by_key(&edit.field, &edit.before, &edit.after),
                    FieldKind::Json => finer(&edit.field, &edit.before, &edit.after),
                    _ => continue,
                };
                if !matches!(finer.as_slice(), [one] if one.field == edit.field) {
                    split.insert(edit.field.clone(), finer);
                }
            }
            if split.is_empty() {
                continue;
            }
            let mut out: Vec<FieldEdit> = Vec::new();
            for edit in std::mem::take(edits) {
                match split.remove(&edit.field) {
                    Some(finer) => {
                        change.fields.retain(|field| *field != edit.field);
                        change.fields.extend(finer.iter().map(|edit| edit.field.clone()));
                        out.extend(finer);
                    }
                    None => out.push(edit),
                }
            }
            out.sort_by(|a, b| a.field.cmp(&b.field));
            *edits = out;
            change.fields.sort();
            change.fields.dedup();
        }
        self
    }

    /// The difference as a receipt gives it: without `texts`.
    pub fn without_texts(mut self) -> Self {
        self.full_texts = false;
        self.texts.clear();
        self
    }

    /// Counts in `unnamed`, and takes out of the lists, every object named by no tool id: one
    /// `before` (deleted) or `after` (the others) does not name, but a change `keep` keeps (the
    /// root's own fields).
    pub(crate) fn count_unnamed(&mut self, before: &ToolIds, after: &ToolIds, keep: &dyn Fn(&ObjectChange) -> bool) {
        let mut count = |ty: &str, list: &str| *self.unnamed.entry(ty.to_owned()).or_default().entry(list.to_owned()).or_default() += 1;
        for (list, changes, names) in [("created", &mut self.created, after), ("changed", &mut self.changed, after), ("deleted", &mut self.deleted, before)] {
            changes.retain(|change| {
                let named = names.type_of(&change.id).is_some() || keep(change);
                if !named {
                    count(&change.ty, list);
                    self.unnamed_objects.entry(list.to_owned()).or_default().push(serde_json::to_value(change).unwrap_or(Value::Null));
                }
                named
            });
        }
        self.moved.retain(|moved| {
            let named = after.type_of(&moved.id).is_some();
            if !named {
                count(&moved.ty, "moved");
                self.unnamed_objects.entry("moved".into()).or_default().push(serde_json::to_value(moved).unwrap_or(Value::Null));
            }
            named
        });
    }

    /// Takes the objects whose tool ids were renumbered (`ids`) out of the lists and names them in
    /// `renumbered`.
    pub(crate) fn set_renumbered(&mut self, ids: &BTreeSet<String>) {
        for list in [&mut self.created, &mut self.changed, &mut self.deleted] {
            list.retain(|change| !ids.contains(&change.id));
        }
        self.moved.retain(|moved| !ids.contains(&moved.id));
        self.renumbered = ids.iter().cloned().collect();
    }

    /// As JSON: `{ created, changed, moved, deleted, texts? }`, objects as `{ id, type, fields, … }`.
    pub fn to_json(&self) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or(Value::Null);
        if !self.full_texts
            && let Some(object) = value.as_object_mut()
        {
            object.remove("texts");
        }
        value
    }

    /// Journal JSON, including deleted scalar/JSON values in `$was` so coverage callbacks can
    /// reconstruct historical predicate matches. Public receipts leave this metadata out.
    pub fn to_recorded_json(&self, schema: &Schema) -> Value {
        let mut value = self.to_located_json();
        if !self.text_basis.is_empty()
            && let Some(object) = value.as_object_mut()
        {
            object.insert("$text".into(), json!(self.text_basis));
        }
        if !self.unnamed_objects.is_empty()
            && let Some(fields) = value.as_object_mut()
        {
            fields.insert("$unnamed".into(), json!(self.unnamed_objects));
        }
        for deleted in value.get_mut("deleted").and_then(Value::as_array_mut).into_iter().flatten() {
            let (Some(id), Some(ty)) = (deleted["id"].as_str().map(str::to_owned), deleted["type"].as_str().map(str::to_owned)) else { continue };
            let Some(values) = self.gone.get(&id) else { continue };
            let Ok(def) = schema.type_def(&ty) else { continue };
            let was: Map<String, Value> = values
                .iter()
                .filter(|(field, _)| field.starts_with('~') || def.fields.contains_key(field.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            if !was.is_empty() {
                deleted["$was"] = Value::Object(was);
            }
        }
        value
    }

    /// Receipt JSON with bounded character offsets and replacement text for long fields.
    /// `complete:false` spans describe the location but cannot be replayed as a patch.
    pub fn to_located_json(&self) -> Value {
        let mut value = self.to_json();
        for object in value.get_mut("changed").and_then(Value::as_array_mut).into_iter().flatten() {
            let Some(fields) = object.get("id").and_then(Value::as_str).and_then(|id| self.spans.get(id)) else { continue };
            for edit in object.get_mut("edits").and_then(Value::as_array_mut).into_iter().flatten() {
                let span = edit.get("field").and_then(Value::as_str).and_then(|field| fields.get(field)).cloned();
                if let (Some(span), Some(edit)) = (span, edit.as_object_mut()) {
                    if span.is_null() {
                        edit.insert("spansTruncated".into(), json!(true));
                    } else {
                        edit.insert("span".into(), span);
                    }
                }
            }
        }
        value
    }
}

/// What the objects without tool ids an object holds changed, told as that object's change.
#[derive(Default)]
struct Told {
    ty: String,
    fields: Vec<String>,
    edits: Vec<FieldEdit>,
    /// For an object the same change created: the held objects' values, at their paths.
    values: Map<String, Value>,
}

impl Told {
    /// An object deleted at a path and another created at the same path (a paragraph replaced, a
    /// text body made again) are one object changed there: their values are compared, and each
    /// that differs is an edit at `<path>.<field>`; equal values tell nothing.
    fn replaced_in_place(&mut self) {
        let side = |edit: &FieldEdit, made: bool| {
            let (gone, now) = if made { (&edit.before, &edit.after) } else { (&edit.after, &edit.before) };
            gone.is_null() && now.is_object()
        };
        let created: BTreeMap<String, Map<String, Value>> =
            self.edits.iter().filter(|edit| side(edit, true)).filter_map(|edit| Some((edit.field.clone(), edit.after.as_object()?.clone()))).collect();
        let deleted: BTreeMap<String, Map<String, Value>> =
            self.edits.iter().filter(|edit| side(edit, false)).filter_map(|edit| Some((edit.field.clone(), edit.before.as_object()?.clone()))).collect();
        let both: BTreeSet<String> = created.keys().filter(|path| deleted.contains_key(*path)).cloned().collect();
        if both.is_empty() {
            return;
        }
        let named: BTreeMap<String, String> =
            self.edits.iter().filter(|edit| both.contains(&edit.field)).filter_map(|edit| Some((edit.field.clone(), edit.named.clone()?))).collect();
        self.edits.retain(|edit| !both.contains(&edit.field));
        self.fields.retain(|field| !both.contains(field));
        for path in &both {
            let (Some(was), Some(now)) = (deleted.get(path), created.get(path)) else { continue };
            let names: BTreeSet<&String> = was.keys().chain(now.keys()).collect();
            for name in names {
                let (before, after) = (was.get(name).cloned().unwrap_or(Value::Null), now.get(name).cloned().unwrap_or(Value::Null));
                if before != after {
                    let field = format!("{path}.{name}");
                    self.fields.push(field.clone());
                    let named = named.get(path).map(|named| format!("{named}.{name}"));
                    self.edits.push(FieldEdit { field, before, after, named });
                }
            }
        }
    }
}

const TYPE_KEY: &str = "$type";

/// A tree's value (`[{ object, children }]`) without the nodes naming no live object, each with
/// its subtree, as reads skip them; `None` when it has none. The canonical state keeps the node of
/// a deleted object ([`crate::Tx::delete`]); a change set compares the trees as read, so a
/// deletion in a tree is told at its place and the later siblings' indexes shift.
pub(crate) fn live_nodes(nodes: &Value, live: &dyn Fn(&str) -> bool) -> Option<Value> {
    fn dead(nodes: &Value, live: &dyn Fn(&str) -> bool) -> bool {
        nodes.as_array().into_iter().flatten().any(|node| {
            node.get("object").and_then(Value::as_str).is_none_or(|object| !live(object)) || node.get("children").is_some_and(|children| dead(children, live))
        })
    }
    fn kept(nodes: &Value, live: &dyn Fn(&str) -> bool) -> Value {
        Value::Array(
            nodes
                .as_array()
                .into_iter()
                .flatten()
                .filter(|node| node.get("object").and_then(Value::as_str).is_some_and(live))
                .map(|node| {
                    let mut node = node.clone();
                    if let Some(children) = node.get_mut("children") {
                        *children = kept(children, live);
                    }
                    node
                })
                .collect(),
        )
    }
    (is_tree(nodes) && dead(nodes, live)).then(|| kept(nodes, live))
}

/// `object`'s tree fields as reads see them ([`live_nodes`]).
pub(crate) fn with_live_nodes(object: &mut Value, live: &dyn Fn(&str) -> bool) {
    for value in object.as_object_mut().into_iter().flat_map(|fields| fields.values_mut()) {
        if let Some(kept) = live_nodes(value, live) {
            *value = kept;
        }
    }
}

/// A canonical state with its trees as reads see them ([`live_nodes`]).
pub(crate) fn without_dead_nodes(state: &Value) -> Value {
    let mut out = state.clone();
    let objects = objects(state);
    let live = |id: &str| objects.contains_key(id);
    for object in out.get_mut("objects").and_then(Value::as_object_mut).into_iter().flat_map(|objects| objects.values_mut()) {
        with_live_nodes(object, &live);
    }
    out
}

fn objects(state: &Value) -> Map<String, Value> {
    state.get("objects").and_then(Value::as_object).cloned().unwrap_or_default()
}

fn type_of(object: &Value) -> String {
    object.get(TYPE_KEY).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn fields_of(object: &Value) -> Map<String, Value> {
    let mut fields = object.as_object().cloned().unwrap_or_default();
    fields.remove(TYPE_KEY);
    fields
}

fn holds_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
        _ => true,
    }
}

/// A field's text: a string, or a marked text's runs (`[{ insert, attributes? }]`) joined.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(runs) if !runs.is_empty() && runs.iter().all(|run| run.get("insert").is_some_and(Value::is_string)) => {
            Some(runs.iter().filter_map(|run| run.get("insert").and_then(Value::as_str)).collect())
        }
        _ => None,
    }
}

/// How a field's values read in a state: the items of a list, the nodes of a tree, or a value.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape {
    List,
    Tree,
    Value,
}

/// Whether `value` reads as a tree: `[{ object, children }]`, not empty.
fn is_tree(value: &Value) -> bool {
    value.as_array().is_some_and(|nodes| {
        !nodes.is_empty() && nodes.iter().all(|node| node.get("object").is_some_and(Value::is_string) && node.get("children").is_some_and(Value::is_array))
    })
}

/// Whether `value` reads as a list of objects: object ids of the document, not empty.
fn is_list(value: &Value, known: &dyn Fn(&str) -> bool) -> bool {
    value.as_array().is_some_and(|items| !items.is_empty() && items.iter().all(|item| item.as_str().is_some_and(known)))
}

fn is_empty_or_null(value: &Value) -> bool {
    value.is_null() || value.as_array().is_some_and(Vec::is_empty)
}

/// The shape of a field from its values before and after (either may be `null`): a list or tree
/// when one side reads as one and the other as one too or empty. The canonical state holds no
/// field kinds, so they are read from the values, the same in both implementations.
fn shape_of(was: &Value, now: &Value, known: &dyn Fn(&str) -> bool) -> Shape {
    let fits = |test: &dyn Fn(&Value) -> bool| (test(was) || test(now)) && (test(was) || is_empty_or_null(was)) && (test(now) || is_empty_or_null(now));
    if fits(&is_tree) {
        Shape::Tree
    } else if fits(&|value: &Value| is_list(value, known)) {
        Shape::List
    } else {
        Shape::Value
    }
}

/// A blob's value (`{ hash, mime, size }`), as its size only.
fn blob_size(value: &Value) -> Option<u64> {
    let object = value.as_object()?;
    (object.get("hash").is_some_and(Value::is_string) && object.get("mime").is_some_and(Value::is_string)).then_some(())?;
    object.get("size").and_then(Value::as_u64)
}

/// A text as a change shows it: whole up to [`EXCERPT_CHARS`] characters, else
/// `{ excerpt, length }`, an excerpt of at most that many characters from about `start` (the
/// first character that changed) cut at character boundaries with `…`, and the full length.
fn shown_text(text: &str, start: usize) -> Value {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= EXCERPT_CHARS {
        return Value::String(text.to_owned());
    }
    let from = start.saturating_sub(EXCERPT_LEAD).min(chars.len());
    let mut budget = EXCERPT_CHARS;
    let mut excerpt = String::new();
    if from > 0 {
        excerpt.push(ELLIPSIS);
        budget -= 1;
    }
    let rest = chars.get(from..).unwrap_or_default();
    if rest.len() <= budget {
        excerpt.extend(rest);
    } else {
        excerpt.extend(rest.iter().take(budget - 1));
        excerpt.push(ELLIPSIS);
    }
    json!({ "excerpt": excerpt, "length": chars.len() })
}

/// A field's value as a change shows it: a text as [`shown_text`] does, a blob as `{ size }`,
/// anything else as it is.
pub fn shown_value(value: &Value, start: usize) -> Value {
    if let Some(size) = blob_size(value) {
        return json!({ "size": size });
    }
    match text_of(value) {
        Some(text) => shown_text(&text, start),
        None => value.clone(),
    }
}

/// A basis blob is an addressable reference, even when its bytes are no longer available.
fn basis_value(value: &Value, start: usize) -> Value {
    if blob_size(value).is_some() { value.clone() } else { shown_value(value, start) }
}

/// Whether a value is what [`shown_value`] made of a long text or a blob (`{ excerpt, length }`,
/// `{ size }`): a leaf, never looked into.
fn is_shown(value: &Value) -> bool {
    if blob_size(value).is_some() {
        return true;
    }
    value.as_object().is_some_and(|object| {
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        keys == ["excerpt", "length"] || keys == ["size"]
    })
}

/// The edits from `a` to `b` at `path`, down to the leaves that differ: object members, and the
/// items of two arrays of one length; anything else is one edit.
fn leaves(path: &str, a: &Value, b: &Value, out: &mut Vec<FieldEdit>) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) if !is_shown(a) && !is_shown(b) => {
            let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let (p, q) = (x.get(key).unwrap_or(&Value::Null), y.get(key).unwrap_or(&Value::Null));
                if p != q {
                    leaves(&format!("{path}.{key}"), p, q, out);
                }
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (index, (p, q)) in x.iter().zip(y).enumerate() {
                if p != q {
                    leaves(&format!("{path}.{index}"), p, q, out);
                }
            }
        }
        _ => out.push(FieldEdit { field: path.to_owned(), before: basis_value(a, 0), after: shown_value(b, 0), named: None }),
    }
}

/// The bytes edits take, as a change set writes them.
fn edits_size(edits: &[FieldEdit]) -> usize {
    edits.iter().map(|edit| edit.field.len() + edit.before.to_string().len() + edit.after.to_string().len()).sum()
}

/// A `json` value's change: down to its changed leaves when that is at most [`LEAF_EDITS`] edits
/// and fewer bytes than the value whole, else whole.
fn finer(path: &str, a: &Value, b: &Value) -> Vec<FieldEdit> {
    let whole = vec![FieldEdit { field: path.to_owned(), before: basis_value(a, 0), after: shown_value(b, 0), named: None }];
    let mut found = Vec::new();
    leaves(path, a, b, &mut found);
    if found.len() <= LEAF_EDITS && edits_size(&found) < edits_size(&whole) { found } else { whole }
}

/// A `map` field's change, one edit per changed key, each key's value as [`finer`] tells it.
fn by_key(path: &str, a: &Value, b: &Value) -> Vec<FieldEdit> {
    let empty = Map::new();
    let (Some(x), Some(y)) = (a.as_object().or(a.is_null().then_some(&empty)), b.as_object().or(b.is_null().then_some(&empty))) else {
        return vec![FieldEdit { field: path.to_owned(), before: a.clone(), after: b.clone(), named: None }];
    };
    let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
    keys.sort();
    keys.dedup();
    let mut out = Vec::new();
    for key in keys {
        let (p, q) = (x.get(key).unwrap_or(&Value::Null), y.get(key).unwrap_or(&Value::Null));
        if p != q {
            out.extend(finer(&format!("{path}.{key}"), p, q));
        }
    }
    out
}

/// How many leading characters two texts share.
fn common_prefix(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count()
}

/// One replacement in Unicode scalar offsets, bounded to 80 changed and 20 context characters
/// per side. Serialized metadata is at most 2 KiB even for escaped control characters.
pub fn text_span(before: &str, after: &str) -> Option<Value> {
    if before == after || before.chars().count() <= EXCERPT_CHARS {
        return None;
    }
    let (a, b): (Vec<_>, Vec<_>) = (before.chars().collect(), after.chars().collect());
    let offset = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
    let suffix = a.iter().skip(offset).rev().zip(b.iter().skip(offset).rev()).take_while(|(a, b)| a == b).count();
    let removed_length = a.len() - offset - suffix;
    let inserted_length = b.len() - offset - suffix;
    Some(json!({"offset":offset,
        "removed":a.iter().skip(offset).take(removed_length.min(80)).collect::<String>(),
        "inserted":b.iter().skip(offset).take(inserted_length.min(80)).collect::<String>(),
        "removedLength":removed_length,"insertedLength":inserted_length,
        "before":a.iter().skip(offset.saturating_sub(20)).take(offset.min(20)).collect::<String>(),
        "after":a.iter().skip(a.len()-suffix).take(20).collect::<String>(),
        "complete":removed_length<=80 && inserted_length<=80}))
}

/// A place in a list or tree: the field's owner, the field, and the parent the item sits under.
type Group = (String, String, String);

/// Every object's first place in the list and tree fields read, and each place's items in order.
#[derive(Default)]
struct Places {
    at: BTreeMap<String, (Group, usize)>,
}

impl Places {
    fn add(&mut self, owner: &str, field: &str, value: &Value, shape: Shape) {
        match shape {
            Shape::List => {
                let group: Group = (owner.to_owned(), field.to_owned(), owner.to_owned());
                for (index, item) in value.as_array().into_iter().flatten().filter_map(Value::as_str).enumerate() {
                    self.at.entry(item.to_owned()).or_insert_with(|| (group.clone(), index));
                }
            }
            Shape::Tree => self.add_nodes(owner, field, owner, value),
            Shape::Value => {}
        }
    }

    fn add_nodes(&mut self, owner: &str, field: &str, parent: &str, nodes: &Value) {
        let group: Group = (owner.to_owned(), field.to_owned(), parent.to_owned());
        for (index, node) in nodes.as_array().into_iter().flatten().enumerate() {
            let Some(object) = node.get("object").and_then(Value::as_str) else { continue };
            self.at.entry(object.to_owned()).or_insert_with(|| (group.clone(), index));
            if let Some(children) = node.get("children") {
                self.add_nodes(owner, field, object, children);
            }
        }
    }

    fn position(&self, id: &str) -> Option<Position> {
        self.at.get(id).map(|((_, field, parent), index)| Position { parent: parent.clone(), field: field.clone(), index: *index })
    }
}

/// The indices of a longest strictly increasing subsequence of `seq`: patience sorting, each
/// value placed on the leftmost pile whose top is not smaller, read back from the last pile. The
/// TypeScript twin picks the same one.
fn longest_increasing(seq: &[usize]) -> BTreeSet<usize> {
    let mut tops: Vec<usize> = Vec::new();
    let mut previous: Vec<Option<usize>> = vec![None; seq.len()];
    for (at, value) in seq.iter().enumerate() {
        let pile = tops.partition_point(|&top| seq.get(top).is_some_and(|top| top < value));
        if pile > 0
            && let Some(slot) = previous.get_mut(at)
        {
            *slot = tops.get(pile - 1).copied();
        }
        if pile == tops.len() {
            tops.push(at);
        } else if let Some(top) = tops.get_mut(pile) {
            *top = at;
        }
    }
    let mut kept = BTreeSet::new();
    let mut at = tops.last().copied();
    while let Some(index) = at {
        kept.insert(index);
        at = previous.get(index).copied().flatten();
    }
    kept
}

/// The difference of the objects `ids` (sorted) between two sides, each the canonical objects it
/// has among them; `type_of_id` answers the type of an object of either side (after, else
/// before), `None` for an id that names none. Answers with `texts` when `full_texts`.
pub(crate) fn diff_objects(
    ids: &[String],
    old: &Map<String, Value>,
    new: &Map<String, Value>,
    type_of_id: &dyn Fn(&str) -> Option<String>,
    full_texts: bool,
) -> StateDiff {
    let known = |id: &str| type_of_id(id).is_some();
    let known: &dyn Fn(&str) -> bool = &known;
    let mut diff = StateDiff { full_texts, ..StateDiff::default() };
    let mut text_basis_bytes = 0;
    let mut span_bytes = 0;
    let (mut before, mut after) = (Places::default(), Places::default());
    let mut created_ids = BTreeSet::new();
    let mut deleted_ids = BTreeSet::new();
    for id in ids {
        match (old.get(id), new.get(id)) {
            (None, Some(object)) => {
                created_ids.insert(id.clone());
                let fields = fields_of(object);
                // Sorted here: a `serde_json` built with `preserve_order` keeps insertion order.
                let mut held: Vec<String> = fields.iter().filter(|(_, value)| holds_value(value)).map(|(name, _)| name.clone()).collect();
                held.sort();
                let mut values = Map::new();
                for name in &held {
                    let value = fields.get(name).unwrap_or(&Value::Null);
                    let shape = if name.starts_with('~') { Shape::Value } else { shape_of(&Value::Null, value, known) };
                    if shape == Shape::Value {
                        values.insert(name.clone(), shown_value(value, 0));
                    } else {
                        after.add(id, name, value, shape);
                    }
                    if full_texts && let Some(text) = text_of(value).filter(|text| !text.is_empty()) {
                        diff.texts.push(TextChange { id: id.clone(), field: name.clone(), before: String::new(), after: text });
                    }
                }
                diff.created.push(ObjectChange { id: id.clone(), ty: type_of(object), fields: held, values: Some(values), ..ObjectChange::default() });
            }
            (Some(object), None) => {
                deleted_ids.insert(id.clone());
                let fields = fields_of(object);
                let mut names: Vec<&String> = fields.keys().collect();
                names.sort();
                let mut values = Map::new();
                for name in names {
                    let value = fields.get(name).unwrap_or(&Value::Null);
                    let shape = if name.starts_with('~') { Shape::Value } else { shape_of(value, &Value::Null, known) };
                    if shape == Shape::Value && holds_value(value) {
                        values.insert(name.clone(), basis_value(value, 0));
                    }
                    before.add(id, name, value, shape);
                }
                diff.gone.insert(id.clone(), values);
                diff.deleted.push(ObjectChange { id: id.clone(), ty: type_of(object), ..ObjectChange::default() });
            }
            (Some(was), Some(now)) if was != now => {
                let (was_fields, now_fields) = (fields_of(was), fields_of(now));
                let mut names: Vec<&String> = was_fields.keys().chain(now_fields.keys()).collect();
                names.sort();
                names.dedup();
                let mut fields = Vec::new();
                let mut edits = Vec::new();
                if type_of(was) != type_of(now) {
                    fields.push(TYPE_KEY.to_owned());
                    edits.push(FieldEdit { field: TYPE_KEY.to_owned(), before: was[TYPE_KEY].clone(), after: now[TYPE_KEY].clone(), named: None });
                }
                for name in names {
                    let (a, b) = (was_fields.get(name).unwrap_or(&Value::Null), now_fields.get(name).unwrap_or(&Value::Null));
                    if a == b {
                        continue;
                    }
                    let shape = if name.starts_with('~') { Shape::Value } else { shape_of(a, b, known) };
                    if shape != Shape::Tree {
                        fields.push(name.clone());
                    }
                    if shape != Shape::Value {
                        before.add(id, name, a, shape);
                        after.add(id, name, b, shape);
                        continue;
                    }
                    let text = |value: &Value| if value.is_null() { Some(String::new()) } else { text_of(value) };
                    let start = match (text(a), text(b)) {
                        (Some(before), Some(after)) => {
                            let start = common_prefix(&before, &after);
                            if let Some(span) = text_span(&before, &after) {
                                let bytes = span.to_string().len();
                                if span_bytes + bytes <= 65_536 {
                                    diff.spans.entry(id.clone()).or_default().insert(name.clone(), span);
                                    span_bytes += bytes;
                                } else {
                                    diff.spans.entry(id.clone()).or_default().insert(name.clone(), Value::Null);
                                }
                            }
                            let bytes = a.to_string().len();
                            if bytes <= 1_048_576 && text_basis_bytes + bytes <= 4_194_304 {
                                diff.text_basis.entry(id.clone()).or_default().insert(name.clone(), a.clone());
                                text_basis_bytes += bytes;
                            }
                            if full_texts && before != after {
                                diff.texts.push(TextChange { id: id.clone(), field: name.clone(), before, after });
                            }
                            start
                        }
                        _ => 0,
                    };
                    edits.push(FieldEdit { field: name.clone(), before: basis_value(a, start), after: shown_value(b, start), named: None });
                }
                let ty = if type_of(now).is_empty() { type_of(was) } else { type_of(now) };
                if !fields.is_empty() {
                    diff.changed.push(ObjectChange { id: id.clone(), ty, fields, edits: Some(edits), ..ObjectChange::default() });
                }
            }
            _ => {}
        }
    }
    for change in &mut diff.created {
        change.at = after.position(&change.id);
    }
    for change in &mut diff.deleted {
        change.at = before.position(&change.id);
    }
    // The items each place keeps (there before and after), in their order after; of them, those
    // outside a longest run in their order before moved.
    let mut kept_in: BTreeMap<&Group, Vec<(&String, usize, usize)>> = BTreeMap::new();
    for (id, (group, index)) in &after.at {
        if let Some((was_group, was_index)) = before.at.get(id)
            && was_group == group
        {
            kept_in.entry(group).or_default().push((id, *was_index, *index));
        }
    }
    let mut stayed: BTreeSet<&String> = BTreeSet::new();
    for items in kept_in.values_mut() {
        items.sort_by_key(|(_, _, index)| *index);
        let order: Vec<usize> = items.iter().map(|(_, was_index, _)| *was_index).collect();
        for at in longest_increasing(&order) {
            if let Some((id, _, _)) = items.get(at) {
                stayed.insert(*id);
            }
        }
    }
    let placed: BTreeSet<&String> = before.at.keys().chain(after.at.keys()).collect();
    for id in placed {
        if created_ids.contains(id) || deleted_ids.contains(id) || stayed.contains(id) {
            continue;
        }
        let ty = type_of_id(id).unwrap_or_default();
        diff.moved.push(Move { id: id.clone(), ty, from: before.position(id), to: after.position(id) });
    }
    diff
}

/// The difference `before → after` of two canonical states ([`crate::Replica::state_json`]): a
/// draft's comparison, with `texts`. It is the reference [`crate::Replica::changes_since`] is
/// tested against.
pub fn diff_states(before: &Value, after: &Value) -> StateDiff {
    let (old, new) = (objects(&without_dead_nodes(before)), objects(&without_dead_nodes(after)));
    let mut ids: Vec<String> = old.keys().chain(new.keys()).cloned().collect();
    ids.sort();
    ids.dedup();
    let type_of_id = |id: &str| new.get(id).or_else(|| old.get(id)).map(type_of);
    diff_objects(&ids, &old, &new, &type_of_id, true)
}
