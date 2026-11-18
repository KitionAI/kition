// Copied from kition-sdk crates/kition-kits/tests/place_guard.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The premise guard on a timeline, against the mock kit's tracks of clips
//! (`KITION_KIT_MOCK_PARTS=tracks`: clips with integer ids, a `start` and `duration` the schema
//! marks as their position, commands that address clips by id, by the selection, or by a place: a
//! track and the playhead).
//!
//! - A step that names its objects by a place (a command that reads the time given `at.time`, or a
//!   parameter marked `x-khp-role: place`) has the premise "the objects under that place are the
//!   ones that were there at `basis`": a colleague's ripple insert before it refuses the write as
//!   `relocated`, naming what is under the place now and where the clips that were there went; a
//!   change elsewhere (later on the track, on another track, a property) does not.
//! - A command declared position-independent (`x-khp-position: independent`) is not refused when
//!   its target only moved; one that is not stays refused, as `relocated` (a `start` change is a
//!   move, not a change of content).
//! - A shift of many clips is stated once (`footprint`) in receipts and in `others`, and the guard
//!   reads it as if every clip were listed.
//! - Integer tool ids are numbers in receipts, `others` and `conflicts`, and `on` takes a number
//!   or a numeric string.
//! - A step whose parameters the command's schema refuses is `invalid-params`, before the guard.
//!
//! Cases: `sdk.agent.premise-guard/places`, `sdk.agent.premise-guard/position`,
//! `sdk.agent.receipts/footprint`, `regressions/issue-guard-invalid-params-first`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, tests that can skip it say so and pass. CI requires it.
#![cfg(unix)]

#[path = "support/editor.rs"]
mod editor;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use kition_kits::tools::{self, CallOptions};
use kition_kits::{KitDefinition, KitManager};
use serde_json::{Value, json};

fn kit(name: &str) -> &'static KitDefinition {
    let manifest = json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": format!("Kition {name}"), "version": "0.3.1",
        "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
        "agent": { "prefix": name, "tools": "document", "parts": ["track"] },
        "headless": { "executable": "kition-kit-mock", "protocol": "kition-kit/2" }
    });
    KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"))
}

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

fn as_kit(dir: &Path, mock: &Path, name: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join(format!("kition-{name}-mock.sh"));
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nKITION_KIT_MOCK_AS=kit.{name}:{name} KITION_KIT_MOCK_VERSION=0.3.1 KITION_KIT_MOCK_PARTS=tracks KITION_KIT_MOCK_BATCH=commands exec '{}' \"$@\"\n",
            mock.display()
        ),
    )
    .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    script
}

const ME: &str = "agent-me";
const OTHER: &str = "agent-other";

#[tokio::test]
async fn raw_batches_need_a_declared_premise_contract_even_on_a_fresh_basis() {
    let f = Fixture::new("batchcontract", &timeline(5)).expect("build mock");
    let basis = f.revision(ME).await;
    let before = f.read();
    let result = f.call(ME, "batch", json!({"basis":basis,"ops":[{"op":"set","target":"2","field":"opacity","value":30}]})).await;
    assert!(result.is_err(), "an undeclared raw operation must refuse: {result:?}");
    assert_eq!(f.read(), before);
    f.shutdown().await;
}

