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
fn raw_moves_address_every_pre_removal_gap() {
    for from in 0..4 {
        for to in 0..=5 {
            let mut replica = replica_of(include_str!("fixtures/test-schema.json"));
            let setup = json!({"ops":[
                {"op":"create","type":"Page","id":"page","fields":{"title":"One"}},
                {"op":"create","type":"Shape","id":"a","in":"root.shapes","fields":{"kind":"rect","x":0,"y":0}},
                {"op":"create","type":"Shape","id":"b","in":"root.shapes","fields":{"kind":"rect","x":0,"y":0}},
                {"op":"create","type":"Shape","id":"c","in":"root.shapes","fields":{"kind":"rect","x":0,"y":0}},
                {"op":"create","type":"Shape","id":"d","in":"root.shapes","fields":{"kind":"rect","x":0,"y":0}}
            ]});
            batch::run(&mut ReplicaTarget(&mut replica), &setup).unwrap();
            let before = replica.state_hash().unwrap();
            let result =
                batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"list.move","target":"root","field":"shapes","from":from,"to":to}]}));
            if to > 4 {
                assert_eq!(result.unwrap_err().code, BatchErrorCode::InvalidValue);
                assert_eq!(replica.state_hash().unwrap(), before);
            } else {
                result.unwrap();
                let mut order = vec!["a", "b", "c", "d"];
                let item = order.remove(from);
                order.insert(if to > from { to - 1 } else { to }, item);
                assert_eq!(
                    replica.list(&ObjectId::from_string("page"), "shapes").unwrap().iter().map(ObjectId::as_str).collect::<Vec<_>>(),
                    order,
                    "{from}/{to}"
                );
            }
        }
    }
}

#[test]
fn a_reused_tool_id_with_a_new_type_retains_the_replacement() {
    let schema = json!({"kdm":1,"kit":"kit.test","schemaVersion":1,"root":"Root","types":{
        "Root":{"fields":{"items":{"kind":"list","of":"Item"},"other":{"kind":"list","of":"Other"}}},
        "Item":{"fields":{"key":{"kind":"string","readOnly":true}},"toolId":{"field":"key"}},
        "Other":{"fields":{"key":{"kind":"string","readOnly":true}},"toolId":{"field":"key"}}
    }});
    let mut replica = replica_of(&schema.to_string());
    batch::run(
        &mut ReplicaTarget(&mut replica),
        &json!({"ops":[{"op":"create","type":"Root","id":"r"},{"op":"create","type":"Item","id":"A","in":"root.items","fields":{"key":"A"}}]}),
    )
    .unwrap();
    let since = replica.version();
    batch::run(
        &mut ReplicaTarget(&mut replica),
        &json!({"ops":[{"op":"delete","target":"A"},{"op":"create","type":"Other","in":"root.other","fields":{"key":"A"}}]}),
    )
    .unwrap();
    let changes = replica.changes_since(&since).unwrap().to_json();
    assert!(changes["deleted"].as_array().unwrap().iter().any(|c| c["id"] == "A"), "{changes}");
    assert!(changes["created"].as_array().unwrap().iter().any(|c| c["id"] == "A"), "{changes}");
}

#[test]
fn creation_only_fields_are_validated_at_creation_and_immutable_afterwards() {
    let mut replica = replica_of(
        &json!({"kdm":1,"kit":"kit.test","schemaVersion":1,"root":"Item","types":{
            "Item":{"fields":{"kind":{"kind":"enum","values":["shape","frame"],"readOnly":true},"name":{"kind":"string"}}}
        }})
        .to_string(),
    );
    for fields in [json!({"name":"New"}), json!({"kind":"invalid","name":"New"})] {
        assert_eq!(
            batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"create","type":"Item","id":"item","fields":fields}]})).unwrap_err().code,
            BatchErrorCode::InvalidValue
        );
        assert!(!replica.exists(&ObjectId::from_string("item")));
    }
    batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"create","type":"Item","id":"item","fields":{"kind":"shape","name":"New"}}]})).unwrap();
    let before = replica.state_hash().unwrap();
    let error = batch::run(
        &mut ReplicaTarget(&mut replica),
        &json!({"ops":[{"op":"set","target":"item","field":"name","value":"Changed"},{"op":"set","target":"item","field":"kind","value":"frame"}]}),
    )
    .unwrap_err();
    assert_eq!(error.code, BatchErrorCode::ReadOnly);
    assert_eq!(replica.state_hash().unwrap(), before);
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

