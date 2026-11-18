// Copied from kition-sdk crates/kition-kits/tests/drafts.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Headless drafts through `kition-kits-mcp`, as an integrator runs them (KHP A12 to
//! A15): with `--drafts`, the agent's edits go to a draft in the workspace's `.kition/drafts/`
//! and leave the file alone; the agent checks the draft and asks for review; the person lists,
//! compares, and merges it with `kition-kits-mcp drafts`, which is refused while the file changed
//! since the draft forked. Merge and discard are never tools.
//!
//! The SDK's mock executable exercises these paths with a synthetic manifest. A kit whose headless executable forks the file's
//! replica (`model.export`, then `model.open`) keeps replica drafts; one whose replica does not
//! fork keeps a copy of the file and says why in `draft.json` (`replicaError`).

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout};

const MCP: &str = env!("CARGO_BIN_EXE_kition-kits-mcp");

struct Case {
    prefix: &'static str,
    fixture: &'static str,
    step: fn() -> Value,
    mode: &'static str,
}

const CASES: &[Case] =
    &[Case { prefix: "example", fixture: "Plan.example", step: || json!({ "command": "text.append", "params": { "text": "# Agenda\n\n" } }), mode: "replica" }];

fn replica_kit() -> (tempfile::TempDir, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let mock = mock_binary().expect("build kition-kit-mock first");
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("kit.json"), include_str!("support/example.json")).unwrap();
    std::fs::write(dir.path().join("Plan.example"), "plan").unwrap();
    let executable = dir.path().join("kition-example");
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\nKITION_KIT_MOCK_AS=kit.example:example KITION_KIT_MOCK_VERSION=0.1.0 KITION_KIT_MOCK_REPLICA=full exec '{}' \"$@\"\n",
            mock.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    (dir, executable)
}

fn sha256(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

struct Server {
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next: u64,
}

impl Server {
    async fn request(&mut self, method: &str, params: Value) -> Value {
        self.next += 1;
        let message = json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params });
        self.stdin.write_all(format!("{message}\n").as_bytes()).await.unwrap_or_else(|err| panic!("{err}"));
        let line = tokio::time::timeout(std::time::Duration::from_secs(120), self.lines.next_line())
            .await
            .unwrap_or_else(|_| panic!("{method} timed out"))
            .unwrap_or_else(|err| panic!("{err}"))
            .unwrap_or_else(|| panic!("the server closed its output"));
        serde_json::from_str(&line).unwrap_or_else(|err| panic!("{err}: {line}"))
    }

    async fn tool(&mut self, name: &str, arguments: Value) -> Value {
        let answer = self.request("tools/call", json!({ "name": name, "arguments": arguments })).await;
        answer["result"].clone()
    }
}

/// `kition-kits-mcp drafts <args>`: its JSON and whether it succeeded.
async fn drafts(workspace: &Path, executable: &Path, args: &[&str]) -> (Value, bool) {
    let output = tokio::process::Command::new(MCP)
        .arg("drafts")
        .args(args)
        .arg("--workspace")
        .arg(workspace)
        .arg("--kit")
        .arg(executable)
        .output()
        .await
        .unwrap_or_else(|err| panic!("{err}"));
    let text = String::from_utf8_lossy(&output.stdout);
    let json = serde_json::from_str(&text).unwrap_or_else(|err| panic!("{err}: {text}"));
    (json, output.status.success())
}