#[tokio::test]
async fn raw_command_mappings_hold_the_commands_fields_and_allow_unrelated_changes() {
    for outside in [false, true] {
        for held in [false, true] {
            let f = Fixture::new("batchmapped", &timeline(5)).expect("build mock");
            let basis = f.revision(ME).await;
            let clip = if held { 2 } else { 4 };
            if outside {
                f.write_outside(&with_opacity(&f.read(), clip, 40));
            } else {
                f.ok(OTHER, "run", json!({"steps":[{"command":"clip.opacity","params":{"clip":clip,"opacity":40}}]})).await;
            }
            let before = f.read();
            let result = f
                .call(
                    ME,
                    "batch",
                    json!({"basis":basis,"ops":[
                        {"op":"set","target":"4","field":"enabled","value":false},
                        {"op":"set","target":"2","field":"opacity","value":30}
                    ]}),
                )
                .await;
            if held {
                let error = result.expect_err("held opacity");
                assert_eq!(conflict_on(&error, 2)["reason"], "changed", "{error}");
                assert_eq!(f.read(), before);
            } else {
                assert!(result.is_ok(), "{result:?}");
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn later_steps_hold_the_selection_made_by_the_run() {
    for outside in [false, true] {
        for held in [false, true] {
            let f = Fixture::new("stepselection", &timeline(5)).expect("build mock");
            let basis = f.revision(ME).await;
            let clip = if held { 2 } else { 4 };
            if outside {
                let original = format!("{clip}={}+1", clip - 1);
                f.write_outside(&f.read().replace(&original, &format!("{original}!")));
            } else {
                f.ok(OTHER, "run", json!({"steps":[{"command":"clip.disable","params":{"clips":[clip]}}]})).await;
            }
            let before = f.read();
            let result = f
                .call(
                    ME,
                    "run",
                    json!({"basis":basis,"steps":[
                        {"command":"timeline.selectAt","params":{"track":"V1"},"at":{"time":1.5}},
                        {"command":"clip.disable"}
                    ]}),
                )
                .await;
            if held {
                let error = result.expect_err("step two must hold the selected clip");
                assert_eq!(conflict_on(&error, 2)["reason"], "changed", "{error}");
                assert_eq!(f.read(), before);
            } else {
                assert!(result.is_ok(), "unrelated change: {result:?}");
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn later_steps_read_objects_created_and_moved_by_the_run() {
    for outside in [false, true] {
        for created in [false, true] {
            for held in [false, true] {
                let f = Fixture::new("stepmodel", &timeline(5)).expect("build mock");
                let basis = f.revision(ME).await;
                let clip = if held { if created { 1 } else { 2 } } else { 4 };
                if outside {
                    f.write_outside(&with_opacity(&f.read(), clip, 30));
                } else {
                    f.ok(OTHER, "run", json!({"steps":[{"command":"clip.opacity","params":{"clip":clip,"opacity":30}}]})).await;
                }
                let before = f.read();
                let result = f
                    .call(
                        ME,
                        "run",
                        json!({"basis":basis,"steps":[
                            {"command":"timeline.insert","params":{"track":"V1","at":0,"duration":1}},
                            {"command":"timeline.razor","params":{"track":"V1"},"at":{"time":if created { 0.5 } else { 2.5 }}}
                        ]}),
                    )
                    .await;
                if held {
                    let error = result.expect_err("the source object is held");
                    assert_eq!(conflict_on(&error, clip)["reason"], "changed", "{error}");
                    assert_eq!(f.read(), before);
                } else {
                    assert!(result.is_ok(), "created={created}, outside={outside}: {result:?}");
                    assert!(f.read().contains(if created { "1001=0+0.5" } else { "2=2+0.5" }), "{}", f.read());
                }
                f.shutdown().await;
            }
        }
    }
}

#[tokio::test]
async fn batch_command_context_matches_run_context_and_guard() {
    for outside in [false, true] {
        let f = Fixture::new("batchtime", &timeline(5)).expect("build mock");
        let basis = f.revision(ME).await;
        if outside {
            f.write_outside(&ripple_inserted(5, 20));
        } else {
            f.ok(OTHER, "run", json!({"steps":[{"command":"timeline.insert","params":{"track":"V1","at":0,"duration":1}}]})).await;
        }
        let before = f.read();
        let refused =
            f.refused(ME, "batch", json!({"basis":basis,"ops":[{"op":"command","id":"timeline.razor","params":{"track":"V1"},"at":{"time":2.5}}]})).await;
        assert!(refused["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "relocated"), "{refused}");
        assert_eq!(f.read(), before);
        let current = f.revision(ME).await;
        f.ok(ME, "batch", json!({"basis":current,"ops":[{"op":"command","id":"timeline.razor","params":{"track":"V1"},"at":{"time":2.5}}]})).await;
        assert!(f.read().contains("2+0.5"), "razor must use explicit batch time: {}", f.read());
        f.ok(ME, "batch", json!({"ops":[{"op":"command","id":"clip.disable","on":[5]}]})).await;
        assert!(f.read().contains("5=5+1!"), "selection must reach command: {}", f.read());
        f.shutdown().await;
    }
}

/// `count` one-second clips end to end on V1, numbered from 1, and one long clip (1000) on V2.
fn timeline(count: u64) -> String {
    let clips: Vec<String> = (1..=count).map(|n| format!("{n}={}+1", n - 1)).collect();
    format!("V1:{}\nV2:1000=0+{count}", clips.join("|"))
}

/// The timeline with a one-second clip `n` put at 0 s on V1, the others one second later.
fn ripple_inserted(count: u64, n: u64) -> String {
    let clips: Vec<String> = std::iter::once(format!("{n}=0+1")).chain((1..=count).map(|at| format!("{at}={at}+1"))).collect();
    format!("V1:{}\nV2:1000=0+{count}", clips.join("|"))
}

struct Fixture {
    kits: KitManager,
    name: String,
    options: CallOptions,
    workspace: tempfile::TempDir,
    _bin: tempfile::TempDir,
}

impl Fixture {
    fn new(name: &str, text: &str) -> Option<Self> {
        let Some(mock) = mock_binary() else {
            eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
            return None;
        };
        let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(workspace.path().join(format!("a.{name}")), text).unwrap_or_else(|err| panic!("{err}"));
        let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit(name), Some(as_kit(bin.path(), &mock, name)))]);
        editor::attach(&kits, workspace.path(), kit(name), &as_kit(bin.path(), &mock, name), &format!("a.{name}"));
        Some(Self { kits, name: name.to_owned(), options: CallOptions::default(), workspace, _bin: bin })
    }

    async fn call(&self, agent: &str, action: &str, mut input: Value) -> Result<Value, Value> {
        input["path"] = json!(format!("a.{}", self.name));
        match tools::call_as(&self.kits, &format!("{}_{action}", self.name), &input, self.options, agent).await {
            Some(Ok(output)) => Ok(output.output),
            Some(Err(error)) => Err(error.structured()),
            None => panic!("{action} is not a kit tool"),
        }
    }

    async fn ok(&self, agent: &str, action: &str, input: Value) -> Value {
        self.call(agent, action, input).await.unwrap_or_else(|error| panic!("{action}: {error}"))
    }

    async fn refused(&self, agent: &str, action: &str, input: Value) -> Value {
        match self.call(agent, action, input).await {
            Err(error) => error,
            Ok(answer) => panic!("{action} was expected to be refused: {answer}"),
        }
    }

    async fn revision(&self, agent: &str) -> String {
        let seen = self.ok(agent, "inspect", json!({})).await;
        seen["revision"].as_str().unwrap_or_else(|| panic!("inspect answers a revision: {seen}")).to_owned()
    }

    fn file(&self) -> PathBuf {
        self.workspace.path().join(format!("a.{}", self.name))
    }

    fn read(&self) -> String {
        std::fs::read_to_string(self.file()).unwrap_or_else(|err| panic!("{err}"))
    }

    /// Writes the file as a colleague's program would, an hour before its own time.
    fn write_outside(&self, text: &str) {
        let at = std::fs::metadata(self.file()).and_then(|meta| meta.modified()).unwrap_or_else(|err| panic!("{err}")) - Duration::from_secs(3600);
        write_at(&self.file(), text, at);
    }

    async fn shutdown(self) {
        self.kits.shutdown().await;
    }
}

fn write_at(file: &Path, text: &str, at: SystemTime) {
    std::fs::write(file, text).unwrap_or_else(|err| panic!("{err}"));
    let handle = std::fs::File::options().write(true).open(file).unwrap_or_else(|err| panic!("{err}"));
    handle.set_modified(at).unwrap_or_else(|err| panic!("{err}"));
}

/// The steps that disable what is under 2.5 s on V1: select it there, then disable the selection.
fn disable_at(time: f64) -> Value {
    json!([{ "command": "timeline.selectAt", "params": { "track": "V1" }, "at": { "time": time } }, { "command": "clip.disable" }])
}

fn razor_at(time: f64) -> Value {
    json!([{ "command": "timeline.razor", "params": { "track": "V1" }, "at": { "time": time } }])
}

fn opacity(clip: u64, value: f64) -> Value {
    json!({ "command": "clip.opacity", "on": [clip], "params": { "opacity": value } })
}

/// The timeline's text with clip `clip`'s opacity set to `value`.
fn with_opacity(text: &str, clip: u64, value: u32) -> String {
    let lines: Vec<String> = text
        .lines()
        .map(|line| {
            let Some((track, clips)) = line.split_once(':') else { return line.to_owned() };
            let clips: Vec<String> = clips
                .split('|')
                .map(|item| match item.split_once('=') {
                    Some((n, span)) if n == clip.to_string() => format!("{n}={}@{value}", span.split('@').next().unwrap_or(span)),
                    _ => item.to_owned(),
                })
                .collect();
            format!("{track}:{}", clips.join("|"))
        })
        .collect();
    lines.join("\n")
}

fn conflict_on(refused: &Value, id: u64) -> &Value {
    refused["conflicts"]
        .as_array()
        .and_then(|conflicts| conflicts.iter().find(|conflict| conflict["id"] == json!(id)))
        .unwrap_or_else(|| panic!("no conflict on {id}: {refused}"))
}

fn ids(list: &Value) -> Vec<Value> {
    list.as_array().map(|items| items.iter().map(|item| item["id"].clone()).collect()).unwrap_or_default()
}

/// The clip numbers a change set says moved in time: listed as changed in `start`, or covered by
/// a `footprint` shift of `start` (read with the track's clips as the file holds them now).
fn shifted(changes: &Value, file: &str) -> Vec<u64> {
    let mut found: Vec<u64> = changes["changed"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["fields"].as_array().is_some_and(|fields| fields.contains(&json!("start"))))
        .filter_map(|item| item["id"].as_u64())
        .collect();
    for print in changes["footprint"].as_array().into_iter().flatten() {
        let track = print["parent"].as_str().unwrap_or_default();
        let line = file.lines().find(|line| line.starts_with(&format!("{track}:"))).unwrap_or_default();
        let clips: Vec<u64> =
            line.split_once(':').map(|(_, clips)| clips.split('|').filter_map(|clip| clip.split('=').next()?.parse().ok()).collect()).unwrap_or_default();
        if print["shift"]["field"] == "start" {
            let from = print["from"].as_u64().unwrap_or(0) as usize;
            let count = print["count"].as_u64().unwrap_or(0) as usize;
            found.extend(clips.iter().skip(from).take(count));
        }
    }
    found.sort_unstable();
    found
}

// ---- 1. A place is a premise ----

/// A colleague ripple-inserts a clip at 0 s on V1: the clip the agent saw under 2.5 s (3) is now
/// under 3.5 s, and 2 is under 2.5 s. The agent's "select what is at 2.5 s on V1, then disable it"
/// with `basis` is refused as `relocated`: the conflict names 2 (under the place now) and 3 (there
/// at `basis`, now at index 3 starting at 3 s), and nothing is written.
#[tokio::test]
async fn places_a_write_by_time_after_a_ripple_insert_is_refused_as_relocated() {
    let Some(f) = Fixture::new("plsel", &timeline(8)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside(&ripple_inserted(8, 9));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": disable_at(2.5) })).await;
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    let entered = conflict_on(&refused, 2);
    assert_eq!(entered["reason"], "relocated", "{refused}");
    assert_eq!(entered["place"]["under"], json!([2]), "what is under the place now: {refused}");
    let left = conflict_on(&refused, 3);
    assert_eq!(left["reason"], "relocated", "{refused}");
    assert_eq!((left["now"]["parent"].clone(), left["now"]["index"].clone(), left["now"]["start"].clone()), (json!("V1"), json!(3), json!(3)), "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    eprintln!("places: refusal {} bytes: {}", refused.to_string().len(), refused["conflicts"]);
    // After an inspect the same steps apply, to what is there now.
    let basis = f.revision(ME).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": disable_at(2.5) })).await;
    assert!(f.read().contains("2=2+1!"), "{}", f.read());
    f.shutdown().await;
}

/// The same with the track and time in the step itself: a razor cut on V1 at 2.5 s is refused,
/// whether the ripple insert came from the file or from another agent.
#[tokio::test]
async fn places_a_cut_by_track_and_time_after_a_ripple_insert_is_refused() {
    let Some(f) = Fixture::new("plcut", &timeline(8)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside(&ripple_inserted(8, 9));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": razor_at(2.5) })).await;
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    assert_eq!(conflict_on(&refused, 3)["reason"], "relocated", "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "timeline.insert", "params": { "track": "V1", "at": 0, "duration": 1 } }] })).await;
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": razor_at(2.5) })).await;
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    f.shutdown().await;
}

/// The clip under the place deleted without a ripple (a gap there now): refused, naming it.
#[tokio::test]
async fn places_a_write_where_a_clip_was_deleted_is_refused() {
    let Some(f) = Fixture::new("plgap", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside("V1:1=0+1|2=1+1|4=3+1|5=4+1\nV2:1000=0+5");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": razor_at(2.5) })).await;
    assert_eq!(conflict_on(&refused, 3)["reason"], "deleted", "{refused}");
    f.shutdown().await;
}

/// Changes elsewhere never refuse a write by place: a ripple delete later on the track, a clip
/// changed on another track, a property of the clip under the place.
#[tokio::test]
async fn places_a_write_by_time_after_a_change_elsewhere_applies() {
    let Some(f) = Fixture::new("plelse", &timeline(8)) else { return };
    for (n, changed) in [
        "V1:1=0+1|2=1+1|3=2+1|4=3+1|5=4+1|7=5+1|8=6+1\nV2:1000=0+8",
        "V1:1=0+1|2=1+1|3=2+1|4=3+1|5=4+1|7=5+1|8=6+1\nV2:1000=0+8@40",
        "V1:1=0+1|2=1+1|3=2+1@70|4=3+1|5=4+1|7=5+1|8=6+1\nV2:1000=0+8@40",
    ]
    .iter()
    .enumerate()
    {
        let basis = f.revision(ME).await;
        f.write_outside(changed);
        let ran =
            f.ok(ME, "run", json!({ "basis": basis, "steps": [{ "command": "timeline.selectAt", "params": { "track": "V1" }, "at": { "time": 2.5 } }] })).await;
        assert!(ran["others"].is_object(), "{n}: others tells the change: {ran}");
    }
    let basis = f.revision(ME).await;
    f.write_outside("V1:1=0+1|2=1+1|3=2+1@70|4=3+1|5=4+1|8=5+1\nV2:1000=0+8@40");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": disable_at(2.5) })).await;
    assert_eq!(ids(&ran["changes"]["changed"]), [json!(3)], "{ran}");
    f.shutdown().await;
}

/// Fifty rounds on a 24-clip timeline: a colleague changes the opacity of a random clip other than
/// the one under 10.5 s, then the agent writes with the revision of its last answer, by place (a
/// cut at 10.5 s, undone in the same run) and by id. None is refused.
#[tokio::test]
async fn places_fifty_unrelated_changes_refuse_no_write_by_place_or_by_id() {
    let Some(f) = Fixture::new("plfifty", &timeline(24)) else { return };
    let mut basis = f.revision(ME).await;
    let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
    let (mut by_place, mut by_id) = (0, 0);
    let mut times = (Vec::new(), Vec::new());
    let mut pick = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let theirs = 1 + seed % 23;
        if theirs >= 11 { theirs + 1 } else { theirs }
    };
    for round in 0..50u32 {
        f.write_outside(&with_opacity(&f.read(), pick(), round + 1));
        let started = Instant::now();
        let steps = json!([{ "command": "timeline.selectAt", "params": { "track": "V1" }, "at": { "time": 10.5 } }, opacity(11, f64::from(round % 2))]);
        match f.call(ME, "run", json!({ "basis": basis, "steps": steps })).await {
            Ok(ran) => basis = ran["revision"].as_str().unwrap_or_default().to_owned(),
            Err(error) => {
                by_place += 1;
                basis = error["revision"].as_str().unwrap_or_default().to_owned();
            }
        }
        times.0.push(started.elapsed().as_secs_f64() * 1000.0);
        f.write_outside(&with_opacity(&f.read(), pick(), round + 2));
        let started = Instant::now();
        match f.call(ME, "run", json!({ "basis": basis, "steps": [opacity(11, 50.0 + f64::from(round % 2))] })).await {
            Ok(ran) => basis = ran["revision"].as_str().unwrap_or_default().to_owned(),
            Err(error) => {
                by_id += 1;
                basis = error["revision"].as_str().unwrap_or_default().to_owned();
            }
        }
        times.1.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let median = |mut values: Vec<f64>| {
        values.sort_by(f64::total_cmp);
        values[values.len() / 2]
    };
    eprintln!("places: 50 rounds: {by_place} writes by place and {by_id} by id refused; median {:.1} ms and {:.1} ms", median(times.0), median(times.1));
    assert_eq!((by_place, by_id), (0, 0));
    f.shutdown().await;
}

/// Without `basis`, a change made in the file refuses the next write once, as for any write.
#[tokio::test]
async fn places_without_basis_the_next_write_is_refused_once() {
    let Some(f) = Fixture::new("plnob", &timeline(5)) else { return };
    f.revision(ME).await;
    f.write_outside(&ripple_inserted(5, 9));
    let refused = f.refused(ME, "run", json!({ "steps": razor_at(2.5) })).await;
    assert!(refused["changedOutside"].is_object(), "{refused}");
    f.ok(ME, "run", json!({ "steps": razor_at(2.5) })).await;
    f.shutdown().await;
}

// ---- 2. Position is a premise only when the command depends on it ----

/// After a ripple insert before clip 3, a position-independent write on it (its opacity) applies,
/// and `others` says it moved; a write that depends on its position (its duration) is refused as
/// `relocated`, with where it is now.
#[tokio::test]
async fn position_an_independent_write_on_a_moved_clip_applies_and_a_dependent_one_is_refused() {
    let Some(f) = Fixture::new("plpos", &timeline(8)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside(&ripple_inserted(8, 9));
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "clip.trim", "on": [3], "params": { "duration": 0.5 } }] })).await;
    let conflict = conflict_on(&refused, 3);
    assert_eq!((conflict["reason"].clone(), conflict["now"]["index"].clone()), (json!("relocated"), json!(3)), "{refused}");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [opacity(3, 40.0)] })).await;
    assert!(f.read().contains("3=3+1@40"), "{}", f.read());
    assert!(shifted(&ran["others"], &f.read()).contains(&3), "others says clip 3 moved: {ran}");
    f.shutdown().await;
}

/// Only clip 3's start moved (clip 2 trimmed by a ripple, 3 keeps its index): the independent write
/// applies; the dependent one is refused as `relocated` (a start is a position, not content).
#[tokio::test]
async fn position_a_start_change_alone_is_a_move() {
    let Some(f) = Fixture::new("plstart", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside("V1:1=0+1|2=1+0.5|3=1.5+1|4=2.5+1|5=3.5+1\nV2:1000=0+5");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "clip.trim", "on": [3], "params": { "duration": 0.5 } }] })).await;
    assert_eq!(conflict_on(&refused, 3)["reason"], "relocated", "{refused}");
    f.ok(ME, "run", json!({ "basis": basis, "steps": [opacity(3, 40.0)] })).await;
    f.shutdown().await;
}

// ---- 3. A shift is stated once ----

/// A ripple delete of the first clip of 5 and of 200: the receipt names the deleted clip and one
/// footprint for the shift, not one entry per clip, nor V1's list change; `changes: "all"` lists
/// every clip. Another agent's ripple delete reaches `others` the same way, and the guard reads
/// the footprint as listing each clip it covers.
#[tokio::test]
async fn footprint_a_ripple_delete_states_the_shift_once() {
    for count in [5u64, 200] {
        let Some(f) = Fixture::new(&format!("plfp{count}"), &timeline(count)) else { return };
        let ran = f.ok(ME, "run", json!({ "steps": [{ "command": "edit.rippleDelete", "params": { "clips": [1] } }] })).await;
        let changes = &ran["changes"];
        assert_eq!(ids(&changes["deleted"]), [json!(1)], "{changes}");
        assert_eq!(changes["changed"], json!([]), "neither each clip nor V1's list: {changes}");
        assert_eq!(
            changes["footprint"],
            json!([{ "parent": "V1", "field": "clips", "from": 0, "count": count - 1, "shift": { "field": "start", "by": -1 } }]),
            "{changes}"
        );
        let all = f.ok(ME, "run", json!({ "changes": "all", "steps": [{ "command": "edit.rippleDelete", "params": { "clips": [2] } }] })).await;
        assert_eq!(all["changes"]["changed"].as_array().map(Vec::len), Some(count as usize - 1), "every shifted clip and V1: {}", all["changes"]);
        assert!(all["changes"].get("footprint").is_none(), "{}", all["changes"]);
        eprintln!(
            "footprint: a ripple delete on {count} clips: receipt {} bytes (\"all\": {} bytes)",
            changes.to_string().len(),
            all["changes"].to_string().len()
        );
        let basis = f.revision(ME).await;
        f.ok(OTHER, "run", json!({ "steps": [{ "command": "edit.rippleDelete", "params": { "clips": [3] } }] })).await;
        let refused =
            f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "clip.trim", "on": [count], "params": { "duration": 0.5 } }] })).await;
        assert_eq!(conflict_on(&refused, count)["reason"], "relocated", "{refused}");
        // Of 5 clips two are left to shift, fewer than a footprint states; of 200, 197.
        assert_eq!(refused["others"]["footprint"].is_array(), count > 5, "{refused}");
        eprintln!("footprint: `others` after another agent's ripple delete on {count} clips: {} bytes", refused["others"].to_string().len());
        f.shutdown().await;
    }
}

