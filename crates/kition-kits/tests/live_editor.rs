// Copied from kition-sdk crates/kition-kits/tests/live_editor.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The live-editor path (C3b): a document open in its editor is edited through the Kit AI bridge,
//! and the agent's tools answer as on the headless path.
//!
//! - Atomic runs (KHP A53): the editor undoes the steps before a failing one in the agent's undo
//!   scope and says so; the tool answers `index`, `rolledBack` and an empty `completed`, as
//!   headless, and `editedMeanwhile` when the person edited while the run was under way. The runs
//!   are shared with the editor's own tests (`fixtures/live-runs.json`, played by
//!   `packages/kit-editor/src/useKitSession.test.tsx`), so the two sides cannot drift apart.
//!
//! - Call context: an editor that lists the capability `context` runs each step in an editor
//!   state of the agent's own, so the server plans the run as on the headless path (`on` into
//!   the command's targets, else the selection; `at.part`, else the run's `target`; `at.time`) and
//!   hands each step its `context`; a plan the headless path refuses is refused the same way and
//!   reaches nothing (`fixtures/live-context.json`, which the editor's tests play too). An editor
//!   that does not list it keeps the typed refusal (`tests/call_context.rs`).
//!
//! - Receipts: an editor that lists the capability `changes` answers the bridge's `version` and
//!   `changes {since}` from its replica, so `<prefix>_run` and `<prefix>_batch` in it answer
//!   `changes` and `diagnostics {new, resolved}` exactly as headless (`fixtures/live-receipts.json`,
//!   whose change set the editor's worker tests compute); one that does not keeps
//!   `changesUnavailable` (`tests/receipts.rs`).
//!
//! - The revision chain and the premise guard: an editor that lists `changes` has a journal here
//!   (`<file>#editor`). Before every call the server reads the editor's replica version, and
//!   what changed since the version it saw last that the agents' own calls did not make is
//!   someone else's: a journal entry by `person` (the editor reported the change as the person's)
//!   or `other`, with its change set. `basis`, `others` and `conflict` then work as headless: the
//!   person's edit of another object is named in `others` and the write applies; the person's
//!   deletion or move of the write's target refuses it as `conflict` (`deleted`, `relocated`).
//!
//! - Preview by explicit view: the picture of a view comes from the kit's render command run in
//!   the editor with that view (in the agent's own editor state, when the editor lists `context`),
//!   checked against the render command's parameter schema as the editor lists it (`schema`), so a
//!   view member it does not take is `invalid-params` and nothing is drawn
//!   (`regressions/issue-live-render-view-schema`).
//!
//! The editor window here is scripted: it answers the bridge's requests as `@kition/kit-editor`
//! answers them, from the shared fixtures.
//!
//! Cases: `sdk.agent.live-editor/atomic-run`, `sdk.agent.live-editor/call-context`,
//! `sdk.agent.live-editor/receipts`, `sdk.agent.live-editor/premise-guard`,
//! `regressions/issue-live-render-view-schema`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use kition_kits::tools;
use kition_kits::{KitDefinition, KitManager};
use serde_json::{Value, json};

/// A kit `kit.<name>` editing `.<name>` files, with no headless kit: every call goes to the editor.
/// A name starting `lvrender` declares the render command `file.render` (`agent.render`).
fn kit(name: &str) -> &'static KitDefinition {
    let mut agent = json!({ "prefix": name, "tools": "document" });
    if name.starts_with("lvrender") {
        agent["render"] = json!("file.render");
    }
    if name == "lvterminal" {
        agent["drafts"] = json!(true);
    }
    let manifest = json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": format!("Kition {name}"), "version": "0.0.0",
        "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
        "agent": agent
    });
    KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"))
}

fn fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap_or_else(|err| panic!("{err}"))).unwrap_or_else(|err| panic!("{err}"))
}

/// How the scripted editor answers one `kit/call`: the tool and its arguments, to its answer.
type Answer = Box<dyn Fn(&str, &Value) -> Value + Send + Sync>;

#[tokio::test]
async fn raw_contract_types_are_loaded_together_without_field_contents() {
    let editor = Editor::open(
        "lvbatchtypes",
        &["model", "changes"],
        Box::new(|tool, arguments| match tool {
            "batch" => json!({"result":{"refs":{},"results":[],"loaded":arguments["load"].as_array().into_iter().flatten()
                .map(|load| json!({"id":load["target"],"type":"Shape","fields":{}})).collect::<Vec<_>>()}}),
            "version" => json!({"result":{"version":"v1"}}),
            "check" => json!({"result":{"diagnostics":[]}}),
            _ => json!({"result":{}}),
        }),
    );
    editor.kits.remember_described(
        editor.kit.id,
        &json!({"root":"Root","types":{
            "Root":{"fields":{}},"Shape":{"fields":{"name":{"kind":"string"}},"batchOps":{"set.name":{"direct":true}}}
        }}),
    );
    let ops: Vec<_> = (0..200).map(|index| json!({"op":"set","target":format!("shape:{index}"),"field":"name","value":"Uniform"})).collect();
    editor.call("batch", json!({"ops":ops,"save":false})).await.unwrap();
    let reads: Vec<_> = editor.got("batch").into_iter().filter(|args| args["load"].as_array().is_some_and(|load| !load.is_empty())).collect();
    assert_eq!(reads.len(), 1, "one type lookup serves the whole raw batch");
    assert_eq!(reads[0]["load"].as_array().unwrap().len(), 200);
    assert!(reads[0]["load"].as_array().unwrap().iter().all(|load| load["fields"] == json!([])), "contract checks need no field contents");
    editor.close().await;
}

