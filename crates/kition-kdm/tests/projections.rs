// Copied from kition-sdk crates/kition-kdm/tests/projections.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use kition_kdm::Schema;
use kition_kdm::batch::{self, BatchError, BatchTarget};
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Tx};
use serde_json::Value;
use serde_json::json;

struct Lines(Replica);

#[test]
fn nested_projected_trees_and_owning_refs_are_read_without_replica_storage() {
    let schema=Schema::parse(&json!({"kdm":1,"kit":"kit.nested","schemaVersion":1,"root":"Document","types":{
        "Document":{"fields":{"sections":{"kind":"tree","of":"Section"}}},
        "Section":{"projected":true,"fields":{"name":{"kind":"string"},"body":{"kind":"ref","of":"Body","owns":true}},"projectedOps":{"create":{"command":"section.create"}}},
        "Body":{"projected":true,"fields":{"text":{"kind":"string"}},"projectedOps":{"create":{"command":"body.create"},"ref.set":{"command":"body.attach","params":{"id":"target","in":"in"}}}}
    }}).to_string()).expect("tree and owning-ref projection schema");
    let mut replica = Replica::create(std::sync::Arc::new(schema), DocId::new(), ActorId::random()).unwrap();
    replica.transact(&Origin::agent("test"), |tx| tx.create_with_id("Document", &ObjectId::from_string("doc"), Default::default())).unwrap();
    let projected: Vec<kition_kdm::projection::ProjectedObject> = serde_json::from_value(json!([
        {"id":"section","type":"Section","fields":{"name":"Parent"},"at":{"parent":"doc","field":"sections","index":0}},
        {"id":"nested","type":"Section","fields":{"name":"Child"},"at":{"parent":"doc","field":"sections","node":"section","index":0}},
        {"id":"body","type":"Body","fields":{"text":"Contents"},"at":{"parent":"nested","field":"body"}}
    ]))
    .unwrap();
    let view = kition_kdm::projection::View::read(&replica, projected.clone()).unwrap();
    assert_eq!(view.state["objects"]["doc"]["sections"], json!([{"object":"section","children":[{"object":"nested","children":[]}]}]));
    assert_eq!(view.state["objects"]["nested"]["body"], "body");
    assert_eq!(view.state["objects"]["section"]["body"], Value::Null);
    assert!(replica.objects_of_type("Section").is_empty());
    for (ty, destination) in [("Section", "root.sections"), ("Body", "nested.body")] {
        assert!(
            kition_kdm::projection::route(replica.schema(), &view, "doc", &json!({"op":"create","type":ty,"in":destination,"fields":{}})).unwrap().is_some()
        );
    }
    let attach =
        kition_kdm::projection::route(replica.schema(), &view, "doc", &json!({"op":"set","target":"section","field":"body","value":"body"})).unwrap().unwrap();
    assert_eq!(attach.command, "body.attach");
    assert_eq!(attach.params, json!({"id":"body","in":"section.body"}));
    let mut cycle = projected.clone();
    cycle[0].at.as_mut().unwrap().node = Some("nested".into());
    assert!(kition_kdm::projection::View::read(&replica, cycle).is_err());
    let mut duplicate = projected.clone();
    let mut second = projected[2].clone();
    second.id = "second".into();
    duplicate.push(second);
    assert!(kition_kdm::projection::View::read(&replica, duplicate).is_err());
}

#[test]
fn projected_ownership_accepts_trees_and_owning_refs() {
    let target = Lines::new();
    let schema = json!({"kdm":1,"kit":"kit.projected","schemaVersion":1,"root":"Document","types":batch::describe(&target.0)["types"]});
    for field in [json!({"kind":"tree","of":"Line"}), json!({"kind":"ref","of":"Line","owns":true})] {
        let mut invalid = schema.clone();
        invalid["types"]["Document"]["fields"]["lines"] = field;
        assert!(Schema::parse(&invalid.to_string()).is_ok(), "projected containment must support tree and owning-ref fields");
    }
}

#[test]
fn projected_create_respects_read_only_destinations() {
    let target = Lines::new();
    let mut schema = target.0.schema().clone();
    schema.types.get_mut("Document").unwrap().fields.get_mut("lines").unwrap().read_only = true;
    let view = kition_kdm::projection::View::read(&target.0, target.projections()).unwrap();
    let error = kition_kdm::projection::route(&schema, &view, "doc", &json!({"op":"create","type":"Line","in":"root.lines","fields":{"text":"New"}}))
        .err()
        .expect("read-only destination must refuse");
    assert_eq!(error.code, batch::BatchErrorCode::ReadOnly);
}