// ---- 4. One id form ----

/// Clips have integer tool ids: receipts, `others` and conflicts name them as numbers, and `on`
/// takes a number or a numeric string, handed to the command as the integer it declares.
#[tokio::test]
async fn ids_integer_tool_ids_are_numbers_everywhere() {
    let Some(f) = Fixture::new("plids", &timeline(5)) else { return };
    let ran = f.ok(ME, "run", json!({ "steps": [{ "command": "clip.opacity", "on": ["3"], "params": { "opacity": 20 } }] })).await;
    assert_eq!(ids(&ran["changes"]["changed"]), [json!(3)], "{ran}");
    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.ok(OTHER, "run", json!({ "steps": [opacity(3, 30.0)] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "clip.trim", "on": [3], "params": { "duration": 0.5 } }] })).await;
    assert_eq!(ids(&refused["others"]["changed"]), [json!(3)], "{refused}");
    assert_eq!(refused["conflicts"][0]["id"], json!(3), "{refused}");
    f.shutdown().await;
}

/// `_query` and a batch's `loaded` name clips by numbers too (an object's id, the
/// ids its lists hold), and take them as numbers; a position's parent takes the form of its type,
/// so a track named `2` stays the string `"2"` where the old rule (all digits) made it a number.
#[tokio::test]
async fn ids_query_and_loads_name_integer_tool_ids_as_numbers_and_parents_by_their_type() {
    let Some(f) = Fixture::new("plidq", "2:5=0+1|6=1+1\nV2:1000=0+2") else { return };
    let read = f.ok(ME, "query", json!({ "objects": ["2"] })).await;
    assert_eq!((read["objects"][0]["id"].clone(), read["objects"][0]["fields"]["clips"].clone()), (json!("2"), json!([5, 6])), "{read}");
    let clip = f.ok(ME, "query", json!({ "objects": [6] })).await;
    assert_eq!((clip["objects"][0]["id"].clone(), clip["objects"][0]["fields"]["id"].clone()), (json!(6), json!(6)), "{clip}");
    let ran = f
        .ok(ME, "batch", json!({ "ops": [{ "op": "set", "target": 5, "field": "opacity", "value": 10 }], "load": [{ "target": 5, "fields": ["opacity"] }] }))
        .await;
    assert_eq!((ran["loaded"][0]["id"].clone(), ids(&ran["changes"]["changed"])), (json!(5), vec![json!(5)]), "{ran}");
    let ran = f.ok(ME, "run", json!({ "steps": [{ "command": "timeline.insert", "params": { "track": "2", "at": 0, "duration": 1 } }] })).await;
    assert_eq!(ran["changes"]["created"][0]["at"], json!({ "parent": "2", "field": "clips", "index": 0 }), "{ran}");
    f.shutdown().await;
}

