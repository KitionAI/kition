// Copied from kition-sdk crates/kition-kit-mock/src/stack.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Documents as images with a stack of layers in a tree (`KITION_KIT_MOCK_PARTS=stack`,
//! ), as a photo kit models them: the root `Image` (no tool id) holds its layers in a KDM
//! tree, a layer has an integer tool id (`id`), a name and an opacity, and any layer may hold
//! layers (a group). The file is the image as JSON, `{ "name": …, "layers": [{ "id", "name",
//! "opacity", "layers": [ … ] }] }`, layers in stored order (the first at the bottom).
//!
//! Commands name a layer by id or by its place among its siblings: `"#n"`, the n-th child (from 1)
//! of the group `in` (the top level without `in`), counted in stored order by `layer.opacity`
//! (`x-khp-index: "#"`) and from the top, the last stored, by `layer.fade` (`x-khp-index-order:
//! "reversed"`). `layer.add` adds a layer to a group at a place, `layer.delete`
//! deletes one, `layer.move` moves one to the end of another group, `image.rename` renames the
//! image and `image.caption` names it with its layer count (a premise on the root's derived value). The kit answers `context.under` for a write by index (the layer the index names now and
//! its window among its siblings, `{ parent: <group id, or the root's>, field: "layers" }`, and
//! the group as a premise of existence alone, `{ id, fields: [], positions: [] }`), and
//! the root's derived value `layerCount` (`model.derived`; the root has no tool id, so it is named
//! by its object id).

use std::sync::{Arc, LazyLock};

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, UndoScope};
use serde_json::{Map, Value, json};

use crate::tracks::Edited;

/// The image's object model.
pub const SCHEMA: &str = r#"{
  "kdm": 1, "kit": "kit.mock", "schemaVersion": 1, "root": "Image",
  "types": {
    "Image": { "fields": {
      "name": { "kind": "string" },
      "resources": { "kind": "json", "optional": true, "sample": false },
      "layers": { "kind": "tree", "of": "Layer" }
    },
    "derived": { "layerCount": { "description": "how many layers the image has, at any depth" } } },
    "Layer": { "fields": {
      "id": { "kind": "integer", "readOnly": true, "optional": true },
      "name": { "kind": "string" },
      "fillOpacity": { "kind": "number", "optional": true, "minimum": 0, "maximum": 1, "sample": false },
      "data": { "kind": "json", "optional": true, "members": { "roughness": { "minimum": 0, "maximum": 1, "multipleOf": 0.1 } } },
      "opacity": { "kind": "number", "minimum": 0, "maximum": 100, "multipleOf": 1 }
    }, "toolId": { "field": "id" } }
  }
}"#;

/// Whether documents are images with a stack of layers.
pub static STACK: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_PARTS").is_ok_and(|value| value.trim() == "stack"));

static CONTAINERS: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_CONTAINERS").is_ok());
static CONTAINER_SCHEMA: LazyLock<String> = LazyLock::new(|| {
    let mut schema: Value = serde_json::from_str(SCHEMA).unwrap();
    schema["types"]["Layer"]["fields"]["look"] = json!({"kind":"map"});
    schema["types"]["Layer"]["fields"]["caption"] = json!({"kind":"text","marks":{"bold":{"expand":"after"}},"sample":false});
    schema["types"]["Layer"]["derived"] = json!({"nameLength":{}});
    schema["types"]["Layer"]["label"] = json!("name");
    schema.to_string()
});

pub fn schema() -> &'static str {
    static ADDRESSES: LazyLock<String> = LazyLock::new(|| {
        let mut schema: Value = serde_json::from_str(SCHEMA).unwrap();
        schema["types"]["Layer"]["fields"]["address"] = json!({"kind":"json","optional":true,"position":true,"sample":false});
        schema["types"]["Layer"]["moveConsequences"] = json!(["address.container"]);
        schema.to_string()
    });
    static CASCADE: LazyLock<String> = LazyLock::new(|| {
        let mut schema: Value = serde_json::from_str(SCHEMA).unwrap();
        schema["types"]["Image"]["fields"]["layers"]["cascade"] = json!(true);
        schema.to_string()
    });
    static NESTED: LazyLock<String> = LazyLock::new(|| {
        let mut schema: Value = serde_json::from_str(SCHEMA).unwrap();
        schema["types"]["Layer"]["fields"]["data"]["members"] = json!({
            "motion.shutter":{"minimum":0,"maximum":1,"multipleOf":0.1},
            "weights[]":{"minimum":0,"maximum":1,"multipleOf":0.1},
            "layers[].opacity":{"minimum":0,"maximum":1,"multipleOf":0.1}
        });
        schema.to_string()
    });
    if std::env::var_os("KITION_KIT_MOCK_MOVE_ADDRESSES").is_some() {
        &ADDRESSES
    } else if std::env::var_os("KITION_KIT_MOCK_CASCADE").is_some() {
        &CASCADE
    } else if std::env::var_os("KITION_KIT_MOCK_NESTED_LIMITS").is_some() {
        &NESTED
    } else if *CONTAINERS {
        &CONTAINER_SCHEMA
    } else {
        SCHEMA
    }
}

