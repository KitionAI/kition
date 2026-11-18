// Copied from kition-sdk crates/kition-kits/tests/receipts.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Receipts: every accepted write of `<prefix>_run` and `<prefix>_batch` on a file the headless
//! kit edits, or on its headless draft, answers what it changed (`changes`, by the ids the tools
//! use), the document's `revision`, and the diagnostics it introduced and resolved, computed by
//! the SDK from the document's data model (`model.version`, `model.changes`, `document.check`),
//! against the mock kit. A failed run answers none; a kit without an object model and a file open
//! in its editor say why (`changesUnavailable`) instead of an empty change set.
//!
//! Cases: `sdk.agent.receipts/run`, `sdk.agent.receipts/batch`, `sdk.agent.receipts/unavailable`,
//! `sdk.agent.receipts/diagnostics`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, tests that can skip it say so and pass. CI requires it.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use kition_kits::tools;
use kition_kits::{KitDefinition, KitManager};
use serde_json::{Value, json};

/// A kit `kit.<name>` editing `.<name>` files, keeping drafts. Each test names its own kit: the
/// tools find kits by prefix in one registry per process.
fn kit(name: &str) -> &'static KitDefinition {
    let manifest = json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": format!("Kition {name}"), "version": "0.0.0",
        "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
        "agent": { "prefix": name, "tools": "document", "drafts": true },
        "headless": { "executable": "kition-kit-mock", "protocol": "kition-kit/2" }
    });
    KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"))
}

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

/// A launcher that starts the mock kit as `kit.<name>` for `.<name>` files, with `env` set.
fn as_kit(dir: &Path, mock: &Path, name: &str, env: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join(format!("kition-{name}-mock.sh"));
    std::fs::write(&script, format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.{name}:{name} {env} exec '{}' \"$@\"\n", mock.display()))
        .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    script
}

struct Fixture {
    kits: KitManager,
    name: String,
    workspace: tempfile::TempDir,
    _bin: tempfile::TempDir,
}

impl Fixture {
    /// The kit `name` (the mock with `env`) on a workspace holding `a.<name>` with `text`.
    fn new(name: &str, env: &str, text: &str) -> Option<Self> {
        let Some(mock) = mock_binary() else {
            eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
            return None;
        };
        let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(workspace.path().join(format!("a.{name}")), text).unwrap_or_else(|err| panic!("{err}"));
        let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit(name), Some(as_kit(bin.path(), &mock, name, env)))]).with_headless_drafts();
        Some(Self { kits, name: name.to_owned(), workspace, _bin: bin })
    }

    fn path(&self) -> String {
        format!("a.{}", self.name)
    }

    /// `<prefix>_<action>` on the fixture's file with `input`: its answer, or its error as the
    /// tool answers it (`{ error, …output }`), with the summary.
    async fn call(&self, action: &str, mut input: Value) -> (Result<Value, Value>, String) {
        input["path"] = json!(self.path());
        match tools::call(&self.kits, &format!("{}_{action}", self.name), &input).await {
            Some(Ok(output)) => (Ok(output.output), output.summary),
            Some(Err(error)) => (Err(error.structured()), error.message),
            None => panic!("{action} is not a kit tool"),
        }
    }

    async fn ok(&self, action: &str, input: Value) -> Value {
        self.call(action, input).await.0.unwrap_or_else(|error| panic!("{action}: {error}"))
    }

    fn read(&self) -> String {
        std::fs::read_to_string(self.workspace.path().join(self.path())).unwrap_or_else(|err| panic!("{err}"))
    }

    async fn shutdown(self) {
        self.kits.shutdown().await;
    }
}

fn append(text: &str) -> Value {
    json!({ "command": "text.append", "params": { "text": text } })
}

fn ids(list: &Value) -> Vec<&str> {
    list.as_array().map(|items| items.iter().filter_map(|item| item["id"].as_str()).collect()).unwrap_or_default()
}

fn count(changes: &Value, list: &str) -> usize {
    changes[list].as_array().map_or(usize::MAX, Vec::len)
}

