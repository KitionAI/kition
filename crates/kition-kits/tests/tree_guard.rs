// Copied from kition-sdk crates/kition-kits/tests/tree_guard.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The premise guard on trees, against the mock kit's images with a stack of layers
//! (`KITION_KIT_MOCK_PARTS=stack`: the root `Image`, no tool id, holds its layers in a KDM tree;
//! layers have integer ids and may hold layers).
//!
//! - A write that names a layer by its index among its siblings (`"#n"`, at the top level
//!   or under a group `in`) is refused as `relocated` when others inserted, deleted or moved a layer
//!   below it, or moved it, so that `"#n"` names another layer than at `basis`, whether another
//!   agent or a program writing the file did it; it applies after a change above it or elsewhere.
//!   A list the guard cannot read refuses (`unknown`) instead of dropping the verdict.
//! - A command whose index counts from the other end (`x-khp-index-order: "reversed"`, a
//!   stack shown top-first: `"#1"` is the last stored) is followed in that order: refused after a
//!   layer put on top, applied after one put at the bottom; a conflict says where the object is now
//!   in the command's spelling (`now.spelled`).
//! - The root, which has no tool id, is named by its object id: its derived value
//!   (`~layerCount`) is in receipts and `others`, also after a change made in the file (where its
//!   changes were counted in `unnamed`), and a premise may name it.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, tests that can skip it say so and pass. CI requires it.
#![cfg(unix)]

#[path = "support/editor.rs"]
mod editor;

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use kition_kits::tools::{self, CallOptions};
use kition_kits::{KitDefinition, KitManager};
use serde_json::{Value, json};

fn kit(name: &str) -> &'static KitDefinition {
    let manifest = json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": format!("Kition {name}"), "version": "0.3.1",
        "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
        "agent": { "prefix": name, "tools": "document" },
        "headless": { "executable": "kition-kit-mock", "protocol": "kition-kit/1" }
    });
    KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"))
}

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

fn as_kit(dir: &Path, mock: &Path, name: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join(format!("kition-{name}-mock.sh"));
    std::fs::write(
        &script,
        format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.{name}:{name} KITION_KIT_MOCK_VERSION=0.3.1 KITION_KIT_MOCK_PARTS=stack exec '{}' \"$@\"\n", mock.display()),
    )
    .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    script
}

const ME: &str = "agent-me";
const OTHER: &str = "agent-other";