#[test]
fn projected_types_cannot_enter_through_snapshots_or_remote_changes() {
    let mut target = Lines::new();
    let projected = std::sync::Arc::new(target.0.schema().clone());
    let mut stored = target.0.schema().clone();
    stored.types.get_mut("Line").unwrap().projected = false;
    stored.types.get_mut("Line").unwrap().projected_ops.clear();
    let mut writer = Replica::load(std::sync::Arc::new(stored), &target.0.snapshot().unwrap(), ActorId::random()).unwrap();
    writer
        .transact(&Origin::agent("writer"), |tx| {
            tx.create_with_id("Line", &ObjectId::from_string("forged"), json!({"text":"stored"}).as_object().unwrap().clone())?;
            Ok(())
        })
        .unwrap();
    assert!(Replica::load(projected, &writer.snapshot().unwrap(), ActorId::random()).is_err());
    let before = target.0.state_json().unwrap();
    assert!(target.0.import_changes(&writer.export_changes(&target.0.version()).unwrap()).is_err());
    assert_eq!(target.0.state_json().unwrap(), before);
}

impl Lines {
    fn new() -> Self {
        let schema = Schema::parse(
            &json!({"kdm":1,"kit":"kit.projected","schemaVersion":1,"root":"Document","types":{
                "Document":{"fields":{"text":{"kind":"string"},"lines":{"kind":"list","of":"Line"}}},
                "Line":{"projected":true,"label":"text","text":"text","fields":{"text":{"kind":"string"}},"projectedOps":{
                    "set.text":{"command":"line.set","params":{"id":"target","text":"value"}},
                    "create":{"command":"line.create","params":{"id":"id","text":"fields.text","at":"at"}},
                    "delete":{"command":"line.delete","params":{"id":"target"}},
                    "list.move":{"command":"line.move","params":{"id":"target","to":"to"}}
                }}
            }})
            .to_string(),
        )
        .unwrap();
        let mut replica = Replica::create(std::sync::Arc::new(schema), DocId::new(), ActorId::random()).unwrap();
        replica
            .transact(&Origin::agent("test"), |tx| {
                tx.create_with_id("Document", &ObjectId::from_string("doc"), json!({"text":"a=Alpha\nb=Beta"}).as_object().unwrap().clone())?;
                Ok(())
            })
            .unwrap();
        Self(replica)
    }

    fn projections(&self) -> Vec<kition_kdm::projection::ProjectedObject> {
        self.0
            .get(&ObjectId::from_string("doc"), "text")
            .unwrap()
            .as_str()
            .unwrap()
            .lines()
            .enumerate()
            .map(|(index, line)| {
                let (id, text) = line.split_once('=').unwrap();
                serde_json::from_value(json!({"id":id,"type":"Line","fields":{"text":text},"at":{"parent":"doc","field":"lines","index":index}})).unwrap()
            })
            .collect()
    }
}

