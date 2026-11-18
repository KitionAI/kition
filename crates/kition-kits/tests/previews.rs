// Copied from kition-sdk crates/kition-kits/tests/previews.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Previews of `<prefix>_inspect` with `preview: true` (KHP A39): a kit that declares a render
//! command (`agent.render` in its kit.json) previews through it, and a kit that declares none
//! previews with its screenshot. A declared render command that fails, is not offered, or answers
//! another shape than `{png}` fails the preview with an error that says what it answered and what
//! a render command answers (A18, A48), never a silent screenshot that ignores `target`, `scale`,
//! and `maxSize`.
//!
//! A kit without one previews with `view.screenshot` at the call's `scale` and `maxSize`, and a
//! `target` or a `scale` the screenshot cannot draw fails the preview with `unsupported`, never the
//! whole document at scale 1 instead (A24, A39).
//!
//! Regressions: `regressions/issue-render-fallback-silent` (Kition Table declared
//! `table.preview.render`, which answers `{change, result: {png}}`, and every preview stayed the
//! screenshot without a word) and `regressions/issue-inspect-preview-params` (the inspect tool
//! asked every screenshot for 1024 pixels at scale 1, whatever the call's `scale`, `maxSize` and
//! `target`).
//!
//! The headless tests use the mock kit executable, built with the workspace (`cargo build -p
//! kition-kit-mock`); when it is missing locally they say so and pass. CI requires it.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use kition_kits::tools;
use kition_kits::{KitDefinition, KitManager};
use serde_json::{Value, json};

/// `RENDER` and `SCREEN`, base64: what the render command and the screenshot answer.
const RENDERED: &str = "UkVOREVS";
const SCREENSHOT: &str = "U0NSRUVO";

/// A kit `kit.<name>` editing `.<name>` files, with the render command `render` when given. Each
/// test names its own kit: the tools find kits by prefix in one registry per process.
fn kit(name: &str, render: Option<&str>) -> &'static KitDefinition {
    let mut agent = json!({ "prefix": name, "tools": "document" });
    if let Some(render) = render {
        agent["render"] = json!(render);
    }
    let manifest = json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": format!("Kition {name}"), "version": "0.0.0",
        "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
        "agent": agent,
        "headless": { "executable": "kition-kit-mock", "protocol": "kition-kit/2" }
    });
    KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"))
}

/// A renderer window with `path` open in the editor of `kit`: `inspect` answers a summary, `run`
/// answers `render` as its one step's result (or its error), and `kit/preview` the screenshot.
/// It records the `run` arguments it got.
fn editor(kits: &KitManager, kit: &'static KitDefinition, path: &str, render: Result<Value, &'static str>) -> Seen {
    editor_seeing(kits, kit, path, render).0
}

/// What a mock editor records: the parameters of each call it got.
type Seen = Arc<Mutex<Vec<Value>>>;

/// [`editor`], also recording the `kit/preview` parameters it got.
fn editor_seeing(kits: &KitManager, kit: &'static KitDefinition, path: &str, render: Result<Value, &'static str>) -> (Seen, Seen) {
    let bridge = kits.bridge().clone();
    let (session, mut rx) = bridge.connect();
    let runs = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&runs);
    let shots = Arc::new(Mutex::new(Vec::new()));
    let shot = Arc::clone(&shots);
    let path = path.to_owned();
    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let Some(id) = message["id"].as_u64() else { continue };
            let params = &message["params"];
            let mut reply = match (message["method"].as_str(), params["tool"].as_str()) {
                (Some("kit/documents"), _) => json!({ "result": { "documents": [{ "path": path, "kit": kit.id, "dirty": false, "revision": 1 }] } }),
                (Some("kit/call"), Some("inspect")) => json!({ "result": { "document": { "summary": "one page" } } }),
                (Some("kit/call"), Some("run")) => {
                    seen.lock().unwrap_or_else(|err| panic!("{err}")).push(params["arguments"].clone());
                    match &render {
                        Ok(answer) => json!({ "result": { "completed": [{ "result": answer }] } }),
                        Err(message) => json!({ "error": { "code": -32000, "message": message } }),
                    }
                }
                (Some("kit/preview"), _) => {
                    shot.lock().unwrap_or_else(|err| panic!("{err}")).push(params.clone());
                    json!({ "result": { "png": SCREENSHOT } })
                }
                _ => json!({ "error": { "code": -32000, "message": "unexpected call" } }),
            };
            reply["jsonrpc"] = json!("2.0");
            reply["id"] = json!(id);
            let _ = bridge.receive(session, &reply);
        }
    });
    (runs, shots)
}

