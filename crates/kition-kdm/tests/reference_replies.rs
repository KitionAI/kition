// Copied from kition-sdk crates/kition-kdm/tests/reference_replies.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::sync::Arc;

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, batch};
use serde_json::{Map, json};

#[test]
fn loads_translate_owning_maps_and_nested_json_references() {
    let schema = Schema::parse(
        &json!({"kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Root","types":{
            "Root":{"fields":{"children":{"kind":"map","owns":true},"data":{"kind":"json"},"text":{"kind":"string"}}},
            "Child":{"toolId":{"field":"key","prefix":"child:"},"fields":{"key":{"kind":"integer","readOnly":true}}}
        }})
        .to_string(),
    )
    .unwrap();
    let mut replica = Replica::create(Arc::new(schema), DocId::new(), ActorId::random()).unwrap();
    replica
        .transact(&Origin::system("open"), |tx| {
            let root =
                tx.create_with_id("Root", &ObjectId::from_string("raw-root"), Map::from_iter([("data".into(), json!({})), ("text".into(), json!(""))]))?;
            let child = tx.create_with_id("Child", &ObjectId::from_string("raw-child"), Map::from_iter([("key".into(), json!(7))]))?;
            tx.map_set(&root, "children", "raw-child", json!({"nested":[child.as_str()]}))?;
            tx.set(&root, "data", json!({"raw-child":{"ref":child.as_str()}}))?;
            tx.set(&root, "text", json!("literal raw-child text"))
        })
        .unwrap();
    let answer =
        batch::run(&mut batch::ReplicaTarget(&mut replica), &json!({"origin":{"kind":"agent","principal":"test"},"ops":[],"load":[{"target":"root"}]}))
            .unwrap();
    assert_eq!(
        answer["loaded"][0]["fields"],
        json!({"children":{"child:7":{"nested":["child:7"]}},"data":{"child:7":{"ref":"child:7"}},"text":"literal raw-child text"})
    );
}
