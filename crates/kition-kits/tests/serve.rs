// Copied from kition-sdk crates/kition-kits/tests/serve.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `kition-kits serve` as a host in any language uses it: one process, newline-delimited JSON-RPC
//! on its standard input and output, files named by workspace paths. The kit behind it is the mock
//! kit standing in for Kition Vector, installed in a kits folder as an SDK bundle installs kits.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing the test says so and passes.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

const SERVE: &str = env!("CARGO_BIN_EXE_kition-kits");
const SCHEMA: &str = include_str!("../../../contracts/kit/kits-service.schema.json");

/// Validates `value` against `$defs/<def>` of the Kits Service API schema.
fn check(def: &str, value: &Value) {
    let mut schema: Value = serde_json::from_str(SCHEMA).unwrap();
    assert!(schema["$defs"].get(def).is_some(), "no $defs/{def}");
    schema["$ref"] = json!(format!("#/$defs/{def}"));
    let validator = jsonschema::validator_for(&schema).unwrap();
    let errors: Vec<String> = validator.iter_errors(value).map(|error| format!("{error} at {}", error.instance_path())).collect();
    assert!(errors.is_empty(), "{def}: {value}\n{}", errors.join("\n"));
}

fn mock_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.parent()?.join("kition-kit-mock");
    path.is_file().then_some(path)
}

/// A kits folder with the vector kit's manifest and, as its executable, the mock kit.
fn kits_dir(dir: &Path, mock: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let kit = dir.join("kits/vector");
    std::fs::create_dir_all(&kit).unwrap();
    let manifest = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/kits/vector.json")).unwrap();
    std::fs::write(kit.join("kit.json"), manifest).unwrap();
    let executable = kit.join("kition-vector");
    std::fs::write(&executable, format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.vector:kvector:vector exec '{}' \"$@\"\n", mock.display())).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    dir.join("kits")
}

struct Service {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Lines<BufReader<ChildStdout>>,
    next: i64,
}

impl Service {
    fn start(workspace: &Path, kits: &Path) -> Self {
        let mut child = tokio::process::Command::new(SERVE)
            .args(["serve", "--workspace"])
            .arg(workspace)
            .arg("--kits-dir")
            .arg(kits)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        Self { child, stdin, stdout, next: 0 }
    }

    /// One request, as a line, and its answer.
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, Value> {
        self.next += 1;
        let line = format!("{}\n", json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params }));
        self.stdin.as_mut().unwrap().write_all(line.as_bytes()).await.unwrap();
        let answer = tokio::time::timeout(Duration::from_secs(30), self.stdout.next_line()).await.unwrap().unwrap().unwrap();
        let answer: Value = serde_json::from_str(&answer).unwrap();
        assert_eq!(answer["id"], self.next, "{answer}");
        match answer.get("error") {
            Some(error) => Err(error.clone()),
            None => Ok(answer["result"].clone()),
        }
    }
}