async fn inspect(kits: &KitManager, tool: &str, input: Value) -> Result<tools::KitToolOutput, tools::KitToolError> {
    match tools::call(kits, tool, &input).await {
        Some(answer) => answer,
        None => panic!("{tool} is not a kit tool"),
    }
}

#[tokio::test]
async fn without_a_render_command_the_preview_is_the_kit_s_screenshot() {
    let shot = kit("shot", None);
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(shot, None)]);
    let runs = editor(&kits, shot, "a.shot", Err("no render command was declared"));
    let answer = inspect(&kits, "shot_inspect", json!({ "path": "a.shot", "preview": true })).await.unwrap_or_else(|err| panic!("{}", err.message));
    let pngs: Vec<&[u8]> = answer.previews.iter().map(|preview| preview.png.as_slice()).collect();
    assert_eq!(pngs, [b"SCREEN".as_slice()], "the screenshot stays the default");
    assert!(runs.lock().unwrap_or_else(|err| panic!("{err}")).is_empty(), "no render command was run");
}

#[tokio::test]
async fn a_declared_render_command_draws_the_preview_at_the_asked_scale_and_size() {
    let drawn = kit("drawn", Some("file.render"));
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(drawn, None)]);
    let runs = editor(&kits, drawn, "a.drawn", Ok(json!({ "png": RENDERED })));
    let input = json!({ "path": "a.drawn", "preview": true, "scale": 2, "maxSize": 300, "target": { "path": "layer:4" } });
    let answer = inspect(&kits, "drawn_inspect", input).await.unwrap_or_else(|err| panic!("{}", err.message));
    let pngs: Vec<&[u8]> = answer.previews.iter().map(|preview| preview.png.as_slice()).collect();
    assert_eq!(pngs, [b"RENDER".as_slice()]);
    let sent = runs.lock().unwrap_or_else(|err| panic!("{err}")).clone();
    let step = &sent[0]["steps"][0];
    assert_eq!(step["command"], "file.render");
    assert_eq!(step["params"], json!({ "target": { "path": "layer:4" }, "scale": 2, "maxSize": 300 }), "the render command gets target, scale, and maxSize");
    assert_eq!(sent[0]["save"], false, "a preview is never saved");
}

#[tokio::test]
async fn a_render_answer_of_another_shape_fails_the_preview_and_says_what_it_answered() {
    let nested = kit("nested", Some("table.preview.render"));
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(nested, None)]);
    let _runs = editor(&kits, nested, "a.nested", Ok(json!({ "change": null, "result": { "png": RENDERED } })));
    let refused = match inspect(&kits, "nested_inspect", json!({ "path": "a.nested", "preview": true })).await {
        Err(error) => error,
        Ok(answer) => panic!("a malformed render answer is not replaced by a screenshot: {} preview(s)", answer.previews.len()),
    };
    assert_eq!(refused.to_json()["code"], "failed");
    for words in ["`table.preview.render`", "`agent.render`", "`{change, result: {png}}`", "`{png}`", "without `preview`"] {
        assert!(refused.message.contains(words), "names {words}: {}", refused.message);
    }
    // Without a preview the same file still answers.
    assert!(inspect(&kits, "nested_inspect", json!({ "path": "a.nested", "preview": false })).await.is_ok());
}

#[tokio::test]
async fn a_render_command_that_fails_fails_the_preview_with_the_kit_s_reason() {
    let broken = kit("broken", Some("file.render"));
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(broken, None)]);
    let _runs = editor(&kits, broken, "a.broken", Err("the page has no layout yet"));
    let refused = match inspect(&kits, "broken_inspect", json!({ "path": "a.broken", "preview": true })).await {
        Err(error) => error,
        Ok(answer) => panic!("a failed render command is not replaced by a screenshot: {} preview(s)", answer.previews.len()),
    };
    assert_eq!(refused.to_json()["code"], "failed");
    for words in ["`file.render`", "the page has no layout yet", "`{png}`"] {
        assert!(refused.message.contains(words), "names {words}: {}", refused.message);
    }
}

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

