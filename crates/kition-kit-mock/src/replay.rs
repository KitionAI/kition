// Copied from kition-sdk crates/kition-kit-mock/src/replay.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A slide-like owned body and a motion-like owned composition with addressable layers.
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, Tx};
use serde_json::{Map, Value, json};
use std::sync::{Arc, LazyLock};

pub static REPLAY: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_ORDER").is_ok_and(|s| s == "replay"));
static SCHEMA: LazyLock<String> = LazyLock::new(|| {
    json!({"kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Root","types":{
    "Root":{"fields":{"items":{"kind":"list","of":"Item"}}},
    "Item":{"toolId":{"field":"id","prefix":"slide:"},"fields":{"id":{"kind":"integer","optional":true,"readOnly":true},"name":{"kind":"string"},"notesBody":{"kind":"ref","of":"TextBody","owns":true},"comp":{"kind":"ref","of":"Comp","owns":true}}},
    "TextBody":{"fields":{"paragraphs":{"kind":"list","of":"Paragraph"}}},
    "Paragraph":{"fields":{"text":{"kind":"string"}}},
    "Comp":{"fields":{"layers":{"kind":"list","of":"Layer"}}},
    "Layer":{"toolId":{"field":"id","prefix":"layer:"},"fields":{"id":{"kind":"integer","optional":true,"readOnly":true},"name":{"kind":"string"}}}
}}).to_string()
});
pub fn schema() -> &'static str {
    &SCHEMA
}
pub fn build(text: &str) -> Result<Replica, String> {
    let file: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Replica::create_with(Arc::new(Schema::parse(schema()).map_err(|e| e.to_string())?), DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
        let root = tx.create_with_id("Root", &ObjectId::from_string("replay-root"), Map::new())?;
        for (at, item) in file["items"].as_array().into_iter().flatten().enumerate() {
            let body = tx.create("TextBody", Map::new())?;
            let p = tx.create("Paragraph", Map::from_iter([("text".into(), item["notes"].clone())]))?;
            tx.list_insert(&body, "paragraphs", 0, &p)?;
            let comp = tx.create_with_id("Comp", &ObjectId::from_string(format!("comp:{}", item["id"])), Map::new())?;
            for (at, layer) in item["layers"].as_array().into_iter().flatten().enumerate() {
                let layer = tx.create("Layer", layer.as_object().cloned().unwrap_or_default())?;
                tx.list_insert(&comp, "layers", at, &layer)?;
            }
            let item = tx.create(
                "Item",
                Map::from_iter([
                    ("id".into(), item["id"].clone()),
                    ("name".into(), item["name"].clone()),
                    ("notesBody".into(), json!(body.as_str())),
                    ("comp".into(), json!(comp.as_str())),
                ]),
            )?;
            tx.list_insert(&root, "items", at, &item)?;
        }
        Ok(())
    })
    .map(|(replica, ())| replica)
    .map_err(|e| e.to_string())
}
pub fn text_of(replica: &Replica) -> Result<String, String> {
    let items = replica.list(&ObjectId::from_string("replay-root"), "items").map_err(|e| e.to_string())?;
    let file:Vec<_>=items.iter().map(|id|{
        let body=ObjectId::from_string(replica.get(id,"notesBody").unwrap().as_str().unwrap());
        let comp=ObjectId::from_string(replica.get(id,"comp").unwrap().as_str().unwrap());
        let paragraphs=replica.list(&body,"paragraphs").unwrap();
        json!({"id":replica.get(id,"id").unwrap(),"name":replica.get(id,"name").unwrap(),"notes":paragraphs.first().map(|id|replica.get(id,"text").unwrap()).unwrap_or(json!("")),"layers":replica.list(&comp,"layers").unwrap().iter().map(|id|json!({"id":replica.get(id,"id").unwrap(),"name":replica.get(id,"name").unwrap()})).collect::<Vec<_>>()})
    }).collect();
    Ok(json!({"items":file}).to_string())
}
pub fn settle(tx: &mut Tx<'_>) -> kition_kdm::Result<()> {
    for ty in ["Item", "Layer"] {
        let ids = tx.objects_of_type(ty);
        let mut next = ids.iter().filter_map(|id| tx.get(id, "id").ok()?.as_u64()).max().unwrap_or(0) + 1;
        for id in ids {
            if tx.get(&id, "id").ok().is_none_or(|v| v.is_null()) {
                tx.set(&id, "id", json!(next))?;
                next += 1;
            }
        }
    }
    Ok(())
}
