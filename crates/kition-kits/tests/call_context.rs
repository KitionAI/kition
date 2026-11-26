// Copied from kition-sdk crates/kition-kits/tests/call_context.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Explicit call context: every `<prefix>_run` step says what it acts on (`on`) and where
//! (`at`, the run's `target`), and the server sets the kit's editor state for the call and puts
//! it back, so no call leaves hidden state behind, against the mock kit's slides mode
//! (`KITION_KIT_MOCK_PARTS=slides`), which has a current slide and a selection.
//!
//! - No hidden state left behind: after `_run {target}` (it succeeds, or it fails and is rolled
//!   back by reopening a clean document or undoing on a dirty one) and after `_inspect {target}`,
//!   the kit's current part and selection are what they were before the call.
//! - `on` (the ids as `<prefix>_inspect` lists them) fills the parameter a command declares as
//!   its targets, and drives a command that acts only on the selection on exactly those objects;
//!   giving both `on` and that parameter, more ids than it takes, or `on` to a command that acts
//!   on no object is `invalid-params`, said.
//! - A step's `at.part` overrides the run's `target` for that step only; a failing step rolls
//!   back the steps on other parts too.
//! - A kit without the editor-state hooks (`KITION_KIT_MOCK_CONTEXT=none`): `target` still works,
//!   and `on` for a selection command is `unsupported` rather than acting on the old selection.
//! - A document open in an editor that does not list the capability `context`: a run that gives
//!   `target`, `on` or `at` is `unsupported`, naming the member, and never reaches the editor
//!   (nothing is accepted and ignored). An editor that lists it: `tests/live_editor.rs`.
//!
//! Cases: `sdk.agent.call-context/leaves-no-state`, `sdk.agent.call-context/on-targets`,
//! `sdk.agent.call-context/step-part`, `sdk.agent.call-context/without-hooks`,
//! `sdk.agent.call-context/live-editor`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, the tests that need it say so and pass. CI requires it.
#![cfg(unix)]

#[path = "support/editor.rs"]
mod editor;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use kition_kits::tools;
use kition_kits::{Caller, KitDefinition, KitManager};
use serde_json::{Map, Value, json};

/// A kit `kit.<name>` editing `.<name>` files. Each test names its own kit: the tools find kits
/// by prefix in one registry per process.
fn kit(name: &str, headless: bool) -> &'static KitDefinition {
    kit_with_parts(name, headless, None)
}

/// [`kit`], declaring the kit's part nouns (`agent.parts`) when `parts` is given.
fn kit_with_parts(name: &str, headless: bool, parts: Option<&[&str]>) -> &'static KitDefinition {
    let mut manifest = json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": format!("Kition {name}"), "version": "0.0.0",
        "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
        "agent": { "prefix": name, "tools": "document" }
    });
    if let Some(parts) = parts {
        manifest["agent"]["parts"] = json!(parts);
    }
    if headless {
        manifest["headless"] = json!({ "executable": "kition-kit-mock", "protocol": "kition-kit/1" });
    }
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

/// Two slides: `s1`, `s2` on the first, `s1`, `s2`, `s3` on the second. Ids are unique only
/// within a slide.
const DECK: &str = "a1|a2\nb1|b2|b3";

/// The mock with slides and the editor-state hooks.
const SLIDES: &str = "KITION_KIT_MOCK_PARTS=slides";
/// The mock with slides and without the editor-state hooks.
const SLIDES_WITHOUT_HOOKS: &str = "KITION_KIT_MOCK_PARTS=slides KITION_KIT_MOCK_CONTEXT=none";

struct Fixture {
    kits: KitManager,
    native: KitManager,
    kit: &'static KitDefinition,
    path: String,
    workspace: tempfile::TempDir,
    _bin: tempfile::TempDir,
}

impl Fixture {
    /// The kit `name` (the mock with `env`) on a workspace holding `a.<name>` with [`DECK`], started
    /// with the document open. The tests' kits start at once (regressions/issue-kit-home-race).
    async fn new(name: &str, env: &str) -> Option<Self> {
        Self::declaring(name, env, None).await
    }