#[tokio::test]
async fn named_json_resources_report_rename_deletion_and_reassignment() {
    for list in ["channels", "patterns", "comps", "searchBins"] {
        for outside in [false, true] {
            for action in ["rename", "delete", "reassign", "content", "other", "shift"] {
                let original = json!({ "name": "photo", "layers": [], "resources": {
                    (list): [{ "key": "a", "name": "Alpha", "value": 1 }, { "key": "b", "name": "Beta", "value": 2 }]
                } });
                let f = Fixture::new("jsonnames", &original.to_string()).expect("build the mock kit first");
                let basis = f.revision(ME).await;
                let mut changed = original.clone();
                let items = changed["resources"][list].as_array_mut().unwrap();
                match action {
                    "rename" => items[0]["name"] = json!("Away"),
                    "delete" => {
                        items.remove(0);
                    }
                    "reassign" => items[0]["key"] = json!("replacement"),
                    "content" => items[0]["value"] = json!(3),
                    "other" => items[1]["name"] = json!("Elsewhere"),
                    _ => items.insert(0, json!({ "key": "new", "name": "New", "value": 0 })),
                }
                if outside {
                    f.write_outside(&changed.to_string());
                } else {
                    f.ok(OTHER, "batch", json!({ "ops": [{ "op": "set", "target": "image", "field": "resources", "value": changed["resources"] }] })).await;
                }
                let before = f.read();
                let answer = f
                    .call(
                        ME,
                        "run",
                        json!({ "basis": basis, "steps": [{ "command": "resource.rename", "params": { "list": list, "name": "Alpha", "to": "Final" } }] }),
                    )
                    .await;
                match action {
                    "other" | "shift" => {
                        answer.unwrap_or_else(|error| panic!("{list}/{action}/{outside}: {error}"));
                    }
                    _ => {
                        let refused = answer.expect_err("a stale named resource must refuse");
                        let reason = match action {
                            "delete" => "deleted",
                            "content" => "changed",
                            _ => "relocated",
                        };
                        assert!(
                            refused["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["id"] == "image" && conflict["reason"] == reason),
                            "{list}/{action}/{outside}: {refused}"
                        );
                        assert_eq!(f.read(), before);
                    }
                }
                f.shutdown().await;
            }
        }
    }
}

#[tokio::test]
async fn tree_delete_requires_child_first_and_its_receipt_agrees_with_reread() {
    let f = Fixture::new("stkchildfirst", &image(&layers())).expect("build the mock kit first");
    let before = f.read();
    let refused = f.call(ME, "batch", json!({ "ops": [{ "op": "delete", "target": 2 }] })).await.expect_err("a group still has children");
    assert_eq!(refused["error"]["code"], "invalid-value", "{refused}");
    assert!(refused["error"]["message"].as_str().unwrap().contains("child-first"), "{refused}");
    assert_eq!(f.read(), before);
    let receipt = f
        .ok(
            ME,
            "batch",
            json!({ "ops": [
        { "op": "delete", "target": 3 }, { "op": "delete", "target": 4 },
        { "op": "delete", "target": 5 }, { "op": "delete", "target": 2 }
    ] }),
        )
        .await;
    let ids: std::collections::BTreeSet<u64> = receipt["changes"]["deleted"].as_array().unwrap().iter().map(|item| item["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, std::collections::BTreeSet::from([2, 3, 4, 5]), "{receipt}");
    assert!(receipt["changes"]["changed"].as_array().unwrap().iter().all(|change| change["fields"] == json!(["~layerCount"])), "{receipt}");
    assert_eq!(serde_json::from_str::<Value>(&f.read()).unwrap()["layers"].as_array().unwrap().len(), 2);
    let reread = f.ok(ME, "inspect", json!({ "basis": receipt["revision"] })).await;
    for list in ["created", "changed", "moved", "deleted"] {
        assert!(reread["others"][list].as_array().is_none_or(Vec::is_empty), "{reread}");
    }
    f.shutdown().await;
}

#[tokio::test]
async fn batch_settles_byte_opacity_before_its_receipt_and_saved_reread() {
    let Some(f) = Fixture::new("stksettle", &image(&json!([{ "id": 1, "name": "bg", "opacity": 100, "fillOpacity": 1 }]))) else { return };
    let basis = f.revision(ME).await;
    let answer = f.ok(ME, "batch", json!({ "basis": basis, "ops": [{ "op": "set", "target": "1", "field": "fillOpacity", "value": 0.9 }] })).await;
    let stored = 230.0 / 255.0;
    assert_eq!(answer["changes"]["changed"][0]["edits"][0]["after"], json!(stored), "{answer}");
    let file: Value = serde_json::from_str(&f.read()).unwrap();
    assert_eq!(file["layers"][0]["fillOpacity"], json!(stored));
    let reread = f.ok(ME, "inspect", json!({ "basis": answer["revision"] })).await;
    assert!(reread["others"]["changed"].as_array().is_none_or(Vec::is_empty), "{reread}");
    f.shutdown().await;
}

struct Fixture {
    kits: KitManager,
    name: String,
    options: CallOptions,
    workspace: tempfile::TempDir,
    _bin: tempfile::TempDir,
}

impl Fixture {
    fn new(name: &str, text: &str) -> Option<Self> {
        let Some(mock) = mock_binary() else {
            eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
            return None;
        };
        let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(workspace.path().join(format!("a.{name}")), text).unwrap_or_else(|err| panic!("{err}"));
        let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit(name), Some(as_kit(bin.path(), &mock, name)))]);
        editor::attach(&kits, workspace.path(), kit(name), &as_kit(bin.path(), &mock, name), &format!("a.{name}"));
        Some(Self { kits, name: name.to_owned(), options: CallOptions::default(), workspace, _bin: bin })
    }

    async fn call(&self, agent: &str, action: &str, mut input: Value) -> Result<Value, Value> {
        input["path"] = json!(format!("a.{}", self.name));
        match tools::call_as(&self.kits, &format!("{}_{action}", self.name), &input, self.options, agent).await {
            Some(Ok(output)) => Ok(output.output),
            Some(Err(error)) => Err(error.structured()),
            None => panic!("{action} is not a kit tool"),
        }
    }

    async fn ok(&self, agent: &str, action: &str, input: Value) -> Value {
        self.call(agent, action, input).await.unwrap_or_else(|error| panic!("{action}: {error}"))
    }

    async fn revision(&self, agent: &str) -> String {
        let seen = self.ok(agent, "inspect", json!({})).await;
        seen["revision"].as_str().unwrap_or_else(|| panic!("inspect answers a revision: {seen}")).to_owned()
    }

    fn file(&self) -> PathBuf {
        self.workspace.path().join(format!("a.{}", self.name))
    }

    fn read(&self) -> String {
        std::fs::read_to_string(self.file()).unwrap_or_else(|err| panic!("{err}"))
    }

    /// Writes the file as a colleague's program would, an hour before its own time.
    fn write_outside(&self, text: &str) {
        let at = std::fs::metadata(self.file()).and_then(|meta| meta.modified()).unwrap_or_else(|err| panic!("{err}")) - Duration::from_secs(3600);
        write_at(&self.file(), text, at);
    }

    async fn shutdown(self) {
        self.kits.shutdown().await;
    }
}

