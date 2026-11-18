// Copied from kition-sdk crates/kition-kit-mock/src/space.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Documents as scenes of nodes in space (`KITION_KIT_MOCK_PARTS=space`), as a 3D kit
//! models them: each node has an integer tool id (`key`), a name, a `location` (a json `[x, y, z]`)
//! and a `parent` (a node's key, or none), both marked `position`, a `hidden` flag, and a mesh (a
//! json `{ verts, faces }`). A node's world location is its location plus its parent's world
//! location (translation only), so a parent's move moves its children in the world while their
//! stored fields stay. The file is the scene as JSON, `{ "nodes": [ … ] }`.
//!
//! Commands address a node by its key (`node`, the declared target), by its name (`node` as a
//! string), or by a world point (`pick: [x, y, z]`, a place): the visible node whose world box (its
//! mesh's local bounds around its world location) holds the point, the smallest first. A mesh's
//! faces and vertices are addressed by index (`mesh.extrude`'s `face`, `mesh.moveVertex`'s
//! `vertex`), which a topology change renumbers.
//!
//! The kit answers `context.under` (premises per call: a rename reads the name alone; a write by
//! element index the mesh's topology, `~topology`), and for a pick the place's `covers`, so the
//! guard asks `context.covered` whether the objects others moved were under the point at `basis`;
//! and it declares two derived values per node (`model.derived`): `topology` (vertex and face
//! counts and a hash of the faces) and `bounds` (the mesh's local bounds).

use std::hash::{Hash, Hasher};
use std::sync::{Arc, LazyLock};

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, UndoScope};
use serde_json::{Map, Value, json};

use crate::tracks::Edited;

/// The scene's object model: nodes in the root's `nodes` list, named by their integer `key`.
pub const SCHEMA: &str = r#"{
  "kdm": 1, "kit": "kit.mock", "schemaVersion": 1, "root": "Scene",
  "types": {
    "Scene": { "fields": { "nodes": { "kind": "list", "of": "Node" }, "materials": { "kind": "list", "of": "Material" } } },
    "Material": { "fields": { "name": { "kind": "string" } } },
    "Node": { "fields": {
      "key": { "kind": "integer", "readOnly": true, "optional": true },
      "name": { "kind": "string" },
      "location": { "kind": "json", "position": true },
      "frame": { "kind": "json", "optional": true, "position": true },
      "parent": { "kind": "integer", "optional": true, "position": true },
      "hidden": { "kind": "boolean" },
      "mesh": { "kind": "json", "optional": true }
    }, "toolId": { "field": "key" },
    "derived": {
      "topology": { "description": "the mesh's vertex and face counts and a hash of its faces: element indexes stay valid while it is unchanged" },
      "bounds": { "description": "the mesh's local bounds, [[min x, y, z], [max x, y, z]]" }
    } }
  }
}"#;

/// Whether documents are scenes of nodes.
pub static SPACE: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_PARTS").is_ok_and(|value| value.trim() == "space"));

static CREATION_KIND: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_CREATION_KIND").is_ok());
static CREATION_SCHEMA: LazyLock<String> = LazyLock::new(|| {
    let mut schema: Value = serde_json::from_str(SCHEMA).unwrap();
    if std::env::var_os("KITION_KIT_MOCK_CREATION_KIND").is_some() {
        schema["types"]["Node"]["fields"]["kind"] = json!({"kind":"enum","values":["shape","frame"],"readOnly":true});
    }
    if std::env::var_os("KITION_KIT_MOCK_WORLD_DERIVED").is_some() {
        schema["types"]["Node"]["derived"]["worldLocation"] = json!({"description":"the node's location composed with all ancestors"});
    }
    if std::env::var_os("KITION_KIT_MOCK_PRIVATE_DERIVED").is_some() {
        schema["types"]["Node"]["derived"]["worldLocation"]["premiseOnly"] = json!(true);
    }
    if std::env::var_os("KITION_KIT_MOCK_PRIVATE_BOUNDS").is_some() {
        schema["types"]["Node"]["derived"]["bounds"]["premiseOnly"] = json!(true);
    }
    schema.to_string()
});

pub fn schema() -> &'static str {
    &CREATION_SCHEMA
}

const ROOT: &str = "scene";

/// How near a point a node without a mesh must have its origin to be picked.
const ORIGIN_REACH: f64 = 0.25;

/// The most objects one `context.covered` request may carry.
pub const COVERED_BUDGET: usize = 4096;

type Vec3 = [f64; 3];