impl BatchTarget for Lines {
    fn projected_objects(&mut self) -> Result<Vec<kition_kdm::projection::ProjectedObject>, BatchError> {
        Ok(self.projections())
    }
    fn replica(&mut self) -> Result<&Replica, BatchError> {
        Ok(&self.0)
    }
    fn transact(&mut self, origin: &Origin, write: &mut dyn FnMut(&mut Tx<'_>) -> Result<(), BatchError>) -> Result<(), BatchError> {
        batch::transact_replica(&mut self.0, origin, write)
    }
    fn command(&mut self, id: &str, params: Value, origin: &Origin) -> Result<Value, String> {
        let mut lines = self.projections();
        let target = params["id"].as_str().unwrap_or("new");
        let at = lines.iter().position(|line| line.id == target);
        match id {
            "line.set" => {
                lines[at.ok_or("no line")?].fields.insert("text".into(), params["text"].clone());
            }
            "line.delete" => {
                lines.remove(at.ok_or("no line")?);
            }
            "line.create" => {
                lines.insert(
                    params["at"].as_u64().map_or(lines.len(), |at| at as usize),
                    serde_json::from_value(json!({"id":target,"type":"Line","fields":{"text":params["text"]}})).unwrap(),
                );
            }
            "line.move" => {
                let line = lines.remove(at.ok_or("no line")?);
                lines.insert(params["to"].as_u64().ok_or("missing to")? as usize, line);
            }
            _ => return Err("undeclared command".into()),
        }
        let text = lines.iter().map(|line| format!("{}={}", line.id, line.fields["text"].as_str().unwrap())).collect::<Vec<_>>().join("\n");
        self.0.transact(origin, |tx| tx.set(&ObjectId::from_string("doc"), "text", json!(text))).map_err(|e| e.to_string())?;
        Ok(json!({"id":target}))
    }
}

#[test]
fn batch_reads_projected_objects_and_virtual_membership() {
    let mut target = Lines::new();
    let read = batch::run(&mut target, &json!({"ops":[],"objects":true,"load":[{"target":"root"}]})).unwrap();
    assert_eq!(read["loaded"][0]["fields"]["lines"], json!(["a", "b"]));
    let read = batch::run(&mut target, &json!({"ops":[],"load":[{"target":"a"}]})).unwrap();
    assert_eq!(read["loaded"][0]["fields"]["text"], "Alpha");
    assert_eq!(read["loaded"][0]["projected"], true);
    assert!(target.0.objects_of_type("Line").is_empty());
}

#[test]
fn projected_edits_use_commands_and_bind_created_ids() {
    let mut moving = Lines::new();
    batch::run(&mut moving, &json!({"ops":[{"op":"create","type":"Line","id":"c","fields":{"text":"Third"}}]})).unwrap();
    let before_move = kition_kdm::projection::View::read(&moving.0, moving.projections()).unwrap().state;
    batch::run(&mut moving, &json!({"ops":[{"op":"list.move","target":"root","field":"lines","from":0,"to":2}]})).unwrap();
    let after_move = kition_kdm::projection::View::read(&moving.0, moving.projections()).unwrap().state;
    let move_diff = kition_kdm::diff::diff_states(&before_move, &after_move).to_json();
    let mut target = Lines::new();
    let before = kition_kdm::projection::View::read(&target.0, target.projections()).unwrap().state;
    let answer = batch::run(
        &mut target,
        &json!({"ops":[
        {"op":"set","target":"a","field":"text","value":"Edited"},
        {"op":"create","type":"Line","id":"c","ref":"$line","in":"root.lines","fields":{"text":"Created"}},
        {"op":"set","target":"$line","field":"text","value":"Bound"},
        {"op":"list.move","target":"root","field":"lines","from":2,"to":0},
        {"op":"delete","target":"b"}
    ],"load":[{"target":"$line"},{"target":"root"}]}),
    )
    .unwrap();
    assert_eq!(answer["refs"]["$line"], "c");
    assert_eq!(answer["loaded"][0]["fields"]["text"], "Bound");
    assert_eq!(answer["loaded"][1]["fields"]["lines"], json!(["c", "a"]));
    let after = kition_kdm::projection::View::read(&target.0, target.projections()).unwrap().state;
    let diff = kition_kdm::diff::diff_states(&before, &after).to_json();
    assert!(diff["created"].as_array().unwrap().iter().any(|item| item["id"] == "c"), "{diff}");
    assert!(diff["deleted"].as_array().unwrap().iter().any(|item| item["id"] == "b"), "{diff}");
    assert!(diff["changed"].as_array().unwrap().iter().any(|item| item["id"] == "a"), "{diff}");
    assert!(move_diff["moved"].as_array().unwrap().iter().any(|item| item["id"] == "a"), "{move_diff}");
    assert!(target.0.objects_of_type("Line").is_empty());
    assert_eq!(target.0.state_json().unwrap()["objects"]["doc"]["lines"], json!([]));
}

#[test]
fn incomplete_or_ambiguous_projections_and_unmapped_writes_refuse() {
    let mut target = Lines::new();
    let before = target.0.state_json().unwrap();
    let error =
        batch::run(&mut target, &json!({"ops":[{"op":"text.mark","target":"a","field":"text","start":0,"end":1,"key":"bold","value":true}]})).unwrap_err();
    assert_eq!(error.code, batch::BatchErrorCode::ReadOnly);
    assert_eq!(before, target.0.state_json().unwrap());
    for change in ["duplicate", "missing-field", "gap", "shadow", "wrong-type", "wrong-container"] {
        let mut objects = target.projections();
        match change {
            "duplicate" => objects.push(objects[0].clone()),
            "missing-field" => objects[0].fields.clear(),
            "gap" => objects[0].at.as_mut().unwrap().index = 9,
            "shadow" => objects[0].id = "doc".into(),
            "wrong-type" => objects[0].ty = "Document".into(),
            _ => objects[0].at.as_mut().unwrap().field = "text".into(),
        }
        assert!(kition_kdm::projection::View::read(&target.0, objects).is_err(), "{change}");
    }
}

#[test]
fn projected_types_are_declared_without_storing_their_objects() {
    let schema = json!({"kdm":1,"kit":"kit.projected","schemaVersion":1,"root":"Document","types":{
        "Document":{"fields":{"text":{"kind":"string"},"lines":{"kind":"list","of":"Line"}}},
        "Line":{"projected":true,"fields":{"text":{"kind":"string"}},"projectedOps":{
            "set.text":{"command":"line.set","params":{"id":"target","text":"value"}}
        }}
    }});
    let parsed = Schema::parse(&schema.to_string());
    assert!(parsed.is_ok(), "a kit can declare computed types: {parsed:?}");
    let schema = parsed.unwrap();
    let mut replica = kition_kdm::Replica::create(std::sync::Arc::new(schema), kition_kdm::DocId::new(), kition_kdm::ActorId::random()).unwrap();
    let before = replica.state_json().unwrap();
    let error =
        replica.transact(&Origin::agent("test"), |tx| tx.create("Line", json!({"text":"Never stored"}).as_object().unwrap().clone()).map(|_| ())).unwrap_err();
    assert!(error.to_string().contains("never stored"), "{error}");
    assert_eq!(before, replica.state_json().unwrap());
    assert_eq!(kition_kdm::batch::describe(&replica)["types"]["Line"]["projected"], true);
}