fn write_at(file: &Path, text: &str, at: SystemTime) {
    std::fs::write(file, text).unwrap_or_else(|err| panic!("{err}"));
    let handle = std::fs::File::options().write(true).open(file).unwrap_or_else(|err| panic!("{err}"));
    handle.set_modified(at).unwrap_or_else(|err| panic!("{err}"));
}

/// The image: at the top level 1, the group 2 holding 3, 4 and 5, then 6 (stored order, the
/// first at the bottom).
fn layers() -> Value {
    json!([
        { "id": 1, "name": "bg", "opacity": 100 },
        { "id": 2, "name": "group", "opacity": 100, "layers": [
            { "id": 3, "name": "a", "opacity": 100 },
            { "id": 4, "name": "b", "opacity": 100 },
            { "id": 5, "name": "c", "opacity": 100 }
        ] },
        { "id": 6, "name": "top", "opacity": 100 }
    ])
}

fn image(layers: &Value) -> String {
    json!({ "name": "photo", "layers": layers }).to_string()
}

/// `layer.opacity` on `"#n"` among the children of `in` (the top level for `None`).
fn by_index(n: u32, group: Option<u64>, opacity: f64) -> Value {
    let mut params = json!({ "layer": format!("#{n}"), "opacity": opacity });
    if let Some(group) = group {
        params["in"] = json!(group);
    }
    json!({ "command": "layer.opacity", "params": params })
}

/// The opacity of layer `id` in the file's text.
fn opacity_in(text: &str, id: u64) -> f64 {
    fn find(layers: &Value, id: u64) -> Option<f64> {
        layers.as_array()?.iter().find_map(|layer| if layer["id"] == json!(id) { layer["opacity"].as_f64() } else { find(&layer["layers"], id) })
    }
    let file: Value = serde_json::from_str(text).unwrap_or_else(|err| panic!("{err}"));
    find(&file["layers"], id).unwrap_or_else(|| panic!("no layer {id} in {text}"))
}

/// What another writer does after the agent's `basis`: a step of another agent, or the file as a
/// program writes it (the layers changed by a function).
enum Change {
    Agent(Value),
    Outside(fn(&mut Value)),
}

/// Runs `step` with `basis` after `change`: the refusal, or `None` when it applied.
async fn after(change: Change, step: Value) -> Option<(Value, String)> {
    let f = Fixture::new("stk", &image(&layers()))?;
    let basis = f.revision(ME).await;
    match change {
        Change::Agent(other) => {
            f.ok(OTHER, "run", json!({ "steps": [other] })).await;
        }
        Change::Outside(edit) => {
            let mut changed = layers();
            edit(&mut changed);
            f.write_outside(&image(&changed));
        }
    }
    let before = f.read();
    let answer = f.call(ME, "run", json!({ "basis": basis, "steps": [step] })).await;
    let file = f.read();
    f.shutdown().await;
    match answer {
        Ok(_) => None,
        Err(refused) => {
            assert_eq!(file, before, "a refused write changes nothing");
            Some((refused, file))
        }
    }
}

