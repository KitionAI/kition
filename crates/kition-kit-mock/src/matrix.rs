// Copied from kition-sdk crates/kition-kit-mock/src/matrix.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Stable records for the non-positional guard matrices.
use std::sync::{Arc, LazyLock};

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema};
use serde_json::{Map, Value, json};

use crate::tracks::Edited;

pub static MATRIX: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_ORDER").is_ok_and(|s| s == "matrix"));
static SCHEMA: LazyLock<String> = LazyLock::new(|| {
    let record = json!({"fields":{"key":{"kind":"string","readOnly":true},"name":{"kind":"string"},"data":{"kind":"json"},"extra":{"kind":"json"}},"toolId":{"field":"key"}});
    let mut schema = json!({"kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Root","types":{
        "Root":{"fields":{"items":{"kind":"list","of":"Item"},"other":{"kind":"list","of":"Other"}}},
        "Item":record,"Other":record
    }});
    schema["types"]["Thread"] = record.clone();
    schema["types"]["Thread"].as_object_mut().unwrap().remove("toolId");
    if std::env::var_os("KITION_KIT_MOCK_RAW_RECORDS").is_some() {
        schema["types"]["Item"].as_object_mut().unwrap().remove("toolId");
    }
    if std::env::var_os("KITION_KIT_MOCK_OWNED_JSON").is_some() {
        schema["types"]["Item"]["fields"]["data"] = json!({"kind":"ref","of":"Payload","owns":true});
        schema["types"]["Item"]["fields"]["children"] = json!({"kind":"list","of":"Item"});
        schema["types"]["Payload"] = json!({"fields":{"parts":{"kind":"json"}}});
    }
    if std::env::var_os("KITION_KIT_MOCK_MEMBERS").is_some() {
        schema["types"]["Item"]["fields"]["data"] = json!({"kind":"ref","of":"Group","owns":true});
        schema["types"]["Group"] = json!({"fields":{"members":{"kind":"list","of":"Member"}}});
        schema["types"]["Member"] = json!({"batchIndependent":true,"fields":{"key":{"kind":"string","readOnly":true},"name":{"kind":"string"},"value":{"kind":"json","optional":true},"children":{"kind":"list","of":"Member"}}});
    }
    if let Ok(kind) = std::env::var("KITION_KIT_MOCK_ROOT_TEXT") {
        schema["types"]["Root"]["fields"]["body"] = json!({"kind":kind});
        schema["types"]["Root"]["fields"]["starred"] = json!({"kind":"boolean"});
        schema["types"]["Root"]["text"] = json!("body");
    }
    if std::env::var_os("KITION_KIT_MOCK_BATCH_INDEPENDENT").is_some() {
        schema["types"]["Item"]["batchIndependent"] = json!(true);
        schema["types"]["Other"]["batchIndependent"] = json!(true);
    }
    if std::env::var_os("KITION_KIT_MOCK_MAPS").is_some() {
        schema["types"]["Root"]["fields"]["catalog"] = json!({"kind":"map","owns":true});
        if std::env::var_os("KITION_KIT_MOCK_TYPED_MAP").is_some() {
            schema["types"]["Root"]["fields"]["catalog"]["of"] = json!("Item");
        }
    }
    if std::env::var_os("KITION_KIT_MOCK_MAP_EDITS").is_some() {
        schema["types"]["Item"]["fields"]["key"]["optional"] = json!(true);
        schema["types"]["Root"]["fields"]["single"] = json!({"kind":"ref","of":"Item","owns":true,"optional":true});
        for field in ["items", "other"] {
            schema["types"]["Root"]["fields"][field]["readOnly"] = json!(true);
        }
    }
    if std::env::var_os("KITION_KIT_MOCK_WINDOWS").is_some() {
        schema["types"]["Root"]["fields"]["other"]["of"] = json!("Item");
        schema["types"]["Item"]["fields"]["extra"]["position"] = json!(true);
    }
    if std::env::var_os("KITION_KIT_MOCK_JOIN").is_some() {
        schema["types"]["Item"]["fields"]["extra"]["position"] = json!(true);
    }
    if std::env::var_os("KITION_KIT_MOCK_TEXT").is_some() {
        schema["types"]["Item"]["text"] = json!("data.words");
    }
    if std::env::var_os("KITION_KIT_MOCK_MARKS").is_some() {
        schema["types"]["Item"]["fields"]["data"] =
            json!({"kind":"text","marks":{"object":{"expand":"none"},"bold":{"expand":"after"},"italic":{"expand":"after"}}});
        schema["types"]["Inline"] =
            json!({"fields":{"key":{"kind":"string","readOnly":true},"rotation":{"kind":"number"}},"toolId":{"field":"key","prefix":"inline:"}});
    }
    if std::env::var_os("KITION_KIT_MOCK_DERIVED").is_some() {
        schema["types"]["Item"]["derived"] = json!({"layerItems":{"premiseOnly":std::env::var_os("KITION_KIT_MOCK_PUBLIC_DERIVED").is_none()}});
        if std::env::var("KITION_KIT_MOCK_DEMAND").as_deref() == Ok("1") {
            schema["types"]["Item"]["derived"]["layerItems"]["onDemand"] = json!(true);
        }
    }
    if std::env::var_os("KITION_KIT_MOCK_DEMAND_TEXT").is_some() {
        schema["types"]["Item"]["derived"] = json!({"textSlice":{"premiseOnly":true,"onDemand":true}});
    }
    schema.to_string()
});