    /// [`Fixture::new`] for a kit whose manifest declares its part nouns (`agent.parts`).
    async fn declaring(name: &str, env: &str, parts: Option<&[&str]>) -> Option<Self> {
        let Some(mock) = mock_binary() else {
            eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
            return None;
        };
        let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let path = format!("a.{name}");
        std::fs::write(workspace.path().join(&path), DECK).unwrap_or_else(|err| panic!("{err}"));
        let kit = kit_with_parts(name, true, parts);
        let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit, Some(as_kit(bin.path(), &mock, name, env)))]);
        kits.open(Caller::Agent, &path).await.unwrap_or_else(|err| panic!("{err}"));
        let native = editor::attach(&kits, workspace.path(), kit, &as_kit(bin.path(), &mock, name, env), &path);
        Some(Self { kits, native, kit, path, workspace, _bin: bin })
    }

    fn tool(&self, action: &str) -> String {
        format!("{}_{action}", self.kit.agent.prefix)
    }

    async fn call(&self, action: &str, mut input: Value) -> Result<Value, Value> {
        input["path"] = json!(self.path);
        match tools::call(&self.kits, &self.tool(action), &input).await {
            Some(Ok(output)) => Ok(output.output),
            Some(Err(error)) => Err(error.structured()),
            None => panic!("{action} is not a kit tool"),
        }
    }

    async fn ok(&self, action: &str, input: Value) -> Value {
        self.call(action, input).await.unwrap_or_else(|error| panic!("{action}: {error}"))
    }

    async fn refused(&self, action: &str, input: Value) -> Value {
        match self.call(action, input).await {
            Err(error) => error,
            Ok(answer) => panic!("{action} was expected to fail: {answer}"),
        }
    }

    fn read(&self) -> String {
        std::fs::read_to_string(self.workspace.path().join(&self.path)).unwrap_or_else(|err| panic!("{err}"))
    }

    /// The person acting in the kit (on the host's connection, as an editor would): `slide.go`,
    /// `select.set`.
    async fn person(&self, command: &str, params: Value) {
        let view = self.native.open(Caller::Agent, &self.path).await.unwrap_or_else(|err| panic!("{err}"));
        let params: Map<String, Value> = params.as_object().cloned().unwrap_or_default();
        self.native.execute(Caller::User, self.kit.id, &view.document_id, command, params).await.unwrap_or_else(|err| panic!("{command}: {err}"));
    }

    /// The kit's current slide (counted from 1) and selection, as its `view.describe` reports them.
    async fn editor(&self) -> Value {
        let answer = self.ok("inspect", json!({})).await;
        json!({ "slide": answer["details"]["slide"], "selection": answer["details"]["selection"] })
    }

    async fn shutdown(self) {
        self.native.shutdown().await;
        self.kits.shutdown().await;
    }
}

fn set_text(id: &str, text: &str) -> Value {
    json!({ "command": "shape.text", "params": { "id": id, "text": text } })
}

fn commands(steps: &Value) -> Vec<&str> {
    steps.as_array().map(|steps| steps.iter().filter_map(|step| step["command"].as_str()).collect()).unwrap_or_default()
}

fn says(error: &Value, words: &[&str]) {
    let message = error["error"]["message"].as_str().unwrap_or_default();
    for word in words {
        assert!(message.contains(word), "the message says {word}: {message}");
    }
}

// ---- No hidden state left behind ----

#[tokio::test]
async fn state_a_run_with_a_target_leaves_the_current_part_and_selection_as_they_were() {
    let Some(f) = Fixture::new("keeps", SLIDES).await else { return };
    f.person("slide.go", json!({ "index": 1 })).await;
    f.person("select.set", json!({ "ids": ["s1", "s3"] })).await;
    let before = f.editor().await;
    assert_eq!(before, json!({ "slide": 2, "selection": ["s1", "s3"] }), "the person is on the second slide with two objects selected");

    let ran = f.ok("run", json!({ "target": { "slide": 1 }, "steps": [set_text("s2", "A2")] })).await;
    assert_eq!(ran["saved"], true, "{ran}");
    assert_eq!(f.read(), "a1|A2\nb1|b2|b3", "the first slide's s2 changed");
    assert_eq!(f.editor().await, before, "the current part and selection are as they were");
    let text = serde_json::to_string(&ran).unwrap_or_default();
    assert!(!text.contains("now on"), "no answer says the kit stays on the part: {text}");
    f.shutdown().await;
}