/// `step` with `basis` after `change` is refused as `relocated`.
async fn refused(change: Change, step: Value) {
    if mock_binary().is_none() {
        return;
    }
    let Some((refused, _)) = after(change, step).await else { panic!("the write was expected to be refused") };
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    let reasons: Vec<&Value> = refused["conflicts"].as_array().into_iter().flatten().map(|conflict| &conflict["reason"]).collect();
    assert!(reasons.iter().any(|reason| **reason == "relocated"), "{refused}");
}

/// `step` with `basis` after `change` applies, to layer `id`.
async fn applies(change: Change, step: Value, id: u64) {
    let Some(f) = Fixture::new("stk", &image(&layers())) else { return };
    let basis = f.revision(ME).await;
    match change {
        Change::Agent(other) => {
            f.ok(OTHER, "run", json!({ "steps": [other] })).await;
        }
        Change::Outside(edit) => {
            let mut changed = layers();
            edit(&mut changed);
            f.write_outside(&image(&changed));
        }
    }
    let ran = f.call(ME, "run", json!({ "basis": basis, "steps": [step] })).await;
    let file = f.read();
    f.shutdown().await;
    let ran = ran.unwrap_or_else(|refused| panic!("the write was expected to apply: {refused}"));
    assert_eq!(opacity_in(&file, id), 50.0, "{ran}");
}

fn add(id: u64, group: Option<u64>, at: Option<u64>) -> Value {
    let mut params = json!({ "id": id });
    if let Some(group) = group {
        params["in"] = json!(group);
    }
    if let Some(at) = at {
        params["at"] = json!(at);
    }
    json!({ "command": "layer.add", "params": params })
}

fn group_of(layers: &mut Value) -> &mut Vec<Value> {
    layers[1]["layers"].as_array_mut().unwrap_or_else(|| panic!("layer 2 is a group"))
}

#[tokio::test]
async fn an_index_under_a_group_is_refused_after_an_insert_below_it() {
    // The conflict names the layer "#2" named at `basis` and where it is now.
    if let Some((refused, _)) = after(Change::Agent(add(10, Some(2), Some(0))), by_index(2, Some(2), 50.0)).await {
        let conflict = refused["conflicts"].as_array().and_then(|all| all.iter().find(|conflict| conflict["id"] == 4)).unwrap_or_else(|| panic!("{refused}"));
        assert_eq!(conflict["reason"], "relocated", "{refused}");
        assert_eq!(conflict["now"], json!({ "parent": "2", "field": "layers", "index": 2, "spelled": "#3" }), "{refused}");
        assert_eq!(conflict["place"]["under"], json!([3]), "\"#2\" names layer 3 now: {refused}");
    } else if mock_binary().is_some() {
        panic!("the write was expected to be refused");
    }
    refused(Change::Agent(add(10, Some(2), Some(0))), by_index(2, Some(2), 50.0)).await;
    refused(Change::Outside(|layers| group_of(layers).insert(0, json!({ "id": 10, "name": "new", "opacity": 100 }))), by_index(2, Some(2), 50.0)).await;
}

#[tokio::test]
async fn an_index_at_the_top_level_is_refused_after_an_insert_below_it() {
    refused(Change::Agent(add(10, None, Some(0))), by_index(2, None, 50.0)).await;
    refused(
        Change::Outside(|layers| layers.as_array_mut().unwrap_or_else(|| panic!("layers")).insert(0, json!({ "id": 10, "name": "new", "opacity": 100 }))),
        by_index(2, None, 50.0),
    )
    .await;
}

#[tokio::test]
async fn an_index_is_refused_after_a_delete_below_it() {
    refused(Change::Agent(json!({ "command": "layer.delete", "params": { "layer": 3 } })), by_index(2, Some(2), 50.0)).await;
    refused(Change::Outside(|layers| drop(group_of(layers).remove(0))), by_index(2, Some(2), 50.0)).await;
    refused(Change::Agent(json!({ "command": "layer.delete", "params": { "layer": 1 } })), by_index(2, None, 50.0)).await;
    refused(Change::Outside(|layers| drop(layers.as_array_mut().unwrap_or_else(|| panic!("layers")).remove(0))), by_index(2, None, 50.0)).await;
}

