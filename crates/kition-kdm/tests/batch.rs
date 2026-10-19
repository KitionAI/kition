// Copied from kition-sdk crates/kition-kdm/tests/batch.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Object-model batches (`kition_kdm::batch`): the shared fixtures `fixtures/batch.json`, which
//! `@kition/kdm` runs too, and the rules they do not cover.

use std::sync::Arc;

use kition_kdm::batch::{self, BatchError, BatchErrorCode, BatchTarget, ReplicaTarget};
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, Tx};
use serde_json::{Value, json};

mod common;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/batch.json")).unwrap()
}

fn replica_of(schema: &str) -> Replica {
    let schema = Arc::new(Schema::parse(schema).unwrap());
    Replica::create(schema, DocId::parse("01920000-0000-7000-8000-0000000000bb").unwrap(), ActorId::from_u64(1).unwrap()).unwrap()
}

#[test]
fn the_shared_fixtures_answer_as_written() {
    let fixture = fixture();
    let mut replica = replica_of(include_str!("fixtures/test-schema.json"));
    for (index, step) in fixture["steps"].as_array().unwrap().iter().enumerate() {
        let before = replica.state_hash().unwrap();
        let answer = batch::run(&mut ReplicaTarget(&mut replica), &step["request"]);
        match (&step["result"], answer) {
            (Value::Null, Err(error)) => {
                assert_eq!(error.code.as_str(), step["error"]["code"], "step {index}: {error}");
                assert_eq!(json!(error.index), step["error"]["index"], "step {index}: {error}");
                assert_eq!(replica.state_hash().unwrap(), before, "step {index} failed but changed the document");
            }
            (expected, Ok(answer)) if !expected.is_null() => assert_eq!(&answer, expected, "step {index}"),
            (_, answer) => panic!("step {index} answered {answer:?}"),
        }
    }
    let state = replica.state_json().unwrap();
    // Both implementations reach this state; the TypeScript suite compares its own against it.
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/batch-state.json");
    if std::env::var_os("KDM_WRITE_FIXTURE").is_some() {
        std::fs::write(path, format!("{state}\n")).unwrap();
    }
    let written: Value = serde_json::from_str(include_str!("fixtures/batch-state.json")).unwrap();
    assert_eq!(state, written);
}

#[test]
fn a_batch_without_commands_is_one_undo_step() {
    let mut replica = replica_of(include_str!("fixtures/test-schema.json"));
    let request = json!({ "origin": { "kind": "person", "principal": "user:test" }, "ops": [
        { "op": "create", "type": "Page", "ref": "$p", "fields": { "title": "A" } },
        { "op": "create", "type": "Shape", "in": "$p.shapes", "fields": { "kind": "rect", "x": 1.5, "y": 1.5 } },
    ] });
    batch::run(&mut ReplicaTarget(&mut replica), &request).unwrap();
    assert_eq!(replica.objects_of_type("Shape").len(), 1);
    assert!(replica.undo().unwrap());
    assert!(replica.objects_of_type("Page").is_empty() && replica.objects_of_type("Shape").is_empty());
    assert!(!replica.can_undo());
}

/// A target that records commands and refuses writes when read-only.
struct Kit<'a> {
    replica: &'a mut Replica,
    read_only: bool,
    commands: Vec<(String, Value, String)>,
}

impl BatchTarget for Kit<'_> {
    fn replica(&mut self) -> Result<&Replica, BatchError> {
        Ok(self.replica)
    }

    fn transact(&mut self, origin: &Origin, write: &mut dyn FnMut(&mut Tx<'_>) -> Result<(), BatchError>) -> Result<(), BatchError> {
        batch::transact_replica(self.replica, origin, write)
    }

    fn command(&mut self, id: &str, params: Value, origin: &Origin) -> Result<Value, String> {
        self.commands.push((id.to_owned(), params.clone(), origin.encode()));
        if id == "fail" { Err("it failed".into()) } else { Ok(json!({ "ran": id })) }
    }

    fn read_only(&self) -> bool {
        self.read_only
    }
}