#[tokio::test]
async fn state_a_failing_run_on_a_clean_document_is_reopened_with_its_part_and_selection_put_back() {
    let Some(f) = Fixture::new("reopened", SLIDES).await else { return };
    f.person("slide.go", json!({ "index": 1 })).await;
    f.person("select.set", json!({ "ids": ["s2"] })).await;
    let before = f.editor().await;

    let failed = f.refused("run", json!({ "target": { "slide": 1 }, "steps": [set_text("s1", "X"), set_text("s9", "Y")] })).await;
    assert_eq!(failed["error"]["index"], 1, "{failed}");
    assert_eq!(commands(&failed["rolledBack"]), ["shape.text"], "{failed}");
    assert_eq!(f.read(), DECK, "nothing was saved");
    let after = f.ok("inspect", json!({})).await;
    assert_eq!(after["details"]["text"], DECK, "the document is as it was: {after}");
    assert_eq!(f.editor().await, before, "the reopened document is on the same part with the same selection");
    f.shutdown().await;
}

#[tokio::test]
async fn state_a_failing_run_on_a_dirty_document_is_undone_with_its_part_and_selection_put_back() {
    let Some(f) = Fixture::new("undone", SLIDES).await else { return };
    f.ok("run", json!({ "target": { "slide": 2 }, "steps": [set_text("s3", "B3")], "save": false })).await;
    f.person("select.set", json!({ "ids": ["s2"] })).await;
    let before = f.editor().await;
    assert_eq!(before, json!({ "slide": 1, "selection": ["s2"] }), "the unsaved run left the first slide current");

    let failed = f.refused("run", json!({ "target": { "slide": 2 }, "steps": [set_text("s1", "X"), set_text("s9", "Y")] })).await;
    assert_eq!(failed["error"]["index"], 1, "{failed}");
    assert_eq!(commands(&failed["rolledBack"]), ["shape.text"], "{failed}");
    let after = f.ok("inspect", json!({})).await;
    assert_eq!(after["details"]["text"], "a1|a2\nb1|b2|B3", "the earlier unsaved edit stays, the failed run's step is gone: {after}");
    assert_eq!(f.editor().await, before, "undoing left neither the target part nor another selection current");
    f.shutdown().await;
}

/// regressions/issue-run-saves-navigation: a kit that writes some editor state into its file (the
/// video kit its open sequence and tabs, the 3D kit its viewport) saved a run's navigation, since
/// the run saved before it put the editor state back.
#[tokio::test]
async fn state_a_run_saves_the_file_with_the_editor_state_put_back() {
    let Some(f) = Fixture::new("savedstate", "KITION_KIT_MOCK_PARTS=slides KITION_KIT_MOCK_STATE_IN_FILE=1").await else { return };
    let before = f.editor().await;
    assert_eq!(before["slide"], 1, "the file names no current slide, so the first is current");

    f.ok("run", json!({ "target": { "slide": 2 }, "steps": [set_text("s3", "B3")] })).await;
    assert_eq!(f.read(), "a1|a2\nb1|b2|B3\n#editor slide=1", "the run's navigation to slide 2 is not in the saved file");
    assert_eq!(f.editor().await, before);

    f.ok("run", json!({ "steps": [{ "command": "shape.text", "on": ["s1"], "params": { "text": "B1" }, "at": { "part": { "slideId": 102 } } }] })).await;
    assert_eq!(f.read(), "a1|a2\nB1|b2|B3\n#editor slide=1", "nor a step's `at.part`");
    f.shutdown().await;
}

/// No call context member sets the editor's mode (or its active object), so a command
/// that reads it says so (`dependsOn`), a run sets it with the kit's own command in an earlier
/// step, and the server puts it back after the call with the rest of the editor state.
#[tokio::test]
async fn state_a_mode_a_run_sets_holds_for_its_later_steps_and_is_put_back() {
    let Some(f) = Fixture::new("modal", SLIDES).await else { return };
    let listed = f.ok("commands", json!({ "query": "shape.write" })).await;
    let write = listed["commands"].as_array().and_then(|commands| commands.iter().find(|command| command["id"] == "shape.write")).cloned().unwrap_or_default();
    assert_eq!(write["reads"], json!(["part", "mode"]), "{write}");
    assert!(write["dependsOn"].as_str().is_some_and(|needs| needs.contains("mode") && needs.contains("same run")), "{write}");
    let mode = || async { f.ok("inspect", json!({})).await["details"]["mode"].clone() };
    assert_eq!(mode().await, "normal");

    let write = |id: &str, text: &str| json!({ "command": "shape.write", "on": [id], "params": { "text": text } });
    f.ok(
        "run",
        json!({ "target": { "slide": 1 }, "steps": [{ "command": "mode.set", "params": { "mode": "caps" } }, write("s1", "loud"), write("s2", "too")] }),
    )
    .await;
    assert_eq!(f.read(), "LOUD|TOO\nb1|b2|b3", "the later steps ran in the mode the run set");
    assert_eq!(mode().await, "normal", "the mode is put back after the call");
    f.ok("run", json!({ "target": { "slide": 2 }, "steps": [write("s1", "quiet")] })).await;
    assert_eq!(f.read(), "LOUD|TOO\nquiet|b2|b3", "a later call runs in the person's mode, not the earlier run's");
    f.shutdown().await;
}