/// The clips' tool-id field is named `id` (as a motion kit's layers' is). A change made in the
/// file is named by the clip, not counted in `unnamed`: another clip's opacity is in
/// `others.changed` with its edit and the write applies; the target's opacity changed refuses the
/// write as `changed`, nothing written; a deleted target is `deleted`.
#[tokio::test]
async fn ids_a_tool_id_field_named_id_names_changes_made_in_the_file() {
    let Some(f) = Fixture::new("plidf", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside(&with_opacity(&f.read(), 5, 30));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [opacity(3, 40.0)] })).await;
    assert_eq!(ids(&ran["others"]["changed"]), [json!(5)], "{ran}");
    assert_eq!(ran["others"]["changed"][0]["edits"], json!([{ "field": "opacity", "before": 100, "after": 30 }]), "{ran}");
    assert!(ran["others"].get("unnamed").is_none(), "{ran}");
    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.write_outside(&with_opacity(&f.read(), 3, 70));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [opacity(3, 50.0)] })).await;
    assert_eq!(conflict_on(&refused, 3)["reason"], "changed", "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    let basis = f.revision(ME).await;
    f.write_outside("V1:1=0+1|2=1+1|4=3+1|5=4+1@30\nV2:1000=0+5");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [opacity(3, 50.0)] })).await;
    assert_eq!(conflict_on(&refused, 3)["reason"], "deleted", "{refused}");
    f.shutdown().await;
}

// ---- 5. A part's own changes  ----

fn set_label(value: &str) -> Value {
    json!({ "command": "track.set", "params": { "key": "label", "value": value }, "at": { "part": { "track": "V1" } } })
}

/// A step that names no object (no `on`, no target, no object in its parameters, no place) acts on
/// its part: `track.set` on V1 after a colleague set V1's own label (in the file, or another
/// agent) is refused as `changed` on `V1`, nothing written. Changes inside the part that are not
/// its own (a clip's opacity, a ripple insert on it, its clips list) and another track's label do
/// not refuse it.
#[tokio::test]
async fn parts_a_write_to_the_part_itself_is_refused_when_others_changed_it() {
    let Some(f) = Fixture::new("plpart", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside(&f.read().replacen("V1:", "V1[label=\"Theirs\"]:", 1));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [set_label("Mine")] })).await;
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    let conflict = refused["conflicts"].as_array().and_then(|all| all.iter().find(|c| c["id"] == "V1")).cloned().unwrap_or_else(|| panic!("{refused}"));
    assert_eq!(conflict["reason"], "changed", "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [set_label("Other")] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [set_label("Mine")] })).await;
    assert_eq!(refused["error"]["code"], "conflict", "between agents: {refused}");
    // Not the part's own: a clip's opacity, a ripple insert on it, another track's label.
    let basis = f.revision(ME).await;
    f.write_outside(&with_opacity(&f.read(), 2, 30));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [set_label("A")] })).await;
    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "timeline.insert", "params": { "track": "V1", "at": 0, "duration": 1 } }] })).await;
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [set_label("B")] })).await;
    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "track.set", "params": { "key": "label", "value": "V2's" }, "at": { "part": { "track": "V2" } } }] }))
        .await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": [set_label("C")] })).await;
    assert!(f.read().starts_with("V1[label=\"C\"]:"), "{}", f.read());
    f.shutdown().await;
}

// ---- 6. Index spellings are places  ----

fn trim(clip: Value) -> Value {
    json!({ "command": "clip.trim", "params": { "clip": clip, "duration": 0.5 }, "at": { "part": { "track": "V1" } } })
}

