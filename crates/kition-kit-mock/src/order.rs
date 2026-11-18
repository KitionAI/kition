// Copied from kition-sdk crates/kition-kit-mock/src/order.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Ordered objects with stable ids and no tool ids, as file-native page models expose them.
use std::sync::{Arc, LazyLock};

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema};
use serde_json::{Map, Value, json};

use crate::tracks::Edited;

pub static ORDER: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_ORDER").is_ok());
static TREE: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_ORDER").is_ok_and(|s| s == "tree"));
static DEPTH: LazyLock<usize> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_ORDER_DEPTH").ok().and_then(|s| s.parse().ok()).unwrap_or(0));
static SCHEMA: LazyLock<String> = LazyLock::new(|| {
    let mut schema = json!({
        "kdm": 1, "kit": "kit.mock", "schemaVersion": 1, "root": "Root",
        "types": {
            "Root": {"fields": {"items": {"kind": if *TREE {"tree"} else {"list"}, "of": "Item"}, "other": {"kind":"list","of":"Item"},"details":{"kind":"list","of":"Detail","readOnly":true}}},
            "Item": {"fields": {"name": {"kind":"string"}}},"Detail":{"readOnly":true,"fields":{"name":{"kind":"string"}}}
        }
    });
    if *DEPTH > 0 {
        schema["types"]["Root"]["fields"]["groups"] = json!({"kind":"list","of":"Group"});
        schema["types"]["Nest"] = schema["types"]["Root"].clone();
        schema["types"]["Group"] = json!({"fields":{"body":{"kind":"ref","of":"Nest","owns":true}}});
    }
    if std::env::var_os("KITION_KIT_MOCK_BATCH_INDEPENDENT").is_some() {
        schema["types"]["Item"]["batchIndependent"] = json!(true);
    }
    if std::env::var_os("KITION_KIT_MOCK_ORDER_ROOT_ID").is_some() {
        schema["types"]["Root"]["fields"]["key"] = json!({"kind":"string","readOnly":true});
        schema["types"]["Root"]["toolId"] = json!({"field":"key"});
    }
    if let Ok(mode) = std::env::var("KITION_KIT_MOCK_CREATION") {
        schema["types"]["Item"]["fields"]["kind"] = json!({"kind":"json","readOnly":true});
        schema["types"]["Root"]["fields"]["other"]["sample"] = json!(false);
        if mode == "excluded" {
            schema["types"]["Root"]["fields"]["items"]["sample"] = json!(false);
        }
        if mode != "immutable" {
            schema["types"]["Item"]["creation"] = json!({"fields":{"kind":{"shape":"box","width":10}}});
        }
        if mode == "command" {
            schema["types"]["Item"]["fields"]["media"] = json!({"kind":"blob"});
            schema["types"]["Item"]["fields"]["bytes"] = json!({"kind":"json","readOnly":true});
            schema["types"]["Item"]["creation"]["command"] =
                json!({"command":"order.create","params":{"name":"fields.name","kind":"fields.kind","at":"at","fixture":"fixtures.image"}});
            schema["types"]["Item"]["creation"]["fixtures"] = json!({"image":{"data":[137,80,78,71],"mime":"image/png"}});
        }
    }
    schema.to_string()
});

fn owner() -> ObjectId {
    ObjectId::from_string(if *DEPTH == 0 { "root-order".to_owned() } else { format!("body-order-{}", *DEPTH) })
}

pub fn schema() -> &'static str {
    if *crate::paragraphs::PARAGRAPHS {
        return crate::paragraphs::SCHEMA;
    }
    if *crate::comments::COMMENTS {
        return crate::comments::schema();
    }
    if *crate::structure::STRUCTURE {
        return crate::structure::schema();
    }
    if *crate::replay::REPLAY {
        return crate::replay::schema();
    }
    if *crate::raster::RASTER {
        return crate::raster::schema();
    }
    if *crate::matrix::MATRIX {
        return crate::matrix::schema();
    }
    &SCHEMA
}