#[tokio::test]
async fn an_agent_drafts_headless_and_the_person_merges() {
    let (kit, executable) = replica_kit();
    for case in CASES {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = dir.path();
        let fixture = kit.path().join(case.fixture);
        let file = workspace.join(case.fixture);
        std::fs::copy(&fixture, &file).unwrap_or_else(|err| panic!("{err}"));
        let original = sha256(&file);

        let mut child = tokio::process::Command::new(MCP)
            .arg("--workspace")
            .arg(workspace)
            .arg("--kit")
            .arg(&executable)
            .arg("--drafts")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap_or_else(|err| panic!("{err}"));
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            panic!("no pipes");
        };
        let mut server = Server { stdin, lines: BufReader::new(stdout).lines(), next: 0 };
        server.request("initialize", json!({ "protocolVersion": "2025-06-18" })).await;
        let listed = server.request("tools/list", json!({})).await;
        let names: Vec<&str> = listed["result"]["tools"].as_array().into_iter().flatten().filter_map(|tool| tool["name"].as_str()).collect();
        assert!(!names.iter().any(|name| name.contains("merge") || name.contains("discard")), "{names:?}");

        let path = case.fixture;
        let missing = server.tool(&format!("{}_draft_ready", case.prefix), json!({ "path": path })).await;
        assert_eq!(missing["structuredContent"]["error"]["code"], "draft-required", "{missing}");

        // `--drafts`: an edit without `draft` goes to a draft.
        let ran = server.tool(&format!("{}_run", case.prefix), json!({ "path": path, "steps": [(case.step)()] })).await;
        assert_eq!(ran["isError"], false, "{ran}");
        assert_eq!(ran["structuredContent"]["draft"], true, "{ran}");
        assert_eq!(sha256(&file), original, "the file is unchanged until the person merges");
        let checked = server.tool(&format!("{}_check", case.prefix), json!({ "path": path, "draft": true })).await;
        assert_eq!(checked["isError"], false, "{checked}");
        assert!(checked["content"][0]["text"].as_str().unwrap_or_default().contains("your draft"), "{checked}");
        let ready = server.tool(&format!("{}_draft_ready", case.prefix), json!({ "path": path })).await;
        assert_eq!(ready["structuredContent"]["state"], "ready", "{ready}");
        drop(server);
        let _ = child.kill().await;

        let (listed, ok) = drafts(workspace, &executable, &["list"]).await;
        assert!(ok, "{listed}");
        assert_eq!(listed["drafts"][0]["path"], path);
        assert_eq!(listed["drafts"][0]["state"], "ready");
        assert_eq!(listed["drafts"][0]["mode"], case.mode);
        assert_eq!(listed["drafts"][0]["stale"], false);

        let (compared, ok) = drafts(workspace, &executable, &["compare", path]).await;
        assert!(ok, "{compared}");
        if case.mode == "replica" {
            let listed = |side: &str| compared["diff"][side].as_array().is_some_and(|objects| !objects.is_empty());
            assert!(listed("changed") || listed("created"), "{compared}");
        } else {
            assert!(compared["diff"].is_null() && compared["diffUnavailable"].is_string(), "{compared}");
        }

        // The file changes under the draft: merging would drop that, so it is refused.
        let mut changed = std::fs::read(&file).unwrap_or_default();
        let kept = changed.clone();
        changed.push(b'\n');
        std::fs::write(&file, &changed).unwrap_or_else(|err| panic!("{err}"));
        let (refused, ok) = drafts(workspace, &executable, &["merge", path]).await;
        assert!(!ok);
        assert_eq!(refused["error"]["code"], "stale", "{refused}");
        std::fs::write(&file, &kept).unwrap_or_else(|err| panic!("{err}"));

        let (merged, ok) = drafts(workspace, &executable, &["merge", path]).await;
        assert!(ok, "{merged}");
        assert_ne!(sha256(&file), original, "the draft is the file now");
        let (listed, _) = drafts(workspace, &executable, &["list"]).await;
        assert_eq!(listed["drafts"], json!([]), "a merged draft closes");
        let (gone, ok) = drafts(workspace, &executable, &["discard", path]).await;
        assert!(!ok);
        assert_eq!(gone["error"]["code"], "not-found");
    }
}

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

