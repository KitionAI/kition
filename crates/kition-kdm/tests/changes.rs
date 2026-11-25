// Copied from kition-sdk crates/kition-kdm/tests/changes.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Change sets: the shared fixtures `fixtures/changes.json`, which `@kition/kdm`
//! runs too. Each case's expected change set is both the comparison of the whole states
//! (`diff_states`, the reference) and the receipt `Replica::changes_since` reads from the objects
//! the edit touched (the cheap path), so the two never drift apart.

use std::sync::Arc;

use kition_kdm::batch::{self, ReplicaTarget};
use kition_kdm::diff::diff_states;
use kition_kdm::{ActorId, DocId, KdmError, Replica, Schema};
use serde_json::{Value, json};

#[test]
fn deleted_json_basis_retains_conditional_predicate_inputs_privately() {
    let schema = Schema::parse(r#"{"kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Item","types":{"Item":{"fields":{"data":{"kind":"json"}}}}}"#).unwrap();
    let before = json!({"objects":{"item":{"$type":"Item","data":{"owner":"selected","bytes":"observed"}}}});
    let diff = diff_states(&before, &json!({"objects":{}}));
    assert_eq!(diff.to_recorded_json(&schema)["deleted"][0]["$was"]["data"], before["objects"]["item"]["data"]);
    assert!(diff.to_json()["deleted"][0].get("$was").is_none());
}

#[test]
fn located_text_spans_bound_unicode_deletions_replacements_and_total_bytes() {
    for (before, after, offset, removed, inserted) in [
        (format!("{}target{}", "x".repeat(5_000), "y".repeat(5_000)), format!("{}updated{}", "x".repeat(5_000), "y".repeat(5_000)), 5_000, "target", "updated"),
        (format!("{}erase{}", "\u{1f600}".repeat(100), "z".repeat(100)), format!("{}{}", "\u{1f600}".repeat(100), "z".repeat(100)), 100, "erase", ""),
    ] {
        let a = json!({"objects":{"root":{"$type":"Doc","body":before}}});
        let b = json!({"objects":{"root":{"$type":"Doc","body":after}}});
        let diff = diff_states(&a, &b).without_texts();
        let located = diff.to_located_json();
        let span = &located["changed"][0]["edits"][0]["span"];
        assert_eq!(span["offset"], offset);
        assert_eq!(span["removed"], removed);
        assert_eq!(span["inserted"], inserted);
        assert_eq!(span["complete"], true);
        assert!(located.to_string().len() < 2_048);
        assert!(diff.to_json()["changed"][0]["edits"][0].get("span").is_none());
    }
    let span = kition_kdm::diff::text_span(&"\u{0000}".repeat(10_000), &"\u{0001}".repeat(10_000)).unwrap();
    assert_eq!(span["removedLength"], 10_000);
    assert_eq!(span["complete"], false);
    assert!(span.to_string().len() < 2_048);
    let fields = (0..500).map(|i| (format!("f{i}"), json!("x".repeat(1_000)))).chain([("$type".into(), json!("Doc"))]).collect::<serde_json::Map<_, _>>();
    let mut after = fields.clone();
    for (field, value) in &mut after {
        if field != "$type" {
            *value = json!("y".repeat(1_000));
        }
    }
    let located = diff_states(&json!({"objects":{"root":fields}}), &json!({"objects":{"root":after}})).to_located_json();
    let spans = located["changed"][0]["edits"].as_array().unwrap().iter().filter_map(|edit| edit.get("span"));
    assert!(spans.map(|span| span.to_string().len()).sum::<usize>() <= 65_536);
    assert!(located["changed"][0]["edits"].as_array().unwrap().iter().any(|edit| edit["spansTruncated"] == true));
}

#[test]
fn map_member_footprints_preserve_keys_and_do_not_compact_mixed_values() {
    let array = json!({"changed":[{"id":"clip","fields":["effects"],"edits":(0..5).map(|i|json!({"field":format!("effects.{i}.amount"),"before":i,"after":i+1})).collect::<Vec<_>>()}]});
    assert_eq!(kition_kdm::footprint::with_footprint(&array, &|_, _| None), array);
    let before = (0..200).map(|i| (format!("entry-{i}"), json!({"offset":i,"label":"same"}))).collect::<serde_json::Map<_, _>>();
    let after = (0..200).map(|i| (format!("entry-{i}"), json!({"offset":i+3,"label":"same"}))).collect::<serde_json::Map<_, _>>();
    let changes = json!({"created":[],"changed":[{"id":"root","type":"Doc","fields":["overlay"],"edits":[{"field":"overlay","before":before,"after":after}]}],"deleted":[],"moved":[]});
    let compact = kition_kdm::footprint::with_footprint(&changes, &|_, _| None);
    let edit = &compact["changed"][0]["edits"][0];
    assert_eq!(edit["field"], "overlay.*.offset");
    assert_eq!(edit["keys"].as_array().unwrap().len(), 200);
    assert_eq!(edit["shift"]["by"], 3);
    assert!(compact.to_string().len() < 4_096);
    let mut mixed = changes;
    mixed["changed"][0]["edits"][0]["after"]["entry-0"]["label"] = json!("changed");
    assert_eq!(kition_kdm::footprint::with_footprint(&mixed, &|_, _| None), mixed);
    let keyed = json!({"changed":[{"id":"root","fields":["overlay"],"edits":[{"field":"overlay",
        "before":{"0":{"x":1},"1":{"x":2},"2":{"x":3},"3":{"x":4}},
        "after":{"0":{"x":2},"1":{"x":3},"2":{"x":4},"3":{"x":5}}}]}]});
    assert_eq!(kition_kdm::footprint::with_footprint(&keyed, &|_, _| None)["changed"][0]["edits"][0]["keys"], json!(["0", "1", "2", "3"]));
}

#[test]
fn batch_inventory_includes_detached_objects_without_writing() {
    let mut replica = set_up(&fixture());
    let created =
        batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[{"op":"create","type":"Shape","ref":"$detached","fields":{"label":"detached","x":0}}]}))
            .unwrap();
    let id = created["refs"]["$detached"].clone();
    let version = replica.version();
    let inventory = batch::run(&mut ReplicaTarget(&mut replica), &json!({"ops":[],"objects":true})).unwrap();
    assert!(inventory["objects"].as_array().expect("complete inventory").iter().any(|object| object["id"] == id && object["type"] == "Shape"));
    assert_eq!(replica.version(), version);
}

