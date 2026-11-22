// Copied from kition-sdk crates/kition-kits/tests/outline.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! A document's outline (`kit.json` `outline.command`, platform K24; `src/outline.rs`): the parts
//! of a file a host lists under it and opens the file at.
//!
//! - A kit that names an outline command answers the file's parts, each `{ id, title, kind?, view }`,
//!   from the headless kit; reading it leaves no document open, and a document that was open
//!   stays open.
//! - The headless answer is kept until the file changes.
//! - A file open in an editor is answered by the editor (the Kit AI bridge's `run`, not saved), so
//!   the outline shows what is not saved yet.
//! - A kit without an outline command has no outline (`None`), which is not an empty one.
//! - An answer of another shape, and a file that is not there, are errors.
//!
//! Against the mock kit's timeline mode (`KITION_KIT_MOCK_PARTS=timeline`): a sequence a line,
//! and `file.outline`, one item a sequence.
//!
//! Cases: `sdk.kits.outline/headless`, `sdk.kits.outline/live`, `sdk.kits.outline/refusals`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, tests that need it say so and pass. CI requires it.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use kition_kits::outline::{OutlineItem, outline};
use kition_kits::{Caller, KitDefinition, KitError, KitManager};
use serde_json::{Value, json};

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

/// A kit `kit.<name>` editing `.<name>` files, with `command` as its outline command when given.
/// `headless` names the mock kit as its executable.
fn kit(name: &str, command: Option<&str>, headless: bool) -> &'static KitDefinition {
    let mut manifest = json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": format!("Kition {name}"), "version": "0.0.0",
        "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
        "agent": { "prefix": name, "tools": "document" }
    });
    if let Some(command) = command {
        manifest["outline"] = json!({ "command": command });
    }
    if headless {
        manifest["headless"] = json!({ "executable": "kition-kit-mock", "protocol": "kition-kit/1" });
    }
    KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"))
}

/// A launcher that starts the mock kit as `kit.<name>` for `.<name>` files, with a timeline.
fn as_kit(dir: &Path, mock: &Path, name: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join(format!("kition-{name}-mock.sh"));
    std::fs::write(&script, format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.{name}:{name} KITION_KIT_MOCK_PARTS=timeline exec '{}' \"$@\"\n", mock.display()))
        .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    script
}

struct Fixture {
    kits: KitManager,
    kit: &'static KitDefinition,
    path: String,
    workspace: tempfile::TempDir,
    _bin: tempfile::TempDir,
}

impl Fixture {
    /// The kit `name` on a workspace holding `a.<name>` with two sequences, `alpha` and `beta`.
    fn new(name: &str, command: Option<&str>) -> Option<Self> {
        let Some(mock) = mock_binary() else {
            eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
            return None;
        };
        let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let path = format!("a.{name}");
        std::fs::write(workspace.path().join(&path), "alpha|x\nbeta").unwrap_or_else(|err| panic!("{err}"));
        let kit = kit(name, command, true);
        let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit, Some(as_kit(bin.path(), &mock, name)))]);
        Some(Self { kits, kit, path, workspace, _bin: bin })
    }

    /// Writes the file anew, a minute later than it was.
    fn rewrite(&self, text: &str) {
        let file = self.workspace.path().join(&self.path);
        let before = std::fs::metadata(&file).and_then(|meta| meta.modified()).unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(&file, text).unwrap_or_else(|err| panic!("{err}"));
        let opened = std::fs::File::options().write(true).open(&file).unwrap_or_else(|err| panic!("{err}"));
        opened.set_modified(before + std::time::Duration::from_secs(60)).unwrap_or_else(|err| panic!("{err}"));
    }
}

fn sequence(number: u64, title: &str) -> OutlineItem {
    OutlineItem { id: number.to_string(), title: title.to_owned(), kind: Some("sequence".into()), view: json!({ "sequence": number }) }
}

#[tokio::test]
async fn the_headless_kit_answers_a_files_parts_and_leaves_nothing_open() {
    let Some(fixture) = Fixture::new("olhead", Some("file.outline")) else { return };
    let items = outline(&fixture.kits, &fixture.path).await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(items, Some(vec![sequence(1, "alpha"), sequence(2, "beta")]));
    assert!(fixture.kits.open_files().await.is_empty(), "reading an outline leaves no document open");
}

#[tokio::test]
async fn a_document_that_was_open_stays_open() {
    let Some(fixture) = Fixture::new("olopen", Some("file.outline")) else { return };
    fixture.kits.open(Caller::User, &fixture.path).await.unwrap_or_else(|err| panic!("{err}"));
    let items = outline(&fixture.kits, &fixture.path).await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(items.map(|items| items.len()), Some(2));
    assert_eq!(fixture.kits.open_files().await, vec![(fixture.kit.id, fixture.path.clone())]);
}

