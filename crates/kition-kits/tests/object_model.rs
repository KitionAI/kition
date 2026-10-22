//! The object-model tools (`<prefix>_query`, `<prefix>_batch`) and structured error codes,
//! against the mock kit standing in for Kition Vector (`KITION_KIT_MOCK_AS`): on the headless
//! kit, and on a live editor through the Kit AI bridge, including drafts and read-only refusals.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing the tests say so and pass.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use kition_kits::tools::{self, ErrorCode};
use kition_kits::{KITS, KitManager};
use serde_json::{Value, json};

fn mock_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.parent()?;
    let path = dir.join("kition-kit-mock");
    path.is_file().then_some(path)
}

/// A launcher that starts the mock kit as `kit.vector` for `.kvector` files.
fn as_vector(dir: &Path, mock: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("kit-vector-mock.sh");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nKITION_KIT_MOCK_AS=kit.vector:kvector exec '{}' \"$@\"\n",
            mock.display()
        ),
    )
    .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
        .unwrap_or_else(|err| panic!("{err}"));
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
    std::fs::write(workspace.path().join("art/Note.kvector"), "hello")
        .unwrap_or_else(|err| panic!("{err}"));
    let vector = KITS
        .iter()
        .find(|kit| kit.id == "kit.vector")
        .unwrap_or_else(|| panic!("kit.vector is a kit"));
    let kits = KitManager::new(
        Some(workspace.path().to_path_buf()),
        vec![(vector, Some(as_vector(bin.path(), &mock)))],
    );
    Some(Fixture {
        kits,
        workspace,
        _bin: bin,
    })
}

async fn call(kits: &KitManager, name: &str, input: Value) -> Result<Value, Value> {
    match tools::call(kits, name, &input).await {
        Some(Ok(output)) => Ok(output.output),
        Some(Err(error)) => Err(error.structured()),
        None => panic!("{name} is not a kit tool"),
    }
}