#[tokio::test]
async fn a_host_opens_edits_and_saves_by_path_and_hears_of_conflicts() {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("work");
    std::fs::create_dir_all(workspace.join("art")).unwrap();
    std::fs::write(workspace.join("art/Note.kvector"), "hello").unwrap();
    let mut service = Service::start(&workspace, &kits_dir(dir.path(), &mock));

    let initialized = service.call("kits.initialize", json!({ "client": { "name": "test", "version": "0" } })).await.unwrap();
    check("initializeResult", &initialized);
    assert_eq!(initialized["serviceVersion"], 1);
    assert_eq!(initialized["protocolVersion"], 2);
    let vector = initialized["kits"].as_array().unwrap().iter().find(|kit| kit["id"] == "kit.vector").cloned().unwrap();
    assert_eq!(vector["installed"], true, "{initialized}");

    let opened = service.call("documents.open", json!({ "path": "art/Note.kvector" })).await.unwrap();
    check("document", &opened);
    assert_eq!((opened["kitId"].as_str(), opened["path"].as_str(), opened["dirty"].as_bool()), (Some("kit.vector"), Some("art/Note.kvector"), Some(false)));
    let document = json!({ "kit": "kit.vector", "documentId": opened["documentId"] });

    // The host's own change on the person's behalf, then a save through the kit's files.*.
    let append = |text: &str, origin: &str| json!({ "kit": "kit.vector", "documentId": opened["documentId"], "command": "text.append", "params": { "text": text }, "origin": origin });
    let executed = service.call("commands.execute", append(" world", "system")).await.unwrap();
    check("executeResult", &executed);
    assert_eq!(executed["changed"], true);
    assert_eq!(executed["document"]["dirty"], true);
    let saved = service.call("documents.save", document.clone()).await.unwrap();
    assert_eq!(saved["dirty"], false);
    assert_eq!(std::fs::read_to_string(workspace.join("art/Note.kvector")).unwrap(), "hello world");

    // Someone else changes the file: the next save is a conflict, and their change stays.
    tokio::time::sleep(Duration::from_millis(20)).await;
    std::fs::write(workspace.join("art/Note.kvector"), "theirs").unwrap();
    service.call("commands.execute", append("!", "user")).await.unwrap();
    let conflict = service.call("documents.save", document.clone()).await.unwrap_err();
    assert_eq!((conflict["code"].as_i64(), conflict["data"]["reason"].as_str()), (Some(-32015), Some("file_conflict")), "{conflict}");
    check("error", &conflict);
    assert_eq!(std::fs::read_to_string(workspace.join("art/Note.kvector")).unwrap(), "theirs");
    // The document says it is in conflict; reloading takes the file (kition-sdk#6).
    let current = service.call("documents.get", document.clone()).await.unwrap();
    assert_eq!((current["conflict"].as_bool(), current["dirty"].as_bool()), (Some(true), Some(true)), "{current}");
    let reloaded = service.call("documents.reload", document.clone()).await.unwrap();
    check("document", &reloaded);
    assert_eq!((reloaded["conflict"].as_bool(), reloaded["dirty"].as_bool()), (Some(false), Some(false)), "{reloaded}");
    // A change outside the kits, told to the service, puts a dirty document in conflict at once.
    service.call("commands.execute", append("?", "user")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    std::fs::write(workspace.join("art/Note.kvector"), "theirs again").unwrap();
    service.call("documents.changedOnDisk", json!({ "path": "art/Note.kvector" })).await.unwrap();
    let told = service.call("documents.get", document.clone()).await.unwrap();
    assert_eq!(told["conflict"], true, "{told}");
    service.call("documents.reload", document.clone()).await.unwrap();

    // Nothing outside the workspace or hidden; a new document never replaces a file.
    for path in ["../escape.kvector", ".kition/drafts/a.kvector"] {
        let refused = service.call("documents.open", json!({ "path": path })).await.unwrap_err();
        assert_eq!(refused["data"]["reason"], "file_not_allowed", "{path}: {refused}");
        check("error", &refused);
    }
    let created = service.call("documents.create", json!({ "path": "art/Note.kvector" })).await.unwrap();
    assert_eq!(created["path"], "art/Note 2.kvector");
    assert!(workspace.join("art/Note 2.kvector").is_file());

    let preview = service.call("documents.preview", json!({ "kit": "kit.vector", "documentId": created["documentId"], "maxSize": 64 })).await.unwrap();
    check("previewResult", &preview);
    let commands = service.call("commands.list", json!({ "kit": "kit.vector", "documentId": created["documentId"] })).await.unwrap();
    check("commandsListResult", &commands);
    assert!(commands["commands"].as_array().unwrap().iter().any(|command| command["id"] == "text.append"));
    let unknown = service.call("documents.open", json!({ "path": "art/a.unknown" })).await.unwrap_err();
    assert_eq!(unknown["data"]["reason"], "invalid_path", "{unknown}");
    check("error", &unknown);
    let missing = service.call("no.such.method", json!({})).await.unwrap_err();
    assert_eq!(missing["code"], -32601);
    // Every method the schema lists is served (it may refuse these parameters, never the method).
    let schema: Value = serde_json::from_str(SCHEMA).unwrap();
    for method in schema["methods"].as_object().unwrap().keys() {
        if let Err(error) = service.call(method, json!({})).await {
            assert_ne!(error["code"], -32601, "{method} is in the schema but not served");
        }
    }

    // Closing standard input ends the service and its kits.
    drop(service.stdin.take());
    let status = tokio::time::timeout(Duration::from_secs(15), service.child.wait()).await.unwrap().unwrap();
    assert!(status.success(), "{status}");
}
