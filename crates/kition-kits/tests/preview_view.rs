// Copied from kition-sdk crates/kition-kits/tests/preview_view.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! A preview is a function of the document and the view the call asks for, never of the editor's
//! current state (KHP A24, A39, A55): `<prefix>_inspect {preview: true, target}` passes the whole
//! `target` to the kit's render command (`agent.render`), with `scale` and `maxSize`, and answers
//! what the picture shows as `preview`; a member the render command's parameter schema does not
//! declare is `invalid-params` naming those it takes, never dropped; the kit's playhead and open
//! sequence are as they were after the call; `<prefix>_run {preview: true, view}` draws its
//! after-picture the same way. A kit without a render command keeps its screenshot, and a view it
//! cannot draw stays `unsupported`.
//!
//! Against the mock kit's timeline mode (`KITION_KIT_MOCK_PARTS=timeline`): a sequence a line, ten
//! seconds each at ten frames a second, and `file.render`, whose PNG carries the view it shows
//! (`tEXt` `view`), so a test tells a wrong view from a right one.
//!
//! Cases: `sdk.agent.preview-view/passes-the-view`, `sdk.agent.preview-view/undeclared-member`,
//! `sdk.agent.preview-view/leaves-the-editor`, `sdk.agent.preview-view/run-after-picture`,
//! `sdk.agent.preview-view/without-render`, `regressions/issue-inspect-view-dropped`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, tests that can skip it say so and pass. CI requires it.
#![cfg(unix)]

use std::path::{Path, PathBuf};

use kition_kits::tools;
use kition_kits::{Caller, KitDefinition, KitManager};
use serde_json::{Map, Value, json};

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
        "headless": { "executable": "kition-kit-mock", "protocol": "kition-kit/1" }
    });
    KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"))
}

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

/// A launcher that starts the mock kit as `kit.<name>` for `.<name>` files, with a timeline.
fn as_kit(dir: &Path, mock: &Path, name: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join(format!("kition-{name}-mock.sh"));
    std::fs::write(&script, format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.{name}:{name} KITION_KIT_MOCK_PARTS=timeline exec '{}' \"$@\"\n", mock.display()))
        .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    script
}

/// Two sequences, `alpha` and `beta`.
const TIMELINE: &str = "alpha\nbeta";

struct Fixture {
    kits: KitManager,
    kit: &'static KitDefinition,
    path: String,
    workspace: tempfile::TempDir,
    _bin: tempfile::TempDir,
}

impl Fixture {
    /// The kit `name` (the mock's timeline, with `render` as its render command) on a workspace
    /// holding `a.<name>` with [`TIMELINE`].
    fn new(name: &str, render: Option<&str>) -> Option<Self> {
        let Some(mock) = mock_binary() else {
            eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
            return None;
        };
        let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let path = format!("a.{name}");
        std::fs::write(workspace.path().join(&path), TIMELINE).unwrap_or_else(|err| panic!("{err}"));
        let kit = kit(name, render);
        let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit, Some(as_kit(bin.path(), &mock, name)))]);
        Some(Self { kits, kit, path, workspace, _bin: bin })
    }

    async fn call(&self, action: &str, mut input: Value) -> Result<tools::KitToolOutput, tools::KitToolError> {
        input["path"] = json!(self.path);
        match tools::call(&self.kits, &format!("{}_{action}", self.kit.agent.prefix), &input).await {
            Some(answer) => answer,
            None => panic!("{action} is not a kit tool"),
        }
    }

    async fn ok(&self, action: &str, input: Value) -> tools::KitToolOutput {
        self.call(action, input).await.unwrap_or_else(|error| panic!("{action}: {}", error.message))
    }

    async fn refused(&self, action: &str, input: Value) -> tools::KitToolError {
        match self.call(action, input).await {
            Err(error) => error,
            Ok(answer) => panic!("{action} was expected to fail: {}", answer.output),
        }
    }

    /// The person acting in the kit's editor: `playhead.set`, `sequence.open`.
    async fn person(&self, command: &str, params: Value) {
        let view = self.kits.open(Caller::Agent, &self.path).await.unwrap_or_else(|err| panic!("{err}"));
        let params: Map<String, Value> = params.as_object().cloned().unwrap_or_default();
        self.kits.execute(Caller::User, self.kit.id, &view.document_id, command, params).await.unwrap_or_else(|err| panic!("{command}: {err}"));
    }

    /// The kit's open sequence (counted from 1) and playhead, as its `view.describe` reports them.
    async fn editor(&self) -> Value {
        let answer = self.ok("inspect", json!({})).await.output;
        json!({ "sequence": answer["details"]["sequence"], "playhead": answer["details"]["playhead"] })
    }
}

