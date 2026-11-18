// Copied from kition-sdk crates/kition-kdm/src/reread.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Two reads of one document's file compared: what changed when another
//! program changed the file and the kit read it again.
//!
//! A kit that builds its replica from its file mints new object ids on every read (Kition platform
//! `docs/platform/data-model.md`, "Ids of a file opened again"): only tool ids survive, and often
//! the root's id, which a kit may keep constant. Compared by object id, two reads of the same file
//! differ in every object without a tool id. So the objects of the two reads are first paired
//! ([`pair`]), then the read before is named as the read after names its objects, and the two are
//! compared as any two states are ([`crate::diff::diff_states`],
//! [`crate::diff::StateDiff::with_tool_ids`]). The pairing, in this order:
//!
//! 1. An object id both reads have, on objects of one type, pairs THAT object (a tool id, a root
//!    whose id is constant, any object id a kit kept). Pairing is per object, never all or
//!    nothing: a constant root says nothing about the other objects.
//! 2. The roots pair.
//! 3. When at least half of the objects of the read before that are no root and have no tool id
//!    kept their ids, the kit keeps object ids: an id only one read has is an object only that
//!    read has, and the pairing ends here. Otherwise (a kit that mints ids):
//! 4. From each pair, the objects the two hold through the same owning field (a `list` or `tree`
//!    field, a `ref` or `map` declared `owns`) pair by their place: a ref's object with the
//!    other's; a map's under the same key (a key read through the pairing, so `<row>:<col>` keys
//!    of paired rows and columns match); a list's (a tree's, under each pair of parent nodes) by
//!    content first, each object paired with the first unpaired one of equal content, then, between
//!    the paired ones that keep their order, the rest in order. So inserting a paragraph pairs every
//!    other paragraph with its equal, and editing one pairs it with the one at its place.
//! 5. Objects no owning field holds (none in a well-formed document, which the read walks from its
//!    root) pair by equal content, and step 4 goes on from them.
//!
//! Ids inside values. An object id may sit anywhere in a value that is not text: a ref, a list, a
//! tree, a map's values and keys, a json value at any depth (`look.kind.fill.media`, a paragraph's
//! `endProps`), a json object's keys. In the fields of those kinds (never in a `string` or `text`
//! field, so no text a person typed is ever read as an id), a string is an id when the WHOLE string
//! equals the id of an object of the read; an object key is an id when the whole key is one, or
//! else each of its `:`-separated segments that is one (`<row id>:<col id>`). Nothing else is: no
//! substring, no other separator. Contents are compared, and fingerprinted, with each such id
//! read through the pairing (its partner's id, or, for a fingerprint, the tool id or type of its
//! object), so a value that differs only by ids of paired objects is unchanged.
//!
//! Content is compared without ids: an object's type and fields, the objects it holds by their
//! content, and a ref that only points by the tool id of its object, or its type.
//!
//! What is left unpaired was deleted or created. A ref to an object of the other read compares
//! equal when the two are paired (a picture whose shared media got a new id did not change).
//!
//! Renumbered tool ids. Another program may give objects new numbers (two shapes on a slide swap
//! their numbers, their content unchanged): paired by tool id, each would read as changed into the
//! other. When an object paired by its tool id differs from its partner (its content without the
//! tool id's own field) while it equals the partner of ANOTHER object paired by tool id that also
//! differs from its own, the tool ids were moved between objects, and what changed in them cannot
//! be told: those objects are [`Pairing::renumbered`], left out of the change ([`diff_read_again`]
//! lists them in `renumbered` instead). Only a whole exchange counts: each object's
//! content, `position` fields and its place in its holder's list included, went to another such
//! object, round a cycle. Clips a ripple edit moved along a track (each now where the next was)
//! make no cycle; two objects whose names alone another program swapped keep their places and are
//! two changes. An exchange of objects that differ in one field alone (or their place alone) is
//! explained as well by a swap of that field, and is read as two changes (the guard then refuses a
//! write on either as `changed`, which is right under both readings).
//!
//! In a document whose object ids were minted again, an object without a tool id that no object
//! with a tool id holds (a slide master, a layout, shared media, the root) has no name an agent
//! could use: its changes are counted by type (`unnamed`), never listed.
//!
//! Each object is fingerprinted once and each list paired in `O(n log n)`, so the pairing is
//! `O(N log N)` in the objects of both reads.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::hash::{Hash, Hasher};

use serde_json::{Map, Value};

use crate::diff::{StateDiff, diff_states};
use crate::tool_ids::ToolIds;
use crate::{FieldDef, FieldKind, ObjectId, Schema};

/// How deep the content of nested objects is read.
const DEPTH: usize = 64;