#[tokio::test]
async fn unchanged_direct_batches_need_no_prefix_plan() {
    let editor = Editor::open(
        "lvdirectfresh",
        &["model", "changes"],
        Box::new(|tool, arguments| match tool {
            "version" => json!({"result":{"version":"v1"}}),
            "commands" => json!({"result":{"commands":[],"total":0}}),
            "premise" if arguments["method"] == "identity" => json!({"result":{"unproven":[]}}),
            "inspect" => json!({"result":{"document":{"summary":"two shapes"}}}),
            "batch" => json!({"result":{"refs":{},"results":[],"loaded":arguments["load"].as_array().into_iter().flatten()
            .map(|load| json!({"id":load["target"],"type":"Shape","fields":{"name":"Before"}})).collect::<Vec<_>>()}}),
            "check" => json!({"result":{"diagnostics":[]}}),
            _ => json!({"error":{"code":-32601,"message":"unsupported"}}),
        }),
    );
    editor.kits.remember_described(
        editor.kit.id,
        &json!({"root":"Root","types":{
            "Root":{"fields":{}},"Shape":{"fields":{"name":{"kind":"string"}},"batchOps":{"set.name":{"direct":true}}}
        }}),
    );
    let basis = editor.call("inspect", json!({})).await.unwrap()["revision"].clone();
    let ops: Vec<_> = (0..2).map(|index| json!({"op":"set","target":format!("shape:{index}"),"field":"name","value":"After"})).collect();
    editor.call("batch", json!({"basis":basis,"ops":ops,"save":false})).await.unwrap();
    assert!(editor.got("premise").iter().all(|ask| ask["method"] != "plan"));
    editor.close().await;
}

/// A renderer window with `path` open in the editor of `kit`, listing the editor's `capabilities`
/// (Kit UI protocol: `context`, `changes`): it records every `kit/call` it gets and answers it
/// with `answer` (`{result}` or `{error}`).
struct Editor {
    kits: KitManager,
    kit: &'static KitDefinition,
    path: String,
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    previews: Arc<AtomicUsize>,
    session: u64,
}

impl Editor {
    fn open(name: &str, capabilities: &[&str], answer: Answer) -> Self {
        let capabilities = json!(capabilities);
        let kit = kit(name);
        let kits = KitManager::new(Some(std::env::temp_dir()), vec![(kit, None)]);
        let path = format!("a.{name}");
        let calls: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let bridge = kits.bridge().clone();
        let (session, mut rx) = bridge.connect();
        let seen = Arc::clone(&calls);
        let previews = Arc::new(AtomicUsize::new(0));
        let preview_count = Arc::clone(&previews);
        let listed = path.clone();
        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                let Some(id) = message["id"].as_u64() else { continue };
                let params = &message["params"];
                let mut reply = match message["method"].as_str() {
                    Some("kit/documents") => {
                        json!({ "result": { "documents": [{ "path": listed, "kit": kit.id, "dirty": false, "revision": 1, "capabilities": capabilities }] } })
                    }
                    Some("kit/call") => {
                        let tool = params["tool"].as_str().unwrap_or_default().to_owned();
                        seen.lock().unwrap_or_else(|err| panic!("{err}")).push((tool.clone(), params["arguments"].clone()));
                        answer(&tool, &params["arguments"])
                    }
                    Some("kit/preview") => {
                        preview_count.fetch_add(1, Ordering::SeqCst);
                        json!({ "error": { "code": -32000, "message": "no preview" } })
                    }
                    _ => json!({ "error": { "code": -32000, "message": "unexpected call" } }),
                };
                reply["jsonrpc"] = json!("2.0");
                reply["id"] = json!(id);
                let _ = bridge.receive(session, &reply);
            }
        });
        Self { kits, kit, path, calls, previews, session }
    }

    /// The editor reports a change of the document (`kit.changed`), by `by`.
    fn changed_by(&self, by: &str, revision: u64) {
        let notice = json!({ "jsonrpc": "2.0", "method": "kit.changed", "params": { "path": self.path, "revision": revision, "by": by } });
        self.kits.bridge().receive(self.session, &notice).unwrap_or_else(|err| panic!("{err}"));
    }

    async fn call(&self, action: &str, mut input: Value) -> Result<Value, Value> {
        input["path"] = json!(self.path);
        let tool = format!("{}_{action}", self.kit.agent.prefix);
        match tools::call(&self.kits, &tool, &input).await {
            Some(Ok(output)) => Ok(output.output),
            Some(Err(error)) => Err(error.structured()),
            None => panic!("{tool} is not a kit tool"),
        }
    }

    async fn refused(&self, action: &str, input: Value) -> Value {
        match self.call(action, input).await {
            Err(error) => error,
            Ok(answer) => panic!("{action} was expected to fail: {answer}"),
        }
    }

    /// The `kit/call`s of `tool` the editor got, their arguments.
    fn got(&self, tool: &str) -> Vec<Value> {
        self.calls.lock().unwrap_or_else(|err| panic!("{err}")).iter().filter(|(called, _)| called == tool).map(|(_, arguments)| arguments.clone()).collect()
    }

    async fn close(self) {
        self.kits.shutdown().await;
    }
}

/// An answer that is the editor's error `{message, data}`.
fn failing(error: &Value) -> Value {
    json!({ "error": { "code": -32000, "message": error["message"], "data": error["data"] } })
}

// ---- Atomic runs ----