#[test]
fn private_text_history_keeps_long_text_marks_and_limits() {
    let schema = Schema::parse(r#"{"kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Doc","types":{"Doc":{"fields":{"text":{"kind":"text"}}}}}"#).unwrap();
    let text = "x".repeat(10_000);
    for before in [json!(text), json!([{"insert":text,"attributes":{"bold":true}}])] {
        let a = json!({"objects":{"story":{"$type":"Doc","text":before}}});
        let b = json!({"objects":{"story":{"$type":"Doc","text":[{"insert":text,"attributes":{"italic":true}}]}}});
        let diff = diff_states(&a, &b).without_texts();
        assert_eq!(diff.to_recorded_json(&schema)["$text"]["story"]["text"], before);
        assert!(diff.to_json().get("$text").is_none());
        assert_eq!(diff.to_json()["changed"][0]["edits"][0]["before"]["length"], 10_000);
    }
    let a = json!({"objects":{"story":{"$type":"Doc","text":"x".repeat(1_048_577)}}});
    let b = json!({"objects":{"story":{"$type":"Doc","text":"short"}}});
    assert!(diff_states(&a, &b).to_recorded_json(&schema).get("$text").is_none());
}

#[test]
fn identical_assignment_footprints_preserve_all_ids_and_full_values() {
    let values: Vec<Value> = serde_json::from_str(include_str!("fixtures/assignment-values.json")).unwrap();
    for after in values {
        let changed = (0..4)
            .map(|i| json!({"id":format!("r{i}"),"type":"Record","fields":["value"],"edits":[{"field":"value","before":format!("Before {i}"),"after":after}]}))
            .collect::<Vec<_>>();
        let input = json!({"created":[],"changed":changed,"moved":[],"deleted":[]});
        let output = kition_kdm::footprint::with_footprint(&input, &|_, _| None);
        assert_eq!(output["changed"], json!([]));
        assert_eq!(output["footprint"], json!([{"ids":["r0","r1","r2","r3"],"edits":[{"field":"value","after":after}]}]));
        let mut incomplete = input.clone();
        incomplete["changed"][0]["edits"][0].as_object_mut().unwrap().remove("after");
        assert_eq!(kition_kdm::footprint::with_footprint(&incomplete, &|_, _| None), incomplete, "missing values cannot form a complete assignment group");
    }
}

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/changes.json")).unwrap()
}