/// A launcher that starts the mock kit as `kit.<name>` for `.<name>` files.
fn as_kit(dir: &Path, mock: &Path, name: &str) -> PathBuf {
    as_kit_with(dir, mock, name, "")
}

/// [`as_kit`], with `env` (`NAME=value …`) set for the mock.
fn as_kit_with(dir: &Path, mock: &Path, name: &str, env: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join(format!("kition-{name}-mock.sh"));
    std::fs::write(&script, format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.{name}:{name} {env} exec '{}' \"$@\"\n", mock.display()))
        .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    script
}

/// The headless kit: the mock offers no render command at all, so one declared in the manifest
/// fails the preview; the same mock without one previews with its screenshot.
#[tokio::test]
async fn a_render_command_the_headless_kit_does_not_offer_fails_the_preview() {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join("a.offered"), "hello").unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join("a.plain"), "hello").unwrap_or_else(|err| panic!("{err}"));
    let (offered, plain) = (kit("offered", Some("file.render")), kit("plain", None));
    let kits = KitManager::new(
        Some(workspace.path().to_path_buf()),
        vec![(offered, Some(as_kit(bin.path(), &mock, "offered"))), (plain, Some(as_kit(bin.path(), &mock, "plain")))],
    );

    let refused = match inspect(&kits, "offered_inspect", json!({ "path": "a.offered", "preview": true })).await {
        Err(error) => error,
        Ok(answer) => panic!("a render command the kit does not offer is not replaced by a screenshot: {} preview(s)", answer.previews.len()),
    };
    assert_eq!(refused.to_json()["code"], "failed");
    assert!(refused.message.contains("`file.render`") && refused.message.contains("`agent.render`"), "{}", refused.message);
    assert!(inspect(&kits, "offered_inspect", json!({ "path": "a.offered" })).await.is_ok(), "without a preview it answers");

    let shown = inspect(&kits, "plain_inspect", json!({ "path": "a.plain", "preview": true })).await.unwrap_or_else(|err| panic!("{}", err.message));
    assert_eq!(shown.previews.len(), 1, "a kit without a render command previews with its screenshot");
    kits.shutdown().await;
}

/// The width and height a PNG's header gives.
fn png_size(png: &[u8]) -> (u32, u32) {
    assert_eq!(png.get(..8), Some(b"\x89PNG\r\n\x1a\n".as_slice()), "a PNG");
    let at = |offset: usize| u32::from_be_bytes([png[offset], png[offset + 1], png[offset + 2], png[offset + 3]]);
    (at(16), at(20))
}

/// The size of the one preview `input` answers.
async fn previewed(kits: &KitManager, tool: &str, input: Value) -> (u32, u32) {
    let answer = inspect(kits, tool, input).await.unwrap_or_else(|err| panic!("{}", err.message));
    assert_eq!(answer.previews.len(), 1, "one preview");
    png_size(&answer.previews[0].png)
}

/// A refused preview: what `inspect` answered instead of an image.
async fn refused(kits: &KitManager, tool: &str, input: Value) -> tools::KitToolError {
    match inspect(kits, tool, input).await {
        Err(error) => error,
        Ok(answer) => panic!("{tool}: a preview the kit cannot draw is not replaced by another image: {} preview(s)", answer.previews.len()),
    }
}