#[test]
fn commands_take_resolved_references_and_split_the_batch() {
    let mut replica = replica_of(include_str!("fixtures/test-schema.json"));
    let mut kit = Kit { replica: &mut replica, read_only: false, commands: Vec::new() };
    let answer = batch::run(
        &mut kit,
        &json!({ "ops": [
            { "op": "create", "type": "Page", "ref": "$p", "id": "p", "fields": { "title": "A" } },
            { "op": "command", "id": "page.tidy", "params": { "page": "$p", "keep": ["$p", "$q"] } },
            { "op": "set", "target": "$p", "field": "title", "value": "B" },
            { "op": "command", "id": "fail" },
            { "op": "set", "target": "$p", "field": "title", "value": "C" },
        ] }),
    );
    let error = answer.unwrap_err();
    assert_eq!((error.code, error.index), (BatchErrorCode::CommandFailed, Some(3)));
    let (id, params, origin) = &kit.commands[0];
    assert_eq!((id.as_str(), params), ("page.tidy", &json!({ "page": "p", "keep": ["p", "$q"] })));
    assert_eq!(origin, r#"["extension","script",null]"#);
    // The steps before the failing command stay; the ones after it never ran.
    assert_eq!(replica.get(&kition_kdm::ObjectId::from_string("p"), "title").unwrap(), json!("B"));
}

#[test]
fn a_read_only_document_takes_reads_but_no_writes() {
    let mut replica = replica_of(include_str!("fixtures/test-schema.json"));
    batch::run(&mut ReplicaTarget(&mut replica), &json!({ "ops": [{ "op": "create", "type": "Page", "fields": { "title": "A" } }] })).unwrap();
    let mut kit = Kit { replica: &mut replica, read_only: true, commands: Vec::new() };
    let read = batch::run(&mut kit, &json!({ "load": [{ "target": "root", "fields": ["title"] }] })).unwrap();
    assert_eq!(read["loaded"][0]["fields"]["title"], "A");
    let error = batch::run(&mut kit, &json!({ "ops": [{ "op": "set", "target": "root", "field": "title", "value": "B" }] })).unwrap_err();
    assert_eq!(error.code, BatchErrorCode::ReadOnly);
}

#[test]
fn marks_load_as_runs_and_count_scalar_values() {
    let mut replica = replica_of(include_str!("fixtures/marks-schema.json"));
    let quarter = common::from_code_points(&common::QUARTER);
    let answer = batch::run(
        &mut ReplicaTarget(&mut replica),
        &json!({ "ops": [
            { "op": "create", "type": "Doc", "id": "d" },
            { "op": "create", "type": "Para", "in": "root.paras", "ref": "$t" },
            { "op": "text.insert", "target": "$t", "field": "text", "index": 0, "text": format!("{quarter} ok") },
            { "op": "text.mark", "target": "$t", "field": "text", "start": 0, "end": 2, "key": "bold", "value": true },
        ], "load": [{ "target": "$t", "fields": ["text", "plain"] }] }),
    )
    .unwrap();
    assert_eq!(answer["loaded"][0]["fields"]["text"], json!([{ "insert": quarter, "attributes": { "bold": true } }, { "insert": " ok" }]));
    assert_eq!(answer["loaded"][0]["fields"]["plain"], json!(""));
}

#[test]
fn describe_lists_types_and_the_root() {
    let mut replica = replica_of(include_str!("fixtures/test-schema.json"));
    assert_eq!(batch::describe(&replica)["rootId"], Value::Null);
    batch::run(&mut ReplicaTarget(&mut replica), &json!({ "ops": [{ "op": "create", "type": "Page", "id": "p", "fields": { "title": "A" } }] })).unwrap();
    let described = batch::describe(&replica);
    assert_eq!(described["capability"], "KitObjectModel 1.0");
    assert_eq!(described["rootId"], "p");
    assert_eq!(described["types"]["Page"]["fields"]["shapes"], json!({ "kind": "list", "of": "Shape" }));
    assert_eq!(described["types"]["Shape"]["fields"]["fill"], json!({ "kind": "string", "optional": true }));
    assert_eq!(described["types"]["Shape"]["fields"]["kind"], json!({ "kind": "enum", "values": ["rect", "ellipse"] }));
}

/// Writes `seed` from `fixtures/read-only.json` with the KDM's own transactions, as a kit's
/// import does: the object model cannot write read-only content.
fn seed_read_only(replica: &mut Replica, seed: &Value) {
    replica
        .transact(&Origin::person("user:test"), |tx| {
            for entry in seed.as_array().unwrap() {
                let split = |path: &str| {
                    let (owner, field) = path.split_once('.').unwrap();
                    (ObjectId::from_string(owner), field.to_owned())
                };
                if let Some(path) = entry["text"].as_str() {
                    let (owner, field) = split(path);
                    tx.text_insert(&owner, &field, 0, entry["value"].as_str().unwrap())?;
                } else if let Some(path) = entry["map"].as_str() {
                    let (owner, field) = split(path);
                    tx.map_set(&owner, &field, entry["key"].as_str().unwrap(), entry["value"].clone())?;
                } else {
                    let id = ObjectId::from_string(entry["id"].as_str().unwrap());
                    tx.create_with_id(entry["type"].as_str().unwrap(), &id, entry["fields"].as_object().cloned().unwrap_or_default())?;
                    if let Some(path) = entry["in"].as_str() {
                        let (owner, field) = split(path);
                        let len = tx.list_items(&owner, &field)?.len();
                        tx.list_insert(&owner, &field, len, &id)?;
                    }
                }
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn read_only_content_answers_the_shared_fixtures() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/read-only.json");
    let mut fixture: Value = serde_json::from_str(include_str!("fixtures/read-only.json")).unwrap();
    let schema = Arc::new(Schema::parse(include_str!("fixtures/read-only-schema.json")).unwrap());
    let mut replica = Replica::create(schema, DocId::parse(fixture["docId"].as_str().unwrap()).unwrap(), ActorId::from_u64(1).unwrap()).unwrap();
    seed_read_only(&mut replica, &fixture["seed"]);
    let write = std::env::var_os("KDM_WRITE_FIXTURE").is_some();
    for (index, step) in fixture["steps"].as_array_mut().unwrap().iter_mut().enumerate() {
        let before = replica.state_hash().unwrap();
        let answer = batch::run(&mut ReplicaTarget(&mut replica), &step["request"]);
        if step.get("error").is_some() {
            let error = answer.unwrap_err();
            assert_eq!(error.code.as_str(), step["error"]["code"], "step {index}: {error}");
            assert_eq!(json!(error.index), step["error"]["index"], "step {index}: {error}");
            assert_eq!(replica.state_hash().unwrap(), before, "step {index} failed but changed the document");
        } else if write {
            step["result"] = answer.unwrap();
        } else {
            assert_eq!(answer.unwrap(), step["result"], "step {index}");
        }
    }
    if write {
        std::fs::write(path, format!("{}\n", serde_json::to_string_pretty(&fixture).unwrap())).unwrap();
    }
    for case in fixture["invalidSchemas"].as_array().unwrap() {
        let error = Schema::parse(&case["schema"].to_string());
        assert!(matches!(error, Err(kition_kdm::KdmError::Schema(_))), "{}: {error:?}", case["why"]);
    }
}

#[test]
fn describe_names_read_only_types_and_fields() {
    let schema = Arc::new(Schema::parse(include_str!("fixtures/read-only-schema.json")).unwrap());
    let replica = Replica::create(schema, DocId::parse("01920000-0000-7000-8000-0000000000bc").unwrap(), ActorId::from_u64(1).unwrap()).unwrap();
    let described = batch::describe(&replica);
    assert_eq!(described["types"]["Kept"]["readOnly"], true);
    assert_eq!(described["types"]["Item"]["readOnlyWhen"], json!({ "field": "kind", "values": ["opaque"] }));
    assert!(described["types"]["Item"].get("readOnly").is_none());
    assert_eq!(described["types"]["Deck"]["fields"]["raw"], json!({ "kind": "json", "optional": true, "readOnly": true }));
    assert!(described["types"]["Deck"]["fields"]["title"].get("readOnly").is_none());
}

#[test]
fn a_document_reads_the_same_with_or_without_read_only_marks() {
    // The marks are the object model's alone: a replica written under the marked schema loads
    // under the same schema without them, and back (no schema version change is needed).
    let marked = include_str!("fixtures/read-only-schema.json");
    let mut plain: Value = serde_json::from_str(marked).unwrap();
    for def in plain["types"].as_object_mut().unwrap().values_mut() {
        let def = def.as_object_mut().unwrap();
        def.remove("readOnly");
        def.remove("readOnlyWhen");
        for field in def["fields"].as_object_mut().unwrap().values_mut() {
            field.as_object_mut().unwrap().remove("readOnly");
        }
    }
    let marked = Arc::new(Schema::parse(marked).unwrap());
    let plain = Arc::new(Schema::parse(&plain.to_string()).unwrap());
    let fixture: Value = serde_json::from_str(include_str!("fixtures/read-only.json")).unwrap();
    let mut replica = Replica::create(marked.clone(), DocId::parse("01920000-0000-7000-8000-0000000000bc").unwrap(), ActorId::from_u64(1).unwrap()).unwrap();
    seed_read_only(&mut replica, &fixture["seed"]);
    let reloaded = Replica::load(plain, &replica.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    assert_eq!(reloaded.state_json().unwrap(), replica.state_json().unwrap());
    let back = Replica::load(marked, &reloaded.snapshot().unwrap(), ActorId::from_u64(3).unwrap()).unwrap();
    assert_eq!(back.state_json().unwrap(), replica.state_json().unwrap());
}
