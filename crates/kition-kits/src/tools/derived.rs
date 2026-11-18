// Copied from kition-sdk crates/kition-kits/src/tools/derived.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Derived values in change sets: a type of the kit's object model may declare values
//! the kit computes on request and never stores (`derived`: a mesh's `topology`, its `bounds`).
//! Change sets name one `~<name>` beside the stored fields, with `before` and `after` when small,
//! so a receipt says a subdivide changed the topology, the journal keeps it, and a premise may
//! name it (`Premise.fields: ["~topology"]`): a write by face index holds the topology and not the
//! whole mesh.
//!
//! The kit answers the values as the document is now (`model.derived`); what they were before a
//! write is what this server last read, kept per kit document with the object model's version it
//! holds for ([`Cache`]): read for every object of a declaring type before the first write
//! with no valid cache, after writes and at each outside reread. Facts may depend on other
//! objects, so rereading only objects named by stored edits is insufficient. A change set whose derived values were read
//! says so (`derived: true`, kept in the journal, never shown); one that does not (the kit could
//! not answer) leaves held derived premises unknown after any other writer's document edit.
//!
//! Values are keyed by the id change sets name an object by: its tool id, or its object id when
//! it has none (the root), which the kit answers alike; a root that keeps its object id
//! on every read is named by it in a change of the file too (`kition_kdm::reread`).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Mutex, PoisonError};

use serde_json::{Map, Value, json};

use crate::manager::{Caller, KitManager};

/// The prefix a derived value's name takes in change sets and premises.
pub(crate) const MARK: char = '~';

/// The largest `before` or `after` (as JSON text) an edit of a derived value carries.
const SMALL: usize = 200;
type Basis = (String, Value, usize);

/// What this server last read of each kit document's derived values, with the object model's
/// version it holds for, by the kit and document.
#[derive(Default)]
pub(crate) struct Cache {
    documents: Mutex<HashMap<String, (String, Values)>>,
    bases: Mutex<HashMap<String, VecDeque<Basis>>>,
}

/// Derived values by object id, then by name.
type Values = HashMap<String, Map<String, Value>>;

fn key(kit_id: &str, document_id: &str) -> String {
    format!("{kit_id}\n{document_id}")
}

impl Cache {
    pub(crate) fn history(&self, kits: &KitManager, key: &str, basis: &str, agent: &str) -> Option<Value> {
        let mut first = self.basis(key, basis)?;
        let super::journal::Since::Covered(entries) = kits.inner.journals.since(key, basis) else {
            return None;
        };
        let mut before = first.clone();
        let mut history = Vec::new();
        for entry in entries {
            let at = kits.inner.journals.revision_at(key, entry.seq)?;
            let after = self.basis(key, &at)?;
            if entry.author != agent {
                history.push(json!({"before":before,"after":after}));
            }
            before = after;
        }
        first["history"] = json!(history);
        Some(first)
    }
    pub(crate) fn basis(&self, key: &str, basis: &str) -> Option<Value> {
        self.bases.lock().unwrap_or_else(PoisonError::into_inner).get(key)?.iter().find(|(at, _, _)| at == basis).map(|(_, model, _)| model.clone())
    }
    fn valid_at(&self, kit_id: &str, document_id: &str, version: &str) -> Option<HashMap<String, Map<String, Value>>> {
        let documents = self.documents.lock().unwrap_or_else(PoisonError::into_inner);
        documents.get(&key(kit_id, document_id)).filter(|(at, _)| at == version).map(|(_, values)| values.clone())
    }

    fn set(&self, kit_id: &str, document_id: &str, version: Option<String>, values: HashMap<String, Map<String, Value>>) {
        let mut documents = self.documents.lock().unwrap_or_else(PoisonError::into_inner);
        match version {
            Some(version) => {
                documents.insert(key(kit_id, document_id), (version, values));
            }
            None => {
                documents.remove(&key(kit_id, document_id));
            }
        }
    }
}

/// Complete model checkpoints for content premises and on-demand facts.
pub(crate) async fn capture(kits: &KitManager, key: &str, view: &crate::manager::DocumentView) {
    capture_from(kits, key, super::guard::Reader::Kit(view)).await;
}