#[tokio::test]
async fn an_index_is_refused_after_a_move_across_groups() {
    // Layer 3 out of the group, to the top of the image: "#2" of the group names 5, not 4.
    refused(Change::Agent(json!({ "command": "layer.move", "params": { "layer": 3 } })), by_index(2, Some(2), 50.0)).await;
    refused(
        Change::Outside(|layers| {
            let moved = group_of(layers).remove(0);
            layers.as_array_mut().unwrap_or_else(|| panic!("layers")).push(moved);
        }),
        by_index(2, Some(2), 50.0),
    )
    .await;
    // Layer 1 into the group: "#2" of the top level names 6, not 2.
    refused(Change::Agent(json!({ "command": "layer.move", "params": { "layer": 1, "in": 2 } })), by_index(2, None, 50.0)).await;
    refused(
        Change::Outside(|layers| {
            let moved = layers.as_array_mut().unwrap_or_else(|| panic!("layers")).remove(0);
            layers[0]["layers"].as_array_mut().unwrap_or_else(|| panic!("the group")).push(moved);
        }),
        by_index(2, None, 50.0),
    )
    .await;
}

#[tokio::test]
async fn an_index_applies_after_an_unrelated_change() {
    let opacity = json!({ "command": "layer.opacity", "params": { "layer": 1, "opacity": 20 } });
    applies(Change::Agent(opacity), by_index(2, Some(2), 50.0), 4).await;
    applies(Change::Outside(|layers| layers[0]["opacity"] = json!(20)), by_index(2, Some(2), 50.0), 4).await;
    // A change in another group's list: the top level's.
    applies(Change::Agent(add(10, None, Some(0))), by_index(2, Some(2), 50.0), 4).await;
}

#[tokio::test]
async fn an_index_applies_after_a_change_above_it() {
    applies(Change::Agent(add(10, Some(2), None)), by_index(2, Some(2), 50.0), 4).await;
    applies(Change::Outside(|layers| group_of(layers).push(json!({ "id": 10, "name": "new", "opacity": 100 }))), by_index(2, Some(2), 50.0), 4).await;
    applies(Change::Agent(json!({ "command": "layer.delete", "params": { "layer": 5 } })), by_index(2, Some(2), 50.0), 4).await;
    applies(Change::Outside(|layers| drop(group_of(layers).pop())), by_index(2, Some(2), 50.0), 4).await;
    applies(Change::Agent(add(10, None, None)), by_index(2, None, 50.0), 2).await;
}

/// The root's own changes and its derived value, after a write and after a file change.
#[tokio::test]
async fn the_roots_derived_value_is_told_after_a_write_and_after_a_file_change() {
    let Some(f) = Fixture::new("stk", &image(&layers())) else { return };
    let ran = f.ok(ME, "run", json!({ "steps": [add(10, None, None)] })).await;
    let root = ran["changes"]["changed"].as_array().and_then(|all| all.iter().find(|change| change["id"] == "image")).unwrap_or_else(|| panic!("{ran}"));
    assert!(root["edits"].as_array().into_iter().flatten().any(|edit| edit == &json!({ "field": "~layerCount", "before": 6, "after": 7 })), "{ran}");
    let basis = f.revision(ME).await;
    let mut changed = layers();
    group_of(&mut changed).push(json!({ "id": 11, "name": "new", "opacity": 100 }));
    changed.as_array_mut().unwrap_or_else(|| panic!("layers")).push(json!({ "id": 10, "name": "", "opacity": 100 }));
    f.write_outside(&json!({ "name": "renamed", "layers": changed }).to_string());
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [{ "command": "layer.opacity", "params": { "layer": 1, "opacity": 50 } }] })).await;
    let others = &ran["others"];
    assert!(others.get("unnamed").is_none(), "the root is named, not counted: {ran}");
    let root = others["changed"].as_array().and_then(|all| all.iter().find(|change| change["id"] == "image")).unwrap_or_else(|| panic!("{ran}"));
    let edits = root["edits"].as_array().cloned().unwrap_or_default();
    assert!(edits.contains(&json!({ "field": "name", "before": "photo", "after": "renamed" })), "{ran}");
    assert!(edits.contains(&json!({ "field": "~layerCount", "before": 7, "after": 8 })), "{ran}");
    f.shutdown().await;
}