#[tokio::test]
async fn terminal_close_in_an_editor_or_draft_skips_all_post_close_reads() {
    for draft in [false, true] {
        let editor = Editor::open(
            "lvterminal",
            &[],
            Box::new(|tool, _| match tool {
                "run" => json!({"result":{"completed":[{"command":"file.close","result":{"closed":true}}],
                    "saved":true,"document":{"summary":"closed"}}}),
                _ => json!({"result":{}}),
            }),
        );
        let answer = editor.call("run", json!({"draft":draft,"steps":[{"command":"file.close","params":{"force":true}}]})).await.unwrap();
        assert_eq!(answer["closed"], true, "draft={draft}: {answer}");
        assert_eq!(answer["saved"], false, "draft={draft}: {answer}");
        assert_eq!(answer["live"], true, "draft={draft}: {answer}");
        assert!(answer.get("document").is_none(), "draft={draft}: {answer}");
        assert_eq!(editor.previews.load(Ordering::SeqCst), 0, "a closed engine cannot render a preview");
        let calls: Vec<_> = editor.calls.lock().unwrap().iter().map(|(tool, _)| tool.clone()).collect();
        let run = calls.iter().position(|tool| tool == "run").expect("run was sent");
        assert!(calls[run + 1..].is_empty(), "no model, version or receipt reads after close: {calls:?}");
        editor.close().await;
    }
}

#[tokio::test]
async fn atomic_a_failed_run_answers_what_the_editor_rolled_back_as_headless_does() {
    let runs = fixture("live-runs.json");
    for (at, run) in runs["runs"].as_array().into_iter().flatten().enumerate() {
        let name = run["name"].as_str().unwrap_or_default();
        let error = run["editor"].clone();
        let editor =
            Editor::open(&format!("lvatomic{at}"), &[], Box::new(move |tool, _| if tool == "run" { failing(&error) } else { json!({ "result": {} }) }));
        let refused = editor.refused("run", json!({ "steps": run["steps"], "save": false })).await;
        let expected = &run["tool"];
        assert_eq!(refused["error"]["code"], expected["code"], "{name}: {refused}");
        assert_eq!(refused["error"]["index"], expected["index"], "{name}: {refused}");
        let message = refused["error"]["message"].as_str().unwrap_or_default();
        assert!(message.contains(run["editor"]["message"].as_str().unwrap_or_default()), "{name}: the editor's account is passed on: {message}");
        let mut output = refused.clone();
        output.as_object_mut().map(|fields| fields.remove("error"));
        assert_eq!(output, expected["output"], "{name}");
        assert_eq!(editor.got("run"), [json!({ "steps": run["steps"], "save": false })], "{name}: the steps went to the editor as given");
        editor.close().await;
    }
}