#[test]
fn blob_basis_values_keep_the_reference_in_receipts_rereads_and_deletions() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/blob-basis.json")).unwrap();
    let mut replica = set_up(&fixture);
    kition_kdm::testing::number_tool_ids(&mut replica).unwrap();
    let before = replica.state_json().unwrap();
    let version = replica.version();
    batch::run(&mut ReplicaTarget(&mut replica), &fixture["edit"]).unwrap();
    let receipt = replica.changes_since(&version).unwrap().to_json();
    assert_eq!(receipt["changed"][0]["edits"][0]["before"], fixture["before"]);
    let reread = kition_kdm::reread::diff_read_again(replica.schema(), &before, &replica.state_json().unwrap());
    assert_eq!(reread.to_json()["changed"][0]["edits"][0]["before"], fixture["before"]);
    let version = replica.version();
    batch::run(&mut ReplicaTarget(&mut replica), &json!({ "ops": [{ "op": "delete", "target": "image" }] })).unwrap();
    assert_eq!(replica.changes_since(&version).unwrap().to_json()["changed"][0]["edits"][0]["before"]["mask"], fixture["after"]);
    let before = json!({ "objects": { "image": { "$type": "Image", "mask": fixture["before"] } } });
    let deleted = diff_states(&before, &json!({ "objects": {} })).to_recorded_json(replica.schema());
    assert_eq!(deleted["deleted"][0]["$was"]["mask"], fixture["before"]);
}

fn set_up(fixture: &Value) -> Replica {
    let schema = Arc::new(Schema::parse(&fixture["schema"].to_string()).unwrap());
    let mut replica = Replica::create(schema, DocId::parse(fixture["docId"].as_str().unwrap()).unwrap(), ActorId::from_u64(1).unwrap()).unwrap();
    batch::run(&mut ReplicaTarget(&mut replica), &fixture["setup"]).unwrap();
    replica
}

#[test]
fn every_kind_of_change_is_described_by_both_paths_alike() {
    let fixture = fixture();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut replica = set_up(&fixture);
        let (version, before) = (replica.version(), replica.state_json().unwrap());
        batch::run(&mut ReplicaTarget(&mut replica), &case["edit"]).unwrap_or_else(|error| panic!("{name}: {error}"));
        let mut reference = diff_states(&before, &replica.state_json().unwrap()).to_json();
        assert!(reference.as_object_mut().unwrap().remove("texts").is_some(), "{name}: a comparison has its texts");
        assert_eq!(reference, case["expected"], "{name}: the comparison of the whole states");
        let receipt = replica.changes_since(&version).unwrap();
        assert_eq!(receipt.to_json(), case["expected"], "{name}: the receipt");
        assert_eq!(receipt.is_empty(), name == "no-effect", "{name}");
        assert_eq!(serde_json::to_string(&receipt.to_json()).unwrap(), serde_json::to_string(&replica.changes_since(&version).unwrap().to_json()).unwrap());
    }
}

/// `fixtures/leaf-edits.json`, which `@kition/kdm` runs too: a change of a `map`
/// field told by key, of a `json` value down to its changed leaves when that is shorter.
#[test]
fn a_map_or_json_change_is_told_where_it_changed() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/leaf-edits.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut replica = set_up(&fixture);
        let version = replica.version();
        batch::run(&mut ReplicaTarget(&mut replica), &case["edit"]).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(replica.changes_since(&version).unwrap().to_json(), case["expected"], "{name}: the receipt");
    }
}

/// `fixtures/path-names.json`, which `@kition/kdm` runs too: an edit inside a
/// held object names its place in the kit's words (`named`) where the types on the way declare a
/// `pathName`.
#[test]
fn an_edit_inside_named_objects_says_where_in_the_kits_words() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/path-names.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut replica = set_up(&fixture);
        kition_kdm::testing::number_tool_ids(&mut replica).unwrap();
        let version = replica.version();
        batch::run(&mut ReplicaTarget(&mut replica), &case["edit"]).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(replica.changes_since(&version).unwrap().to_json(), case["expected"], "{name}: the receipt");
    }
}