/// `clip.trim` takes `"#3"`, the third clip of the current track (declared `x-khp-index: "#"`).
/// After a ripple insert at 0 s on V1 (in the file, or by another agent) `"#3"` names clip 2: the
/// write is refused as `relocated`, the conflict naming clip 3 (what `#3` named at `basis`) with
/// where it is now, and nothing is written. With no change it applies to clip 3. `on: ["#3"]` is
/// `invalid-params`: `on` takes ids.
#[tokio::test]
async fn index_a_write_by_index_after_an_insert_is_refused_as_relocated() {
    let Some(f) = Fixture::new("plidx", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside(&ripple_inserted(5, 9));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [trim(json!("#3"))] })).await;
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    let was = conflict_on(&refused, 3);
    assert_eq!((was["reason"].clone(), was["now"]["parent"].clone(), was["now"]["index"].clone()), (json!("relocated"), json!("V1"), json!(3)), "{refused}");
    assert_eq!(was["place"]["clip"], json!("#3"), "{refused}");
    assert_eq!(was["place"]["under"], json!([2]), "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "timeline.insert", "params": { "track": "V1", "at": 0, "duration": 1 } }] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [trim(json!("#3"))] })).await;
    assert_eq!(conflict_on(&refused, 2)["reason"], "relocated", "between agents: {refused}");
    let basis = f.revision(ME).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": [trim(json!("#3"))] })).await;
    let refused = f
        .refused(ME, "run", json!({ "steps": [{ "command": "clip.trim", "on": ["#3"], "params": { "duration": 0.5 }, "at": { "part": { "track": "V1" } } }] }))
        .await;
    assert_eq!(refused["error"]["code"], "invalid-params", "{refused}");
    assert!(refused["error"]["message"].as_str().is_some_and(|message| message.contains("`#3`")), "{refused}");
    f.shutdown().await;
}

// ---- 7. A map's change is told at its key  ----

/// A colleague changes one setting of V1 (its `attrs` map): `others` tells the key alone
/// (`attrs.label`, before and after), not the whole map. A batch setting another key of that map
/// applies; one setting the same key with the `basis` from before is refused as `changed`.
#[tokio::test]
async fn maps_a_change_of_one_key_is_told_at_the_key_and_conflicts_only_with_it() {
    let Some(f) = Fixture::new("plmap", &format!("V1[label=\"a\";mark=1]:{}", &timeline(3)[3..])) else { return };
    let basis = f.revision(ME).await;
    f.write_outside(&f.read().replace("label=\"a\"", "label=\"b\""));
    let set = |key: &str, value: Value| json!({ "op": "map.set", "target": "V1", "field": "attrs", "key": key, "value": value });
    let ran = f.ok(ME, "batch", json!({ "basis": basis, "ops": [set("mark", json!(2))] })).await;
    let theirs = &ran["others"]["changed"][0];
    assert_eq!((theirs["id"].clone(), theirs["fields"].clone()), (json!("V1"), json!(["attrs.label"])), "{ran}");
    assert_eq!(theirs["edits"], json!([{ "field": "attrs.label", "before": "a", "after": "b" }]), "{ran}");
    assert_eq!(ran["changes"]["changed"][0]["edits"], json!([{ "field": "attrs.mark", "before": 1, "after": 2 }]), "{ran}");
    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.ok(OTHER, "batch", json!({ "ops": [set("label", json!("c"))] })).await;
    let before = f.read();
    let refused = f.refused(ME, "batch", json!({ "basis": basis, "ops": [set("label", json!("mine"))] })).await;
    assert_eq!(refused["conflicts"], json!([{ "id": "V1", "reason": "changed" }]), "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    f.ok(ME, "batch", json!({ "basis": basis, "ops": [set("mark", json!(3))] })).await;
    f.shutdown().await;
}

// ---- 8. Paths in the kit's words  ----

/// A clip's effects are objects without tool ids whose type declares `pathName: "name"`: a change
/// of one, in the file or by the agent, names it as the kit does (`named: "blur.amount"`) beside
/// its place in the model (`field: "effects.0.amount"`).
#[tokio::test]
async fn paths_a_change_inside_a_clip_is_named_in_the_kits_words() {
    let Some(f) = Fixture::new("plpath", "V1:1=0+1{blur:5,glow:2}|2=1+1\nV2:1000=0+2") else { return };
    let basis = f.revision(ME).await;
    f.write_outside(&f.read().replace("blur:5", "blur:8"));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [opacity(2, 40.0)] })).await;
    assert_eq!(ran["others"]["changed"][0]["edits"], json!([{ "field": "effects.0.amount", "named": "blur.amount", "before": 5, "after": 8 }]), "{ran}");
    let ran = f.ok(ME, "run", json!({ "steps": [{ "command": "clip.effect", "on": [1], "params": { "name": "glow", "amount": 3 } }] })).await;
    assert_eq!(ran["changes"]["changed"][0]["edits"], json!([{ "field": "effects.1.amount", "named": "glow.amount", "before": 2, "after": 3 }]), "{ran}");
    f.shutdown().await;
}

// ---- 9. Parameters are checked before the guard ----

/// A parameter the command does not take, whose value names a clip others changed: refused as
/// `invalid-params` (the kit's words), not as `conflict`.
#[tokio::test]
async fn invalid_params_come_before_the_guard() {
    let Some(f) = Fixture::new("plinv", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [opacity(3, 30.0)] })).await;
    let refused =
        f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "clip.opacity", "on": [4], "params": { "opacity": 1, "near": "3" } }] })).await;
    assert_eq!(refused["error"]["code"], "invalid-params", "{refused}");
    assert!(refused["error"]["message"].as_str().is_some_and(|message| message.contains("`near`")), "{refused}");
    f.shutdown().await;
}

/// A parameter of the wrong type (a duration given as text) on a clip others changed is
/// `invalid-params`, not `conflict`: the kit would refuse it as it runs.
#[tokio::test]
async fn invalid_types_come_before_the_guard() {
    let Some(f) = Fixture::new("pltype", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [opacity(3, 30.0)] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "clip.trim", "on": [3], "params": { "duration": "long" } }] })).await;
    assert_eq!(refused["error"]["code"], "invalid-params", "{refused}");
    assert!(refused["error"]["message"].as_str().is_some_and(|message| message.contains("`duration`") && message.contains("a number")), "{refused}");
    f.shutdown().await;
}

// ---- 10. The premises of a call  ----

/// A colleague changes the clip under 2.5 s without moving it (its opacity): the objects a place
/// names carry the same content premises as if named by id, so a cut there (for which the kit
/// states no fields) is refused as `changed` on clip 3, with the place, and nothing is written.
/// Selecting it and disabling the selection applies: the kit says selecting reads no content of
/// the clip, and `clip.disable` names its clips by the selection.
#[tokio::test]
async fn premises_a_cut_after_the_clip_under_it_changed_is_refused_as_changed() {
    let Some(f) = Fixture::new("prcut", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside(&with_opacity(&f.read(), 3, 70));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": razor_at(2.5) })).await;
    let conflict = conflict_on(&refused, 3);
    assert_eq!((conflict["reason"].clone(), conflict["place"]["under"].clone()), (json!("changed"), json!([3])), "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    f.ok(ME, "run", json!({ "basis": basis, "steps": disable_at(2.5) })).await;
    assert!(f.read().contains("3=2+1@70!"), "{}", f.read());
    f.shutdown().await;
}

/// The colleague trims the clip under 2.5 s at its end (3 lasts 0.8 s, still under 2.5 s, its
/// start the same): the cut applies, the kit saying a cut depends on where the clip under it
/// starts, not on its length. A trim of its start (it starts at 2.2 s) refuses it as
/// `relocated`.
#[tokio::test]
async fn premises_a_cut_after_a_trim_that_keeps_the_clip_under_it_applies() {
    let Some(f) = Fixture::new("prtrim", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside("V1:1=0+1|2=1+1|3=2+0.8|4=3+1|5=4+1\nV2:1000=0+5");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": razor_at(2.5) })).await;
    assert_eq!(ran["completed"][0]["result"]["pieces"][0]["left"], json!(3), "{ran}");
    f.shutdown().await;
    let Some(f) = Fixture::new("prtrim2", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside("V1:1=0+1|2=1+1|3=2.2+0.8|4=3+1|5=4+1\nV2:1000=0+5");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": razor_at(2.5) })).await;
    assert_eq!(conflict_on(&refused, 3)["reason"], "relocated", "{refused}");
    f.shutdown().await;
}

/// Changes next to the place, not under it: a ripple insert at the end of the clip under 2.5 s,
/// the clip after it deleted (a gap left), the clip before it trimmed. What a place names at
/// `basis` is replayed exactly from the clips' times in the change sets: the cut at 2.5 s applies
/// after each, in the file and between agents (it used to be refused for a change next to the
/// window).
#[tokio::test]
async fn exact_a_change_next_to_the_place_applies() {
    for (n, changed) in
        ["V1:1=0+1|2=1+1|3=2+1|9=3+1|4=4+1|5=5+1\nV2:1000=0+5", "V1:1=0+1|2=1+1|3=2+1|5=4+1\nV2:1000=0+5", "V1:1=0+1|2=1+0.5|3=2+1|4=3+1|5=4+1\nV2:1000=0+5"]
            .iter()
            .enumerate()
    {
        let Some(f) = Fixture::new(&format!("prnext{n}"), &timeline(5)) else { return };
        let basis = f.revision(ME).await;
        f.write_outside(changed);
        let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": razor_at(2.5) })).await;
        assert_eq!(ran["completed"][0]["result"]["pieces"][0]["left"], json!(3), "{n}: {ran}");
        // The times the guard replays stay in the journal: `others` does not show them.
        assert!(ran["others"]["deleted"].as_array().into_iter().flatten().all(|deleted| deleted.get("$was").is_none()), "{ran}");
        f.shutdown().await;
    }
    let Some(f) = Fixture::new("prnexta", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "timeline.insert", "params": { "track": "V1", "at": 3, "duration": 1 } }] })).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "edit.rippleDelete", "params": { "clips": [5] } }] })).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": razor_at(2.5) })).await;
    f.shutdown().await;
}