/// The root's object id, the same on every read.
pub const ROOT: &str = "image";

/// A layer as the file holds it.
#[derive(Clone, Debug, PartialEq)]
struct Layer {
    id: u64,
    name: String,
    opacity: f64,
    fill_opacity: Option<f64>,
    data: Option<Value>,
    address: Option<Value>,
    look: Value,
    caption: Value,
    layers: Vec<Layer>,
}

fn parse_layers(value: &Value) -> Result<Vec<Layer>, String> {
    value
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|layer| {
            Ok(Layer {
                id: layer["id"].as_u64().filter(|id| *id > 0).ok_or_else(|| format!("{layer} has no `id` (a whole number from 1)"))?,
                name: layer["name"].as_str().unwrap_or_default().to_owned(),
                opacity: layer["opacity"].as_f64().unwrap_or(100.0),
                fill_opacity: layer["fillOpacity"].as_f64(),
                data: layer.get("data").cloned(),
                address: layer.get("address").cloned(),
                look: layer.get("look").cloned().unwrap_or_else(|| json!({})),
                caption: layer.get("caption").cloned().unwrap_or_else(|| json!([])),
                layers: parse_layers(&layer["layers"])?,
            })
        })
        .collect()
}

/// A new image replica from its text.
pub fn build(text: &str) -> Result<Replica, String> {
    let file: Value = serde_json::from_str(text).map_err(|error| format!("the image is no JSON: {error}"))?;
    let layers = parse_layers(&file["layers"])?;
    let schema = Arc::new(Schema::parse(schema()).map_err(|error| error.to_string())?);
    let (replica, ()) = Replica::create_with(schema, DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
        let mut fields = Map::from_iter([("name".to_owned(), json!(file["name"].as_str().unwrap_or_default()))]);
        if let Some(resources) = file.get("resources") {
            fields.insert("resources".into(), resources.clone());
        }
        let root = tx.create_with_id("Image", &ObjectId::from_string(ROOT), fields)?;
        fn add(tx: &mut kition_kdm::Tx<'_>, root: &ObjectId, parent: Option<&kition_kdm::NodeRef>, layers: &[Layer]) -> Result<(), kition_kdm::KdmError> {
            for layer in layers {
                let object = tx.create_with_id("Layer", &ObjectId::from_string(format!("layer-{}", layer.id)), fields_of(layer))?;
                if *CONTAINERS {
                    for (key, value) in layer.look.as_object().into_iter().flatten() {
                        tx.map_set(&object, "look", key, value.clone())?;
                    }
                    let mut offset = 0;
                    for run in layer.caption.as_array().into_iter().flatten() {
                        let text = run["insert"].as_str().unwrap_or_default();
                        tx.text_insert(&object, "caption", offset, text)?;
                        let end = offset + text.chars().count();
                        for (key, value) in run["attributes"].as_object().into_iter().flatten() {
                            tx.text_mark(&object, "caption", offset, end, key, value.clone())?;
                        }
                        offset = end;
                    }
                }
                let node = tx.tree_create(root, "layers", parent, &object)?;
                add(tx, root, Some(&node), &layer.layers)?;
            }
            Ok(())
        }
        add(tx, &root, None, &layers)?;
        Ok(())
    })
    .map_err(|error| error.to_string())?;
    Ok(replica)
}