pub fn schema() -> &'static str {
    &SCHEMA
}

pub fn settle(tx: &mut kition_kdm::Tx<'_>) -> kition_kdm::Result<()> {
    if std::env::var_os("KITION_KIT_MOCK_MAP_EDITS").is_none() {
        return Ok(());
    }
    let objects = tx.objects_of_type("Item");
    let mut next = objects.len();
    for id in objects {
        if tx.get(&id, "key")?.is_null() {
            loop {
                next += 1;
                let key = format!("created:{next}");
                if !tx.objects_of_type("Item").iter().any(|other| tx.get(other, "key").ok() == Some(json!(key))) {
                    tx.set(&id, "key", json!(key))?;
                    break;
                }
            }
        }
    }
    Ok(())
}

pub fn build(text: &str) -> Result<Replica, String> {
    let file: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let schema = Arc::new(Schema::parse(schema()).map_err(|e| e.to_string())?);
    Replica::create_with(schema, DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
        let mut fields = Map::new();
        if let Ok(kind) = std::env::var("KITION_KIT_MOCK_ROOT_TEXT") {
            fields.insert("starred".into(), json!(file["starred"].as_bool().unwrap_or(false)));
            if kind != "text" {
                fields.insert("body".into(), json!(file["body"].as_str().unwrap_or_default()));
            }
        }
        let root = tx.create_with_id("Root", &ObjectId::from_string("matrix-root"), fields)?;
        let mut inline = Map::new();
        for object in file["inline"].as_array().into_iter().flatten() {
            let id = tx.create("Inline", object.as_object().unwrap().clone())?;
            inline.insert(format!("inline:{}", object["key"].as_str().unwrap()), json!(id.as_str()));
        }
        if let Ok(kind) = std::env::var("KITION_KIT_MOCK_ROOT_TEXT") {
            let body = file["body"].as_str().unwrap_or_default();
            if kind == "text" {
                tx.text_insert(&root, "body", 0, body)?;
            }
        }
        for (field, ty) in [("items", "Item"), ("other", "Other")] {
            let ty = if std::env::var_os("KITION_KIT_MOCK_WINDOWS").is_some() { "Item" } else { ty };
            for (at, record) in file[field].as_array().into_iter().flatten().enumerate() {
                let id = ObjectId::from_string(record["key"].as_str().unwrap());
                let mut fields = record.as_object().unwrap().clone();
                let marked = ty == "Item" && std::env::var_os("KITION_KIT_MOCK_MARKS").is_some();
                if marked {
                    fields.remove("data");
                }
                if ty == "Item" && std::env::var_os("KITION_KIT_MOCK_OWNED_JSON").is_some() {
                    let payload = tx.create_with_id(
                        "Payload",
                        &ObjectId::from_string(format!("payload:{}", id.as_str())),
                        Map::from_iter([("parts".into(), record["data"].clone())]),
                    )?;
                    fields.insert("data".into(), json!(payload.as_str()));
                }
                if ty == "Item" && std::env::var_os("KITION_KIT_MOCK_MEMBERS").is_some() {
                    let group = tx.create_with_id("Group", &ObjectId::from_string(format!("group:{}", id.as_str())), Map::new())?;
                    for (at, member) in record["data"]["members"].as_array().into_iter().flatten().enumerate() {
                        let member_id = ObjectId::from_string(format!("member:{}:{}", id.as_str(), member["key"].as_str().unwrap()));
                        let mut fields = member.as_object().unwrap().clone();
                        fields.remove("children");
                        tx.create_with_id("Member", &member_id, fields)?;
                        for (index, child) in member["children"].as_array().into_iter().flatten().enumerate() {
                            let child_id = ObjectId::from_string(format!("{}:{}", member_id.as_str(), child["key"].as_str().unwrap()));
                            tx.create_with_id("Member", &child_id, child.as_object().unwrap().clone())?;
                            tx.list_insert(&member_id, "children", index, &child_id)?;
                        }
                        tx.list_insert(&group, "members", at, &member_id)?;
                    }
                    fields.insert("data".into(), json!(group.as_str()));
                }
                tx.create_with_id(ty, &id, fields)?;
                if marked {
                    let mut offset = 0;
                    for run in record["data"].as_array().into_iter().flatten() {
                        let text = run["insert"].as_str().unwrap();
                        let end = offset + text.chars().count();
                        tx.text_insert(&id, "data", offset, text)?;
                        for (key, value) in run["attributes"].as_object().into_iter().flatten() {
                            let value = if key == "object" { value.as_str().and_then(|key| inline.get(key)).unwrap_or(value) } else { value };
                            tx.text_mark(&id, "data", offset, end, key, value.clone())?;
                        }
                        offset = end;
                    }
                }
                tx.list_insert(&root, field, at, &id)?;
            }
        }
        for (key, record) in file["catalog"].as_object().into_iter().flatten() {
            let id = tx.create("Item", record.as_object().unwrap().clone())?;
            let value = if key == "wrapped" { json!({"body":id.as_str(),"note":"literal"}) } else { json!(id.as_str()) };
            tx.map_set(&root, "catalog", key, value)?;
        }
        if let Some(record) = file.get("single").and_then(Value::as_object) {
            let id = tx.create("Item", record.clone())?;
            tx.set(&root, "single", json!(id.as_str()))?;
        }
        Ok(())
    })
    .map(|(replica, ())| replica)
    .map_err(|e| e.to_string())
}

