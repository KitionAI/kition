// Copied from kition-sdk crates/kition-kit-mock/src/comments.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Shared comment types exercised through commands and raw batches.
use std::sync::{Arc, LazyLock};

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, comment};
use serde_json::{Map, Value, json};

use crate::tracks::Edited;

pub static COMMENTS: LazyLock<bool> = LazyLock::new(|| std::env::var_os("KITION_KIT_MOCK_COMMENTS").is_some());
static SCHEMA: LazyLock<String> = LazyLock::new(|| {
    json!({"kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Root","types":{
        "Root":{"fields":{}},
        "CommentThread":serde_json::from_str::<Value>(comment::COMMENT_THREAD_TYPE_JSON).unwrap(),
        "Comment":serde_json::from_str::<Value>(comment::COMMENT_TYPE_JSON).unwrap()
    }})
    .to_string()
});

pub fn schema() -> &'static str {
    &SCHEMA
}

pub fn build(text: &str) -> Result<Replica, String> {
    let schema = Arc::new(Schema::parse(schema()).map_err(|e| e.to_string())?);
    if text != "new" {
        let bytes: Vec<u8> = serde_json::from_str(text).map_err(|e| e.to_string())?;
        return Replica::load(schema, &bytes, ActorId::random()).map_err(|e| e.to_string());
    }
    Replica::create_with(schema, DocId::new(), ActorId::random(), &Origin::system("open"), |tx| {
        tx.create_with_id("Root", &ObjectId::from_string("root-comments"), Map::new())?;
        for name in ["held", "other"] {
            let thread = tx.create_with_id(
                "CommentThread",
                &ObjectId::from_string(name),
                Map::from_iter([("anchor".into(), json!({"object":"root-comments"})), ("resolved".into(), json!(false))]),
            )?;
            let comment = tx.create_with_id(
                "Comment",
                &ObjectId::from_string(format!("{name}-comment")),
                Map::from_iter([("author".into(), json!("alice")), ("created".into(), json!("2026-11-14T00:00:00Z"))]),
            )?;
            tx.text_insert(&comment, "body", 0, "Question")?;
            tx.list_insert(&thread, "comments", 0, &comment)?;
        }
        Ok(())
    })
    .map(|(replica, ())| replica)
    .map_err(|e| e.to_string())
}

pub fn text_of(replica: &Replica) -> Result<String, String> {
    replica.content_snapshot().map(|bytes| json!(bytes).to_string()).map_err(|e| e.to_string())
}

pub fn under(command: &str, params: &Map<String, Value>) -> Value {
    let fields = match command {
        "comment.reply" => json!(["comments"]),
        "comment.resolve" => json!(["resolved"]),
        "comment.edit" => json!(["body"]),
        "comment.delete" => json!([]),
        _ => Value::Null,
    };
    let mut premise = json!({"id":params["target"],"positions":[]});
    if !fields.is_null() {
        premise["fields"] = fields;
    }
    json!({"objects":[],"premises":[premise]})
}

pub fn edit(replica: &mut Replica, command: &str, params: &Map<String, Value>, origin: &Origin) -> Result<Edited, String> {
    let target = ObjectId::from_string(params["target"].as_str().ok_or("target must be a string")?);
    replica
        .transact(origin, |tx| match command {
            "comment.reply" => comment::reply(
                tx,
                &target,
                &comment::NewComment { author: "agent".into(), name: None, body: "Reply".into(), created: "2026-11-14T00:00:00Z".into() },
            )
            .map(|_| ()),
            "comment.resolve" => comment::set_resolved(tx, &target, true),
            "comment.delete" => comment::delete_thread(tx, &target),
            "comment.edit" => {
                let length = tx.text_len(&target, "body")?;
                tx.text_delete(&target, "body", 0, length)?;
                tx.text_insert(&target, "body", 0, "Edited")
            }
            _ => Err(kition_kdm::KdmError::NotFound(command.into())),
        })
        .map_err(|e| e.to_string())?;
    Ok(Edited { result: None, changed: true, selection: None })
}

pub fn commands() -> Vec<(&'static str, &'static str, bool, Value)> {
    ["comment.reply", "comment.resolve", "comment.delete", "comment.edit"]
        .into_iter()
        .map(|command| {
            (
                command,
                "Write a comment",
                true,
                json!({"type":"object","required":["target"],"properties":{"target":{"type":"string","x-khp-role":"targets"}},"x-khp-position":"independent"}),
            )
        })
        .collect()
}