/// A draft that could not fork the file's replica keeps a copy of the file, and says why: the
/// kit's error is in `drafts list` (`replicaError`) and in the comparison's `diffUnavailable`.
/// The mock kit, standing in for Example, has no `model.export`.
#[tokio::test]
async fn a_file_draft_says_why_it_is_not_a_replica() {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let path = "Plan.example";
    let file = workspace.path().join(path);
    std::fs::write(&file, "plan").unwrap_or_else(|err| panic!("{err}"));
    let original = sha256(&file);
    let kits = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let example = kits.path().join("example-ui");
    std::fs::create_dir_all(&example).unwrap_or_else(|err| panic!("{err}"));
    std::fs::copy(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/support/example.json"), example.join("kit.json")).unwrap_or_else(|err| panic!("{err}"));
    let launcher = example.join(format!("kition-example{}", std::env::consts::EXE_SUFFIX));
    // The person's `drafts` commands start the kit too: the launcher names what the mock stands in for.
    let manifest = std::fs::read_to_string(example.join("kit.json")).unwrap_or_else(|err| panic!("{err}"));
    let version = serde_json::from_str::<serde_json::Value>(&manifest).unwrap()["version"].as_str().unwrap().to_owned();
    std::fs::write(
        &launcher,
        format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.example:example KITION_KIT_MOCK_VERSION={version} exec '{}' \"$@\"\n", mock.display()),
    )
    .unwrap_or_else(|err| panic!("{err}"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    }
    let mut command = tokio::process::Command::new(MCP);
    for (key, _) in std::env::vars() {
        if key.starts_with("KITION_KIT_") && key.ends_with("_BINARY") {
            command.env_remove(key);
        }
    }
    let mut child = command
        .arg("--workspace")
        .arg(workspace.path())
        .arg("--kits-dir")
        .arg(kits.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap_or_else(|err| panic!("{err}"));
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        panic!("no pipes");
    };
    let mut server = Server { stdin, lines: BufReader::new(stdout).lines(), next: 0 };
    server.request("initialize", json!({ "protocolVersion": "2025-06-18" })).await;
    let step = json!({ "command": "text.append", "params": { "text": " and more" } });
    let ran = server.tool("example_run", json!({ "path": path, "draft": true, "steps": [step] })).await;
    assert_eq!(ran["isError"], false, "{ran}");
    assert_eq!(sha256(&file), original, "the draft edit wrote the file");
    drop(server);
    let _ = child.kill().await;

    let draft: Value = std::fs::read_dir(workspace.path().join(".kition/drafts"))
        .into_iter()
        .flatten()
        .flatten()
        .find_map(|entry| std::fs::read_to_string(entry.path().join("draft.json")).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| panic!("no draft was stored"));
    assert_eq!(draft["mode"], "file", "{draft}");
    let reason = draft["replicaError"].as_str().unwrap_or_else(|| panic!("the draft does not say why it is a copy of the file: {draft}"));
    assert!(reason.contains("model.export"), "{reason}");
    let (compared, ok) = drafts(workspace.path(), &launcher, &["compare", path]).await;
    assert!(ok, "{compared}");
    assert!(compared["diff"].is_null(), "{compared}");
    assert!(compared["diffUnavailable"].as_str().is_some_and(|why| why.contains(reason)), "{compared}");
}

async fn start(workspace: &Path, executable: &Path) -> (Server, tokio::process::Child) {
    let mut child = tokio::process::Command::new(MCP)
        .arg("--workspace")
        .arg(workspace)
        .arg("--kit")
        .arg(executable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap_or_else(|err| panic!("{err}"));
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        panic!("no pipes");
    };
    let mut server = Server { stdin, lines: BufReader::new(stdout).lines(), next: 0 };
    server.request("initialize", json!({ "protocolVersion": "2025-06-18" })).await;
    (server, child)
}

/// What a live `<prefix>_inspect` answers about the document, without its preview and without
/// object ids, which some kits number per session (a replica opened first takes the next ones).
async fn live_state(server: &mut Server, prefix: &str, path: &str) -> Value {
    let answer = server.tool(&format!("{prefix}_inspect"), json!({ "path": path, "preview": false, "draft": false })).await;
    assert_eq!(answer["isError"], false, "{answer}");
    without_ids(answer["structuredContent"].clone())
}

fn without_ids(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.into_iter().filter(|(key, _)| key != "id").map(|(key, value)| (key, without_ids(value))).collect()),
        Value::Array(items) => Value::Array(items.into_iter().map(without_ids).collect()),
        other => other,
    }
}

