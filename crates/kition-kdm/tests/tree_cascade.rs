// Copied from kition-sdk crates/kition-kdm/tests/tree_cascade.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! opt-in cascading deletes preserve the default child-first contract.
use kition_kdm::batch::{self, ReplicaTarget};
use kition_kdm::{ActorId, DocId, Replica, Schema};
use serde_json::json;
use std::sync::Arc;

#[test]
fn cascade_is_opt_in_atomic_and_names_every_descendant() {
    for cascade in [false, true] {
        let mut field = json!({"kind":"tree","of":"Node"});
        if cascade {
            field["cascade"] = json!(true);
        }
        let schema=Arc::new(Schema::parse(&json!({"kdm":1,"kit":"kit.test","schemaVersion":1,"root":"Root","types":{
            "Root":{"fields":{"nodes":field}},"Node":{"fields":{"name":{"kind":"string"},"key":{"kind":"string","readOnly":true}},"toolId":{"field":"key"}}
        }}).to_string()).unwrap());
        let mut replica = Replica::create(schema.clone(), DocId::new(), ActorId::random()).unwrap();
        batch::run(
            &mut ReplicaTarget(&mut replica),
            &json!({"ops":[
                {"op":"create","type":"Root","id":"r"},
                {"op":"create","type":"Node","id":"p","in":"root.nodes","fields":{"key":"p","name":"parent"}},
                {"op":"create","type":"Node","id":"c","in":"root.nodes","parent":"p","fields":{"key":"c","name":"child"}},
                {"op":"create","type":"Node","id":"g","in":"root.nodes","parent":"c","fields":{"key":"g","name":"grandchild"}},
                {"op":"create","type":"Node","id":"s","in":"root.nodes","fields":{"key":"s","name":"sibling"}}
            ]}),
        )
        .unwrap();
        let before = replica.state_json().unwrap();
        let since = replica.version();
        let answer = batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"delete","target":"p"}]}));
        if !cascade {
            assert!(answer.is_err());
            assert_eq!(replica.state_json().unwrap(), before);
            continue;
        }
        answer.unwrap();
        let changes = replica.changes_since(&since).unwrap().to_json();
        let deleted = changes["deleted"].as_array().unwrap();
        assert_eq!(deleted.iter().map(|v| v["id"].as_str().unwrap()).collect::<std::collections::BTreeSet<_>>(), ["p", "c", "g"].into_iter().collect());
        let after = replica.state_json().unwrap();
        let reread = kition_kdm::reread::diff_read_again(&schema, &before, &after).to_json();
        assert_eq!(reread["deleted"], changes["deleted"]);
        assert_eq!(replica.objects_of_type("Node").len(), 1);
        assert!(replica.undo().unwrap().is_done());
        assert_eq!(replica.state_json().unwrap(), before);
    }
}
