// Copied from kition-sdk crates/kition-kits/tests/object_model.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The object-model tools (`<prefix>_query`, `<prefix>_batch`) and structured error codes,
//! against the mock kit standing in for Kition Example (`KITION_KIT_MOCK_AS`): on the headless
//! kit, and on a live editor through the Kit AI bridge, including drafts and read-only refusals.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, tests that can skip it say so and pass. CI requires it.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use kition_kits::KitManager;
use kition_kits::tools::{self, ErrorCode};
use serde_json::{Value, json};

/// The synthetic manifest used by the mock executable.
fn fixture_kit(name: &str) -> &'static kition_kits::KitDefinition {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("tests/support/{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let manifest = serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    kition_kits::KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"))
}

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

/// A launcher that starts the mock kit as `kit.example` for `.example` files.
fn as_example(dir: &Path, mock: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("kition-example-mock.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nKITION_KIT_MOCK_AS=kit.example:example KITION_KIT_MOCK_VERSION={} exec '{}' \"$@\"\n",
            fixture_kit("example").version,
            mock.display()
        ),
    )
    .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    script
}

struct Fixture {
    kits: KitManager,
    workspace: tempfile::TempDir,
    _bin: tempfile::TempDir,
}

fn fixture() -> Option<Fixture> {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return None;
    };
    let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::create_dir_all(workspace.path().join("art")).unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join("art/Note.example"), "hello").unwrap_or_else(|err| panic!("{err}"));
    let example = fixture_kit("example");
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(example, Some(as_example(bin.path(), &mock)))]);
    Some(Fixture { kits, workspace, _bin: bin })
}

async fn call(kits: &KitManager, name: &str, input: Value) -> Result<Value, Value> {
    match tools::call(kits, name, &input).await {
        Some(Ok(output)) => Ok(output.output),
        Some(Err(error)) => Err(error.structured()),
        None => panic!("{name} is not a kit tool"),
    }
}

#[tokio::test]
async fn owning_map_queries_use_tool_ids() {
    use std::os::unix::fs::PermissionsExt;
    let mock = mock_binary().expect("build mock first");
    let workspace = tempfile::tempdir().unwrap();
    let bin = tempfile::tempdir().unwrap();
    let name = "refreplies";
    let manifest = json!({"khp":"1.0","id":"kit.refreplies","name":"References","version":"0.0.0",
        "formats":[{"id":name,"extensions":[name],"role":"edit"}],"agent":{"prefix":name,"tools":"document","objectModel":true},
        "headless":{"executable":"mock","protocol":"kition-kit/1"}});
    let kit = kition_kits::KitDefinition::from_manifest(&manifest).unwrap();
    let script = bin.path().join("mock");
    std::fs::write(
        &script,
        format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.{name}:{name} KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_MAPS=1 exec '{}' \"$@\"\n", mock.display()),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(
        workspace.path().join("a.refreplies"),
        json!({"items":[],"other":[],"catalog":{
            "standard":{"key":"style:Standard","name":"Standard","data":{},"extra":1},
            "wrapped":{"key":"style:Wrapped","name":"Wrapped","data":{},"extra":2}
        }})
        .to_string(),
    )
    .unwrap();
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit, Some(script))]);
    let read = call(&kits, "refreplies_query", json!({"path":"a.refreplies"})).await.unwrap();
    assert_eq!(read["objects"][0]["fields"]["catalog"], json!({"standard":"style:Standard","wrapped":{"body":"style:Wrapped","note":"literal"}}));
    kits.shutdown().await;
}