#[tokio::test]
async fn state_inspect_with_a_target_leaves_the_current_part_and_selection_as_they_were() {
    let Some(f) = Fixture::new("looks", SLIDES).await else { return };
    f.person("select.set", json!({ "ids": ["s1"] })).await;
    let before = f.editor().await;
    assert_eq!(before, json!({ "slide": 1, "selection": ["s1"] }));

    let looked = f.ok("inspect", json!({ "target": { "slide": 2 } })).await;
    assert_eq!(looked["part"]["shapes"].as_array().map(Vec::len), Some(3), "{looked}");
    let edit = looked["edit"].as_str().unwrap_or_default();
    assert!(!edit.contains("now on"), "{edit}");
    assert_eq!(f.editor().await, before, "inspecting another slide moved nothing");
    f.ok("inspect", json!({ "target": { "slideId": 102 } })).await;
    assert_eq!(f.editor().await, before, "nor by its id");
    f.shutdown().await;
}

// ---- `on`: what a step acts on ----

#[tokio::test]
async fn on_fills_the_parameter_the_command_declares_as_its_targets() {
    let Some(f) = Fixture::new("filled", SLIDES).await else { return };
    let ran = f
        .ok(
            "run",
            json!({ "target": { "slide": 2 }, "steps": [
                { "command": "shape.text", "on": ["s3"], "params": { "text": "B3" } },
                { "command": "shape.upper", "on": ["s1", "s2"] }
            ] }),
        )
        .await;
    assert_eq!(commands(&ran["completed"]), ["shape.text", "shape.upper"], "{ran}");
    assert_eq!(f.read(), "a1|a2\nB1|B2|B3", "one id to `id`, a list to `ids`");
    f.shutdown().await;
}

#[tokio::test]
async fn on_and_the_target_parameter_together_or_too_many_ids_are_invalid_params() {
    let Some(f) = Fixture::new("twice", SLIDES).await else { return };
    let both = f
        .refused("run", json!({ "target": { "slide": 1 }, "steps": [{ "command": "shape.text", "on": ["s1"], "params": { "id": "s1", "text": "X" } }] }))
        .await;
    assert_eq!(both["error"]["code"], "invalid-params", "{both}");
    assert_eq!(both["error"]["index"], 0, "{both}");
    says(&both, &["`on`", "`id`"]);

    let many = f
        .refused(
            "run",
            json!({ "target": { "slide": 1 }, "steps": [set_text("s1", "ok"), { "command": "shape.text", "on": ["s1", "s2"], "params": { "text": "X" } }] }),
        )
        .await;
    assert_eq!(many["error"]["code"], "invalid-params", "{many}");
    assert_eq!(many["error"]["index"], 1, "{many}");
    says(&many, &["one"]);
    assert_eq!(f.read(), DECK, "neither run changed anything, not even the step before");
    f.shutdown().await;
}

#[tokio::test]
async fn on_for_a_command_that_acts_on_no_object_is_invalid_params_and_says_why() {
    let Some(f) = Fixture::new("aimless", SLIDES).await else { return };
    let refused = f.refused("run", json!({ "steps": [{ "command": "text.append", "on": ["s1"], "params": { "text": "!" } }] })).await;
    assert_eq!(refused["error"]["code"], "invalid-params", "{refused}");
    says(&refused, &["`text.append`", "`on`", "acts on no object"]);
    assert_eq!(f.read(), DECK);
    f.shutdown().await;
}