/// A write by id and the premises the kit states for it: `clip.effect` on clip 1's glow applies
/// after a colleague changed clip 1's blur, and after a ripple insert before clip 1 (the kit says
/// it reads that effect alone, wherever the clip is); after a change of its glow it is refused as
/// `changed`.
#[tokio::test]
async fn premises_a_write_by_id_needs_only_what_the_kit_says() {
    let Some(f) = Fixture::new("prid", "V1:1=0+1{blur:5,glow:2}|2=1+1\nV2:1000=0+2") else { return };
    let glow = |amount: f64| json!([{ "command": "clip.effect", "on": [1], "params": { "name": "glow", "amount": amount } }]);
    let basis = f.revision(ME).await;
    f.write_outside(&f.read().replace("blur:5", "blur:8"));
    f.ok(ME, "run", json!({ "basis": basis, "steps": glow(3.0) })).await;
    let basis = f.revision(ME).await;
    f.write_outside("V1:9=0+1|1=1+1{blur:8,glow:3}|2=2+1\nV2:1000=0+2");
    f.ok(ME, "run", json!({ "basis": basis, "steps": glow(4.0) })).await;
    let basis = f.revision(ME).await;
    f.write_outside(&f.read().replace("glow:4", "glow:9"));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": glow(5.0) })).await;
    assert_eq!(conflict_on(&refused, 1)["reason"], "changed", "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    f.shutdown().await;
}

/// A clip another parameter names: by its integer id (`from: 5`), a premise as a string id is; by
/// its place on the track in the index spelling (`from: "#2"`), a place. `clip.copyOpacity` from
/// clip 5 after a colleague changed 5's opacity is refused as `changed` on 5; after another clip's
/// change it applies; from `"#2"` after a ripple insert at 0 s (`"#2"` names clip 1 now) it is
/// refused as `relocated`.
#[tokio::test]
async fn mentions_an_integer_id_or_an_index_in_another_parameter_is_a_premise() {
    let Some(f) = Fixture::new("prmen", &timeline(5)) else { return };
    let copy = |from: Value| json!([{ "command": "clip.copyOpacity", "params": { "clip": 1, "from": from }, "at": { "part": { "track": "V1" } } }]);
    let basis = f.revision(ME).await;
    f.write_outside(&with_opacity(&f.read(), 5, 30));
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": copy(json!(5)) })).await;
    assert_eq!(conflict_on(&refused, 5)["reason"], "changed", "{refused}");
    let basis = f.revision(ME).await;
    f.write_outside(&with_opacity(&f.read(), 4, 40));
    f.ok(ME, "run", json!({ "basis": basis, "steps": copy(json!(5)) })).await;
    let basis = f.revision(ME).await;
    f.write_outside(&ripple_inserted(5, 9).replace("1=1+1", "1=1+1@30").replace("5=5+1", "5=5+1@30").replace("4=4+1", "4=4+1@40"));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": copy(json!("#2")) })).await;
    let relocated: Vec<&Value> = refused["conflicts"].as_array().into_iter().flatten().filter(|conflict| conflict["reason"] == "relocated").collect();
    assert!(relocated.iter().any(|conflict| conflict["place"]["from"] == "#2"), "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    f.shutdown().await;
}

/// A step that gives its target (`clip.paste`'s `clip`, the clip read) and a place (`track`,
/// `at`: the clips written): the place is a premise too. After a ripple insert at 0 s the clip
/// under 2.5 s is another: refused as `relocated`, nothing written.
#[tokio::test]
async fn places_a_step_by_id_with_a_place_is_checked_at_the_place() {
    let Some(f) = Fixture::new("prpaste", &timeline(5)) else { return };
    let paste = json!([{ "command": "clip.paste", "params": { "clip": 5, "track": "V1", "at": 2.5 } }]);
    let basis = f.revision(ME).await;
    f.write_outside(&ripple_inserted(5, 9));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": paste })).await;
    assert_eq!(conflict_on(&refused, 2)["reason"], "relocated", "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    let basis = f.revision(ME).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": paste })).await;
    f.shutdown().await;
}

/// A step with no time of its own (`timeline.razor` with no `at.time`) after a step that moved the
/// playhead (`playhead.set`): the time it reads is not known before the run, so after a
/// colleague's change it is refused as `relocated`, the place saying why; with no change by others
/// it applies.
#[tokio::test]
async fn time_a_step_reading_a_time_an_earlier_step_set_is_refused_after_a_change() {
    let Some(f) = Fixture::new("prtime", &timeline(5)) else { return };
    let steps = json!([{ "command": "playhead.set", "params": { "time": 2.5 } }, { "command": "timeline.razor", "params": { "track": "V1" } }]);
    let bare = json!([{ "command": "playhead.set", "params": { "time": 2.5 } }, { "command": "timeline.razor" }]);
    let basis = f.revision(ME).await;
    f.write_outside(&ripple_inserted(5, 9));
    let before = f.read();
    for steps in [&steps, &bare] {
        let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": steps })).await;
        assert_eq!(refused["error"]["code"], "conflict", "{refused}");
        assert_eq!(f.read(), before, "nothing written");
    }
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": bare })).await;
    assert_eq!(refused["conflicts"][0]["reason"], "relocated", "{refused}");
    let basis = f.revision(ME).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": bare })).await;
    f.shutdown().await;
}

/// `clip.trim` reads a number that is no clip's id as the n-th clip of the track
/// (`x-khp-index-numbers`): on clips 10, 11, 12, `clip: 2` is clip 11. After a ripple insert at 0
/// s, `2` names clip 10: refused as `relocated` naming clip 11, nothing written. `clip: 11` is an
/// id and applies.
#[tokio::test]
async fn index_a_number_that_names_no_clip_is_a_place() {
    let Some(f) = Fixture::new("prnum", "V1:10=0+1|11=1+1|12=2+1\nV2:1000=0+3") else { return };
    let basis = f.revision(ME).await;
    f.write_outside("V1:13=0+1|10=1+1|11=2+1|12=3+1\nV2:1000=0+3");
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [trim(json!(2))] })).await;
    assert_eq!(conflict_on(&refused, 11)["reason"], "relocated", "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    let basis = f.revision(ME).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": [trim(json!(12))] })).await;
    assert!(f.read().contains("12=3+0.5"), "{}", f.read());
    f.shutdown().await;
}

/// The clip `"#3"` names is a target, not only an identity: after a colleague changed clip 3's
/// opacity, `clip.trim` on `"#3"` (every field its premise) is refused as `changed` on clip 3.
#[tokio::test]
async fn index_a_write_by_index_after_its_clip_changed_is_refused_as_changed() {
    let Some(f) = Fixture::new("prixc", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside(&with_opacity(&f.read(), 3, 30));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [trim(json!("#3"))] })).await;
    assert_eq!(conflict_on(&refused, 3)["reason"], "changed", "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    f.shutdown().await;
}

