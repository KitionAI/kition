// Copied from kition-sdk crates/kition-kits/tests/headless_runs.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `<prefix>_run` on a file the headless kit edits (no draft, no open editor), against the mock
//! kit: what other projects rely on when an agent edits files through `kition-kits-mcp`.
//!
//! - A run is atomic (KHP A53): when a step fails, the document and its file are as they were
//!   before the call, unsaved edits of earlier calls included; the error gives the failing step's
//!   `index`, lists the steps it rolled back (`rolledBack`), and answers `completed` empty.
//! - The run's target (A46, A54): the ids `<prefix>_inspect` lists for a part work in a run with
//!   that part as `target`, whatever part was current; with another `target` the same id reaches
//!   that part's object or fails, never the first part's. The mock's slides mode
//!   (`KITION_KIT_MOCK_PARTS=slides`) numbers objects per slide, so the same id is on every slide.
//! - Changes made outside the agent's calls (A56): the next inspect says so in `changedOutside`,
//!   the next run is refused once (`failed`, retryable) and changes nothing, and the run after it
//!   proceeds. A file the agent saved itself is not reported.
//!
//! Cases: `sdk.agent.headless-runs/atomic-run`, `sdk.agent.headless-runs/run-target`,
//! `sdk.agent.headless-runs/changed-outside`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, tests that can skip it say so and pass. CI requires it.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use kition_kits::tools;
use kition_kits::{KitDefinition, KitManager};
use serde_json::{Value, json};

/// A kit `kit.<name>` editing `.<name>` files. Each test names its own kit: the tools find kits
/// by prefix in one registry per process.
fn kit(name: &str) -> &'static KitDefinition {
    let manifest = json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": format!("Kition {name}"), "version": "0.0.0",
        "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
        "agent": { "prefix": name, "tools": "document" },
        "headless": { "executable": "kition-kit-mock", "protocol": "kition-kit/2" }
    });
    KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"))
}

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

/// A launcher that starts the mock kit as `kit.<name>` for `.<name>` files, with `env`
/// (`NAME=value …`) set for it.
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
    workspace: tempfile::TempDir,
    _bin: tempfile::TempDir,
}

impl Fixture {
    /// The kit `name` (the mock with `env`) on a workspace holding `files` (name, text).
    fn new(name: &str, env: &str, files: &[(&str, &str)]) -> Option<Self> {
        let Some(mock) = mock_binary() else {
            eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
            return None;
        };
        let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        for (file, text) in files {
            std::fs::write(workspace.path().join(file), text).unwrap_or_else(|err| panic!("{err}"));
        }
        let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit(name), Some(as_kit(bin.path(), &mock, name, env)))]);
        Some(Self { kits, workspace, _bin: bin })
    }

    /// A tool's answer, or its error as the tool answers it (`{ error, …output }`).
    async fn call(&self, tool: &str, input: Value) -> Result<Value, Value> {
        match tools::call(&self.kits, tool, &input).await {
            Some(Ok(output)) => Ok(output.output),
            Some(Err(error)) => Err(error.structured()),
            None => panic!("{tool} is not a kit tool"),
        }
    }

    async fn ok(&self, tool: &str, input: Value) -> Value {
        self.call(tool, input).await.unwrap_or_else(|error| panic!("{tool}: {error}"))
    }

    async fn refused(&self, tool: &str, input: Value) -> Value {
        match self.call(tool, input).await {
            Err(error) => error,
            Ok(answer) => panic!("{tool} was expected to fail: {answer}"),
        }
    }

    fn file(&self, path: &str) -> PathBuf {
        self.workspace.path().join(path)
    }

    fn read(&self, path: &str) -> String {
        std::fs::read_to_string(self.file(path)).unwrap_or_else(|err| panic!("{err}"))
    }

    fn modified(&self, path: &str) -> SystemTime {
        std::fs::metadata(self.file(path)).and_then(|meta| meta.modified()).unwrap_or_else(|err| panic!("{err}"))
    }

    /// Writes `text` to `path` as someone other than the agent would, and sets its modification
    /// time to `at`, so the change is seen whatever the file system's time resolution.
    fn write_outside(&self, path: &str, text: &str, at: SystemTime) {
        let file = self.file(path);
        std::fs::write(&file, text).unwrap_or_else(|err| panic!("{err}"));
        let handle = std::fs::File::options().write(true).open(&file).unwrap_or_else(|err| panic!("{err}"));
        handle.set_modified(at).unwrap_or_else(|err| panic!("{err}"));
    }

    async fn shutdown(self) {
        self.kits.shutdown().await;
    }
}

