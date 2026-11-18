// Copied from kition-sdk crates/kition-kit-mock/src/reels.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Reels in a timeline (`KITION_KIT_MOCK_PARTS=tracks`): a reel is an object with a tool
//! id (`reel:<name>`) that holds, through a ref it owns (`body`), a lane: its markers (a `json`
//! list of `{ id, name, time }`, as a video kit's sequence markers), its shots (objects with
//! integer tool ids, as clips) and its keys (objects without tool ids, `{ time, value }` in time
//! order, as a motion kit's keyframes). A line of the file that starts with `@` is a reel:
//!
//! ```text
//! @R1|501=10,502=20|1=10,2=20,3=30|[{"id":7,"name":"a","time":1}]
//! ```
//!
//! the reel's name, its shots (`<id>=<amount>`), its keys (`<time>=<value>`) and its markers
//! (JSON, the rest of the line).
//!
//! Commands: `reel.shot` sets a shot's amount (by id); `reel.marker` renames the marker with an
//! id, `reel.markerAdd` adds one; `reel.key` sets the value of the key at a time, adding it in time
//! order when there is none. `context.under` states their premises: a marker by its index in the
//! markers (`body.markers.<i>`) or, with `byKey`, by a selector on its id
//! (`body.markers[id=7]`); a key by a selector on its time (`body.keys[time=2]`), or with
//! `byIndex` by its index now (`body.keys.<i>`).

use kition_kdm::{ObjectId, Origin, Replica, Tx};
use serde_json::{Map, Value, json};

use crate::tracks::Edited;

/// A reel as the file holds it.
#[derive(Clone, Debug, PartialEq)]
pub struct ReelLine {
    name: String,
    shots: Vec<(u64, f64)>,
    keys: Vec<(f64, f64)>,
    markers: Value,
}

/// A reel line (`@…`), without its `@`.
pub fn parse(line: &str) -> Result<ReelLine, String> {
    let mut parts = line.splitn(4, '|');
    let name = parts.next().unwrap_or_default().trim().to_owned();
    if name.is_empty() {
        return Err(format!("`@{line}` names no reel"));
    }
    let pairs = |text: Option<&str>| -> Result<Vec<(f64, f64)>, String> {
        text.unwrap_or_default()
            .split(',')
            .filter(|item| !item.trim().is_empty())
            .map(|item| {
                let (a, b) = item.split_once('=').ok_or_else(|| format!("`{item}` is no `<a>=<b>`"))?;
                Ok((a.trim().parse::<f64>().map_err(|_| format!("`{a}` is no number"))?, b.trim().parse::<f64>().map_err(|_| format!("`{b}` is no number"))?))
            })
            .collect()
    };
    let shots = pairs(parts.next())?.into_iter().map(|(id, amount)| (id as u64, amount)).collect();
    let keys = pairs(parts.next())?;
    let markers = match parts.next().map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => serde_json::from_str(text).map_err(|_| format!("`{text}` is no JSON list of markers"))?,
        None => json!([]),
    };
    Ok(ReelLine { name, shots, keys, markers })
}

/// Creates the reel `line` at `index` of the root's reels.
pub fn create(tx: &mut Tx<'_>, root: &ObjectId, index: usize, line: &ReelLine) -> Result<(), kition_kdm::KdmError> {
    let reel = tx.create_with_id("Reel", &ObjectId::from_string(format!("reel-{}", line.name)), Map::from_iter([("name".to_owned(), json!(line.name))]))?;
    tx.list_insert(root, "reels", index, &reel)?;
    let lane = tx.create("Lane", Map::from_iter([("markers".to_owned(), line.markers.clone())]))?;
    tx.set(&reel, "body", json!(lane.to_string()))?;
    for (at, (id, amount)) in line.shots.iter().enumerate() {
        let shot = tx.create_with_id(
            "Shot",
            &ObjectId::from_string(format!("shot-{id}")),
            Map::from_iter([("id".to_owned(), json!(id)), ("amount".to_owned(), json!(amount))]),
        )?;
        tx.list_insert(&lane, "shots", at, &shot)?;
    }
    for (at, (time, value)) in line.keys.iter().enumerate() {
        let key = tx.create("Key", Map::from_iter([("time".to_owned(), json!(time)), ("value".to_owned(), json!(value))]))?;
        tx.list_insert(&lane, "keys", at, &key)?;
    }
    Ok(())
}

fn reels(replica: &Replica) -> Vec<ObjectId> {
    kition_kdm::batch::root_id(replica).and_then(|root| replica.list(&root, "reels").ok()).unwrap_or_default()
}

fn text(replica: &Replica, object: &ObjectId, field: &str) -> String {
    replica.get(object, field).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}

