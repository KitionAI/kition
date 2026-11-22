// Copied from kition-sdk crates/kition-kit-mock/src/paragraphs.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Nested owned lists with persisted UUIDs (`KITION_KIT_MOCK_ORDER=paragraphs`). With
//! `KITION_KIT_MOCK_PARAGRAPHS=numbered` the shape's tool id is the integer `1` (no prefix), so a
//! receipt names the body's paragraphs under the number `1` at `body.paragraphs`.
use std::sync::{Arc, LazyLock};

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema};
use serde_json::{Map, Value, json};

pub static PARAGRAPHS: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_ORDER").as_deref() == Ok("paragraphs"));
static NUMBERED: LazyLock<bool> = LazyLock::new(|| std::env::var("KITION_KIT_MOCK_PARAGRAPHS").as_deref() == Ok("numbered"));
pub const BODY: &str = "00000000-0000-0000-0000-000000000020";
pub const SHAPE: &str = "00000000-0000-0000-0000-000000000010";
pub const SCHEMA: &str = r#"{
  "kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Root","types":{
    "Root":{"toolId":{"field":"key"},"fields":{"key":{"kind":"string","readOnly":true},"shapes":{"kind":"list","of":"Shape"}}},
    "Shape":{"toolId":{"field":"key","prefix":"shape:"},"fields":{"key":{"kind":"string","readOnly":true},"body":{"kind":"ref","of":"TextBody","owns":true}}},
    "TextBody":{"fields":{"paragraphs":{"kind":"list","of":"Paragraph"}}},
    "Paragraph":{"fields":{"text":{"kind":"text"}}}
  }
}"#;
const NUMBERED_SCHEMA: &str = r#"{
  "kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Root","types":{
    "Root":{"toolId":{"field":"key"},"fields":{"key":{"kind":"string","readOnly":true},"shapes":{"kind":"list","of":"Shape"}}},
    "Shape":{"toolId":{"field":"key"},"fields":{"key":{"kind":"integer","readOnly":true},"body":{"kind":"ref","of":"TextBody","owns":true}}},
    "TextBody":{"fields":{"paragraphs":{"kind":"list","of":"Paragraph"}}},
    "Paragraph":{"fields":{"text":{"kind":"text"}}}
  }
}"#;

/// The schema: [`SCHEMA`], or with `KITION_KIT_MOCK_PARAGRAPHS=numbered` its numbered shape.
pub fn schema() -> &'static str {
    if *NUMBERED { NUMBERED_SCHEMA } else { SCHEMA }
}

pub fn build(text: &str) -> Result<Replica, String> {
    let file: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
    let schema = Arc::new(Schema::parse(schema()).map_err(|error| error.to_string())?);
    let (replica, ()) = Replica::create_with(schema, DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
        let body = tx.create_with_id("TextBody", &ObjectId::from_string(BODY), Map::new())?;
        let shape = tx.create_with_id(
            "Shape",
            &ObjectId::from_string(SHAPE),
            json!({"key":if *NUMBERED { json!(1) } else { json!("1") },"body":BODY}).as_object().unwrap().clone(),
        )?;
        let root =
            tx.create_with_id("Root", &ObjectId::from_string("00000000-0000-0000-0000-000000000001"), json!({"key":"document"}).as_object().unwrap().clone())?;
        tx.list_insert(&root, "shapes", 0, &shape)?;
        for (index, paragraph) in file["paragraphs"].as_array().into_iter().flatten().enumerate() {
            let id = tx.create_with_id("Paragraph", &ObjectId::from_string(paragraph["id"].as_str().unwrap()), Map::new())?;
            tx.text_insert(&id, "text", 0, paragraph["text"].as_str().unwrap())?;
            tx.list_insert(&body, "paragraphs", index, &id)?;
        }
        Ok(())
    })
    .map_err(|error| error.to_string())?;
    Ok(replica)
}

pub fn text_of(replica: &Replica) -> Result<String, String> {
    let paragraphs = replica
        .list(&ObjectId::from_string(BODY), "paragraphs")
        .map_err(|error| error.to_string())?
        .iter()
        .map(|id| json!({"id":id.as_str(),"text":replica.text(id,"text").unwrap()}))
        .collect::<Vec<_>>();
    Ok(json!({"paragraphs":paragraphs}).to_string())
}