/// Creates tags named `names` under the note in one batch, answering their ids.
async fn tags(f: &Fixture, names: &[&str]) -> Vec<String> {
    let ops: Vec<Value> = names.iter().map(|name| json!({ "op": "create", "type": "Tag", "in": "root.tags", "fields": { "name": name } })).collect();
    let answer = f.ok("batch", json!({ "ops": ops })).await;
    answer["results"].as_array().map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

// ---- `<prefix>_run` ----

#[tokio::test]
async fn derived_receipts_only_report_proven_public_changes() {
    for public in [false, true] {
        for available in [false, true] {
            let file = json!({"items":[{"key":"A","name":if available {"Anchor"} else {"Fail derived"},"data":{},"extra":0}],"other":[]});
            let env = format!(
                "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_DERIVED=1 KITION_KIT_MOCK_DERIVED_FAILURE=1 {}",
                if public { "KITION_KIT_MOCK_PUBLIC_DERIVED=1" } else { "" }
            );
            let name = format!("proven{public}{available}");
            let f = Fixture::new(&name, &env, &file.to_string()).expect("build mock");
            for changes in [json!(true), json!("all")] {
                let answer = f.ok("batch", json!({"changes":changes,"ops":[{"op":"set","target":"A","field":"name","value":"Renamed"}]})).await;
                assert!(!answer["changes"].to_string().contains("~layerItems"), "unchanged or unknown facts are not changes: {answer}");
            }
            let answer = f
                .ok(
                    "batch",
                    json!({"ops":[{"op":"create","type":"Other","in":"root.other","fields":{"key":"B","name":"Member","data":{"layer":"A"},"extra":0}}]}),
                )
                .await;
            assert_eq!(answer["changes"].to_string().contains("~layerItems"), public, "only public changed facts are shown: {answer}");
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn derived_receipt_schema_accepts_omitted_values_from_the_mock() {
    let file = json!({"items":[{"key":"A","name":"Anchor","data":{},"extra":0}],"other":(0..128).map(|i|json!({"key":format!("member-{i}-{}", "x".repeat(40)),"name":"Member","data":{"layer":"A"},"extra":0})).collect::<Vec<_>>()});
    let f = Fixture::new("derivedreceipt", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_DERIVED=1 KITION_KIT_MOCK_PUBLIC_DERIVED=1", &file.to_string())
        .expect("build mock");
    let answer = f.ok("batch", json!({"ops":[{"op":"set","target":file["other"][0]["key"],"field":"data","value":{"layer":"elsewhere"}}]})).await;
    let edits = answer["changes"]["changed"].as_array().unwrap().iter().flat_map(|change| change["edits"].as_array().into_iter().flatten());
    assert!(edits.into_iter().any(|edit| edit["field"] == "~layerItems" && edit.get("before").is_none() && edit.get("after").is_none()), "{answer}");
    let schema = tools::schemas::tool_output_schema("derivedreceipt_batch").unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    let errors: Vec<_> = validator.iter_errors(&answer).map(|error| error.to_string()).collect();
    assert!(errors.is_empty(), "{answer}\n{}", errors.join("\n"));
    f.shutdown().await;
}

#[tokio::test]
async fn run_reports_the_one_object_it_changed_with_before_and_after_and_a_revision() {
    let Some(f) = Fixture::new("rcone", "", "Hello") else { return };
    tags(&f, &["a", "b", "c"]).await;
    let (answer, summary) = f.call("run", json!({ "steps": [append(" world")] })).await;
    let answer = answer.unwrap_or_else(|error| panic!("{error}"));
    let changes = &answer["changes"];
    assert_eq!(count(changes, "changed"), 1, "only the note, not the tags beside it: {answer}");
    assert_eq!(changes["changed"][0]["type"], "Note");
    assert_eq!(changes["changed"][0]["edits"], json!([{ "field": "text", "before": "Hello", "after": "Hello world" }]), "{answer}");
    assert_eq!((count(changes, "created"), count(changes, "moved"), count(changes, "deleted")), (0, 0, 0), "{answer}");
    assert!(changes.get("texts").is_none() && changes.get("truncated").is_none(), "{answer}");
    assert!(answer["revision"].as_str().is_some_and(|revision| !revision.is_empty()), "{answer}");
    assert!(answer.get("changesUnavailable").is_none(), "{answer}");
    assert!(summary.contains("objects 1 changed"), "{summary}");
    f.shutdown().await;
}

#[tokio::test]
async fn run_of_many_steps_reports_their_union_once() {
    let Some(f) = Fixture::new("rcunion", "", "Hello") else { return };
    let answer = f.ok("run", json!({ "steps": [append("1"), append("2"), append("3")] })).await;
    assert_eq!(answer["changes"]["changed"].as_array().map(Vec::len), Some(1), "{answer}");
    assert_eq!(answer["changes"]["changed"][0]["edits"], json!([{ "field": "text", "before": "Hello", "after": "Hello123" }]), "{answer}");
    f.shutdown().await;
}

#[tokio::test]
async fn run_with_no_effect_reports_an_empty_change_set_and_still_a_revision() {
    let Some(f) = Fixture::new("rcnone", "", "Hello") else { return };
    let first = f.ok("run", json!({ "steps": [append("!")] })).await;
    let answer = f.ok("run", json!({ "steps": [append("?"), { "command": "edit.undo" }] })).await;
    assert_eq!(answer["changes"], json!({ "created": [], "changed": [], "moved": [], "deleted": [] }), "{answer}");
    assert_eq!(answer["revision"], first["revision"], "nothing changed: the same revision");
    f.shutdown().await;
}

#[tokio::test]
async fn run_that_fails_reports_no_changes() {
    let Some(f) = Fixture::new("rcfail", "", "Hello") else { return };
    let (answer, _) = f.call("run", json!({ "steps": [append("x"), { "command": "text.append", "params": { "text": "" } }] })).await;
    let error = answer.err().unwrap_or_else(|| panic!("the run was expected to fail"));
    assert!(error["rolledBack"].is_array(), "{error}");
    for member in ["changes", "revision", "changesUnavailable", "diagnostics"] {
        assert!(error.get(member).is_none(), "a rolled-back run has no `{member}`: {error}");
    }
    assert_eq!(f.read(), "Hello");
    f.shutdown().await;
}

#[tokio::test]
async fn run_on_a_headless_draft_reports_its_changes_too() {
    let Some(f) = Fixture::new("rcdraft", "", "Hello") else { return };
    let answer = f.ok("run", json!({ "draft": true, "steps": [append(" draft")] })).await;
    assert_eq!(answer["draft"], true, "{answer}");
    assert_eq!(answer["changes"]["changed"][0]["edits"], json!([{ "field": "text", "before": "Hello", "after": "Hello draft" }]), "{answer}");
    assert!(answer["revision"].is_string(), "{answer}");
    assert_eq!(f.read(), "Hello", "the file is unchanged");
    f.shutdown().await;
}

/// A deck as a real slide kit models it (`KITION_KIT_MOCK_DECK=nested`): slides 7 and 9, each with
/// a shape numbered 1 (`shape:7/1`, `shape:9/1`), shapes' text in a body of paragraphs.
const NESTED: &str = "7:1=Title|2=Body~Second line|!1=Speak slowly\n9:1=Other|2=More";
const NESTED_ENV: &str = "KITION_KIT_MOCK_PARTS=deck KITION_KIT_MOCK_DECK=nested";

/// A text edit changes a paragraph, which has no tool id: the receipt names the shape holding it,
/// by its tool id, with the path to the field and the text before and after, and no object id of
/// a paragraph or a body (regressions/issue-change-attribution).
#[tokio::test]
async fn run_a_text_edit_names_the_shape_holding_the_text_and_the_path_to_it() {
    let Some(f) = Fixture::new("rcnested", NESTED_ENV, NESTED) else { return };
    let text = |id: &str, text: &str| json!({ "command": "shape.text", "on": [id], "params": { "text": text } });
    let ran = f.ok("run", json!({ "steps": [text("shape:7/1", "Hello there")] })).await;
    assert_eq!(
        ran["changes"]["changed"],
        json!([{ "id": "shape:7/1", "type": "Shape", "fields": ["body.paragraphs.0.text"], "edits": [{ "field": "body.paragraphs.0.text", "before": "Title", "after": "Hello there" }] }]),
        "{ran}"
    );
    assert_eq!(f.read(), "7:1=Hello there|2=Body~Second line|!1=Speak slowly\n9:1=Other|2=More");
    // A paragraph added, and one taken away: the shape's edits at the items' paths.
    let added = f.ok("run", json!({ "steps": [{ "command": "shape.paragraph", "on": ["shape:9/1"], "params": { "text": "Added" } }] })).await;
    assert_eq!(added["changes"]["changed"][0]["id"], "shape:9/1", "{added}");
    assert_eq!(added["changes"]["changed"][0]["edits"], json!([{ "field": "body.paragraphs.1", "before": null, "after": { "text": "Added" } }]), "{added}");
    let long = "x".repeat(100);
    let cut = f.ok("run", json!({ "steps": [text("shape:7/2", &long)] })).await;
    let edits = &cut["changes"]["changed"][0]["edits"];
    assert_eq!(
        edits[0],
        json!({ "field": "body.paragraphs.0.text", "before": "Body", "after": { "excerpt": format!("{}…", "x".repeat(79)), "length": 100 } }),
        "{cut}"
    );
    assert_eq!(edits[1], json!({ "field": "body.paragraphs.1", "before": { "text": "Second line" }, "after": null }), "{cut}");
    for answer in [&ran, &added, &cut] {
        let shown = answer["changes"].to_string();
        assert!(!shown.contains("para-") && !shown.contains("body-"), "no object id of a held object: {shown}");
    }
    f.shutdown().await;
}

// ---- `<prefix>_batch` ----

#[tokio::test]
async fn batch_reports_exactly_the_object_it_set_by_the_ids_the_tools_use() {
    let Some(f) = Fixture::new("rcbatch", "", "Hello") else { return };
    let made = f
        .ok(
            "batch",
            json!({ "ops": [
        { "op": "create", "type": "Tag", "in": "root.tags", "fields": { "name": "a" } },
        { "op": "create", "type": "Tag", "in": "root.tags", "fields": { "name": "b" } }
    ] }),
        )
        .await;
    let created = ids(&made["changes"]["created"]);
    assert_eq!(created.len(), 2, "{made}");
    let results: Vec<&str> = made["results"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let mut sorted = results.clone();
    sorted.sort_unstable();
    assert_eq!(created, sorted, "created objects by the ids the batch answered, ordered by id");
    assert_eq!(made["changes"]["created"][0]["values"]["name"], if results[0] == sorted[0] { "a" } else { "b" });
    assert!(made["changes"]["created"][0]["at"]["field"] == "tags", "{made}");
    // The note's list of tags changed: its created tags say so (`at`), so the note's own entry
    // (`fields: ["tags"]`, no edits) is left out.
    assert_eq!(ids(&made["changes"]["changed"]).len(), 0, "the note's tags are told by the created tags: {made}");

    let set = f.ok("batch", json!({ "ops": [{ "op": "set", "target": results[1], "field": "name", "value": "B" }] })).await;
    assert_eq!(
        set["changes"]["changed"],
        json!([{ "id": results[1], "type": "Tag", "fields": ["name"], "edits": [{ "field": "name", "before": "b", "after": "B" }] }]),
        "{set}"
    );
    assert!(set["revision"].is_string() && set["revision"] != made["revision"], "{set}");

    let moved = f.ok("batch", json!({ "ops": [{ "op": "list.move", "target": "root", "field": "tags", "from": 1, "to": 0 }] })).await;
    assert_eq!(ids(&moved["changes"]["moved"]), vec![results[1]], "{moved}");
    assert_eq!(moved["changes"]["moved"][0]["to"]["index"], 0, "{moved}");

    let deleted = f.ok("batch", json!({ "ops": [{ "op": "delete", "target": results[0] }] })).await;
    assert_eq!(
        deleted["changes"]["deleted"],
        json!([{ "id": results[0], "type": "Tag", "fields": [], "at": { "parent": made["changes"]["created"][0]["at"]["parent"], "field": "tags", "index": 1 } }]),
        "{deleted}"
    );
    f.shutdown().await;
}

#[tokio::test]
async fn batch_names_objects_by_the_tool_ids_query_lists() {
    let Some(f) = Fixture::new("rctool", "KITION_KIT_MOCK_SCHEMA=tool-ids", "Hello") else { return };
    let made = f
        .ok(
            "batch",
            json!({ "ops": [
        { "op": "create", "type": "Frame", "in": "root.frames", "fields": { "name": "One" } },
        { "op": "create", "type": "Frame", "in": "root.frames", "fields": { "name": "Two" } }
    ] }),
        )
        .await;
    let listed = f.ok("query", json!({ "follow": "frames" })).await;
    let mut queried = ids(&listed["objects"]);
    queried.sort_unstable();
    assert_eq!(queried, vec!["frame:1", "frame:2"], "{listed}");
    assert_eq!(ids(&made["changes"]["created"]), queried, "{made}");
    let set = f.ok("batch", json!({ "ops": [{ "op": "set", "target": "frame:2", "field": "name", "value": "Second" }] })).await;
    assert_eq!(ids(&set["changes"]["changed"]), vec!["frame:2"], "{set}");
    f.shutdown().await;
}

#[tokio::test]
async fn batch_receipt_lists_at_most_fifty_objects_unless_asked_for_all_and_can_be_left_out() {
    let Some(f) = Fixture::new("rccap", "", "Hello") else { return };
    let names: Vec<String> = (0..60).map(|at| format!("t{at}")).collect();
    let ops: Vec<Value> = names.iter().map(|name| json!({ "op": "create", "type": "Tag", "in": "root.tags", "fields": { "name": name } })).collect();
    let capped = f.ok("batch", json!({ "ops": ops })).await;
    let changes = &capped["changes"];
    assert_eq!(count(changes, "created") + count(changes, "changed"), 50, "{changes}");
    // 60 tags created and no entry for the note's list: 50 listed, 10 left out.
    assert_eq!(changes["truncated"], json!({ "created": 10, "changed": 0, "moved": 0, "deleted": 0 }), "{changes}");

    let more: Vec<Value> = (0..60).map(|at| json!({ "op": "create", "type": "Tag", "in": "root.tags", "fields": { "name": format!("u{at}") } })).collect();
    let all = f.ok("batch", json!({ "ops": more, "changes": "all" })).await;
    assert_eq!(count(&all["changes"], "created"), 60, "{}", all["changes"]);
    assert!(all["changes"].get("truncated").is_none());

    let left_out = f.ok("run", json!({ "steps": [append("!")], "changes": false })).await;
    assert!(left_out.get("changes").is_none() && left_out.get("changesUnavailable").is_none(), "{left_out}");
    assert!(left_out["revision"].is_string(), "{left_out}");
    let (refused, _) = f.call("run", json!({ "steps": [append("!")], "changes": "some" })).await;
    assert_eq!(refused.err().map(|error| error["error"]["code"].clone()), Some(json!("invalid-params")));
    assert_eq!(f.read(), "Hello!", "the refused call ran nothing");
    f.shutdown().await;
}

// ---- No change set ----

#[tokio::test]
async fn unavailable_for_a_kit_without_an_object_model() {
    let Some(f) = Fixture::new("rcnomodel", "KITION_KIT_MOCK_SCHEMA=none", "Hello") else { return };
    let answer = f.ok("run", json!({ "steps": [append("!")] })).await;
    assert!(answer["changes"].is_null(), "never an empty change set: {answer}");
    assert!(answer["changesUnavailable"].as_str().is_some_and(|why| why.contains("no object model")), "{answer}");
    assert!(answer.get("revision").is_none(), "{answer}");
    assert_eq!(f.read(), "Hello!");
    f.shutdown().await;
}

/// A renderer window with `path` open in the editor of `kit`, answering every `run` and `batch`.
fn editor(kits: &KitManager, kit: &'static KitDefinition, path: &str) {
    let bridge = kits.bridge().clone();
    let (session, mut rx) = bridge.connect();
    let path = path.to_owned();
    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let Some(id) = message["id"].as_u64() else { continue };
            let mut reply = match (message["method"].as_str(), message["params"]["tool"].as_str()) {
                (Some("kit/documents"), _) => json!({ "result": { "documents": [{ "path": path, "kit": kit.id, "dirty": false, "revision": 1 }] } }),
                (Some("kit/call"), Some("run")) => {
                    json!({ "result": { "completed": [{ "command": "text.append" }], "saved": true, "document": { "summary": "6 characters" } } })
                }
                (Some("kit/call"), Some("batch")) => json!({ "result": { "results": [null], "loaded": [] } }),
                (Some("kit/preview"), _) => json!({ "error": { "code": -32000, "message": "no preview" } }),
                _ => json!({ "error": { "code": -32000, "message": "unexpected call" } }),
            };
            reply["jsonrpc"] = json!("2.0");
            reply["id"] = json!(id);
            let _ = bridge.receive(session, &reply);
        }
    });
}

#[tokio::test]
async fn unavailable_for_a_write_in_an_open_editor() {
    let live = kit("rclive");
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(live, None)]);
    editor(&kits, live, "a.rclive");
    for (tool, input) in [
        ("rclive_run", json!({ "path": "a.rclive", "steps": [append("!")] })),
        ("rclive_batch", json!({ "path": "a.rclive", "ops": [{ "op": "set", "target": "root", "field": "text", "value": "x" }] })),
    ] {
        let answer =
            tools::call(&kits, tool, &input).await.unwrap_or_else(|| panic!("{tool}")).unwrap_or_else(|error| panic!("{tool}: {}", error.message)).output;
        assert_eq!(answer["live"], true, "{answer}");
        assert!(answer["changes"].is_null(), "{tool}: {answer}");
        assert!(answer["changesUnavailable"].as_str().is_some_and(|why| why.contains("open in its")), "{tool}: {answer}");
    }
    kits.shutdown().await;
}

// ---- Diagnostics ----

#[tokio::test]
async fn diagnostics_a_call_introduced_and_resolved() {
    let Some(f) = Fixture::new("rcdiag", "", "Hello") else { return };
    let added = f.ok("run", json!({ "steps": [append(" TODO")] })).await;
    assert_eq!(added["diagnostics"]["resolved"], json!([]), "{added}");
    let new = &added["diagnostics"]["new"];
    assert_eq!(new.as_array().map(Vec::len), Some(1), "{added}");
    assert_eq!((&new[0]["code"], &new[0]["target"]), (&json!("mock.todo"), &json!({})), "{added}");

    let kept = f.ok("run", json!({ "steps": [append(" more")] })).await;
    assert_eq!(kept["diagnostics"], json!({ "new": [], "resolved": [] }), "the TODO is still there, neither new nor resolved: {kept}");

    let cleared = f.ok("batch", json!({ "ops": [{ "op": "text.set", "target": "root", "field": "text", "text": "Done" }] })).await;
    assert_eq!(cleared["diagnostics"]["new"], json!([]), "{cleared}");
    assert_eq!(cleared["diagnostics"]["resolved"][0]["code"], "mock.todo", "{cleared}");

    let unchecked = f.ok("run", json!({ "steps": [append(" TODO")], "check": false })).await;
    assert!(unchecked.get("diagnostics").is_none(), "{unchecked}");
    f.shutdown().await;
}

/// What a receipt costs on the mock: runs of one step with the change set and the checks, without
/// the checks (`check: false`), and without either (`changes: false, check: false`). Reported,
/// not asserted: the machine is shared, so no tight time budget.
#[tokio::test]
async fn overhead_of_receipts_on_the_mock() {
    let Some(f) = Fixture::new("rccost", "", "Hello") else { return };
    let f = Arc::new(f);
    const RUNS: u32 = 20;
    let mut timings = Vec::new();
    for (label, extra) in [
        ("bare (changes: false, check: false)", json!({ "changes": false, "check": false })),
        ("changes, no check", json!({ "check": false })),
        ("changes and check (default)", json!({})),
    ] {
        f.ok("run", json!({ "steps": [append(".")], "save": false })).await;
        let started = Instant::now();
        for _ in 0..RUNS {
            let mut input = extra.clone();
            input["steps"] = json!([append(".")]);
            input["save"] = json!(false);
            f.ok("run", input).await;
        }
        let each: Duration = started.elapsed() / RUNS;
        timings.push(format!("{label}: {:.2} ms a run", each.as_secs_f64() * 1000.0));
    }
    eprintln!("receipt overhead on the mock ({RUNS} runs each): {}", timings.join("; "));
    if let Ok(f) = Arc::try_unwrap(f) {
        f.shutdown().await;
    }
}