#[tokio::test]
async fn on_drives_a_selection_command_on_exactly_those_objects_and_leaves_the_selection() {
    let Some(f) = Fixture::new("marks", SLIDES).await else { return };
    f.person("slide.go", json!({ "index": 1 })).await;
    f.person("select.set", json!({ "ids": ["s2"] })).await;
    let before = f.editor().await;

    let ran = f.ok("run", json!({ "target": { "slide": 2 }, "steps": [{ "command": "format.mark", "on": ["s1", "s3"] }] })).await;
    assert_eq!(commands(&ran["completed"]), ["format.mark"], "{ran}");
    assert_eq!(f.read(), "a1|a2\n*b1*|b2|*b3*", "exactly the objects named, not the person's selection");
    assert_eq!(f.editor().await, before, "the person's selection is as it was");

    // On another part than the current one: the selection is set there for the step.
    f.ok("run", json!({ "steps": [{ "command": "format.mark", "on": ["s2"], "at": { "part": { "slide": 1 } } }] })).await;
    assert_eq!(f.read(), "a1|*a2*\n*b1*|b2|*b3*");
    assert_eq!(f.editor().await, before);
    f.shutdown().await;
}

// ---- `at`: where a step acts ----

#[tokio::test]
async fn at_a_steps_part_overrides_the_runs_target_for_that_step_only() {
    let Some(f) = Fixture::new("overrides", SLIDES).await else { return };
    let before = f.editor().await;
    f.ok(
        "run",
        json!({ "target": { "slide": 1 }, "steps": [
            set_text("s2", "A2"),
            { "command": "shape.text", "params": { "id": "s2", "text": "B2" }, "at": { "part": { "slide": 2 } } },
            set_text("s1", "A1")
        ] }),
    )
    .await;
    assert_eq!(f.read(), "A1|A2\nb1|B2|b3", "the middle step on the second slide, the others on the run's target");
    assert_eq!(f.editor().await, before);
    f.shutdown().await;
}

#[tokio::test]
async fn at_two_steps_on_two_parts_reach_their_objects_and_a_failing_second_rolls_back_the_first() {
    let Some(f) = Fixture::new("parts", SLIDES).await else { return };
    let before = f.editor().await;
    f.ok(
        "run",
        json!({ "steps": [
            { "command": "shape.text", "on": ["s3"], "params": { "text": "B3" }, "at": { "part": { "slideId": 102 } } },
            { "command": "shape.text", "on": ["s1"], "params": { "text": "A1" }, "at": { "part": { "slide": 1 } } }
        ] }),
    )
    .await;
    assert_eq!(f.read(), "A1|a2\nb1|b2|B3");

    let failed = f
        .refused(
            "run",
            json!({ "steps": [
                { "command": "shape.text", "on": ["s3"], "params": { "text": "lost" }, "at": { "part": { "slide": 2 } } },
                { "command": "shape.text", "on": ["s3"], "params": { "text": "X" }, "at": { "part": { "slide": 1 } } }
            ] }),
        )
        .await;
    assert_eq!(failed["error"]["index"], 1, "the first slide has no s3: {failed}");
    says(&failed, &["s3"]);
    assert_eq!(commands(&failed["rolledBack"]), ["shape.text"], "{failed}");
    assert_eq!(f.read(), "A1|a2\nb1|b2|B3", "the second slide's edit was rolled back");
    assert_eq!(f.ok("inspect", json!({})).await["details"]["text"], "A1|a2\nb1|b2|B3");
    assert_eq!(f.editor().await, before);
    f.shutdown().await;
}

#[tokio::test]
async fn at_a_part_that_is_not_a_part_is_invalid_params() {
    let Some(f) = Fixture::new("badpart", SLIDES).await else { return };
    for at in [json!({ "part": { "slide": 0 } }), json!({ "part": 3 }), json!({ "time": "soon" }), json!({ "where": 1 })] {
        let refused = f.refused("run", json!({ "steps": [{ "command": "shape.text", "params": { "id": "s1", "text": "X" }, "at": at }] })).await;
        assert_eq!(refused["error"]["code"], "invalid-params", "{at}: {refused}");
    }
    assert_eq!(f.read(), DECK);
    f.shutdown().await;
}

// ---- Parts a kit declares ----

/// The mock with a timeline (each line a sequence) and the editor-state hooks.
const TIMELINE: &str = "KITION_KIT_MOCK_PARTS=timeline";

/// The open sequence (counted from 1) and playhead, as the timeline mock's `view.describe` reports them.
async fn timeline_editor(f: &Fixture) -> Value {
    let answer = f.ok("inspect", json!({})).await;
    json!({ "sequence": answer["details"]["sequence"], "playhead": answer["details"]["playhead"] })
}