#[test]
fn a_receipt_needs_a_version_the_replica_holds() {
    let fixture = fixture();
    let replica = set_up(&fixture);
    // A replica loaded from this one's snapshot holds the same changes: the same version.
    let other = Replica::load(Arc::new(replica.schema().clone()), &replica.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    let mut edited = set_up(&fixture);
    batch::run(&mut ReplicaTarget(&mut edited), &fixture["cases"][1]["edit"]).unwrap();
    assert!(matches!(replica.changes_since(&edited.version()), Err(KdmError::HistoryMissing(_))), "a version past this replica's");
    assert!(replica.changes_since(&other.version()).unwrap().is_empty(), "the same changes are the same version");
    assert!(replica.changes_since(&replica.version()).unwrap().is_empty());
}

/// A receipt names objects as the tool interface does (OM9): by their tool ids where the schema
/// declares them, positions' parents too.
#[test]
fn a_receipt_names_objects_by_their_tool_ids() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/tool-ids.json")).unwrap();
    let schema = Arc::new(Schema::parse(&fixture["schema"].to_string()).unwrap());
    let mut replica = Replica::create(schema, DocId::new(), ActorId::from_u64(1).unwrap()).unwrap();
    let request = serde_json::json!({ "ops": [
        { "op": "create", "type": "Doc", "id": "doc" },
        { "op": "create", "type": "Frame", "id": "f1", "in": "doc.frames", "fields": { "name": "One" } },
        { "op": "create", "type": "Frame", "id": "f2", "in": "doc.frames", "fields": { "name": "Two" } }
    ] });
    batch::run(&mut ReplicaTarget(&mut replica), &request).unwrap();
    kition_kdm::testing::number_tool_ids(&mut replica).unwrap();
    let version = replica.version();
    let edit = serde_json::json!({ "ops": [
        { "op": "set", "target": "frame:2", "field": "name", "value": "Second" },
        { "op": "list.move", "target": "doc", "field": "frames", "from": 1, "to": 0 }
    ] });
    batch::run(&mut ReplicaTarget(&mut replica), &edit).unwrap();
    let receipt = replica.changes_since(&version).unwrap().to_json();
    assert_eq!(receipt["changed"][1]["id"], "frame:2", "{receipt}");
    assert_eq!(receipt["changed"][1]["edits"], serde_json::json!([{ "field": "name", "before": "Two", "after": "Second" }]));
    assert_eq!(receipt["moved"][0]["id"], "frame:2", "{receipt}");
    assert_eq!(receipt["moved"][0]["to"], serde_json::json!({ "parent": "doc", "field": "frames", "index": 0 }));
}

/// A change inside an object without a tool id is told as a change of the nearest object holding
/// it that has one, at the path from it, through list and tree fields and refs that
/// own: `fixtures/attribution.json`, which `@kition/kdm` runs too. The receipt and the comparison
/// of the whole states named by tool ids agree, and no object id of a held object appears.
#[test]
fn a_change_inside_an_object_is_told_as_a_change_of_its_holder() {
    use kition_kdm::tool_ids::ToolIds;
    let fixture: Value = serde_json::from_str(include_str!("fixtures/attribution.json")).unwrap();
    let schema = Arc::new(Schema::parse(&fixture["schema"].to_string()).unwrap());
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut replica =
            Replica::create(Arc::clone(&schema), DocId::parse(fixture["docId"].as_str().unwrap()).unwrap(), ActorId::from_u64(1).unwrap()).unwrap();
        batch::run(&mut ReplicaTarget(&mut replica), &fixture["setup"]).unwrap();
        kition_kdm::testing::number_tool_ids(&mut replica).unwrap();
        let (version, before) = (replica.version(), replica.state_json().unwrap());
        batch::run(&mut ReplicaTarget(&mut replica), &case["edit"]).unwrap_or_else(|error| panic!("{name}: {error}"));
        kition_kdm::testing::number_tool_ids(&mut replica).unwrap();
        let after = replica.state_json().unwrap();
        let receipt = replica.changes_since(&version).unwrap().to_json();
        assert_eq!(receipt, case["expected"], "{name}: the receipt\n{}", serde_json::to_string(&receipt).unwrap());
        let (was, now) = (ToolIds::of_state(&schema, &before), ToolIds::of_state(&schema, &after));
        let mut reference = diff_states(&before, &after).with_tool_ids(&schema, &was, &now).to_json();
        let texts = reference.as_object_mut().unwrap().remove("texts").unwrap();
        assert_eq!(reference, case["expected"], "{name}: the comparison of the whole states");
        if let Some(expected) = case.get("texts") {
            assert_eq!(&texts, expected, "{name}: the comparison's texts\n{}", serde_json::to_string(&texts).unwrap());
        }
        let shown = receipt.to_string();
        for internal in ["\"b1\"", "\"b2\"", "\"b3\"", "\"p1\"", "\"p2\"", "\"p3\"", "\"p4\"", "\"p5\"", "\"p6\"", "\"c1\""] {
            assert!(!shown.contains(internal), "{name}: {internal} is held by an object with a tool id: {shown}");
        }
    }
}