/// A mesh: vertices, and faces by vertex index.
#[derive(Clone, Debug, PartialEq)]
struct Mesh {
    verts: Vec<Vec3>,
    faces: Vec<Vec<usize>>,
}

/// A node as the file holds it.
#[derive(Clone, Debug, PartialEq)]
struct Node {
    key: u64,
    name: String,
    location: Vec3,
    frame: Option<Value>,
    parent: Option<u64>,
    hidden: bool,
    mesh: Option<Mesh>,
    /// The local bounds when told rather than read from the mesh (`context.covered`'s before
    /// values: a deleted node's mesh is gone, its `~bounds` is not).
    bounds: Option<Option<(Vec3, Vec3)>>,
}

fn vec3(value: &Value) -> Option<Vec3> {
    let items = value.as_array()?;
    match items.as_slice() {
        [x, y, z] => Some([x.as_f64()?, y.as_f64()?, z.as_f64()?]),
        _ => None,
    }
}

fn mesh_of(value: &Value) -> Option<Mesh> {
    let verts = value["verts"].as_array()?.iter().map(vec3).collect::<Option<Vec<_>>>()?;
    let faces = value["faces"]
        .as_array()?
        .iter()
        .map(|face| face.as_array()?.iter().map(|index| index.as_u64().and_then(|index| usize::try_from(index).ok())).collect::<Option<Vec<_>>>())
        .collect::<Option<Vec<_>>>()?;
    Some(Mesh { verts, faces })
}

fn mesh_json(mesh: &Mesh) -> Value {
    json!({ "verts": mesh.verts, "faces": mesh.faces })
}

fn parse(text: &str) -> Result<Vec<Node>, String> {
    let file: Value = serde_json::from_str(text).map_err(|error| format!("the scene is no JSON: {error}"))?;
    let mut nodes = Vec::new();
    for node in file["nodes"].as_array().ok_or("the scene is `{ \"nodes\": [ … ] }`")? {
        nodes.push(Node {
            key: node["key"].as_u64().filter(|key| *key > 0).ok_or_else(|| format!("{node} has no `key` (a whole number from 1)"))?,
            name: node["name"].as_str().unwrap_or_default().to_owned(),
            location: vec3(&node["location"]).ok_or_else(|| format!("{node} has no `location` [x, y, z]"))?,
            frame: node.get("frame").cloned(),
            parent: node["parent"].as_u64(),
            hidden: node["hidden"].as_bool().unwrap_or(false),
            mesh: match &node["mesh"] {
                Value::Null => None,
                mesh => Some(mesh_of(mesh).ok_or_else(|| format!("{mesh} is no mesh: {{ verts, faces }}"))?),
            },
            bounds: None,
        });
    }
    Ok(nodes)
}

fn fields_of(node: &Node) -> Map<String, Value> {
    let mut fields = Map::from_iter([
        ("key".to_owned(), json!(node.key)),
        ("name".to_owned(), json!(node.name)),
        ("location".to_owned(), json!(node.location)),
        ("hidden".to_owned(), json!(node.hidden)),
    ]);
    if let Some(parent) = node.parent {
        fields.insert("parent".into(), json!(parent));
    }
    if let Some(frame) = &node.frame {
        fields.insert("frame".into(), frame.clone());
    }
    if let Some(mesh) = &node.mesh {
        fields.insert("mesh".into(), mesh_json(mesh));
    }
    fields
}

/// A new scene replica from its text.
pub fn build(text: &str) -> Result<Replica, String> {
    let nodes = parse(text)?;
    let file: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let schema = Arc::new(Schema::parse(schema()).map_err(|error| error.to_string())?);
    let (replica, ()) = Replica::create_with(schema, DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
        let root = tx.create_with_id("Scene", &ObjectId::from_string(ROOT), Map::new())?;
        for (at, node) in nodes.iter().enumerate() {
            let mut fields = fields_of(node);
            if *CREATION_KIND {
                fields.insert("kind".into(), file["nodes"][at]["kind"].clone());
            }
            let object = tx.create_with_id("Node", &ObjectId::from_string(format!("node-{}", node.key)), fields)?;
            tx.list_insert(&root, "nodes", at, &object)?;
        }
        for (at, name) in file["materials"].as_array().into_iter().flatten().enumerate() {
            let object =
                tx.create_with_id("Material", &ObjectId::from_string(format!("material-{at}")), Map::from_iter([("name".to_owned(), name.clone())]))?;
            tx.list_insert(&root, "materials", at, &object)?;
        }
        Ok(())
    })
    .map_err(|error| error.to_string())?;
    Ok(replica)
}

