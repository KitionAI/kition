// Copied from kition-sdk crates/kition-kdm/tests/nested_members.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! numeric constraints visit nested JSON and arrays.
use kition_kdm::batch::{self, ReplicaTarget};
use kition_kdm::{ActorId, DocId, Origin, Replica, Schema};
use serde_json::json;
use std::sync::Arc;

#[test]
fn nested_member_numbers_are_checked_atomically() {
    let schema = Arc::new(Schema::parse(&json!({"kdm":1,"kit":"kit.test","schemaVersion":1,"root":"Root","types":{"Root":{"fields":{
        "data":{"kind":"json","minimum":0,"members":{"motion.shutter":{"minimum":0,"maximum":1},"weights[]":{"minimum":0},"layers[].opacity":{"minimum":0,"maximum":1}}}
    }}}}).to_string()).unwrap());
    let mut replica = Replica::create(schema, DocId::new(), ActorId::random()).unwrap();
    let good = json!({"motion":{"shutter":0.5},"weights":[2,2,2],"layers":[{"opacity":0.5},{"opacity":1}]});
    batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"create","type":"Root","id":"r","fields":{"data":good}}]})).unwrap();
    for (field, value) in [
        ("data.motion.shutter", json!(-1)),
        ("data.weights.1", json!(-1)),
        ("data.layers.0.opacity", json!(2)),
        ("data", json!({"motion":{"shutter":-1}})),
        ("data", json!({"weights":[2,-1,2]})),
        ("data", json!({"layers":[{"opacity":-1}]})),
        ("data.motion.shutter", json!("auto")),
        ("data.weights.1", json!(null)),
        ("data.layers.0.opacity", json!(false)),
    ] {
        let before = replica.state_hash().unwrap();
        assert!(
            batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"set","target":"root","field":field,"value":value}]})).is_err(),
            "{field}={value}"
        );
        assert_eq!(replica.state_hash().unwrap(), before);
    }
    for value in [json!([2, 2, 2]), json!({"motion":{"shutter":{}}}), json!("auto")] {
        replica.transact(&Origin::system("heterogeneous"), |tx| tx.set(&replica_id(), "data", value.clone())).unwrap();
    }
}
fn replica_id() -> kition_kdm::ObjectId {
    kition_kdm::ObjectId::from_string("r")
}