#[tokio::test]
async fn queries_and_batches_the_headless_kit() {
    let Some(f) = fixture() else { return };
    let kits = &f.kits;
    let path = "art/Note.example";

    let read = call(kits, "example_query", json!({ "path": path, "describe": "*" })).await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(read["objects"][0]["type"], "Note", "{read}");
    assert_eq!(read["objects"][0]["fields"]["text"], "hello");
    assert_eq!(read["describe"]["root"], "Note");
    assert_eq!(read["schema"]["$defs"]["Tag"]["properties"]["name"]["type"], "string");
    // The schema the kit described shapes the tools' arguments from now on.
    let installed = tools::installed(kits);
    let query = installed.iter().find(|spec| spec.name == "example_query").unwrap_or_else(|| panic!("example_query is offered"));
    assert_eq!(query.input_schema["properties"]["fields"]["items"]["enum"], json!(["name", "tags", "text"]));
    let batch_spec = installed.iter().find(|spec| spec.name == "example_batch").unwrap_or_else(|| panic!("example_batch is offered"));
    assert!(batch_spec.writes);
    assert_eq!(batch_spec.input_schema["properties"]["ops"]["items"]["properties"]["type"]["enum"], json!(["Note", "Tag"]));

    let edited = call(
        kits,
        "example_batch",
        json!({
            "path": path,
            "ops": [
                { "op": "create", "type": "Tag", "fields": { "name": "draft" }, "ref": "$tag", "in": "root.tags" },
                { "op": "text.insert", "target": "root", "field": "text", "index": 5, "text": ", world" }
            ],
            "load": [{ "target": "$tag" }]
        }),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(edited["saved"], true, "{edited}");
    assert_eq!(edited["loaded"][0]["fields"]["name"], "draft");
    let tag = edited["refs"]["$tag"].as_str().unwrap_or_default().to_owned();
    assert!(!tag.is_empty());
    assert_eq!(std::fs::read_to_string(f.workspace.path().join(path)).unwrap_or_default(), "hello, world", "the batch was saved");

    // Following fields from the root, and reading by id.
    let tags = call(kits, "example_query", json!({ "path": path, "follow": "tags", "fields": ["name"] })).await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(tags["objects"], json!([{ "id": tag, "type": "Tag", "fields": { "name": "draft" } }]));
    let first = call(kits, "example_query", json!({ "path": path, "follow": "tags.0" })).await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(first["objects"][0]["id"], tag);

    // Failures answer a code, the failing op's index, and a message.
    let missing = call(
        kits,
        "example_batch",
        json!({ "path": path, "ops": [
            { "op": "text.insert", "target": "root", "field": "text", "index": 0, "text": "x" },
            { "op": "set", "target": "no-such-object", "field": "name", "value": "y" }
        ] }),
    )
    .await
    .err()
    .unwrap_or_else(|| panic!("an op on a missing object fails"));
    assert_eq!(missing["error"]["code"], "not-found", "{missing}");
    assert_eq!(missing["error"]["index"], 1);
    assert_eq!(std::fs::read_to_string(f.workspace.path().join(path)).unwrap_or_default(), "hello, world", "nothing of a failed batch is kept");
    let bad = call(kits, "example_batch", json!({ "path": path, "ops": [{ "op": "paint" }] })).await.err().unwrap_or_default();
    assert_eq!(bad["error"]["code"], "invalid-op", "{bad}");
    let command = call(kits, "example_batch", json!({ "path": path, "ops": [{ "op": "command", "id": "text.append", "params": { "text": "!" } }] }))
        .await
        .err()
        .unwrap_or_default();
    assert_eq!(command["error"]["code"], "command-failed", "{command}");
    let unknown = call(kits, "example_run", json!({ "path": path, "steps": [{ "command": "no.such.command" }] })).await.err().unwrap_or_default();
    assert_eq!(unknown["error"]["code"], "unknown-command", "{unknown}");
    assert_eq!(unknown["error"]["index"], 0);
    assert!(unknown["completed"].is_array(), "what was done is kept");
    let wrong = call(kits, "example_query", json!({ "path": "art/Cover.psd" })).await.err().unwrap_or_default();
    assert_eq!(wrong["error"]["code"], "invalid-params");
    // Drafts live in the person's open editor: a closed file has none.
    let draft =
        call(kits, "example_batch", json!({ "path": path, "draft": true, "ops": [{ "op": "text.set", "target": "root", "field": "text", "text": "x" }] }))
            .await
            .err()
            .unwrap_or_default();
    assert_eq!(draft["error"]["code"], "not-open", "{draft}");
    let no_draft = call(kits, "example_query", json!({ "path": path, "draft": true })).await.err().unwrap_or_default();
    assert_eq!(no_draft["error"]["code"], "not-open");
    kits.shutdown().await;
}

/// `describe` says how each field is written, and `<prefix>_batch` refuses what a writer cannot
/// `set`, saying why and what to use (KHP A16a, A18, A48; KitObjectModel OM1a, OM8): a read-only
/// field, a reference to no object, a text container, and an enum value it does not take. Before,
/// the JSON Schema read `{ "type": "string" }` for all of them, so agents and the conformance tool
/// picked fields they could not write (cad `handle`, note `body`, photo `depth`).
#[tokio::test]
async fn describe_and_batch_tell_the_fields_a_batch_cannot_set() {
    use std::os::unix::fs::PermissionsExt;
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join("Kinds.example"), "hello").unwrap_or_else(|err| panic!("{err}"));
    let script = bin.path().join("kition-example-mock.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nKITION_KIT_MOCK_SCHEMA=every-kind KITION_KIT_MOCK_AS=kit.example:example KITION_KIT_MOCK_VERSION={} exec '{}' \"$@\"\n",
            fixture_kit("example").version,
            mock.display()
        ),
    )
    .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(fixture_kit("example"), Some(script))]);
    let kits = &kits;
    let path = "Kinds.example";

    let full = call(kits, "example_query", json!({ "path": path, "describe": "*" })).await.unwrap_or_else(|err| panic!("{err}"));
    let tag = &full["schema"]["$defs"]["Tag"]["properties"];
    assert_eq!(tag["handle"]["readOnly"], true, "{tag}");
    assert_eq!(tag["color"]["enum"], json!(["red", "green"]));
    assert_eq!(tag["parent"]["x-kdm-ref"], "Tag", "{tag}");
    assert_eq!(full["schema"]["$defs"]["Note"]["properties"]["text"]["x-kdm-ops"], json!(["text.insert", "text.delete", "text.set"]));
    assert_eq!(full["schema"]["$defs"]["Kept"]["readOnly"], true);
    let listing = call(kits, "example_query", json!({ "path": path, "describe": true })).await.unwrap_or_else(|err| panic!("{err}"));
    let types = listing["types"].as_str().unwrap_or_default();
    for marked in ["text: text (text.* ops, not set)", "handle: string, read-only", "parent: ref to Tag", "color: enum red|green", "Kept (read-only)"] {
        assert!(types.contains(marked), "{marked} in {types}");
    }
    let unknown = call(kits, "example_query", json!({ "path": path, "describe": "Tag,Shape" })).await.err().unwrap_or_default();
    assert_eq!(unknown["error"]["code"], "not-found", "{unknown}");
    assert!(unknown["error"]["message"].as_str().unwrap_or_default().contains("its types are Note, Kept, Tag"), "{unknown}");

    let made = call(
        kits,
        "example_batch",
        json!({ "path": path, "ops": [{ "op": "create", "type": "Tag", "fields": { "name": "a" }, "ref": "$a", "in": "root.tags" }] }),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    let id = made["refs"]["$a"].as_str().unwrap_or_default().to_owned();
    let refused = |field: &str, value: Value| json!({ "path": path, "ops": [{ "op": "set", "target": id, "field": field, "value": value }] });
    let read_only = call(kits, "example_batch", refused("handle", json!("H1"))).await.err().unwrap_or_default();
    assert_eq!((&read_only["error"]["code"], &read_only["error"]["index"]), (&json!("read-only"), &json!(0)), "{read_only}");
    let message = read_only["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("`Tag.handle` is read-only") && message.contains("example_query with `describe`") && message.contains("example_commands"),
        "{message}"
    );
    let dangling = call(kits, "example_batch", refused("parent", json!("no-such-tag"))).await.err().unwrap_or_default();
    assert_eq!(dangling["error"]["code"], "not-found", "{dangling}");
    assert!(
        dangling["error"]["message"].as_str().unwrap_or_default().contains("holds the id of a `Tag`, and no object has the id `no-such-tag`"),
        "{dangling}"
    );
    let text = call(kits, "example_batch", json!({ "path": path, "ops": [{ "op": "set", "target": "root", "field": "text", "value": "x" }] }))
        .await
        .err()
        .unwrap_or_default();
    assert_eq!(text["error"]["code"], "invalid-value", "{text}");
    assert!(text["error"]["message"].as_str().unwrap_or_default().contains("text.insert, text.delete, text.set"), "{text}");
    let color = call(kits, "example_batch", refused("color", json!("blue"))).await.err().unwrap_or_default();
    assert!(color["error"]["message"].as_str().unwrap_or_default().contains("takes one of `red`, `green`, not `blue`"), "{color}");
    let linked = call(kits, "example_batch", refused("parent", json!(id))).await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(linked["saved"], true, "a reference to an object that exists is written: {linked}");
    kits.shutdown().await;
}