fn append(text: &str) -> Value {
    json!({ "command": "text.append", "params": { "text": text } })
}

/// A step the mock refuses: `text.append` takes a non-empty `text`.
fn failing_step() -> Value {
    json!({ "command": "text.append", "params": { "text": "" } })
}

/// The commands of `steps`, as an answer lists them.
fn commands(steps: &Value) -> Vec<&str> {
    steps.as_array().map(|steps| steps.iter().filter_map(|step| step["command"].as_str()).collect()).unwrap_or_default()
}

// ---- A53: a run is atomic ----

#[tokio::test]
async fn atomic_a_failing_run_leaves_a_clean_document_and_its_file_as_they_were() {
    let Some(f) = Fixture::new("atomic", "", &[("a.atomic", "hello")]) else { return };
    let path = "a.atomic";
    let before = f.ok("atomic_inspect", json!({ "path": path })).await;
    let modified = f.modified(path);

    let failed = f.refused("atomic_run", json!({ "path": path, "steps": [append(" one"), append(" two"), failing_step(), append(" four")] })).await;
    assert_eq!(failed["error"]["code"], "command-failed", "{failed}");
    assert_eq!(failed["error"]["index"], 2, "the failing step's index: {failed}");
    assert_eq!(commands(&failed["rolledBack"]), ["text.append", "text.append"], "the steps before it were rolled back: {failed}");
    assert_eq!(failed["completed"], json!([]), "{failed}");
    assert_eq!(failed["saved"], false, "{failed}");

    assert_eq!(f.read(path), "hello", "nothing was saved");
    assert_eq!(f.modified(path), modified, "the file was not written");
    let after = f.ok("atomic_inspect", json!({ "path": path })).await;
    assert_eq!(after, before, "the document is as it was before the call");

    // A correct run after it succeeds and is saved.
    let ran = f.ok("atomic_run", json!({ "path": path, "steps": [append(" again")] })).await;
    assert_eq!(ran["saved"], true, "{ran}");
    assert_eq!(commands(&ran["completed"]), ["text.append"], "{ran}");
    assert_eq!(f.read(path), "hello again");
    f.shutdown().await;
}

#[tokio::test]
async fn atomic_a_run_whose_first_step_fails_changes_nothing() {
    let Some(f) = Fixture::new("first", "", &[("a.first", "hello")]) else { return };
    let path = "a.first";
    let before = f.ok("first_inspect", json!({ "path": path })).await;

    let failed = f.refused("first_run", json!({ "path": path, "steps": [failing_step(), append(" two")] })).await;
    assert_eq!(failed["error"]["code"], "command-failed", "{failed}");
    assert_eq!(failed["error"]["index"], 0, "{failed}");
    assert_eq!(failed["rolledBack"], json!([]), "nothing ran before it: {failed}");
    assert_eq!(failed["completed"], json!([]), "{failed}");

    assert_eq!(f.read(path), "hello");
    assert_eq!(f.ok("first_inspect", json!({ "path": path })).await, before);
    f.shutdown().await;
}

#[tokio::test]
async fn atomic_a_failing_run_keeps_the_unsaved_edits_of_earlier_runs_and_drops_its_own() {
    let Some(f) = Fixture::new("unsaved", "", &[("a.unsaved", "hello")]) else { return };
    let path = "a.unsaved";
    let kept = f.ok("unsaved_run", json!({ "path": path, "steps": [append(" kept")], "save": false })).await;
    assert_eq!(kept["saved"], false, "{kept}");
    assert_eq!(f.read(path), "hello", "an unsaved run does not write the file");
    let before = f.ok("unsaved_inspect", json!({ "path": path })).await;
    assert_eq!(before["details"]["text"], "hello kept", "{before}");
    assert_eq!(before["dirty"], true, "{before}");

    let failed = f.refused("unsaved_run", json!({ "path": path, "steps": [append(" lost"), append(" too"), failing_step()] })).await;
    assert_eq!(failed["error"]["index"], 2, "{failed}");
    assert_eq!(commands(&failed["rolledBack"]), ["text.append", "text.append"], "{failed}");
    assert_eq!(failed["completed"], json!([]), "{failed}");
    assert_eq!(failed["saved"], false, "{failed}");

    assert_eq!(f.read(path), "hello", "nothing was saved");
    let after = f.ok("unsaved_inspect", json!({ "path": path })).await;
    assert_eq!(after, before, "the earlier unsaved edit is still there and the failed run's steps are gone");

    // Saving now writes the earlier edit and nothing of the failed run.
    f.ok("unsaved_run", json!({ "path": path, "steps": [append("!")] })).await;
    assert_eq!(f.read(path), "hello kept!");
    f.shutdown().await;
}