#[tokio::test]
async fn parts_a_kit_that_declares_its_part_nouns_takes_them_as_target_and_at_part() {
    let Some(f) = Fixture::declaring("seqparts", TIMELINE, Some(&["sequence"])).await else { return };
    let before = timeline_editor(&f).await;
    assert_eq!(before["sequence"], 1);

    let append = |text: &str| json!({ "command": "sequence.append", "params": { "text": text } });
    f.ok("run", json!({ "target": { "sequence": 2 }, "steps": [append("X")] })).await;
    assert_eq!(f.read(), "a1|a2\nb1|b2|b3X", "the run's `target` reached the kit's set_context unchanged");
    f.ok("run", json!({ "target": { "sequence": 2 }, "steps": [append("Y"), { "command": "sequence.append", "params": { "text": "Z" }, "at": { "part": { "sequence": 1 } } }] }))
        .await;
    assert_eq!(f.read(), "a1|a2Z\nb1|b2|b3XY", "a step's `at.part` overrides the run's target for that step");
    assert_eq!(timeline_editor(&f).await, before, "the open sequence is as it was");

    for target in [json!({ "slide": 1 }), json!({ "sequence": 1, "comp": 1 }), json!({ "sequence": true })] {
        let refused = f.refused("run", json!({ "target": target, "steps": [append("!")] })).await;
        assert_eq!(refused["error"]["code"], "invalid-params", "{target}: {refused}");
        says(&refused, &["`sequence`"]);
    }
    let refused = f.refused("run", json!({ "steps": [{ "command": "sequence.append", "params": { "text": "!" }, "at": { "part": { "page": 2 } } }] })).await;
    assert_eq!(refused["error"]["code"], "invalid-params", "{refused}");
    says(&refused, &["`page`", "`sequence`"]);
    assert_eq!(f.read(), "a1|a2Z\nb1|b2|b3XY", "nothing ran");
    f.shutdown().await;
}

#[tokio::test]
async fn parts_a_kit_that_declares_none_keeps_slides_and_pages() {
    let Some(f) = Fixture::new("seqnone", TIMELINE).await else { return };
    let refused = f.refused("run", json!({ "target": { "sequence": 2 }, "steps": [{ "command": "sequence.append", "params": { "text": "X" } }] })).await;
    assert_eq!(refused["error"]["code"], "invalid-params", "{refused}");
    says(&refused, &["`sequence`", "`slide`", "`page`"]);
    f.shutdown().await;
}

// ---- A kit without the editor-state hooks ----

#[tokio::test]
async fn nohooks_a_target_and_on_for_a_target_parameter_keep_working() {
    let Some(f) = Fixture::new("plain", SLIDES_WITHOUT_HOOKS).await else { return };
    f.ok("run", json!({ "target": { "slide": 2 }, "steps": [set_text("s3", "B3")] })).await;
    f.ok("run", json!({ "target": { "slideId": 101 }, "steps": [{ "command": "shape.text", "on": ["s1"], "params": { "text": "A1" } }] })).await;
    assert_eq!(f.read(), "A1|a2\nb1|b2|B3");
    f.shutdown().await;
}

#[tokio::test]
async fn nohooks_on_for_a_selection_command_is_unsupported_and_never_acts_on_the_old_selection() {
    let Some(f) = Fixture::new("oldsel", SLIDES_WITHOUT_HOOKS).await else { return };
    f.person("select.set", json!({ "ids": ["s1"] })).await;
    let refused = f.refused("run", json!({ "target": { "slide": 1 }, "steps": [set_text("s2", "A2"), { "command": "format.mark", "on": ["s2"] }] })).await;
    assert_eq!(refused["error"]["code"], "unsupported", "{refused}");
    assert_eq!(refused["error"]["index"], 1, "{refused}");
    says(&refused, &["`format.mark`", "selection"]);
    assert_eq!(f.read(), DECK, "the step before it was not run either, and s1 was not marked");
    f.shutdown().await;
}

// ---- A document open in its editor ----

type Seen = Arc<Mutex<Vec<Value>>>;

