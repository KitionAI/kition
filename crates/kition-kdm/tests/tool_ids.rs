// Copied from kition-sdk crates/kition-kdm/tests/tool_ids.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Tool ids (KitObjectModel OM9; KHP A44, A46, A47, A48): the shared fixtures
//! `fixtures/tool-ids.json`, which `@kition/kdm` runs too, messages included. Before, the object
//! model answered and took only KDM object ids, so an agent met a kit's numbers (`item:10`) in
//! inspect, commands and diagnostics and UUIDs in query and batch, and edits landed on the wrong
//! object.

use std::sync::Arc;

use kition_kdm::batch::{self, BatchError, BatchTarget};
use kition_kdm::diff::diff_states;
use kition_kdm::testing::number_tool_ids;
use kition_kdm::tool_ids::ToolIds;
use kition_kdm::{ActorId, DocId, Origin, Replica, Schema, Tx};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/tool-ids.json")).unwrap()
}

/// A replica standing in for a kit that numbers what it holds: after each transaction, every
/// object of a type with a `toolId` and no number gets one more than the highest of its type under
/// the same holder, in type then id order. Its one command, `echo`, answers its parameters.
struct Numbering<'a>(&'a mut Replica);

impl BatchTarget for Numbering<'_> {
    fn replica(&mut self) -> Result<&Replica, BatchError> {
        Ok(self.0)
    }

    fn transact(&mut self, origin: &Origin, write: &mut dyn FnMut(&mut Tx<'_>) -> Result<(), BatchError>) -> Result<(), BatchError> {
        batch::transact_replica(self.0, origin, write)?;
        number_tool_ids(self.0).map_err(|error| BatchError::new(batch::BatchErrorCode::InvalidValue, None, error.to_string()))
    }

    fn command(&mut self, id: &str, params: Value, _origin: &Origin) -> Result<Value, String> {
        if id == "echo" { Ok(params) } else { Err(format!("unknown command `{id}`")) }
    }
}

fn replica_of(schema: &Value) -> Replica {
    let schema = Arc::new(Schema::parse(&schema.to_string()).unwrap());
    Replica::create(schema, DocId::parse("01920000-0000-7000-8000-0000000000cc").unwrap(), ActorId::from_u64(1).unwrap()).unwrap()
}

#[test]
fn the_object_model_answers_and_takes_tool_ids() {
    let fixture = fixture();
    let mut replica = replica_of(&fixture["schema"]);
    for (index, step) in fixture["steps"].as_array().unwrap().iter().enumerate() {
        let before = replica.state_json().unwrap();
        let answer = batch::run(&mut Numbering(&mut replica), &step["request"]);
        match (answer, &step["error"]) {
            (Err(error), expected) if !expected.is_null() => {
                assert_eq!(json!({ "code": error.code.as_str(), "index": error.index, "message": error.message }), *expected, "step {index}");
                assert_eq!(replica.state_json().unwrap(), before, "step {index} failed but changed the document");
            }
            (Ok(answer), Value::Null) => assert_eq!(answer, step["result"], "step {index}"),
            (answer, _) => panic!("step {index} answered {answer:?}"),
        }
        if !step["diff"].is_null() {
            let after = replica.state_json().unwrap();
            let schema = replica.schema();
            let diff = diff_states(&before, &after).with_tool_ids(schema, &ToolIds::of_state(schema, &before), &ToolIds::of_state(schema, &after));
            assert_eq!(diff.to_json(), step["diff"], "step {index}: the comparison");
        }
    }
    let described = batch::describe(&replica);
    assert_eq!(described["rootId"], fixture["describe"]["rootId"]);
    for (ty, tool) in fixture["describe"]["toolIds"].as_object().unwrap() {
        assert_eq!(described["types"][ty]["toolId"], *tool, "{ty}");
    }
    assert!(described["types"]["Tag"].get("toolId").is_none(), "a type without one says nothing");
}

#[test]
fn a_schema_checks_its_tool_ids() {
    let fixture = fixture();
    for case in fixture["schemaErrors"].as_array().unwrap() {
        let mut schema = fixture["schema"].clone();
        let ty = case["type"].as_str().unwrap();
        schema["types"][ty]["toolId"] = case["toolId"].clone();
        let error = Schema::parse(&schema.to_string()).expect_err(&case.to_string());
        assert_eq!(error.to_string(), case["message"], "{case}");
    }
}

/// A schema without `toolId` answers object ids as before (no kit that re-pins changes).
#[test]
fn a_schema_without_tool_ids_answers_object_ids() {
    let mut schema = fixture()["schema"].clone();
    for ty in ["Frame", "Cell", "Pin", "Flag"] {
        schema["types"][ty].as_object_mut().unwrap().remove("toolId");
    }
    let mut replica = replica_of(&schema);
    let request = json!({ "ops": [
        { "op": "create", "type": "Doc", "id": "doc" },
        { "op": "create", "type": "Frame", "id": "f1", "in": "doc.frames", "ref": "$f1" }
    ], "load": [{ "target": "root" }] });
    let answer = batch::run(&mut Numbering(&mut replica), &request).unwrap();
    assert_eq!(answer["results"], json!(["doc", "f1"]));
    assert_eq!(answer["refs"], json!({ "$f1": "f1" }));
    assert_eq!(answer["loaded"][0]["fields"]["frames"], json!(["f1"]));
    let gone = batch::run(&mut Numbering(&mut replica), &json!({ "ops": [{ "op": "delete", "target": "frame:9" }] })).unwrap_err();
    assert_eq!(gone.message, "object `frame:9` not found", "the KDM's own message, as before");
    assert!(!ToolIds::of_replica(&replica).is_active());
}