/// `fixtures/derived.json`, which `@kition/kdm` runs too: a type's derived values are
/// described; a bad derived name, member, or a field named `~…` is refused.
#[test]
fn describe_names_derived_values_and_bad_ones_are_refused() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/derived.json")).unwrap();
    let replica = replica_of(&fixture["schema"].to_string());
    assert_eq!(batch::describe(&replica)["types"]["Node"]["derived"], fixture["described"]);
    assert!(batch::describe(&replica)["types"]["Scene"].get("derived").is_none());
    for refused in fixture["refused"].as_array().unwrap() {
        let schema = json!({ "kdm": 1, "kit": "k", "schemaVersion": 1, "root": "A", "types": refused["types"] });
        assert!(Schema::parse(&schema.to_string()).is_err(), "{}", refused["why"]);
    }
}

/// `fixtures/words-schema.json`, which `@kition/kdm` runs too: a type's `label` and a
/// field's `display` and `sample` are described; bad ones are refused.
#[test]
fn describe_names_labels_displays_and_samples() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/words-schema.json")).unwrap();
    let replica = replica_of(&fixture["schema"].to_string());
    assert_eq!(batch::describe(&replica)["types"]["Clip"], fixture["described"]["Clip"]);
    for refused in fixture["refused"].as_array().unwrap() {
        let schema = json!({ "kdm": 1, "kit": "k", "schemaVersion": 1, "root": "Doc", "types": refused["types"] });
        assert!(Schema::parse(&schema.to_string()).is_err(), "{}", refused["why"]);
    }
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
    assert_eq!(described["types"]["SlideFile"]["fields"]["raw"], json!({ "kind": "json", "optional": true, "readOnly": true }));
    assert!(described["types"]["SlideFile"]["fields"]["title"].get("readOnly").is_none());
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

/// A `set` or `create` that writes a reference names an object that exists (`not-found`
/// otherwise, with what to give instead, KHP A48): the shared fixtures `fixtures/refs.json`,
/// which `@kition/kdm` runs too, messages included. Before, a batch stored any id, and an agent's
/// guess became a dangling reference the kit dropped or repaired.
#[test]
fn references_name_objects_that_exist() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/refs.json")).unwrap();
    let mut replica = replica_of(&fixture["schema"].to_string());
    for (index, step) in fixture["steps"].as_array().unwrap().iter().enumerate() {
        let before = replica.state_hash().unwrap();
        match (batch::run(&mut ReplicaTarget(&mut replica), &step["request"]), &step["error"]) {
            (Err(error), expected) if !expected.is_null() => {
                assert_eq!(json!({ "code": error.code.as_str(), "index": error.index, "message": error.message }), *expected, "step {index}");
                assert_eq!(replica.state_hash().unwrap(), before, "step {index} failed but changed the document");
            }
            (Ok(answer), Value::Null) => assert_eq!(answer, step["result"], "step {index}"),
            (answer, _) => panic!("step {index} answered {answer:?}"),
        }
    }
}

#[test]
fn deletion_cascades_through_owned_refs_lists_and_maps() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/delete-owned.json")).unwrap();
    let mut replica = replica_of(&fixture["schema"].to_string());
    batch::run(&mut ReplicaTarget(&mut replica), &fixture["setup"]).unwrap();
    let version = replica.version();
    batch::run(&mut ReplicaTarget(&mut replica), &fixture["edit"]).unwrap();
    let receipt = replica.changes_since(&version).unwrap().to_json();
    let deleted: Vec<_> = receipt["deleted"].as_array().unwrap().iter().map(|item| item["id"].clone()).collect();
    assert_eq!(json!(deleted), fixture["deleted"], "{receipt}");
    let state = replica.state_json().unwrap();
    assert_eq!(json!(state["objects"].as_object().unwrap().keys().collect::<Vec<_>>()), fixture["remaining"]);
    assert!(replica.undo().unwrap());
    assert!(replica.exists(&ObjectId::from_string("prop")), "the cascade is one undo step");
}