/// One id space at the tool interface (KHP A44, A46, A47, A48; KitObjectModel OM9): a kit whose
/// schema names each type's tool id (the mock kit's `tool-ids` schema: `frame:<n>`, cells per
/// frame `frame:<n>/cell:<m>`, pins and flags colliding under one empty prefix, tags without)
/// gets them answered and taken by `<prefix>_query`, `<prefix>_batch` and `kit://` object
/// resources, and `describe` says how each type's ids read. Before, query and batch knew only KDM
/// object ids (UUIDs), while the kit's inspect, commands and diagnostics used its numbers.
#[tokio::test]
async fn the_tools_give_a_document_one_id_space() {
    use std::os::unix::fs::PermissionsExt;
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join("Ids.example"), "hello").unwrap_or_else(|err| panic!("{err}"));
    let script = bin.path().join("kition-example-mock.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nKITION_KIT_MOCK_SCHEMA=tool-ids KITION_KIT_MOCK_AS=kit.example:example KITION_KIT_MOCK_VERSION={} exec '{}' \"$@\"\n",
            fixture_kit("example").version,
            mock.display()
        ),
    )
    .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(fixture_kit("example"), Some(script))]);
    let kits = &kits;
    let path = "Ids.example";

    // `describe` says which kind of id each type uses.
    let listing = call(kits, "example_query", json!({ "path": path, "describe": true })).await.unwrap_or_else(|err| panic!("{err}"));
    let types = listing["types"].as_str().unwrap_or_default();
    for marked in ["Frame (ids frame:<number>)", "Cell (ids <Frame id>/cell:<number>)", "Pin (ids <number>)", "Tag (object ids)", "Note (root) (object ids)"] {
        assert!(types.contains(marked), "{marked} in {types}");
    }
    let full = call(kits, "example_query", json!({ "path": path, "describe": "*" })).await.unwrap_or_else(|err| panic!("{err}"));
    let defs = &full["schema"]["$defs"];
    assert_eq!(defs["Cell"]["x-kdm-id"], json!({ "field": "number", "prefix": "cell:", "parent": "Frame" }), "{defs}");
    assert!(defs["Frame"]["description"].as_str().unwrap_or_default().contains("Its id is `frame:<number>`"), "{}", defs["Frame"]);
    assert!(defs["Tag"]["description"].as_str().unwrap_or_default().contains("Its id is its object id"), "{}", defs["Tag"]);
    assert!(defs["Tag"].get("x-kdm-id").is_none());

    // Objects created in a batch are addressed by `$name` within it, and answered with their tool ids.
    let made = call(
        kits,
        "example_batch",
        json!({ "path": path, "ops": [
            { "op": "create", "type": "Frame", "in": "root.frames", "ref": "$one", "fields": { "name": "One" } },
            { "op": "create", "type": "Frame", "in": "root.frames", "ref": "$two", "fields": { "name": "Two" } },
            { "op": "create", "type": "Cell", "in": "$one.cells", "fields": { "label": "a" } },
            { "op": "create", "type": "Cell", "in": "$two.cells", "ref": "$cell", "fields": { "label": "b" } },
            { "op": "set", "target": "$two", "field": "link", "value": "$one" },
            { "op": "create", "type": "Pin", "in": "root.pins" },
            { "op": "create", "type": "Flag", "in": "root.flags" },
            { "op": "create", "type": "Tag", "in": "root.tags", "ref": "$tag", "fields": { "name": "t", "frame": "$two" } }
        ], "load": [{ "target": "$two" }, { "target": "$tag" }] }),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(made["refs"]["$one"], "frame:1", "{made}");
    assert_eq!(made["refs"]["$cell"], "frame:2/cell:1", "{made}");
    for (at, id) in ["frame:1", "frame:2", "frame:1/cell:1", "frame:2/cell:1"].into_iter().enumerate() {
        assert_eq!(made["results"][at], id, "{made}");
    }
    assert_eq!(
        made["loaded"][0],
        json!({ "id": "frame:2", "type": "Frame", "fields": { "cells": ["frame:2/cell:1"], "link": "frame:1", "name": "Two", "number": 2 } })
    );
    let tag = made["refs"]["$tag"].as_str().unwrap_or_default().to_owned();
    assert!(!tag.is_empty() && !tag.contains(':'), "a type without toolId keeps its object id: {tag}");
    assert_eq!(made["loaded"][1]["fields"]["frame"], "frame:2", "a reference answers the tool id it holds");

    // Query answers tool ids, by following fields and by id; batch and loads take them.
    let frames =
        call(kits, "example_query", json!({ "path": path, "follow": "frames", "fields": ["name", "link"] })).await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(frames["objects"][0]["id"], "frame:1", "{frames}");
    assert_eq!(frames["objects"][1]["fields"]["link"], "frame:1", "{frames}");
    let cell = call(kits, "example_query", json!({ "path": path, "objects": ["frame:2/cell:1"] })).await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(cell["objects"][0], json!({ "id": "frame:2/cell:1", "type": "Cell", "fields": { "label": "b", "number": 1 } }));
    let edited = call(
        kits,
        "example_batch",
        json!({ "path": path, "ops": [
            { "op": "set", "target": "frame:1/cell:1", "field": "label", "value": "A" },
            { "op": "set", "target": tag, "field": "frame", "value": "frame:1" }
        ], "load": [{ "target": "frame:1/cell:1", "fields": ["label"] }, { "target": tag, "fields": ["frame"] }] }),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(edited["loaded"][0], json!({ "id": "frame:1/cell:1", "type": "Cell", "fields": { "label": "A" } }), "{edited}");
    assert_eq!(edited["loaded"][1]["fields"]["frame"], "frame:1", "{edited}");

    // The `kit://` object resource takes and answers the same id.
    let uri = kition_kits::resources::KitResource::Object { path: path.to_owned(), id: "frame:2".to_owned() }.uri();
    let resource = kition_kits::resources::read(kits, &uri).await.unwrap_or_else(|err| panic!("{err:?}"));
    let object: Value = serde_json::from_str(resource[0]["text"].as_str().unwrap_or_default()).unwrap_or_default();
    assert_eq!(object["id"], "frame:2", "{object}");

    // An unknown tool id is not-found and lists the ids it may have meant (A48); one that two
    // objects render is refused, listing them by the ids they answer (A44).
    let unknown = call(kits, "example_batch", json!({ "path": path, "ops": [{ "op": "delete", "target": "frame:9" }] })).await.err().unwrap_or_default();
    assert_eq!((&unknown["error"]["code"], &unknown["error"]["index"]), (&json!("not-found"), &json!(0)), "{unknown}");
    let message = unknown["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("no object has the id `frame:9`; the ids starting `frame:` are `frame:1`"), "{message}");
    assert!(!message.contains("command ids"), "the tool ids are the kit's own ids: {message}");
    let bare = call(kits, "example_query", json!({ "path": path, "objects": ["2"] })).await.err().unwrap_or_default();
    assert_eq!(bare["error"]["code"], "not-found", "{bare}");
    assert!(bare["error"]["message"].as_str().unwrap_or_default().contains("these end in `2`: `frame:2`"), "{bare}");
    let ambiguous = call(kits, "example_batch", json!({ "path": path, "ops": [{ "op": "delete", "target": "1" }] })).await.err().unwrap_or_default();
    assert_eq!(ambiguous["error"]["code"], "invalid-op", "{ambiguous}");
    let message = ambiguous["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("`1` names 2 objects (the `Flag` `") && message.contains("and the `Pin` `"), "{message}");
    let pins = call(kits, "example_query", json!({ "path": path, "follow": "pins" })).await.unwrap_or_else(|err| panic!("{err}"));
    let pin = pins["objects"][0]["id"].as_str().unwrap_or_default().to_owned();
    assert!(message.contains(&pin), "the candidates are the ids query answers ({pin}): {message}");
    let deleted = call(kits, "example_batch", json!({ "path": path, "ops": [{ "op": "delete", "target": pin }] })).await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(deleted["results"], json!([null]), "{deleted}");
    let flags = call(kits, "example_query", json!({ "path": path, "follow": "flags" })).await.unwrap_or_else(|err| panic!("{err}"));
    // An integer tool id is a number in `_query`, as in receipts.
    assert_eq!(flags["objects"][0]["id"], 1, "once its id is its own again, the flag answers it: {flags}");
    kits.shutdown().await;
}

/// A renderer window with `path` open in its Example editor, answering `describe` and `batch` as
/// `kitBridge.ts` does; it records the calls it got.
/// The mock kit as Example, running its commands inside a batch as a real kit does
/// (`KITION_KIT_MOCK_BATCH=commands`), on `art/Note.example` ("hello"); with headless drafts.
fn commands_fixture() -> Option<Fixture> {
    use std::os::unix::fs::PermissionsExt;
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return None;
    };
    let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::create_dir_all(workspace.path().join("art")).unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join("art/Note.example"), "hello").unwrap_or_else(|err| panic!("{err}"));
    let script = bin.path().join("kition-example-mock.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nKITION_KIT_MOCK_BATCH=commands KITION_KIT_MOCK_AS=kit.example:example KITION_KIT_MOCK_VERSION={} exec '{}' \"$@\"\n",
            fixture_kit("example").version,
            mock.display()
        ),
    )
    .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(fixture_kit("example"), Some(script))]).with_headless_drafts();
    Some(Fixture { kits, workspace, _bin: bin })
}