/// A renderer window with `path` open in the editor of `kit`, recording each `run` it gets.
fn editor(kits: &KitManager, kit: &'static KitDefinition, path: &str) -> Seen {
    let bridge = kits.bridge().clone();
    let (session, mut rx) = bridge.connect();
    let runs: Seen = Arc::default();
    let seen = Arc::clone(&runs);
    let path = path.to_owned();
    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let Some(id) = message["id"].as_u64() else { continue };
            let params = &message["params"];
            let mut reply = match (message["method"].as_str(), params["tool"].as_str()) {
                (Some("kit/documents"), _) => json!({ "result": { "documents": [{ "path": path, "kit": kit.id, "dirty": false, "revision": 1 }] } }),
                (Some("kit/call"), Some("run")) => {
                    seen.lock().unwrap_or_else(|err| panic!("{err}")).push(params["arguments"].clone());
                    json!({ "result": { "completed": [{ "command": "shape.text" }], "saved": true, "document": { "summary": "2 slides" } } })
                }
                (Some("kit/preview"), _) => json!({ "error": { "code": -32000, "message": "no preview" } }),
                _ => json!({ "error": { "code": -32000, "message": "unexpected call" } }),
            };
            reply["jsonrpc"] = json!("2.0");
            reply["id"] = json!(id);
            let _ = bridge.receive(session, &reply);
        }
    });
    runs
}

#[tokio::test]
async fn live_a_run_in_an_open_editor_refuses_the_context_it_cannot_honour_and_names_it() {
    let live = kit("liveed", false);
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(live, None)]);
    let runs = editor(&kits, live, "a.liveed");
    let call = |input: Value| {
        let kits = &kits;
        async move {
            match tools::call(kits, "liveed_run", &input).await {
                Some(answer) => answer,
                None => panic!("liveed_run is not a kit tool"),
            }
        }
    };
    let cases = [
        (json!({ "path": "a.liveed", "target": { "slide": 2 }, "steps": [set_text("s1", "X")] }), "`target`"),
        (json!({ "path": "a.liveed", "steps": [{ "command": "shape.text", "on": ["s1"], "params": { "text": "X" } }] }), "`on`"),
        (
            json!({ "path": "a.liveed", "steps": [set_text("s1", "X"), { "command": "shape.text", "params": { "id": "s1", "text": "X" }, "at": { "part": { "slide": 2 } } }] }),
            "`at`",
        ),
    ];
    for (input, member) in cases {
        let Err(error) = call(input.clone()).await else { panic!("{input} was expected to fail") };
        assert_eq!(error.code.as_str(), "unsupported", "{input}: {}", error.message);
        assert!(error.message.contains(member) && error.message.contains("open"), "{member}: {}", error.message);
    }
    assert!(runs.lock().unwrap_or_else(|err| panic!("{err}")).is_empty(), "nothing reached the editor");

    // A run that names no context still runs in the editor.
    let ran = call(json!({ "path": "a.liveed", "steps": [set_text("s1", "X")] })).await;
    assert!(ran.is_ok(), "{:?}", ran.err().map(|error| error.message));
    assert_eq!(runs.lock().unwrap_or_else(|err| panic!("{err}")).len(), 1);
    kits.shutdown().await;
}

/// A kit that declares a built-in noun (`page`) as its own part noun: the noun's value is the
/// part's id as the kit lists it (here counted from 0), in a run's `target`, a step's `at.part`
/// and an inspect's `target` alike, never a number counted from 1 (regressions/issue-declared-part-noun).
#[tokio::test]
async fn parts_a_declared_built_in_noun_carries_the_parts_id_everywhere() {
    let Some(f) = Fixture::declaring("pageparts", &format!("{TIMELINE} KITION_KIT_MOCK_PART_NOUN=page"), Some(&["page"])).await else { return };
    let before = timeline_editor(&f).await;
    let append = |text: &str| json!({ "command": "sequence.append", "params": { "text": text } });
    f.ok("run", json!({ "target": { "page": 0 }, "steps": [append("X")] })).await;
    assert_eq!(f.read(), "a1|a2X\nb1|b2|b3", "page 0 is the kit's id of the first part");
    f.ok("run", json!({ "steps": [{ "command": "sequence.append", "params": { "text": "Y" }, "at": { "part": { "page": 1 } } }] })).await;
    assert_eq!(f.read(), "a1|a2X\nb1|b2|b3Y");
    let seen = f.ok("inspect", json!({ "target": { "page": 1 } })).await;
    assert_eq!(seen["details"]["sequence"], 2, "the inspect shows the part its target names: {seen}");
    assert_eq!(timeline_editor(&f).await, before, "and puts the kit's part back");
    f.shutdown().await;
}
