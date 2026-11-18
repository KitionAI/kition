// Copied from kition-sdk crates/kition-kdm/tests/integer_paths.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use kition_kdm::{
    ActorId, DocId, Origin, Replica, Schema, Tx,
    batch::{self, BatchError, BatchTarget, ReplicaTarget, ValueLimits},
};
use serde_json::{Value, json};
use std::sync::Arc;

#[test]
fn nullable_nested_and_map_integer_limits_are_atomic() {
    let schema = Schema::parse(
        &json!({"kdm":1,"kit":"kit.test","schemaVersion":1,"root":"Root","types":{"Root":{"fields":{
            "count":{"kind":"integer","optional":true,"minimum":0,"multipleOf":1},
            "data":{"kind":"json","members":{"doc.revision":{"minimum":0,"multipleOf":1,"nullable":true}}},
            "parts":{"kind":"map","members":{"style":{"minimum":0,"multipleOf":1},"*.count":{"minimum":0,"multipleOf":1,"nullable":true}}}
        }}}})
        .to_string(),
    )
    .unwrap();
    let mut replica = Replica::create(Arc::new(schema), DocId::new(), ActorId::random()).unwrap();
    batch::run(
        &mut ReplicaTarget(&mut replica),
        &json!({"ops":[{"op":"create","type":"Root","id":"r","fields":{"count":null,"data":{"doc":{"revision":null}}}}]}),
    )
    .unwrap();
    for (key, value, valid) in [
        ("style", json!(2), true),
        ("style", json!(0.5), false),
        ("style", json!(null), false),
        ("other", json!({"count":null}), true),
        ("other", json!({"count":1.5}), false),
    ] {
        let before = replica.state_hash().unwrap();
        let answer = batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"map.set","target":"root","field":"parts","key":key,"value":value}]}));
        assert_eq!(answer.is_ok(), valid, "{key}={value}: {answer:?}");
        if !valid {
            assert_eq!(replica.state_hash().unwrap(), before);
        }
    }
    for value in [json!(0.5), json!(-1), json!(false)] {
        assert!(
            batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"set","target":"root","field":"data.doc.revision","value":value}]})).is_err()
        );
    }
}

#[test]
fn deleting_map_metadata_revalidates_conditional_limits_atomically() {
    struct Limited<'a>(&'a mut Replica);
    impl BatchTarget for Limited<'_> {
        fn value_limits(&mut self) -> Option<ValueLimits> {
            Some(Box::new(|object, path| {
                (path == "value")
                    .then(|| serde_json::from_value(json!({"minimum":0,"maximum":if object["fields"]["config"]["wide"]==true {10} else {1}})).unwrap())
            }))
        }
        fn replica(&mut self) -> Result<&Replica, BatchError> {
            Ok(self.0)
        }
        fn transact(&mut self, origin: &Origin, write: &mut dyn FnMut(&mut Tx<'_>) -> Result<(), BatchError>) -> Result<(), BatchError> {
            batch::transact_replica(self.0, origin, write)
        }
        fn command(&mut self, _: &str, _: Value, _: &Origin) -> Result<Value, String> {
            Err("no commands".into())
        }
    }
    let schema = Schema::parse(
        &json!({"kdm":1,"kit":"kit.test","schemaVersion":1,"root":"Root","types":{"Root":{"fields":{
            "value":{"kind":"number"},"config":{"kind":"map"}
        }}}})
        .to_string(),
    )
    .unwrap();
    let mut replica = Replica::create(Arc::new(schema), DocId::new(), ActorId::random()).unwrap();
    batch::run(
        &mut Limited(&mut replica),
        &json!({"ops":[
            {"op":"create","type":"Root","id":"r","fields":{"value":0}},
            {"op":"map.set","target":"root","field":"config","key":"wide","value":true},
            {"op":"set","target":"root","field":"value","value":5}
        ]}),
    )
    .unwrap();
    let before = replica.state_hash().unwrap();
    let answer = batch::run(&mut Limited(&mut replica), &json!({"ops":[{"op":"map.delete","target":"root","field":"config","key":"wide"}]}));
    assert_eq!(answer.expect_err("removing metadata must revalidate value").code, batch::BatchErrorCode::InvalidValue);
    assert_eq!(replica.state_hash().unwrap(), before);
    batch::run(
        &mut Limited(&mut replica),
        &json!({"ops":[
            {"op":"set","target":"root","field":"value","value":1},
            {"op":"map.delete","target":"root","field":"config","key":"wide"}
        ]}),
    )
    .unwrap();
}