fn fields_of(layer: &Layer) -> Map<String, Value> {
    let mut fields = Map::from_iter([("id".to_owned(), json!(layer.id)), ("name".to_owned(), json!(layer.name)), ("opacity".to_owned(), json!(layer.opacity))]);
    if let Some(value) = layer.fill_opacity {
        fields.insert("fillOpacity".to_owned(), json!(value));
    }
    if let Some(data) = &layer.data {
        fields.insert("data".to_owned(), data.clone());
    }
    if let Some(address) = &layer.address {
        fields.insert("address".to_owned(), address.clone());
    }
    fields
}

pub fn settle_batch(tx: &mut kition_kdm::Tx<'_>) -> Result<(), kition_kdm::KdmError> {
    if std::env::var_os("KITION_KIT_MOCK_MOVE_ADDRESSES").is_some() {
        let tree = tx.tree(&root(), "layers")?;
        for entry in &tree {
            let mut parent = entry.parent.as_ref();
            let mut container = json!("image");
            while let Some(node) = parent {
                let ancestor = tree.iter().find(|other| other.node == *node).unwrap();
                container = tx.get(&ancestor.object, "id")?;
                parent = ancestor.parent.as_ref();
            }
            tx.set(&entry.object, "address", json!({"container":container}))?;
        }
    }
    for id in tx.objects_of_type("Layer") {
        if *CONTAINERS && tx.map_entries(&id, "look")?.is_empty() {
            tx.map_set(&id, "look", "fill", json!("ink"))?;
        }
        if let Some(value) = tx.get(&id, "fillOpacity")?.as_f64() {
            tx.set(&id, "fillOpacity", json!((value * 255.0).round() / 255.0))?;
        }
    }
    Ok(())
}

fn root() -> ObjectId {
    ObjectId::from_string(ROOT)
}

/// Every layer's object and its parent layer's object (`None`: the top level), in pre-order.
fn entries(replica: &Replica) -> Vec<(ObjectId, Option<ObjectId>)> {
    let entries = replica.tree(&root(), "layers").unwrap_or_default();
    entries
        .iter()
        .map(|entry| {
            let parent = entry.parent.as_ref().and_then(|parent| entries.iter().find(|other| other.node == *parent)).map(|other| other.object.clone());
            (entry.object.clone(), parent)
        })
        .collect()
}

/// The children of `parent` (`None`: the top level), in stored order.
fn children(replica: &Replica, parent: Option<&ObjectId>) -> Vec<ObjectId> {
    entries(replica).into_iter().filter(|(_, of)| of.as_ref() == parent).map(|(object, _)| object).collect()
}

fn number(replica: &Replica, object: &ObjectId, field: &str) -> f64 {
    replica.get(object, field).ok().and_then(|value| value.as_f64()).unwrap_or(0.0)
}

fn layer_id(replica: &Replica, object: &ObjectId) -> u64 {
    number(replica, object, "id") as u64
}

fn layer_of(replica: &Replica, object: &ObjectId) -> Layer {
    Layer {
        id: layer_id(replica, object),
        name: replica.get(object, "name").ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default(),
        opacity: number(replica, object, "opacity"),
        fill_opacity: replica.get(object, "fillOpacity").ok().and_then(|value| value.as_f64()),
        data: replica.get(object, "data").ok().filter(|value| !value.is_null()),
        address: replica.get(object, "address").ok().filter(|value| !value.is_null()),
        look: json!(replica.map_entries(object, "look").unwrap_or_default().into_iter().collect::<Map<_, _>>()),
        caption: json!(replica.text_delta(object, "caption").unwrap_or_default()),
        layers: children(replica, Some(object)).iter().map(|child| layer_of(replica, child)).collect(),
    }
}

fn layer_json(layer: &Layer) -> Value {
    let mut value = json!({ "id": layer.id, "name": layer.name, "opacity": layer.opacity });
    if let Some(opacity) = layer.fill_opacity {
        value["fillOpacity"] = json!((opacity * 255.0).round() / 255.0);
    }
    if let Some(data) = &layer.data {
        value["data"] = data.clone();
    }
    if let Some(address) = &layer.address {
        value["address"] = address.clone();
    }
    if *CONTAINERS {
        value["look"] = layer.look.clone();
        value["caption"] = layer.caption.clone();
    }
    if !layer.layers.is_empty() {
        value["layers"] = Value::Array(layer.layers.iter().map(layer_json).collect());
    }
    value
}