fn number(replica: &Replica, object: &ObjectId, field: &str) -> f64 {
    replica.get(object, field).ok().and_then(|value| value.as_f64()).unwrap_or(0.0)
}

fn lane(replica: &Replica, reel: &ObjectId) -> Option<ObjectId> {
    replica.get(reel, "body").ok().and_then(|value| value.as_str().map(ObjectId::from_string))
}

/// The reels as the file holds them, a line each.
pub fn lines(replica: &Replica) -> Vec<String> {
    let format = |n: f64| if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") };
    reels(replica)
        .iter()
        .map(|reel| {
            let lane = lane(replica, reel);
            let list = |field: &str| lane.as_ref().and_then(|lane| replica.list(lane, field).ok()).unwrap_or_default();
            let shots: Vec<String> =
                list("shots").iter().map(|shot| format!("{}={}", number(replica, shot, "id") as u64, format(number(replica, shot, "amount")))).collect();
            let keys: Vec<String> =
                list("keys").iter().map(|key| format!("{}={}", format(number(replica, key, "time")), format(number(replica, key, "value")))).collect();
            let markers = lane.as_ref().and_then(|lane| replica.get(lane, "markers").ok()).unwrap_or_else(|| json!([]));
            format!("@{}|{}|{}|{}", text(replica, reel, "name"), shots.join(","), keys.join(","), markers)
        })
        .collect()
}

/// The reel a call names (`reel`: its tool id `reel:<name>` or its name).
fn reel_named(replica: &Replica, params: &Map<String, Value>) -> Result<ObjectId, String> {
    let given = params.get("reel").and_then(Value::as_str).ok_or("`reel` names the reel")?;
    let name = given.strip_prefix("reel:").unwrap_or(given);
    reels(replica).into_iter().find(|reel| text(replica, reel, "name") == name).ok_or_else(|| format!("no reel `{given}`"))
}

/// The index of the marker with id `id` in `markers`.
fn marker_index(markers: &Value, id: &Value) -> Option<usize> {
    markers.as_array()?.iter().position(|marker| marker["id"] == *id)
}

/// The keys of a lane: (key, time).
fn keys(replica: &Replica, lane: &ObjectId) -> Vec<(ObjectId, f64)> {
    replica.list(lane, "keys").unwrap_or_default().into_iter().map(|key| (key.clone(), number(replica, &key, "time"))).collect()
}

/// `context.under` for the reels' commands: their premises (see the module).
pub fn under(replica: &Replica, command: &str, params: &Map<String, Value>) -> Result<Option<Value>, String> {
    match command {
        "reel.shot" => {
            let shot = params.get("shot").cloned().unwrap_or(Value::Null);
            Ok(Some(json!({ "objects": [], "premises": [{ "id": shot, "fields": ["amount"], "positions": [] }] })))
        }
        "reel.marker" => {
            let reel = reel_named(replica, params)?;
            let lane = lane(replica, &reel).ok_or("the reel has no lane")?;
            let id = params.get("id").cloned().unwrap_or(Value::Null);
            let markers = replica.get(&lane, "markers").unwrap_or(Value::Null);
            let path = match (params.get("byKey").and_then(Value::as_bool) == Some(true), marker_index(&markers, &id)) {
                (true, _) => format!("body.markers[id={id}]"),
                (false, Some(index)) => format!("body.markers.{index}"),
                (false, None) => "body.markers".to_owned(),
            };
            let reel_id = format!("reel:{}", text(replica, &reel, "name"));
            Ok(Some(json!({ "objects": [], "premises": [{ "id": reel_id, "fields": [path], "positions": [] }] })))
        }
        "reel.key" => {
            let reel = reel_named(replica, params)?;
            let lane = lane(replica, &reel).ok_or("the reel has no lane")?;
            let time = params.get("time").and_then(Value::as_f64).ok_or("`time` is the key's time")?;
            let path = match params.get("byIndex").and_then(Value::as_bool) == Some(true) {
                true => match keys(replica, &lane).iter().position(|(_, at)| *at == time) {
                    Some(index) => format!("body.keys.{index}"),
                    None => "body.keys".to_owned(),
                },
                false => format!("body.keys[time={}]", json!(time)),
            };
            let reel_id = format!("reel:{}", text(replica, &reel, "name"));
            Ok(Some(json!({ "objects": [], "premises": [{ "id": reel_id, "fields": [path], "positions": [] }] })))
        }
        _ => Ok(None),
    }
}