// ---- A46, A54: the run's target ----

/// Two slides: `s1`, `s2` on the first, `s1`, `s2`, `s3` on the second.
const DECK: &str = "a1|a2\nb1|b2|b3";

/// The ids `inspect` lists for the part of `target`.
async fn listed_ids(f: &Fixture, tool: &str, path: &str, target: Value) -> Vec<String> {
    let answer = f.ok(tool, json!({ "path": path, "target": target })).await;
    let shapes = answer["part"]["shapes"].as_array().unwrap_or_else(|| panic!("inspect lists the part's objects: {answer}"));
    shapes.iter().filter_map(|shape| shape["id"].as_str().map(str::to_owned)).collect()
}

fn set_text(id: &str, text: &str) -> Value {
    json!({ "command": "shape.text", "params": { "id": id, "text": text } })
}

#[tokio::test]
async fn target_ids_inspect_lists_for_a_part_work_in_a_run_on_that_part_whatever_part_was_current() {
    let Some(f) = Fixture::new("deck", "KITION_KIT_MOCK_PARTS=slides", &[("a.deck", DECK)]) else { return };
    let path = "a.deck";
    assert_eq!(listed_ids(&f, "deck_inspect", path, json!({ "slide": 1 })).await, ["s1", "s2"]);
    // Inspecting the second slide leaves it current; the run still acts on the first.
    assert_eq!(listed_ids(&f, "deck_inspect", path, json!({ "slide": 2 })).await, ["s1", "s2", "s3"]);
    let ran = f.ok("deck_run", json!({ "path": path, "target": { "slide": 1 }, "steps": [set_text("s2", "A2")] })).await;
    assert_eq!(ran["saved"], true, "{ran}");
    assert_eq!(f.read(path), "a1|A2\nb1|b2|b3", "the first slide's s2 changed");

    // The same id with the other part as the target reaches that part's object, not the first's.
    f.ok("deck_run", json!({ "path": path, "target": { "slide": 2 }, "steps": [set_text("s2", "B2")] })).await;
    assert_eq!(f.read(path), "a1|A2\nb1|B2|b3", "the second slide's s2 changed, the first slide's kept its text");

    // By the part's stable id as well.
    f.ok("deck_run", json!({ "path": path, "target": { "slideId": 101 }, "steps": [set_text("s1", "A1")] })).await;
    f.ok("deck_run", json!({ "path": path, "target": { "slideId": 102 }, "steps": [set_text("s1", "B1")] })).await;
    assert_eq!(f.read(path), "A1|A2\nB1|B2|b3");
    f.shutdown().await;
}

#[tokio::test]
async fn target_an_id_the_target_part_lacks_fails_loudly_and_never_reaches_another_part() {
    let Some(f) = Fixture::new("slides", "KITION_KIT_MOCK_PARTS=slides", &[("a.slides", DECK)]) else { return };
    let path = "a.slides";
    // `s3` is listed for the second slide only; make the second slide current first.
    assert_eq!(listed_ids(&f, "slides_inspect", path, json!({ "slide": 2 })).await, ["s1", "s2", "s3"]);
    let failed = f.refused("slides_run", json!({ "path": path, "target": { "slide": 1 }, "steps": [set_text("s3", "X")] })).await;
    assert_eq!(failed["error"]["index"], 0, "{failed}");
    assert!(failed["error"]["message"].as_str().is_some_and(|message| message.contains("s3")), "the error names the id: {failed}");
    assert_eq!(f.read(path), DECK, "neither slide changed");

    // A part past the end is an error, never the part that was current.
    let missing = f.refused("slides_run", json!({ "path": path, "target": { "slide": 3 }, "steps": [set_text("s1", "X")] })).await;
    assert!(missing["error"]["code"].is_string(), "{missing}");
    assert_eq!(f.read(path), DECK, "nothing changed");
    let inspected = f.ok("slides_inspect", json!({ "path": path })).await;
    assert_eq!(inspected["details"]["text"], DECK, "{inspected}");
    f.shutdown().await;
}