#[tokio::test]
async fn queries_and_batches_the_headless_kit() {
    let Some(f) = fixture() else { return };
    let kits = &f.kits;
    let path = "art/Note.kvector";

    let read = call(
        kits,
        "vector_query",
        json!({ "path": path, "describe": true }),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(read["objects"][0]["type"], "Note", "{read}");
    assert_eq!(read["objects"][0]["fields"]["text"], "hello");
    assert_eq!(read["describe"]["root"], "Note");
    assert_eq!(
        read["schema"]["$defs"]["Tag"]["properties"]["name"]["type"],
        "string"
    );
    // The schema the kit described shapes the tools' arguments from now on.
    let installed = tools::installed(kits);
    let query = installed
        .iter()
        .find(|spec| spec.name == "vector_query")
        .unwrap_or_else(|| panic!("vector_query is offered"));
    assert_eq!(
        query.input_schema["properties"]["fields"]["items"]["enum"],
        json!(["name", "tags", "text"])
    );
    let batch_spec = installed
        .iter()
        .find(|spec| spec.name == "vector_batch")
        .unwrap_or_else(|| panic!("vector_batch is offered"));
    assert!(batch_spec.writes);
    assert_eq!(
        batch_spec.input_schema["properties"]["ops"]["items"]["properties"]["type"]["enum"],
        json!(["Note", "Tag"])
    );

    let edited = call(
        kits,
        "vector_batch",
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
    let tag = edited["refs"]["$tag"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(!tag.is_empty());
    assert_eq!(
        std::fs::read_to_string(f.workspace.path().join(path)).unwrap_or_default(),
        "hello, world",
        "the batch was saved"
    );

    // Following fields from the root, and reading by id.
    let tags = call(
        kits,
        "vector_query",
        json!({ "path": path, "follow": "tags", "fields": ["name"] }),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(
        tags["objects"],
        json!([{ "id": tag, "type": "Tag", "fields": { "name": "draft" } }])
    );
    let first = call(
        kits,
        "vector_query",
        json!({ "path": path, "follow": "tags.0" }),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(first["objects"][0]["id"], tag);

    // Failures answer a code, the failing op's index, and a message.
    let missing = call(
        kits,
        "vector_batch",
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
    assert_eq!(
        std::fs::read_to_string(f.workspace.path().join(path)).unwrap_or_default(),
        "hello, world",
        "nothing of a failed batch is kept"
    );
    let bad = call(
        kits,
        "vector_batch",
        json!({ "path": path, "ops": [{ "op": "paint" }] }),
    )
    .await
    .err()
    .unwrap_or_default();
    assert_eq!(bad["error"]["code"], "invalid-op", "{bad}");
    let command = call(
        kits,
        "vector_batch",
        json!({ "path": path, "ops": [{ "op": "command", "id": "text.append", "params": { "text": "!" } }] }),
    )
    .await
    .err()
    .unwrap_or_default();
    assert_eq!(command["error"]["code"], "command-failed", "{command}");
    let unknown = call(
        kits,
        "vector_run",
        json!({ "path": path, "steps": [{ "command": "no.such.command" }] }),
    )
    .await
    .err()
    .unwrap_or_default();
    assert_eq!(unknown["error"]["code"], "unknown-command", "{unknown}");
    assert_eq!(unknown["error"]["index"], 0);
    assert!(unknown["completed"].is_array(), "what was done is kept");
    let wrong = call(kits, "vector_query", json!({ "path": "art/Cover.psd" }))
        .await
        .err()
        .unwrap_or_default();
    assert_eq!(wrong["error"]["code"], "invalid-params");
    // Drafts live in the person's open editor: a closed file has none.
    let draft = call(
        kits,
        "vector_batch",
        json!({ "path": path, "draft": true, "ops": [{ "op": "text.set", "target": "root", "field": "text", "text": "x" }] }),
    )
    .await
    .err()
    .unwrap_or_default();
    assert_eq!(draft["error"]["code"], "not-open", "{draft}");
    let no_draft = call(kits, "vector_query", json!({ "path": path, "draft": true }))
        .await
        .err()
        .unwrap_or_default();
    assert_eq!(no_draft["error"]["code"], "not-open");
    kits.shutdown().await;
}

/// A renderer window with `path` open in its Vector editor, answering `describe` and `batch` as
/// `kitBridge.ts` does; it records the calls it got.
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
                    json!({ "result": { "documents": [{ "path": path, "kit": "kit.vector", "dirty": false, "revision": 1 }] } })
                }
                Some("kit/call") => {
                    seen.lock()
                        .unwrap_or_else(|err| panic!("{err}"))
                        .push(params.clone());
                    let arguments = &params["arguments"];
                    let writes = arguments["ops"]
                        .as_array()
                        .is_some_and(|ops| !ops.is_empty());
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
                            json!({ "result": { "kit": "kit.vector", "root": "Note", "rootId": "n1", "types": { "Note": { "fields": { "text": { "kind": "text" } } } } } })
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
    let vector = KITS
        .iter()
        .find(|kit| kit.id == "kit.vector")
        .unwrap_or_else(|| panic!("kit.vector is a kit"));
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(vector, None)]);
    let calls = editor(&kits, "art/Live.kvector", false);

    let read = call(
        &kits,
        "vector_query",
        json!({ "path": "art/Live.kvector", "describe": true }),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(
        (
            read["live"].clone(),
            read["objects"][0]["fields"]["text"].clone()
        ),
        (json!(true), json!("live text"))
    );
    assert_eq!(
        kits.described("kit.vector")
            .map(|described| described["root"].clone()),
        Some(json!("Note"))
    );

    let edited = call(
        &kits,
        "vector_batch",
        json!({ "path": "art/Live.kvector", "ops": [{ "op": "text.set", "target": "root", "field": "text", "text": "x" }] }),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(
        (edited["live"].clone(), edited["saved"].clone()),
        (json!(true), json!(true))
    );
    assert!(
        edited.get("version").is_none(),
        "replica versions are not for the model"
    );

    // On the draft: the editor is asked for its draft, and nothing is saved.
    let drafted = call(
        &kits,
        "vector_batch",
        json!({ "path": "art/Live.kvector", "draft": true, "ops": [{ "op": "text.set", "target": "root", "field": "text", "text": "x" }], "load": [{ "target": "root" }] }),
    )
    .await
    .unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(drafted["draft"], true);
    assert_eq!(drafted["saved"], false);
    assert_eq!(drafted["loaded"][0]["fields"]["text"], "draft text");
    let sent: Vec<Value> = calls.lock().unwrap_or_else(|err| panic!("{err}")).clone();
    let last = sent.last().cloned().unwrap_or_default();
    assert_eq!(last["arguments"]["draft"], true);
    assert!(
        last["arguments"].get("save").is_none(),
        "a draft is never saved"
    );
    assert_eq!(
        last["arguments"]["origin"]["kind"], "agent",
        "the agent's batches say so"
    );

    // A read-only document refuses writes with `read-only`.
    let readonly = KitManager::new(Some(workspace.path().to_path_buf()), vec![(vector, None)]);
    let _calls = editor(&readonly, "art/Shared.kvector", true);
    let refused = match tools::call(
        &readonly,
        "vector_batch",
        &json!({ "path": "art/Shared.kvector", "ops": [{ "op": "text.set", "target": "root", "field": "text", "text": "x" }] }),
    )
    .await
    {
        Some(Err(error)) => error,
        other => panic!("a read-only document refuses the batch: {other:?}"),
    };
    assert_eq!(refused.code, ErrorCode::READ_ONLY);
    assert_eq!(refused.to_json()["code"], "read-only");
}