pub fn text_of(replica: &Replica) -> Result<String, String> {
    let mut file = json!({});
    if let Ok(kind) = std::env::var("KITION_KIT_MOCK_ROOT_TEXT") {
        let root = ObjectId::from_string("matrix-root");
        file["body"] = if kind == "text" {
            json!(replica.text(&root, "body").map_err(|error| error.to_string())?)
        } else {
            replica.get(&root, "body").map_err(|error| error.to_string())?
        };
        file["starred"] = replica.get(&root, "starred").map_err(|error| error.to_string())?;
    }
    for field in ["items", "other"] {
        let ids = replica.list(&ObjectId::from_string("matrix-root"), field).map_err(|e| e.to_string())?;
        file[field] = json!(
            ids.iter()
                .map(|id| {
                    ["key", "name", "data", "extra"]
                        .into_iter()
                        .map(|field| {
                            let value = if field == "data"
                                && replica.objects_of_type("Item").contains(id)
                                && std::env::var_os("KITION_KIT_MOCK_OWNED_JSON").is_some()
                            {
                                let payload = ObjectId::from_string(replica.get(id, "data").unwrap().as_str().unwrap());
                                replica.get(&payload, "parts").unwrap()
                            } else if field == "data" && replica.objects_of_type("Item").contains(id) && std::env::var_os("KITION_KIT_MOCK_MEMBERS").is_some() {
                                let group = ObjectId::from_string(replica.get(id, "data").unwrap().as_str().unwrap());
                                let members = replica
                                    .list(&group, "members")
                                    .unwrap()
                                    .iter()
                                    .map(|id| {
                                        let mut member: Map<String, Value> =
                                            ["key", "name", "value"].into_iter().map(|field| (field.to_owned(), replica.get(id, field).unwrap())).collect();
                                        let children = replica
                                            .list(id, "children")
                                            .unwrap()
                                            .iter()
                                            .map(|id| {
                                                Value::Object(
                                                    ["key", "name", "value"]
                                                        .into_iter()
                                                        .map(|field| (field.to_owned(), replica.get(id, field).unwrap()))
                                                        .collect(),
                                                )
                                            })
                                            .collect::<Vec<_>>();
                                        if !children.is_empty() {
                                            member.insert("children".into(), json!(children));
                                        }
                                        Value::Object(member)
                                    })
                                    .collect::<Vec<_>>();
                                json!({"members":members})
                            } else if field == "data" && replica.objects_of_type("Item").contains(id) && std::env::var_os("KITION_KIT_MOCK_MARKS").is_some() {
                                let mut runs = replica.text_delta(id, field).unwrap();
                                let ids = kition_kdm::tool_ids::ToolIds::of_replica(replica);
                                for run in &mut runs {
                                    for value in run.attributes.values_mut() {
                                        *value = ids.show_json(value);
                                    }
                                }
                                json!(runs)
                            } else {
                                replica.get(id, field).unwrap()
                            };
                            (field.to_owned(), value)
                        })
                        .collect::<Map<_, _>>()
                })
                .collect::<Vec<_>>()
        );
    }
    if std::env::var_os("KITION_KIT_MOCK_MARKS").is_some() {
        file["inline"] = json!(
            replica
                .objects_of_type("Inline")
                .iter()
                .map(|id| json!({"key":replica.get(id,"key").unwrap(),"rotation":replica.get(id,"rotation").unwrap()}))
                .collect::<Vec<_>>()
        );
    }
    if std::env::var_os("KITION_KIT_MOCK_MAPS").is_some() {
        let mut catalog = Map::new();
        for (key, value) in replica.map_entries(&ObjectId::from_string("matrix-root"), "catalog").map_err(|e| e.to_string())? {
            let raw = value.as_str().or_else(|| value["body"].as_str()).unwrap();
            let id = ObjectId::from_string(raw);
            if replica.exists(&id) {
                catalog
                    .insert(key, Value::Object(["key", "name", "data", "extra"].into_iter().map(|f| (f.to_owned(), replica.get(&id, f).unwrap())).collect()));
            }
        }
        file["catalog"] = json!(catalog);
    }
    if std::env::var_os("KITION_KIT_MOCK_MAP_EDITS").is_some()
        && let Some(id) = replica.get(&ObjectId::from_string("matrix-root"), "single").map_err(|e| e.to_string())?.as_str()
    {
        file["single"] = Value::Object(
            ["key", "name", "data", "extra"].into_iter().map(|field| (field.to_owned(), replica.get(&ObjectId::from_string(id), field).unwrap())).collect(),
        );
    }
    Ok(file.to_string())
}