fn objects(replica: &Replica) -> Vec<ObjectId> {
    kition_kdm::batch::root_id(replica).and_then(|root| replica.list(&root, "nodes").ok()).unwrap_or_default()
}

fn node_of(replica: &Replica, object: &ObjectId) -> Node {
    let get = |field: &str| replica.get(object, field).unwrap_or(Value::Null);
    Node {
        key: get("key").as_u64().unwrap_or(0),
        name: get("name").as_str().unwrap_or_default().to_owned(),
        location: vec3(&get("location")).unwrap_or_default(),
        frame: replica.get(object, "frame").ok().filter(|value| !value.is_null()),
        parent: get("parent").as_u64(),
        hidden: get("hidden").as_bool().unwrap_or(false),
        mesh: mesh_of(&get("mesh")),
        bounds: None,
    }
}

fn nodes(replica: &Replica) -> Vec<Node> {
    objects(replica).iter().map(|object| node_of(replica, object)).collect()
}

/// The scene as the file holds it.
pub fn text_of(replica: &Replica) -> String {
    let nodes: Vec<Value> = objects(replica)
        .iter()
        .map(|object| {
            let mut fields = fields_of(&node_of(replica, object));
            if *CREATION_KIND {
                fields.insert("kind".into(), replica.get(object, "kind").unwrap());
            }
            Value::Object(fields)
        })
        .collect();
    let materials: Vec<Value> =
        replica.list(&ObjectId::from_string(ROOT), "materials").unwrap_or_default().iter().map(|id| replica.get(id, "name").unwrap_or(Value::Null)).collect();
    json!({ "nodes": nodes, "materials": materials }).to_string()
}

/// How many nodes the scene has.
pub fn count(replica: &Replica) -> usize {
    objects(replica).len()
}

/// The node with key `key`, its object and index.
fn find(replica: &Replica, key: u64) -> Result<(ObjectId, usize), String> {
    objects(replica)
        .into_iter()
        .enumerate()
        .find(|(_, object)| replica.get(object, "key").ok().and_then(|value| value.as_u64()) == Some(key))
        .map(|(index, object)| (object, index))
        .ok_or_else(|| format!("no node {key} in the scene"))
}

/// Whether the scene has the node `id` (its key, as a number or numeric string).
pub fn has_node(replica: &Replica, id: &Value) -> bool {
    key_of(id).is_some_and(|key| find(replica, key).is_ok())
}

fn key_of(id: &Value) -> Option<u64> {
    id.as_u64().or_else(|| id.as_str().and_then(|text| text.parse().ok()))
}

/// The local bounds of a node: told, else its mesh's.
fn local_bounds(node: &Node) -> Option<(Vec3, Vec3)> {
    if let Some(told) = node.bounds {
        return told;
    }
    let mesh = node.mesh.as_ref()?;
    let first = *mesh.verts.first()?;
    Some(
        mesh.verts.iter().fold((first, first), |(lo, hi), point| {
            (std::array::from_fn(|axis| lo[axis].min(point[axis])), std::array::from_fn(|axis| hi[axis].max(point[axis])))
        }),
    )
}

/// A node's world location: its location plus its parents'.
fn world(nodes: &[Node], node: &Node) -> Vec3 {
    let mut at = node.location;
    let mut parent = node.parent;
    let mut depth = 0;
    while let Some(key) = parent.filter(|_| depth < 64) {
        let Some(up) = nodes.iter().find(|node| node.key == key) else { break };
        at = std::array::from_fn(|axis| at[axis] + up.location[axis]);
        parent = up.parent;
        depth += 1;
    }
    at
}

/// The node at world point `at`: the smallest visible node whose world box holds it (then the
/// first listed), else the nearest visible node without a mesh within [`ORIGIN_REACH`].
fn pick(nodes: &[Node], at: Vec3) -> Option<u64> {
    let mut best: Option<(f64, u64)> = None;
    for node in nodes.iter().filter(|node| !node.hidden) {
        let Some((lo, hi)) = local_bounds(node) else { continue };
        let origin = world(nodes, node);
        let slack = 1e-3;
        let inside = (0..3).all(|axis| at[axis] >= origin[axis] + lo[axis] - slack && at[axis] <= origin[axis] + hi[axis] + slack);
        if inside {
            let volume: f64 = (0..3).map(|axis| (hi[axis] - lo[axis]).max(slack)).product();
            if best.is_none_or(|(smallest, _)| volume < smallest) {
                best = Some((volume, node.key));
            }
        }
    }
    if let Some((_, key)) = best {
        return Some(key);
    }
    let mut nearest: Option<(f64, u64)> = None;
    for node in nodes.iter().filter(|node| !node.hidden && local_bounds(node).is_none()) {
        let origin = world(nodes, node);
        let distance = (0..3).map(|axis| (origin[axis] - at[axis]).powi(2)).sum::<f64>().sqrt();
        if distance <= ORIGIN_REACH && nearest.is_none_or(|(near, _)| distance < near) {
            nearest = Some((distance, node.key));
        }
    }
    nearest.map(|(_, key)| key)
}