// ---- 11. Receipts say derived shifts once  ----

/// A colleague raises every effect of clip 1 by one (five edits of one leaf, `effects.N.amount`,
/// by one amount): `others` tells one edit, `effects.*.amount`, with the count and the amount.
#[tokio::test]
async fn receipts_many_edits_of_one_leaf_by_one_amount_are_one() {
    let Some(f) = Fixture::new("rcleaf", "V1:1=0+1{a:1,b:2,c:3,d:4,e:5}|2=1+1\nV2:1000=0+2") else { return };
    let basis = f.revision(ME).await;
    f.write_outside("V1:1=0+1{a:2,b:3,c:4,d:5,e:6}|2=1+1\nV2:1000=0+2");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [opacity(2, 40.0)] })).await;
    let theirs = &ran["others"]["changed"][0];
    assert_eq!(theirs["edits"], json!([{ "field": "effects.*.amount", "count": 5, "shift": { "by": 1 } }]), "{ran}");
    assert_eq!(theirs["fields"], json!(["effects.*.amount"]), "{ran}");
    f.shutdown().await;
}

/// The first clip of eight deleted in the file, a gap left: the seven others' indexes shift by one,
/// stated once in `footprint`.
#[tokio::test]
async fn receipts_an_index_shift_is_stated_once() {
    let Some(f) = Fixture::new("rcidx", &timeline(8)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside("V1:2=1+1|3=2+1|4=3+1|5=4+1|6=5+1|7=6+1|8=7+1\nV2:1000=0+8");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [opacity(5, 40.0)] })).await;
    assert_eq!(ran["others"]["footprint"], json!([{ "parent": "V1", "field": "clips", "from": 0, "count": 7, "shift": { "index": -1 } }]), "{ran}");
    f.shutdown().await;
}

/// A clip a colleague created is told in `others` by id, type, `at`, its fields' names and its
/// naming and position values only (here `start`, `duration`); `changes: "all"` tells them all.
#[tokio::test]
async fn receipts_others_tell_a_created_object_by_its_names() {
    let Some(f) = Fixture::new("rccre", &timeline(3)) else { return };
    let basis = f.revision(ME).await;
    f.write_outside("V1:1=0+1|2=1+1|3=2+1|9=3+1@20\nV2:1000=0+3");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [opacity(2, 40.0)] })).await;
    assert_eq!(ran["others"]["created"][0]["values"], json!({ "duration": 1, "start": 3 }), "{ran}");
    let basis = f.revision(ME).await;
    f.write_outside("V1:1=0+1|2=1+1@40|3=2+1|9=3+1@20|10=4+1@30\nV2:1000=0+3");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "changes": "all", "steps": [opacity(2, 50.0)] })).await;
    assert_eq!(ran["others"]["created"][0]["values"]["opacity"], json!(30), "{ran}");
    f.shutdown().await;
}

/// a step that names its source by id (`clip.stamp`'s `clip`) and acts at its
/// time (`at.time`, the command reads it) has the place as a premise too. A colleague puts a clip under
/// 2.5 s on V1 (a ripple insert at 2.5 s): the agent's stamp at 2.5 s with `basis` is refused as
/// `relocated` naming the new clip (before: applied over it), nothing written. After a change elsewhere (clip 8's opacity)
/// it applies.
#[tokio::test]
async fn places_a_step_by_id_at_a_time_is_checked_at_the_time() {
    let Some(f) = Fixture::new("prstamp", &timeline(8)) else { return };
    let stamp = json!([{ "command": "clip.stamp", "params": { "clip": 1 }, "at": { "time": 2.5 } }]);
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "timeline.insert", "params": { "track": "V1", "at": 2.5, "duration": 1 } }] })).await;
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": stamp })).await;
    let theirs = f.read().split(['|', '\n']).find_map(|clip| clip.strip_suffix("=2.5+1")?.parse::<u64>().ok()).unwrap_or_else(|| panic!("{}", f.read()));
    assert_eq!(conflict_on(&refused, theirs)["reason"], "relocated", "{refused}");
    assert!(conflict_on(&refused, theirs)["place"]["time"] == json!(2.5), "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [opacity(8, 40.0)] })).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": stamp })).await;
    f.shutdown().await;
}

// ---- held objects at their paths, selectors on list items ----

/// One clip, and the reel `R1` holding (through `body`, a ref it owns) shots 501 and 502, keys at
/// 1, 2 and 3 s, and markers 7 (at 1 s) and 8 (at 2 s) in a json list.
const REEL: &str = "V1:1=0+1\nV2:1000=0+1\n@R1|501=10,502=20|1=10,2=20,3=30|[{\"id\":7,\"name\":\"a\",\"time\":1},{\"id\":8,\"name\":\"b\",\"time\":2}]";

#[tokio::test]
async fn raw_key_references_keep_their_identity_across_saved_rereads() {
    for change in ["same", "insert-before", "value", "delete"] {
        let f = Fixture::new("rawkeyref", REEL).expect("build mock");
        let reel = f.ok(ME, "batch", json!({"load":[{"target":"reel:R1","fields":["body"]}]})).await;
        let lane = reel["loaded"][0]["fields"]["body"].as_str().unwrap();
        let loaded = f.ok(ME, "batch", json!({"load":[{"target":lane,"fields":["keys"]}]})).await;
        let key = loaded["loaded"][0]["fields"]["keys"][1].as_str().unwrap();
        let basis = loaded["revision"].clone();
        let changed = match change {
            "insert-before" => with_key(REEL, "0", "5"),
            "value" => with_key(REEL, "2", "50"),
            "delete" => REEL.replace("1=10,2=20,3=30", "1=10,3=30"),
            _ => REEL.to_owned(),
        };
        f.write_outside(&changed);
        let before = f.read();
        let result = f.call(ME, "batch", json!({"basis":basis,"ops":[{"op":"set","target":key,"field":"value","value":99}]})).await;
        match change {
            "value" | "delete" => {
                let error = result.expect_err("stale key premise must refuse");
                assert_eq!(error["error"]["code"], json!("conflict"), "{change}: {error}");
                assert_eq!(error["conflicts"][0]["reason"], json!(if change == "delete" { "deleted" } else { "changed" }), "{error}");
                assert_eq!(f.read(), before);
            }
            _ => {
                result.unwrap_or_else(|error| panic!("{change}: {error}"));
                assert!(f.read().contains("2=99"), "{}", f.read());
            }
        }
        f.shutdown().await;
    }
}

fn reel_marker(id: u64, name: &str, by_key: bool) -> Value {
    json!({ "command": "reel.marker", "params": { "reel": "reel:R1", "id": id, "name": name, "byKey": by_key } })
}

fn reel_key(time: f64, value: f64, by_index: bool) -> Value {
    json!({ "command": "reel.key", "params": { "reel": "reel:R1", "time": time, "value": value, "byIndex": by_index } })
}

#[tokio::test]
async fn deleting_a_reel_names_its_owned_shots_in_the_receipt() {
    let Some(f) = Fixture::new("delowned", REEL) else { return };
    let answer = f.ok(ME, "batch", json!({ "ops": [{ "op": "delete", "target": "reel:R1" }], "changes": "all" })).await;
    let deleted: Vec<_> = answer["changes"]["deleted"].as_array().unwrap().iter().map(|item| item["id"].clone()).collect();
    assert!(deleted.contains(&json!(501)) && deleted.contains(&json!(502)) && deleted.contains(&json!("reel:R1")), "{answer}");
    f.shutdown().await;
}

/// a shot (tool id) the reel holds through its owned `body` is held at its path
/// (`body.shots.0`), not at `body`: a premise on a marker (`body.markers.0`) survives a change of
/// the shot and is refused after a change of that marker. Before, every object held through the
/// ref read as held at `body` and overlapped every path under it.
#[tokio::test]
async fn held_a_marker_premise_survives_a_change_of_a_held_object() {
    let Some(f) = Fixture::new("hldmark", REEL) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "reel.shot", "params": { "shot": 501, "amount": 11 } }] })).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": [reel_marker(7, "mine", false)] })).await;
    assert!(f.read().contains("\"name\":\"mine\""), "{}", f.read());
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [reel_marker(7, "theirs", false)] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [reel_marker(7, "again", false)] })).await;
    assert_eq!(refused["conflicts"][0]["id"], "reel:R1", "{refused}");
    assert_eq!(refused["conflicts"][0]["reason"], "changed", "{refused}");
    f.shutdown().await;
}