// ---- A56: changes made outside the agent's calls ----

/// A modification time no write of this test makes: an hour before the file's own.
fn earlier(f: &Fixture, path: &str) -> SystemTime {
    f.modified(path) - Duration::from_secs(3600)
}

#[tokio::test]
async fn outside_a_file_the_agent_saved_itself_is_not_reported_as_changed_outside() {
    let Some(f) = Fixture::new("own", "", &[("a.own", "hello")]) else { return };
    let path = "a.own";
    f.ok("own_inspect", json!({ "path": path })).await;
    f.ok("own_run", json!({ "path": path, "steps": [append(" mine")] })).await;
    assert_eq!(f.read(path), "hello mine");
    let inspected = f.ok("own_inspect", json!({ "path": path })).await;
    assert!(inspected.get("changedOutside").is_none(), "the agent's own save is no outside change: {inspected}");
    let ran = f.ok("own_run", json!({ "path": path, "steps": [append("!")] })).await;
    assert!(ran.get("changedOutside").is_none(), "{ran}");
    assert_eq!(f.read(path), "hello mine!");
    f.shutdown().await;
}

#[tokio::test]
async fn outside_the_next_inspect_after_a_change_outside_says_so_once() {
    let Some(f) = Fixture::new("seen", "", &[("a.seen", "hello")]) else { return };
    let path = "a.seen";
    let first = f.ok("seen_inspect", json!({ "path": path })).await;
    assert!(first.get("changedOutside").is_none(), "{first}");

    f.write_outside(path, "someone else's text", earlier(&f, path));
    let noticed = f.ok("seen_inspect", json!({ "path": path })).await;
    assert_eq!(noticed["changedOutside"]["path"], path, "{noticed}");
    // Looking again shows the file as it now is, not the document as the kit read it before.
    assert_eq!(noticed["details"]["text"], "someone else's text", "{noticed}");
    assert_eq!(noticed["changedOutside"]["was"], "5 characters", "{noticed}");
    assert_eq!(noticed["changedOutside"]["now"], "19 characters", "{noticed}");
    assert_eq!(f.read(path), "someone else's text", "inspect changes nothing");

    let again = f.ok("seen_inspect", json!({ "path": path })).await;
    assert!(again.get("changedOutside").is_none(), "said once: {again}");
    f.shutdown().await;
}

#[tokio::test]
async fn outside_the_next_run_after_a_change_outside_is_refused_once_and_the_one_after_proceeds() {
    let Some(f) = Fixture::new("outside", "", &[("a.outside", "hello")]) else { return };
    let path = "a.outside";
    f.ok("outside_run", json!({ "path": path, "steps": [append(" mine")] })).await;
    assert_eq!(f.read(path), "hello mine");

    let theirs = "someone else's text";
    let at = earlier(&f, path);
    f.write_outside(path, theirs, at);
    let refused = f.refused("outside_run", json!({ "path": path, "steps": [append(" again")] })).await;
    assert_eq!(refused["error"]["code"], "failed", "{refused}");
    assert_eq!(refused["error"]["retryable"], true, "{refused}");
    assert_eq!(refused["changedOutside"]["path"], path, "{refused}");
    let message = refused["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("changed outside") && message.contains("Nothing was run"), "{message}");
    assert_eq!(f.read(path), theirs, "the refused run changed nothing");
    assert_eq!(f.modified(path), at, "the refused run wrote nothing");

    // Refused once: the same run again proceeds, on the file as it now is.
    let ran = f.ok("outside_run", json!({ "path": path, "steps": [append(" again")] })).await;
    assert_eq!(ran["saved"], true, "{ran}");
    assert_eq!(f.read(path), format!("{theirs} again"), "the run kept the change made outside and added its own");
    f.shutdown().await;
}