/// Whether `key` is `of` or below it.
fn derives_from(nodes: &[Node], key: u64, of: u64) -> bool {
    let mut current = Some(key);
    let mut depth = 0;
    while let Some(at) = current.filter(|_| depth < 64) {
        if at == of {
            return true;
        }
        current = nodes.iter().find(|node| node.key == at).and_then(|node| node.parent);
        depth += 1;
    }
    false
}

/// The node a target value names: a key, or a name (the first node so named).
fn named(nodes: &[Node], id: &Value) -> Option<u64> {
    match id {
        Value::String(text) if text.parse::<u64>().is_err() => nodes.iter().find(|node| node.name == *text).map(|node| node.key),
        other => key_of(other),
    }
}

/// `context.under` for a scene: a pick names the node at its point now and asks to be asked about
/// what moved (`covers`: the place depends on every node's position, its `hidden` flag and its
/// mesh's bounds); a write by element index needs the mesh's topology alone; a rename the name
/// alone (by key, by name, or by a pick).
pub fn under(replica: &Replica, command: &str, params: &Map<String, Value>) -> Result<Option<Value>, String> {
    let nodes = nodes(replica);
    if let Some(index) = params.get("rootIndex").and_then(Value::as_u64) {
        return Ok(Some(json!({"objects":[],"within":[{"parent":ROOT,"field":"nodes","from":index,"to":index+1}]})));
    }
    if let Some(mode) = params.get("orderMode").and_then(Value::as_str) {
        let held = params.get("held").and_then(Value::as_array).cloned().unwrap_or_default();
        let positions = if mode == "exact" { json!(["nodes"]) } else { json!([]) };
        let mut answer = json!({"objects":[],"premises":held.iter().map(|id|json!({"id":id,"fields":["name"],"positions":positions})).collect::<Vec<_>>()});
        if mode == "relative" || mode == "anchored" {
            answer["orders"] = json!([{"parent":ROOT,"field":"nodes","objects":held}]);
        }
        if mode == "window" {
            answer["within"] = json!([{"parent":ROOT,"field":"nodes","from":3,"to":7}]);
        }
        return Ok(Some(answer));
    }
    if command == "node.move"
        && let Some(node) = params.get("node").and_then(|id| named(&nodes, id)).and_then(|key| nodes.iter().find(|node| node.key == key))
        && let Some(parent) = node.parent.and_then(|key| nodes.iter().find(|node| node.key == key)).filter(|parent| parent.frame.is_some())
    {
        return Ok(Some(json!({ "objects": [], "premises": [
            { "id": node.key, "fields": [], "positions": ["location", "parent"] },
            { "id": parent.key, "fields": [], "positions": ["frame.transform"] }
        ] })));
    }
    let reads = |key: Value| match command {
        "node.rename" => {
            Some(json!({ "id": key, "fields": [if params.get("world")==Some(&Value::Bool(true)) {"~worldLocation"}else{"name"}], "positions": [] }))
        }
        "mesh.extrude" | "mesh.moveVertex" => Some(json!({ "id": key, "fields": ["~topology"], "positions": [] })),
        _ => None,
    };
    if let Some(at) = params.get("pick") {
        let at = vec3(at).ok_or("`pick` is a world point [x, y, z]")?;
        let found: Vec<u64> = pick(&nodes, at).into_iter().collect();
        let premises: Vec<Value> = found.iter().filter_map(|key| reads(json!(key))).collect();
        let mut answer = json!({ "objects": found, "covers": { "fields": ["hidden", "~bounds"] }, "premises": premises });
        if params.get("window") == Some(&Value::Bool(true)) {
            answer["within"] = json!([{"parent":ROOT,"field":"nodes","from":0,"to":1}]);
        }
        return Ok(Some(answer));
    }
    match params.get("node").and_then(|id| named(&nodes, id)) {
        Some(key) => Ok(reads(json!(key)).map(|premise| json!({ "objects": [], "premises": [premise] }))),
        None => Ok(None),
    }
}