/// A premise on the root's derived value: refused after a change of it by another agent
/// or in the file, applied after a change that keeps it.
#[tokio::test]
async fn a_premise_on_the_roots_derived_value_holds() {
    let caption = json!({ "command": "image.caption", "params": { "text": "trip" } });
    let opacity = json!({ "command": "layer.opacity", "params": { "layer": 1, "opacity": 20 } });
    for (change, refuses) in [
        (Change::Agent(add(10, Some(2), None)), true),
        (Change::Outside(|layers| group_of(layers).push(json!({ "id": 10, "name": "new", "opacity": 100 }))), true),
        (Change::Agent(opacity.clone()), false),
        (Change::Outside(|layers| layers[0]["opacity"] = json!(20)), false),
    ] {
        let Some(f) = Fixture::new("stk", &image(&layers())) else { return };
        let basis = f.revision(ME).await;
        match change {
            Change::Agent(other) => {
                f.ok(OTHER, "run", json!({ "steps": [other] })).await;
            }
            Change::Outside(edit) => {
                let mut changed = layers();
                edit(&mut changed);
                f.write_outside(&image(&changed));
            }
        }
        let answer = f.call(ME, "run", json!({ "basis": basis, "steps": [caption.clone()] })).await;
        f.shutdown().await;
        match (answer, refuses) {
            (Err(refused), true) => {
                let conflict = &refused["conflicts"][0];
                assert_eq!((&conflict["id"], &conflict["reason"]), (&json!("image"), &json!("changed")), "{refused}");
            }
            (Ok(_), false) => {}
            (answer, _) => panic!("expected refused: {refuses}, got {answer:?}"),
        }
    }
}

/// `layer.fade` on `"#n"` counted from the top among the children of `in`.
fn from_top(n: u32, group: Option<u64>) -> Value {
    let mut step = by_index(n, group, 50.0);
    step["command"] = json!("layer.fade");
    step
}

/// An index counted from the top follows the stack from the top.
#[tokio::test]
async fn an_index_counted_from_the_top_is_followed_from_the_top() {
    // A layer put on top: "#1" from the top named 6, names 10 now.
    refused(Change::Agent(add(10, None, None)), from_top(1, None)).await;
    refused(
        Change::Outside(|layers| layers.as_array_mut().unwrap_or_else(|| panic!("layers")).push(json!({ "id": 10, "name": "new", "opacity": 100 }))),
        from_top(1, None),
    )
    .await;
    refused(Change::Agent(add(10, Some(2), None)), from_top(1, Some(2))).await;
    // A layer put at the bottom, or the bottom one of the group deleted: the top ones stay.
    applies(Change::Agent(add(10, None, Some(0))), from_top(1, None), 6).await;
    applies(
        Change::Outside(|layers| layers.as_array_mut().unwrap_or_else(|| panic!("layers")).insert(0, json!({ "id": 10, "name": "new", "opacity": 100 }))),
        from_top(1, None),
        6,
    )
    .await;
    applies(Change::Agent(json!({ "command": "layer.delete", "params": { "layer": 3 } })), from_top(2, Some(2)), 4).await;
    // Refused, the conflict says where the layer "#1" named is now, counted from the top.
    if let Some((refused, _)) = after(Change::Agent(add(10, None, None)), from_top(1, None)).await {
        let conflict = refused["conflicts"].as_array().and_then(|all| all.iter().find(|conflict| conflict["id"] == 6)).unwrap_or_else(|| panic!("{refused}"));
        assert_eq!(conflict["now"]["index"], 2, "stored order, from 0: {refused}");
        assert_eq!(conflict["now"]["spelled"], "#2", "the command's order: {refused}");
        assert_eq!(conflict["place"]["under"], json!([10]), "{refused}");
    }
}