pub(crate) async fn capture_from(kits: &KitManager, key: &str, reader: super::guard::Reader<'_>) {
    let basis = kits.inner.journals.revision(key);
    if kits.inner.derived.basis(key, &basis).is_some() {
        return;
    }
    let described = reader.described(kits).await;
    let has_facts = described
        .as_ref()
        .and_then(|model| model["types"].as_object())
        .into_iter()
        .flatten()
        .any(|(_, ty)| ty["derived"].as_object().is_some_and(|facts| !facts.is_empty()));
    if !has_facts {
        return;
    }
    let Some(mut objects) = super::guard::objects_from(kits, reader).await else {
        return;
    };
    let mut derived = Map::new();
    for (id, object) in &mut objects {
        if let Some(fields) = object.as_object_mut() {
            let facts: Map<String, Value> =
                fields.iter().filter(|(name, _)| name.starts_with(MARK)).map(|(name, value)| (name.clone(), value.clone())).collect();
            fields.retain(|name, _| !name.starts_with(MARK));
            if !facts.is_empty() {
                derived.insert(id.clone(), Value::Object(facts));
            }
        }
    }
    let model = json!({"objects":objects,"derived":derived});
    let bytes = serde_json::to_vec(&model).map_or(usize::MAX, |v| v.len());
    if bytes > 64 * 1024 * 1024 || objects.len() > 20_000 {
        return;
    }
    let mut bases = kits.inner.derived.bases.lock().unwrap_or_else(PoisonError::into_inner);
    let bases = bases.entry(key.to_owned()).or_default();
    bases.retain(|(at, _, _)| matches!(kits.inner.journals.since(key, at), super::journal::Since::Covered(_)));
    bases.push_back((basis, model, bytes));
    while bases.len() > 256 || bases.iter().map(|(_, _, bytes)| bytes).sum::<usize>() > 64 * 1024 * 1024 {
        bases.pop_front();
    }
}

pub(crate) async fn editor_snapshot(kits: &KitManager, document: &crate::bridge::LiveDocument) -> Option<Map<String, Value>> {
    if !document.can("premises") {
        return None;
    }
    let reader = super::guard::Reader::Editor(document);
    super::guard::objects_from(kits, reader).await
}

/// Add the eager facts compared in two editor checkpoints to the replica's stored edits.
pub(crate) fn editor_changes(before: Option<&Map<String, Value>>, after: Option<&Map<String, Value>>, changes: &mut Value) {
    let (Some(before), Some(after)) = (before, after) else { return };
    let facts = |objects: &Map<String, Value>| -> Value {
        json!({"objects":objects.iter().map(|(id,object)| {
            let fields: Map<String,Value> = object.as_object().into_iter().flatten().filter(|(name,_)| name.starts_with(MARK) || name.as_str() == "$type")
                .map(|(name,value)|(name.clone(),value.clone())).collect();
            (id.clone(),json!(fields))
        }).collect::<Map<_,_>>()})
    };
    let diff = kition_kdm::diff::diff_states(&facts(before), &facts(after)).to_json();
    for mut fact in diff["changed"].as_array().into_iter().flatten().cloned() {
        // The replica already records creation/deletion when a tool id is reused for a new type.
        // Only derived fields belong to this supplemental comparison.
        if let Some(fields) = fact["fields"].as_array_mut() {
            fields.retain(|name| name.as_str().is_some_and(|name| name.starts_with(MARK)));
        }
        if let Some(edits) = fact["edits"].as_array_mut() {
            edits.retain(|edit| edit["field"].as_str().is_some_and(|name| name.starts_with(MARK)));
        }
        if fact["fields"].as_array().is_none_or(Vec::is_empty) {
            continue;
        }
        let changed = changes["changed"].as_array_mut();
        let Some(changed) = changed else { return };
        if let Some(item) = changed.iter_mut().find(|item| item["id"] == fact["id"]) {
            for key in ["fields", "edits"] {
                if let Some(items) = item[key].as_array_mut() {
                    items.extend(fact[key].as_array().into_iter().flatten().cloned());
                }
            }
        } else {
            changed.push(fact);
        }
    }
    changes["derived"] = json!(true);
}