/// `context.covered`: what a pick named at `basis` (`under`), read in the scene with every object's
/// before values put in at once (`objects`: `{ id, before, deleted?, created?, unknown? }`; a
/// created one left out), and for each object whether it (or a node below it) was what it named;
/// nothing in the document changes. An object whose before state is not fully told (`unknown`) is
/// answered `null`.
pub fn covered(replica: &Replica, params: &Map<String, Value>, objects: &[Value]) -> Result<Value, String> {
    if objects.len() > COVERED_BUDGET {
        return Err(format!("at most {COVERED_BUDGET} objects a request"));
    }
    if params.get("cannot") == Some(&Value::Bool(true)) {
        return Ok(json!({"under":[],"covered":objects.iter().map(|o|json!({"id":o["id"],"covered":null})).collect::<Vec<_>>()}));
    }
    let at = params.get("pick").and_then(vec3).ok_or("`covered` answers a pick: `params.pick` is a world point [x, y, z]")?;
    let mut before = nodes(replica);
    let mut positions = Vec::new();
    for object in objects {
        let key = key_of(&object["id"]).ok_or_else(|| format!("{} is no node key", object["id"]))?;
        // Created since `basis`: not there then.
        if object["created"] == true {
            before.retain(|node| node.key != key);
            continue;
        }
        let was = &object["before"];
        if was["$at"]["field"] == "nodes"
            && let Some(index) = was["$at"]["index"].as_u64()
        {
            positions.push((index as usize, key));
        }
        let index = match before.iter().position(|node| node.key == key) {
            Some(index) => index,
            None => {
                before.push(Node { key, name: String::new(), location: [0.0; 3], frame: None, parent: None, hidden: false, mesh: None, bounds: Some(None) });
                before.len() - 1
            }
        };
        let node = &mut before[index];
        if let Some(location) = was.get("location") {
            node.location = vec3(location).ok_or_else(|| format!("{location} is no location"))?;
        }
        if let Some(parent) = was.get("parent") {
            node.parent = parent.as_u64();
        }
        if let Some(hidden) = was.get("hidden") {
            node.hidden = hidden.as_bool().unwrap_or(false);
        }
        if let Some(bounds) = was.get("~bounds") {
            node.bounds = Some(bounds_of(bounds));
        }
    }
    positions.sort();
    for (index, key) in positions {
        if let Some(at) = before.iter().position(|node| node.key == key) {
            let node = before.remove(at);
            before.insert(index.min(before.len()), node);
        }
    }
    let picked = pick(&before, at);
    let answers: Vec<Value> = objects
        .iter()
        .map(|object| {
            let unknown = object["unknown"].as_array().is_some_and(|unknown| !unknown.is_empty());
            let key = key_of(&object["id"]).unwrap_or(0);
            let covered = if unknown { Value::Null } else { json!(picked.is_some_and(|picked| derives_from(&before, picked, key))) };
            json!({ "id": object["id"], "covered": covered })
        })
        .collect();
    Ok(json!({ "under": picked.into_iter().collect::<Vec<_>>(), "covered": answers }))
}

fn bounds_of(value: &Value) -> Option<(Vec3, Vec3)> {
    let pair = value.as_array()?;
    match pair.as_slice() {
        [lo, hi] => Some((vec3(lo)?, vec3(hi)?)),
        _ => None,
    }
}

/// The derived values of a node (`model.derived`).
fn derived_of(node: &Node, names: &[String]) -> Map<String, Value> {
    let mut values = Map::new();
    for name in names {
        let value = match name.as_str() {
            "topology" => match &node.mesh {
                Some(mesh) => {
                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                    mesh.faces.hash(&mut hasher);
                    json!(format!("{}v{}f:{:08x}", mesh.verts.len(), mesh.faces.len(), hasher.finish() & 0xffff_ffff))
                }
                None => Value::Null,
            },
            "bounds" => local_bounds(node).map_or(Value::Null, |(lo, hi)| json!([lo, hi])),
            _ => continue,
        };
        values.insert(name.clone(), value);
    }
    values
}