#[tokio::test]
async fn atomic_an_editor_that_does_not_say_what_it_rolled_back_is_said_loudly() {
    // An editor before C3b answers a failing step with no `completed` or `rolledBack`.
    let editor = Editor::open(
        "lvolder",
        &[],
        Box::new(|tool, _| {
            if tool == "run" { json!({ "error": { "code": -32000, "message": "step 1 (`image.crop`) failed: broken" } }) } else { json!({ "result": {} }) }
        }),
    );
    let refused = editor.refused("run", json!({ "steps": [{ "command": "layer.new" }, { "command": "image.crop" }] })).await;
    assert_eq!(refused["error"]["code"], "command-failed", "{refused}");
    let message = refused["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("did not say whether the step(s) before it"), "{message}");
    assert!(refused.get("completed").is_none() && refused.get("rolledBack").is_none(), "nothing is claimed: {refused}");
    editor.close().await;
}

#[tokio::test]
async fn atomic_a_step_refused_for_another_session_s_lease_keeps_the_steps_before_it_and_says_so() {
    // The Kit UI protocol (section 7b): a lease refusal runs nothing, and the steps before it stay.
    let editor = Editor::open(
        "lvheld",
        &[],
        Box::new(|tool, _| {
            if tool == "run" {
                json!({ "error": { "code": -32000, "message": "step 1 (`image.crop`) is not allowed: Alice holds the lease on `*`", "data": { "reason": "held", "command": "image.crop", "step": 1, "scope": "*" } } })
            } else {
                json!({ "result": {} })
            }
        }),
    );
    let refused = editor.refused("run", json!({ "steps": [{ "command": "layer.new" }, { "command": "image.crop" }] })).await;
    assert_eq!(refused["error"]["index"], 1, "{refused}");
    let message = refused["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("Alice holds the lease") && message.contains("the 1 step(s) before it stay"), "{message}");
    editor.close().await;
}

// ---- Call context ----

/// An editor that lists `context` and the fixture's commands, and runs every run.
fn context_editor(name: &str, commands: Value) -> Editor {
    Editor::open(
        name,
        &["context"],
        Box::new(move |tool, arguments| match tool {
            "commands" => json!({ "result": { "commands": commands, "total": 3 } }),
            "run" => {
                let completed: Vec<Value> = arguments["steps"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|step| json!({ "command": step["command"], "changed": true, "result": null }))
                    .collect();
                json!({ "result": { "completed": completed, "saved": false, "document": { "summary": "2 slides" } } })
            }
            _ => json!({ "error": { "code": -32000, "message": "unexpected call" } }),
        }),
    )
}

#[tokio::test]
async fn context_each_step_reaches_the_editor_with_the_context_the_headless_path_would_set() {
    let fixture = fixture("live-context.json");
    for (at, run) in fixture["runs"].as_array().into_iter().flatten().enumerate() {
        let name = run["name"].as_str().unwrap_or_default();
        let editor = context_editor(&format!("lvctx{at}"), fixture["commands"].clone());
        let mut input = run["input"].clone();
        input["save"] = json!(false);
        let answer = editor.call("run", input).await.unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(answer["live"], true, "{name}: {answer}");
        assert_eq!(editor.got("run"), [json!({ "steps": run["editorSteps"], "save": false })], "{name}");
        editor.close().await;
    }
}

#[tokio::test]
async fn context_a_plan_the_headless_path_refuses_is_refused_the_same_way_and_reaches_nothing() {
    let fixture = fixture("live-context.json");
    for (at, case) in fixture["refused"].as_array().into_iter().flatten().enumerate() {
        let name = case["name"].as_str().unwrap_or_default();
        let editor = context_editor(&format!("lvctxno{at}"), fixture["commands"].clone());
        let refused = editor.refused("run", case["input"].clone()).await;
        assert_eq!(refused["error"]["code"], case["code"], "{name}: {refused}");
        assert_eq!(refused["error"]["index"], case["index"], "{name}: {refused}");
        let message = refused["error"]["message"].as_str().unwrap_or_default();
        assert!(message.contains(case["says"].as_str().unwrap_or_default()), "{name}: {message}");
        assert!(editor.got("run").is_empty(), "{name}: nothing reached the editor");
        editor.close().await;
    }
}

#[tokio::test]
async fn context_a_run_on_the_agent_s_draft_in_the_editor_still_refuses_a_context() {
    // The draft is a second engine in the editor; its runs take no call context yet.
    let editor = context_editor("lvctxdraft", json!([]));
    let refused = editor.refused("run", json!({ "target": { "slide": 1 }, "steps": [{ "command": "text.append" }], "draft": true })).await;
    assert_eq!(refused["error"]["code"], "unsupported", "{refused}");
    editor.close().await;
}

// ---- Receipts ----

/// An editor that lists `changes`: its replica is at `v<n>` after `n - 1` writes; `changes`
/// answers `found` (the fixture's change set, or no change set and why); `check` answers the
/// fixture's checks in turn.
fn receipts_editor(name: &str, found: Value) -> Editor {
    let receipts = fixture("live-receipts.json");
    let writes = Arc::new(AtomicUsize::new(1));
    let checks = Arc::new(AtomicUsize::new(0));
    Editor::open(
        name,
        &["changes"],
        Box::new(move |tool, arguments| match tool {
            "version" => json!({ "result": { "version": format!("v{}", writes.load(Ordering::SeqCst)) } }),
            "changes" => {
                let mut answer = found.clone();
                answer["version"] = json!(format!("v{}", writes.load(Ordering::SeqCst)));
                json!({ "result": answer })
            }
            "check" => {
                let at = checks.fetch_add(1, Ordering::SeqCst).min(1);
                json!({ "result": { "diagnostics": receipts["checks"][at] } })
            }
            "run" => {
                writes.fetch_add(1, Ordering::SeqCst);
                let completed: Vec<Value> = arguments["steps"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|step| json!({ "command": step["command"], "changed": true, "result": null }))
                    .collect();
                json!({ "result": { "completed": completed, "saved": false, "document": { "summary": "1 page" } } })
            }
            "batch" => {
                writes.fetch_add(1, Ordering::SeqCst);
                json!({ "result": { "refs": {}, "results": [null], "loaded": [], "saved": false } })
            }
            _ => json!({ "error": { "code": -32000, "message": "unexpected call" } }),
        }),
    )
}

/// The bridge tools the editor got, in order.
fn tools_called(editor: &Editor) -> Vec<String> {
    editor.calls.lock().unwrap_or_else(|err| panic!("{err}")).iter().map(|(tool, _)| tool.clone()).collect()
}

#[tokio::test]
async fn receipts_a_run_and_a_batch_in_the_editor_answer_what_they_changed_as_headless() {
    let receipts = fixture("live-receipts.json");
    for (at, (action, input)) in [
        ("run", json!({ "steps": [{ "command": "page.rename", "params": { "title": "Two" } }], "save": false })),
        ("batch", json!({ "ops": [{ "op": "set", "target": "page", "field": "title", "value": "Two" }], "save": false })),
    ]
    .into_iter()
    .enumerate()
    {
        let editor = receipts_editor(&format!("lvrc{at}"), json!({ "changes": receipts["changes"] }));
        let answer = editor.call(action, input).await.unwrap_or_else(|error| panic!("{action}: {error}"));
        assert_eq!(answer["changes"], receipts["changes"], "{action}: {answer}");
        assert!(answer.get("changesUnavailable").is_none(), "{action}: {answer}");
        assert_eq!(answer["diagnostics"], receipts["diagnostics"], "{action}: {answer}");
        let called = tools_called(&editor);
        let write = called.iter().position(|tool| tool == action).unwrap_or_else(|| panic!("{action} reached the editor"));
        assert_eq!(called[..write], ["version", "check"], "{action}: the version and the diagnostics before the write: {called:?}");
        assert_eq!(called[write + 1..], ["changes", "check"], "{action}: the change set and the diagnostics after it: {called:?}");
        assert_eq!(editor.got("changes"), [json!({ "since": "v1" })], "{action}: since the version before the write");
        editor.close().await;
    }
}

#[tokio::test]
async fn receipts_an_editor_that_cannot_say_answers_why_never_an_empty_change_set() {
    let editor = receipts_editor("lvrcno", json!({ "changes": null, "unavailable": "the version is not in this replica's history" }));
    let answer = editor.call("run", json!({ "steps": [{ "command": "page.rename" }], "save": false })).await.unwrap_or_else(|error| panic!("{error}"));
    assert!(answer["changes"].is_null(), "{answer}");
    assert!(answer["changesUnavailable"].as_str().is_some_and(|why| why.contains("replaced while the call ran")), "{answer}");
    editor.close().await;
}

#[tokio::test]
async fn receipts_a_call_that_asks_for_neither_reads_no_diagnostics_and_answers_no_change_set() {
    let receipts = fixture("live-receipts.json");
    let editor = receipts_editor("lvrcoff", json!({ "changes": receipts["changes"] }));
    let answer = editor
        .call("run", json!({ "steps": [{ "command": "page.rename" }], "save": false, "changes": false, "check": false }))
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(answer.get("changes").is_none() && answer.get("diagnostics").is_none(), "{answer}");
    assert!(!tools_called(&editor).contains(&"check".to_owned()), "no check was asked for");
    editor.close().await;
}

// ---- The revision chain and the premise guard ----

#[tokio::test]
async fn implicit_live_state_reads_refuse_unknown_without_a_state_history() {
    let editor = Editor::open(
        "lvstateunknown",
        &["changes", "context"],
        Box::new(|tool, _| match tool {
            "version" => json!({"result":{"version":"v1"}}),
            "inspect" => json!({"result":{"document":{"summary":"one shape"}}}),
            "commands" => {
                json!({"result":{"commands":[{"id":"shape.mode","title":"Mode-dependent edit","enabled":true,"mutates":true,"schema":{"type":"object","x-khp-reads":["mode"],"properties":{}}}],"total":1}})
            }
            "run" => json!({"result":{"completed":[{"command":"shape.mode"}],"document":{"summary":"changed"}}}),
            "check" => json!({"result":{"diagnostics":[]}}),
            _ => json!({"result":{}}),
        }),
    );
    let basis = editor.call("inspect", json!({})).await.unwrap()["revision"].clone();
    let refused = editor.refused("run", json!({"basis":basis,"steps":[{"command":"shape.mode"}],"save":false})).await;
    assert!(refused["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "unknown"), "{refused}");
    assert!(editor.got("run").is_empty());
    editor.close().await;
}

/// The document in a scripted editor with a replica: shapes `shape:1`, `shape:2`, `shape:3` in
/// the page's list, a version `v<n>` that moves with each change, and each change's change set.
#[derive(Default)]
struct Sim {
    shapes: Vec<String>,
    /// The change set of each change, the first moving `v1` to `v2`.
    log: Vec<Value>,
}

impl Sim {
    fn version(&self) -> String {
        format!("v{}", self.log.len() + 1)
    }

    /// The change sets since `since`, their lists joined.
    fn since(&self, since: &str) -> Value {
        let from = since.trim_start_matches('v').parse::<usize>().unwrap_or(1).saturating_sub(1);
        let mut joined = json!({ "created": [], "changed": [], "moved": [], "deleted": [] });
        for change in self.log.iter().skip(from) {
            for list in ["created", "changed", "moved", "deleted"] {
                if let (Some(into), Some(items)) = (joined[list].as_array_mut(), change[list].as_array()) {
                    into.extend(items.iter().cloned());
                }
            }
        }
        joined
    }

    fn change(&mut self, change: Value) {
        self.log.push(change);
    }
}

fn changed(id: &str, field: &str, before: &str, after: &str) -> Value {
    json!({ "created": [], "changed": [{ "id": id, "type": "Shape", "fields": [field], "edits": [{ "field": field, "before": before, "after": after }] }], "moved": [], "deleted": [] })
}

/// An editor that lists `changes` over `sim`: an agent's `shape.text` run is a change of its own.
fn journaled_editor(name: &str, sim: Arc<Mutex<Sim>>) -> Editor {
    sim.lock().unwrap_or_else(|err| panic!("{err}")).shapes = vec!["shape:1".into(), "shape:2".into(), "shape:3".into()];
    let commands = json!([{ "id": "shape.text", "title": "Set text", "description": null, "enabled": true, "mutates": true, "schema": { "type": "object", "properties": { "id": { "type": "string", "x-khp-role": "targets" }, "text": { "type": "string" } } } }]);
    Editor::open(
        name,
        &["changes", "premises"],
        Box::new(move |tool, arguments| {
            let mut sim = sim.lock().unwrap_or_else(|err| panic!("{err}"));
            match tool {
                "premise" if arguments["method"] == "under" => json!({"result":null}),
                "premise" if arguments["method"] == "identity" => json!({"result":{"unproven":[]}}),
                "version" => json!({ "result": { "version": sim.version() } }),
                "changes" => json!({ "result": { "changes": sim.since(arguments["since"].as_str().unwrap_or_default()), "version": sim.version() } }),
                "check" => json!({ "result": { "diagnostics": [] } }),
                "commands" => json!({ "result": { "commands": commands, "total": 1 } }),
                "inspect" => json!({ "result": { "document": { "summary": "3 shapes" } } }),
                "batch" => {
                    let loaded: Vec<Value> = arguments["load"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|load| json!({ "id": load["target"], "type": "Page", "fields": { "shapes": sim.shapes } }))
                        .collect();
                    json!({ "result": { "refs": {}, "results": [], "loaded": loaded, "saved": false } })
                }
                "run" => {
                    let mut completed = Vec::new();
                    for step in arguments["steps"].as_array().into_iter().flatten() {
                        let id = step["params"]["id"].as_str().unwrap_or_default();
                        let text = step["params"]["text"].as_str().unwrap_or_default();
                        sim.change(changed(id, "text", "", text));
                        completed.push(json!({ "command": step["command"], "changed": true, "result": null }));
                    }
                    json!({ "result": { "completed": completed, "saved": false, "document": { "summary": "3 shapes" } } })
                }
                _ => json!({ "error": { "code": -32000, "message": "unexpected call" } }),
            }
        }),
    )
}

fn set_text(id: &str, text: &str) -> Value {
    json!({ "command": "shape.text", "params": { "id": id, "text": text } })
}

#[tokio::test]
async fn editor_uses_the_kits_narrowed_call_premises() {
    let mut failures = Vec::new();
    for relevant in [false, true] {
        let sim = Arc::new(Mutex::new(Sim::default()));
        let state = Arc::clone(&sim);
        let editor = Editor::open(
            &format!("lvpremise{}", u8::from(relevant)),
            &["changes", "premises"],
            Box::new(move |tool, arguments| {
                let mut sim = state.lock().unwrap();
                match tool {
                    "version" => json!({"result":{"version":sim.version()}}),
                    "changes" => json!({"result":{"changes":sim.since(arguments["since"].as_str().unwrap()),"version":sim.version()}}),
                    "inspect" => json!({"result":{"document":{"summary":"One shape"}}}),
                    "check" => json!({"result":{"diagnostics":[]}}),
                    "commands" => json!({"result":{"commands":[{"id":"shape.text","title":"Set text","enabled":true,"mutates":true,
                        "schema":{"type":"object","properties":{"id":{"type":"string","x-khp-role":"targets"},"text":{"type":"string"}}}}],"total":1}}),
                    "premise" if arguments["method"] == "under" => {
                        json!({"result":{"objects":[],"premises":[{"id":"shape:1","fields":["sourceFact"],"positions":[]}]}})
                    }
                    "premise" if arguments["method"] == "inputs" => json!({"result":{"inputs":[]}}),
                    "premise" if arguments["method"] == "identity" => json!({"result":{"unproven":[]}}),
                    "batch" => json!({"result":{"refs":{},"results":[],"loaded":arguments["load"].as_array().into_iter().flatten()
                        .map(|load|json!({"id":load["target"],"type":"Shape","fields":{"text":"One","sourceFact":"stable"}})).collect::<Vec<_>>()}}),
                    "run" => {
                        sim.change(changed("shape:1", "text", "One", "Agent"));
                        json!({"result":{"completed":[{"command":"shape.text","changed":true}],"saved":false}})
                    }
                    _ => json!({"error":{"code":-32000,"message":"unexpected call"}}),
                }
            }),
        );
        editor.kits.remember_described(
            editor.kit.id,
            &json!({"root":"Page","types":{
                "Page":{"fields":{"shapes":{"kind":"list","of":"Shape"}}},
                "Shape":{"fields":{"text":{"kind":"text"},"sourceFact":{"kind":"string"}}}
            }}),
        );
        let basis = editor.call("inspect", json!({})).await.unwrap()["revision"].clone();
        sim.lock().unwrap().change(changed("shape:1", if relevant { "sourceFact" } else { "text" }, "stable", "Other"));
        editor.changed_by("person", 2);
        let result = editor.call("run", json!({"basis":basis,"steps":[set_text("shape:1","Agent")],"save":false})).await;
        match (relevant, &result) {
            (false, Ok(_)) => assert_eq!(editor.got("run").len(), 1),
            (true, Err(error)) if error["conflicts"].as_array().is_some_and(|items| items.iter().any(|item| item["reason"] == "changed")) => {
                assert!(editor.got("run").is_empty());
            }
            _ => failures.push(format!("relevant={relevant}: {result:?}")),
        }
        if editor.got("premise").is_empty() {
            failures.push(format!("relevant={relevant}: the guard never asked the editor's kit"));
        }
        editor.close().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn unavailable_editor_premises_refuse_before_the_write() {
    for answer in [json!({"error":{"code":-32601,"message":"unsupported"}}), json!({"result":{"unexpected":true}})] {
        let sim = Arc::new(Mutex::new(Sim::default()));
        let state = Arc::clone(&sim);
        let editor = Editor::open(
            "lvunavailablepremise",
            &["changes"],
            Box::new(move |tool, arguments| {
                let sim = state.lock().unwrap();
                match tool {
                    "version" => json!({"result":{"version":sim.version()}}),
                    "changes" => json!({"result":{"changes":sim.since(arguments["since"].as_str().unwrap()),"version":sim.version()}}),
                    "inspect" => json!({"result":{"document":{"summary":"One shape"}}}),
                    "commands" => json!({"result":{"commands":[{"id":"shape.text","title":"Set text","enabled":true,"mutates":true,
                    "schema":{"type":"object","properties":{"id":{"type":"string","x-khp-role":"targets"},"text":{"type":"string"}}}}],"total":1}}),
                    "premise" => answer.clone(),
                    "run" => panic!("an unavailable premise must refuse before run"),
                    _ => json!({"error":{"code":-32601,"message":"unsupported"}}),
                }
            }),
        );
        let basis = editor.call("inspect", json!({})).await.unwrap()["revision"].clone();
        sim.lock().unwrap().change(changed("shape:2", "text", "Two", "Other"));
        editor.changed_by("person", 2);
        let refused = editor.refused("run", json!({"basis":basis,"steps":[set_text("shape:1","Agent")],"save":false})).await;
        assert_eq!(refused["error"]["code"], "conflict", "{refused}");
        assert_eq!(refused["conflicts"][0]["reason"], "unknown", "{refused}");
        assert!(editor.got("run").is_empty());
        editor.close().await;
    }
}

#[tokio::test]
async fn editor_on_demand_facts_fail_closed_and_stored_facts_preserve_independence() {
    for on_demand in [false, true] {
        for relevant in [false, true] {
            let sim = Arc::new(Mutex::new(Sim::default()));
            let state = Arc::clone(&sim);
            let editor = Editor::open(
                &format!("lvfacts{}{}", u8::from(on_demand), u8::from(relevant)),
                &["changes", "premises"],
                Box::new(move |tool, arguments| {
                    let mut sim = state.lock().unwrap();
                    match tool {
                        "premise" if arguments["method"] == "under" => json!({"result":null}),
                        "premise" if arguments["method"] == "identity" => json!({"result":{"unproven":[]}}),
                        "version" => json!({"result":{"version":sim.version()}}),
                        "changes" => json!({"result":{"changes":sim.since(arguments["since"].as_str().unwrap()),"version":sim.version()}}),
                        "inspect" => json!({"result":{"document":{"summary":"Two shapes"}}}),
                        "check" => json!({"result":{"diagnostics":[]}}),
                        "commands" => json!({"result":{"commands":[{"id":"shape.text","title":"Set text","enabled":true,"mutates":true,
                            "schema":{"type":"object","properties":{"id":{"type":"string","x-khp-role":"targets"},"text":{"type":"string"}}}}],"total":1}}),
                        "batch" if arguments["objects"] == true => {
                            json!({"result":{"objects":[{"id":"shape:1","type":"Shape"},{"id":"shape:2","type":"Shape"}]}})
                        }
                        "batch" => json!({"result":{"refs":{},"results":[],"loaded":arguments["load"].as_array().into_iter().flatten()
                            .map(|load|json!({"id":load["target"],"type":"Shape","fields":{"text":"One","sourceFact":"stable"}})).collect::<Vec<_>>()}}),
                        "run" => {
                            sim.change(changed("shape:1", "text", "One", "Agent"));
                            json!({"result":{"completed":[{"command":"shape.text","changed":true}],"saved":false}})
                        }
                        _ => json!({"error":{"code":-32000,"message":"unexpected call"}}),
                    }
                }),
            );
            let mut described = json!({"root":"Page","types":{
                "Page":{"fields":{"shapes":{"kind":"list","of":"Shape"}}},
                "Shape":{"fields":{"text":{"kind":"text"},"sourceFact":{"kind":"string","readOnly":true,"sample":false}}}
            }});
            if on_demand {
                described["types"]["Shape"]["derived"] = json!({"sources":{"premiseOnly":true,"onDemand":true}});
            }
            editor.kits.remember_described(editor.kit.id, &described);
            let basis = editor.call("inspect", json!({})).await.unwrap()["revision"].clone();
            // A kit materializes sourceFact on the holder only when its inputs change.
            let change = if relevant { changed("shape:1", "sourceFact", "stable", "changed") } else { changed("shape:2", "text", "Two", "Other") };
            sim.lock().unwrap().change(change);
            editor.changed_by("person", 2);
            let result = editor.call("run", json!({"basis":basis,"steps":[set_text("shape:1","Agent")],"save":false})).await;
            if on_demand || relevant {
                let refused = result.expect_err("held facts must not be silently ignored");
                let reason = if on_demand { "unknown" } else { "changed" };
                assert!(
                    refused["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["id"] == "shape:1" && conflict["reason"] == reason),
                    "{refused}"
                );
                assert!(editor.got("run").is_empty());
            } else {
                result.unwrap_or_else(|error| panic!("an unrelated edit must apply with a stored holder fact: {error}"));
                assert_eq!(editor.got("run").len(), 1);
            }
            editor.close().await;
        }
    }
}

#[tokio::test]
async fn guard_the_person_s_edit_of_another_object_is_named_in_others_and_the_write_applies() {
    let sim = Arc::new(Mutex::new(Sim::default()));
    let editor = journaled_editor("lvgdother", Arc::clone(&sim));
    let basis = editor.call("inspect", json!({})).await.unwrap_or_else(|error| panic!("{error}"))["revision"].clone();
    assert!(basis.is_string(), "an answer in the editor names its revision: {basis}");
    // The person retitles shape:2 in the editor.
    sim.lock().unwrap_or_else(|err| panic!("{err}")).change(changed("shape:2", "text", "Two", "Mine"));
    editor.changed_by("person", 2);
    let ran =
        editor.call("run", json!({ "basis": basis, "steps": [set_text("shape:1", "Agent")], "save": false })).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(ran["others"]["by"], json!(["person"]), "{ran}");
    assert_eq!(ran["others"]["changed"][0]["id"], "shape:2", "{ran}");
    assert_eq!(ran["changes"]["changed"][0]["id"], "shape:1", "the receipt is the agent's write alone: {ran}");
    assert!(ran["revision"].is_string() && ran["revision"] != basis, "{ran}");
    assert_eq!(editor.got("run").len(), 1, "the write applied");
    // The agent's own write is not someone else's: from its revision, nothing happened since.
    let next = editor.call("inspect", json!({ "basis": ran["revision"] })).await.unwrap_or_else(|error| panic!("{error}"));
    assert!(next.get("others").is_none(), "{next}");
    assert_eq!(next["revision"], ran["revision"], "{next}");
    editor.close().await;
}

#[tokio::test]
async fn guard_the_person_deleting_the_write_s_target_refuses_it_as_a_conflict() {
    let sim = Arc::new(Mutex::new(Sim::default()));
    let editor = journaled_editor("lvgddel", Arc::clone(&sim));
    let basis = editor.call("inspect", json!({})).await.unwrap_or_else(|error| panic!("{error}"))["revision"].clone();
    {
        let mut sim = sim.lock().unwrap_or_else(|err| panic!("{err}"));
        sim.shapes.retain(|id| id != "shape:1");
        sim.change(json!({ "created": [], "changed": [], "moved": [], "deleted": [{ "id": "shape:1", "type": "Shape", "fields": [], "at": { "parent": "page", "field": "shapes", "index": 0 } }] }));
    }
    editor.changed_by("person", 2);
    let refused = editor.refused("run", json!({ "basis": basis, "steps": [set_text("shape:1", "Agent")], "save": false })).await;
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    assert_eq!(refused["conflicts"], json!([{ "id": "shape:1", "reason": "deleted" }]), "{refused}");
    assert_eq!(refused["others"]["by"], json!(["person"]), "{refused}");
    assert!(editor.got("run").is_empty(), "nothing was run");
    editor.close().await;
}

#[tokio::test]
async fn guard_the_person_moving_the_write_s_target_refuses_it_and_says_where_it_is_now() {
    let sim = Arc::new(Mutex::new(Sim::default()));
    let editor = journaled_editor("lvgdmove", Arc::clone(&sim));
    let basis = editor.call("inspect", json!({})).await.unwrap_or_else(|error| panic!("{error}"))["revision"].clone();
    {
        let mut sim = sim.lock().unwrap_or_else(|err| panic!("{err}"));
        sim.shapes = vec!["shape:2".into(), "shape:3".into(), "shape:1".into()];
        sim.change(json!({ "created": [], "changed": [], "moved": [{ "id": "shape:1", "type": "Shape", "from": { "parent": "page", "field": "shapes", "index": 0 }, "to": { "parent": "page", "field": "shapes", "index": 2 } }], "deleted": [] }));
    }
    let refused = editor.refused("run", json!({ "basis": basis, "steps": [set_text("shape:1", "Agent")], "save": false })).await;
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    assert_eq!(refused["conflicts"][0]["id"], "shape:1", "{refused}");
    assert_eq!(refused["conflicts"][0]["reason"], "relocated", "{refused}");
    assert_eq!(refused["conflicts"][0]["now"], json!({ "parent": "page", "field": "shapes", "index": 2 }), "{refused}");
    // No `kit.changed` said whose change it was: it is someone else's, `other`.
    assert_eq!(refused["others"]["by"], json!(["other"]), "{refused}");
    assert!(editor.got("run").is_empty(), "nothing was run");
    editor.close().await;
}

#[tokio::test]
async fn guard_an_editor_that_cannot_say_what_changed_keeps_saying_the_guard_is_unavailable() {
    // Without a change history, the stale basis cannot authorize a write.
    let editor = Editor::open(
        "lvgdnone",
        &[],
        Box::new(|tool, _| match tool {
            "run" => {
                json!({ "result": { "completed": [{ "command": "shape.text", "changed": true, "result": null }], "saved": false, "document": { "summary": "x" } } })
            }
            _ => json!({ "error": { "code": -32000, "message": "unexpected call" } }),
        }),
    );
    let answer = editor.refused("run", json!({ "basis": "x1", "steps": [set_text("shape:1", "A")], "save": false })).await;
    assert_eq!(answer["error"]["code"], "conflict", "{answer}");
    assert_eq!(answer["conflicts"][0]["reason"], "unknown", "{answer}");
    assert!(editor.got("run").is_empty());
    editor.close().await;
}

// ---- Preview by explicit view ----

/// An editor whose kit renders views with `file.render`, which takes `target.time` and
/// `target.sequence`, as `ai/commands` lists it (`schema`).
fn rendering_editor(name: &str) -> Editor {
    let commands = json!([{ "id": "file.render", "title": "Render", "description": null, "enabled": true, "mutates": false, "schema": { "type": "object", "properties": { "target": { "type": "object", "properties": { "time": { "type": "number" }, "sequence": { "type": "string" } } }, "scale": { "type": "number" } } } }]);
    Editor::open(
        name,
        &[],
        Box::new(move |tool, arguments| match tool {
            "commands" => json!({ "result": { "commands": commands, "total": 1 } }),
            "inspect" => json!({ "result": { "document": { "summary": "a film" } } }),
            "run" => {
                json!({ "result": { "completed": [{ "command": "file.render", "changed": false, "result": { "png": "iVBORw0KGgo=", "time": arguments["steps"][0]["params"]["target"]["time"] } }], "saved": false } })
            }
            _ => json!({ "error": { "code": -32000, "message": "unexpected call" } }),
        }),
    )
}

#[tokio::test]
async fn render_a_view_member_the_editor_s_render_command_does_not_take_is_invalid_params_and_nothing_is_drawn() {
    let editor = rendering_editor("lvrenderno");
    let refused = editor.refused("inspect", json!({ "preview": true, "target": { "time": 3, "zoom": 2 } })).await;
    assert_eq!(refused["error"]["code"], "invalid-params", "{refused}");
    let message = refused["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("`target.zoom`") && message.contains("`file.render`") && message.contains("`time`"), "{message}");
    assert!(editor.got("run").is_empty(), "nothing was drawn");
    editor.close().await;
}

#[tokio::test]
async fn render_the_view_reaches_the_editor_s_render_command_intact() {
    let editor = rendering_editor("lvrenderok");
    let answer = editor.call("inspect", json!({ "preview": true, "target": { "time": 3, "sequence": "s2" } })).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(answer["live"], true, "{answer}");
    let runs = editor.got("run");
    assert_eq!(runs.len(), 1, "{runs:?}");
    assert_eq!(runs[0]["steps"][0]["command"], "file.render");
    assert_eq!(runs[0]["steps"][0]["params"]["target"], json!({ "time": 3, "sequence": "s2" }), "the view as asked");
    assert_eq!(runs[0]["save"], false, "a preview is never saved");
    editor.close().await;
}