/// What the agent's session holds of `art/Note.example` (or of its draft): its text and whether it
/// has unsaved edits.
async fn session_text(kits: &KitManager, draft: bool) -> (Value, Value) {
    let read = call(kits, "example_query", json!({ "path": "art/Note.example", "draft": draft })).await.unwrap_or_else(|err| panic!("{err}"));
    let inspected = call(kits, "example_inspect", json!({ "path": "art/Note.example", "draft": draft })).await.unwrap_or_else(|err| panic!("{err}"));
    (read["objects"][0]["fields"]["text"].clone(), inspected["dirty"].clone())
}

/// A `<prefix>_batch` with a `command` operation is one change (KHP A16) and a failed one leaves
/// the file and the session's document as they were (A18), as `<prefix>_run` does (A53): whether a
/// later operation fails after the command ran, or the command fails after operations ran. On a
/// document with unsaved edits, where only undo could take the command back, such a batch is
/// refused before anything runs, naming `<prefix>_run`. Before, the command's effect stayed in the
/// session after a batch failed at a later operation.
#[tokio::test]
async fn a_failed_batch_with_a_command_changes_nothing() {
    let Some(f) = commands_fixture() else { return };
    let kits = &f.kits;
    let path = "art/Note.example";
    let file = f.workspace.path().join(path);

    // A command, then an operation that fails: the command is taken back.
    let later = call(
        kits,
        "example_batch",
        json!({ "path": path, "ops": [
            { "op": "command", "id": "text.append", "params": { "text": " world" } },
            { "op": "set", "target": "no-such-object", "field": "name", "value": "y" }
        ] }),
    )
    .await
    .err()
    .unwrap_or_else(|| panic!("an op on a missing object fails the batch"));
    assert_eq!(later["error"]["code"], "not-found", "{later}");
    assert_eq!(later["error"]["index"], 1, "{later}");
    assert!(later["error"]["message"].as_str().unwrap_or_default().contains("rolled back"), "{later}");
    assert_eq!(session_text(kits, false).await, (json!("hello"), json!(false)), "the command's edit stayed in the document");
    assert_eq!(std::fs::read_to_string(&file).unwrap_or_default(), "hello");

    // Operations, then a command that fails: the operations are taken back.
    let failing = call(
        kits,
        "example_batch",
        json!({ "path": path, "ops": [
            { "op": "text.insert", "target": "root", "field": "text", "index": 0, "text": "Oh, " },
            { "op": "command", "id": "text.append", "params": {} }
        ] }),
    )
    .await
    .err()
    .unwrap_or_else(|| panic!("a failing command fails the batch"));
    assert_eq!(failing["error"]["code"], "command-failed", "{failing}");
    assert_eq!(failing["error"]["index"], 1, "{failing}");
    assert_eq!(session_text(kits, false).await, (json!("hello"), json!(false)), "the operations before the command stayed");
    assert_eq!(std::fs::read_to_string(&file).unwrap_or_default(), "hello");

    // A batch that succeeds keeps all of it.
    let done = call(
        kits,
        "example_batch",
        json!({ "path": path, "save": false, "ops": [
            { "op": "text.insert", "target": "root", "field": "text", "index": 0, "text": "Oh, " },
            { "op": "command", "id": "text.append", "params": { "text": "!" } }
        ] }),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(done["saved"], false, "{done}");
    assert_eq!(session_text(kits, false).await, (json!("Oh, hello!"), json!(true)));

    // Unsaved edits: a mixed batch could only be taken back by undo, so it is refused upfront.
    let refused = call(
        kits,
        "example_batch",
        json!({ "path": path, "ops": [
            { "op": "command", "id": "text.append", "params": { "text": " again" } },
            { "op": "text.insert", "target": "root", "field": "text", "index": 0, "text": "So " }
        ] }),
    )
    .await
    .err()
    .unwrap_or_else(|| panic!("a mixed batch on unsaved edits is refused"));
    assert_eq!(refused["error"]["code"], "unsupported", "{refused}");
    assert!(refused["error"]["message"].as_str().unwrap_or_default().contains("example_run"), "{refused}");
    assert_eq!(session_text(kits, false).await, (json!("Oh, hello!"), json!(true)), "nothing of the refused batch ran");
    // A command alone, or operations alone, are one change and still run.
    call(kits, "example_batch", json!({ "path": path, "save": false, "ops": [{ "op": "command", "id": "text.clear" }] }))
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(session_text(kits, false).await.0, json!(""));

    // On the agent's headless draft: the draft goes back to what it was before the call.
    let drafted =
        call(kits, "example_batch", json!({ "path": path, "draft": true, "ops": [{ "op": "text.set", "target": "root", "field": "text", "text": "draft" }] }))
            .await
            .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(drafted["draft"], true, "{drafted}");
    let on_draft = call(
        kits,
        "example_batch",
        json!({ "path": path, "draft": true, "ops": [
            { "op": "command", "id": "text.append", "params": { "text": " more" } },
            { "op": "set", "target": "no-such-object", "field": "name", "value": "y" }
        ] }),
    )
    .await
    .err()
    .unwrap_or_else(|| panic!("the draft batch fails"));
    assert_eq!(on_draft["error"]["code"], "not-found", "{on_draft}");
    assert_eq!(session_text(kits, true).await.0, json!("draft"), "the command's edit stayed in the draft");
    kits.shutdown().await;
}

fn editor(kits: &KitManager, path: &str, read_only: bool) -> Arc<Mutex<Vec<Value>>> {
    let bridge = kits.bridge().clone();
    let (session, mut rx) = bridge.connect();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&calls);
    let path = path.to_owned();
    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let Some(id) = message["id"].as_u64() else {
                continue;
            };
            let params = &message["params"];
            let answer = match message["method"].as_str() {
                Some("kit/documents") => {
                    json!({ "result": { "documents": [{ "path": path, "kit": "kit.example", "dirty": false, "revision": 1 }] } })
                }
                Some("kit/call") => {
                    seen.lock().unwrap_or_else(|err| panic!("{err}")).push(params.clone());
                    let arguments = &params["arguments"];
                    let writes = arguments["ops"].as_array().is_some_and(|ops| !ops.is_empty());
                    match params["tool"].as_str() {
                        Some("batch") if read_only && writes => {
                            json!({ "error": { "code": -32000, "message": "the document is read-only", "data": { "code": "read-only", "index": null, "message": "the document is read-only" } } })
                        }
                        Some("batch") => json!({ "result": {
                            "refs": {}, "results": arguments["ops"].as_array().map(|ops| vec![Value::Null; ops.len()]).unwrap_or_default(),
                            "loaded": arguments["load"].as_array().map(|loads| loads.iter().map(|load| json!({ "id": load["target"], "type": "Note", "fields": { "text": if arguments["draft"] == true { "draft text" } else { "live text" } } })).collect::<Vec<_>>()).unwrap_or_default(),
                            "version": [1, 2],
                            "saved": arguments["save"] == true,
                        } }),
                        Some("describe") => {
                            json!({ "result": { "kit": "kit.example", "root": "Note", "rootId": "n1", "types": { "Note": { "fields": { "text": { "kind": "text" } } } } } })
                        }
                        _ => json!({ "error": { "code": -32000, "message": "unexpected tool" } }),
                    }
                }
                _ => continue,
            };
            let mut reply = answer;
            reply["jsonrpc"] = json!("2.0");
            reply["id"] = json!(id);
            let _ = bridge.receive(session, &reply);
        }
    });
    calls
}