/// `model.derived`: the derived values `names` (every declared one when none) of the nodes `ids`
/// (every node when none), by key.
pub fn derived(replica: &Replica, ids: Option<&[Value]>, names: Option<&[String]>) -> Result<Value, String> {
    if std::env::var_os("KITION_KIT_MOCK_DERIVED_FAILURE").is_some() && nodes(replica).iter().any(|node| node.name == "Fail derived") {
        return Err("derived values unavailable".into());
    }
    let all = ["topology".to_owned(), "bounds".to_owned(), "worldLocation".to_owned()];
    let names = names.unwrap_or(&all);
    let nodes = nodes(replica);
    let mut found = Vec::new();
    match ids {
        Some(ids) => {
            for id in ids {
                let node = key_of(id).and_then(|key| nodes.iter().find(|node| node.key == key)).ok_or_else(|| format!("no node {id} in the scene"))?;
                let mut values = derived_of(node, names);
                if std::env::var_os("KITION_KIT_MOCK_WORLD_DERIVED").is_some() && names.iter().any(|name| name == "worldLocation") {
                    values.insert("worldLocation".into(), json!(world(&nodes, node)));
                }
                found.push(json!({ "id": node.key, "values": values }));
            }
        }
        None => found.extend(nodes.iter().map(|node| {
            let mut values = derived_of(node, names);
            if std::env::var_os("KITION_KIT_MOCK_WORLD_DERIVED").is_some() && names.iter().any(|name| name == "worldLocation") {
                values.insert("worldLocation".into(), json!(world(&nodes, node)));
            }
            json!({ "id": node.key, "values": values })
        })),
    }
    Ok(json!({ "objects": found }))
}

/// `model.carried`: for each node of `ids` that has descendants, how many it carries in world
/// space (a change of its location moves them all).
pub fn carried(replica: &Replica, ids: &[Value], changes: &[Value]) -> Result<Value, String> {
    let nodes = nodes(replica);
    let mut found = Vec::new();
    for id in ids {
        let Some(key) = key_of(id) else { continue };
        let affects_world = changes.iter().filter(|change| key_of(&change["id"]) == Some(key)).any(|change| {
            change["fields"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|field| matches!(field.split('.').next(), Some("location" | "parent")))
        });
        if !affects_world {
            continue;
        }
        let mut count = 0u64;
        let mut frontier = vec![key];
        let mut seen = std::collections::BTreeSet::from([key]);
        while let Some(parent) = frontier.pop() {
            for child in nodes.iter().filter(|node| node.parent == Some(parent)) {
                if seen.insert(child.key) {
                    count += 1;
                    frontier.push(child.key);
                }
            }
        }
        if count > 0 {
            found.push(json!({ "id": key, "carries": { "count": count, "what": "world location" } }));
        }
    }
    Ok(json!({ "objects": found }))
}