#[tokio::test]
async fn the_answer_is_kept_until_the_file_changes() {
    let Some(fixture) = Fixture::new("olkept", Some("file.outline")) else { return };
    let first = outline(&fixture.kits, &fixture.path).await.unwrap_or_else(|err| panic!("{err}"));
    // The same file again is answered without the kit: a manager with no executable still answers.
    let without = KitManager::new(Some(fixture.workspace.path().to_path_buf()), vec![(fixture.kit, None)]);
    assert_eq!(outline(&without, &fixture.path).await.unwrap_or_else(|err| panic!("{err}")), first);
    fixture.rewrite("alpha|x\nbeta\ngamma");
    let again = outline(&fixture.kits, &fixture.path).await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(again, Some(vec![sequence(1, "alpha"), sequence(2, "beta"), sequence(3, "gamma")]));
    assert!(matches!(outline(&without, &fixture.path).await, Ok(Some(items)) if items.len() == 3), "the new answer is the one kept");
}

#[tokio::test]
async fn a_kit_without_an_outline_command_has_no_outline() {
    let Some(fixture) = Fixture::new("olnone", None) else { return };
    assert_eq!(outline(&fixture.kits, &fixture.path).await.unwrap_or_else(|err| panic!("{err}")), None);
    assert!(fixture.kits.open_files().await.is_empty(), "nothing was opened to find that out");
}

#[tokio::test]
async fn an_answer_of_another_shape_and_a_missing_file_are_errors() {
    // `sequence.open` is no outline command: it refuses a call without its `sequence`.
    let Some(fixture) = Fixture::new("olwrong", Some("sequence.open")) else { return };
    let error = outline(&fixture.kits, &fixture.path).await.err().unwrap_or_else(|| panic!("an outline"));
    assert!(matches!(error, KitError::Kit { .. } | KitError::Unavailable(_)), "{error:?}");
    assert!(fixture.kits.open_files().await.is_empty(), "the document is closed after a failed read too");

    let Some(fixture) = Fixture::new("olgone", Some("file.outline")) else { return };
    let error = outline(&fixture.kits, "missing.olgone").await.err().unwrap_or_else(|| panic!("an outline"));
    assert!(matches!(&error, KitError::InvalidPath(message) if message.contains("missing.olgone")), "{error:?}");
    let error = outline(&fixture.kits, "notes.txt").await.err().unwrap_or_else(|| panic!("an outline"));
    assert!(matches!(&error, KitError::InvalidPath(message) if message.contains("no kit opens")), "{error:?}");
}

/// An editor window that has `a.<name>` open and answers the bridge's `run` with `answer`; the
/// calls it got are kept.
fn editor(kits: &KitManager, kit: &'static KitDefinition, path: &str, answer: Value) -> Arc<Mutex<Vec<Value>>> {
    let calls: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen = Arc::clone(&calls);
    let bridge = kits.bridge().clone();
    let (session, mut rx) = bridge.connect();
    let listed = path.to_owned();
    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let Some(id) = message["id"].as_u64() else { continue };
            let mut reply = match message["method"].as_str() {
                Some("kit/documents") => {
                    json!({ "result": { "documents": [{ "path": listed, "kit": kit.id, "dirty": true, "revision": 4, "capabilities": [] }] } })
                }
                Some("kit/call") => {
                    seen.lock().unwrap_or_else(|err| panic!("{err}")).push(message["params"].clone());
                    json!({ "result": answer })
                }
                _ => json!({ "error": { "code": -32000, "message": "unexpected call" } }),
            };
            reply["jsonrpc"] = json!("2.0");
            reply["id"] = json!(id);
            let _ = bridge.receive(session, &reply);
        }
    });
    calls
}

#[tokio::test]
async fn an_open_editor_answers_its_own_outline_and_is_not_saved() {
    let kit = kit("ollive", Some("file.outline"), false);
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    // The file on disk does not matter: the editor has it open, with edits not saved yet.
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit, None)]);
    let unsaved =
        json!({ "completed": [{ "result": { "items": [{ "id": "t9", "title": "Not saved yet", "kind": "table", "view": { "path": "tables/t9" } }] } }] });
    let calls = editor(&kits, kit, "a.ollive", unsaved);
    let items = outline(&kits, "a.ollive").await.unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(
        items,
        Some(vec![OutlineItem { id: "t9".into(), title: "Not saved yet".into(), kind: Some("table".into()), view: json!({ "path": "tables/t9" }) }])
    );
    let calls = calls.lock().unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["tool"], "run");
    assert_eq!(calls[0]["arguments"]["steps"], json!([{ "command": "file.outline", "params": {} }]));
    assert_eq!(calls[0]["arguments"]["save"], false, "reading an outline never saves the person's document");
}