/// The reel's file with the key at `time` set to `value` (added in time order when absent).
fn with_key(text: &str, time: &str, value: &str) -> String {
    text.lines()
        .map(|line| {
            let Some(rest) = line.strip_prefix("@R1|") else { return line.to_owned() };
            let parts: Vec<&str> = rest.splitn(3, '|').collect();
            let mut keys: Vec<(f64, String)> =
                parts[1].split(',').filter_map(|key| key.split_once('=')).map(|(at, v)| (at.parse().unwrap_or(0.0), format!("{at}={v}"))).collect();
            let wanted: f64 = time.parse().unwrap_or(0.0);
            match keys.iter_mut().find(|(at, _)| *at == wanted) {
                Some(key) => key.1 = format!("{time}={value}"),
                None => keys.push((wanted, format!("{time}={value}"))),
            }
            keys.sort_by(|a, b| a.0.total_cmp(&b.0));
            format!("@R1|{}|{}|{}", parts[0], keys.into_iter().map(|(_, key)| key).collect::<Vec<_>>().join(","), parts[2])
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// a premise naming a list item by a selector on one of its members
/// (`body.keys[time=2]`) is touched when an item matching it was changed or removed, or an item
/// now matching it did not match before, through every save since `basis`; index shifts of other
/// items do not touch it. The agent sets the key at 2 s (20 when it looked) with `basis`, by a
/// colleague's agent and by another program writing the file:
/// - its value set to 25, then (a second save) a key added at 1.5 s: refused as `changed`
///   (its premise by index now, `transform/opacity.keys.2`, missed
///   the first save's edit at `keys.1` and applied over the colleague's 25);
/// - its value set to 25: refused;
/// - a key added at 1.5 s or at 3.5 s: applied; the held key is unchanged.
#[tokio::test]
async fn selector_a_key_premise_follows_the_key_by_its_time_across_saves() {
    for outside in [false, true] {
        for change in ["its value, then a key before", "its value", "a key before", "a key after"] {
            let name = format!("sel{}{}", u8::from(outside), change.len());
            let Some(f) = Fixture::new(&name, REEL) else { return };
            let basis = f.revision(ME).await;
            let save = |time: &str, value: &str| {
                let f = &f;
                let (time, value) = (time.to_owned(), value.to_owned());
                async move {
                    if outside {
                        f.write_outside(&with_key(&f.read(), &time, &value));
                        f.ok(OTHER, "inspect", json!({})).await;
                    } else {
                        f.ok(OTHER, "run", json!({ "steps": [reel_key(time.parse().unwrap_or(0.0), value.parse().unwrap_or(0.0), false)] })).await;
                    }
                }
            };
            match change {
                "its value, then a key before" => {
                    save("2", "25").await;
                    save("1.5", "15").await;
                }
                "its value" => save("2", "25").await,
                "a key before" => save("1.5", "15").await,
                _ => save("3.5", "35").await,
            }
            let answer = f.call(ME, "run", json!({ "basis": basis, "steps": [reel_key(2.0, 77.0, false)] })).await;
            let label = format!("{change} (outside: {outside})");
            if change.starts_with("its value") {
                let refused = answer.expect_err(&label);
                assert_eq!(refused["conflicts"][0]["reason"], "changed", "{label}: {refused}");
                assert!(f.read().contains("2=25"), "{label}: the colleague's value kept: {}", f.read());
            } else {
                answer.unwrap_or_else(|error| panic!("{label}: {error}"));
                assert!(f.read().contains("2=77"), "{label}: {}", f.read());
            }
            f.shutdown().await;
        }
    }
}

/// A key the agent adds at a time where it saw none: refused when a colleague added one there
/// since (an item now matching the selector did not before), applied when the colleague's key is
/// elsewhere.
#[tokio::test]
async fn selector_an_item_that_now_matches_touches_the_premise() {
    for (theirs, refused) in [(2.5, true), (3.5, false)] {
        let Some(f) = Fixture::new(&format!("selnew{}", theirs as u64), REEL) else { return };
        let basis = f.revision(ME).await;
        f.ok(OTHER, "run", json!({ "steps": [reel_key(theirs, 1.0, false)] })).await;
        let answer = f.call(ME, "run", json!({ "basis": basis, "steps": [reel_key(2.5, 77.0, false)] })).await;
        match refused {
            true => assert_eq!(answer.expect_err("theirs at 2.5")["conflicts"][0]["reason"], "changed"),
            false => {
                answer.unwrap_or_else(|error| panic!("theirs at {theirs}: {error}"));
            }
        }
        f.shutdown().await;
    }
}

/// A marker (an item of a json list) named by a selector on its id (`body.markers[id=7]`):
/// a marker added before it (the whole list told at once)
/// does not touch it; a rename of marker 7 does, also after the add moved it to index 1.
#[tokio::test]
async fn selector_a_json_list_item_by_its_id() {
    let Some(f) = Fixture::new("seljson", REEL) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "reel.markerAdd", "params": { "reel": "reel:R1", "id": 9, "name": "new", "time": 0.5 } }] })).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": [reel_marker(7, "mine", true)] })).await;
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [reel_marker(8, "theirs", false)] })).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": [reel_marker(7, "mine again", true)] })).await;
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "reel.markerAdd", "params": { "reel": "reel:R1", "id": 10, "name": "x", "time": 0.25 } }, reel_marker(7, "theirs", false)] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [reel_marker(7, "mine", true)] })).await;
    assert_eq!(refused["conflicts"][0]["reason"], "changed", "{refused}");
    f.shutdown().await;
}

/// `clip.trim` names clips (`x-khp-types: ["Clip"]`) and reads a number naming no
/// clip as the n-th clip of the track. On clips 10, 11, 12 and a reel holding shot 2, `clip: 2` is
/// clip 11 (the kit reads it so), not shot 2: a colleague's change of shot 2 does not refuse it,
/// and after a ripple insert at 0 s it is refused as `relocated` naming clip 11. Before, 2 named
/// the shot, an object of another type: refused as "2 changed", and applied to clip 10 after the
/// insert.
#[tokio::test]
async fn typed_a_number_naming_an_object_of_another_type_is_a_place() {
    let file = "V1:10=0+1|11=1+1|12=2+1\nV2:1000=0+3\n@R1|2=5||[]";
    let Some(f) = Fixture::new("typnum", file) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "reel.shot", "params": { "shot": 2, "amount": 6 } }] })).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": [trim(json!(2))] })).await;
    assert!(f.read().contains("11=1+0.5"), "{}", f.read());
    let basis = f.revision(ME).await;
    f.write_outside(&f.read().replace("V1:10=0+1|11=1+0.5|12=2+1", "V1:13=0+1|10=1+1|11=2+0.5|12=3+1"));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [trim(json!(2))] })).await;
    assert_eq!(conflict_on(&refused, 11)["reason"], "relocated", "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    f.shutdown().await;
}

/// a numeric string in an integer id parameter (`clip: "3"`, the form a kit's
/// receipts may print) is given to the command as the integer, as `on` is; before, a write with
/// `basis` after others' change was refused as `invalid-params` (an integer expected), and a kit
/// checking its own schema refused it too.
#[tokio::test]
async fn typed_a_numeric_string_for_an_integer_id_is_that_integer() {
    let Some(f) = Fixture::new("typstr", &timeline(5)) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [opacity(5, 30.0)] })).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": [{ "command": "clip.opacity", "params": { "clip": "3", "opacity": 40 } }] })).await;
    assert!(f.read().contains("3=2+1@40"), "{}", f.read());
    // Without `basis` too: the command gets the integer.
    f.ok(ME, "run", json!({ "steps": [{ "command": "clip.trim", "params": { "clip": "4", "duration": 0.5 } }] })).await;
    assert!(f.read().contains("4=3+0.5"), "{}", f.read());
    f.shutdown().await;
}