/// Only a ref says it owns its object: list and tree fields always do.
#[test]
fn only_a_ref_field_takes_owns() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/attribution.json")).unwrap();
    for error in fixture["schemaErrors"].as_array().unwrap() {
        let mut schema = fixture["schema"].clone();
        schema["types"][error["type"].as_str().unwrap()]["fields"][error["field"].as_str().unwrap()] = error["def"].clone();
        let refused = Schema::parse(&schema.to_string()).unwrap_err();
        assert_eq!(refused.to_string(), error["message"].as_str().unwrap());
    }
}

/// A receipt names no object id an agent cannot use: a cell of a table whose rows and
/// columns are in lists is told at `table.cells.<row>:<column>` by their indexes, and a ref to a
/// layout no tool id names reads `{ unnamed: "Layout" }`, as `fixtures/usable-ids.json` says and
/// `@kition/kdm` answers too.
#[test]
fn a_receipt_names_cells_by_position_and_unnamed_refs_by_type() {
    use kition_kdm::tool_ids::ToolIds;
    let fixture: Value = serde_json::from_str(include_str!("fixtures/usable-ids.json")).unwrap();
    let schema = Arc::new(Schema::parse(&fixture["schema"].to_string()).unwrap());
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut replica =
            Replica::create(Arc::clone(&schema), DocId::parse(fixture["docId"].as_str().unwrap()).unwrap(), ActorId::from_u64(1).unwrap()).unwrap();
        batch::run(&mut ReplicaTarget(&mut replica), &fixture["setup"]).unwrap();
        kition_kdm::testing::number_tool_ids(&mut replica).unwrap();
        let (version, before) = (replica.version(), replica.state_json().unwrap());
        batch::run(&mut ReplicaTarget(&mut replica), &case["edit"]).unwrap_or_else(|error| panic!("{name}: {error}"));
        kition_kdm::testing::number_tool_ids(&mut replica).unwrap();
        let after = replica.state_json().unwrap();
        let receipt = replica.changes_since(&version).unwrap().to_json();
        assert_eq!(receipt, case["expected"], "{name}: the receipt\n{}", serde_json::to_string(&receipt).unwrap());
        let (was, now) = (ToolIds::of_state(&schema, &before), ToolIds::of_state(&schema, &after));
        let mut reference = diff_states(&before, &after).with_tool_ids(&schema, &was, &now).to_json();
        reference.as_object_mut().unwrap().remove("texts");
        assert_eq!(reference, case["expected"], "{name}: the comparison of the whole states");
    }
}