pub fn carry_replica_objects(previous: &Replica, next: &mut Replica) -> Result<(), String> {
    next.transact(&Origin::system("reread"), |tx| {
        for id in previous.objects_of_type("Item") {
            let action = previous.get(&id, "name")?;
            if tx.exists(&id) || !matches!(action.as_str(), Some("Replica keep" | "Replica reanchor")) {
                continue;
            }
            let mut fields: Map<String, Value> =
                ["key", "name", "data", "extra"].into_iter().map(|field| Ok((field.into(), previous.get(&id, field)?))).collect::<kition_kdm::Result<_>>()?;
            if action == "Replica reanchor" {
                fields.insert("data".into(), json!({"anchor":1}));
            }
            tx.create_with_id("Item", &id, fields)?;
        }
        Ok(())
    })
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn resolve(replica: &Replica, params: &Map<String, Value>) -> Option<ObjectId> {
    if let Some(index) = scoped_index(params) {
        return replica.list(&ObjectId::from_string("matrix-root"), "items").ok()?.get(index).cloned();
    }
    if let Some(index) = params
        .get("item")
        .and_then(Value::as_str)
        .and_then(|text| text.strip_prefix('#'))
        .and_then(|index| index.parse::<usize>().ok())
        .and_then(|index| index.checked_sub(1))
    {
        return replica.list(&ObjectId::from_string("matrix-root"), "items").ok()?.get(index).cloned();
    }
    if let Some(index) = params.get("item").and_then(Value::as_u64).and_then(|index| index.checked_sub(1)) {
        return replica.list(&ObjectId::from_string("matrix-root"), "items").ok()?.get(index as usize).cloned();
    }
    let text = params.get("item").or_else(|| params.get("resource"))?.as_str()?;
    let types: &[&str] = if params.get("typed") == Some(&Value::Bool(true)) { &["Item"] } else { &["Item", "Other"] };
    let ids: Vec<_> = types.iter().flat_map(|ty| replica.objects_of_type(ty)).collect();
    ids.iter()
        .find(|id| replica.get(id, "key").ok().as_ref() == Some(&json!(text)))
        .cloned()
        .or_else(|| ids.into_iter().find(|id| replica.get(id, "name").ok().as_ref() == Some(&json!(text))))
}

fn scoped_index(params: &Map<String, Value>) -> Option<usize> {
    params.get("item")?.as_str()?.strip_prefix("shape:items/")?.parse::<usize>().ok()?.checked_sub(1)
}

pub fn under(replica: &Replica, _command: &str, params: &Map<String, Value>) -> Result<Option<Value>, String> {
    if std::env::var_os("KITION_KIT_MOCK_CONDITIONAL").is_some() && params.contains_key("predicate") {
        let objects = conditional_objects(replica, &json!(params));
        return Ok(Some(json!({"objects":objects,"covers":{"fields":["data"]},
            "premises":objects.iter().map(|id|json!({"id":id,"fields":["data"],"positions":[]})).collect::<Vec<_>>()
        })));
    }
    if let Some(form) = params.get("emptyPlace").and_then(Value::as_str) {
        let mut answer = json!({"objects":[],"premises":[{"id":"A","fields":["data"],"positions":[]}]});
        match form {
            "index" => answer["within"] = json!([{"parent":"matrix-root","field":"other","from":0,"to":1}]),
            "gap" => answer["within"] = json!([{"parent":"matrix-root","field":"other","from":1,"to":1}]),
            "time" => answer["within"] = json!([{"parent":"matrix-root","field":"other","time":{"from":1,"to":2,"start":"extra"}}]),
            "object" => answer["objects"] = json!(["C"]),
            "premise" => answer["premises"].as_array_mut().unwrap().push(json!({"id":"C","fields":["data"],"positions":[]})),
            "covers" => {
                answer["objects"] = json!(
                    replica
                        .objects_of_type("Other")
                        .iter()
                        .filter(|id| replica.get(id, "extra").ok() == Some(json!(1)))
                        .map(|id| kition_kdm::tool_ids::ToolIds::of_replica(replica).show(id))
                        .collect::<Vec<_>>()
                );
                answer["covers"] = json!({"fields":["extra"]});
            }
            _ => {}
        }
        return Ok(Some(answer));
    }
    if let Some(index) = scoped_index(params) {
        let objects: Vec<_> = resolve(replica, params).into_iter().map(|id| id.as_str().to_owned()).collect();
        return Ok(Some(json!({"objects":objects,"premises":objects.iter().map(|id|json!({"id":id,"fields":[],"positions":[]})).collect::<Vec<_>>(),
            "within":[{"parent":"matrix-root","field":"items","from":index,"to":index+1}]})));
    }
    let Some(id) = resolve(replica, params) else { return Ok(None) };
    if let Some(region) = params.get("contentRegion") {
        return Ok(Some(json!({"objects":[],"premises":[{"id":id.as_str(),"fields":[],"positions":[]}],
            "content":[{"id":id.as_str(),"field":params.get("contentField").cloned().unwrap_or(json!("data")),"region":region}]})));
    }
    if params.get("range").is_some() {
        if std::env::var_os("KITION_KIT_MOCK_COVERED_GONE").is_some() && replica.get(&id, "data").ok() == Some(json!("")) {
            return Ok(Some(json!({"objects":[],"covers":{"fields":["data"]}})));
        }
        return Ok(Some(json!({"objects":[id.as_str()],"premises":[{"id":id.as_str(),"fields":[],"positions":[]}],"covers":{"fields":["data"]}})));
    }
    if let Some(holds) = params.get("holds").and_then(Value::as_array) {
        let premises: Vec<_> = holds
            .iter()
            .cloned()
            .map(|mut hold| {
                hold["id"] = json!(id.as_str());
                hold
            })
            .collect();
        return Ok(Some(json!({"objects":[],"premises":premises})));
    }
    let Some(hold) = params.get("hold").filter(|v| !v.is_null()) else { return Ok(None) };
    let mut premise = json!({"id":id.as_str(),"fields":hold,"positions":[]});
    if let Some(key) = params.get("identity") {
        premise["identities"] = json!({(hold[0].as_str().unwrap()):key});
    }
    let mut answer = json!({"objects":[],"premises":[premise]});
    if let Some(inputs) = params.get("inputs") {
        answer["inputs"] = inputs.clone();
    }
    if std::env::var_os("KITION_KIT_MOCK_LOCAL").is_some() {
        answer["within"] = json!([{"parent":"matrix-root","field":"items","from":0,"to":1}]);
    }
    if let Ok(mode) = std::env::var("KITION_KIT_MOCK_JSON_WINDOW") {
        let mut time = json!({"from":1,"to":5,"start":"time","identity":"id"});
        if mode == "interval" {
            time["end"] = json!("end");
        }
        answer["within"] = json!([{"parent":id.as_str(),"field":"data.members","time":time}]);
    }
    if let Ok(mode) = std::env::var("KITION_KIT_MOCK_WINDOWS") {
        let mut window = json!({"parent":"matrix-root","field":"items","from":1,"to":3});
        if mode == "time" {
            window["time"] = json!({"from":1,"to":5,"start":"extra"});
        }
        answer["within"] = json!([window]);
    }
    if std::env::var_os("KITION_KIT_MOCK_MIXED_WINDOWS").is_some() {
        let objects: Vec<_> = replica
            .list(&ObjectId::from_string("matrix-root"), "items")
            .unwrap_or_default()
            .into_iter()
            .filter(|id| replica.get(id, "extra").ok().and_then(|value| value.as_f64()).is_some_and(|start| start <= 2.5 && start * 2.0 > 2.5))
            .collect();
        answer["objects"] = json!(objects.iter().map(|id| id.as_str()).collect::<Vec<_>>());
        for id in objects {
            answer["premises"].as_array_mut().unwrap().push(json!({"id":id.as_str(),"fields":[],"positions":[]}));
        }
        answer["within"] = json!([
            {"parent":"matrix-root","field":"items","time":{"from":2.5,"to":2.5,"start":"extra","duration":"extra"}},
            {"parent":"matrix-root","field":"other","from":0,"to":1}
        ]);
    }
    Ok(Some(answer))
}

pub fn edit(replica: &mut Replica, _command: &str, params: &Map<String, Value>, origin: &Origin) -> Result<Edited, String> {
    let id = resolve(replica, params).ok_or("missing matrix record")?;
    let field = params.get("write").and_then(Value::as_str).unwrap_or("extra");
    let mut pieces = field.split('.');
    let root = pieces.next().unwrap();
    let path: Vec<_> = pieces.collect();
    let mut value = replica.get(&id, root).map_err(|e| e.to_string())?;
    let mut at = &mut value;
    for member in path {
        if !at.is_object() {
            *at = json!({});
        }
        at = &mut at[member];
    }
    *at = if params.get("inputs").and_then(Value::as_array).is_some_and(|inputs| !inputs.is_empty()) {
        let path = std::env::var("KITION_KIT_MOCK_INPUT").map_err(|error| error.to_string())?;
        json!(std::fs::read_to_string(path).map_err(|error| error.to_string())?)
    } else {
        params.get("value").cloned().unwrap_or(json!("Agent"))
    };
    let recipients = if std::env::var_os("KITION_KIT_MOCK_CONDITIONAL").is_some() { conditional_objects(replica, &json!(params)) } else { Vec::new() };
    replica
        .transact(origin, |tx| {
            tx.set(&id, root, value)?;
            for recipient in &recipients {
                tx.set(&ObjectId::from_string(recipient), "extra", params.get("value").cloned().unwrap_or(json!("Agent")))?;
            }
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    Ok(Edited { result: None, changed: true, selection: None })
}

pub fn commands() -> Vec<(&'static str, &'static str, bool, Value)> {
    let mut commands: Vec<_> =
        [("matrix.write", false, false), ("matrix.typed", true, false), ("matrix.param", false, true), ("matrix.paramTyped", true, true)]
            .into_iter()
            .map(|(id, typed, param)| {
                let mut target = json!({"type":"string","x-khp-name":"name"});
                if std::env::var_os("KITION_KIT_MOCK_LOCAL").is_some() {
                    target = json!({"oneOf":[{"type":"string"},{"type":"integer"}],"x-khp-index-numbers":true,"x-khp-index":"#","x-khp-name":"name"});
                }
                if typed {
                    target["x-khp-types"] = json!(["Item"]);
                }
                if !param {
                    target["x-khp-role"] = json!("targets");
                }
                let mut schema = json!({"type":"object","properties":{(if param {"resource"} else {"item"}):target}});
                schema["properties"]["range"] = json!({"type":"array","x-khp-role":"place"});
                schema["properties"]["sourceName"] = json!({"type":"string","x-khp-name":"name","x-khp-types":["Other"]});
                schema["properties"]["sourceId"] = json!({"type":"string","x-khp-role":"object"});
                schema["properties"]["nested"] =
                    json!({"type":"object","properties":{"id":{"type":"string","x-khp-role":"object"},"literal":{"type":"string"}}});
                schema["properties"]["sources"] = json!({"type":"array","items":{"type":"string","x-khp-role":"object"}});
                if std::env::var_os("KITION_KIT_MOCK_WINDOWS").is_some() {
                    schema["properties"]["window"] = json!({"type":"boolean","x-khp-role":"place"});
                }
                (id, "Matrix write", true, schema)
            })
            .collect();
    for (id, state) in [
        ("matrix.selection", "selection"),
        ("matrix.part", "part"),
        ("matrix.time", "time"),
        ("matrix.mode", "mode"),
        ("matrix.active", "active"),
        ("matrix.area", "area"),
    ] {
        commands.push((
            id,
            "State-dependent write",
            true,
            json!({"type":"object","properties":{"item":{"type":"string","x-khp-role":"object"}},"x-khp-reads":[state]}),
        ));
    }
    commands.push((
        "matrix.targeted",
        "Write explicit target",
        true,
        json!({"type":"object","properties":{"item":{"type":"string","x-khp-role":"targets"}},"x-khp-reads":["selection"]}),
    ));
    commands
}

fn layer_items(objects: &Map<String, Value>, id: &str) -> Value {
    json!(objects.iter().filter(|(_, o)| o["$type"] == "Other" && o["data"]["layer"] == id).map(|(_, o)| o["key"].clone()).collect::<Vec<_>>())
}

pub fn derived(replica: &Replica, ids: Option<&Vec<Value>>) -> Result<Value, String> {
    let state = replica.state_json().map_err(|e| e.to_string())?;
    let objects = state["objects"].as_object().ok_or("no objects")?;
    if std::env::var_os("KITION_KIT_MOCK_DERIVED_FAILURE").is_some() && objects.values().any(|object| object["name"] == "Fail derived") {
        return Err("derived facts unavailable".into());
    }
    let mut values = Vec::new();
    for (id, _) in objects.iter().filter(|(_, o)| o["$type"] == "Item") {
        if ids.is_some_and(|ids| !ids.contains(&json!(id))) {
            continue;
        }
        count_derived();
        values.push(json!({"id":id,"values":{"layerItems":layer_items(objects,id)}}));
    }
    Ok(json!({"objects":values}))
}

fn count_derived() {
    use std::io::Write;
    if let Ok(path) = std::env::var("KITION_KIT_MOCK_DERIVED_COUNT") {
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        writeln!(file, "evaluation").unwrap();
    }
}

pub fn derived_content(replica: &Replica, params: &Value) -> Result<Value, String> {
    if params["field"] == "~layerItems" && params["region"].is_u64() {
        let id = params["id"].as_str().ok_or("id is required")?;
        let before = params["before"].as_array().ok_or("complete derived basis is required")?;
        let index = params["region"].as_u64().ok_or("member index is required")? as usize;
        let state = replica.state_json().map_err(|error| error.to_string())?;
        let now = layer_items(state["objects"].as_object().ok_or("no objects")?, id);
        return Ok(json!({"changed":before.get(index) != now.get(index)}));
    }
    if params["field"] == "~textSlice" {
        let id = params["id"].as_str().ok_or("id is required")?;
        let slice = |objects: &Value| -> Result<String, String> {
            Ok(objects[id]["data"].as_str().ok_or("complete checkpoint text is required")?.chars().skip(2).take(3).collect())
        };
        let mut changed = false;
        for entry in params["before"]["history"].as_array().ok_or("history is required")? {
            changed |= slice(&entry["before"]["objects"])? != slice(&entry["after"]["objects"])?;
        }
        return Ok(json!({"changed":changed}));
    }
    if params["field"] == "data" {
        let before = rich_text(&params["before"]).ok_or("complete basis text is required")?;
        let id = ObjectId::from_string(params["id"].as_str().ok_or("id is required")?);
        let now = if std::env::var_os("KITION_KIT_MOCK_MARKS").is_some() {
            kition_kdm::tool_ids::ToolIds::of_replica(replica).show_text(&json!(replica.text_delta(&id, "data").map_err(|error| error.to_string())?))
        } else {
            replica.get(&id, "data").map_err(|error| error.to_string())?
        };
        let now = rich_text(&now).ok_or("current text is required")?;
        let from = params["region"][0].as_u64().ok_or("range start is required")? as usize;
        let to = params["region"][1].as_u64().ok_or("range end is required")? as usize;
        return Ok(json!({"changed":before.get(from..to) != now.get(from..to)}));
    }
    count_derived();
    let state = replica.state_json().map_err(|e| e.to_string())?;
    let id = params["id"].as_str().ok_or("id is required")?;
    let before = params["before"]["objects"].as_object().ok_or("basis objects are required")?;
    let now = state["objects"].as_object().ok_or("no objects")?;
    let changed = if let Some(history) = params["before"]["history"].as_array() {
        history
            .iter()
            .any(|entry| layer_items(entry["before"]["objects"].as_object().unwrap(), id) != layer_items(entry["after"]["objects"].as_object().unwrap(), id))
    } else {
        layer_items(before, id) != layer_items(now, id)
    };
    Ok(json!({"changed":changed}))
}

pub fn covered(replica: &Replica, params: &Value, objects: &[Value]) -> Result<Value, String> {
    if std::env::var_os("KITION_KIT_MOCK_CONDITIONAL").is_some() && params.get("predicate").is_some() {
        let mut under: std::collections::BTreeSet<String> = conditional_objects(replica, params).into_iter().collect();
        let mut covered = Vec::new();
        for object in objects {
            let id = object["id"].as_str().ok_or("missing covered identity")?;
            under.remove(id);
            let data = object["before"].get("data").cloned().or_else(|| replica.get(&ObjectId::from_string(id), "data").ok()).unwrap_or(Value::Null);
            let known = object["unknown"].as_array().is_none_or(Vec::is_empty);
            let held = known.then(|| object["created"] != true && conditional_match(params, id, &data));
            if held == Some(true) {
                under.insert(id.to_owned());
            }
            let now = replica.get(&ObjectId::from_string(id), "data").ok();
            covered.push(json!({"id":id,"covered":held,"content":if now.as_ref()==Some(&data) {"same"} else {"changed"}}));
        }
        return Ok(json!({"under":under,"covered":covered}));
    }
    if let Ok(mode) = std::env::var("KITION_KIT_MOCK_COVERED_GONE") {
        let id = params["item"].as_str().ok_or("item required")?;
        let gone = replica.get(&ObjectId::from_string(id), "data").ok() == Some(json!(""));
        return Ok(
            json!({"under":[id],"covered":objects.iter().map(|object|json!({"id":object["id"],"covered":if mode=="unknown" {Value::Null} else {json!(true)},"gone":mode=="deleted" && gone})).collect::<Vec<_>>() }),
        );
    }
    if params["emptyPlace"] == "covers" {
        let mut under: std::collections::BTreeSet<String> = replica
            .objects_of_type("Other")
            .into_iter()
            .filter(|id| replica.get(id, "extra").ok() == Some(json!(1)))
            .map(|id| kition_kdm::tool_ids::ToolIds::of_replica(replica).show(&id))
            .collect();
        let covered: Vec<_> = objects
            .iter()
            .map(|object| {
                let id = object["id"].as_str().unwrap();
                let held = object["before"]["extra"] == 1;
                under.remove(id);
                if held {
                    under.insert(id.to_owned());
                }
                json!({"id":id,"covered":held})
            })
            .collect();
        return Ok(json!({"under":under,"covered":covered}));
    }
    let id = params["item"].as_str().ok_or("item is required")?;
    let from = params["range"][0].as_u64().ok_or("range start is required")? as usize;
    let to = params["range"][1].as_u64().ok_or("range end is required")? as usize;
    let now = replica.get(&ObjectId::from_string(id), "data").map_err(|e| e.to_string())?;
    let mut under = vec![json!(id)];
    let mut covered = Vec::new();
    for object in objects {
        let before = rich_text(&object["before"]["data"]);
        let current = rich_text(&now);
        let (held, content) = match (before, current) {
            (Some(before), Some(current)) => {
                let (b, n) = (before, current);
                let prefix = b.iter().zip(&n).take_while(|(a, b)| a.0 == b.0).count();
                let suffix = b.iter().skip(prefix).rev().zip(n.iter().skip(prefix).rev()).take_while(|(a, b)| a.0 == b.0).count();
                let removed_end = b.len() - suffix;
                let deleted = removed_end > prefix && n.len() - suffix == prefix && prefix < to && removed_end > from;
                let moved = prefix < from && b.len() != n.len();
                let changed = b.get(from..to) != n.get(from..to);
                (
                    deleted || !moved,
                    if deleted {
                        "deleted"
                    } else if changed {
                        "changed"
                    } else {
                        "same"
                    },
                )
            }
            _ => (true, "unknown"),
        };
        if !held {
            under.clear();
        }
        covered.push(json!({"id":object["id"],"covered":held,"content":content}));
    }
    Ok(json!({"under":under,"covered":covered}))
}

fn conditional_match(params: &Value, id: &str, data: &Value) -> bool {
    match params["predicate"].as_str() {
        Some("parameter") => params["kind"] == "shape" && params["recipient"] == id,
        Some("subset") => params["subset"].as_array().is_some_and(|subset| subset.contains(&data["owner"])),
        Some("bytes") => data.get("bytes").is_some_and(|bytes| bytes == &params["bytes"]),
        _ => false,
    }
}

fn conditional_objects(replica: &Replica, params: &Value) -> Vec<String> {
    replica
        .objects_of_type("Other")
        .iter()
        .filter(|id| conditional_match(params, id.as_str(), &replica.get(id, "data").unwrap_or(Value::Null)))
        .map(ToString::to_string)
        .collect()
}

fn rich_text(value: &Value) -> Option<Vec<(char, Value)>> {
    if let Some(text) = value.as_str() {
        return Some(text.chars().map(|c| (c, Value::Null)).collect());
    }
    let mut chars = Vec::new();
    for run in value.as_array()? {
        chars.extend(run["insert"].as_str()?.chars().map(|c| (c, run["attributes"].clone())));
    }
    Some(chars)
}
