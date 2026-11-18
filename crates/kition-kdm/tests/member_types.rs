// Copied from kition-sdk crates/kition-kdm/tests/member_types.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! bounded scalar members require numbers, with explicit nullability.
use std::sync::Arc;

use kition_kdm::{
    ActorId, DocId, Replica, Schema,
    batch::{self, ReplicaTarget},
};
use serde_json::json;

#[test]
fn typed_owning_maps_enforce_values_and_roundtrip_through_tools() {
    let schema = Schema::parse(
        &json!({"kdm":1,"kit":"kit.test","schemaVersion":1,"root":"Root","types":{
            "Root":{"fields":{"cells":{"kind":"map","owns":true,"of":"Cell"},"loose":{"kind":"map","owns":true}}},
            "Cell":{"fields":{"text":{"kind":"string"}}},"Other":{"fields":{}}
        }})
        .to_string(),
    )
    .expect("typed owning map schema");
    let mut replica = Replica::create(Arc::new(schema), DocId::new(), ActorId::random()).unwrap();
    batch::run(
        &mut ReplicaTarget(&mut replica),
        &json!({"ops":[
            {"op":"create","type":"Root","id":"r"},
            {"op":"create","type":"Cell","id":"c","fields":{"text":"value"}},
            {"op":"create","type":"Other","id":"o"},
            {"op":"map.set","target":"root","field":"cells","key":"A1","value":"c"},
            {"op":"map.set","target":"root","field":"loose","key":"anything","value":{"literal":42}},
        ]}),
    )
    .unwrap();
    assert_eq!(batch::describe(&replica)["types"]["Root"]["fields"]["cells"]["of"], "Cell");
    for value in [json!("o"), json!(42), json!({"body":"c"})] {
        let before = replica.state_hash().unwrap();
        assert!(
            batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"map.set","target":"root","field":"cells","key":"B1","value":value}]})).is_err(),
            "accepted {value}"
        );
        assert_eq!(replica.state_hash().unwrap(), before);
    }
    let loaded = batch::run(&mut ReplicaTarget(&mut replica), &json!({"load":[{"target":"root","fields":["cells"]}]})).unwrap();
    assert_eq!(loaded["loaded"][0]["fields"]["cells"]["A1"], "c");
    let root = kition_kdm::ObjectId::from_string("r");
    let other = kition_kdm::ObjectId::from_string("o");
    assert!(replica.transact(&kition_kdm::Origin::person("map-test"), |tx| tx.map_set(&root, "cells", "B1", json!(other.as_str()))).is_err());
}

#[test]
fn bounded_members_require_numeric_scalars() {
    let schema = Schema::parse(
        &json!({"kdm":1,"kit":"kit.test","schemaVersion":1,"root":"Root","types":{"Root":{"fields":{
            "data":{"kind":"json","members":{"roughness":{"minimum":0},"resolution":{"minimum":1},"resolution[]":{"minimum":1},"a.b":{"maximum":1}}}
        }}}})
        .to_string(),
    )
    .unwrap();
    let mut replica = Replica::create(Arc::new(schema), DocId::new(), ActorId::random()).unwrap();
    batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"create","type":"Root","id":"r","fields":{"data":{}}}]})).unwrap();
    for value in
        [json!({"roughness":"bad"}), json!({"roughness":false}), json!({"roughness":null}), json!({"resolution":[2,"bad",2]}), json!({"a":{"b":false}})]
    {
        let before = replica.state_hash().unwrap();
        assert!(
            batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"set","target":"root","field":"data","value":value}]})).is_err(),
            "accepted {value}"
        );
        assert_eq!(replica.state_hash().unwrap(), before);
    }
    for value in [json!({}), json!({"resolution":2}), json!({"resolution":[2,2,2]}), json!({"roughness":{},"a":{"b":[]}})] {
        batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"set","target":"root","field":"data","value":value}]})).unwrap();
    }
}

#[test]
fn nullable_member_limits_roundtrip_and_validate() {
    let schema = Schema::parse(
        &json!({"kdm":1,"kit":"kit.test","schemaVersion":1,"root":"Root","types":{"Root":{"fields":{
            "data":{"kind":"json","members":{"count":{"minimum":0,"multipleOf":1,"nullable":true}}}
        }}}})
        .to_string(),
    )
    .unwrap();
    let mut replica = Replica::create(Arc::new(schema), DocId::new(), ActorId::random()).unwrap();
    batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"create","type":"Root","id":"r","fields":{"data":{"count":null}}}]})).unwrap();
    assert_eq!(batch::describe(&replica)["types"]["Root"]["fields"]["data"]["members"]["count"]["nullable"], true);
    for value in [json!(1.5), json!(-1), json!(false), json!("bad")] {
        assert!(batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"set","target":"root","field":"data.count","value":value}]})).is_err());
    }
}