/// What [`pair`] found: each object of the read before paired with one of the read after.
#[derive(Clone, Debug, Default)]
pub struct Pairing {
    /// Read before to read after.
    pairs: BTreeMap<String, String>,
    /// Whether the kit minted new object ids for the read after (fewer than half of the objects
    /// that are no root and have no tool id kept their ids).
    pub reminted: bool,
    /// The tool ids another program moved between objects (module docs, "Renumbered tool ids").
    pub renumbered: BTreeSet<String>,
}

impl Pairing {
    /// An explicit identity mapping, for example ids allocated by equivalent creation receipts.
    /// Callers must supply a one-to-one mapping; this performs no content-based pairing.
    pub fn from_ids(pairs: BTreeMap<String, String>) -> Self {
        Self { pairs, ..Self::default() }
    }

    /// The object of the read after paired with `before`'s object `id`.
    pub fn after(&self, id: &str) -> Option<&str> {
        self.pairs.get(id).map(String::as_str)
    }

    /// How many objects were paired.
    pub fn len(&self) -> usize {
        self.pairs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pairs.is_empty()
    }

    /// The state `before` with each paired object named as the read after names it, in its key
    /// and wherever its id is in a value that is not text (module docs, "Ids inside values").
    pub fn renamed(&self, schema: &Schema, before: &Value) -> Value {
        let Some(objects) = before.get("objects").and_then(Value::as_object) else { return before.clone() };
        let mut out = Map::new();
        for (id, object) in objects {
            let ty = object.get(TYPE).and_then(Value::as_str).unwrap_or_default();
            let mut renamed = Map::new();
            for (field, value) in object.as_object().into_iter().flatten() {
                let value = if field == TYPE {
                    value.clone()
                } else if marked_text(schema, ty, field) {
                    // A text's runs: the ids in their formatting, never the text.
                    runs_with(value, &mut |attributes| self.rewrite(attributes))
                } else if holds_ids(schema, ty, field) {
                    self.rewrite(value)
                } else {
                    value.clone()
                };
                renamed.insert(field.clone(), value);
            }
            out.insert(self.after(id).unwrap_or(id).to_owned(), Value::Object(renamed));
        }
        let mut state = before.clone();
        if let Some(fields) = state.as_object_mut() {
            fields.insert("objects".into(), Value::Object(out));
        }
        state
    }

    /// `value` with each id in it, and in its objects' keys, paired.
    fn rewrite(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.after(text).unwrap_or(text).to_owned()),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.rewrite(item)).collect()),
            Value::Object(entries) => Value::Object(entries.iter().map(|(key, value)| (self.translate(key), self.rewrite(value))).collect()),
            other => other.clone(),
        }
    }

    /// A key with the ids in it paired ([`key_ids`]).
    fn translate(&self, key: &str) -> String {
        translated(key, &|id| self.after(id).map(str::to_owned))
    }
}

/// Whether the field `ty.field` may hold object ids: any kind but a scalar's (`string`, `text`,
/// numbers, booleans, enums, blobs). A field the schema does not know may.
fn holds_ids(schema: &Schema, ty: &str, field: &str) -> bool {
    match schema.field(ty, field) {
        Ok(def) => matches!(def.kind, FieldKind::Json | FieldKind::Ref | FieldKind::List | FieldKind::Tree | FieldKind::Map),
        Err(_) => true,
    }
}

/// Whether `ty.field` is a text with marks: its value (as a load answers it) is runs,
/// `[{ insert, attributes? }]`, whose attributes may hold object ids (a picture fill of the
/// letters), and whose `insert` is text, never an id.
fn marked_text(schema: &Schema, ty: &str, field: &str) -> bool {
    schema.field(ty, field).is_ok_and(|def| def.kind == FieldKind::Text && def.has_marks())
}

/// A text's runs with each run's `attributes` replaced by what `attributes` makes of them.
fn runs_with(value: &Value, attributes: &mut dyn FnMut(&Value) -> Value) -> Value {
    let Value::Array(runs) = value else { return value.clone() };
    Value::Array(
        runs.iter()
            .map(|run| {
                let mut run = run.clone();
                if let Some(slot) = run.get_mut("attributes").filter(|given| given.is_object()) {
                    *slot = attributes(slot);
                }
                run
            })
            .collect(),
    )
}

/// `key` with each id in it replaced by what `pairs` answers: the whole key when it is one, else
/// each `:`-separated segment that is one (`<row id>:<col id>`); nothing else is an id.
fn translated(key: &str, pairs: &dyn Fn(&str) -> Option<String>) -> String {
    if let Some(whole) = pairs(key) {
        return whole;
    }
    if !key.contains(':') {
        return key.to_owned();
    }
    key.split(':').map(|segment| pairs(segment).unwrap_or_else(|| segment.to_owned())).collect::<Vec<_>>().join(":")
}

const TYPE: &str = "$type";