/// A map field declared `owns` holds the objects its values name, under their keys:
/// a change inside one is told as its holder's, at `<field>.<key>[.<member>]`, as
/// `fixtures/map-ownership.json` says and `@kition/kdm` answers too; a map without `owns` (the
/// table's `look`) holds nothing, so a change inside what it names keeps its object id.
#[test]
fn a_map_that_owns_holds_the_objects_its_values_name() {
    use kition_kdm::tool_ids::ToolIds;
    let fixture: Value = serde_json::from_str(include_str!("fixtures/map-ownership.json")).unwrap();
    let schema = Arc::new(Schema::parse(&fixture["schema"].to_string()).unwrap());
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut replica =
            Replica::create(Arc::clone(&schema), DocId::parse(fixture["docId"].as_str().unwrap()).unwrap(), ActorId::from_u64(1).unwrap()).unwrap();
        batch::run(&mut ReplicaTarget(&mut replica), &fixture["setup"]).unwrap();
        kition_kdm::testing::number_tool_ids(&mut replica).unwrap();
        let (version, before) = (replica.version(), replica.state_json().unwrap());
        batch::run(&mut ReplicaTarget(&mut replica), &case["edit"]).unwrap_or_else(|error| panic!("{name}: {error}"));
        kition_kdm::testing::number_tool_ids(&mut replica).unwrap();
        let after = replica.state_json().unwrap();
        let receipt = replica.changes_since(&version).unwrap().to_json();
        assert_eq!(receipt, case["expected"], "{name}: the receipt\n{}", serde_json::to_string(&receipt).unwrap());
        let (was, now) = (ToolIds::of_state(&schema, &before), ToolIds::of_state(&schema, &after));
        let mut reference = diff_states(&before, &after).with_tool_ids(&schema, &was, &now).to_json();
        reference.as_object_mut().unwrap().remove("texts");
        assert_eq!(reference, case["expected"], "{name}: the comparison of the whole states");
    }
    let mut replica = Replica::create(Arc::clone(&schema), DocId::parse(fixture["docId"].as_str().unwrap()).unwrap(), ActorId::from_u64(1).unwrap()).unwrap();
    batch::run(&mut ReplicaTarget(&mut replica), &fixture["setup"]).unwrap();
    kition_kdm::testing::number_tool_ids(&mut replica).unwrap();
    let version = replica.version();
    batch::run(&mut ReplicaTarget(&mut replica), &json!({ "ops": [{ "op": "text.set", "target": "p3", "field": "text", "text": "Still loose" }] })).unwrap();
    let receipt = replica.changes_since(&version).unwrap().to_json();
    assert_eq!(receipt["changed"][0]["id"], "p3", "a map without `owns` holds nothing: {receipt}");
    for error in fixture["schemaErrors"].as_array().unwrap() {
        let mut schema = fixture["schema"].clone();
        schema["types"][error["type"].as_str().unwrap()]["fields"][error["field"].as_str().unwrap()] = error["def"].clone();
        assert_eq!(Schema::parse(&schema.to_string()).unwrap_err().to_string(), error["message"].as_str().unwrap());
    }
}

/// A shift of many objects is stated once (`footprint`): the shared fixture
/// `fixtures/footprint.json`, which `@kition/kdm`'s `withFootprint` answers alike.
#[test]
fn a_shift_of_many_objects_is_stated_once() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/footprint.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let lists = &case["lists"];
        let items = |parent: &str, field: &str| -> Option<Vec<String>> {
            lists[format!("{parent}/{field}")].as_array().map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect())
        };
        let compact = kition_kdm::footprint::with_footprint(&case["changes"], &items);
        assert_eq!(compact, case["expected"], "{name}");
    }
}

/// `fixtures/batch-paths.json`, which `@kition/kdm` runs too: a batch's `set` and
/// `text.set` take `field` as a path from the target to a field of a held object, positional or in
/// the kit's words; the receipt names the change at that path, and what such a path cannot name is
/// refused, alike in both.
#[test]
fn a_set_takes_a_path_to_a_held_objects_field() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/batch-paths.json")).unwrap();
    let bless = std::env::var("C8F9_BLESS").is_ok();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut replica = set_up(&fixture);
        kition_kdm::testing::number_tool_ids(&mut replica).unwrap();
        let version = replica.version();
        let answer = match batch::run(&mut ReplicaTarget(&mut replica), &case["edit"]) {
            Ok(_) => json!({ "expected": replica.changes_since(&version).unwrap().to_json() }),
            Err(error) => json!({ "error": { "code": error.code.as_str(), "message": error.message } }),
        };
        if bless {
            println!("{name}: {answer}");
            continue;
        }
        let wanted = if case.get("error").is_some() { json!({ "error": case["error"] }) } else { json!({ "expected": case["expected"] }) };
        assert_eq!(answer, wanted, "{name}");
    }
}