/// regressions/issue-inspect-preview-params: the screenshot preview of a kit without a render
/// command is drawn at the call's `scale` and within its `maxSize` (KHP A39). The mock's canvas is
/// 40 × 20; `sharp` draws up to scale 2, `blunt` only up to scale 1, so its scale 2 fails the
/// preview with `unsupported` that says the scale it draws at most, and a `target` the screenshot
/// cannot draw fails it too, instead of the whole document at scale 1 (A24, A18, A48).
#[tokio::test]
async fn the_screenshot_preview_takes_the_call_s_scale_and_max_size_and_refuses_what_it_cannot_draw() {
    let Some(mock) = mock_binary() else {
        eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
        return;
    };
    let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join("a.sharp"), "hello").unwrap_or_else(|err| panic!("{err}"));
    std::fs::write(workspace.path().join("a.blunt"), "hello").unwrap_or_else(|err| panic!("{err}"));
    let (sharp, blunt) = (kit("sharp", None), kit("blunt", None));
    let kits = KitManager::new(
        Some(workspace.path().to_path_buf()),
        vec![(sharp, Some(as_kit_with(bin.path(), &mock, "sharp", "KITION_KIT_MOCK_MAX_SCALE=2"))), (blunt, Some(as_kit(bin.path(), &mock, "blunt")))],
    );

    let shot = |input: Value| previewed(&kits, "sharp_inspect", input);
    assert_eq!(shot(json!({ "path": "a.sharp", "preview": true })).await, (40, 20), "no scale or maxSize: the document at scale 1");
    assert_eq!(shot(json!({ "path": "a.sharp", "preview": true, "scale": 2 })).await, (80, 40), "scale 2 is twice scale 1");
    assert_eq!(shot(json!({ "path": "a.sharp", "preview": true, "scale": 0.5 })).await, (20, 10));
    assert_eq!(shot(json!({ "path": "a.sharp", "preview": true, "maxSize": 16 })).await, (16, 8), "maxSize bounds the longer side");
    assert_eq!(shot(json!({ "path": "a.sharp", "preview": true, "scale": 2, "maxSize": 64 })).await, (64, 32), "maxSize wins over scale");

    let shot = |input: Value| previewed(&kits, "blunt_inspect", input);
    assert_eq!(shot(json!({ "path": "a.blunt", "preview": true, "maxSize": 16 })).await, (16, 8), "every kit draws smaller");
    assert_eq!(shot(json!({ "path": "a.blunt", "preview": true, "scale": 2, "maxSize": 16 })).await, (16, 8), "maxSize brings scale 2 down");
    let enlarged = refused(&kits, "blunt_inspect", json!({ "path": "a.blunt", "preview": true, "scale": 2 })).await;
    assert_eq!(enlarged.to_json()["code"], "unsupported", "{}", enlarged.message);
    for words in ["scale 2", "scale 1 at most", "blunt_inspect", "without `scale`"] {
        assert!(enlarged.message.contains(words), "names {words}: {}", enlarged.message);
    }

    let target = json!({ "path": "a.blunt", "preview": true, "target": { "path": "layer:4" } });
    let untargeted = refused(&kits, "blunt_inspect", target).await;
    assert_eq!(untargeted.to_json()["code"], "unsupported", "{}", untargeted.message);
    for words in ["`target`", r#"{"path":"layer:4"}"#, "without `target`", "`agent.render`"] {
        assert!(untargeted.message.contains(words), "names {words}: {}", untargeted.message);
    }
    assert!(inspect(&kits, "blunt_inspect", json!({ "path": "a.blunt", "target": { "path": "layer:4" } })).await.is_ok(), "without a preview it answers");
    kits.shutdown().await;
}

/// The preview of a document open in its editor (`ai/preview`, which draws the whole document at
/// scale 1 within `maxSize`): the call's `maxSize` reaches it, and a `scale` or `target` it cannot
/// draw fails the preview instead of the whole document at scale 1.
#[tokio::test]
async fn an_open_editor_s_preview_takes_max_size_and_refuses_what_it_cannot_draw() {
    let open = kit("opened", None);
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(open, None)]);
    let (_runs, shots) = editor_seeing(&kits, open, "a.opened", Err("no render command was declared"));
    let sizes = || shots.lock().unwrap_or_else(|err| panic!("{err}")).iter().map(|params| params["maxSize"].clone()).collect::<Vec<_>>();

    assert!(inspect(&kits, "opened_inspect", json!({ "path": "a.opened", "preview": true })).await.is_ok());
    assert!(inspect(&kits, "opened_inspect", json!({ "path": "a.opened", "preview": true, "maxSize": 64 })).await.is_ok());
    assert_eq!(sizes(), [json!(1024), json!(64)], "1024 unless the call gives maxSize");

    let enlarged = refused(&kits, "opened_inspect", json!({ "path": "a.opened", "preview": true, "scale": 2 })).await;
    assert_eq!(enlarged.to_json()["code"], "unsupported", "{}", enlarged.message);
    assert!(enlarged.message.contains("without `scale`"), "{}", enlarged.message);
    let untargeted = refused(&kits, "opened_inspect", json!({ "path": "a.opened", "preview": true, "target": { "objectId": "o1" } })).await;
    assert_eq!(untargeted.to_json()["code"], "unsupported", "{}", untargeted.message);
    assert!(untargeted.message.contains("without `target`"), "{}", untargeted.message);
    assert_eq!(sizes().len(), 2, "nothing else was drawn");
}