/// KHP A12 to A15: a replica draft never stands in for the file. Editing it leaves the file byte
/// for byte, live reads in the same server and after a restart see the file, not the draft, and
/// the draft keeps its edit even when the replica opens before the file.
#[tokio::test]
async fn a_replica_draft_never_changes_or_stands_in_for_the_file() {
    let (kit, executable) = replica_kit();
    let kits = [("example", executable, kit.path().join("Plan.example"), json!([{ "command": "text.append", "params": { "text": " updated" } }]))];
    for (prefix, executable, fixture, steps) in kits {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = dir.path();
        let path = fixture.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let file = workspace.join(&path);
        std::fs::copy(&fixture, &file).unwrap_or_else(|err| panic!("{err}"));
        let original = sha256(&file);

        let (mut server, mut child) = start(workspace, &executable).await;
        let before = live_state(&mut server, prefix, &path).await;
        let ran = server.tool(&format!("{prefix}_run"), json!({ "path": path, "draft": true, "steps": steps })).await;
        assert_eq!(ran["isError"], false, "{prefix}: {ran}");
        assert_eq!(sha256(&file), original, "{prefix}: the draft edit wrote the file");
        assert_eq!(live_state(&mut server, prefix, &path).await, before, "{prefix}: a live read saw the draft");
        drop(server);
        let _ = child.kill().await;
        assert_eq!(sha256(&file), original, "{prefix}: stopping the server wrote the file");

        // A new server opens the draft first, then the file: the file is still the file.
        let (mut server, mut child) = start(workspace, &executable).await;
        let draft = server.tool(&format!("{prefix}_inspect"), json!({ "path": path, "preview": true, "draft": true })).await;
        assert_eq!(draft["isError"], false, "{prefix}: {draft}");
        let live = live_state(&mut server, prefix, &path).await;
        assert_eq!(live, before, "{prefix}: after a restart, a live read saw the draft");
        // What the agent sees of each: the kit's report and its preview, the rendered part the edit
        // is on (a shape added to a slide leaves the deck's report as it was).
        let seen = |answer: &Value| {
            let previews: Vec<&Value> =
                answer["content"].as_array().into_iter().flatten().filter(|item| item["type"] == "image").map(|item| &item["data"]).collect();
            assert!(!previews.is_empty(), "{prefix}: no preview: {answer}");
            let state = without_ids(answer["structuredContent"].clone());
            json!({ "summary": state["summary"], "details": state["details"], "content": state["content"], "previews": previews })
        };
        let live = server.tool(&format!("{prefix}_inspect"), json!({ "path": path, "preview": true, "draft": false })).await;
        assert_ne!(seen(&draft), seen(&live), "{prefix}: the draft lost its edit");
        drop(server);
        let _ = child.kill().await;
        assert_eq!(sha256(&file), original, "{prefix}: the file changed before any merge");

        // A replica draft holds the edit as objects too: the person's comparison lists them. A kit
        // whose replica does not fork keeps a copy of the file and says why (`replicaError`).
        let (listed, ok) = drafts(workspace, &executable, &["list"]).await;
        assert!(ok, "{prefix}: {listed}");
        let stored = &listed["drafts"][0];
        if stored["mode"] == "replica" {
            let (compared, ok) = drafts(workspace, &executable, &["compare", &path]).await;
            assert!(ok, "{prefix}: {compared}");
            let objects = |side: &str| compared["diff"][side].as_array().is_some_and(|objects| !objects.is_empty());
            assert!(objects("created") || objects("changed"), "{prefix}: the draft's objects lost the edit: {compared}");
        } else {
            assert!(stored["replicaError"].is_string(), "{prefix}: {stored}");
            eprintln!("{prefix}: a copy of the file, not a replica: {}", stored["replicaError"]);
        }
    }
}