/// Runs one of the reels' commands as `origin`; `None` for another command.
pub fn edit(replica: &mut Replica, command: &str, params: &Map<String, Value>, origin: &Origin) -> Option<Result<Edited, String>> {
    let kdm = |error: kition_kdm::KdmError| error.to_string();
    let done = Edited { changed: true, result: None, selection: None };
    let result = match command {
        "reel.shot" => (|| {
            let id = params.get("shot").and_then(|id| id.as_u64().or_else(|| id.as_str()?.parse().ok())).ok_or("`shot` is a shot's id")?;
            let shot =
                replica.objects_of_type("Shot").into_iter().find(|shot| number(replica, shot, "id") as u64 == id).ok_or_else(|| format!("no shot {id}"))?;
            let amount = params.get("amount").and_then(Value::as_f64).ok_or("`amount` is a number")?;
            replica.transact(origin, |tx| tx.set(&shot, "amount", json!(amount))).map_err(kdm)?;
            Ok(done)
        })(),
        "reel.marker" | "reel.markerAdd" => (|| {
            let reel = reel_named(replica, params)?;
            let lane = lane(replica, &reel).ok_or("the reel has no lane")?;
            let mut markers = replica.get(&lane, "markers").unwrap_or_else(|_| json!([]));
            let list = markers.as_array_mut().ok_or("the markers are no list")?;
            let id = params.get("id").cloned().unwrap_or(Value::Null);
            let name = params.get("name").cloned().unwrap_or_else(|| json!(""));
            if command == "reel.markerAdd" {
                let time = params.get("time").and_then(Value::as_f64).unwrap_or(0.0);
                let at = list.iter().position(|marker| marker["time"].as_f64().unwrap_or(0.0) > time).unwrap_or(list.len());
                list.insert(at, json!({ "id": id, "name": name, "time": time }));
            } else {
                let index = marker_index(&Value::Array(list.clone()), &id).ok_or_else(|| format!("no marker {id}"))?;
                list[index]["name"] = name;
            }
            replica.transact(origin, |tx| tx.set(&lane, "markers", markers.clone())).map_err(kdm)?;
            Ok(done)
        })(),
        "reel.key" => (|| {
            let reel = reel_named(replica, params)?;
            let lane = lane(replica, &reel).ok_or("the reel has no lane")?;
            let time = params.get("time").and_then(Value::as_f64).ok_or("`time` is the key's time")?;
            let value = params.get("value").and_then(Value::as_f64).ok_or("`value` is a number")?;
            let listed = keys(replica, &lane);
            match listed.iter().find(|(_, at)| *at == time) {
                Some((key, _)) => replica.transact(origin, |tx| tx.set(key, "value", json!(value))).map_err(kdm)?,
                None => {
                    let index = listed.iter().position(|(_, at)| *at > time).unwrap_or(listed.len());
                    replica
                        .transact(origin, |tx| {
                            let key = tx.create("Key", Map::from_iter([("time".to_owned(), json!(time)), ("value".to_owned(), json!(value))]))?;
                            tx.list_insert(&lane, "keys", index, &key)
                        })
                        .map_err(kdm)?
                }
            }
            Ok(done)
        })(),
        _ => return None,
    };
    Some(result)
}

/// The reels' commands, as [`crate::tracks::commands`] lists them.
pub fn commands() -> Vec<(&'static str, &'static str, bool, Value)> {
    let reel = json!({ "type": "string", "x-khp-role": "targets" });
    vec![
        (
            "reel.shot",
            "Sets the amount of the shot `shot`.",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["shot", "amount"], "x-khp-position": "independent", "properties": {
                "shot": { "type": "integer", "x-khp-role": "targets" }, "amount": { "type": "number" }
            } }),
        ),
        (
            "reel.marker",
            "Renames the marker `id` of the reel `reel` (`byKey`: the premise names it by its id, not its index).",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["reel", "id", "name"], "properties": {
                "reel": reel.clone(), "id": { "type": "integer" }, "name": { "type": "string" }, "byKey": { "type": "boolean" }
            } }),
        ),
        (
            "reel.markerAdd",
            "Adds a marker `id` named `name` at `time` to the reel `reel`, in time order.",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["reel", "id", "time"], "properties": {
                "reel": reel.clone(), "id": { "type": "integer" }, "name": { "type": "string" }, "time": { "type": "number" }
            } }),
        ),
        (
            "reel.key",
            "Sets the value of the reel's key at `time`, adding one in time order when there is none (`byIndex`: the premise names the key by its index now).",
            true,
            json!({ "type": "object", "additionalProperties": false, "required": ["reel", "time", "value"], "properties": {
                "reel": reel, "time": { "type": "number" }, "value": { "type": "number" }, "byIndex": { "type": "boolean" }
            } }),
        ),
    ]
}