/// The view a mock render's PNG carries (`tEXt` `view`): `sequence=<n>;frames=<times>;text=<line>`.
fn shown(answer: &tools::KitToolOutput) -> String {
    assert_eq!(answer.previews.len(), 1, "one preview");
    let png = &answer.previews[0].png;
    let mut at = 8;
    while at + 8 <= png.len() {
        let len = u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]) as usize;
        let data = &png[at + 8..at + 8 + len];
        if &png[at + 4..at + 8] == b"tEXt" && data.starts_with(b"view\0") {
            return String::from_utf8_lossy(&data[5..]).into_owned();
        }
        at += 12 + len;
    }
    panic!("the preview carries no view: it was not drawn by the render command");
}

fn says(error: &tools::KitToolError, words: &[&str]) {
    for word in words {
        assert!(error.message.contains(word), "the message says {word}: {}", error.message);
    }
}

/// regressions/issue-inspect-view-dropped, sdk.agent.preview-view/passes-the-view: the call's view
/// reaches the render command whole: a time, a range with its frames, a sequence. Before, inspect
/// passed `target` on only when it had `path` or `objectId`, so `{time: 3}` drew the default view
/// without a word.
#[tokio::test]
async fn the_view_reaches_the_render_command_intact() {
    let Some(f) = Fixture::new("viewed", Some("file.render")) else { return };
    let at = f.ok("inspect", json!({ "preview": true, "target": { "time": 3 } })).await;
    assert_eq!(shown(&at), "sequence=1;frames=3;text=alpha", "the frame at 3 s of the main sequence");
    assert_eq!(at.output["preview"]["frames"], json!([{ "time": 3.0, "frame": 30, "label": "3.0s" }]), "{}", at.output);

    let sheet = f.ok("inspect", json!({ "preview": true, "target": { "range": [0, 4], "frames": 3 } })).await;
    assert_eq!(shown(&sheet), "sequence=1;frames=0,2,4;text=alpha", "three frames from 0 to 4 s");

    let other = f.ok("inspect", json!({ "preview": true, "target": { "sequence": 2, "time": 1.5 } })).await;
    assert_eq!(shown(&other), "sequence=2;frames=1.5;text=beta");
    assert!(other.previews[0].caption.contains(r#"{"sequence":2,"time":1.5}"#), "{}", other.previews[0].caption);

    let small = f.ok("inspect", json!({ "preview": true, "target": { "time": 3 }, "scale": 2, "maxSize": 20 })).await;
    assert_eq!((small.output["preview"]["width"].clone(), small.output["preview"]["scale"].clone()), (json!(20), json!(1.25)), "scale and maxSize go too");
    f.kits.shutdown().await;
}

/// sdk.agent.preview-view/passes-the-view: the inspect answer says what the picture shows, as the
/// render command answered it beside the image: its size and scale, the sequence, the frames and
/// their times, the contact sheet's grid.
#[tokio::test]
async fn the_inspect_answer_says_what_the_preview_shows() {
    let Some(f) = Fixture::new("metadata", Some("file.render")) else { return };
    let sheet = f.ok("inspect", json!({ "preview": true, "target": { "range": [1, 6], "frames": 6 } })).await;
    let preview = &sheet.output["preview"];
    assert_eq!(preview["sequence"], 1);
    assert_eq!((preview["columns"].clone(), preview["rows"].clone()), (json!(4), json!(2)));
    assert_eq!((preview["width"].clone(), preview["height"].clone(), preview["scale"].clone()), (json!(64), json!(18), json!(1.0)));
    let times: Vec<f64> = preview["frames"].as_array().into_iter().flatten().filter_map(|frame| frame["time"].as_f64()).collect();
    assert_eq!(times, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    assert!(preview.get("png").is_none(), "the image is the attached preview, not JSON");
    let plain = f.ok("inspect", json!({ "target": { "time": 3 } })).await;
    assert!(plain.output.get("preview").is_none() && plain.previews.is_empty(), "no preview without `preview`");
    f.kits.shutdown().await;
}

/// sdk.agent.preview-view/undeclared-member: a view member the render command's parameter schema
/// does not declare is `invalid-params`, naming the member and those it takes; nothing is drawn
/// and no other picture stands in for it.
#[tokio::test]
async fn a_view_member_the_render_command_does_not_declare_is_invalid_params() {
    let Some(f) = Fixture::new("undeclared", Some("file.render")) else { return };
    let zoom = f.refused("inspect", json!({ "preview": true, "target": { "time": 3, "zoom": 2 } })).await;
    assert_eq!(zoom.to_json()["code"], "invalid-params", "{}", zoom.message);
    says(&zoom, &["`target.zoom`", "`file.render`", "`time`", "`range`", "`frames`", "`sequence`"]);
    let part = f.refused("inspect", json!({ "preview": true, "target": { "slide": 2 } })).await;
    assert_eq!(part.to_json()["code"], "invalid-params", "{}", part.message);
    says(&part, &["`target.slide`"]);
    assert!(f.call("inspect", json!({ "target": { "zoom": 2 } })).await.is_ok(), "without `preview` nothing is drawn, so nothing is refused");
    f.kits.shutdown().await;
}

/// sdk.agent.preview-view/leaves-the-editor: inspecting a view sends the kit nowhere: its playhead
/// and open sequence are as they were, and the picture is the view asked for, not the playhead's.
#[tokio::test]
async fn inspect_with_a_view_leaves_the_playhead_and_the_open_sequence() {
    let Some(f) = Fixture::new("untouched", Some("file.render")) else { return };
    f.person("sequence.open", json!({ "sequence": 2 })).await;
    f.person("playhead.set", json!({ "time": 7 })).await;
    let before = f.editor().await;
    assert_eq!(before, json!({ "sequence": 2, "playhead": 7.0 }));
    let at = f.ok("inspect", json!({ "preview": true, "target": { "sequence": 1, "time": 3 } })).await;
    assert_eq!(shown(&at), "sequence=1;frames=3;text=alpha");
    let whole = f.ok("inspect", json!({ "preview": true })).await;
    assert!(shown(&whole).starts_with("sequence=1;frames=0,"), "without a view, the kit's default view, not the playhead: {}", shown(&whole));
    assert_eq!(f.editor().await, before, "the kit's playhead and open sequence are unchanged");
    f.kits.shutdown().await;
}

/// sdk.agent.preview-view/run-after-picture: a run's after-picture is drawn by the render command
/// at the run's `view`, after the steps; a view it does not take is refused before anything runs.
#[tokio::test]
async fn a_runs_preview_is_the_after_picture_of_its_view() {
    let Some(f) = Fixture::new("after", Some("file.render")) else { return };
    let steps = json!([{ "command": "text.append", "params": { "text": "X" } }]);
    let ran = f.ok("run", json!({ "steps": steps, "preview": true, "view": { "sequence": 2, "time": 1 } })).await;
    assert_eq!(shown(&ran), "sequence=2;frames=1;text=betaX", "the picture after the steps, at the view");
    assert_eq!(ran.output["preview"]["frames"][0]["time"], 1.0, "{}", ran.output);
    let whole = f.ok("run", json!({ "steps": steps, "preview": true })).await;
    assert!(shown(&whole).starts_with("sequence=1;frames=0,"), "without a view, the render command's whole document: {}", shown(&whole));

    let before = std::fs::read_to_string(f.workspace.path().join(&f.path)).unwrap_or_else(|err| panic!("{err}"));
    let refused = f.refused("run", json!({ "steps": steps, "preview": true, "view": { "zoom": 2 } })).await;
    assert_eq!(refused.to_json()["code"], "invalid-params", "{}", refused.message);
    says(&refused, &["`target.zoom`", "`time`"]);
    let after = std::fs::read_to_string(f.workspace.path().join(&f.path)).unwrap_or_else(|err| panic!("{err}"));
    assert_eq!(after, before, "nothing ran");
    f.kits.shutdown().await;
}

/// sdk.agent.preview-view/without-render: a kit without a render command previews with its
/// screenshot as before; a view its screenshot cannot draw stays `unsupported`, and a run's `view`
/// is `unsupported` before anything runs.
#[tokio::test]
async fn a_kit_without_a_render_command_keeps_its_screenshot() {
    let Some(f) = Fixture::new("shotonly", None) else { return };
    let whole = f.ok("inspect", json!({ "preview": true })).await;
    assert_eq!(whole.previews.len(), 1, "the screenshot");
    assert!(whole.output.get("preview").is_none(), "no render command, no render answer");
    let timed = f.refused("inspect", json!({ "preview": true, "target": { "time": 3 } })).await;
    assert_eq!(timed.to_json()["code"], "unsupported", "{}", timed.message);
    says(&timed, &["`target`", "without `target`"]);
    let steps = json!([{ "command": "text.append", "params": { "text": "X" } }]);
    let refused = f.refused("run", json!({ "steps": steps, "preview": true, "view": { "time": 3 } })).await;
    assert_eq!(refused.to_json()["code"], "unsupported", "{}", refused.message);
    assert_eq!(std::fs::read_to_string(f.workspace.path().join(&f.path)).unwrap_or_default(), TIMELINE, "nothing ran");
    let ran = f.ok("run", json!({ "steps": steps, "preview": true })).await;
    assert_eq!(ran.previews.len(), 1, "the whole document's screenshot after the run");
    f.kits.shutdown().await;
}