pub fn build(text: &str) -> Result<Replica, String> {
    if *crate::paragraphs::PARAGRAPHS {
        return crate::paragraphs::build(text);
    }
    if *crate::comments::COMMENTS {
        return crate::comments::build(text);
    }
    if *crate::structure::STRUCTURE {
        return crate::structure::build(text);
    }
    if *crate::replay::REPLAY {
        return crate::replay::build(text);
    }
    if *crate::raster::RASTER {
        return crate::raster::build(text);
    }
    if *crate::matrix::MATRIX {
        return crate::matrix::build(text);
    }
    let file: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let schema = Arc::new(Schema::parse(schema()).map_err(|e| e.to_string())?);
    let (replica, ()) = Replica::create_with(schema, DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
        let fields = if std::env::var_os("KITION_KIT_MOCK_ORDER_ROOT_ID").is_some() { Map::from_iter([("key".into(), json!("ordered"))]) } else { Map::new() };
        let root = tx.create_with_id("Root", &ObjectId::from_string("root-order"), fields)?;
        let mut holder = root.clone();
        for depth in 1..=*DEPTH {
            let body = tx.create_with_id("Nest", &ObjectId::from_string(format!("body-order-{depth}")), Map::new())?;
            let group =
                tx.create_with_id("Group", &ObjectId::from_string(format!("wrapper-order-{depth}")), Map::from_iter([("body".into(), json!(body.as_str()))]))?;
            tx.list_insert(&holder, "groups", 0, &group)?;
            holder = body;
        }
        for i in 0..if std::env::var("KITION_KIT_MOCK_ORDER_NO_DETAILS").is_ok() { 0 } else { 12 } {
            let detail = tx.create("Detail", Map::from_iter([("name".into(), json!(format!("detail-{i}")))]))?;
            tx.list_insert(&root, "details", i, &detail)?;
        }
        for field in ["items", "other"] {
            let group = if *TREE {
                let group = tx.create_with_id(
                    "Item",
                    &ObjectId::from_string(if field == "items" { "group-order" } else { "other-group-order" }),
                    Map::from_iter([("name".into(), json!("Group"))]),
                )?;
                Some(tx.tree_create(&holder, "items", None, &group)?)
            } else {
                None
            };
            for (i, item) in file[field].as_array().into_iter().flatten().enumerate() {
                let id = ObjectId::from_string(item["id"].as_str().unwrap());
                let mut fields = item.as_object().cloned().unwrap();
                fields.remove("id");
                tx.create_with_id("Item", &id, fields)?;
                if *TREE {
                    tx.tree_create(&holder, "items", group.as_ref(), &id)?;
                } else {
                    tx.list_insert(&holder, field, i, &id)?;
                }
            }
        }
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    Ok(replica)
}

fn items(replica: &Replica, field: &str) -> Vec<ObjectId> {
    let root = owner();
    if *TREE {
        let entries = replica.tree(&root, "items").unwrap_or_default();
        let group = entries.iter().find(|e| e.object.as_str() == if field == "items" { "group-order" } else { "other-group-order" }).map(|e| e.node.clone());
        entries.into_iter().filter(|e| e.parent == group).map(|e| e.object).collect()
    } else {
        replica.list(&root, field).unwrap_or_default()
    }
}

pub fn text_of(replica: &Replica) -> Result<String, String> {
    if *crate::paragraphs::PARAGRAPHS {
        return crate::paragraphs::text_of(replica);
    }
    if *crate::comments::COMMENTS {
        return crate::comments::text_of(replica);
    }
    if *crate::structure::STRUCTURE {
        return crate::structure::text_of(replica);
    }
    if *crate::replay::REPLAY {
        return crate::replay::text_of(replica);
    }
    if *crate::raster::RASTER {
        return crate::raster::text_of(replica);
    }
    if *crate::matrix::MATRIX {
        return crate::matrix::text_of(replica);
    }
    let mut file = json!({});
    for field in ["items", "other"] {
        file[field] = json!(
            items(replica, field)
                .iter()
                .map(|id| {
                    let mut fields = Map::from_iter([("id".into(), json!(id.as_str()))]);
                    for field in replica.schema().types["Item"].fields.keys() {
                        fields.insert(field.clone(), replica.get(id, field).unwrap());
                    }
                    json!(fields)
                })
                .collect::<Vec<_>>()
        );
    }
    Ok(file.to_string())
}

pub fn count(replica: &Replica) -> usize {
    if *crate::paragraphs::PARAGRAPHS {
        return replica.objects_of_type("Paragraph").len();
    }
    if *crate::comments::COMMENTS {
        return replica.objects_of_type("CommentThread").len();
    }
    if *crate::replay::REPLAY {
        return replica.objects_of_type("Item").len();
    }
    if *crate::raster::RASTER {
        return 1;
    }
    if *crate::matrix::MATRIX {
        return replica.objects_of_type("Item").len();
    }
    items(replica, "items").len()
}
pub fn has(replica: &Replica, id: u64) -> bool {
    replica.exists(&ObjectId::from_string(id.to_string()))
}

pub fn under(replica: &Replica, command: &str, params: &Map<String, Value>) -> Result<Option<Value>, String> {
    if *crate::comments::COMMENTS {
        return Ok(Some(crate::comments::under(command, params)));
    }
    if *crate::structure::STRUCTURE {
        return Ok(Some(crate::structure::under()));
    }
    if *crate::replay::REPLAY {
        return Ok(None);
    }
    if *crate::raster::RASTER {
        return crate::raster::under(replica, params);
    }
    if *crate::matrix::MATRIX {
        return crate::matrix::under(replica, command, params);
    }
    let from = index(params);
    let items = items(replica, "items");
    let (from, to) = match command {
        "order.index" => (from, from + 1),
        "order.reverse" => items.len().checked_sub(from + 1).map_or((items.len(), items.len()), |i| (i, i + 1)),
        "order.window" => (from, from + 2),
        _ => (from, from),
    };
    let objects: Vec<_> = items.iter().skip(from).take(to - from).map(ObjectId::as_str).collect();
    let mut premises: Vec<_> = objects.iter().map(|id| json!({"id":id,"fields":[],"positions":[]})).collect();
    if let Some(item) = params.get("item") {
        let mut premise = json!({"id":item,"fields":[]});
        if item == "Y" || std::env::var_os("KITION_KIT_MOCK_BATCH_INDEPENDENT").is_some() {
            premise["positions"] = json!([]);
        }
        premises.push(premise);
    }
    Ok(Some(
        json!({"objects":objects,"premises":premises,"within":[{"parent":if *TREE {"group-order".to_owned()} else {owner().to_string()},"field":"items","from":from,"to":to}]}),
    ))
}

pub fn edit(replica: &mut Replica, command: &str, params: &Map<String, Value>, origin: &Origin) -> Result<Edited, String> {
    if *crate::comments::COMMENTS {
        return crate::comments::edit(replica, command, params, origin);
    }
    if *crate::structure::STRUCTURE {
        if command != "cell.write" {
            return Err(format!("unknown command `{command}`"));
        }
        return crate::structure::edit(replica, params, origin);
    }
    if *crate::raster::RASTER {
        return crate::raster::edit(replica, command, params, origin);
    }
    if *crate::matrix::MATRIX {
        return crate::matrix::edit(replica, command, params, origin);
    }
    if !command.starts_with("order.") {
        return Err(format!("unknown command `{command}`"));
    }
    if command == "order.create" {
        let id = replica.transact(origin, |tx| {
            let fixture = &params["fixture"];
            let data = fixture["data"].as_array().expect("fixture bytes");
            let id = tx.create("Item",json!({"name":params["name"],"kind":params["kind"],"bytes":data,"media":{"hash":format!("fixture-{}",json!(data)),"mime":fixture["mime"],"size":data.len()}}).as_object().unwrap().clone())?;
            tx.list_insert(&owner(),"items",params["at"].as_u64().unwrap_or(0) as usize,&id)?;
            Ok(id)
        }).map_err(|error|error.to_string())?;
        return Ok(Edited { result: Some(json!({"id":id.as_str()})), changed: true, selection: None });
    }
    let at = index(params);
    let root = owner();
    let current = items(replica, "items");
    let other = items(replica, "other");
    let parent = if *TREE { replica.tree(&root, "items").unwrap().iter().find(|e| e.object.as_str() == "group-order").map(|e| e.node.clone()) } else { None };
    replica
        .transact(origin, |tx| {
            if command == "order.gap" {
                let id = tx.create("Item", Map::from_iter([("name".into(), json!("Agent"))]))?;
                if *TREE {
                    let later = tx.tree(&root, "items")?.into_iter().filter(|e| e.parent == parent).skip(at).map(|e| e.node).collect::<Vec<_>>();
                    tx.tree_create(&root, "items", parent.as_ref(), &id)?;
                    for node in later {
                        tx.tree_move(&root, "items", &node, parent.as_ref())?;
                    }
                } else {
                    tx.list_insert(&root, "items", at, &id)?;
                }
            } else if command == "order.move" {
                let id = ObjectId::from_string(params["item"].as_str().unwrap());
                if *TREE {
                    let entries = tx.tree(&root, "items")?;
                    let node = match entries.iter().find(|e| e.object == id) {
                        Some(e) => e.node.clone(),
                        None => tx.tree_create(&root, "items", parent.as_ref(), &id)?,
                    };
                    let later = entries.iter().filter(|e| e.object != id && e.parent == parent).skip(at).map(|e| e.node.clone()).collect::<Vec<_>>();
                    tx.tree_move(&root, "items", &node, parent.as_ref())?;
                    for node in later {
                        tx.tree_move(&root, "items", &node, parent.as_ref())?;
                    }
                } else {
                    if let Some(from) = current.iter().position(|i| *i == id) {
                        tx.list_move(&root, "items", from, at.min(current.len() - 1))?;
                    } else {
                        tx.list_remove(&root, "other", other.iter().position(|i| *i == id).unwrap())?;
                        tx.list_insert(&root, "items", at, &id)?;
                    }
                }
            } else {
                let ids = items_for_command(current.clone(), command, at);
                for id in ids {
                    tx.set(&id, "name", json!("Agent"))?;
                }
            }
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    Ok(Edited { result: None, changed: true, selection: None })
}

fn index(params: &Map<String, Value>) -> usize {
    params["at"].as_u64().map(|n| n as usize).unwrap_or_else(|| params["at"].as_str().unwrap().trim_start_matches('#').parse::<usize>().unwrap() - 1)
}

fn items_for_command(mut ids: Vec<ObjectId>, command: &str, at: usize) -> Vec<ObjectId> {
    if command == "order.reverse" {
        ids.reverse();
    }
    ids.into_iter().skip(at).take(if command == "order.window" { 2 } else { 1 }).collect()
}

pub fn commands() -> Vec<(&'static str, &'static str, bool, Value)> {
    if *crate::comments::COMMENTS {
        return crate::comments::commands();
    }
    if std::env::var("KITION_KIT_MOCK_CREATION").as_deref() == Ok("command") {
        return vec![(
            "order.create",
            "Create with fixture media",
            true,
            json!({"type":"object","properties":{"name":{"type":"string"},"kind":{},"at":{"type":"integer"},"fixture":{"type":"object"}}}),
        )];
    }
    if *crate::structure::STRUCTURE {
        return crate::structure::commands();
    }
    if *crate::replay::REPLAY {
        return vec![];
    }
    if *crate::raster::RASTER {
        return crate::raster::commands();
    }
    if *crate::matrix::MATRIX {
        return crate::matrix::commands();
    }
    ["gap", "window", "index", "reverse", "move"]
        .into_iter()
        .map(|kind| {
            let mut at = json!({"type":"integer","minimum":0,"x-khp-role":"place"});
            if matches!(kind, "index" | "reverse") {
                at = json!({"type":"string","x-khp-role":"targets","x-khp-index":"#","x-khp-types":["Item"]});
            }
            if kind == "reverse" {
                at["x-khp-index-order"] = json!("reversed");
            }
            let command = match kind {
                "gap" => "order.gap",
                "window" => "order.window",
                "index" => "order.index",
                "reverse" => "order.reverse",
                _ => "order.move",
            };
            let mut properties = json!({"at":at});
            if kind == "move" {
                properties["item"] = json!({"type":"string","x-khp-role":"targets","x-khp-types":["Item"]});
            }
            (command, "Ordered edit", true, json!({"type":"object","properties":properties}))
        })
        .collect()
}