/// The image as the file holds it.
pub fn text_of(replica: &Replica) -> String {
    let name = replica.get(&root(), "name").ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default();
    let layers: Vec<Value> = children(replica, None).iter().map(|object| layer_json(&layer_of(replica, object))).collect();
    let mut file = json!({ "name": name, "layers": layers });
    if let Ok(resources) = replica.get(&root(), "resources")
        && !resources.is_null()
    {
        file["resources"] = resources;
    }
    file.to_string()
}

/// How many layers the image has, at any depth.
pub fn count(replica: &Replica) -> usize {
    entries(replica).len()
}

fn id_of(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

/// The layer with id `id`.
fn find(replica: &Replica, id: u64) -> Result<ObjectId, String> {
    entries(replica).into_iter().map(|(object, _)| object).find(|object| layer_id(replica, object) == id).ok_or_else(|| format!("no layer {id} in the image"))
}

/// Whether the image has the layer `id`.
pub fn has_layer(replica: &Replica, id: &Value) -> bool {
    id_of(id).is_some_and(|id| find(replica, id).is_ok())
}

/// The group `in` names (`None`: the top level).
fn group(replica: &Replica, params: &Map<String, Value>) -> Result<Option<ObjectId>, String> {
    match params.get("in") {
        None | Some(Value::Null) => Ok(None),
        Some(id) => Ok(Some(find(replica, id_of(id).ok_or_else(|| format!("`in` is a layer id, not {id}"))?)?)),
    }
}

/// The place (from 0, in stored order) the index spelling `"#n"` names among `count` siblings:
/// counted in stored order, or from the top (the last stored) when `reversed`.
fn stored_index(value: &Value, count: usize, reversed: bool) -> Option<usize> {
    let n = value.as_str()?.strip_prefix('#')?.parse::<usize>().ok()?.checked_sub(1)?;
    if reversed { count.checked_sub(n + 1) } else { Some(n) }
}

/// Whether `command` counts `"#n"` from the top.
fn reversed(command: &str) -> bool {
    command == "layer.fade"
}

/// The layer the target `layer` names: an id, or `"#n"` among the children of `in`; with, for an
/// index, its window among its siblings as `context.under` gives it.
fn target(replica: &Replica, command: &str, params: &Map<String, Value>) -> Result<(Option<u64>, Option<Value>), String> {
    let given = params.get("layer").ok_or("`layer` names the layer: its id or `#n`")?;
    if given.as_str().is_some_and(|text| text.starts_with('#')) {
        let group = group(replica, params)?;
        let siblings = children(replica, group.as_ref());
        let parent = group.as_ref().map_or_else(|| json!(ROOT), |group| json!(layer_id(replica, group)));
        let index = stored_index(given, siblings.len(), reversed(command));
        let found = index.and_then(|index| siblings.get(index)).map(|object| layer_id(replica, object));
        let from = index.unwrap_or(siblings.len());
        let to = if found.is_some() { from + 1 } else { from };
        return Ok((found, Some(json!({ "parent": parent, "field": "layers", "from": from, "to": to }))));
    }
    let id = id_of(given).ok_or_else(|| format!("`layer` is a layer id or `#n`, not {given}"))?;
    Ok((Some(id), None))
}

/// `context.under`: for a write by index, the layer the index names now and its window.
pub fn under(replica: &Replica, command: &str, params: &Map<String, Value>) -> Result<Option<Value>, String> {
    if matches!(command, "resource.rename" | "resource.delete") {
        let list = params.get("list").and_then(Value::as_str).ok_or("`list` names the resource list")?;
        let name = params.get("name").ok_or("`name` names the resource")?;
        let selector = format!("resources.{list}[name={name}]");
        return Ok(Some(json!({ "objects": [], "premises": [{
            "id": ROOT, "fields": [selector], "positions": [], "identities": { (selector): "key" }
        }] })));
    }
    if command == "image.caption" {
        // It reads how many layers the image has, a derived value of the root.
        return Ok(Some(json!({ "objects": [], "premises": [{ "id": ROOT, "fields": ["~layerCount"], "positions": [] }] })));
    }
    if !matches!(command, "layer.opacity" | "layer.fade") {
        return Ok(None);
    }
    // The group `in` is where the index counts, not what the write reads: it must exist, wherever
    // it is (its children's order is the place's window).
    let premises: Vec<Value> =
        params.get("in").filter(|group| !group.is_null()).map(|group| json!({ "id": group, "fields": [], "positions": [] })).into_iter().collect();
    match target(replica, command, params)? {
        (found, Some(window)) => Ok(Some(json!({ "objects": found.into_iter().collect::<Vec<_>>(), "within": [window], "premises": premises }))),
        (_, None) => Ok(None),
    }
}

/// `model.derived`: the root's `layerCount`, by its object id.
pub fn derived(replica: &Replica, ids: Option<&[Value]>) -> Result<Value, String> {
    let wanted = ids.is_none_or(|ids| ids.iter().any(|id| id.as_str() == Some(ROOT)));
    let mut objects = if wanted { vec![json!({ "id": ROOT, "values": { "layerCount": count(replica) } })] } else { Vec::new() };
    if *CONTAINERS {
        for (layer, _) in entries(replica) {
            let id = layer_id(replica, &layer);
            if ids.is_none_or(|ids| ids.iter().any(|value| id_of(value) == Some(id))) {
                objects.push(json!({"id":id,"values":{"nameLength":replica.get(&layer,"name").unwrap_or_default().as_str().unwrap_or_default().len()}}));
            }
        }
    }
    Ok(json!({ "objects": objects }))
}

/// Runs one of the image's commands as `origin`.
pub fn edit(replica: &mut Replica, command: &str, params: &Map<String, Value>, origin: &Origin) -> Result<Edited, String> {
    let kdm = |error: kition_kdm::KdmError| error.to_string();
    let done = |result: Option<Value>| Ok(Edited { changed: true, result, selection: None });
    let root = root();
    match command {
        "resource.rename" | "resource.delete" => {
            let list = params.get("list").and_then(Value::as_str).ok_or("`list` names the resource list")?;
            let name = params.get("name").ok_or("`name` names the resource")?;
            let mut resources = replica.get(&root, "resources").map_err(kdm)?;
            let items = resources[list].as_array_mut().ok_or("no resource list")?;
            let index = items.iter().position(|item| item["name"] == *name).ok_or("no resource with that name")?;
            if command == "resource.delete" {
                items.remove(index);
            } else {
                items[index]["name"] = params.get("to").cloned().ok_or("`to` is the new name")?;
            }
            replica.transact(origin, |tx| tx.set(&root, "resources", resources)).map_err(kdm)?;
            done(None)
        }
        "layer.opacity" | "layer.fade" => {
            let (found, _) = target(replica, command, params)?;
            let object = find(replica, found.ok_or("no layer at that place")?)?;
            let opacity = params.get("opacity").and_then(Value::as_f64).ok_or("`opacity` is a number from 0 to 100")?;
            replica.transact(origin, |tx| tx.set(&object, "opacity", json!(opacity))).map_err(kdm)?;
            done(Some(json!({ "layer": layer_id(replica, &object) })))
        }
        "layer.add" => {
            let group = group(replica, params)?;
            let id = params.get("id").and_then(id_of).ok_or("`id` is the new layer's id")?;
            if find(replica, id).is_ok() {
                return Err(format!("the image has a layer {id}"));
            }
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
            let siblings = children(replica, group.as_ref());
            let at = params.get("at").and_then(Value::as_u64).and_then(|at| usize::try_from(at).ok()).unwrap_or(siblings.len()).min(siblings.len());
            let nodes = replica.tree(&root, "layers").map_err(kdm)?;
            let node_of = |object: &ObjectId| nodes.iter().find(|entry| entry.object == *object).map(|entry| entry.node.clone());
            let parent = group.as_ref().and_then(node_of);
            let later: Vec<_> = siblings[at..].iter().filter_map(node_of).collect();
            replica
                .transact(origin, |tx| {
                    let object = tx.create(
                        "Layer",
                        fields_of(&Layer {
                            address: None,
                            id,
                            name: name.clone(),
                            opacity: 100.0,
                            fill_opacity: None,
                            data: None,
                            look: json!({}),
                            caption: json!([]),
                            layers: Vec::new(),
                        }),
                    )?;
                    tx.tree_create(&root, "layers", parent.as_ref(), &object)?;
                    // A tree adds a node last among its siblings: the later ones go after it.
                    later.iter().try_for_each(|node| tx.tree_move(&root, "layers", node, parent.as_ref()))
                })
                .map_err(kdm)?;
            done(None)
        }
        "layer.delete" => {
            let object = find(replica, params.get("layer").and_then(id_of).ok_or("`layer` is a layer id")?)?;
            replica.transact(origin, |tx| tx.delete(&object)).map_err(kdm)?;
            done(None)
        }
        "layer.move" => {
            let object = find(replica, params.get("layer").and_then(id_of).ok_or("`layer` is a layer id")?)?;
            let group = group(replica, params)?;
            let nodes = replica.tree(&root, "layers").map_err(kdm)?;
            let node_of = |object: &ObjectId| nodes.iter().find(|entry| entry.object == *object).map(|entry| entry.node.clone());
            let node = node_of(&object).ok_or("the layer is in no tree")?;
            let parent = group.as_ref().and_then(node_of);
            replica.transact(origin, |tx| tx.tree_move(&root, "layers", &node, parent.as_ref())).map_err(kdm)?;
            done(None)
        }
        "image.caption" => {
            let text = params.get("text").and_then(Value::as_str).ok_or("`text` is the caption")?;
            let name = format!("{text} ({} layers)", count(replica));
            replica.transact(origin, |tx| tx.set(&root, "name", json!(name))).map_err(kdm)?;
            done(None)
        }
        "image.rename" => {
            let name = params.get("name").and_then(Value::as_str).ok_or("`name` is the image's new name")?;
            replica.transact(origin, |tx| tx.set(&root, "name", json!(name))).map_err(kdm)?;
            done(None)
        }
        "edit.undo" => {
            let scope = match params.get("scope").and_then(Value::as_str) {
                Some(scope) => UndoScope::parse(scope).ok_or("`scope` is person or agent")?,
                None => UndoScope::of(origin.kind).unwrap_or(UndoScope::Person),
            };
            if !replica.undo_in(scope).map_err(kdm)?.is_done() {
                return Err("nothing to undo".to_owned());
            }
            done(None)
        }
        other => Err(format!("unknown command `{other}`")),
    }
}

/// The commands an image offers.
pub fn commands() -> Vec<(&'static str, &'static str, bool, Value)> {
    let group = json!({ "type": "integer", "x-khp-role": "object", "x-khp-types": ["Layer"] });
    let by_index = |order: Option<&str>| {
        let mut layer = json!({ "oneOf": [{ "type": "integer", "minimum": 1 }, { "type": "string" }], "x-khp-role": "targets", "x-khp-index": "#", "x-khp-types": ["Layer"] });
        if let Some(order) = order {
            layer["x-khp-index-order"] = json!(order);
        }
        json!({ "type": "object", "additionalProperties": false, "required": ["layer", "opacity"], "properties": {
            "layer": layer, "in": group.clone(), "opacity": { "type": "number" }
        } })
    };
    vec![
        (
            "resource.rename",
            "Renames a resource held in the image's JSON state.",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["list", "name", "to"], "properties": {
                "list": { "type": "string" }, "name": { "type": "string" }, "to": { "type": "string" }
            } }),
        ),
        (
            "resource.delete",
            "Deletes a resource held in the image's JSON state.",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["list", "name"], "properties": {
                "list": { "type": "string" }, "name": { "type": "string" }
            } }),
        ),
        (
            "layer.opacity",
            "Sets a layer's opacity; `layer` is its id or `#n`, the n-th layer of the group `in` (the top level without it), from the bottom.",
            true,
            by_index(None),
        ),
        (
            "layer.fade",
            "Sets a layer's opacity; `layer` is its id or `#n`, the n-th layer of the group `in` (the top level without it), from the top.",
            true,
            by_index(Some("reversed")),
        ),
        (
            "layer.add",
            "Adds the layer `id` named `name` to the group `in` (the top level without it) at `at` (from 0, from the bottom; the top when left out).",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["id"], "properties": {
                "id": { "type": "integer" }, "name": { "type": "string" }, "in": group.clone(), "at": { "type": "integer" }
            } }),
        ),
        (
            "layer.delete",
            "Deletes the layer `layer` (a group only once it is empty).",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["layer"], "properties": { "layer": { "type": "integer", "x-khp-role": "targets" } } }),
        ),
        (
            "layer.move",
            "Moves the layer `layer` to the top of the group `in` (the top level without it).",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["layer"], "properties": {
                "layer": { "type": "integer", "x-khp-role": "targets" }, "in": group
            } }),
        ),
        (
            "image.caption",
            "Names the image `text` and how many layers it has.",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["text"], "properties": { "text": { "type": "string" } } }),
        ),
        (
            "image.rename",
            "Renames the image.",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["name"], "properties": { "name": { "type": "string" } } }),
        ),
    ]
}