/// `--drafts` with a kit that does not declare drafts (`agent.drafts` false; the mock stands in
/// for Example): such a kit keeps no drafts and offers no draft tools (KHP A12: "a kit that supports
/// drafts says so in its manifest"; A35), and the server chose not to edit files directly, so an
/// edit without `draft` is refused `unsupported` and changes nothing, as is one that asks for a
/// draft; only `draft: false` edits the file itself. No draft is stranded where neither the
/// document nor `drafts list` shows it, and the instructions name the kit. Before, the edit went
/// to a draft that no `plain_draft_ready` could hand to the person.
#[tokio::test]
async fn draft_mode_refuses_edits_of_a_kit_without_drafts() {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let path = "Screen.plain";
    let file = workspace.path().join(path);
    std::fs::write(&file, "screen").unwrap_or_else(|err| panic!("{err}"));
    let kits = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let plain = kits.path().join("plain");
    std::fs::create_dir_all(&plain).unwrap_or_else(|err| panic!("{err}"));
    let mut manifest: Value = serde_json::from_str(include_str!("support/example.json")).unwrap_or_else(|err| panic!("{err}"));
    manifest["id"] = json!("kit.plain");
    manifest["formats"][0]["extensions"] = json!(["plain"]);
    manifest["agent"]["prefix"] = json!("plain");
    manifest["agent"]["drafts"] = json!(false);
    manifest["headless"]["executable"] = json!("kition-plain");
    std::fs::write(plain.join("kit.json"), manifest.to_string()).unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(manifest["agent"]["drafts"], false, "the fixture is a kit without drafts");
    let launcher = plain.join(format!("kition-plain{}", std::env::consts::EXE_SUFFIX));
    std::fs::write(
        &launcher,
        format!(
            "#!/bin/sh\nKITION_KIT_MOCK_AS=kit.plain:plain KITION_KIT_MOCK_VERSION={} exec '{}' \"$@\"\n",
            manifest["version"].as_str().unwrap_or_default(),
            mock.display()
        ),
    )
    .unwrap_or_else(|err| panic!("{err}"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    }
    let mut command = tokio::process::Command::new(MCP);
    for (key, _) in std::env::vars() {
        if key.starts_with("KITION_KIT_") && key.ends_with("_BINARY") {
            command.env_remove(key);
        }
    }
    let mut child = command
        .arg("--workspace")
        .arg(workspace.path())
        .arg("--kits-dir")
        .arg(kits.path())
        .arg("--drafts")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap_or_else(|err| panic!("{err}"));
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        panic!("no pipes");
    };
    let mut server = Server { stdin, lines: BufReader::new(stdout).lines(), next: 0 };
    let init = server.request("initialize", json!({ "protocolVersion": "2025-06-18" })).await;
    let instructions = init["result"]["instructions"].as_str().unwrap_or_default().to_owned();
    assert!(!instructions.contains("draft_ready"), "no kit here offers a draft tool: {instructions}");
    assert!(instructions.contains("`plain_*` keep no drafts") && instructions.contains("`draft: false`"), "{instructions}");
    let listed = server.request("tools/list", json!({})).await;
    let names: Vec<&str> = listed["result"]["tools"].as_array().into_iter().flatten().filter_map(|tool| tool["name"].as_str()).collect();
    assert!(!names.iter().any(|name| name.contains("draft")), "{names:?}");

    // An edit without `draft`, and one that asks for a draft: refused, and the file is as it was.
    let step = json!({ "command": "text.append", "params": { "text": " v2" } });
    for arguments in [json!({ "path": path, "steps": [step] }), json!({ "path": path, "draft": true, "steps": [step] })] {
        let refused = server.tool("plain_run", arguments).await;
        assert_eq!(refused["structuredContent"]["error"]["code"], "unsupported", "{refused}");
        let message = refused["structuredContent"]["error"]["message"].as_str().unwrap_or_default();
        assert!(message.contains("agent.drafts") && message.contains("draft: false"), "{message}");
        assert_eq!(std::fs::read_to_string(&file).unwrap_or_default(), "screen");
    }
    let batch = server.tool("plain_batch", json!({ "path": path, "ops": [{ "op": "text.set", "target": "root", "field": "text", "text": "x" }] })).await;
    assert_eq!(batch["structuredContent"]["error"]["code"], "unsupported", "{batch}");
    // Reads need no draft: they read the file.
    let inspected = server.tool("plain_inspect", json!({ "path": path })).await;
    assert_eq!(inspected["isError"], false, "{inspected}");
    // `draft: false` edits the file itself.
    let ran = server.tool("plain_run", json!({ "path": path, "draft": false, "steps": [step] })).await;
    assert_eq!(ran["isError"], false, "{ran}");
    assert_eq!(std::fs::read_to_string(&file).unwrap_or_default(), "screen v2");
    drop(server);
    let _ = child.kill().await;

    // Nothing is stranded in a draft.
    let (drafted, ok) = drafts(workspace.path(), &launcher, &["list"]).await;
    assert!(ok, "{drafted}");
    assert_eq!(drafted["drafts"], json!([]), "{drafted}");
}