#[tokio::test]
async fn a_file_open_in_an_editor_is_queried_and_batched_live() {
    let example = fixture_kit("example");
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(example, None)]);
    let calls = editor(&kits, "art/Live.example", false);

    let read = call(&kits, "example_query", json!({ "path": "art/Live.example", "describe": true })).await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!((read["live"].clone(), read["objects"][0]["fields"]["text"].clone()), (json!(true), json!("live text")));
    assert_eq!(kits.described("kit.example").map(|described| described["root"].clone()), Some(json!("Note")));

    let edited =
        call(&kits, "example_batch", json!({ "path": "art/Live.example", "ops": [{ "op": "text.set", "target": "root", "field": "text", "text": "x" }] }))
            .await
            .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!((edited["live"].clone(), edited["saved"].clone()), (json!(true), json!(true)));
    assert!(edited.get("version").is_none(), "replica versions are not for the model");

    // On the draft: the editor is asked for its draft, and nothing is saved.
    let drafted = call(
        &kits,
        "example_batch",
        json!({ "path": "art/Live.example", "draft": true, "ops": [{ "op": "text.set", "target": "root", "field": "text", "text": "x" }], "load": [{ "target": "root" }] }),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(drafted["draft"], true);
    assert_eq!(drafted["saved"], false);
    assert_eq!(drafted["loaded"][0]["fields"]["text"], "draft text");
    let sent: Vec<Value> = calls.lock().unwrap_or_else(|err| panic!("{err}")).clone();
    let last = sent.last().cloned().unwrap_or_default();
    assert_eq!(last["arguments"]["draft"], true);
    assert!(last["arguments"].get("save").is_none(), "a draft is never saved");
    assert_eq!(last["arguments"]["origin"]["kind"], "agent", "the agent's batches say so");

    // A read-only document refuses writes with `read-only`.
    let readonly = KitManager::new(Some(workspace.path().to_path_buf()), vec![(example, None)]);
    let _calls = editor(&readonly, "art/Shared.example", true);
    let refused = match tools::call(
        &readonly,
        "example_batch",
        &json!({ "path": "art/Shared.example", "ops": [{ "op": "text.set", "target": "root", "field": "text", "text": "x" }] }),
    )
    .await
    {
        Some(Err(error)) => error,
        other => panic!("a read-only document refuses the batch: {other:?}"),
    };
    assert_eq!(refused.code, ErrorCode::READ_ONLY);
    assert_eq!(refused.to_json()["code"], "read-only");
}

#[tokio::test]
async fn a_search_finds_a_command_by_its_keywords_and_says_which() {
    let Some(f) = fixture() else { return };
    let found = call(&f.kits, "example_commands", json!({ "path": "art/Note.example", "query": "boilerplate" })).await.unwrap_or_else(|err| panic!("{err}"));
    let first = &found["commands"][0];
    assert_eq!(first["id"], "text.append", "{found}");
    assert_eq!(first["matched"], json!(["Boilerplate"]), "{found}");
    assert!(found["commands"].as_array().is_some_and(|all| all.iter().all(|c| c.get("keywords").is_none())), "keywords are not listed: {found}");
}