/// One read: its objects and their tool ids.
struct Side<'a> {
    objects: &'a Map<String, Value>,
    tools: ToolIds,
}

impl Side<'_> {
    fn ty(&self, id: &str) -> Option<&str> {
        self.objects.get(id)?.get(TYPE)?.as_str()
    }

    fn field(&self, id: &str, field: &str) -> &Value {
        self.objects.get(id).and_then(|object| object.get(field)).unwrap_or(&Value::Null)
    }

    fn is_tool_id(&self, id: &str) -> bool {
        self.tools.tool_id(&ObjectId::from_string(id)).is_some()
    }

    fn exists(&self, id: &str) -> bool {
        self.objects.contains_key(id)
    }
}

/// The objects a list field's value names, in order.
fn list_items(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

/// A tree field's nodes by their parent node (`None`: the top), in order: nested
/// (`[{ object, children }]`, a canonical state) or flat (`[{ object, parent }]`, as a load answers).
fn tree_children(value: &Value) -> HashMap<Option<String>, Vec<String>> {
    fn nested(nodes: &Value, parent: Option<String>, out: &mut HashMap<Option<String>, Vec<String>>) {
        for node in nodes.as_array().into_iter().flatten() {
            let Some(object) = node.get("object").and_then(Value::as_str) else { continue };
            out.entry(parent.clone()).or_default().push(object.to_owned());
            if let Some(children) = node.get("children") {
                nested(children, Some(object.to_owned()), out);
            }
        }
    }
    let mut out: HashMap<Option<String>, Vec<String>> = HashMap::new();
    let flat = value.as_array().is_some_and(|nodes| nodes.iter().any(|node| node.get("parent").is_some()));
    if flat {
        for node in value.as_array().into_iter().flatten() {
            let Some(object) = node.get("object").and_then(Value::as_str) else { continue };
            let parent = node.get("parent").and_then(Value::as_str).map(str::to_owned);
            out.entry(parent).or_default().push(object.to_owned());
        }
    } else {
        nested(value, None, &mut out);
    }
    out
}

/// Every object the owning field `def` of a holder holds, given its value.
fn owned_ids(def: &FieldDef, value: &Value, side: &Side<'_>) -> Vec<String> {
    match def.kind {
        FieldKind::List => list_items(value),
        FieldKind::Tree => tree_children(value).into_values().flatten().collect(),
        FieldKind::Ref => value.as_str().map(str::to_owned).into_iter().collect(),
        FieldKind::Map => FieldDef::map_held(value, |id| side.exists(id)).into_iter().map(|(id, _)| id).collect(),
        _ => Vec::new(),
    }
}

/// The objects an owning map's value holds, each with its key and, for an object value, the
/// member naming it ([`FieldDef::map_held`], with the key kept whole).
fn map_places(map: &Value, side: &Side<'_>) -> Vec<(String, String, Option<String>)> {
    let mut out = Vec::new();
    for (key, value) in map.as_object().into_iter().flatten() {
        match value {
            Value::String(id) if side.exists(id) => out.push((id.clone(), key.clone(), None)),
            Value::Object(members) => {
                for (member, value) in members {
                    if let Some(id) = value.as_str().filter(|id| side.exists(id)) {
                        out.push((id.to_owned(), key.clone(), Some(member.clone())));
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Fingerprints of one read's objects, without ids (memoized).
struct Prints<'a> {
    schema: &'a Schema,
    memo: HashMap<String, u64>,
}

impl Prints<'_> {
    fn of(&mut self, side: &Side<'_>, id: &str, depth: usize) -> u64 {
        if let Some(known) = self.memo.get(id) {
            return *known;
        }
        // A cycle through owning fields reads as an object without content.
        self.memo.insert(id.to_owned(), 0);
        let print = self.content(side, id, depth, &|_| false, false);
        self.memo.insert(id.to_owned(), print);
        print
    }

    /// The fingerprint of `id`'s content, without the fields `skip` names (not memoized when
    /// skipping). The object's fingerprint: its type and fields, without those and, with
    /// `positions`, without the fields the schema marks `position` (where it is, not what it is).
    fn content(&mut self, side: &Side<'_>, id: &str, depth: usize, skip: &dyn Fn(&str) -> bool, positions: bool) -> u64 {
        let mut hasher = DefaultHasher::new();
        let ty = side.ty(id).unwrap_or_default().to_owned();
        ty.hash(&mut hasher);
        if depth < DEPTH
            && let Some(object) = side.objects.get(id).and_then(Value::as_object)
        {
            let schema = self.schema;
            let placed = |name: &str| positions && schema.field(&ty, name).is_ok_and(|def| def.position);
            let mut names: Vec<&String> = object.keys().filter(|name| name.as_str() != TYPE && !skip(name) && !placed(name)).collect();
            names.sort();
            for name in names {
                name.hash(&mut hasher);
                let value = side.field(id, name);
                let schema = self.schema;
                let def = schema.field(&ty, name).ok();
                match def {
                    Some(def) if def.owning() && def.kind == FieldKind::Map => {
                        // Keys hold ids: the held objects' content, in order, without them.
                        let mut held: Vec<u64> = map_places(value, side).into_iter().map(|(held, _, _)| self.of(side, &held, depth + 1)).collect();
                        held.sort_unstable();
                        held.hash(&mut hasher);
                        let mut rest = value.clone();
                        strip_ids(&mut rest, side);
                        self.value(side, &rest, false, depth, &mut hasher);
                    }
                    Some(def) if def.owning() => self.value(side, value, true, depth, &mut hasher),
                    // A text's runs: the text as text, the ids in its formatting as ids.
                    _ if marked_text(schema, &ty, name) => {
                        for run in value.as_array().into_iter().flatten() {
                            ("run", run.get("insert").map(Value::to_string)).hash(&mut hasher);
                            self.value(side, run.get("attributes").unwrap_or(&Value::Null), false, depth, &mut hasher);
                        }
                    }
                    _ if !holds_ids(schema, &ty, name) => ("raw", value.to_string()).hash(&mut hasher),
                    _ => self.value(side, value, false, depth, &mut hasher),
                }
            }
        }
        hasher.finish()
    }

    /// How an id of the read is fingerprinted where it is no held object: by its object's tool id,
    /// else its type.
    fn named(side: &Side<'_>, id: &str) -> String {
        match side.tools.tool_id(&ObjectId::from_string(id)) {
            Some(tool) => format!("tool {tool}"),
            None => format!("ref {}", side.ty(id).unwrap_or_default()),
        }
    }

    /// Hashes `value`: an id of the read as its object's content (`owned`), else by the object's
    /// tool id or type; an object's keys with the ids in them ([`translated`]) by the same names;
    /// everything else as it is.
    fn value(&mut self, side: &Side<'_>, value: &Value, owned: bool, depth: usize, hasher: &mut DefaultHasher) {
        match value {
            Value::String(text) if side.exists(text) => {
                if owned {
                    ("held", self.of(side, text, depth + 1)).hash(hasher);
                } else {
                    ("id", Self::named(side, text)).hash(hasher);
                }
            }
            Value::String(text) => ("text", text).hash(hasher),
            Value::Array(items) => {
                ("list", items.len()).hash(hasher);
                for item in items {
                    self.value(side, item, owned, depth, hasher);
                }
            }
            Value::Object(entries) => {
                let mut keys: Vec<(String, &Value)> = entries
                    .iter()
                    .map(|(key, item)| (translated(key, &|id| side.exists(id).then(|| format!("{{{}}}", Self::named(side, id)))), item))
                    .collect();
                keys.sort_by(|a, b| a.0.cmp(&b.0));
                ("object", keys.len()).hash(hasher);
                for (key, item) in keys {
                    key.hash(hasher);
                    self.value(side, item, owned, depth, hasher);
                }
            }
            other => ("value", other.to_string()).hash(hasher),
        }
    }
}

/// A map's value without the ids it holds (they are hashed by content) and without its keys.
fn strip_ids(value: &mut Value, side: &Side<'_>) {
    if let Value::Object(entries) = value {
        let mut values: Vec<Value> = entries
            .values()
            .map(|entry| match entry {
                Value::String(id) if side.exists(id) => Value::Null,
                Value::Object(members) => Value::Object(
                    members
                        .iter()
                        .map(|(name, member)| (name.clone(), if member.as_str().is_some_and(|id| side.exists(id)) { Value::Null } else { member.clone() }))
                        .collect(),
                ),
                other => other.clone(),
            })
            .collect();
        values.sort_by_key(Value::to_string);
        *value = Value::Array(values);
    }
}

/// The pairing in progress.
struct Pairer<'a> {
    schema: &'a Schema,
    before: Side<'a>,
    after: Side<'a>,
    prints: [Prints<'a>; 2],
    forward: BTreeMap<String, String>,
    backward: BTreeMap<String, String>,
    queue: VecDeque<(String, String)>,
}

impl Pairer<'_> {
    /// Pairs `b` (before) with `a` (after) when both are unpaired objects of one type.
    fn link(&mut self, b: &str, a: &str) -> bool {
        if self.forward.contains_key(b) || self.backward.contains_key(a) {
            return false;
        }
        match (self.before.ty(b), self.after.ty(a)) {
            (Some(x), Some(y)) if x == y => {}
            _ => return false,
        }
        self.forward.insert(b.to_owned(), a.to_owned());
        self.backward.insert(a.to_owned(), b.to_owned());
        self.queue.push_back((b.to_owned(), a.to_owned()));
        true
    }

    fn print(&mut self, after: bool, id: &str) -> u64 {
        let [before_prints, after_prints] = &mut self.prints;
        if after { after_prints.of(&self.after, id, 0) } else { before_prints.of(&self.before, id, 0) }
    }

    /// Pairs the items of two lists: by equal content first, then, between the paired items that
    /// keep their order, the rest in order.
    fn sequence(&mut self, before: &[String], after: &[String]) {
        let mut by_print: HashMap<u64, VecDeque<usize>> = HashMap::new();
        for (j, id) in after.iter().enumerate() {
            if !self.backward.contains_key(id) && self.after.exists(id) {
                let print = self.print(true, id);
                by_print.entry(print).or_default().push_back(j);
            }
        }
        for id in before {
            if self.forward.contains_key(id) || !self.before.exists(id) {
                continue;
            }
            let print = self.print(false, id);
            while let Some(j) = by_print.get_mut(&print).and_then(VecDeque::pop_front) {
                if let Some(other) = after.get(j)
                    && self.link(id, other)
                {
                    break;
                }
            }
        }
        // The paired items, by their index before and after; the longest run keeping its order.
        let at_after: HashMap<&str, usize> = after.iter().enumerate().map(|(j, id)| (id.as_str(), j)).collect();
        let anchors: Vec<(usize, usize)> = before.iter().enumerate().filter_map(|(i, id)| Some((i, *at_after.get(self.forward.get(id)?.as_str())?))).collect();
        let order: Vec<usize> = anchors.iter().map(|(_, j)| *j).collect();
        let kept: Vec<(usize, usize)> = longest_increasing(&order).into_iter().filter_map(|at| anchors.get(at).copied()).collect();
        let mut bounds: Vec<(Option<usize>, Option<usize>)> = vec![(None, None)];
        bounds.extend(kept.iter().map(|(i, j)| (Some(*i), Some(*j))));
        bounds.push((Some(before.len()), Some(after.len())));
        for window in bounds.windows(2) {
            let [(from_i, from_j), (to_i, to_j)] = window else { continue };
            let start = |bound: &Option<usize>| bound.map_or(0, |at| at + 1);
            let gap_before: Vec<String> = before
                .get(start(from_i)..to_i.unwrap_or(before.len()).max(start(from_i)))
                .unwrap_or_default()
                .iter()
                .filter(|id| !self.forward.contains_key(*id) && self.before.exists(id))
                .cloned()
                .collect();
            let gap_after: Vec<String> = after
                .get(start(from_j)..to_j.unwrap_or(after.len()).max(start(from_j)))
                .unwrap_or_default()
                .iter()
                .filter(|id| !self.backward.contains_key(*id) && self.after.exists(id))
                .cloned()
                .collect();
            for (b, a) in gap_before.iter().zip(&gap_after) {
                self.link(b, a);
            }
        }
    }

    /// Pairs what a pair of holders holds through the same owning fields (maps last, so the ids
    /// in their keys are paired first).
    fn holders(&mut self, b: &str, a: &str) {
        let Some(ty) = self.before.ty(b).map(str::to_owned) else { return };
        let Ok(def) = self.schema.type_def(&ty) else { return };
        let mut fields: Vec<(&String, &FieldDef)> = def.fields.iter().filter(|(_, def)| def.owning()).collect();
        fields.sort_by_key(|(name, def)| (def.kind == FieldKind::Map, name.as_str()));
        for (name, def) in fields {
            let (was, now) = (self.before.field(b, name).clone(), self.after.field(a, name).clone());
            match def.kind {
                FieldKind::Ref => {
                    if let (Some(x), Some(y)) = (was.as_str(), now.as_str()) {
                        self.link(x, y);
                    }
                }
                FieldKind::List => self.sequence(&list_items(&was), &list_items(&now)),
                FieldKind::Tree => {
                    let (was, now) = (tree_children(&was), tree_children(&now));
                    let mut parents: VecDeque<(Option<String>, Option<String>)> = VecDeque::from([(None, None)]);
                    while let Some((x, y)) = parents.pop_front() {
                        let (bs, as_) = (was.get(&x).cloned().unwrap_or_default(), now.get(&y).cloned().unwrap_or_default());
                        self.sequence(&bs, &as_);
                        for node in bs {
                            if let Some(paired) = self.forward.get(&node).filter(|paired| as_.contains(paired)) {
                                parents.push_back((Some(node.clone()), Some(paired.clone())));
                            }
                        }
                    }
                }
                FieldKind::Map => {
                    let held_after: HashMap<(String, Option<String>), String> =
                        map_places(&now, &self.after).into_iter().map(|(id, key, member)| ((key, member), id)).collect();
                    for (id, key, member) in map_places(&was, &self.before) {
                        let key = translated(&key, &|token| self.forward.get(token).cloned());
                        if let Some(other) = held_after.get(&(key, member)) {
                            self.link(&id, other);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn drain(&mut self) {
        while let Some((b, a)) = self.queue.pop_front() {
            self.holders(&b, &a);
        }
    }
}

/// The indices of a longest strictly increasing subsequence of `seq`, in order.
fn longest_increasing(seq: &[usize]) -> Vec<usize> {
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
    let mut kept = Vec::new();
    let mut at = tops.last().copied();
    while let Some(index) = at {
        kept.push(index);
        at = previous.get(index).copied().flatten();
    }
    kept.reverse();
    kept
}

/// Pairs the objects of two reads of one document (`{ objects: { <id>: { $type, … } } }`, as a
/// canonical state or the object model's loads give them), as the module says.
pub fn pair(schema: &Schema, before: &Value, after: &Value) -> Pairing {
    let objects = |state: &Value| state.get("objects").and_then(Value::as_object).cloned().unwrap_or_default();
    let (old, new) = (objects(before), objects(after));
    let mut pairer = Pairer {
        schema,
        before: Side { objects: &old, tools: ToolIds::of_state(schema, before) },
        after: Side { objects: &new, tools: ToolIds::of_state(schema, after) },
        prints: [Prints { schema, memo: HashMap::new() }, Prints { schema, memo: HashMap::new() }],
        forward: BTreeMap::new(),
        backward: BTreeMap::new(),
        queue: VecDeque::new(),
    };
    // 1. Each id both reads have, on objects of one type.
    for id in old.keys() {
        if new.contains_key(id) {
            pairer.link(id, id);
        }
    }
    // Canonical replica states still use raw ids; model loads may already use tool ids.
    for id in old.keys() {
        if let Some(tool) = pairer.before.tools.tool_id(&ObjectId::from_string(id))
            && let Ok(other) = pairer.after.tools.resolve(tool, |id| new.contains_key(id.as_str()))
        {
            pairer.link(id, other.as_str());
        }
    }
    // 2. The roots.
    let roots = |side: &Side<'_>| side.objects.keys().filter(|id| side.ty(id) == Some(schema.root.as_str())).cloned().collect::<Vec<_>>();
    let (roots_before, roots_after) = (roots(&pairer.before), roots(&pairer.after));
    if let ([b], [a]) = (roots_before.as_slice(), roots_after.as_slice()) {
        let (b, a) = (b.clone(), a.clone());
        pairer.link(&b, &a);
    }
    // 3. Whether the kit keeps object ids: half the objects that are no root and have no tool id
    // kept theirs.
    let plain: Vec<&String> = old.keys().filter(|id| !roots_before.contains(id) && !pairer.before.is_tool_id(id)).collect();
    let kept = plain.iter().filter(|id| pairer.forward.get(id.as_str()) == Some(*id)).count();
    let reminted = plain.is_empty() || kept * 2 < plain.len();
    if reminted {
        // The objects some owning field holds, in each read.
        let held = |side: &Side<'_>| -> BTreeSet<String> {
            let mut found = BTreeSet::new();
            for (id, object) in side.objects {
                let ty = object.get(TYPE).and_then(Value::as_str).unwrap_or_default();
                let Ok(def) = schema.type_def(ty) else { continue };
                for (name, field) in def.fields.iter().filter(|(_, def)| def.owning()) {
                    found.extend(owned_ids(field, side.field(id, name), side));
                }
            }
            found
        };
        let (held_before, held_after) = (held(&pairer.before), held(&pairer.after));
        loop {
            // 4. What paired holders hold, by place.
            pairer.drain();
            // 5. Objects nothing holds: by equal content.
            let loose_after: Vec<String> = new.keys().filter(|id| !pairer.backward.contains_key(*id) && !held_after.contains(*id)).cloned().collect();
            let mut by_print: HashMap<u64, VecDeque<String>> = HashMap::new();
            for id in loose_after {
                let print = pairer.print(true, &id);
                by_print.entry(print).or_default().push_back(id);
            }
            let loose_before: Vec<String> = old.keys().filter(|id| !pairer.forward.contains_key(*id) && !held_before.contains(*id)).cloned().collect();
            let mut linked = false;
            for id in loose_before {
                let print = pairer.print(false, &id);
                if let Some(other) = by_print.get_mut(&print).and_then(VecDeque::pop_front) {
                    linked |= pairer.link(&id, &other);
                }
            }
            if !linked {
                break;
            }
        }
    }
    let renumbered = pairer.renumbered();
    Pairing { pairs: pairer.forward, reminted, renumbered }
}

impl Pairer<'_> {
    /// The tool ids another program moved between objects (module docs, "Renumbered tool ids"):
    /// objects paired by their tool id whose whole content (every field but the tool id's own,
    /// `position` fields and what they hold included) and place in their holder's list
    /// went, each, to another such object, round a cycle. A ripple edit's clips (each now where
    /// the next was) make no cycle; two objects whose names alone were swapped keep their places
    /// and are two changes. Ambiguous, and read as two changes (the guard then refuses a write on
    /// either as `changed`, right under both readings): an exchange of objects that differ in one
    /// field alone (or in their place alone), which a swap of that field explains as well.
    fn renumbered(&mut self) -> BTreeSet<String> {
        let paired: Vec<String> =
            self.forward.iter().filter(|(b, a)| b == a && self.before.is_tool_id(b) && self.after.is_tool_id(a)).map(|(b, _)| b.clone()).collect();
        let places_before = places(&self.before);
        let places_after = places(&self.after);
        // A place after, by the holder's id before (holders may be minted again).
        let place_of = |after: bool, id: &str| -> Option<(String, String, usize)> {
            if after {
                let (holder, field, index) = places_after.get(id)?.clone();
                let holder = self.backward.get(&holder).cloned().unwrap_or(holder);
                Some((holder, field, index))
            } else {
                places_before.get(id).cloned()
            }
        };
        let tool_field = |side: &Side<'_>, id: &str| -> Option<String> {
            side.ty(id).and_then(|ty| self.schema.type_def(ty).ok()).and_then(|def| def.tool_id.as_ref()).map(|tool| tool.field.clone())
        };
        let mut differing: Vec<(String, Whole, Whole)> = Vec::new();
        for id in paired {
            let skip = tool_field(&self.before, &id);
            let [before_prints, after_prints] = &mut self.prints;
            let skipping = |name: &str| Some(name) == skip.as_deref();
            let was = (before_prints.content(&self.before, &id, 0, &skipping, false), place_of(false, &id));
            let now = (after_prints.content(&self.after, &id, 0, &skipping, false), place_of(true, &id));
            if was != now {
                differing.push((id, was, now));
            }
        }
        // `id` → the objects whose content now is what `id`'s was.
        let mut carried: HashMap<&str, Vec<&str>> = HashMap::new();
        for (id, was, _) in &differing {
            for (other, _, now) in &differing {
                if other != id && now == was {
                    carried.entry(id.as_str()).or_default().push(other.as_str());
                }
            }
        }
        // On a cycle: `id`'s content went round back to it.
        let on_cycle = |start: &str| {
            let mut seen: BTreeSet<&str> = BTreeSet::new();
            let mut frontier: Vec<&str> = carried.get(start).cloned().unwrap_or_default();
            while let Some(next) = frontier.pop() {
                if next == start {
                    return true;
                }
                if seen.insert(next) {
                    frontier.extend(carried.get(next).into_iter().flatten().copied());
                }
            }
            false
        };
        let cycled: Vec<String> = differing.iter().map(|(id, _, _)| id.clone()).filter(|id| on_cycle(id)).collect();
        // An exchange the swap of one field explains as well (or of the places alone): not told
        // as a renumbering.
        let mut found = BTreeSet::new();
        for id in &cycled {
            let partners: Vec<&str> = carried.get(id.as_str()).cloned().unwrap_or_default();
            let explained_by_one = partners.iter().any(|other| {
                let (Some(a), Some(b)) =
                    (self.before.objects.get(id.as_str()).and_then(Value::as_object), self.before.objects.get(*other).and_then(Value::as_object))
                else {
                    return true;
                };
                let skip = tool_field(&self.before, id);
                let names: BTreeSet<&String> =
                    a.keys().chain(b.keys()).filter(|name| name.as_str() != TYPE && Some(name.as_str()) != skip.as_deref()).collect();
                let mut differ = usize::from(place_of(false, id) != place_of(false, other));
                for name in names {
                    let only = |field: &str| field != name.as_str();
                    let [before_prints, _] = &mut self.prints;
                    if before_prints.content(&self.before, id, 0, &only, false) != before_prints.content(&self.before, other, 0, &only, false) {
                        differ += 1;
                    }
                }
                differ <= 1
            });
            if !explained_by_one {
                found.insert(id.clone());
            }
        }
        // A cycle is told whole or not at all.
        loop {
            let partial: Vec<String> = found
                .iter()
                .filter(|id| carried.get(id.as_str()).into_iter().flatten().any(|other| cycled.iter().any(|cycled| cycled == other) && !found.contains(*other)))
                .cloned()
                .collect();
            if partial.is_empty() {
                break;
            }
            for id in partial {
                found.remove(&id);
            }
        }
        found
    }
}

/// An object's whole content: its fingerprint and its place in its holder's list (holder, field,
/// index).
type Whole = (u64, Option<(String, String, usize)>);

/// Each object an owning list field holds in `side`: its holder, the field and its index.
fn places(side: &Side<'_>) -> HashMap<String, (String, String, usize)> {
    let mut found = HashMap::new();
    for (id, object) in side.objects {
        for (name, value) in object.as_object().into_iter().flatten() {
            if name == TYPE || !value.is_array() {
                continue;
            }
            for (index, item) in list_items(value).into_iter().enumerate() {
                if side.objects.contains_key(&item) {
                    found.entry(item).or_insert_with(|| (id.clone(), name.clone(), index));
                }
            }
        }
    }
    found
}

/// The change between two reads of one document's file ([`pair`]), as a receipt names it: by tool
/// ids, a change inside an object told as its holder's at a path, no `texts`. When the kit minted
/// new object ids, the changes of objects that have no tool id and no holder with one are counted
/// by type in `unnamed` instead of listed. Objects whose tool ids were renumbered are left out and
/// listed in `renumbered`.
pub fn diff_read_again(schema: &Schema, before: &Value, after: &Value) -> StateDiff {
    let (mut diff, pairing, (was, now)) = paired_diff(schema, before, after);
    diff = diff.without_texts();
    if pairing.reminted {
        // The root keeps its object id on every read (a kit that makes it so) and changed in a
        // field of its own, not only in a list or tree it holds (told by their items): named by
        // that id, as a write's change set names it, so its derived values and fields can be
        // premises.
        let root_id = |state: &Value| {
            state.get("objects").and_then(Value::as_object).and_then(|objects| {
                objects.iter().find(|(_, object)| object.get(TYPE).and_then(Value::as_str) == Some(schema.root.as_str())).map(|(id, _)| id.clone())
            })
        };
        let root = root_id(after).filter(|id| root_id(before).as_ref() == Some(id));
        let deleted: BTreeSet<String> = diff.deleted.iter().map(|change| change.id.clone()).collect();
        let holds = |field: &str| schema.field(&schema.root, field).is_ok_and(|def| matches!(def.kind, FieldKind::List | FieldKind::Tree));
        diff.count_unnamed(&was, &now, &|change| {
            deleted.contains(&change.id) || Some(&change.id) == root.as_ref() && change.fields.iter().any(|field| !holds(field))
        });
    }
    diff
}

/// Two reads of one document compared through their pairing ([`pair`]), every change listed, as a
/// receipt names it (by tool ids, a held object's change under its holder): what a training
/// environment compares the states of a file read again by (`kition-env`), where nothing may hide
/// in a count. Objects whose tool ids were renumbered are left out and listed in `renumbered`.
pub fn diff_paired(schema: &Schema, before: &Value, after: &Value) -> StateDiff {
    paired_diff(schema, before, after).0
}

fn paired_diff(schema: &Schema, before: &Value, after: &Value) -> (StateDiff, Pairing, (ToolIds, ToolIds)) {
    // Trees as reads see them: a node naming a deleted object is no object to pair.
    let (before, after) = (&crate::diff::without_dead_nodes(before), &crate::diff::without_dead_nodes(after));
    let pairing = pair(schema, before, after);
    let renamed = pairing.renamed(schema, before);
    let after = &unpermuted(schema, &renamed, after, &pairing.renumbered);
    let (was, now) = (ToolIds::of_state(schema, &renamed), ToolIds::of_state(schema, after));
    let mut diff = diff_states(&renamed, after).with_leaf_edits(schema).with_tool_ids(schema, &was, &now);
    if !pairing.renumbered.is_empty() {
        diff.set_renumbered(&pairing.renumbered);
    }
    (diff, pairing, (was, now))
}

/// `after` with each list that differs from the read before only in the order of renumbered
/// objects (`ids`) given that order: the renumbering is told once, in `renumbered`, not as moves.
fn unpermuted(schema: &Schema, before: &Value, after: &Value, ids: &BTreeSet<String>) -> Value {
    if ids.is_empty() {
        return after.clone();
    }
    let mut out = after.clone();
    let Some(objects) = out.get_mut("objects").and_then(Value::as_object_mut) else { return out };
    for (id, object) in objects.iter_mut() {
        let ty = object.get(TYPE).and_then(Value::as_str).unwrap_or_default().to_owned();
        let Some(fields) = object.as_object_mut() else { continue };
        for (field, value) in fields.iter_mut() {
            if schema.field(&ty, field).ok().is_none_or(|def| def.kind != FieldKind::List) {
                continue;
            }
            let Some(was) = before.get("objects").and_then(|objects| objects.get(id.as_str())).and_then(|object| object.get(field.as_str())) else { continue };
            let (old, new) = (list_items(was), list_items(value));
            let rest = |items: &[String]| items.iter().filter(|item| !ids.contains(*item)).cloned().collect::<Vec<_>>();
            let mut sorted = (old.clone(), new.clone());
            sorted.0.sort();
            sorted.1.sort();
            if old != new && sorted.0 == sorted.1 && rest(&old) == rest(&new) {
                *value = was.clone();
            }
        }
    }
    out
}