/// The derived values each type of the kit's description declares, by type.
pub(crate) fn declared(described: Option<&Value>) -> BTreeMap<String, Vec<String>> {
    described
        .and_then(|described| described["types"].as_object())
        .into_iter()
        .flatten()
        .filter_map(|(ty, def)| {
            let names: Vec<String> = def["derived"].as_object()?.iter().filter(|(_, fact)| fact["onDemand"] != true).map(|(name, _)| name.clone()).collect();
            (!names.is_empty()).then(|| (ty.clone(), names))
        })
        .collect()
}

fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(id) if !id.is_empty() => Some(id.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// The derived values of `ids` (every object of a declaring type when `None`), by id: the kit's
/// `model.derived`. `None` when it cannot say.
async fn read(kits: &KitManager, kit_id: &str, document_id: &str, described: Option<&Value>) -> Option<HashMap<String, Map<String, Value>>> {
    let mut params = Map::new();
    let names: std::collections::BTreeSet<_> = declared(described).into_values().flatten().collect();
    params.insert("names".into(), json!(names));
    let answer = kits.model(Caller::Agent, kit_id, document_id, "model.derived", params).await.ok()?;
    let objects = answer["objects"].as_array()?;
    Some(objects.iter().filter_map(|object| Some((id_text(&object["id"])?, object["values"].as_object().cloned().unwrap_or_default()))).collect())
}

/// Before a write: the derived values of every object of a declaring type, read once when this
/// server holds none for the document at `version` (its object model's version before the write).
pub(crate) async fn before_write(kits: &KitManager, kit_id: &str, document_id: &str, version: &str, described: Option<&Value>) {
    if declared(described).is_empty() || kits.inner.derived.valid_at(kit_id, document_id, version).is_some() {
        return;
    }
    let values = read(kits, kit_id, document_id, described).await;
    let valid = values.is_some();
    kits.inner.derived.set(kit_id, document_id, valid.then(|| version.to_owned()), values.unwrap_or_default());
}

/// An edit of the derived value `name`: `before` and `after` when each is small and `before` is
/// known.
fn edit(name: &str, before: Option<&Value>, after: &Value) -> Value {
    let small = |value: &Value| value.to_string().len() <= SMALL;
    let mut edit = json!({ "field": format!("{MARK}{name}") });
    match before {
        Some(before) if small(before) && small(after) => {
            edit["before"] = before.clone();
            edit["after"] = after.clone();
        }
        Some(_) => {}
        // What it was is not known: only what it is.
        None if small(after) => edit["after"] = after.clone(),
        None => {}
    }
    edit
}

/// After a write whose change set (`changes`, from the object model's version `since` to `now`)
/// names objects of a declaring type: their derived values read now, compared with those this
/// server held before; each that differs (or whose value before is not known) is added to its
/// change as `~<name>` with its edit, a deleted object's values before go in its `$was`, and the
/// set says `derived: true`. The cache then holds the document at `now`.
pub(crate) async fn after_write(
    kits: &KitManager,
    kit_id: &str,
    document_id: &str,
    described: Option<&Value>,
    since: &str,
    now: Option<&str>,
    changes: &mut Value,
) {
    let declared = declared(described);
    if declared.is_empty() || !changes.is_object() {
        return;
    }
    let was = kits.inner.derived.valid_at(kit_id, document_id, since);
    // Structural changes of a tree are told by its items; the root may still derive a value
    // from that tree even when it has no stored field change of its own.
    let root_change = if let Some(model) = described
        && model["root"].as_str().is_some_and(|ty| declared.contains_key(ty))
        && let Some(root) = id_text(&model["rootId"])
        && !["changed", "created", "deleted"]
            .iter()
            .flat_map(|list| changes[*list].as_array().into_iter().flatten())
            .any(|item| id_text(&item["id"]).as_ref() == Some(&root))
    {
        Some(json!({ "id": root, "type": model["root"], "fields": [], "edits": [] }))
    } else {
        None
    };
    let of_type = |item: &Value| item["type"].as_str().and_then(|ty| declared.get(ty)).is_some();
    let ids: Vec<String> = ["changed", "created"]
        .iter()
        .flat_map(|list| changes[*list].as_array().into_iter().flatten())
        .chain(root_change.iter())
        .filter(|item| of_type(item))
        .filter_map(|item| id_text(&item["id"]))
        .collect();
    // Derived facts may depend on any object's fields; the declaration names no input graph.
    let read_now = read(kits, kit_id, document_id, described).await;
    let Some(read_now) = read_now else {
        kits.inner.derived.set(kit_id, document_id, None, HashMap::new());
        return;
    };
    if let Some(root) = root_change
        && let Some(changed) = changes.get_mut("changed").and_then(Value::as_array_mut)
    {
        changed.push(root);
    }
    let indirect: Vec<_> = read_now
        .iter()
        .filter(|(id, values)| !ids.contains(id) && was.as_ref().and_then(|was| was.get(*id)).is_some_and(|before| before != *values))
        .map(|(id, _)| id.clone())
        .collect();
    if !indirect.is_empty() {
        let source = super::receipts::Source::Kit { kit_id, document_id };
        if let Some(answer) = source.load(kits, json!(indirect.iter().map(|id| json!({"target":id,"fields":[]})).collect::<Vec<_>>())).await {
            for loaded in answer["loaded"].as_array().into_iter().flatten() {
                if let Some(changed) = changes["changed"].as_array_mut() {
                    changed.push(json!({"id":loaded["id"],"type":loaded["type"],"fields":[],"edits":[]}));
                }
            }
        } else {
            kits.inner.derived.set(kit_id, document_id, None, HashMap::new());
            return;
        }
    }
    marked(changes, &declared, was.as_ref(), &read_now);
    if let Some(changed) = changes.get_mut("changed").and_then(Value::as_array_mut) {
        changed.retain(|item| item["fields"].as_array().is_none_or(|fields| !fields.is_empty()));
    }
    privatize(changes, described);
    let mut values = was.clone().unwrap_or_default();
    for deleted in changes["deleted"].as_array().into_iter().flatten().filter_map(|item| id_text(&item["id"])) {
        values.remove(&deleted);
    }
    values.extend(read_now);
    kits.inner.derived.set(kit_id, document_id, now.map(str::to_owned), values);
}

/// Keep premise-only comparisons in the journal without adding public changed objects.
pub(crate) fn privatize(changes: &mut Value, described: Option<&Value>) {
    fn lists(changes: &mut Value, described: Option<&Value>, private: &mut Vec<Value>) {
        for list in ["created", "changed", "deleted", "moved", "texts"] {
            let Some(items) = changes.get_mut(list).and_then(Value::as_array_mut) else { continue };
            for item in items.iter_mut() {
                let unknown = item.as_object_mut().and_then(|item| item.remove("$unknownDerived")).unwrap_or(Value::Null);
                let ty = item["type"].as_str().unwrap_or_default().to_owned();
                let hidden = |field: &Value| {
                    unknown.as_array().is_some_and(|fields| fields.contains(field))
                        || field
                            .as_str()
                            .and_then(|field| field.strip_prefix(MARK))
                            .is_some_and(|name| described.is_some_and(|model| model["types"][&ty]["derived"][name]["premiseOnly"] == true))
                };
                let fields: Vec<_> = item["fields"].as_array().into_iter().flatten().filter(|field| hidden(field)).cloned().collect();
                if list == "changed" && !fields.is_empty() {
                    let edits: Vec<_> = item["edits"].as_array().into_iter().flatten().filter(|edit| hidden(&edit["field"])).cloned().collect();
                    private.push(json!({"id":item["id"],"type":item["type"],"fields":fields,"edits":edits}));
                }
                // Optional members must stay absent so receipts keep the state diff's shape.
                if let Some(fields) = item.get_mut("fields").and_then(Value::as_array_mut) {
                    fields.retain(|field| !hidden(field));
                }
                if let Some(edits) = item.get_mut("edits").and_then(Value::as_array_mut) {
                    edits.retain(|edit| !hidden(&edit["field"]));
                }
                if let Some(values) = item.get_mut("values").and_then(Value::as_object_mut) {
                    values.retain(|name, _| !hidden(&json!(name)));
                }
                // Deleted before-values stay private in the journal's $was. Receipts strip
                // that entire member; it remains available to historical coverage checks.
            }
            if list == "changed" {
                items.retain(|item| item["fields"].as_array().is_none_or(|fields| !fields.is_empty()));
            }
        }
    }
    let mut private = Vec::new();
    lists(changes, described, &mut private);
    for group in ["$unnamed", "$objects"] {
        if let Some(hidden) = changes.get_mut(group) {
            lists(hidden, described, &mut private);
        }
    }
    if !private.is_empty() {
        changes["$premises"] = json!(private);
    }
}

/// `changes` with the derived values that changed between `was` (before; `None`: not known) and
/// `now` (after) told (`~<name>`, its edit), a deleted object's values before in its `$was`, and
/// `derived: true`.
fn marked(
    changes: &mut Value,
    declared: &BTreeMap<String, Vec<String>>,
    was: Option<&HashMap<String, Map<String, Value>>>,
    now: &HashMap<String, Map<String, Value>>,
) {
    for item in changes.get_mut("changed").and_then(Value::as_array_mut).into_iter().flatten() {
        let Some(names) = item["type"].as_str().and_then(|ty| declared.get(ty)) else { continue };
        let Some(id) = id_text(&item["id"]) else { continue };
        let before = was.map(|was| was.get(&id));
        let after = now.get(&id);
        for name in names {
            let after = after.and_then(|after| after.get(name)).unwrap_or(&Value::Null);
            let edit = match before {
                // Not held before: changed as far as anyone can tell.
                None | Some(None) => {
                    let field = json!(format!("{MARK}{name}"));
                    if let Some(unknown) = item.get_mut("$unknownDerived").and_then(Value::as_array_mut) {
                        unknown.push(field);
                    } else {
                        item["$unknownDerived"] = json!([field]);
                    }
                    edit(name, None, after)
                }
                Some(Some(before)) => {
                    let before = before.get(name).unwrap_or(&Value::Null);
                    if before == after {
                        continue;
                    }
                    edit(name, Some(before), after)
                }
            };
            if let Some(fields) = item.get_mut("fields").and_then(Value::as_array_mut) {
                fields.push(json!(format!("{MARK}{name}")));
            }
            match item.get_mut("edits").and_then(Value::as_array_mut) {
                Some(edits) => edits.push(edit),
                None => item["edits"] = json!([edit]),
            }
        }
    }
    for item in changes.get_mut("deleted").and_then(Value::as_array_mut).into_iter().flatten() {
        let Some(names) = item["type"].as_str().and_then(|ty| declared.get(ty)) else { continue };
        let Some(values) = id_text(&item["id"]).and_then(|id| was.and_then(|was| was.get(&id))) else { continue };
        for name in names {
            if let Some(value) = values.get(name) {
                item["$was"][format!("{MARK}{name}")] = value.clone();
            }
        }
    }
    changes["derived"] = json!(true);
}

/// The objects of one full read of the document (`guard::objects`, by id) with their derived
/// values added as `~<name>` fields, read in one request; the cache then holds them at `version`.
/// `false` when the kit declares none or cannot say.
pub(crate) async fn into_objects(
    kits: &KitManager,
    kit_id: &str,
    document_id: &str,
    described: Option<&Value>,
    version: Option<&str>,
    objects: &mut Map<String, Value>,
) -> bool {
    if declared(described).is_empty() {
        return false;
    }
    let Some(values) = read(kits, kit_id, document_id, described).await else { return false };
    for (id, derived) in &values {
        if let Some(object) = objects.get_mut(id).and_then(Value::as_object_mut) {
            for (name, value) in derived {
                object.insert(format!("{MARK}{name}"), value.clone());
            }
        }
    }
    kits.inner.derived.set(kit_id, document_id, version.map(str::to_owned), values);
    true
}

/// Whether a change set's derived values were read (`derived: true`).
pub(crate) fn told(changes: &Value) -> bool {
    changes["derived"] == true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privatizing_changes_preserves_public_structure() {
        let public = json!({
            "created": [{"id":"new","type":"Node","fields":["name"],"values":{"name":"New"}}],
            "changed": [{"id":"changed","type":"Node","fields":["name"],"edits":[{"field":"name","before":"Old","after":"New"}]}],
            "deleted": [{"id":"gone","type":"Node","fields":[],"$was":{"name":"Gone","~secret":"basis"}}],
            "moved": [{"id":"moved","type":"Node","from":{"parent":"root","field":"nodes","index":0},"to":{"parent":"root","field":"nodes","index":1}}],
            "texts": [{"id":"changed","field":"name","before":"Old","after":"New"}]
        });
        let mut changes = public.clone();
        for group in ["$unnamed", "$objects"] {
            changes[group] = public.clone();
        }
        let before = changes.clone();
        privatize(&mut changes, Some(&json!({"types":{"Node":{"derived":{"secret":{"premiseOnly":true}}}}})));
        assert_eq!(changes, before, "privacy filtering must preserve public facts and the journal's private deletion basis without adding absent members");
    }

    #[tokio::test]
    async fn unavailable_derived_values_do_not_add_an_empty_root_change() {
        let kits = KitManager::new(None, vec![]);
        let described = json!({ "root": "Image", "rootId": "image", "types": { "Image": { "derived": { "layerCount": {} } } } });
        let mut changes = json!({ "created": [], "changed": [], "moved": [], "deleted": [{ "id": "1", "type": "Layer" }] });
        let before = changes.clone();
        after_write(&kits, "kit.unavailable", "document", Some(&described), "before", Some("after"), &mut changes).await;
        assert_eq!(changes, before);
    }

    #[test]
    fn a_changed_derived_value_is_told_with_its_edit_and_an_unknown_one_without_before() {
        let declared = BTreeMap::from([("Node".to_owned(), vec!["topology".to_owned(), "bounds".to_owned()])]);
        let mut changes = json!({
            "created": [], "moved": [],
            "changed": [
                { "id": "1", "type": "Node", "fields": ["mesh"], "edits": [{ "field": "mesh" }] },
                { "id": "2", "type": "Node", "fields": ["mesh"] },
                { "id": "3", "type": "Node", "fields": ["name"] }
            ],
            "deleted": [{ "id": "4", "type": "Node", "fields": [], "$was": { "location": [0, 0, 0] } }]
        });
        let was = HashMap::from([
            ("1".to_owned(), Map::from_iter([("topology".to_owned(), json!("8v6f")), ("bounds".to_owned(), json!([[0], [1]]))])),
            ("3".to_owned(), Map::from_iter([("topology".to_owned(), json!("8v6f")), ("bounds".to_owned(), json!([[0], [1]]))])),
            ("4".to_owned(), Map::from_iter([("bounds".to_owned(), json!([[0], [2]]))])),
        ]);
        let now = HashMap::from([
            ("1".to_owned(), Map::from_iter([("topology".to_owned(), json!("14v12f")), ("bounds".to_owned(), json!([[0], [1]]))])),
            ("2".to_owned(), Map::from_iter([("topology".to_owned(), json!("8v6f")), ("bounds".to_owned(), json!([[0], [1]]))])),
            ("3".to_owned(), Map::from_iter([("topology".to_owned(), json!("8v6f")), ("bounds".to_owned(), json!([[0], [1]]))])),
        ]);
        marked(&mut changes, &declared, Some(&was), &now);
        assert_eq!(changes["changed"][0]["fields"], json!(["mesh", "~topology"]));
        assert_eq!(changes["changed"][0]["edits"][1], json!({ "field": "~topology", "before": "8v6f", "after": "14v12f" }));
        assert_eq!(changes["changed"][1]["fields"], json!(["mesh", "~topology", "~bounds"]), "not held before: told");
        assert_eq!(changes["changed"][1]["edits"][0], json!({ "field": "~topology", "after": "8v6f" }));
        assert_eq!(changes["changed"][2]["fields"], json!(["name"]), "unchanged: not told");
        assert_eq!(changes["deleted"][0]["$was"], json!({ "location": [0, 0, 0], "~bounds": [[0], [2]] }));
        assert!(told(&changes));
    }
}
