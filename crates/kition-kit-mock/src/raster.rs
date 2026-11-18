// Copied from kition-sdk crates/kition-kit-mock/src/raster.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Four opaque pixels in one replaceable tile, for historical-byte and region premises.
use crate::tracks::Edited;
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema};
use serde_json::{Map, Value, json};
use std::sync::{Arc, LazyLock};

pub static RASTER: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_ORDER").is_ok_and(|s| s == "raster"));
const SCHEMA: &str = r#"{"kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Surface","types":{"Surface":{"fields":{"name":{"kind":"string"},"tile":{"kind":"blob","position":true},"raw":{"kind":"json","readOnly":true,"sample":false}}}}}"#;
pub fn schema() -> &'static str {
    SCHEMA
}
fn root() -> ObjectId {
    ObjectId::from_string("surface")
}
pub fn build(text: &str) -> Result<Replica, String> {
    let file: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let fields = json!({"name":file["name"],"raw":file["pixels"],"tile":{"hash":file["hash"],"mime":"application/octet-stream","size":file["pixels"].as_array().unwrap().len()}});
    Replica::create_with(Arc::new(Schema::parse(SCHEMA).map_err(|e| e.to_string())?), DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
        tx.create_with_id("Surface", &root(), fields.as_object().unwrap().clone()).map(|_| ())
    })
    .map(|(r, ())| r)
    .map_err(|e| e.to_string())
}
pub fn text_of(replica: &Replica) -> Result<String, String> {
    Ok(json!({"name":replica.get(&root(),"name").map_err(|e|e.to_string())?,"pixels":replica.get(&root(),"raw").map_err(|e|e.to_string())?,"hash":replica.get(&root(),"tile").map_err(|e|e.to_string())?["hash"]}).to_string())
}
pub fn pixels(replica: &Replica) -> Vec<u8> {
    replica.get(&root(), "raw").unwrap().as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect()
}
pub fn hash(replica: &Replica) -> String {
    replica.get(&root(), "tile").unwrap()["hash"].as_str().unwrap().to_owned()
}
pub fn index(params: &Value) -> usize {
    params["pick"][1].as_u64().unwrap_or(0) as usize * 2 + params["pick"][0].as_u64().unwrap_or(0) as usize
}
pub fn under(replica: &Replica, params: &Map<String, Value>) -> Result<Option<Value>, String> {
    if let Some(region) = params.get("region") {
        return Ok(Some(
            json!({"objects":[],"premises":[{"id":"surface","fields":["name"],"positions":[]}],"content":[{"id":"surface","field":"tile","region":region}]}),
        ));
    }
    let hit = pixels(replica).get(index(&json!(params))).is_some_and(|v| *v != 0);
    Ok(Some(
        json!({"objects":if hit {vec!["surface"]}else{vec![]},"premises":[{"id":"surface","fields":["name"],"positions":[]}],"covers":{"fields":["tile"]}}),
    ))
}
pub fn edit(replica: &mut Replica, command: &str, params: &Map<String, Value>, origin: &Origin) -> Result<Edited, String> {
    if command == "raster.replace" {
        let pixels = params.get("pixels").cloned().ok_or("pixels required")?;
        let hash = params.get("hash").cloned().ok_or("hash required")?;
        replica
            .transact(origin, |tx| {
                tx.set(&root(), "raw", pixels.clone())?;
                tx.set(&root(), "tile", json!({"hash":hash,"mime":"application/octet-stream","size":pixels.as_array().map_or(0,Vec::len)}))
            })
            .map_err(|e| e.to_string())?;
        return Ok(Edited { result: None, changed: true, selection: None });
    }
    if !matches!(command, "raster.rename" | "raster.regionRename") {
        return Err(format!("unknown command {command}"));
    }
    if command == "raster.rename" && pixels(replica).get(index(&json!(params))).is_none_or(|v| *v == 0) {
        return Err("no opaque pixel here".into());
    }
    replica.transact(origin, |tx| tx.set(&root(), "name", params.get("name").cloned().unwrap_or(json!("Agent")))).map_err(|e| e.to_string())?;
    Ok(Edited { result: None, changed: true, selection: None })
}
pub fn commands() -> Vec<(&'static str, &'static str, bool, Value)> {
    vec![
        ("raster.replace", "Replace pixel tile", true, json!({"type":"object","properties":{"pixels":{"type":"array"},"hash":{"type":"string"}}})),
        (
            "raster.regionRename",
            "Rename from region content",
            true,
            json!({"type":"object","properties":{"id":{"type":"string","x-khp-role":"targets"},"region":{"type":"array"},"name":{"type":"string"}}}),
        ),
        (
            "raster.rename",
            "Rename by opaque pixel",
            true,
            json!({"type":"object","properties":{"pick":{"type":"array","x-khp-role":"place"},"name":{"type":"string"}}}),
        ),
    ]
}