/// Runs one of the scene's commands as `origin`.
pub fn edit(replica: &mut Replica, command: &str, params: &Map<String, Value>, origin: &Origin) -> Result<Edited, String> {
    let kdm = |error: kition_kdm::KdmError| error.to_string();
    let all = nodes(replica);
    let target = |key: &str| -> Result<(ObjectId, Node), String> {
        let named = match (params.get(key), params.get("pick")) {
            (Some(id), _) => named(&all, id).ok_or_else(|| format!("no node {id} in the scene"))?,
            (None, Some(at)) => {
                pick(&all, vec3(at).ok_or("`pick` is a world point [x, y, z]")?).ok_or_else(|| format!("nothing at {at}: name the node by its key"))?
            }
            (None, None) => params
                .get("rootIndex")
                .and_then(Value::as_u64)
                .and_then(|index| all.get(index as usize))
                .map(|node| node.key)
                .ok_or_else(|| format!("`{key}` names the node (its key or its name), or `pick` a world point"))?,
        };
        let (object, _) = find(replica, named)?;
        Ok((object.clone(), node_of(replica, &object)))
    };
    let keys = |key: &str| -> Result<Vec<u64>, String> {
        match params.get(key) {
            Some(Value::Array(items)) => items.iter().map(|id| named(&all, id).ok_or_else(|| format!("no node {id} in the scene"))).collect(),
            Some(one) => Ok(vec![named(&all, one).ok_or_else(|| format!("no node {one} in the scene"))?]),
            None => Err(format!("`{key}` names the nodes")),
        }
    };
    let offset = |key: &str| params.get(key).and_then(vec3).ok_or_else(|| format!("`{key}` is [x, y, z]"));
    let done = |result: Option<Value>| Ok(Edited { changed: true, result, selection: None });
    match command {
        "node.rename" => {
            let (object, node) = target("node")?;
            let name = params.get("name").and_then(Value::as_str).ok_or("`name` is the new name")?;
            replica.transact(origin, |tx| tx.set(&object, "name", json!(name))).map_err(kdm)?;
            done(Some(json!({ "node": node.key })))
        }
        "node.move" => {
            let (object, node) = target("node")?;
            let by = offset("offset")?;
            let to: Vec3 = std::array::from_fn(|axis| node.location[axis] + by[axis]);
            replica.transact(origin, |tx| tx.set(&object, "location", json!(to))).map_err(kdm)?;
            done(None)
        }
        "node.place" => {
            let (object, _) = target("node")?;
            let value = params.get("location").ok_or("location is required")?;
            let to = if let Some(key) = named(&all, value) {
                let (node, _) = find(replica, key)?;
                node_of(replica, &node).location
            } else {
                offset("location")?
            };
            replica.transact(origin, |tx| tx.set(&object, "location", json!(to))).map_err(kdm)?;
            done(None)
        }
        "node.parent" => {
            let (object, node) = target("node")?;
            let parent = match params.get("parent") {
                None | Some(Value::Null) => None,
                Some(id) => Some(named(&all, id).filter(|key| find(replica, *key).is_ok()).ok_or_else(|| format!("no node {id} in the scene"))?),
            };
            if parent.is_some_and(|parent| derives_from(&all, parent, node.key)) {
                return Err("a node cannot be its own parent".to_owned());
            }
            replica.transact(origin, |tx| tx.set(&object, "parent", parent.map_or(Value::Null, |parent| json!(parent)))).map_err(kdm)?;
            done(None)
        }
        "node.hide" => {
            let objects = keys("nodes")?.into_iter().map(|key| find(replica, key).map(|(object, _)| object)).collect::<Result<Vec<_>, _>>()?;
            replica.transact(origin, |tx| objects.iter().try_for_each(|object| tx.set(object, "hidden", json!(true)))).map_err(kdm)?;
            done(None)
        }
        "node.delete" => {
            let root = kition_kdm::batch::root_id(replica).ok_or("the scene has no root")?;
            for key in keys("nodes")? {
                let (object, index) = find(replica, key)?;
                replica
                    .transact(origin, |tx| {
                        tx.list_remove(&root, "nodes", index)?;
                        tx.delete(&object)
                    })
                    .map_err(kdm)?;
            }
            done(None)
        }
        "mesh.moveVertex" => {
            let (object, node) = target("node")?;
            let mut mesh = node.mesh.ok_or("the node has no mesh")?;
            let vertex = params.get("vertex").and_then(Value::as_u64).and_then(|vertex| usize::try_from(vertex).ok()).ok_or("`vertex` is a vertex index")?;
            let by = offset("offset")?;
            let point = mesh.verts.get_mut(vertex).ok_or_else(|| format!("the mesh has no vertex {vertex}"))?;
            *point = std::array::from_fn(|axis| point[axis] + by[axis]);
            replica.transact(origin, |tx| tx.set(&object, "mesh", mesh_json(&mesh))).map_err(kdm)?;
            done(None)
        }
        "mesh.subdivide" => {
            // Each face becomes itself and one face more through its first edge's midpoint: the
            // topology changes, the bounds do not.
            let (object, node) = target("node")?;
            let mut mesh = node.mesh.ok_or("the node has no mesh")?;
            let faces = mesh.faces.clone();
            for face in faces {
                let (Some(&a), Some(&b)) = (face.first(), face.get(1)) else { continue };
                let (Some(pa), Some(pb)) = (mesh.verts.get(a).copied(), mesh.verts.get(b).copied()) else { continue };
                mesh.verts.push(std::array::from_fn(|axis| (pa[axis] + pb[axis]) / 2.0));
                let mid = mesh.verts.len() - 1;
                mesh.faces.push(vec![a, mid, b]);
            }
            replica.transact(origin, |tx| tx.set(&object, "mesh", mesh_json(&mesh))).map_err(kdm)?;
            done(None)
        }
        "mesh.extrude" => {
            let (object, node) = target("node")?;
            let mut mesh = node.mesh.ok_or("the node has no mesh")?;
            let face = params.get("face").and_then(Value::as_u64).and_then(|face| usize::try_from(face).ok()).ok_or("`face` is a face index")?;
            let corners = mesh.faces.get(face).cloned().ok_or_else(|| format!("the mesh has no face {face}"))?;
            let distance = params.get("distance").and_then(Value::as_f64).unwrap_or(0.5);
            let mut lifted = Vec::new();
            for corner in &corners {
                let point = *mesh.verts.get(*corner).ok_or("a face names a vertex the mesh lacks")?;
                mesh.verts.push([point[0], point[1], point[2] + distance]);
                lifted.push(mesh.verts.len() - 1);
            }
            mesh.faces.push(lifted);
            replica.transact(origin, |tx| tx.set(&object, "mesh", mesh_json(&mesh))).map_err(kdm)?;
            done(Some(json!({ "faces": mesh.faces.len() })))
        }
        "edit.undo" => {
            let scope = match params.get("scope").and_then(Value::as_str) {
                Some(scope) => UndoScope::parse(scope).ok_or("`scope` is person or agent")?,
                None => UndoScope::of(origin.kind).unwrap_or(UndoScope::Person),
            };
            if !replica.undo_in(scope).map_err(kdm)? {
                return Err("nothing to undo".to_owned());
            }
            done(None)
        }
        other => Err(format!("unknown command `{other}`")),
    }
}