#[test]
fn a_read_only_owned_descendant_refuses_the_whole_deletion() {
    let mut fixture: Value = serde_json::from_str(include_str!("fixtures/delete-owned.json")).unwrap();
    let mut replica = replica_of(&fixture["schema"].to_string());
    batch::run(&mut ReplicaTarget(&mut replica), &fixture["setup"]).unwrap();
    fixture["schema"]["types"]["Prop"]["readOnly"] = json!(true);
    let mut replica =
        Replica::load(Arc::new(Schema::parse(&fixture["schema"].to_string()).unwrap()), &replica.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    let before = replica.state_hash().unwrap();
    assert_eq!(batch::run(&mut ReplicaTarget(&mut replica), &fixture["edit"]).unwrap_err().code, BatchErrorCode::ReadOnly);
    assert_eq!(replica.state_hash().unwrap(), before);
}

#[test]
fn numeric_limits_refuse_invalid_batches_atomically() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/numeric-limits.json")).unwrap();
    let mut replica = replica_of(&fixture["schema"].to_string());
    batch::run(
        &mut ReplicaTarget(&mut replica),
        &json!({ "ops": [{ "op": "create", "type": "Image", "id": "image", "fields": { "opacity": 0, "level": 0 } }] }),
    )
    .unwrap();
    let described = batch::describe(&replica);
    for key in ["minimum", "maximum", "multipleOf"] {
        assert_eq!(described["types"]["Image"]["fields"]["opacity"][key], fixture["schema"]["types"]["Image"]["fields"]["opacity"][key]);
    }
    for (field, valid, invalid) in [("opacity", "valid", "invalid"), ("level", "integers", "invalidIntegers")] {
        for value in fixture[valid].as_array().unwrap() {
            batch::run(&mut ReplicaTarget(&mut replica), &json!({ "ops": [{ "op": "set", "target": "root", "field": field, "value": value }] })).unwrap();
        }
        for value in fixture[invalid].as_array().unwrap() {
            let before = replica.state_hash().unwrap();
            let failed = batch::run(
                &mut ReplicaTarget(&mut replica),
                &json!({ "ops": [
                { "op": "set", "target": "root", "field": "level", "value": 0 },
                { "op": "set", "target": "root", "field": field, "value": value }
            ] }),
            )
            .unwrap_err();
            assert_eq!(failed.code, BatchErrorCode::InvalidValue, "{field}: {value}");
            assert_eq!(replica.state_hash().unwrap(), before);
        }
    }
}

#[test]
fn boolean_field_labels_are_exposed_by_the_model() {
    let replica = replica_of(include_str!("fixtures/boolean-labels.json"));
    assert_eq!(batch::describe(&replica)["types"]["Image"]["fields"]["isClipped"]["label"], "clipped");
}

#[test]
fn json_member_limits_validate_path_and_whole_value_writes() {
    let schema = r#"{"kdm":1,"kit":"kit.limits","schemaVersion":1,"root":"Image","types":{"Image":{"fields":{
        "data":{"kind":"json","members":{"roughness":{"minimum":0,"maximum":1,"multipleOf":0.1}}},
        "weight":{"kind":"json","minimum":0,"maximum":1}
    }}}}"#;
    let mut replica = replica_of(schema);
    batch::run(
        &mut ReplicaTarget(&mut replica),
        &json!({"ops":[{"op":"create","type":"Image","id":"image","fields":{"data":{"roughness":0.5},"weight":0.5}}]}),
    )
    .unwrap();
    assert_eq!(batch::describe(&replica)["types"]["Image"]["fields"]["data"]["members"]["roughness"]["maximum"], 1);
    for (field, value) in [
        ("data.roughness", json!(2)),
        ("data.roughness", json!(0.15)),
        ("data", json!({"roughness":-1})),
        ("data", json!({"roughness":"bad"})),
        ("weight", json!(2)),
    ] {
        let before = replica.state_hash().unwrap();
        assert_eq!(
            batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"set","target":"root","field":field,"value":value}]})).unwrap_err().code,
            BatchErrorCode::InvalidValue
        );
        assert_eq!(replica.state_hash().unwrap(), before);
    }
    batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"set","target":"root","field":"data.roughness","value":0.3}]})).unwrap();
}