/// The commands a scene offers: what names the node each acts on (`node`, the declared target, a
/// key or a name), the world point (`pick`, a place), and whether the effect depends on where the
/// node is.
pub fn commands() -> Vec<(&'static str, &'static str, bool, Value)> {
    let node =
        json!({ "oneOf": [{ "type": "integer", "minimum": 1 }, { "type": "string" }], "x-khp-role": "targets", "x-khp-name": "name", "x-khp-types": ["Node"] });
    let pick = json!({ "type": "array", "items": { "type": "number" }, "x-khp-role": "place" });
    let point = json!({ "type": "array", "items": { "type": "number" } });
    let props = |extra: Value| {
        let mut properties = json!({ "node": node.clone(), "pick": pick.clone() });
        if let (Some(properties), Some(extra)) = (properties.as_object_mut(), extra.as_object()) {
            properties.extend(extra.clone());
        }
        properties
    };
    let schema = |properties: Value, independent: bool| {
        let mut schema = json!({ "type": "object", "additionalProperties": false, "properties": properties });
        if independent {
            schema["x-khp-position"] = json!("independent");
        }
        schema
    };
    vec![
        (
            "node.rename",
            "Renames the node `node` (its key or its name) or the one at `pick`.",
            true,
            schema(
                props(json!({ "name": { "type": "string" }, "world":{"type":"boolean"},"window":{"type":"boolean"},"cannot":{"type":"boolean"},
                "rootIndex":{"type":"integer"},"orderMode":{"type":"string"},"held":{"type":"array","items":{"type":"integer"},"x-khp-role":"object"} })),
                true,
            ),
        ),
        ("node.move", "Moves the node by `offset` [x, y, z].", true, schema(props(json!({ "offset": point.clone() })), false)),
        (
            "node.place",
            "Puts the node at `location` [x, y, z] or at a named node.",
            true,
            schema(
                props(json!({ "location": {
            "oneOf": [point.clone(), {"type":"integer"}, {"type":"string"}], "x-khp-name":"name", "x-khp-role":"object", "x-khp-types":["Node"]
        } })),
                false,
            ),
        ),
        (
            "node.parent",
            "Makes `parent` (a node's key; null for none) the node's parent; the node keeps its location relative to the parent.",
            true,
            schema(
                props(
                    json!({ "parent": { "oneOf": [{ "type": "integer" }, { "type": "string" }, { "type": "null" }], "x-khp-role": "object", "x-khp-name": "name", "x-khp-types": ["Node"] } }),
                ),
                false,
            ),
        ),
        (
            "node.hide",
            "Hides the nodes `nodes`: one key or name, or a list of keys.",
            true,
            json!({ "type": "object", "additionalProperties": false, "x-khp-position": "independent", "properties": {
                "nodes": { "oneOf": [{ "type": "integer" }, { "type": "string" }, { "type": "array", "items": { "type": "integer" } }], "x-khp-role": "targets" }
            } }),
        ),
        (
            "node.delete",
            "Deletes the nodes `nodes`.",
            true,
            json!({ "type": "object", "additionalProperties": false, "properties": {
                "nodes": { "type": "array", "items": { "type": "integer" }, "x-khp-role": "targets" }
            } }),
        ),
        (
            "mesh.moveVertex",
            "Moves the vertex `vertex` (an index) of the node's mesh by `offset`.",
            true,
            schema(props(json!({ "vertex": { "type": "integer" }, "offset": point.clone() })), false),
        ),
        ("mesh.subdivide", "Subdivides the node's mesh: new vertices and faces; the bounds stay.", true, schema(props(json!({})), false)),
        (
            "mesh.extrude",
            "Extrudes the face `face` (an index) of the node's mesh by `distance` up.",
            true,
            schema(props(json!({ "face": { "type": "integer" }, "distance": { "type": "number" } })), false),
        ),
    ]
}
