// Copied from kition-sdk crates/kition-kits/tests/premise_guard.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The revision chain and the premise guard, against the mock kit's decks
//! (`KITION_KIT_MOCK_PARTS=deck`: slides and shapes whose ids survive edits and reloads).
//!
//! - Every result of `<prefix>_inspect`, `_query`, `_run` and `_batch` carries `revision`, a short
//!   token naming the document state it describes; the server keeps, per document, a journal of
//!   the accepted writes (each by its agent) and of the changes made outside (`outside`).
//! - A call that passes `basis` (the last `revision` it was given) is told what others changed
//!   since (`others`, with `by`), and a write whose premises others changed (a target or its part
//!   deleted, relocated, or, for a command step, any of its fields changed; for a batch, the field
//!   it replaces) is refused as a whole with `conflict`, `conflicts` and the current `revision`.
//!   Changes by others to other objects never refuse.
//! - Guard modes (`premise`, `epoch`, `off`), `--require-basis`, the journal's bound, and the A56
//!   path for calls without `basis` (`_batch` refused once like `_run`; reads do not clear it).
//! - Each agent connection is its own principal (the MCP client's name and a suffix), and an
//!   agent's undo never takes back another agent's edit.
//!
//! Two agents are two MCP sessions on one server (`mcp::Session`), or two principals given to
//! `tools::call_as` on one `KitManager`; a change made outside is a write to the file.
//!
//! Cases: `sdk.agent.premise-guard/precision`, `sdk.agent.premise-guard/conflicts`,
//! `sdk.agent.premise-guard/outside`, `sdk.agent.premise-guard/options`,
//! `sdk.agent.premise-guard/principals`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, tests that can skip it say so and pass. CI requires it.
#![cfg(unix)]

#[path = "support/editor.rs"]
mod editor;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use kition_kits::tools::{self, CallOptions, Guard};
use kition_kits::{KitDefinition, KitManager, mcp};
use serde_json::{Value, json};

/// A kit `kit.<name>` editing `.<name>` files. Each test names its own kit: the tools find kits
/// by prefix in one registry per process.
fn kit(name: &str) -> &'static KitDefinition {
    let manifest = json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": format!("Kition {name}"), "version": "0.3.1",
        "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
        "agent": { "prefix": name, "tools": "document" },
        "headless": { "executable": "kition-kit-mock", "protocol": "kition-kit/1" }
    });
    KitDefinition::from_manifest(&manifest).unwrap_or_else(|error| panic!("{error}"))
}

#[path = "support/binary.rs"]
mod binary;
use binary::mock_binary;

fn as_kit(dir: &Path, mock: &Path, name: &str, env: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join(format!("kition-{name}-mock.sh"));
    std::fs::write(&script, format!("#!/bin/sh\nKITION_KIT_MOCK_AS=kit.{name}:{name} KITION_KIT_MOCK_VERSION=0.3.1 {env} exec '{}' \"$@\"\n", mock.display()))
        .unwrap_or_else(|err| panic!("{err}"));
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap_or_else(|err| panic!("{err}"));
    script
}

/// Two slides: shapes 1, 2, 3 on the first (slide 1), 4 and 5 on the second (slide 2).
const DECK: &str = "1:1=Title|2=Body|3=Footer\n2:4=Second|5=More";

/// A deck as a real slide kit models it (`KITION_KIT_MOCK_DECK=nested`): slides 7 and 9 (slide
/// numbers 1 and 2), each with a shape numbered 1 (`shape:7/1`, `shape:9/1`: per-slide numbers in
/// document-unique tool ids), shapes' text in an owned body of paragraphs without tool ids, and a
/// note on slide 9 (`slide:9/note:1`, an id starting as the slide's does).
const NESTED: &str = "7:1=Title|2=Body\n9:1=Other|2=More|!1=Speak slowly";
const NESTED_ENV: &str = "KITION_KIT_MOCK_PARTS=deck KITION_KIT_MOCK_DECK=nested";

const ME: &str = "agent-me";
const OTHER: &str = "agent-other";

#[path = "support/guard_regressions.rs"]
mod guard_regressions;

#[path = "support/nested_list_regressions.rs"]
mod nested_list_regressions;

fn comment_write(command: &str, target: &str, raw: bool) -> Value {
    if !raw {
        return json!({"steps":[{"command":command,"params":{"target":target}}]});
    }
    let ops = match command {
        "comment.reply" => json!([
            {"op":"create","type":"Comment","ref":"$reply","fields":{"author":"agent","created":"2026-11-14T00:00:00Z"}},
            {"op":"text.insert","target":"$reply","field":"body","index":0,"text":"Reply"},
            {"op":"list.insert","target":target,"field":"comments","index":1,"item":"$reply"}
        ]),
        "comment.resolve" => json!([{"op":"set","target":target,"field":"resolved","value":true}]),
        "comment.edit" => json!([{"op":"text.set","target":target,"field":"body","text":"Edited"}]),
        _ => json!([{"op":"delete","target":target}]),
    };
    json!({"ops":ops})
}

#[tokio::test]
async fn shared_comment_batches_match_commands_and_refuse_deleted_reply_targets() {
    for command in ["comment.reply", "comment.resolve", "comment.delete", "comment.edit"] {
        for raw in [false, true] {
            for change in ["fresh", "deleted", "held", "unrelated"] {
                let f = Fixture::new("sharedcomments", "KITION_KIT_MOCK_ORDER=list KITION_KIT_MOCK_COMMENTS=1 KITION_KIT_MOCK_BATCH=commands", "new")
                    .expect("build mock");
                let basis = f.revision(ME).await;
                let target = if command == "comment.edit" { "held-comment" } else { "held" };
                let changed = if change == "unrelated" { "other" } else { "held" };
                let op = match change {
                    "deleted" => json!({"op":"delete","target":target}),
                    _ if command == "comment.edit" => {
                        json!({"op":"text.insert","target":format!("{changed}-comment"),"field":"body","index":0,"text":"Theirs "})
                    }
                    _ if command == "comment.reply" => json!({"op":"list.remove","target":changed,"field":"comments","index":0}),
                    _ => json!({"op":"set","target":changed,"field":"resolved","value":true}),
                };
                if change != "fresh" {
                    f.ok(OTHER, "batch", json!({"ops":[op]})).await;
                }
                let before = f.read();
                let mut input = comment_write(command, target, raw);
                input["basis"] = json!(basis);
                let result = f.call(ME, if raw { "batch" } else { "run" }, input).await;
                if matches!(change, "fresh" | "unrelated") || command == "comment.delete" && change == "held" {
                    assert!(result.is_ok(), "{command}/{raw}/{change}: {result:?}");
                    assert_ne!(f.read(), before);
                } else {
                    let error = result.expect_err("changed comment premise must refuse");
                    let reason = if change == "deleted" {
                        "deleted"
                    } else if raw && command == "comment.reply" {
                        "relocated"
                    } else {
                        "changed"
                    };
                    assert!(
                        error["conflicts"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|entry| (entry["id"] == target || entry["place"]["target"] == target) && entry["reason"] == reason),
                        "{command}/{raw}/{change}: {error}"
                    );
                    assert_eq!(f.read(), before);
                }
                f.shutdown().await;
            }
        }
    }
}

#[tokio::test]
async fn raw_contracts_also_cover_references_returned_by_commands() {
    for declared in [false, true] {
        let name = if declared { "createdcontract" } else { "batchcontract" };
        let f = Fixture::new(name, "KITION_KIT_MOCK_ORDER=list KITION_KIT_MOCK_CREATION=command KITION_KIT_MOCK_BATCH=commands", r#"{"items":[],"other":[]}"#)
            .expect("build mock");
        let before = f.read();
        let result = f.call(ME, "batch", json!({"ops":[
            {"op":"command","id":"order.create","ref":"$new","params":{"name":"Created","kind":{"shape":"box","width":10},"at":0,"fixture":{"data":[137,80,78,71],"mime":"image/png"}}},
            {"op":"set","target":"$new","field":"name","value":"Edited"}
        ]})).await;
        if !declared {
            let error = result.expect_err("command-returned references must not bypass missing raw contracts");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
            assert_eq!(f.read(), before);
        } else if std::env::var("KITION_TEST_READER").as_deref() == Ok("editor") {
            assert_eq!(result.expect_err("mixed editor batches need rollback")["error"]["code"], "unsupported");
            assert_eq!(f.read(), before);
        } else {
            assert!(result.is_ok(), "{result:?}");
            assert!(f.read().contains("Edited"));
        }
        f.shutdown().await;
    }
}

#[tokio::test]
async fn scoped_undo_and_redo_hold_the_objects_of_their_next_step() {
    for redo in [false, true] {
        for change in ["held", "other-object", "other-field"] {
            let touched = change == "held";
            let f = Fixture::deck("gundotouch").expect("build mock");
            f.ok(ME, "run", json!({"steps":[{"command":"shape.text","params":{"id":"shape:1","text":"Mine"}}]})).await;
            if redo {
                f.ok(ME, "run", json!({"steps":[{"command":"edit.undo"}]})).await;
            }
            let basis = f.revision(ME).await;
            let target = if change == "other-object" { "shape:2" } else { "shape:1" };
            let view = f.native.open(kition_kits::Caller::Agent, &f.path()).await.unwrap();
            let (command, params) = if change == "other-field" {
                ("shape.color", json!({"id":target,"color":"blue"}))
            } else {
                ("shape.text", json!({"id":target,"text":"Theirs"}))
            };
            f.native.execute(kition_kits::Caller::User, view.kit_id, &view.document_id, command, params.as_object().unwrap().clone()).await.unwrap();
            let under = f
                .native
                .context(
                    kition_kits::Caller::Agent,
                    view.kit_id,
                    &view.document_id,
                    "context.under",
                    json!({"command":if redo {"edit.redo"} else {"edit.undo"},"params":{"scope":"agent"}}).as_object().unwrap().clone(),
                )
                .await
                .unwrap();
            assert_eq!(under.unwrap()["premises"], json!([{"id":"shape:1","fields":["text"]}]));
            let before = f.read();
            let command = if redo { "edit.redo" } else { "edit.undo" };
            let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":command}]})).await;
            if touched {
                let error = answer.expect_err("a changed undo target must refuse");
                assert!(error["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "changed"), "{error}");
                assert_eq!(f.read(), before);
            } else {
                assert!(answer.is_ok(), "unrelated undo target: {answer:?}");
            }
            f.shutdown().await;
        }
    }
}

fn records() -> Value {
    json!({"items":[
        {"key":"A","name":"Alpha","data":{"branch":{"leaf":{"n":1},"sibling":2},"members":[{"key":"a","name":"Alpha","value":1},{"key":"b","name":"Beta","value":2}]},"extra":1},
        {"key":"B","name":"Beta","data":{"branch":{"leaf":{"n":2},"sibling":2}},"extra":2}
    ],"other":[]})
}

fn member_records() -> Value {
    let mut file = records();
    file["items"][0]["data"] = json!({"members":[
        {"key":"a","name":"Alpha","value":1,"children":[{"key":"aa","name":"First child","value":10}]},
        {"key":"b","name":"Beta","value":2,"children":[{"key":"bb","name":"Selected child","value":20}]},
        {"key":"c","name":"Gamma","value":3,"children":[{"key":"cc","name":"Last child","value":30}]}
    ]});
    file["items"][1]["data"] = json!({"members":[]});
    file
}

#[tokio::test]
async fn stable_member_id_survives_an_outside_sibling_deletion() {
    let mut failures = Vec::new();
    for change in ["delete-before", "target", "other"] {
        let original = member_records();
        let f = Fixture::new("stablemember", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_MEMBERS=1", &original.to_string()).expect("build mock");
        let basis = f.revision(ME).await;
        let mut after = original;
        match change {
            "delete-before" => {
                after["items"][0]["data"]["members"].as_array_mut().unwrap().remove(0);
            }
            "target" => after["items"][0]["data"]["members"][1]["value"] = json!(20),
            _ => after["items"][0]["data"]["members"][0]["value"] = json!(10),
        }
        f.write_outside(&after.to_string());
        let saved = f.read();
        let answer = f.call(ME, "batch", json!({"basis":basis,"ops":[{"op":"set","target":"member:A:b","field":"value","value":20}]})).await;
        if answer.is_ok() {
            after["items"][0]["data"]["members"].as_array_mut().unwrap().iter_mut().find(|member| member["key"] == "b").unwrap()["value"] = json!(20);
            assert_eq!(serde_json::from_str::<Value>(&f.read()).unwrap(), after, "{change}: only the named member is written");
        }
        matrix_result(change, (change == "target").then_some("changed"), answer, f.read() == saved, &mut failures);
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn named_member_survives_outside_sibling_deletions() {
    let mut failures = Vec::new();
    for change in [
        "delete-before",
        "delete-after",
        "delete-before-target",
        "delete-before-target-child",
        "delete-before-target-null",
        "delete-before-target-child-null",
        "rename",
        "target",
        "target-child",
        "other",
    ] {
        let mut original = member_records();
        if change == "delete-before-target-null" {
            original["items"][0]["data"]["members"][0]["value"] = Value::Null;
            original["items"][0]["data"]["members"][1]["value"] = json!({"observed":2});
        } else if change == "delete-before-target-child-null" {
            original["items"][0]["data"]["members"][0]["children"][0]["value"] = Value::Null;
            original["items"][0]["data"]["members"][1]["children"][0]["value"] = json!({"observed":20});
        }
        let f = Fixture::new("namesibling", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_MEMBERS=1", &original.to_string()).expect("build mock");
        let basis = f.revision(ME).await;
        let members = original["items"][0]["data"]["members"].as_array_mut().unwrap();
        match change {
            "delete-before" => {
                members.remove(0);
            }
            "delete-after" => {
                members.remove(2);
            }
            "delete-before-target" | "delete-before-target-child" | "delete-before-target-null" | "delete-before-target-child-null" => {
                members.remove(0);
                if change == "delete-before-target" {
                    members[0]["value"] = json!(20);
                } else if change == "delete-before-target-child" {
                    members[0]["children"][0]["value"] = json!(21);
                } else if change == "delete-before-target-null" {
                    members[0]["value"] = Value::Null;
                } else {
                    members[0]["children"][0]["value"] = Value::Null;
                }
            }
            "rename" => members[1]["name"] = json!("Away"),
            "target" => members[1]["value"] = json!(20),
            "target-child" => members[1]["children"][0]["value"] = json!(21),
            _ => members[0]["value"] = json!(10),
        }
        f.write_outside(&original.to_string());
        let saved = f.read();
        let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","hold":["data.members[name=Beta]"],"identity":"key","write":"name","value":"Agent"}}]})).await;
        let expected = match change {
            "rename" => Some("relocated"),
            "delete-before-target"
            | "delete-before-target-child"
            | "delete-before-target-null"
            | "delete-before-target-child-null"
            | "target"
            | "target-child" => Some("changed"),
            _ => None,
        };
        if answer.is_ok() {
            original["items"][0]["name"] = json!("Agent");
            assert_eq!(serde_json::from_str::<Value>(&f.read()).unwrap(), original, "{change}: unrelated member content is preserved");
        }
        matrix_result(change, expected, answer, f.read() == saved, &mut failures);
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn private_content_basis_survives_another_agents_write() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for related in [false, true] {
            let mut original = records();
            original["other"] =
                json!((0..40).map(|i| json!({"key":format!("marker-{i:02}"),"name":"Marker","data":{"layer":"A"},"extra":0})).collect::<Vec<_>>());
            let f = Fixture::new("privatecontent", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_DERIVED=1", &original.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            let index = if related { 0 } else { 39 };
            original["other"][index]["data"]["layer"] = json!("B");
            matrix_change(&f, outside, &original, vec![json!({"op":"set","target":format!("marker-{index:02}"),"field":"data","value":{"layer":"B"}})]).await;
            let saved = f.read();
            let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","contentField":"~layerItems","contentRegion":0,"write":"name","value":"Agent"}}]})).await;
            let output = answer.as_ref().unwrap_or_else(|error| error);
            for field in ["changes", "others"] {
                assert!(!output[field].to_string().contains("~layerItems"), "private facts leaked in {field}: {output}");
            }
            if answer.is_ok() {
                original["items"][0]["name"] = json!("Agent");
                assert_eq!(serde_json::from_str::<Value>(&f.read()).unwrap(), original, "the unrelated member edit survives the guarded write");
            }
            matrix_result(&format!("private-content/{outside}/{related}"), related.then_some("changed"), answer, f.read() == saved, &mut failures);
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn conditional_recipients_keep_departed_historical_matches() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for predicate in ["parameter", "subset", "bytes"] {
            for change in ["departed", "deleted", "unrelated"] {
                let file = json!({"items":[{"key":"A","name":"Anchor","data":{},"extra":0},{"key":"B","name":"Second","data":{},"extra":0}],"other":[
                    {"key":"C","name":"Recipient","data":{"owner":"A","bytes":"observed"},"extra":0},
                    {"key":"E","name":"Second recipient","data":{"owner":"B","bytes":"second"},"extra":0},
                    {"key":"D","name":"Unrelated","data":{"owner":"elsewhere","bytes":"other"},"extra":0}
                ]});
                let f = Fixture::new("historicalmatches", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_CONDITIONAL=1", &file.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let mut after = file.clone();
                let key = if change == "unrelated" { "D" } else { "C" };
                let index = if key == "D" { 2 } else { 0 };
                let ops = if change == "deleted" {
                    after["other"].as_array_mut().unwrap().remove(index);
                    vec![json!({"op":"delete","target":key})]
                } else {
                    after["other"][index]["data"] = json!({"owner":"elsewhere","bytes":"changed"});
                    vec![json!({"op":"set","target":key,"field":"data","value":after["other"][index]["data"]})]
                };
                matrix_change(&f, outside, &after, ops).await;
                let saved = f.read();
                let result = f
                    .call(
                        ME,
                        "run",
                        json!({"basis":basis,"steps":[{"command":"matrix.write","params":{
                            "item":"A","predicate":predicate,"kind":"shape","recipient":"C","subset":["A","B"],"bytes":"observed","value":"Mine"
                        }}]}),
                    )
                    .await;
                let reason = if change == "unrelated" {
                    None
                } else if change == "deleted" {
                    Some("deleted")
                } else if predicate == "parameter" {
                    Some("changed")
                } else {
                    Some("relocated")
                };
                matrix_result(&format!("conditional/{outside}/{predicate}/{change}"), reason, result, f.read() == saved, &mut failures);
                if change == "unrelated" {
                    let saved: Value = serde_json::from_str(&f.read()).unwrap();
                    assert_eq!(saved["other"][0]["extra"], "Mine");
                    assert_eq!(saved["other"][1]["extra"], if predicate == "subset" { json!("Mine") } else { json!(0) });
                }
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn conditional_recipients_do_not_hold_an_unused_parameter() {
    let f = Fixture::new("unusedrecipient", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_CONDITIONAL=1", &records().to_string()).expect("build mock");
    let basis = f.revision(ME).await;
    f.ok(OTHER, "batch", json!({"ops":[{"op":"set","target":"B","field":"data","value":"Other"}]})).await;
    f.ok(
        ME,
        "run",
        json!({"basis":basis,"steps":[{"command":"matrix.write","params":{
            "item":"A","predicate":"parameter","kind":"chart","recipient":"B","value":"Mine"
        }}]}),
    )
    .await;
    let saved: Value = serde_json::from_str(&f.read()).unwrap();
    assert_eq!(saved["items"][1]["data"], "Other");
    assert_eq!(saved["items"][1]["extra"], 2);
    f.shutdown().await;
}

#[tokio::test]
async fn covered_gone_is_deleted_instead_of_relocated() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for reason in ["deleted", "relocated", "unknown"] {
            let mut initial = records();
            initial["items"][0]["data"] = json!("held content");
            let f = Fixture::new("mcoveredgone", &format!("KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_COVERED_GONE={reason}"), &initial.to_string())
                .expect("build mock");
            let basis = f.revision(ME).await;
            let mut after = initial.clone();
            after["items"][0]["data"] = json!("");
            matrix_change(&f, outside, &after, vec![json!({"op":"set","target":"A","field":"data","value":""})]).await;
            let before = f.read();
            let result =
                f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","range":[0,1],"value":"Mine"}}]})).await;
            matrix_result(&format!("covered-gone/{outside}/{reason}"), Some(reason), result, f.read() == before, &mut failures);
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn receipts_and_others_locate_long_text_edits_with_bounded_bytes() {
    for outside in [false, true] {
        let mut initial = records();
        let text = format!("{}target{}", "x".repeat(5_000), "y".repeat(5_000));
        initial["items"][0]["data"] = json!(text);
        let f = Fixture::new("mlocatedtext", "KITION_KIT_MOCK_ORDER=matrix", &initial.to_string()).expect("build mock");
        let basis = f.revision(ME).await;
        let replacement = text.replacen("target", "updated", 1);
        let mut after = initial.clone();
        after["items"][0]["data"] = json!(replacement);
        if outside {
            f.write_outside(&after.to_string());
        } else {
            let receipt = f.ok(OTHER, "batch", json!({"ops":[{"op":"set","target":"A","field":"data","value":replacement}]})).await;
            assert_eq!(receipt["changes"]["changed"][0]["edits"][0]["span"]["offset"], 5_000, "{receipt}");
            assert!(receipt["changes"].to_string().len() < 2_048, "{}", receipt["changes"].to_string().len());
        }
        let answer = f.ok(ME, "inspect", json!({"basis":basis})).await;
        let edit = &answer["others"]["changed"][0]["edits"][0];
        assert_eq!(edit["span"]["offset"], 5_000, "{answer}");
        assert_eq!(edit["span"]["removed"], "target");
        assert_eq!(edit["span"]["inserted"], "updated");
        assert_eq!(edit["span"]["complete"], true);
        assert!(answer["others"].to_string().len() < 2_048);
        f.shutdown().await;
    }
}

#[tokio::test]
async fn map_keyed_overlay_shifts_compact_in_receipts_and_others() {
    let mut initial = records();
    initial["items"][0]["data"] =
        json!({"overlay":(0..200).map(|i|(format!("annotation-{i}"),json!({"x":i,"y":i*2,"label":"overlay"}))).collect::<serde_json::Map<_,_>>()});
    let f = Fixture::new("mmapfootprint", "KITION_KIT_MOCK_ORDER=matrix", &initial.to_string()).expect("build mock");
    let basis = f.revision(ME).await;
    let mut overlay = initial["items"][0]["data"].clone();
    for value in overlay["overlay"].as_object_mut().unwrap().values_mut() {
        value["x"] = json!(value["x"].as_i64().unwrap() + 3);
    }
    let answer = f.ok(OTHER, "batch", json!({"ops":[{"op":"set","target":"A","field":"data","value":overlay}]})).await;
    let print = &answer["changes"]["changed"][0]["edits"][0];
    assert_eq!(print["field"], "data.overlay.*.x", "{answer}");
    assert_eq!(print["count"], 200);
    assert_eq!(print["keys"].as_array().unwrap().len(), 200);
    assert_eq!(print["shift"]["by"], 3);
    assert!(answer["changes"].to_string().len() < 4_096);
    let others = f.ok(ME, "inspect", json!({"basis":basis})).await;
    assert_eq!(others["others"]["changed"][0]["edits"][0], *print);
    assert!(others["others"].to_string().len() < 4_096);
    f.shutdown().await;
}

#[tokio::test]
async fn only_declared_reference_parameters_hold_objects_matrix() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for route in ["run", "batch"] {
            for kind in ["id", "name", "string", "integer", "nested-id", "nested-literal", "array-id", "array-literal"] {
                let mut initial = records();
                initial["other"] = json!([{"key":"17","name":"17","data":{},"extra":0}]);
                let f =
                    Fixture::new("mdeclaredvalues", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_BATCH=commands", &initial.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let mut after = initial.clone();
                after["other"] = json!([]);
                matrix_change(&f, outside, &after, vec![json!({"op":"delete","target":"17"})]).await;
                let mut params = json!({"item":"A","value":"Written"});
                match kind {
                    "id" => params["sourceId"] = json!("17"),
                    "name" => params["sourceName"] = json!("17"),
                    "string" => params["value"] = json!("17"),
                    "integer" => params["value"] = json!(17),
                    "nested-id" => params["nested"] = json!({"id":"17"}),
                    "nested-literal" => params["nested"] = json!({"literal":"17"}),
                    "array-id" => params["sources"] = json!(["17"]),
                    _ => params["value"] = json!(["17"]),
                }
                let input = if route == "run" {
                    json!({"basis":basis,"steps":[{"command":"matrix.write","params":params}]})
                } else {
                    json!({"basis":basis,"ops":[{"op":"command","id":"matrix.write","params":params}]})
                };
                let saved = f.read();
                let result = f.call(ME, route, input).await;
                let holds = matches!(kind, "id" | "name" | "nested-id" | "array-id");
                matrix_result(&format!("declared/{outside}/{route}/{kind}"), holds.then_some("deleted"), result, f.read() == saved, &mut failures);
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn unknown_messages_distinguish_content_basis_from_unproven_identity() {
    for cause in ["content", "identity"] {
        let mut initial = records();
        initial["items"][0]["data"] = json!("x".repeat(1_048_577));
        let env = format!("KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_UNPROVEN={}", if cause == "identity" { "A" } else { "" });
        let f = Fixture::new("munknownmessages", &env, &initial.to_string()).expect("build mock");
        let basis = f.revision(ME).await;
        let mut after = initial.clone();
        if cause == "content" {
            after["items"][0]["data"] = json!(format!("{}y", "x".repeat(1_048_576)));
        } else {
            after["items"][1]["extra"] = json!(7);
        }
        f.write_outside(&after.to_string());
        let params = if cause == "content" { json!({"item":"A","contentRegion":[2,5]}) } else { json!({"item":"A","hold":["extra"]}) };
        let refused = f.refused(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":params}]})).await;
        let message = refused["error"]["message"].as_str().unwrap();
        assert!(message.contains(if cause == "content" { "Content basis unavailable" } else { "Identity unprovable" }), "{cause}: {refused}");
        assert!(!message.contains("renumbered"), "{cause}: {refused}");
        f.shutdown().await;
    }
}

#[tokio::test]
async fn covered_removed_text_is_deleted_and_shifted_text_is_relocated() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for edit in ["delete", "shift", "after"] {
            let mut initial = records();
            initial["items"][0]["data"] = json!("abcdefghijklmno");
            let f = Fixture::new("mremovedtext", "KITION_KIT_MOCK_ORDER=matrix", &initial.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            let mut after = initial.clone();
            after["items"][0]["data"] = json!(match edit {
                "delete" => "abhijklmno",
                "shift" => "XXabcdefghijklmno",
                _ => "abcdefghijklmnoXX",
            });
            matrix_change(&f, outside, &after, vec![json!({"op":"set","target":"A","field":"data","value":after["items"][0]["data"]})]).await;
            let saved = f.read();
            let result = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","range":[3,6]}}]})).await;
            matrix_result(
                &format!("removed-text/{outside}/{edit}"),
                match edit {
                    "delete" => Some("deleted"),
                    "shift" => Some("relocated"),
                    _ => None,
                },
                result,
                f.read() == saved,
                &mut failures,
            );
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn reread_reports_deleted_replica_only_objects_before_a_stale_write_runs() {
    for ty in ["Item", "Thread"] {
        for route in ["outside", "notification", "reload"] {
            let f = Fixture::new("mdroppedobjects", "KITION_KIT_MOCK_ORDER=matrix", &records().to_string()).expect("build mock");
            let created = f
                .ok(
                    ME,
                    "batch",
                    json!({"ops":[{"op":"create","type":ty,"ref":"$thread","fields":{"key":"thread","name":"Thread","data":{"anchor":0},"extra":0}}]}),
                )
                .await;
            let id = created["refs"]["$thread"].clone();
            let basis = f.revision(ME).await;
            let view = f.native.open(kition_kits::Caller::Agent, &f.path()).await.unwrap();
            let mut after = records();
            after["items"][1]["extra"] = json!(7);
            if route != "reload" {
                f.write_outside(&after.to_string());
            }
            if route == "notification" {
                f.native.changed_on_disk(&f.path()).await;
            }
            if route == "reload" {
                f.native.reload(view.kit_id, &view.document_id).await.unwrap();
            }
            let saved = f.read();
            let refused = f.refused(ME, "batch", json!({"basis":basis,"ops":[{"op":"set","target":id,"field":"extra","value":1}]})).await;
            assert_eq!(refused["error"]["code"], "conflict", "{ty} {route}: {refused}");
            assert!(refused["conflicts"].as_array().unwrap().iter().any(|c| c["id"] == id && c["reason"] == "deleted"), "{ty} {route}: {refused}");
            assert!(refused["others"]["deleted"].as_array().unwrap().iter().any(|c| c["id"] == id), "{ty} {route}: {refused}");
            assert_eq!(f.read(), saved, "{ty} {route}");
            f.shutdown().await;
        }
    }
}

/// The kit reads the changed file again on its own (`document.didChangeOnDisk`, handled on the
/// host's connection) while the server reads the document on the agent's: here between the
/// server's `model.version` and its read of the objects (`KITION_KIT_MOCK_REREAD=late`). The
/// replica-only object is still reported deleted, and the stale write on it is refused.
#[tokio::test]
async fn kit_reread_between_the_servers_reads_still_reports_the_deleted_object() {
    let mut failures = Vec::new();
    for ty in ["Item", "Thread"] {
        let f = Fixture::new("mlatereread", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_REREAD=late", &records().to_string()).expect("build mock");
        let created = f
            .ok(ME, "batch", json!({"ops":[{"op":"create","type":ty,"ref":"$thread","fields":{"key":"thread","name":"Thread","data":{"anchor":0},"extra":0}}]}))
            .await;
        let id = created["refs"]["$thread"].clone();
        let basis = f.revision(ME).await;
        f.native.open(kition_kits::Caller::Agent, &f.path()).await.unwrap();
        let mut after = records();
        after["items"][1]["extra"] = json!(7);
        f.write_outside(&after.to_string());
        f.native.changed_on_disk(&f.path()).await;
        let saved = f.read();
        let answer = f.call(ME, "batch", json!({"basis":basis,"ops":[{"op":"set","target":id,"field":"extra","value":1}]})).await;
        let refused = match answer {
            Err(refused) => refused,
            Ok(answer) => {
                failures.push(format!("{ty}: the stale write ran: {answer}"));
                f.shutdown().await;
                continue;
            }
        };
        let deleted = refused["error"]["code"] == "conflict"
            && refused["conflicts"].as_array().is_some_and(|conflicts| conflicts.iter().any(|c| c["id"] == id && c["reason"] == "deleted"))
            && refused["others"]["deleted"].as_array().is_some_and(|others| others.iter().any(|c| c["id"] == id));
        if !deleted {
            failures.push(format!("{ty}: not refused as deleted: {refused}"));
        }
        if f.read() != saved {
            failures.push(format!("{ty}: the refused write changed the file"));
        }
        f.shutdown().await;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn reread_carry_hook_keeps_reanchors_or_drops_replica_only_objects() {
    for action in ["keep", "reanchor", "drop"] {
        let f = Fixture::new("mcarryobjects", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_CARRY=1", &records().to_string()).expect("build mock");
        f.ok(
            ME,
            "batch",
            json!({"ops":[{"op":"create","type":"Item","fields":{"key":"thread","name":format!("Replica {action}"),"data":{"anchor":0},"extra":0}}]}),
        )
        .await;
        let basis = f.revision(ME).await;
        let mut after = records();
        after["items"][1]["extra"] = json!(7);
        f.write_outside(&after.to_string());
        let saved = f.read();
        let answer = f
            .call(ME, "batch", json!({"basis":basis,"ops":[{"op":"set","target":"thread","field":"data","value":{"anchor":2}}],"load":[{"target":"thread"}]}))
            .await;
        if action == "keep" {
            let answer = answer.unwrap_or_else(|error| panic!("{action}: {error}"));
            assert_eq!(answer["loaded"][0]["fields"]["data"], json!({"anchor":2}));
            assert!(!answer["others"]["deleted"].as_array().unwrap().iter().any(|object| object["id"] == "thread"));
        } else {
            let refused = answer.expect_err("changed or dropped basis object");
            assert!(
                refused["conflicts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|object| object["id"] == "thread" && object["reason"] == if action == "drop" { "deleted" } else { "changed" }),
                "{action}: {refused}"
            );
            assert_eq!(f.read(), saved);
            if action == "reanchor" {
                let current = f.revision(ME).await;
                let loaded = f.ok(ME, "batch", json!({"basis":current,"ops":[],"load":[{"target":"thread"}]})).await;
                assert_eq!(loaded["loaded"][0]["fields"]["data"], json!({"anchor":1}));
            }
        }
        f.shutdown().await;
    }
}

#[tokio::test]
async fn empty_places_hold_absence_against_creation_matrix() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for form in ["index", "gap", "time", "covers", "name", "object", "premise"] {
            for inside in [false, true] {
                let mut initial = json!({"items":[{"key":"A","name":"Chart","data":{},"extra":0}],"other":[]});
                if form == "gap" {
                    initial["other"] = json!([
                        {"key":"L","name":"Left","data":{},"extra":0},
                        {"key":"R","name":"Right","data":{},"extra":3}
                    ]);
                }
                let f = Fixture::new("memptyplaces", "KITION_KIT_MOCK_ORDER=matrix", &initial.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let mut after = initial.clone();
                let in_other = form != "index" || inside;
                let (field, ty) = if in_other { ("other", "Other") } else { ("items", "Item") };
                let key = if !inside && matches!(form, "object" | "premise") { "D" } else { "C" };
                let created = json!({"key":key,"name":if inside {"Held"} else {"Next"},"data":{},"extra":if inside {1} else {2}});
                let at = if form == "gap" && inside { 1 } else { after[field].as_array().unwrap().len() };
                after[field].as_array_mut().unwrap().insert(at, created.clone());
                matrix_change(&f, outside, &after, vec![json!({"op":"create","type":ty,"in":format!("root.{field}"),"at":at,"fields":created})]).await;
                let saved = f.read();
                let mut params = json!({"item":"A","emptyPlace":form,"value":"Agent"});
                if form == "name" {
                    params["sourceName"] = json!("Held");
                }
                let result = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":params}]})).await;
                matrix_result(&format!("empty-place/{outside}/{form}/{inside}"), inside.then_some("relocated"), result, f.read() == saved, &mut failures);
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn covered_cells_still_hold_their_independent_row_index_window() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for inside in [false, true] {
            for edit in ["create", "delete", "move"] {
                let initial = json!({"sheets":(1..=2).map(|sheet|json!({"id":sheet,"name":format!("Sheet {sheet}"),
                    "rows":(1..=3).map(|row|json!({"id":(sheet-1)*3+row,"name":format!("Row {row}")})).collect::<Vec<_>>(),
                    "cells":(1..=3).map(|row|json!({"id":(sheet-1)*3+row,"row":(sheet-1)*3+row,"value":row})).collect::<Vec<_>>()
                })).collect::<Vec<_>>()});
                let f = Fixture::new("mcellwindow", "KITION_KIT_MOCK_ORDER=structure", &initial.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let sheet = if inside { 1 } else { 2 };
                let mut after = initial.clone();
                let rows = after["sheets"][sheet - 1]["rows"].as_array_mut().unwrap();
                let op = match edit {
                    "create" => {
                        rows.insert(1, json!({"id":7,"name":"New row"}));
                        json!({"op":"create","type":"Row","in":format!("sheet:{sheet}.rows"),"at":1,"fields":{"name":"New row"}})
                    }
                    "delete" => {
                        let row = rows.remove(1)["id"].as_u64().unwrap();
                        json!({"op":"delete","target":format!("row:{row}")})
                    }
                    _ => {
                        rows.swap(1, 2);
                        json!({"op":"list.move","target":format!("sheet:{sheet}"),"field":"rows","from":1,"to":3})
                    }
                };
                matrix_change(&f, outside, &after, vec![op]).await;
                let saved = f.read();
                let result = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"cell.write","params":{"cell":"cell:1","value":99}}]})).await;
                let expected = inside.then_some(if edit == "delete" { "deleted" } else { "relocated" });
                matrix_result(&format!("cell-covers-within/{outside}/{inside}/{edit}"), expected, result, f.read() == saved, &mut failures);
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn scoped_string_addresses_are_guarded_before_the_command_runs() {
    for outside in [false, true] {
        for moved in [false, true] {
            let file = json!({"items":[{"key":"A","name":"Shape","data":{},"extra":0}],"other":[]});
            let f = Fixture::new("mscopedaddress", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_WINDOWS=address", &file.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            let mut after = file.clone();
            let ops = if moved {
                after["items"] = json!([]);
                after["other"] = file["items"].clone();
                vec![
                    json!({"op":"list.remove","target":"root","field":"items","index":0}),
                    json!({"op":"list.insert","target":"root","field":"other","index":0,"item":"A"}),
                ]
            } else {
                after["items"][0]["data"] = json!({"unheld":1});
                vec![json!({"op":"set","target":"A","field":"data","value":{"unheld":1}})]
            };
            matrix_change(&f, outside, &after, ops).await;
            let saved = f.read();
            let result = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"shape:items/1","value":2}}]})).await;
            if moved {
                let error = result.expect_err("the scoped source is now empty");
                assert_eq!(error["error"]["code"], "conflict", "{outside}: {error}");
                assert_eq!(error["conflicts"][0]["reason"], "relocated", "{outside}: {error}");
                assert_eq!(f.read(), saved);
            } else {
                result.unwrap_or_else(|e| panic!("unheld content: {e}"));
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn design_shaped_derived_holders_are_independent_and_evaluated_on_demand() {
    for demand in [false, true] {
        for outside in [false, true] {
            for reverted in [false, true] {
                for held in ["L0", "L1"] {
                    let log = tempfile::tempdir().unwrap();
                    let count = log.path().join("count");
                    let file = json!({"items":(0..32).map(|i|json!({"key":format!("L{i}"),"name":format!("Layer {i}"),"data":{},"extra":0})).collect::<Vec<_>>(),
                    "other":[{"key":"frame","name":"Frame","data":{"layer":"L0"},"extra":0}]});
                    let env = format!(
                        "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_DERIVED=1 KITION_KIT_MOCK_DEMAND={} KITION_KIT_MOCK_DERIVED_COUNT={}",
                        u8::from(demand),
                        count.display()
                    );
                    let f = Fixture::new("mdesignholders", &env, &file.to_string()).expect("build mock");
                    let basis = f.revision(ME).await;
                    std::fs::write(&count, "").unwrap();
                    let mut after = file.clone();
                    after["other"][0]["data"]["layer"] = json!("L2");
                    matrix_change(&f, outside, &after, vec![json!({"op":"set","target":"frame","field":"data","value":{"layer":"L2"}})]).await;
                    if reverted {
                        f.revision(OTHER).await;
                        matrix_change(&f, outside, &file, vec![json!({"op":"set","target":"frame","field":"data","value":{"layer":"L0"}})]).await;
                    }
                    let saved = f.read();
                    let result = f
                        .call(
                            ME,
                            "run",
                            json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":held,"hold":["~layerItems"],"value":"Agent"}}]}),
                        )
                        .await;
                    if held == "L0" {
                        let error = result.expect_err("held layer membership changed");
                        assert!(error["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "changed"), "{demand}/{outside}: {error}");
                        assert_eq!(f.read(), saved);
                    } else {
                        result.unwrap_or_else(|e| panic!("unrelated layer must apply: {demand}/{outside}: {e}"));
                    }
                    if demand {
                        let evaluations = std::fs::read_to_string(&count).unwrap().lines().count();
                        assert_eq!(evaluations, 1, "32 declaring holders, one held: demand={demand}, outside={outside}");
                    }
                    f.shutdown().await;
                }
            }
        }
    }
}

fn matrix_result(label: &str, expected: Option<&str>, answer: Result<Value, Value>, unchanged: bool, failures: &mut Vec<String>) {
    let actual = match &answer {
        Ok(_) => "apply",
        Err(e) if e["error"]["code"] == "conflict" => e["conflicts"][0]["reason"].as_str().unwrap_or("missing-reason"),
        Err(_) => "other-error",
    };
    let valid = actual == expected.unwrap_or("apply") && (answer.is_ok() || unchanged);
    println!("MATRIX {label}: {} {}", expected.unwrap_or("apply"), if valid { "PASS" } else { "FAIL" });
    if !valid {
        failures.push(format!("{label}: expected {}, got {answer:?}", expected.unwrap_or("apply")));
    }
}

async fn matrix_change(f: &Fixture, outside: bool, changed: &Value, ops: Vec<Value>) {
    if outside {
        f.write_outside(&changed.to_string());
    } else if !ops.is_empty() {
        f.ok(OTHER, "batch", json!({"ops":ops})).await;
    }
}

#[tokio::test]
async fn covered_text_content_distinguishes_change_from_relocation() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for (at, expected) in [(2, Some("relocated")), (7, Some("changed")), (15, None)] {
            let mut original = records();
            original["items"][0]["data"] = json!("0123456789ABCDEFGHIJ");
            let f = Fixture::new("mrange", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            let mut after = original.clone();
            let mut text = original["items"][0]["data"].as_str().unwrap().to_owned();
            if at == 7 {
                text.replace_range(at..at + 1, "q");
            } else {
                text.insert(at, '_');
            }
            after["items"][0]["data"] = json!(text);
            matrix_change(&f, outside, &after, vec![json!({"op":"set","target":"A","field":"data","value":text})]).await;
            let saved = f.read();
            let result =
                f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","range":[5,10],"value":"Agent"}}]})).await;
            matrix_result(&format!("covered-text/{outside}/{at}"), expected, result, f.read() == saved, &mut failures);
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn content_callbacks_receive_complete_basis_text_with_bounded_retention() {
    let mut failures = Vec::new();
    for length in [10, 81, 10_000, 1_048_577] {
        for covered in [false, true] {
            for outside in [false, true] {
                for related in [false, true] {
                    let mut original = records();
                    let text = "a".repeat(length);
                    original["items"][0]["data"] = json!(text);
                    let f = Fixture::new("mcontentbasis", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
                    let basis = f.revision(ME).await;
                    let mut text = text;
                    let at = if related { 3 } else { length - 1 };
                    text.replace_range(at..at + 1, "b");
                    let mut after = original;
                    after["items"][0]["data"] = json!(text);
                    matrix_change(&f, outside, &after, vec![json!({"op":"set","target":"A","field":"data","value":text})]).await;
                    let saved = f.read();
                    let mut params = json!({"item":"A","value":"Agent"});
                    params[if covered { "range" } else { "contentRegion" }] = json!([2, 5]);
                    let result = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":params}]})).await;
                    let expected = if length > 1_048_576 {
                        Some("unknown")
                    } else if related {
                        Some("changed")
                    } else {
                        None
                    };
                    matrix_result(&format!("content-basis/{length}/{covered}/{outside}/{related}"), expected, result, f.read() == saved, &mut failures);
                    f.shutdown().await;
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn on_demand_content_receives_complete_text_checkpoints_until_journal_eviction() {
    let mut failures = Vec::new();
    for length in [10, 81, 10_000] {
        for outside in [false, true] {
            for related in [false, true] {
                for evicted in [false, true] {
                    let mut original = records();
                    let text = "a".repeat(length);
                    original["items"][0]["data"] = json!(text);
                    let f = Fixture::with("mdemandtext", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_DEMAND_TEXT=1", &original.to_string(), |kits| {
                        kits.with_journal_limits(if evicted { 1 } else { 256 }, 20_000)
                    })
                    .expect("build mock");
                    let basis = f.revision(ME).await;
                    let mut text = text;
                    let at = if related { 3 } else { length - 1 };
                    text.replace_range(at..at + 1, "b");
                    let mut after = original;
                    after["items"][0]["data"] = json!(text);
                    matrix_change(&f, outside, &after, vec![json!({"op":"set","target":"A","field":"data","value":text})]).await;
                    let current = f.revision(OTHER).await;
                    f.ok(OTHER, "batch", json!({"basis":current,"ops":[{"op":"set","target":"B","field":"extra","value":9}]})).await;
                    let saved = f.read();
                    let result = f
                        .call(
                            ME,
                            "run",
                            json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","hold":["~textSlice"],"value":"Agent"}}]}),
                        )
                        .await;
                    let expected = if evicted {
                        Some("unknown")
                    } else if related {
                        Some("changed")
                    } else {
                        None
                    };
                    matrix_result(&format!("demand-text/{length}/{outside}/{related}/{evicted}"), expected, result, f.read() == saved, &mut failures);
                    f.shutdown().await;
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn outside_rename_refuses_on_the_tool_id_the_agent_observed() {
    for target in ["A", "B"] {
        let original = records();
        let f = Fixture::new("renamedtool", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
        let basis = f.revision(ME).await;
        let mut after = original;
        after["items"][0]["key"] = json!("G");
        f.write_outside(&after.to_string());
        let saved = f.read();
        let result =
            f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":target,"hold":["key","data"],"value":"Agent"}}]})).await;
        if target == "A" {
            let error = result.expect_err("the observed tool identity changed");
            assert_eq!(error["error"]["code"], "conflict", "{error}");
            assert_eq!(conflict(&error, "A")["reason"], "relocated", "{error}");
            assert_eq!(f.read(), saved);
        } else {
            assert!(result.is_ok(), "{result:?}");
        }
        f.shutdown().await;
    }
}

#[tokio::test]
async fn private_facts_stay_precise_after_outside_rereads() {
    for related in [false, true] {
        let mut original = records();
        original["other"] = json!([{"key":"X","name":"Frame","data":{"layer":"A"},"extra":0}]);
        let f = Fixture::new("privatefact", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_DERIVED=1", &original.to_string()).expect("build mock");
        let basis = f.revision(ME).await;
        let mut after = original;
        if related {
            after["other"][0]["data"]["layer"] = json!("B");
        } else {
            after["other"][0]["extra"] = json!(9);
        }
        f.write_outside(&after.to_string());
        let saved = f.read();
        let result =
            f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","hold":["~layerItems"],"value":"Agent"}}]})).await;
        let answer = if related {
            let error = result.expect_err("private fact changed");
            assert_eq!(conflict(&error, "A")["reason"], "changed", "{error}");
            assert_eq!(f.read(), saved);
            error
        } else {
            result.expect("unrelated outside edit applies")
        };
        assert!(!answer["others"].to_string().contains("~layerItems"), "{answer}");
        f.shutdown().await;
    }
}

#[tokio::test]
async fn real_text_marks_retain_inline_identity_and_formatting_history() {
    for formatting in [false, true] {
        for related in [false, true] {
            let mut original = records();
            original["items"][0]["data"] = json!([{"insert":"abcdefghij","attributes":{"object":"inline:1","bold":true}}]);
            original["items"][1]["data"] = json!([{"insert":"other"}]);
            original["inline"] = json!([{"key":"1","rotation":0}]);
            let f = Fixture::new("inlinemarks", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_MARKS=1", &original.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            f.write_outside(&original.to_string());
            let same = f.ok(ME, "inspect", json!({"basis":basis,"preview":false})).await;
            assert!(same.get("others").is_none_or(|others| others["changed"].as_array().is_none_or(Vec::is_empty)), "{same}");
            let basis = same["revision"].clone();
            let mut after = original;
            if formatting {
                let at = if related { 3 } else { 8 };
                let text = "abcdefghij";
                after["items"][0]["data"] = json!([
                    {"insert":text[..at],"attributes":{"object":"inline:1","bold":true}},
                    {"insert":text[at..at+1],"attributes":{"object":"inline:1","italic":true}},
                    {"insert":text[at+1..],"attributes":{"object":"inline:1","bold":true}}
                ]);
            } else {
                after["inline"][0]["rotation"] = json!(45);
            }
            f.write_outside(&after.to_string());
            if formatting {
                let saved = f.read();
                let result = f
                    .call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","contentRegion":[2,5],"value":"Agent"}}]}))
                    .await;
                if related {
                    let refused = result.expect_err("formatting inside the held range changed");
                    assert_eq!(conflict(&refused, "A")["reason"], "changed", "{refused}");
                    assert_eq!(f.read(), saved);
                } else {
                    assert!(result.is_ok(), "{result:?}");
                }
            } else {
                let answer = f.ok(ME, "inspect", json!({"basis":basis,"preview":false})).await;
                assert!(
                    answer["others"]["changed"].as_array().unwrap().iter().any(|item| item["id"] == "inline:1" && item["fields"] == json!(["rotation"])),
                    "{answer}"
                );
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn direct_content_callbacks_compare_long_text_formatting() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for related in [false, true] {
            let text = "a".repeat(10_000);
            let mut original = records();
            original["items"][0]["data"] = json!([{"insert":text,"attributes":{"bold":true}}]);
            let f = Fixture::new("mcontentmarks", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            let at = if related { 3 } else { 9000 };
            let value = json!([
                {"insert":text[..at],"attributes":{"bold":true}},
                {"insert":text[at..at+1],"attributes":{"italic":true}},
                {"insert":text[at+1..],"attributes":{"bold":true}}
            ]);
            let mut after = original;
            after["items"][0]["data"] = value.clone();
            matrix_change(&f, outside, &after, vec![json!({"op":"set","target":"A","field":"data","value":value})]).await;
            let saved = f.read();
            let result = f
                .call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","contentRegion":[2,5],"value":"Agent"}}]}))
                .await;
            matrix_result(&format!("content-marks/{outside}/{related}"), related.then_some("changed"), result, f.read() == saved, &mut failures);
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn content_callbacks_receive_basis_blob_bytes_with_bounded_retention() {
    use sha2::{Digest, Sha256};
    let file = |pixels: &[u8]| json!({"pixels":pixels,"hash":hex::encode(Sha256::digest(pixels)),"name":"Tile"});
    let mut failures = Vec::new();
    for limit in [4, 64] {
        for covered in [false, true] {
            for outside in [false, true] {
                for related in [false, true] {
                    let original = file(&[1, 0, 0, 0]);
                    let f = Fixture::with("mcontentblob", "KITION_KIT_MOCK_ORDER=raster KITION_KIT_MOCK_COVERED_CONTENT=1", &original.to_string(), |kits| {
                        kits.with_history_blob_limit(limit)
                    })
                    .expect("build mock");
                    let basis = f.revision(ME).await;
                    let after = file(if related { &[2, 0, 0, 0] } else { &[1, 0, 0, 1] });
                    if outside {
                        f.write_outside(&after.to_string());
                    } else {
                        f.ok(OTHER, "run", json!({"steps":[{"command":"raster.replace","params":{"pixels":after["pixels"],"hash":after["hash"]}}]})).await;
                    }
                    let saved = f.read();
                    let (command, params) = if covered {
                        ("raster.rename", json!({"pick":[0,0],"name":"Agent"}))
                    } else {
                        ("raster.regionRename", json!({"id":"surface","region":[0,0,1,1],"name":"Agent"}))
                    };
                    let result = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
                    let expected = if limit == 4 {
                        Some("unknown")
                    } else if related {
                        Some("changed")
                    } else {
                        None
                    };
                    matrix_result(&format!("content-blob/{limit}/{covered}/{outside}/{related}"), expected, result, f.read() == saved, &mut failures);
                    f.shutdown().await;
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn long_text_and_formatting_ranges_have_complete_guard_history() {
    let mut failures = Vec::new();
    let chars: Vec<char> = (0..10_000).map(|i| char::from_u32(0x1000 + i).unwrap()).collect();
    let text: String = chars.iter().collect();
    for outside in [false, true] {
        for format in [false, true] {
            for at in [1000, 3500, 9000] {
                let mut original = records();
                original["items"][0]["data"] = json!(text);
                let f = Fixture::new("mlongrange", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let value = if format {
                    json!([{"insert":chars[..at].iter().collect::<String>()},{"insert":chars[at..at+1].iter().collect::<String>(),"attributes":{"bold":true}},{"insert":chars[at+1..].iter().collect::<String>()}])
                } else {
                    let mut changed = chars.clone();
                    changed.insert(at, '_');
                    json!(changed.iter().collect::<String>())
                };
                let mut after = original.clone();
                after["items"][0]["data"] = value.clone();
                matrix_change(&f, outside, &after, vec![json!({"op":"set","target":"A","field":"data","value":value})]).await;
                let saved = f.read();
                let result = f
                    .call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","range":[3000,4000],"value":"Agent"}}]}))
                    .await;
                let expected = if !format && at < 3000 {
                    Some("relocated")
                } else if at == 3500 {
                    Some("changed")
                } else {
                    None
                };
                matrix_result(&format!("long-text/{outside}/{format}/{at}"), expected, result, f.read() == saved, &mut failures);
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn time_dimension_name_and_ordinal_windows_enforce_only_held_members() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for ordinal in [false, true] {
            for change in ["insert-before", "delete-after", "rename", "other-value"] {
                let original = records();
                let f = Fixture::new("mnameordinal", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_LOCAL=1", &original.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let mut after = original.clone();
                let ops = match change {
                    "insert-before" => {
                        let value = json!({"key":"N","name":"New","data":{},"extra":0});
                        after["items"].as_array_mut().unwrap().insert(0, value.clone());
                        vec![json!({"op":"create","type":"Item","in":"root.items","at":0,"fields":value})]
                    }
                    "delete-after" => {
                        after["items"].as_array_mut().unwrap().remove(1);
                        vec![json!({"op":"delete","target":"B"})]
                    }
                    "rename" => {
                        after["items"][0]["name"] = json!("Renamed");
                        vec![json!({"op":"set","target":"A","field":"name","value":"Renamed"})]
                    }
                    _ => {
                        after["items"][1]["name"] = json!("Other");
                        vec![json!({"op":"set","target":"B","field":"name","value":"Other"})]
                    }
                };
                matrix_change(&f, outside, &after, ops).await;
                let saved = f.read();
                let answer=f.call(ME,"run",json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":if ordinal {"#1"} else {"Alpha"},"hold":["name"],"write":"name"}}]})).await;
                let reason = match change {
                    "insert-before" => Some("relocated"),
                    "rename" => Some(if ordinal { "changed" } else { "relocated" }),
                    _ => None,
                };
                matrix_result(&format!("name-ordinal/{outside}/{ordinal}/{change}"), reason, answer, saved == f.read(), &mut failures);
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn time_dimension_automation_keeps_ordinal_and_time_windows_independent() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for change in ["trim-covered", "time-out", "other-append", "other-before", "delete-member", "value"] {
            let mut original = records();
            original["other"] = json!([{"key":"X","name":"Other","data":{},"extra":20}]);
            let f = Fixture::new("mmixedtime", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_JOIN=1 KITION_KIT_MOCK_MIXED_WINDOWS=1", &original.to_string())
                .expect("build mock");
            let basis = f.revision(ME).await;
            let mut after = original.clone();
            let ops = match change {
                "trim-covered" | "time-out" => {
                    let value = if change == "trim-covered" { json!(2.2) } else { json!(4) };
                    after["items"][1]["extra"] = value.clone();
                    vec![json!({"op":"set","target":"B","field":"extra","value":value})]
                }
                "other-append" | "other-before" => {
                    let at = usize::from(change == "other-append");
                    let value = json!({"key":"Y","name":"Other","data":{},"extra":30});
                    after["other"].as_array_mut().unwrap().insert(at, value.clone());
                    vec![json!({"op":"create","type":"Other","in":"root.other","at":at,"fields":value})]
                }
                "delete-member" => {
                    after["items"].as_array_mut().unwrap().remove(1);
                    vec![json!({"op":"delete","target":"B"})]
                }
                "value" => {
                    after["items"][1]["name"] = json!("Colleague");
                    vec![json!({"op":"set","target":"B","field":"name","value":"Colleague"})]
                }
                _ => unreachable!(),
            };
            matrix_change(&f, outside, &after, ops).await;
            let saved = f.read();
            let answer =
                f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","hold":["name"],"write":"name"}}]})).await;
            let reason = match change {
                "time-out" | "other-before" => Some("relocated"),
                "delete-member" => Some("deleted"),
                _ => None,
            };
            matrix_result(&format!("automation/{outside}/{change}"), reason, answer, saved == f.read(), &mut failures);
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn time_dimension_json_map_windows_hold_deleted_captions() {
    for outside in [false, true] {
        for change in ["delete", "replace", "value"] {
            let mut original = records();
            original["items"][0]["data"]["members"] =
                json!({"caption-1":{"id":"one","time":2,"end":3,"value":"Caption"},"caption-2":{"id":"two","time":8,"end":9,"value":"After"}});
            let f =
                Fixture::new("mcaptionmap", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_JSON_WINDOW=interval", &original.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            let mut after = original.clone();
            let members = after["items"][0]["data"]["members"].as_object_mut().unwrap();
            match change {
                "delete" => {
                    members.remove("caption-1");
                }
                "replace" => {
                    members.get_mut("caption-1").unwrap()["id"] = json!("replacement");
                }
                "value" => {
                    members.get_mut("caption-2").unwrap()["value"] = json!("Unrelated");
                }
                _ => unreachable!(),
            }
            matrix_change(&f, outside, &after, vec![json!({"op":"set","target":"A","field":"data","value":after["items"][0]["data"]})]).await;
            let saved = f.read();
            let result =
                f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","hold":["name"],"write":"name"}}]})).await;
            if change == "value" {
                result.unwrap_or_else(|error| panic!("{error}"));
            } else {
                let error = result.expect_err("historical caption membership changed");
                assert_eq!(error["conflicts"][0]["reason"], json!("relocated"), "{error}");
                assert_eq!(saved, f.read());
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn time_dimension_nested_selector_names_keep_identity_and_diagnostics() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for change in ["delete-before", "delete-after", "rename", "value", "replace", "delete-selected"] {
            let mut original = records();
            original["items"][0]["data"]["members"] = json!([
                {"uid":"a","meta":{"name":"Before"},"value":0},
                {"uid":"b","meta":{"name":"Selected"},"value":1},
                {"uid":"c","meta":{"name":"After"},"value":2}
            ]);
            let f = Fixture::new("mnestedselector", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            let mut after = original.clone();
            let list = after["items"][0]["data"]["members"].as_array_mut().unwrap();
            match change {
                "delete-before" => {
                    list.remove(0);
                }
                "delete-after" => {
                    list.remove(2);
                }
                "delete-selected" => {
                    list.remove(1);
                }
                "rename" => list[1]["meta"]["name"] = json!("Renamed"),
                "value" => list[1]["value"] = json!(5),
                "replace" => list[1]["uid"] = json!("replacement"),
                _ => unreachable!(),
            }
            matrix_change(&f, outside, &after, vec![json!({"op":"set","target":"A","field":"data","value":after["items"][0]["data"]})]).await;
            let saved = f.read();
            let selector = "data.members[meta.name=\"Selected\"]";
            let answer = f
                .call(
                    ME,
                    "run",
                    json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","hold":[selector],"identity":"uid","write":"name"}}]}),
                )
                .await;
            let reason = match change {
                "rename" | "replace" => Some("relocated"),
                "value" => Some("changed"),
                "delete-selected" => Some("deleted"),
                _ => None,
            };
            if let Err(error) = &answer {
                assert_eq!(error["conflicts"][0]["place"]["selector"], json!(selector), "{error}");
            }
            matrix_result(&format!("nested-selector/{outside}/{change}"), reason, answer, saved == f.read(), &mut failures);
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn time_dimension_raw_fields_indexes_and_marker_overwrites() {
    let mut failures = Vec::new();
    for independent in [false, true] {
        for outside in [false, true] {
            for operation in ["field", "remove-index", "markers", "delete"] {
                for change in ["insert-before", "append", "delete-target", "field", "markers"] {
                    let original = records();
                    let env = if independent { "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_BATCH_INDEPENDENT=1" } else { "KITION_KIT_MOCK_ORDER=matrix" };
                    let f = Fixture::new("mrawtime", env, &original.to_string()).expect("build mock");
                    let basis = f.revision(ME).await;
                    let mut after = original.clone();
                    let ops = match change {
                        "insert-before" | "append" => {
                            let at = if change == "append" { 2 } else { 0 };
                            let value = json!({"key":"N","name":"New","data":{},"extra":0});
                            after["items"].as_array_mut().unwrap().insert(at, value.clone());
                            vec![json!({"op":"create","type":"Item","in":"root.items","at":at,"fields":value})]
                        }
                        "delete-target" => {
                            after["items"].as_array_mut().unwrap().remove(1);
                            vec![json!({"op":"delete","target":"B"})]
                        }
                        "field" => {
                            after["items"][1]["name"] = json!("Colleague");
                            vec![json!({"op":"set","target":"B","field":"name","value":"Colleague"})]
                        }
                        "markers" => {
                            after["items"][1]["data"] = json!({"markers":[{"time":2,"text":"Colleague"}]});
                            vec![json!({"op":"set","target":"B","field":"data","value":after["items"][1]["data"]})]
                        }
                        _ => unreachable!(),
                    };
                    matrix_change(&f, outside, &after, ops).await;
                    let op = match operation {
                        "field" => json!({"op":"set","target":"B","field":"name","value":"Agent"}),
                        "markers" => json!({"op":"set","target":"B","field":"data","value":{"markers":[]}}),
                        "delete" => json!({"op":"delete","target":"B"}),
                        _ => json!({"op":"list.remove","target":"root","field":"items","index":1}),
                    };
                    let expected = if change == "delete-target" {
                        Some("deleted")
                    } else if (matches!(operation, "remove-index" | "delete") || !independent) && change == "insert-before" {
                        Some("relocated")
                    } else if operation == "field" && change == "field" || operation == "markers" && change == "markers" {
                        Some("changed")
                    } else {
                        None
                    };
                    let saved = f.read();
                    let answer = f.call(ME, "batch", json!({"basis":basis,"ops":[op]})).await;
                    matrix_result(&format!("raw-time/{independent}/{outside}/{operation}/{change}"), expected, answer, saved == f.read(), &mut failures);
                    f.shutdown().await;
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn time_dimension_json_windows_replay_deleted_endpoints_and_replacements() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for interval in [false, true] {
            for change in ["delete-in", "delete-after", "insert-in", "insert-after", "move-in", "move-out", "replace", "value"] {
                let mut original = records();
                original["items"][0]["data"]["members"] = json!([
                    {"id":"left","time":2,"end":3,"value":1},
                    {"id":"right","time":8,"end":9,"value":2}
                ]);
                let env = format!("KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_JSON_WINDOW={}", if interval { "interval" } else { "point" });
                let f = Fixture::new("mtimejson", &env, &original.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let mut after = original.clone();
                let members = after["items"][0]["data"]["members"].as_array_mut().unwrap();
                match change {
                    "delete-in" => {
                        members.remove(0);
                    }
                    "delete-after" => {
                        members.remove(1);
                    }
                    "insert-in" | "insert-after" => members.push(json!({"id":"new","time":if change=="insert-in" {3} else {10},"end":11,"value":0})),
                    "move-in" => members[1]["time"] = json!(3),
                    "move-out" => {
                        members[0]["time"] = json!(6);
                        members[0]["end"] = json!(7);
                    }
                    "replace" => members[0]["id"] = json!("replacement"),
                    "value" => members[0]["value"] = json!(10),
                    _ => unreachable!(),
                }
                let ops = vec![json!({"op":"set","target":"A","field":"data","value":after["items"][0]["data"]})];
                matrix_change(&f, outside, &after, ops).await;
                let saved = f.read();
                let answer =
                    f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","hold":["name"],"write":"name"}}]})).await;
                let expected = (!matches!(change, "delete-after" | "insert-after" | "value")).then_some("relocated");
                matrix_result(&format!("json-time/{outside}/{interval}/{change}"), expected, answer, saved == f.read(), &mut failures);
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn raw_batch_literal_strings_do_not_hold_objects_with_matching_ids() {
    let f = Fixture::new("mliteral", "KITION_KIT_MOCK_ORDER=matrix", &records().to_string()).expect("build mock");
    let basis = f.revision(ME).await;
    f.ok(OTHER, "batch", json!({"ops":[{"op":"set","target":"B","field":"name","value":"Colleague"}]})).await;
    let answer = f.call(ME, "batch", json!({"basis":basis,"ops":[{"op":"set","target":"A","field":"name","value":"B"}]})).await;
    assert!(answer.is_ok(), "a string value is not a reference: {answer:?}");
    assert_eq!(serde_json::from_str::<Value>(&f.read()).unwrap()["items"][0]["name"], json!("B"));
    f.shutdown().await;
}

#[tokio::test]
async fn single_index_and_local_integer_windows_ignore_unrelated_structure() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for local in [false, true] {
            for change in ["other-insert", "other-delete", "append", "delete-after", "insert-before"] {
                let mut original = records();
                original["other"] = json!([{"key":"X","name":"X","data":{},"extra":0}]);
                let f = Fixture::new("mlocal", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_LOCAL=1", &original.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let mut after = original.clone();
                let ops = if change.starts_with("other") {
                    if change == "other-insert" {
                        let item = json!({"key":"Y","name":"Y","data":{},"extra":0});
                        after["other"].as_array_mut().unwrap().push(item.clone());
                        vec![json!({"op":"create","type":"Other","fields":item,"in":"root.other","at":1})]
                    } else {
                        after["other"] = json!([]);
                        vec![json!({"op":"delete","target":"X"})]
                    }
                } else if change == "delete-after" {
                    after["items"].as_array_mut().unwrap().remove(1);
                    vec![json!({"op":"delete","target":"B"})]
                } else {
                    let at = if change == "append" { 2 } else { 0 };
                    let item = json!({"key":"N","name":"N","data":{},"extra":0});
                    after["items"].as_array_mut().unwrap().insert(at, item.clone());
                    vec![json!({"op":"create","type":"Item","fields":item,"in":"root.items","at":at})]
                };
                matrix_change(&f, outside, &after, ops).await;
                let saved = f.read();
                let answer = f
                    .call(
                        ME,
                        "run",
                        json!({"basis":basis,"steps":[{"command":"matrix.write","params":{
                            "item":if local {json!(1)} else {json!("A")},"hold":["name"],"write":"name"
                        }}]}),
                    )
                    .await;
                matrix_result(
                    &format!("local-window/{outside}/{local}/{change}"),
                    (change == "insert-before").then_some("relocated"),
                    answer,
                    saved == f.read(),
                    &mut failures,
                );
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn identical_assignments_compact_every_id_in_receipts_and_others() {
    let original =
        json!({"items":(0..200).map(|i|json!({"key":format!("R{i:03}"),"name":format!("Text {i}"),"data":{},"extra":i})).collect::<Vec<_>>(),"other":[]});
    let f = Fixture::new("massignments", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
    let basis = f.revision(ME).await;
    let ops = (0..200).map(|i| json!({"op":"set","target":format!("R{i:03}"),"field":"name","value":"Uniform"})).collect::<Vec<_>>();
    let receipt = f.ok(OTHER, "batch", json!({"ops":ops})).await;
    let observation = f.ok(ME, "inspect", json!({"basis":basis})).await;
    for changes in [&receipt["changes"], &observation["others"]] {
        assert!(changes.get("truncated").is_none(), "{changes}");
        assert_eq!(changes["changed"], json!([]), "{changes}");
        let footprint = changes["footprint"].as_array().expect("compacted assignments");
        assert_eq!(footprint.len(), 1);
        assert_eq!(footprint[0]["edits"], json!([{"field":"name","after":"Uniform"}]));
        let ids = footprint[0]["ids"].as_array().unwrap();
        assert_eq!(ids.len(), 200);
        assert_eq!(ids.iter().map(|id| id.as_str().unwrap()).collect::<std::collections::BTreeSet<_>>().len(), 200);
        assert!(changes.to_string().len() < 3000, "{}", changes.to_string().len());
    }
    f.shutdown().await;
}

#[tokio::test]
async fn external_inputs_require_observed_available_equal_fingerprints() {
    for state in ["equal", "changed", "missing", "unobserved"] {
        for declared in [false, true] {
            for batch in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let library = dir.path().join("library");
                let registered = dir.path().join("library.registered");
                std::fs::write(&library, "alpha").unwrap();
                if state != "unobserved" {
                    std::fs::write(&registered, "").unwrap();
                }
                let env = format!("KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_BATCH=commands KITION_KIT_MOCK_INPUT='{}'", library.display());
                let f = Fixture::new("minputs", &env, &records().to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                match state {
                    "changed" => std::fs::write(&library, "beta").unwrap(),
                    "missing" => std::fs::remove_file(&library).unwrap(),
                    "unobserved" => std::fs::write(&registered, "").unwrap(),
                    _ => {}
                }
                let params = json!({"item":"A","hold":[],"inputs":if declared {vec!["library"]} else {vec![]}});
                let (action, input) = if batch {
                    ("batch", json!({"basis":basis,"ops":[{"op":"command","id":"matrix.write","params":params}]}))
                } else {
                    ("run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":params}]}))
                };
                let saved = f.read();
                let answer = f.call(ME, action, input).await;
                let expected = if !declared || state == "equal" { None } else { Some(if state == "changed" { "changed" } else { "unknown" }) };
                let mut failures = Vec::new();
                matrix_result(&format!("inputs/{state}/{declared}/{batch}"), expected, answer, saved == f.read(), &mut failures);
                assert!(failures.is_empty(), "{}", failures.join("\n"));
                f.shutdown().await;
            }
        }
    }
}

#[tokio::test]
async fn unprovable_identity_survives_model_equal_outside_rereads() {
    for unproven in [false, true] {
        let env = format!("KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_UNPROVEN={}", if unproven { "A" } else { "" });
        let f = Fixture::new("midentityequal", &env, &records().to_string()).expect("build mock");
        let basis = f.revision(ME).await;
        f.write_outside(&serde_json::to_string_pretty(&records()).unwrap());
        let saved = f.read();
        let answer = f.call(ME, "batch", json!({"basis":basis,"ops":[{"op":"set","target":"A","field":"name","value":"Agent"}]})).await;
        if unproven {
            let error = answer.expect_err("equal values cannot prove identity");
            assert_eq!(error["conflicts"][0]["reason"], json!("unknown"), "{error}");
            assert_eq!(f.read(), saved);
            let current = f.revision(ME).await;
            f.ok(ME, "batch", json!({"basis":current,"ops":[{"op":"set","target":"A","field":"name","value":"Agent"}]})).await;
        } else {
            answer.unwrap();
        }
        f.shutdown().await;
    }
}

#[tokio::test]
async fn unprovable_identity_refuses_only_after_outside_rereads() {
    for outside in [false, true] {
        for unproven in [false, true] {
            for address in ["id", "name", "batch"] {
                let env = format!("KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_UNPROVEN={}", if unproven { "A" } else { "" });
                let f = Fixture::new("midentity", &env, &records().to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let mut after = records();
                after["items"].as_array_mut().unwrap().swap(0, 1);
                matrix_change(&f, outside, &after, vec![json!({"op":"list.move","target":"root","field":"items","from":0,"to":2})]).await;
                let (action, mut input) = if address == "batch" {
                    ("batch", json!({"ops":[{"op":"set","target":"A","field":"extra","value":"Agent"}]}))
                } else {
                    ("run", json!({"steps":[{"command":"matrix.write","params":{"item":if address=="name" {"Alpha"} else {"A"},"hold":[],"write":"extra"}}]}))
                };
                // A batch holds its list position; use an unrelated outside field edit instead.
                if address == "batch" {
                    let fresh = f.revision(ME).await;
                    input["basis"] = json!(fresh);
                    let mut after = after.clone();
                    after["items"][0]["extra"] = json!(77);
                    matrix_change(&f, outside, &after, vec![json!({"op":"set","target":"B","field":"extra","value":77})]).await;
                } else {
                    input["basis"] = json!(basis);
                }
                let saved = f.read();
                let answer = f.call(ME, action, input.clone()).await;
                if outside && unproven {
                    let error = answer.expect_err("identity cannot be proved");
                    assert_eq!(error["error"]["code"], "conflict", "{error}");
                    assert!(error["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "unknown"), "{error}");
                    assert_eq!(f.read(), saved);
                    let retry = f.call(ME, action, input.clone()).await;
                    assert!(retry.is_err(), "stale retry must stay refused");
                    input["basis"] = json!(f.revision(ME).await);
                    f.ok(ME, action, input).await;
                } else {
                    answer.unwrap_or_else(|error| panic!("{outside}/{unproven}/{address}: {error}"));
                }
                f.shutdown().await;
            }
        }
    }
}

#[tokio::test]
async fn repeated_premises_join_in_every_order_within_calls_and_runs() {
    let holds = [
        json!({"fields":["name"],"positions":[]}),
        json!({"fields":["data.members[name=\"Alpha\"].value"],"positions":[]}),
        json!({"fields":[],"positions":["extra"]}),
        json!({}),
    ];
    let mut orders = Vec::new();
    for a in 0..3 {
        for b in 0..3 {
            if a == b {
                continue;
            }
            orders.push(vec![a, b]);
            for c in 0..3 {
                if c != a && c != b {
                    orders.push(vec![a, b, c]);
                }
            }
        }
    }
    orders.extend([vec![3, 0], vec![0, 3]]);
    let mut failures = Vec::new();
    for outside in [false, true] {
        for steps in [false, true] {
            for order in &orders {
                for changed in order.iter().copied().filter(|i| *i != 3) {
                    let original = records();
                    let f = Fixture::new("mjoin", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_JOIN=1", &original.to_string()).expect("build mock");
                    let basis = f.revision(ME).await;
                    let mut after = original.clone();
                    let (field, value, reason) = match changed {
                        0 => {
                            after["items"][0]["name"] = json!("Colleague");
                            ("name", json!("Colleague"), "changed")
                        }
                        1 => {
                            after["items"][0]["data"]["members"][0]["value"] = json!(9);
                            ("data", after["items"][0]["data"].clone(), "changed")
                        }
                        _ => {
                            after["items"][0]["extra"] = json!(9);
                            ("extra", json!(9), "relocated")
                        }
                    };
                    matrix_change(&f, outside, &after, vec![json!({"op":"set","target":"A","field":field,"value":value})]).await;
                    let commands = if steps {
                        order.iter().map(|i| json!({"command":"matrix.write","params":{"item":"A","holds":[holds[*i].clone()]}})).collect::<Vec<_>>()
                    } else {
                        vec![json!({"command":"matrix.write","params":{"item":"A","holds":order.iter().map(|i|holds[*i].clone()).collect::<Vec<_>>()}})]
                    };
                    let saved = f.read();
                    let answer = f.call(ME, "run", json!({"basis":basis,"steps":commands})).await;
                    matrix_result(&format!("join/{outside}/{steps}/{order:?}/{changed}"), Some(reason), answer, saved == f.read(), &mut failures);
                    f.shutdown().await;
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn list_windows_hold_membership_including_historical_and_point_ordering() {
    let record = |key: &str, time: i32| json!({"key":key,"name":key,"data":{},"extra":time});
    let original = json!({"items":[record("A",0),record("B",2),record("C",4),record("D",8)],"other":[record("X",3)]});
    let mut failures = Vec::new();
    for held in [false, true] {
        for time in [false, true] {
            for outside in [false, true] {
                for change in ["insert", "delete", "move-in", "move-out", "after", "field", "time-in", "time-out", "transient"] {
                    if outside && change == "transient" {
                        continue;
                    }
                    let env = format!("KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_WINDOWS={}", if time { "time" } else { "ordinal" });
                    let f = Fixture::new("mwindows", &env, &original.to_string()).expect("build mock");
                    let basis = f.revision(ME).await;
                    let mut after = original.clone();
                    let mut ops = Vec::new();
                    match change {
                        "insert" | "after" | "transient" => {
                            let at = if change == "after" { 4 } else { 2 };
                            let item = record("N", if change == "after" { 9 } else { 3 });
                            after["items"].as_array_mut().unwrap().insert(at, item.clone());
                            ops.push(json!({"op":"create","type":"Item","fields":item,"in":"root.items","at":at}));
                        }
                        "delete" => {
                            after["items"].as_array_mut().unwrap().remove(1);
                            ops.push(json!({"op":"delete","target":"B"}));
                        }
                        "move-in" => {
                            let item = after["other"].as_array_mut().unwrap().remove(0);
                            after["items"].as_array_mut().unwrap().insert(2, item);
                            ops.extend([
                                json!({"op":"list.remove","target":"root","field":"other","index":0}),
                                json!({"op":"list.insert","target":"root","field":"items","index":2,"item":"X"}),
                            ]);
                        }
                        "move-out" => {
                            let item = after["items"].as_array_mut().unwrap().remove(1);
                            after["other"].as_array_mut().unwrap().push(item);
                            ops.extend([
                                json!({"op":"list.remove","target":"root","field":"items","index":1}),
                                json!({"op":"list.insert","target":"root","field":"other","index":1,"item":"B"}),
                            ]);
                        }
                        "field" => {
                            after["items"][2]["name"] = json!("Other");
                            ops.push(json!({"op":"set","target":"C","field":"name","value":"Other"}));
                        }
                        "time-in" | "time-out" => {
                            let (at, id, value) = if change == "time-in" { (3, "D", 3) } else { (1, "B", 8) };
                            after["items"][at]["extra"] = json!(value);
                            ops.push(json!({"op":"set","target":id,"field":"extra","value":value}));
                        }
                        _ => unreachable!(),
                    }
                    matrix_change(&f, outside, &after, ops).await;
                    if change == "transient" {
                        f.ok(OTHER, "batch", json!({"ops":[{"op":"delete","target":"N"}]})).await;
                    }
                    let expected = match change {
                        "after" | "field" => None,
                        "time-in" if !time => None,
                        "delete" => Some("deleted"),
                        _ => Some("relocated"),
                    };
                    let before = f.read();
                    let mut params = json!({"item":"A","hold":["name"],"write":"name","value":"Agent"});
                    if !held {
                        params["window"] = json!(true);
                    }
                    let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":params}]})).await;
                    matrix_result(&format!("window/{held}/{time}/{outside}/{change}"), expected, answer, f.read() == before, &mut failures);
                    f.shutdown().await;
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn historical_blob_chunks_survive_boundary_reads() {
    use sha2::{Digest, Sha256};
    const CHUNK: usize = 1024 * 1024;
    let file = |pixels: &[u8]| json!({"pixels":pixels,"hash":hex::encode(Sha256::digest(pixels)),"name":"Tile"}).to_string();
    for changed in [false, true] {
        let mut pixels = vec![0_u8; CHUNK + 9];
        pixels[CHUNK - 1] = 1;
        pixels[CHUNK] = 1;
        let f = Fixture::new("mchunks", "KITION_KIT_MOCK_ORDER=raster", &file(&pixels)).expect("build mock");
        let basis = f.revision(ME).await;
        pixels[CHUNK + 8] = 1;
        if changed {
            pixels[CHUNK] = 0;
        }
        f.write_outside(&file(&pixels));
        for at in [CHUNK - 1, CHUNK] {
            let before = f.read();
            let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"raster.rename","params":{"pick":[at,0],"name":"Agent"}}]})).await;
            if changed && at == CHUNK {
                let refused = answer.expect_err("removed boundary pixel");
                assert!(refused["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "relocated"), "{refused}");
                assert_eq!(f.read(), before);
            } else {
                assert!(answer.is_ok(), "boundary {at}: {answer:?}");
            }
        }
        f.shutdown().await;
    }
}

#[tokio::test]
async fn historical_blobs_refuse_corrupt_sources_and_define_restart_lifetime() {
    use sha2::{Digest, Sha256};
    let file = |pixels: &[u8]| json!({"pixels":pixels,"hash":hex::encode(Sha256::digest(pixels)),"name":"Tile"}).to_string();
    for mode in ["corrupt", "close", "worker", "manager"] {
        let env = format!("KITION_KIT_MOCK_ORDER=raster {}", if mode == "corrupt" { "KITION_KIT_MOCK_CORRUPT_BLOB=1" } else { "" });
        let mut f = Fixture::new("mlifetime", &env, &file(&[1, 0, 0, 0])).expect("build mock");
        let basis = f.revision(ME).await;
        if mode == "close" {
            f.native.close_file(&f.path()).await;
        }
        if mode == "worker" || mode == "manager" {
            f.native.shutdown().await;
        }
        if mode == "manager" {
            f.kits.shutdown().await;
            let mock = mock_binary().unwrap();
            let script = as_kit(f._bin.path(), &mock, &f.name, &env);
            f.kits = KitManager::new(Some(f.workspace.path().to_path_buf()), vec![(kit(&f.name), Some(script.clone()))]);
            f.native = editor::attach(&f.kits, f.workspace.path(), kit(&f.name), &script, &f.path());
        }
        f.write_outside(&file(&[1, 0, 0, 1]));
        let before = f.read();
        let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"raster.rename","params":{"pick":[0,0],"name":"Agent"}}]})).await;
        if mode == "corrupt" || mode == "manager" {
            let refused = answer.expect_err("unavailable history");
            assert!(refused["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "unknown"), "{mode}: {refused}");
            assert_eq!(f.read(), before);
        } else {
            assert!(answer.is_ok(), "{mode}: {answer:?}");
        }
        f.shutdown().await;
    }
}

#[tokio::test]
async fn historical_tile_bytes_answer_a_pick_after_outside_replacement() {
    use sha2::{Digest, Sha256};
    let file = |pixels: &[u8]| json!({"pixels":pixels,"hash":hex::encode(Sha256::digest(pixels)),"name":"Tile"});
    let original = file(&[1, 0, 0, 0]);
    let f = Fixture::new("mhist", "KITION_KIT_MOCK_ORDER=raster", &original.to_string()).expect("build mock");
    f.ok(ME, "batch", json!({"ops":[],"load":[{"target":"root"}]})).await;
    let basis = f.revision(ME).await;
    f.write_outside(&file(&[1, 0, 0, 1]).to_string());
    f.ok(ME, "run", json!({"basis":basis,"steps":[{"command":"raster.rename","params":{"pick":[0,0],"name":"Agent"}}]})).await;
    f.shutdown().await;
}

#[tokio::test]
async fn historical_tile_bytes_refuse_changed_pixels_and_evicted_bytes() {
    use sha2::{Digest, Sha256};
    let file = |pixels: &[u8]| json!({"pixels":pixels,"hash":hex::encode(Sha256::digest(pixels)),"name":"Tile"});
    for (limit, pixels, reason) in [(64, vec![0, 0, 0, 1], "relocated"), (4, vec![1, 0, 0, 1], "unknown"), (0, vec![1, 0, 0, 1], "unknown")] {
        let f = Fixture::with("mhistevict", "KITION_KIT_MOCK_ORDER=raster", &file(&[1, 0, 0, 0]).to_string(), |kits| kits.with_history_blob_limit(limit))
            .expect("build mock");
        let basis = f.revision(ME).await;
        f.write_outside(&file(&pixels).to_string());
        let refused = f.refused(ME, "run", json!({"basis":basis,"steps":[{"command":"raster.rename","params":{"pick":[0,0],"name":"Agent"}}]})).await;
        assert!(refused["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == reason), "limit={limit}: {refused}");
        assert_eq!(serde_json::from_str::<Value>(&f.read()).unwrap()["name"], "Tile");
        f.shutdown().await;
    }
}

#[tokio::test]
async fn region_content_distinguishes_edits_inside_and_elsewhere_in_one_tile() {
    use sha2::{Digest, Sha256};
    let file = |pixels: &[u8]| json!({"pixels":pixels,"hash":hex::encode(Sha256::digest(pixels)),"name":"Tile"});
    for outside in [false, true] {
        for (limit, pixels, reason) in [(64, vec![1, 0, 0, 1], None), (64, vec![0, 0, 0, 0], Some("changed")), (4, vec![1, 0, 0, 1], Some("unknown"))] {
            let f = Fixture::with("mregion", "KITION_KIT_MOCK_ORDER=raster", &file(&[1, 0, 0, 0]).to_string(), |kits| kits.with_history_blob_limit(limit))
                .expect("build mock");
            let basis = f.revision(ME).await;
            if outside {
                f.write_outside(&file(&pixels).to_string());
            } else {
                f.ok(OTHER, "run", json!({"steps":[{"command":"raster.replace","params":{"pixels":pixels,"hash":file(&pixels)["hash"]}}]})).await;
            }
            let answer = f
                .call(ME, "run", json!({"basis":basis,"steps":[{"command":"raster.regionRename","params":{"id":"surface","region":[0,0,1,1],"name":"Agent"}}]}))
                .await;
            match reason {
                None => assert!(answer.is_ok(), "elsewhere: {answer:?}"),
                Some(reason) => {
                    let refused = answer.expect_err("content changed/unavailable must refuse");
                    assert!(refused["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == reason), "{refused}");
                    assert_eq!(serde_json::from_str::<Value>(&f.read()).unwrap()["name"], "Tile");
                }
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn map_owned_records_are_complete_in_outside_rereads() {
    let mut original = records();
    original["catalog"] = json!({"standard":{"key":"style:Standard","name":"Standard","data":{},"extra":1},"wrapped":{"key":"style:Wrapped","name":"Wrapped","data":{},"extra":1}});
    for change in ["unchanged", "create", "change", "delete"] {
        let f = Fixture::new("mmap", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_MAPS=1", &original.to_string()).expect("build mock");
        let basis = f.revision(ME).await;
        let mut after = original.clone();
        match change {
            "create" => after["catalog"]["new"] = json!({"key":"style:New","name":"New","data":{},"extra":1}),
            "change" => after["catalog"]["wrapped"]["extra"] = json!(2),
            "delete" => {
                after["catalog"].as_object_mut().unwrap().remove("wrapped");
            }
            _ => {}
        }
        f.write_outside(&after.to_string());
        let answer = f.ok(ME, "inspect", json!({"basis":basis})).await;
        let expected = match change {
            "create" => Some(("created", "style:New")),
            "change" => Some(("changed", "style:Wrapped")),
            "delete" => Some(("deleted", "style:Wrapped")),
            _ => None,
        };
        if let Some((list, id)) = expected {
            assert!(answer["others"][list].as_array().is_some_and(|items| items.iter().any(|item| item["id"] == id)), "{change}: {answer}");
        } else {
            assert!(answer.get("others").is_none(), "{answer}");
        }
        // Structural map membership may change; reminted ids alone must not change it.
        if matches!(change, "unchanged" | "change") {
            assert!(
                !answer["others"]["changed"].as_array().is_some_and(|items| items.iter().any(|item| item["id"] == "matrix-root")),
                "map id normalization: {answer}"
            );
        }
        f.shutdown().await;
    }
}

#[tokio::test]
async fn remaining_id_field_matrix() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for hold in [None, Some("data.branch.leaf"), Some("extra"), Some("data.branch"), Some("data.branch.leaf.n"), Some("data.branch.sibling")] {
            for change in ["same", "other", "above", "below", "beside", "delete", "recreate", "type"] {
                let original = records();
                let f = Fixture::new("mid", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let mut changed = original.clone();
                let path = match change {
                    "other" => "extra",
                    "above" => "data.branch",
                    "below" => "data.branch.leaf.n",
                    "beside" => "data.branch.sibling",
                    _ => "data.branch.leaf",
                };
                let mut ops = Vec::new();
                let mut reason = if matches!(change, "delete" | "recreate" | "type") { Some("deleted") } else { None };
                if matches!(change, "delete" | "recreate" | "type") {
                    let mut removed = changed["items"].as_array_mut().unwrap().remove(0);
                    ops.push(json!({"op":"delete","target":"A"}));
                    if change != "delete" {
                        if change == "recreate" {
                            removed["key"] = json!("X");
                        }
                        let (field, ty) = if change == "type" { ("other", "Other") } else { ("items", "Item") };
                        changed[field].as_array_mut().unwrap().push(removed.clone());
                        ops.push(json!({"op":"create","type":ty,"in":format!("root.{field}"),"fields":removed}));
                    }
                } else {
                    let value = if change == "same" { json!({"n":9}) } else { json!(9) };
                    let mut at = &mut changed["items"][0];
                    for segment in path.split('.') {
                        at = &mut at[segment];
                    }
                    *at = value.clone();
                    ops.push(json!({"op":"set","target":"A","field":path,"value":value}));
                    let overlap = |a: &str, b: &str| {
                        a == b || a.strip_prefix(b).is_some_and(|s| s.starts_with('.')) || b.strip_prefix(a).is_some_and(|s| s.starts_with('.'))
                    };
                    if hold.is_none_or(|h| overlap(h, path)) {
                        reason = Some("changed");
                    }
                }
                // A persistent id reused with a different type cannot establish continuity.
                if outside && change == "type" {
                    reason = Some("unknown");
                }
                matrix_change(&f, outside, &changed, ops).await;
                let saved = f.read();
                let answer=f.call(ME,"run",json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","hold":hold.map(|h|vec![h]),"write":"data.branch.leaf","value":{"n":10}}}]})).await;
                matrix_result(&format!("id/{outside}/{hold:?}/{change}"), reason, answer, f.read() == saved, &mut failures);
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn remaining_type_replacement_receipt() {
    let original = records();
    let f = Fixture::new("mtype", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
    let basis = f.revision(ME).await;
    let receipt = f
        .ok(OTHER, "batch", json!({"ops":[{"op":"delete","target":"A"},{"op":"create","type":"Other","in":"root.other","fields":original["items"][0]}]}))
        .await;
    assert!(receipt["changes"]["deleted"].as_array().unwrap().iter().any(|v| v["id"] == "A"), "{receipt}");
    let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A"}}]})).await;
    assert!(answer.is_err(), "{answer:?}");
    f.shutdown().await;
}

#[tokio::test]
async fn remaining_name_matrix() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for command in ["matrix.write", "matrix.typed", "matrix.param", "matrix.paramTyped"] {
            for change in ["away", "to", "swap", "identical-swap", "delete", "recreate", "duplicate"] {
                let mut original = records();
                if change == "identical-swap" {
                    let data = original["items"][0]["data"].clone();
                    original["items"][1]["data"] = data;
                    original["items"][1]["extra"] = json!(1);
                }
                let f = Fixture::new("mname", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let mut changed = original.clone();
                let mut ops = Vec::new();
                if matches!(change, "away" | "swap" | "identical-swap") {
                    changed["items"][0]["name"] = json!("Beta");
                    ops.push(json!({"op":"set","target":"A","field":"name","value":"Beta"}));
                }
                if matches!(change, "to" | "swap" | "identical-swap") {
                    changed["items"][1]["name"] = json!("Alpha");
                    ops.push(json!({"op":"set","target":"B","field":"name","value":"Alpha"}));
                }
                if change == "duplicate" {
                    let mut duplicate = original["items"][0].clone();
                    duplicate["key"] = json!("X");
                    changed["items"].as_array_mut().unwrap().push(duplicate.clone());
                    ops.push(json!({"op":"create","type":"Item","in":"root.items","fields":duplicate}));
                }
                if matches!(change, "delete" | "recreate") {
                    let mut removed = changed["items"].as_array_mut().unwrap().remove(0);
                    ops.push(json!({"op":"delete","target":"A"}));
                    if change == "recreate" {
                        removed["key"] = json!("X");
                        changed["items"].as_array_mut().unwrap().push(removed.clone());
                        ops.push(json!({"op":"create","type":"Item","in":"root.items","fields":removed}));
                    }
                }
                matrix_change(&f, outside, &changed, ops).await;
                let saved = f.read();
                let param = if command.contains("param") { "resource" } else { "item" };
                let answer =
                    f.call(ME, "run", json!({"basis":basis,"steps":[{"command":command,"params":{(param):"Alpha","typed":command.contains("yped")}}]})).await;
                matrix_result(
                    &format!("name/{outside}/{command}/{change}"),
                    Some(if matches!(change, "delete" | "recreate") { "deleted" } else { "relocated" }),
                    answer,
                    f.read() == saved,
                    &mut failures,
                );
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn forced_close_finishes_without_a_document_view_or_save() {
    let f = Fixture::new("closing", "KITION_KIT_MOCK_CLOSE=1", "Original").expect("build mock");
    let basis = f.revision(ME).await;
    f.write_outside("Outside");
    let answer =
        f.call(ME, "run", json!({"basis":basis,"preview":true,"steps":[{"command":"file.close","params":{"force":true}}]})).await.expect("close completed");
    assert_eq!(answer["completed"][0]["result"]["closed"], true, "{answer}");
    assert_eq!(answer["closed"], true, "{answer}");
    assert_eq!(answer["saved"], false, "{answer}");
    assert!(answer.get("document").is_none(), "{answer}");
    assert_eq!(f.read(), "Outside");
    f.shutdown().await;
}

#[tokio::test]
async fn typed_owning_maps_work_in_mock_loads_and_refuse_wrong_types() {
    let mut file = records();
    file["other"] = json!([{"key":"C","name":"Other type","data":{},"extra":0}]);
    let f = Fixture::new("typedmap", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_MAPS=1 KITION_KIT_MOCK_TYPED_MAP=1", &file.to_string()).expect("build mock");
    let basis = f.revision(ME).await;
    let answer = f.call(ME, "batch", json!({"basis":basis,"ops":[{"op":"map.set","target":"root","field":"catalog","key":"chosen","value":"A"}],"load":[{"target":"root","fields":["catalog"]}]})).await.expect("typed map accepted");
    assert_eq!(answer["loaded"][0]["fields"]["catalog"]["chosen"], "A", "{answer}");
    let basis = answer["revision"].clone();
    let saved = f.read();
    let error = f.refused(ME, "batch", json!({"basis":basis,"ops":[{"op":"map.set","target":"root","field":"catalog","key":"wrong","value":"C"}]})).await;
    assert_eq!(error["error"]["code"], "invalid-value", "{error}");
    assert_eq!(f.read(), saved);
    f.shutdown().await;
}

#[tokio::test]
async fn literal_json_paths_do_not_parse_selector_shaped_keys() {
    for outside in [false, true] {
        for changed_key in ["flag[id=7]", "other"] {
            let mut original = records();
            original["items"][0]["data"] = json!({"flag[id=7]":1,"other":1});
            let f = Fixture::new("literalpaths", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            original["items"][0]["data"][changed_key] = json!(2);
            matrix_change(&f, outside, &original, vec![json!({"op":"set","target":"A","field":"data","value":original["items"][0]["data"]})]).await;
            let saved = f.read();
            let result = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","hold":["/data/flag[id=7]"]}}]})).await;
            if changed_key == "other" {
                assert!(result.is_ok(), "{outside}/{changed_key}: {result:?}");
            } else {
                assert_eq!(conflict(&result.expect_err("literal member changed"), "A")["reason"], "changed");
                assert_eq!(f.read(), saved);
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn json_resource_addresses_report_identity_reasons() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for address in ["key", "name", "index"] {
            for change in ["edited", "renamed", "removed", "swapped", "inserted", "other"] {
                let original = records();
                let f = Fixture::new("jsonidentity", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let mut changed = original;
                let list = changed["items"][0]["data"]["members"].as_array_mut().unwrap();
                match change {
                    "edited" => list[0]["value"] = json!(9),
                    "renamed" => list[0]["name"] = json!("Away"),
                    "removed" => {
                        list.remove(0);
                    }
                    "swapped" => list.swap(0, 1),
                    "inserted" => list.insert(0, json!({"key":"c","name":"New","value":3})),
                    _ => list[1]["value"] = json!(9),
                }
                matrix_change(&f, outside, &changed, vec![json!({"op":"set","target":"A","field":"data","value":changed["items"][0]["data"]})]).await;
                let path = match address {
                    "key" => "data.members[key=a].value",
                    "name" => "data.members[name=Alpha].value",
                    _ => "data.members.0.value",
                };
                let saved = f.read();
                let answer =
                    f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","hold":[path],"identity":"key"}}]})).await;
                let reason = match (address, change) {
                    ("index", "removed" | "swapped" | "inserted") | ("name", "renamed") => Some("relocated"),
                    (_, "removed") => Some("deleted"),
                    (_, "edited") => Some("changed"),
                    _ => None,
                };
                matrix_result(&format!("json-resource/{outside}/{address}/{change}"), reason, answer, f.read() == saved, &mut failures);
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn outside_identity_pairing_reports_relocated() {
    let mut original = records();
    let f = Fixture::new("renameidentity", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
    let basis = f.revision(ME).await;
    original["items"][0]["key"] = json!("G");
    f.write_outside(&original.to_string());
    let saved = f.read();
    let error = f.refused(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","hold":["data"]}}]})).await;
    assert_eq!(conflict(&error, "A")["reason"], "relocated", "{error}");
    assert_eq!(conflict(&error, "A")["now"]["id"], "G", "{error}");
    assert_eq!(f.read(), saved);
    f.shutdown().await;
}

#[tokio::test]
async fn remaining_selector_matrix() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for identity in [false, true] {
            for quoted in [false, true] {
                for change in ["edited", "renamed", "removed", "reordered", "second", "other"] {
                    let mut original = records();
                    let name = if quoted { "A\"[x]=]" } else { "Alpha" };
                    original["items"][0]["data"]["members"][0]["name"] = json!(name);
                    let f = Fixture::new("msel", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
                    let basis = f.revision(ME).await;
                    let mut changed = original.clone();
                    let list = changed["items"][0]["data"]["members"].as_array_mut().unwrap();
                    match change {
                        "edited" => list[0]["value"] = json!(9),
                        "renamed" => list[0]["name"] = json!("Away"),
                        "removed" => {
                            list.remove(0);
                        }
                        "reordered" => list.swap(0, 1),
                        "second" => list.push(json!({"key":"c","name":name,"value":3})),
                        _ => list[1]["value"] = json!(9),
                    }
                    matrix_change(&f, outside, &changed, vec![json!({"op":"set","target":"A","field":"data","value":changed["items"][0]["data"]})]).await;
                    let selector = format!("data.members[name={}]", serde_json::to_string(name).unwrap());
                    let mut params = json!({"item":"A","hold":[selector]});
                    if identity {
                        params["identity"] = json!("key");
                    }
                    let saved = f.read();
                    let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":params}]})).await;
                    let reason = match change {
                        "reordered" | "other" => None,
                        "removed" if identity => Some("deleted"),
                        "renamed" if identity => Some("relocated"),
                        "second" if identity => Some("unknown"),
                        _ => Some("changed"),
                    };
                    matrix_result(&format!("selector/{outside}/{identity}/{quoted}/{change}"), reason, answer, f.read() == saved, &mut failures);
                    f.shutdown().await;
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn implicit_editor_reads_without_state_hooks_refuse_unknown() {
    let f = Fixture::new("mstateunknown", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_CONTEXT=none", &records().to_string()).expect("build mock");
    let basis = f.revision(ME).await;
    let refused = f.refused(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.mode","params":{"item":"A","hold":[]}}]})).await;
    assert!(refused["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "unknown"), "{refused}");
    f.shutdown().await;
}

#[tokio::test]
async fn remaining_modes_matrix() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for premise in ["id", "name", "selector", "state"] {
            for mode in [Guard::Premise, Guard::Epoch, Guard::Off] {
                let dir = tempfile::tempdir().unwrap();
                let file = dir.path().join("state.json");
                std::fs::write(&file, r#"{"mode":1}"#).unwrap();
                let env = format!("KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_EDITOR_FILE='{}'", file.display());
                let original = records();
                let mut f = Fixture::new("mmodes", &env, &original.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let mut changed = original.clone();
                let (ops, params, command, reason) = match premise {
                    "name" => {
                        changed["items"][0]["name"] = json!("Away");
                        (vec![json!({"op":"set","target":"A","field":"name","value":"Away"})], json!({"item":"Alpha","hold":[]}), "matrix.write", "relocated")
                    }
                    "selector" => {
                        changed["items"][0]["data"]["members"][0]["value"] = json!(9);
                        (
                            vec![json!({"op":"set","target":"A","field":"data.members.0.value","value":9})],
                            json!({"item":"A","hold":["data.members[key=a]"]}),
                            "matrix.write",
                            "changed",
                        )
                    }
                    "state" => {
                        std::fs::write(&file, r#"{"mode":2}"#).unwrap();
                        (vec![], json!({"item":"A","hold":[]}), "matrix.mode", "changed")
                    }
                    _ => {
                        changed["items"][0]["extra"] = json!(9);
                        (vec![json!({"op":"set","target":"A","field":"extra","value":9})], json!({"item":"A","hold":["extra"]}), "matrix.write", "changed")
                    }
                };
                matrix_change(&f, outside, &changed, ops).await;
                f.options.guard = mode;
                let saved = f.read();
                let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":command,"params":params}]})).await;
                let expected = match mode {
                    Guard::Off => None,
                    Guard::Epoch => Some("changed"),
                    Guard::Premise => Some(reason),
                };
                // In off mode a renamed-away target is no longer resolvable by the kit.
                if mode == Guard::Off && premise == "name" {
                    assert!(answer.as_ref().err().is_some_and(|e| e["error"]["code"] != "conflict"));
                } else {
                    matrix_result(&format!("modes/{outside}/{premise}/{mode:?}"), expected, answer, f.read() == saved, &mut failures);
                }
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn remaining_editor_state_matrix() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for state in ["selection", "part", "time", "mode", "active", "area"] {
            for changed in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let file = dir.path().join("state.json");
                std::fs::write(&file, json!({state:1}).to_string()).unwrap();
                let env = format!("KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_EDITOR_FILE='{}'", file.display());
                let original = records();
                let f = Fixture::new("mstate", &env, &original.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                std::fs::write(&file, json!({state:if changed{2}else{1}}).to_string()).unwrap();
                if outside {
                    f.write_outside(&original.to_string());
                }
                let saved = f.read();
                let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":format!("matrix.{state}"),"params":{"item":"A","hold":[]}}]})).await;
                matrix_result(&format!("state/{outside}/{state}/{changed}"), changed.then_some("changed"), answer, f.read() == saved, &mut failures);
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn explicit_targets_replace_selection_reads_but_object_parameters_do_not() {
    for declared_target in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state.json");
        std::fs::write(&state, json!({"selection":["B"]}).to_string()).unwrap();
        let env = format!("KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_EDITOR_FILE='{}'", state.display());
        let f = Fixture::new("declaredselection", &env, &records().to_string()).expect("build mock");
        let basis = f.revision(ME).await;
        std::fs::write(&state, json!({"selection":["A"]}).to_string()).unwrap();
        let command = if declared_target { "matrix.targeted" } else { "matrix.selection" };
        let result = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":command,"params":{"item":"A","hold":["data"],"value":"Mine"}}]})).await;
        if declared_target {
            result.unwrap_or_else(|error| panic!("an explicit declared target does not read selection: {error}"));
        } else {
            let error = result.expect_err("the kit still declares a selection read");
            assert!(
                error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["now"]["state"] == "selection" && conflict["reason"] == "changed"),
                "{error}"
            );
        }
        f.shutdown().await;
    }
}

#[tokio::test]
async fn distant_appends_only_conflict_when_the_kit_explicitly_holds_the_new_object() {
    for broad in [false, true] {
        let mut file = records();
        file["other"] = json!([{"key":"D","name":"D","data":{},"extra":0},{"key":"E","name":"E","data":{},"extra":0}]);
        let f = Fixture::new("declaredappend", "KITION_KIT_MOCK_ORDER=matrix", &file.to_string()).expect("build mock");
        let basis = f.revision(ME).await;
        file["other"].as_array_mut().unwrap().push(json!({"key":"C","name":"New distant object","data":{},"extra":0}));
        f.write_outside(&file.to_string());
        let result = f
            .call(
                ME,
                "run",
                json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","emptyPlace":if broad {"premise"} else {"gap"},"value":"Mine"}}]}),
            )
            .await;
        if broad {
            let error = result.expect_err("the kit explicitly held the newly created object");
            assert!(error["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["id"] == "C" && conflict["reason"] == "relocated"), "{error}");
        } else {
            result.unwrap_or_else(|error| panic!("an append beyond the declared gap is independent: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test]
async fn ordered_gap_deleted_before() {
    let f =
        Fixture::new("orddelete", "KITION_KIT_MOCK_ORDER=list", r#"{"items":[{"id":"A","name":"A"},{"id":"B","name":"B"},{"id":"C","name":"C"}],"other":[]}"#)
            .expect("build mock");
    let basis = f.revision(ME).await;
    f.write_outside(r#"{"items":[{"id":"B","name":"B"},{"id":"C","name":"C"}],"other":[]}"#);
    let refused = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"order.gap","params":{"at":1}}]})).await.expect_err("stale gap");
    assert!(refused["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "relocated"), "{refused}");
    f.shutdown().await;
}

#[tokio::test]
async fn ordered_gap_edges_and_unchanged_distant_neighbours() {
    for tree in [false, true] {
        for outside in [false, true] {
            for (gap, kind, at, refuses) in [
                (5, "insert", 5, true),
                (2, "insert", 2, true),
                (0, "insert", 0, true),
                (5, "reorder", 0, false),
                (2, "delete", 3, false),
                (2, "field", 1, false),
                (2, "field", 2, false),
            ] {
                let original =
                    json!({"items": (["A","B","C","D","E"].map(|id| json!({"id":id,"name":id}))),"other":[{"id":"Z","name":"Z"},{"id":"Y","name":"Y"}]});
                let label = format!("edge{tree}{outside}{gap}{kind}{at}");
                let f = Fixture::new(&label, if tree { "KITION_KIT_MOCK_ORDER=tree" } else { "KITION_KIT_MOCK_ORDER=list" }, &original.to_string())
                    .expect("build mock");
                let basis = f.revision(ME).await;
                let mut changed = original.clone();
                let list = changed["items"].as_array_mut().unwrap();
                match kind {
                    "insert" => list.insert(at, json!({"id":"X","name":"X"})),
                    "reorder" => list.swap(at, at + 1),
                    "delete" => {
                        list.remove(at);
                    }
                    _ => list[at]["name"] = json!("Elsewhere"),
                }
                if outside {
                    f.write_outside(&changed.to_string());
                } else {
                    f.ok(OTHER, "batch", json!({"ops":order_change(tree,kind,at,&original,&changed)})).await;
                }
                let saved = f.read();
                let result = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"order.gap","params":{"at":gap}}]})).await;
                if refuses {
                    let error = result.expect_err(&label);
                    assert!(error["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "relocated"), "{label}: {error}");
                    assert_eq!(saved, f.read());
                } else {
                    result.unwrap_or_else(|error| panic!("{label}: {error}"));
                }
                f.shutdown().await;
            }
        }
    }
}

#[tokio::test]
async fn ordered_place_matrix() {
    let mut failures = Vec::new();
    let mut tasks = tokio::task::JoinSet::new();
    for tree in [false, true] {
        for outside in [false, true] {
            for command in ["gap", "window", "index", "reverse", "move", "source"] {
                for position in [0_usize, 2, 5] {
                    let from = if command == "window" {
                        position.min(3)
                    } else if matches!(command, "index" | "reverse") {
                        position.min(4)
                    } else {
                        position
                    };
                    let to = from
                        + match command {
                            "window" => 2,
                            "index" | "reverse" => 1,
                            _ => 0,
                        };
                    for kind in ["insert", "delete", "move-in", "move-out", "reorder", "field"] {
                        for after in [false, true] {
                            let at = if after {
                                to + usize::from(matches!(command, "gap" | "move" | "source"))
                            } else if kind == "reorder" {
                                from.saturating_sub(1).min(3)
                            } else {
                                from.saturating_sub(1)
                            };
                            if at >= 5 || kind == "reorder" && at + 1 >= 5 {
                                continue;
                            }
                            let label = format!("{tree}/{outside}/{command}/{position}/{kind}/{}", if after { "after" } else { "before" });
                            let original = json!({"items": (["A","B","C","D","E"].map(|id| json!({"id":id,"name":id}))), "other":[{"id":"Z","name":"Z"},{"id":"Y","name":"Y"}]});
                            let env = if tree { "KITION_KIT_MOCK_ORDER=tree" } else { "KITION_KIT_MOCK_ORDER=list" };
                            if tasks.len() >= 16
                                && let Some(failure) = tasks.join_next().await.unwrap().unwrap()
                            {
                                failures.push(failure);
                            }
                            tasks.spawn(async move {
                                let name = format!("ord{}", label.replace(['/', '-'], ""));
                                let f = Fixture::new(&name, env, &original.to_string()).expect("build the mock kit first");
                                let basis = f.revision(ME).await;
                                let mut changed = original.clone();
                                let list = changed["items"].as_array_mut().unwrap();
                                match kind {
                                    "insert" => list.insert(at, json!({"id":"X","name":"X"})),
                                    "delete" => {
                                        list.remove(at);
                                    }
                                    "move-in" => list.insert(at, json!({"id":"Z","name":"Z"})),
                                    "move-out" => {
                                        list.remove(at);
                                    }
                                    "reorder" => list.swap(at, at + 1),
                                    _ => list[at]["name"] = json!("Elsewhere"),
                                }
                                if kind == "move-in" {
                                    changed["other"].as_array_mut().unwrap().remove(0);
                                }
                                if kind == "move-out" {
                                    changed["other"].as_array_mut().unwrap().push(original["items"][at].clone());
                                }
                                if outside {
                                    f.write_outside(&changed.to_string());
                                } else {
                                    f.ok(OTHER, "batch", json!({"ops":order_change(tree, kind, at, &original, &changed)})).await;
                                }
                                let old_ids: Vec<_> = original["items"].as_array().unwrap().iter().map(|v| v["id"].clone()).collect();
                                let new_ids: Vec<_> = changed["items"].as_array().unwrap().iter().map(|v| v["id"].clone()).collect();
                                let relevant = |ids: &[Value]| {
                                    if command == "reverse" {
                                        return vec![ids.len().checked_sub(5 - from).and_then(|at| ids.get(at)).cloned()];
                                    }
                                    let range = if matches!(command, "gap" | "move" | "source") { from.saturating_sub(1)..to + 1 } else { from..to };
                                    let mut held = range.map(|i| ids.get(i).cloned()).collect::<Vec<_>>();
                                    // A window holds which items are at its positions, not their
                                    // order among themselves (docs/platform/data-model.md).
                                    if command == "window" {
                                        held.sort_by_key(|id| id.as_ref().map(Value::to_string));
                                    }
                                    held
                                };
                                let source_changed = command == "source" && old_ids.iter().position(|id| id == "C") != new_ids.iter().position(|id| id == "C");
                                let should_refuse = relevant(&old_ids) != relevant(&new_ids) || source_changed;
                                let saved = f.read();
                                let at_param = match command {
                                    "index" => json!(format!("#{}", from + 1)),
                                    "reverse" => json!(format!("#{}", 5 - from)),
                                    _ => json!(from),
                                };
                                let mut params = json!({"at":at_param});
                                if matches!(command, "move" | "source") {
                                    params["item"] = json!(if command == "source" { "C" } else { "Y" });
                                }
                                let actual_command = if command == "source" { "move" } else { command };
                                let answer =
                                    f.call(ME, "run", json!({"basis":basis,"steps":[{"command":format!("order.{actual_command}"),"params":params}]})).await;
                                let valid = if should_refuse {
                                    answer.as_ref().err().is_some_and(|e| {
                                        e["error"]["code"] == "conflict"
                                            && (!matches!(command, "gap" | "move")
                                                || e["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "relocated"))
                                    }) && f.read() == saved
                                } else {
                                    answer.is_ok()
                                };
                                println!("MATRIX {label}: {} {}", if should_refuse { "refuse" } else { "apply" }, if valid { "PASS" } else { "FAIL" });
                                let failure =
                                    (!valid).then(|| format!("{label}: expected {}, got {answer:?}", if should_refuse { "refusal" } else { "apply" }));
                                f.shutdown().await;
                                failure
                            });
                        }
                    }
                }
            }
        }
    }
    while let Some(result) = tasks.join_next().await {
        if let Some(failure) = result.unwrap() {
            failures.push(failure);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A told ordinal window holds which items are at its positions `[from, to)` (data-model.md,
/// "List windows hold membership"): another writer's reorder among the members applies; an
/// item moved in or out, created or deleted inside, or shifted across an end by an insertion or
/// removal before the window refuses; edits after it apply. An empty window is an insertion gap
/// and holds its neighbours; a window of positions ending at the list's end holds an append only
/// when `to` passes the last item.
#[tokio::test]
async fn window_membership_matrix() {
    let mut failures = Vec::new();
    // (label, window, change, the index it changes, expected reason or None to apply)
    type Case = (&'static str, (usize, usize), &'static str, usize, Option<&'static str>);
    let cases: [Case; 18] = [
        ("reorder-inside", (1, 4), "reorder", 1, None),
        ("reorder-inside-last", (1, 4), "reorder", 2, None),
        ("reorder-whole-list", (0, 6), "reorder", 0, None),
        ("reorder-across-end", (1, 4), "reorder", 3, Some("relocated")),
        ("move-in", (1, 4), "move-in", 2, Some("relocated")),
        ("move-out", (1, 4), "move-out", 2, Some("relocated")),
        ("insert-before", (1, 4), "insert", 0, Some("relocated")),
        ("insert-inside", (1, 4), "insert", 2, Some("relocated")),
        ("insert-after", (1, 4), "insert", 4, None),
        ("remove-before", (1, 4), "delete", 0, Some("relocated")),
        ("remove-inside", (1, 4), "delete", 2, Some("deleted")),
        ("remove-after", (1, 4), "delete", 4, None),
        ("empty-insert-at", (2, 2), "insert", 2, Some("relocated")),
        ("empty-insert-after", (2, 2), "insert", 4, None),
        ("end-append", (3, 5), "insert", 5, None),
        ("end-slot-append", (3, 6), "insert", 5, Some("relocated")),
        ("end-reorder", (3, 5), "reorder", 3, None),
        ("whole-list-remove-last", (0, 6), "delete", 4, Some("deleted")),
    ];
    for outside in [false, true] {
        for (label, (from, to), kind, at, expected) in cases {
            let label = format!("{outside}/{label}");
            let original =
                json!({"items": (["A","B","C","D","E"].map(|id| json!({"id":id,"name":id}))), "other":[{"id":"Z","name":"Z"},{"id":"Y","name":"Y"}]});
            let f = Fixture::new(&format!("wm{}", label.replace(['/', '-'], "")), "KITION_KIT_MOCK_ORDER=list", &original.to_string())
                .expect("build the mock kit first");
            let basis = f.revision(ME).await;
            let mut changed = original.clone();
            let list = changed["items"].as_array_mut().unwrap();
            match kind {
                "insert" => list.insert(at, json!({"id":"X","name":"X"})),
                "delete" | "move-out" => {
                    list.remove(at);
                }
                "move-in" => list.insert(at, json!({"id":"Z","name":"Z"})),
                _ => list.swap(at, at + 1),
            }
            if kind == "move-in" {
                changed["other"].as_array_mut().unwrap().remove(0);
            }
            if kind == "move-out" {
                changed["other"].as_array_mut().unwrap().push(original["items"][at].clone());
            }
            matrix_change(&f, outside, &changed, order_change(false, kind, at, &original, &changed)).await;
            let saved = f.read();
            let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"order.window","params":{"at":from,"to":to}}]})).await;
            let valid = match (&answer, expected) {
                (Ok(_), None) => {
                    // The window's items now are the ones the write renamed.
                    let written: Value = serde_json::from_str(&f.read()).unwrap();
                    let items = written["items"].as_array().unwrap();
                    items.iter().enumerate().all(|(index, item)| (item["name"] == "Agent") == (from..to).contains(&index))
                }
                (Err(error), Some(reason)) => {
                    error["error"]["code"] == "conflict"
                        && error["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == reason))
                        && f.read() == saved
                }
                _ => false,
            };
            println!("MATRIX {label}: {} {}", expected.unwrap_or("apply"), if valid { "PASS" } else { "FAIL" });
            if !valid {
                failures.push(format!("{label}: expected {}, got {answer:?}", expected.unwrap_or("apply")));
            }
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn order_change(tree: bool, kind: &str, at: usize, before: &Value, after: &Value) -> Vec<Value> {
    let item = &before["items"][at]["id"];
    let mut ops = match kind {
        "field" => vec![json!({"op":"set","target":item,"field":"name","value":"Elsewhere"})],
        "delete" => vec![json!({"op":"delete","target":item})],
        "insert" => vec![
            json!({"op":"create","type":"Item","id":"X","in":"root.items","parent":if tree {json!("group-order")} else {Value::Null},"at":if tree {json!("end")} else {json!(at)},"fields":{"name":"X"}}),
        ],
        "move-in" if tree => vec![json!({"op":"tree.move","target":"root","field":"items","item":"Z","parent":"group-order"})],
        "move-out" if tree => vec![json!({"op":"tree.move","target":"root","field":"items","item":item,"parent":"other-group-order"})],
        "move-in" => vec![
            json!({"op":"list.remove","target":"root","field":"other","index":0}),
            json!({"op":"list.insert","target":"root","field":"items","index":at,"item":"Z"}),
        ],
        "move-out" => vec![
            json!({"op":"list.remove","target":"root","field":"items","index":at}),
            json!({"op":"list.insert","target":"root","field":"other","index":2,"item":item}),
        ],
        _ => vec![json!({"op":"list.move","target":"root","field":"items","from":at,"to":at+2})],
    };
    if tree && matches!(kind, "insert" | "move-in" | "reorder") {
        if kind == "reorder" {
            ops.clear();
        }
        ops.extend(
            after["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| json!({"op":"tree.move","target":"root","field":"items","item":item["id"],"parent":"group-order"})),
        );
    }
    ops
}

/// Batch twins of the ordered command matrix, through zero, one and two list/ref holders.
#[tokio::test]
async fn ordered_batch_matrix() {
    let mut failures = Vec::new();
    let mut tasks = tokio::task::JoinSet::new();
    for tree in [false, true] {
        for depth in 0..=2 {
            for held in [false, true] {
                for outside in [false, true] {
                    for form in ["create", "insert", "move"] {
                        for kind in ["insert", "delete", "move-in", "move-out", "reorder", "field"] {
                            for after in [false, true] {
                                if tasks.len() >= 16 {
                                    failures.extend(tasks.join_next().await.unwrap().unwrap());
                                }
                                tasks.spawn(async move {
                                let mut failures = Vec::new();
                                let original = json!({"items": (["A","B","C","D","E"].map(|id| json!({"id":id,"name":id}))),"other":[{"id":"Z","name":"Z"},{"id":"Y","name":"Y"}]});
                                let label = format!("batch/{tree}/{depth}/{held}/{outside}/{form}/{kind}/{after}");
                                let env = format!("KITION_KIT_MOCK_ORDER={} KITION_KIT_MOCK_ORDER_DEPTH={depth}", if tree {"tree"} else {"list"});
                                let f = Fixture::new("ordbatch", &env, &original.to_string()).expect("build mock");
                                let basis = f.revision(ME).await;
                                let at = if after { 3 } else { 0 };
                                let mut changed = original.clone();
                                let list = changed["items"].as_array_mut().unwrap();
                                match kind {
                                    "insert" => list.insert(at, json!({"id":"X","name":"X"})),
                                    "move-in" => list.insert(at, json!({"id":"Z","name":"Z"})),
                                    "delete" | "move-out" => { list.remove(at); }
                                    "reorder" => list.swap(at, at + 1),
                                    _ => list[at]["name"] = json!("Elsewhere"),
                                }
                                if kind == "move-in" { changed["other"].as_array_mut().unwrap().remove(0); }
                                if kind == "move-out" { changed["other"].as_array_mut().unwrap().push(original["items"][at].clone()); }
                                let owner = if depth == 0 { "root".to_owned() } else { format!("body-order-{depth}") };
                                if outside {
                                    f.write_outside(&changed.to_string());
                                } else {
                                    let mut ops = order_change(tree, kind, at, &original, &changed);
                                    for op in &mut ops {
                                        if op["target"] == "root" { op["target"] = json!(owner); }
                                        if let Some(path) = op["in"].as_str().and_then(|s|s.strip_prefix("root.")) { op["in"] = json!(format!("{owner}.{path}")); }
                                    }
                                    f.ok(OTHER, "batch", json!({"ops":ops})).await;
                                }
                                let target = if held { "root".to_owned() } else { owner };
                                let field = if held { format!("{}items", "groups.0.body.".repeat(depth)) } else { "items".to_owned() };
                                let gap = if tree { 5 } else { 2 };
                                let old: Vec<_> = original["items"].as_array().unwrap().iter().map(|v|v["id"].clone()).collect();
                                let new: Vec<_> = changed["items"].as_array().unwrap().iter().map(|v|v["id"].clone()).collect();
                                let neighbours = |ids: &[Value]| vec![ids.get(gap-1).cloned(), ids.get(gap).cloned()];
                                let source_changed = !tree && form == "move" && old.first() != new.first();
                                let refuses = neighbours(&old) != neighbours(&new) || source_changed;
                                let mut ops = Vec::new();
                                if form == "create" {
                                    ops.push(json!({"op":"create","type":"Item","in":format!("{target}.{field}"),"at":if tree {json!("end")} else {json!(gap)},"parent":if tree {json!("group-order")} else {Value::Null},"fields":{"name":"Agent"}}));
                                } else if form == "insert" {
                                    ops.push(json!({"op":"create","type":"Item","ref":"$agent","fields":{"name":"Agent"}}));
                                    ops.push(if tree {json!({"op":"tree.insert","target":target,"field":field,"item":"$agent","parent":"group-order"})} else {json!({"op":"list.insert","target":target,"field":field,"item":"$agent","index":gap})});
                                } else {
                                    ops.push(if tree {json!({"op":"tree.move","target":target,"field":field,"item":"Y","parent":"group-order"})} else {json!({"op":"list.move","target":target,"field":field,"from":0,"to":gap})});
                                }
                                let saved = f.read();
                                let answer = f.call(ME,"batch",json!({"basis":basis,"ops":ops})).await;
                                matrix_result(&label, refuses.then_some("relocated"), answer, saved==f.read(), &mut failures);
                                f.shutdown().await;
                                failures
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    while let Some(result) = tasks.join_next().await {
        failures.extend(result.unwrap());
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn insertion_gap_holds_neighbours_for_agent_and_outside_edits() {
    for (case, outside, before) in [("ggapab", false, true), ("ggapaa", false, false), ("ggapob", true, true), ("ggapoa", true, false)] {
        let f = Fixture::deck(case).expect("build the mock kit first");
        let basis = f.revision(ME).await;
        if outside {
            f.write_outside(if before { "3:\n1:1=Title|2=Body|3=Footer\n2:4=Second|5=More" } else { "1:1=Title|2=Body|3=Footer\n2:4=Second|5=More\n3:" });
        } else {
            f.ok(OTHER, "run", json!({ "steps": [{ "command": "slide.insert", "params": { "index": if before { 0 } else { 2 } } }] })).await;
        }
        let saved = f.read();
        let result = f.call(ME, "run", json!({ "basis": basis, "steps": [{ "command": "slide.insert", "params": { "index": 1 } }] })).await;
        if before {
            let refused = result.expect_err("a stale insertion gap must refuse");
            assert_conflict(&refused);
            assert!(refused["conflicts"].as_array().unwrap().iter().any(|entry| entry["reason"] == "relocated"), "{refused}");
            assert_eq!(f.read(), saved);
        } else {
            result.unwrap_or_else(|error| panic!("an edit after the gap must apply: {error}"));
        }
        f.shutdown().await;
    }
}

struct Fixture {
    kits: KitManager,
    native: KitManager,
    name: String,
    options: CallOptions,
    workspace: tempfile::TempDir,
    _bin: tempfile::TempDir,
}

impl Fixture {
    fn new(name: &str, env: &str, text: &str) -> Option<Self> {
        Self::with(name, env, text, |kits| kits)
    }

    /// The kit `name` (the mock with `env`) on a workspace holding `a.<name>` with `text`, its
    /// manager set up by `setup`.
    fn with(name: &str, env: &str, text: &str, setup: impl FnOnce(KitManager) -> KitManager) -> Option<Self> {
        let Some(mock) = mock_binary() else {
            eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
            return None;
        };
        let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(workspace.path().join(format!("a.{name}")), text).unwrap_or_else(|err| panic!("{err}"));
        let kits = setup(KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit(name), Some(as_kit(bin.path(), &mock, name, env)))]));
        let native = editor::attach(&kits, workspace.path(), kit(name), &as_kit(bin.path(), &mock, name, env), &format!("a.{name}"));
        Some(Self { kits, native, name: name.to_owned(), options: CallOptions::default(), workspace, _bin: bin })
    }

    fn deck(name: &str) -> Option<Self> {
        Self::new(name, "KITION_KIT_MOCK_PARTS=deck", DECK)
    }

    /// A deck as a real slide kit models it ([`NESTED`]).
    fn nested(name: &str) -> Option<Self> {
        Self::new(name, NESTED_ENV, NESTED)
    }

    fn path(&self) -> String {
        format!("a.{}", self.name)
    }

    /// `<prefix>_<action>` on the fixture's file as `agent`: its answer, or its failure as the
    /// tool answers it (`{ error, …output }`).
    async fn call(&self, agent: &str, action: &str, mut input: Value) -> Result<Value, Value> {
        input["path"] = json!(self.path());
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

    /// The revision of what `agent` sees now (an inspect).
    async fn revision(&self, agent: &str) -> String {
        let seen = self.ok(agent, "inspect", json!({})).await;
        seen["revision"].as_str().unwrap_or_else(|| panic!("inspect answers a revision: {seen}")).to_owned()
    }

    fn file(&self) -> PathBuf {
        self.workspace.path().join(self.path())
    }

    fn read(&self) -> String {
        std::fs::read_to_string(self.file()).unwrap_or_else(|err| panic!("{err}"))
    }

    /// Writes the file as someone outside the server would, an hour before its own time.
    fn write_outside(&self, text: &str) {
        let at = std::fs::metadata(self.file()).and_then(|meta| meta.modified()).unwrap_or_else(|err| panic!("{err}")) - Duration::from_secs(3600);
        write_at(&self.file(), text, at);
    }

    async fn shutdown(self) {
        self.native.shutdown().await;
        self.kits.shutdown().await;
    }
}

fn write_at(file: &Path, text: &str, at: SystemTime) {
    std::fs::write(file, text).unwrap_or_else(|err| panic!("{err}"));
    let handle = std::fs::File::options().write(true).open(file).unwrap_or_else(|err| panic!("{err}"));
    handle.set_modified(at).unwrap_or_else(|err| panic!("{err}"));
}

fn text_of(id: &str, text: &str) -> Value {
    json!({ "command": "shape.text", "on": [id], "params": { "text": text } })
}

fn ids(list: &Value) -> Vec<&str> {
    list.as_array().map(|items| items.iter().filter_map(|item| item["id"].as_str()).collect()).unwrap_or_default()
}

fn conflict<'a>(refused: &'a Value, id: &str) -> &'a Value {
    refused["conflicts"]
        .as_array()
        .and_then(|conflicts| conflicts.iter().find(|conflict| conflict["id"] == id))
        .unwrap_or_else(|| panic!("no conflict on {id}: {refused}"))
}

/// The refusal of a write whose premises others changed: `conflict`, retryable, with `others`,
/// `conflicts` and the revision to use next.
fn assert_conflict(refused: &Value) {
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    assert_eq!(refused["error"]["retryable"], true, "{refused}");
    assert!(refused["others"].is_object(), "a refusal says what others changed: {refused}");
    assert!(refused["conflicts"].as_array().is_some_and(|conflicts| !conflicts.is_empty()), "{refused}");
    assert!(refused["revision"].is_string(), "{refused}");
}

// ---- Precision: changes to other objects never refuse ----

#[tokio::test]
async fn precision_another_agents_edit_of_an_unrelated_object_is_reported_and_never_refuses() {
    let Some(f) = Fixture::deck("gdprec") else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [text_of("shape:3", "Their footer")] })).await;
    let ran = f.ok(ME, "run", json!({ "basis": basis, "target": { "slide": 1 }, "steps": [text_of("shape:1", "My title")] })).await;
    assert_eq!(ids(&ran["others"]["changed"]), ["shape:3"], "the other agent's edit is reported: {ran}");
    assert_eq!(ran["others"]["by"], json!([OTHER]), "{ran}");
    assert_eq!(ids(&ran["changes"]["changed"]), ["shape:1"], "and the call's own change is its receipt: {ran}");
    assert_eq!(f.read(), "1:1=My title|2=Body|3=Their footer\n2:4=Second|5=More");

    // A batch is as precise.
    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.ok(OTHER, "batch", json!({ "ops": [{ "op": "set", "target": "shape:5", "field": "text", "value": "Theirs" }] })).await;
    let set = f.ok(ME, "batch", json!({ "basis": basis, "ops": [{ "op": "set", "target": "shape:2", "field": "text", "value": "Mine" }] })).await;
    assert_eq!(ids(&set["others"]["changed"]), ["shape:5"], "{set}");
    f.shutdown().await;
}

#[tokio::test]
async fn precision_the_epoch_guard_refuses_the_same_write_and_the_guard_off_refuses_nothing() {
    let Some(mut f) = Fixture::deck("gdepoch") else { return };
    f.options = CallOptions { guard: Guard::Epoch, ..CallOptions::default() };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [text_of("shape:3", "Their footer")] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:1", "My title")] })).await;
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    assert_eq!(ids(&refused["others"]["changed"]), ["shape:3"], "{refused}");
    assert!(f.read().starts_with("1:1=Title|"), "nothing ran: {}", f.read());

    f.options = CallOptions { guard: Guard::Off, ..CallOptions::default() };
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "shape.delete", "on": ["shape:2"] }] })).await;
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:1", "My title")] })).await;
    assert_eq!(ids(&ran["others"]["deleted"]), ["shape:2"], "off still says what others changed: {ran}");
    f.shutdown().await;
}

#[tokio::test]
async fn precision_my_own_earlier_writes_never_refuse_me_even_when_they_moved_things() {
    let Some(f) = Fixture::deck("gdown") else { return };
    let basis = f.revision(ME).await;
    f.ok(ME, "run", json!({ "steps": [{ "command": "slide.insert", "params": { "index": 0 } }] })).await;
    f.ok(ME, "run", json!({ "steps": [{ "command": "shape.delete", "on": ["shape:1"] }, text_of("shape:2", "Mine")] })).await;
    let ran = f.ok(ME, "run", json!({ "basis": basis, "target": { "slideId": 1 }, "steps": [text_of("shape:3", "Mine too")] })).await;
    assert!(ran.get("others").is_none(), "nothing by others: {ran}");
    let set = f.ok(ME, "batch", json!({ "basis": basis, "ops": [{ "op": "set", "target": "shape:2", "field": "text", "value": "Again" }] })).await;
    assert!(set.get("others").is_none(), "{set}");
    f.shutdown().await;
}

// ---- Conflicts ----

#[tokio::test]
async fn conflict_another_agent_deleted_my_target_and_a_retry_on_the_new_basis_works() {
    let Some(f) = Fixture::deck("gddel") else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "shape.delete", "on": ["shape:2"] }] })).await;
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:1", "Mine"), text_of("shape:2", "Mine")] })).await;
    assert_conflict(&refused);
    assert_eq!(conflict(&refused, "shape:2")["reason"], "deleted", "{refused}");
    assert!(conflict(&refused, "shape:2").get("now").is_none(), "{refused}");
    assert_eq!(ids(&refused["others"]["deleted"]), ["shape:2"], "{refused}");
    assert_eq!(f.read(), before, "nothing ran, not even the step on shape:1");

    let next = refused["revision"].as_str().unwrap_or_default();
    let ran = f.ok(ME, "run", json!({ "basis": next, "steps": [text_of("shape:1", "Mine")] })).await;
    assert!(ran.get("others").is_none(), "nothing new by others since the refusal: {ran}");
    assert!(f.read().starts_with("1:1=Mine|3=Footer"), "{}", f.read());
    f.shutdown().await;
}

#[tokio::test]
async fn conflict_a_slide_inserted_before_my_part_relocates_it_and_says_where_it_is_now() {
    let Some(f) = Fixture::deck("gdins") else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "slide.insert", "params": { "index": 0 } }] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "target": { "slide": 1 }, "steps": [text_of("shape:1", "Mine")] })).await;
    assert_conflict(&refused);
    let part = conflict(&refused, "slide:1");
    assert_eq!(part["reason"], "relocated", "{refused}");
    assert_eq!(part["now"], json!({ "slide": 2 }), "{refused}");
    assert_eq!(refused["others"]["created"][0]["at"]["index"], 0, "{refused}");

    // By the part's stable id, the same write applies: what it names did not move.
    let ran = f.ok(ME, "run", json!({ "basis": basis, "target": { "slideId": 1 }, "steps": [text_of("shape:1", "Mine")] })).await;
    assert_eq!(ids(&ran["others"]["created"]).len(), 1, "{ran}");
    f.shutdown().await;
}

#[tokio::test]
async fn conflict_a_shape_moved_to_another_slide_or_shifted_in_its_list_is_relocated() {
    let Some(f) = Fixture::deck("gdmove") else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "shape.move", "on": ["shape:1"], "params": { "slideId": 2 } }] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:1", "Mine")] })).await;
    assert_conflict(&refused);
    let moved = conflict(&refused, "shape:1");
    assert_eq!(moved["reason"], "relocated", "{refused}");
    assert_eq!(moved["now"]["parent"], "slide:2", "{refused}");

    // Shape 2 slid from index 1 to 0 when shape 1 left its slide; shape 3 too.
    let refused = f.refused(ME, "batch", json!({ "basis": basis, "ops": [{ "op": "set", "target": "shape:3", "field": "text", "value": "Mine" }] })).await;
    assert_eq!(conflict(&refused, "shape:3")["reason"], "relocated", "{refused}");
    assert_eq!(conflict(&refused, "shape:3")["now"], json!({ "parent": "slide:1", "field": "shapes", "index": 1 }), "{refused}");
    // Shape 4 is before the end of slide 2's list, where shape 1 went: it kept its index and applies.
    f.ok(ME, "batch", json!({ "basis": basis, "ops": [{ "op": "set", "target": "shape:4", "field": "text", "value": "Mine" }] })).await;
    f.shutdown().await;
}

#[tokio::test]
async fn conflict_field_precision_a_batch_conflicts_on_the_field_it_replaces_a_command_on_any_field() {
    let Some(f) = Fixture::deck("gdfield") else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "batch", json!({ "ops": [{ "op": "set", "target": "shape:1", "field": "text", "value": "Theirs" }] })).await;
    let refused = f.refused(ME, "batch", json!({ "basis": basis, "ops": [{ "op": "set", "target": "shape:1", "field": "text", "value": "Mine" }] })).await;
    assert_conflict(&refused);
    assert_eq!(conflict(&refused, "shape:1")["reason"], "changed", "{refused}");

    let basis = refused["revision"].as_str().unwrap_or_default().to_owned();
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "shape.color", "on": ["shape:1"], "params": { "color": "red" } }] })).await;
    let set = f.ok(ME, "batch", json!({ "basis": basis, "ops": [{ "op": "set", "target": "shape:1", "field": "text", "value": "Mine" }] })).await;
    assert_eq!(set["others"]["changed"][0]["fields"], json!(["color"]), "{set}");
    // A command's written fields are not known: any change to its target refuses it.
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:1", "Mine")] })).await;
    assert_eq!(conflict(&refused, "shape:1")["reason"], "changed", "{refused}");
    assert_eq!(f.read(), "1:1=Mine#red|2=Body|3=Footer\n2:4=Second|5=More");
    f.shutdown().await;
}

// ---- Changes made outside (A56) ----

#[tokio::test]
async fn reread_session_keeps_agent_undo_after_an_unrelated_outside_edit() {
    let f = Fixture::new("retainedundo", "KITION_KIT_MOCK_PARTS=deck KITION_KIT_MOCK_RETAIN_SESSION=1", DECK).expect("build mock");
    f.ok(ME, "run", json!({"steps":[text_of("shape:1", "Mine")]})).await;
    let basis = f.revision(ME).await;
    f.write_outside("1:1=Mine|2=Body|3=Outside\n2:4=Second|5=More");
    f.ok(ME, "run", json!({"basis":basis,"steps":[{"command":"edit.undo"}]})).await;
    assert_eq!(f.read(), "1:1=Title|2=Body|3=Outside\n2:4=Second|5=More");
    f.shutdown().await;
}

#[tokio::test]
async fn outside_with_basis_an_unrelated_change_applies_and_a_deleted_target_conflicts() {
    let Some(f) = Fixture::deck("gdout") else { return };
    let basis = f.revision(ME).await;
    f.write_outside("1:1=Title|2=Body|3=Edited outside\n2:4=Second|5=More");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:1", "Mine")] })).await;
    assert_eq!(ran["others"]["by"], json!(["outside"]), "{ran}");
    assert_eq!(ids(&ran["others"]["changed"]), ["shape:3"], "{ran}");
    assert_eq!(f.read(), "1:1=Mine|2=Body|3=Edited outside\n2:4=Second|5=More");

    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.write_outside("1:1=Mine|3=Edited outside\n2:4=Second|5=More|2=Body");
    let refused = f.refused(ME, "batch", json!({ "basis": basis, "ops": [{ "op": "set", "target": "shape:2", "field": "text", "value": "x" }] })).await;
    assert_conflict(&refused);
    assert_eq!(conflict(&refused, "shape:2")["reason"], "relocated", "{refused}");
    f.write_outside("1:1=Mine\n2:4=Second|5=More|2=Body");
    let refused = f.refused(ME, "run", json!({ "basis": refused["revision"], "steps": [text_of("shape:3", "x")] })).await;
    assert_eq!(conflict(&refused, "shape:3")["reason"], "deleted", "{refused}");
    f.shutdown().await;
}

#[tokio::test]
async fn outside_without_basis_a_batch_is_refused_once_like_a_run_and_reads_do_not_clear_it() {
    let Some(f) = Fixture::deck("gdgap") else { return };
    f.ok(ME, "inspect", json!({})).await;
    f.write_outside("1:1=Title|2=Body|3=Edited outside\n2:4=Second|5=More");
    let seen = f.ok(ME, "inspect", json!({})).await;
    assert_eq!(seen["changedOutside"]["path"], f.path(), "{seen}");
    f.ok(ME, "query", json!({})).await;
    f.ok(ME, "check", json!({})).await;
    let refused = f.refused(ME, "batch", json!({ "ops": [{ "op": "set", "target": "shape:1", "field": "text", "value": "x" }] })).await;
    assert_eq!(refused["error"]["code"], "failed", "{refused}");
    assert_eq!(refused["error"]["retryable"], true, "{refused}");
    assert_eq!(refused["changedOutside"]["path"], f.path(), "{refused}");
    assert!(f.read().starts_with("1:1=Title|"), "the refused batch changed nothing");
    // Refused once.
    f.ok(ME, "batch", json!({ "ops": [{ "op": "set", "target": "shape:1", "field": "text", "value": "x" }] })).await;
    assert!(f.read().starts_with("1:1=x|2=Body|3=Edited outside"), "{}", f.read());
    f.shutdown().await;
}

#[tokio::test]
async fn outside_a_kit_without_an_object_model_cannot_say_what_changed_so_a_basis_is_unknown() {
    let Some(f) = Fixture::new("gdnomodel", "KITION_KIT_MOCK_SCHEMA=none", "Hello") else { return };
    let basis = f.revision(ME).await;
    f.write_outside("Someone else's text");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "text.append", "params": { "text": "!" } }] })).await;
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    assert_eq!(refused["conflicts"], json!([{ "reason": "unknown" }]), "{refused}");
    assert!(refused["error"]["message"].as_str().is_some_and(|message| message.contains("inspect")), "{refused}");
    assert_eq!(f.read(), "Someone else's text");
    let next = refused["revision"].as_str().unwrap_or_default();
    f.ok(ME, "run", json!({ "basis": next, "steps": [{ "command": "text.append", "params": { "text": "!" } }] })).await;
    assert_eq!(f.read(), "Someone else's text!");
    f.shutdown().await;
}

/// The mock enforces what a kit process serving `kition-kit-server` enforces: a batch on the
/// agent's connection, a read included, names the agent as its origin. The guard's reads passed
/// on the mock without one and failed on a real kit, where every change made in the file became
/// `unknown` (regressions/issue-guard-agent-origin).
#[tokio::test]
async fn outside_the_mock_refuses_an_agents_batch_without_its_origin_as_a_kit_process_does() {
    use kition_kits::manager::Caller;
    let Some(f) = Fixture::deck("gdorigin") else { return };
    let view = f.native.open(Caller::Agent, &f.path()).await.unwrap_or_else(|error| panic!("{error}"));
    let read = |origin: Option<Value>| {
        let mut params = serde_json::Map::new();
        params.insert("ops".into(), json!([]));
        params.insert("load".into(), json!([{ "target": "root" }]));
        if let Some(origin) = origin {
            params.insert("origin".into(), origin);
        }
        params
    };
    let refused = f.native.model(Caller::Agent, view.kit_id, &view.document_id, "model.batch", read(None)).await;
    assert!(refused.as_ref().is_err_and(|error| error.to_string().contains("origin")), "{refused:?}");
    let person = Some(json!({ "kind": "person", "principal": "p" }));
    assert!(f.native.model(Caller::Agent, view.kit_id, &view.document_id, "model.batch", read(person)).await.is_err());
    let agent = Some(json!({ "kind": "agent", "principal": "local" }));
    let answer = f.native.model(Caller::Agent, view.kit_id, &view.document_id, "model.batch", read(agent)).await.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(answer["loaded"][0]["type"], "Deck", "{answer}");
    // The host's connection is not the agent's: its batches keep their own origin.
    f.native.model(Caller::User, view.kit_id, &view.document_id, "model.batch", read(None)).await.unwrap_or_else(|error| panic!("{error}"));
    // A read as the agent is no edit: the file, its revision and the agents' undo are unchanged.
    let revision = f.revision(ME).await;
    let before = f.read();
    let seen = f.ok(ME, "query", json!({})).await;
    assert_eq!(seen["revision"], json!(revision), "{seen}");
    let undo = f.call(ME, "run", json!({ "steps": [{ "command": "edit.undo" }] })).await;
    assert!(undo.is_err(), "nothing to undo after reads: {undo:?}");
    assert_eq!(f.read(), before);
    f.shutdown().await;
}

// ---- A deck as a real kit models it ----

/// The scenario that answered `unknown` on a real kit: another process rewrites the file, changing
/// an object on another slide; a write with `basis` applies and `others` names that change by the
/// tool id of the shape holding the text, with the path to it.
#[tokio::test]
async fn nested_a_file_change_on_another_part_applies_and_others_names_it_by_tool_id() {
    let Some(f) = Fixture::nested("gnfile") else { return };
    let basis = f.revision(ME).await;
    f.write_outside("7:1=Title|2=Body\n9:1=Edited outside|2=More|!1=Speak slowly");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:7/1", "Mine")] })).await;
    assert_eq!(ran["others"]["by"], json!(["outside"]), "{ran}");
    assert_eq!(
        ran["others"]["changed"],
        json!([{ "id": "shape:9/1", "type": "Shape", "fields": ["body.paragraphs.0.text"], "edits": [{ "field": "body.paragraphs.0.text", "before": "Other", "after": "Edited outside" }] }]),
        "{ran}"
    );
    assert!(ran["others"].get("unknown").is_none(), "{ran}");
    assert_eq!(f.read(), "7:1=Mine|2=Body\n9:1=Edited outside|2=More|!1=Speak slowly");
    f.shutdown().await;
}

/// A file change that deletes my target, inserts a shape before it or moves it in its list
/// conflicts, by the target's tool id, with where it is now.
#[tokio::test]
async fn nested_a_file_change_that_deletes_or_relocates_my_target_conflicts_by_its_tool_id() {
    let Some(f) = Fixture::nested("gnreloc") else { return };
    let basis = f.revision(ME).await;
    f.write_outside("7:3=New|1=Title|2=Body\n9:1=Other|2=More|!1=Speak slowly");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:7/1", "Mine")] })).await;
    assert_conflict(&refused);
    assert_eq!(conflict(&refused, "shape:7/1")["reason"], "relocated", "inserted before it: {refused}");
    assert_eq!(conflict(&refused, "shape:7/1")["now"], json!({ "parent": "slide:7", "field": "shapes", "index": 1 }), "{refused}");
    assert!(!refused.to_string().contains("shape-7") && !refused.to_string().contains("para-"), "no object ids: {refused}");

    let basis = refused["revision"].as_str().unwrap_or_default().to_owned();
    f.write_outside("7:3=New|2=Body|1=Title\n9:1=Other|2=More|!1=Speak slowly");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:7/1", "Mine")] })).await;
    assert_eq!(conflict(&refused, "shape:7/1")["reason"], "relocated", "moved in its list: {refused}");
    assert_eq!(conflict(&refused, "shape:7/1")["now"]["index"], 2, "{refused}");

    let basis = refused["revision"].as_str().unwrap_or_default().to_owned();
    f.write_outside("7:3=New|2=Body\n9:1=Other|2=More|!1=Speak slowly");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:7/1", "Mine")] })).await;
    assert_eq!(conflict(&refused, "shape:7/1")["reason"], "deleted", "{refused}");
    assert_eq!(f.read(), "7:3=New|2=Body\n9:1=Other|2=More|!1=Speak slowly", "nothing ran");
    f.shutdown().await;
}

/// The text inside my target shape, changed in the file or by another agent, is a change of my
/// target: a command on it conflicts as `changed`; text changed inside another shape is reported
/// under that shape's tool id and refuses nothing. A batch replacing another field of my target
/// still runs.
#[tokio::test]
async fn nested_text_changed_inside_my_target_conflicts_and_inside_another_shape_applies() {
    let Some(f) = Fixture::nested("gntext") else { return };
    let basis = f.revision(ME).await;
    f.write_outside("7:1=Their title|2=Body\n9:1=Other|2=More|!1=Speak slowly");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:7/1", "Mine")] })).await;
    assert_conflict(&refused);
    assert_eq!(conflict(&refused, "shape:7/1")["reason"], "changed", "{refused}");
    let set = f.ok(ME, "batch", json!({ "basis": basis, "ops": [{ "op": "set", "target": "shape:7/1", "field": "color", "value": "red" }] })).await;
    assert_eq!(ids(&set["others"]["changed"]), ["shape:7/1"], "{set}");

    let basis = set["revision"].as_str().unwrap_or_default().to_owned();
    f.ok(OTHER, "run", json!({ "steps": [text_of("shape:9/1", "Theirs")] })).await;
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:7/2", "Mine")] })).await;
    assert_eq!(ran["others"]["changed"][0]["id"], "shape:9/1", "{ran}");
    assert_eq!(ran["others"]["changed"][0]["edits"][0]["field"], "body.paragraphs.0.text", "{ran}");

    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "shape.paragraph", "on": ["shape:7/2"], "params": { "text": "Theirs" } }] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:7/2", "Mine again")] })).await;
    assert_eq!(conflict(&refused, "shape:7/2")["reason"], "changed", "a paragraph added inside it: {refused}");
    assert_eq!(f.read(), "7:1=Their title#red|2=Mine~Theirs\n9:1=Theirs|2=More|!1=Speak slowly");
    f.shutdown().await;
}

/// A batch that names a paragraph by the object id a query answered: others' change to its text,
/// which change sets name under the shape at a path, is followed to it and conflicts; a change to
/// another shape's paragraph does not.
#[tokio::test]
async fn nested_a_batch_on_a_paragraph_by_its_object_id_conflicts_when_others_changed_it() {
    let Some(f) = Fixture::nested("gnpara") else { return };
    let paragraph = |shape: &str| {
        let shape = shape.to_owned();
        let f = &f;
        async move {
            let read = f.ok(ME, "query", json!({ "objects": [shape], "follow": "body.paragraphs" })).await;
            read["objects"][0]["id"].as_str().unwrap_or_else(|| panic!("a paragraph: {read}")).to_owned()
        }
    };
    let (mine, theirs) = (paragraph("shape:7/1").await, paragraph("shape:9/1").await);
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [text_of("shape:7/1", "Theirs")] })).await;
    let refused = f.refused(ME, "batch", json!({ "basis": basis, "ops": [{ "op": "set", "target": mine, "field": "text", "value": "Mine" }] })).await;
    assert_conflict(&refused);
    assert_eq!(conflict(&refused, &mine)["reason"], "changed", "{refused}");
    f.ok(ME, "batch", json!({ "basis": basis, "ops": [{ "op": "set", "target": theirs, "field": "text", "value": "Mine" }] })).await;
    assert_eq!(f.read(), "7:1=Theirs|2=Body\n9:1=Mine|2=More|!1=Speak slowly");
    f.shutdown().await;
}

/// `--guard epoch` refuses the unrelated file change; `--guard off` refuses nothing and reports it.
#[tokio::test]
async fn nested_the_epoch_guard_refuses_a_file_change_and_the_guard_off_reports_it() {
    let Some(mut f) = Fixture::nested("gnepoch") else { return };
    f.options = CallOptions { guard: Guard::Epoch, ..CallOptions::default() };
    let basis = f.revision(ME).await;
    f.write_outside("7:1=Title|2=Body\n9:1=Edited outside|2=More|!1=Speak slowly");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:7/1", "Mine")] })).await;
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    assert_eq!(ids(&refused["others"]["changed"]), ["shape:9/1"], "{refused}");
    f.options = CallOptions { guard: Guard::Off, ..CallOptions::default() };
    f.write_outside("7:1=Title\n9:1=Edited outside|2=More|!1=Speak slowly");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:7/1", "Mine")] })).await;
    // Slide 7's list of shapes changed: the deleted shape says so (`at`), so the slide's own
    // entry (`fields: ["shapes"]`, no edits) is left out.
    assert_eq!(ids(&ran["others"]["changed"]), ["shape:9/1"], "{ran}");
    assert_eq!(ids(&ran["others"]["deleted"]), ["shape:7/2"], "{ran}");
    f.shutdown().await;
}

/// The list of parts is the one of the type whose tool id carries the part's noun, not the first
/// list holding an id that starts like a part's: a note deleted on slide 9 (`slide:9/note:1`)
/// refuses no write to slide 1. A part addressed by number conflicts by its tool id, with its
/// number now.
#[tokio::test]
async fn nested_parts_are_found_by_type_and_a_numbered_part_conflicts_by_its_tool_id() {
    let Some(f) = Fixture::nested("gnparts") else { return };
    let basis = f.revision(ME).await;
    f.write_outside("7:1=Title|2=Body\n9:1=Other|2=More");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "target": { "slide": 1 }, "steps": [text_of("shape:7/1", "Mine")] })).await;
    assert_eq!(ids(&ran["others"]["deleted"]), ["slide:9/note:1"], "{ran}");

    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "slide.insert", "params": { "index": 0 } }] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "target": { "slide": 2 }, "steps": [text_of("shape:9/1", "Mine")] })).await;
    assert_conflict(&refused);
    let part = conflict(&refused, "slide:9");
    assert_eq!(part["reason"], "relocated", "{refused}");
    assert_eq!(part["now"], json!({ "slide": 3 }), "{refused}");
    f.shutdown().await;
}

/// A batch's `command` operation acts on the objects its command declares as `targets`: they are
/// premises, so another's change to them refuses it, and a change elsewhere does not.
#[tokio::test]
async fn nested_a_batch_command_operation_conflicts_on_its_declared_targets() {
    let Some(f) = Fixture::new("gncmd", &format!("{NESTED_ENV} KITION_KIT_MOCK_BATCH=commands"), NESTED) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [text_of("shape:7/1", "Theirs")] })).await;
    let command = |id: &str| json!({ "op": "command", "id": "shape.color", "params": { "id": id, "color": "red" } });
    let refused = f.refused(ME, "batch", json!({ "basis": basis, "ops": [command("shape:7/1")] })).await;
    assert_conflict(&refused);
    assert_eq!(conflict(&refused, "shape:7/1")["reason"], "changed", "{refused}");
    let ran = f.ok(ME, "batch", json!({ "basis": basis, "ops": [command("shape:9/1")] })).await;
    assert_eq!(ids(&ran["changes"]["changed"]), ["shape:9/1"], "{ran}");
    f.shutdown().await;
}

// ---- A file changed by another program, its object ids minted again  ----

/// A deck as large as a short talk, in a nested deck's file: two layouts and two media the deck
/// holds, ten slides (ids 11 to 20, numbers 1 to 10) each with a title, a body and a footer
/// (`shape:<id>/1` to `/3`, thirty shapes with text), slide 20 with a picture of the medium
/// `logo` (`shape:20/4`), slide 13 with a two-by-two table (`shape:13/5`, cells `a`, `b`, `c`,
/// `d`), slides 16 and 18 (and 26, 36 in larger decks) with a connector joining their title and body (`shape:<id>/6`, naming
/// them by object id in its `look`). The mock mints new object ids for every object but the root on every read of the file,
/// as a kit that builds its replica from the file does; only tool ids and the root's id survive.
/// Object ids also sit inside json values (a picture's `look` names its medium, a slide's `props`
/// has its layout's id as a key) and in map keys (the table's cells, `<row id>:<column id>`).
fn talk() -> String {
    deck_of(10)
}

/// A talk of `slides` slides (ids 11 on), as [`talk`] describes.
fn deck_of(slides: u64) -> String {
    let mut lines = vec!["layout Title=big".to_owned(), "layout Plain=small".to_owned(), "media logo=PNG1".to_owned(), "media chart=PNG2".to_owned()];
    for id in 11..11 + slides {
        let layout = if id % 2 == 1 { "Title" } else { "Plain" };
        let picture = if id == 20 { "|4=Logo^logo" } else { "" };
        let table = if id == 13 { "|5%a,b;c,d" } else { "" };
        let connector = if matches!(id, 16 | 18 | 26 | 36) { "|6>1,2" } else { "" };
        lines.push(format!("{id}@{layout}:1=Title {id}|2=Body {id}|3=Footer {id}{picture}{table}{connector}"));
    }
    lines.join("\n")
}

/// The deck's file written again unchanged by another program, in another form: a comment line,
/// the media lines before the layout lines, the slides after, each line ended by `\r\n`.
fn resaved(text: &str) -> String {
    let saves = text.lines().filter(|line| line.starts_with("//")).count() + 1;
    let note = format!("// saved again by another program ({saves})");
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    let mut out = vec![note.as_str()];
    out.extend(lines.iter().filter(|line| line.starts_with("//")));
    out.extend(lines.iter().filter(|line| line.starts_with("media ")));
    out.extend(lines.iter().filter(|line| line.starts_with("layout ")));
    out.extend(lines.iter().filter(|line| !line.starts_with("media ") && !line.starts_with("layout ") && !line.starts_with("//")));
    out.join("\r\n") + "\r\n"
}

impl Fixture {
    fn talk(name: &str) -> Option<Self> {
        Self::new(name, NESTED_ENV, &talk())
    }

    /// The file as another program writes it: `edit` applied to the text now on disk.
    fn colleague(&self, edit: impl FnOnce(&str) -> String) {
        let now = self.read();
        let changed = edit(&now);
        assert_ne!(changed, now, "the colleague's edit changes the file");
        self.write_outside(&changed);
    }
}

/// `text` with `from` replaced by `to`, once, where it must be.
fn replaced(text: &str, from: &str, to: &str) -> String {
    assert!(text.contains(from), "`{from}` in {text}");
    text.replacen(from, to, 1)
}

/// A text edit as `others` and receipts name it: under the shape, at the path to its text.
fn text_edit(id: &str, before: &str, after: &str) -> Value {
    json!({ "id": id, "type": "Shape", "fields": ["body.paragraphs.0.text"], "edits": [{ "field": "body.paragraphs.0.text", "before": before, "after": after }] })
}

/// The bound on `others` for one text edit made in the file: one entry, not the whole deck.
const SMALL: usize = 512;

/// a. A colleague's program edits a text on another slide: my write with `basis` applies, and
/// `others` names exactly that shape, by tool id, with the path and the text before and after.
#[tokio::test]
async fn reread_an_unrelated_text_edit_in_the_file_applies_and_others_names_only_it() {
    let Some(f) = Fixture::talk("rra") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "Body 19", "Edited outside"));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:12/2", "Mine")] })).await;
    assert_eq!(
        ran["others"],
        json!({ "by": ["outside"], "created": [], "changed": [text_edit("shape:19/2", "Body 19", "Edited outside")], "moved": [], "deleted": [] }),
        "{ran}"
    );
    assert!(ran["others"].to_string().len() < SMALL, "{} bytes", ran["others"].to_string().len());
    assert!(f.read().contains("2=Mine") && f.read().contains("2=Edited outside"), "{}", f.read());
    f.shutdown().await;
}

/// b. The colleague edits the text of my target: refused as `changed`, nothing written; the retry
/// on the revision the refusal gives applies.
#[tokio::test]
async fn reread_a_text_edit_of_my_target_in_the_file_conflicts_and_the_retry_applies() {
    let Some(f) = Fixture::talk("rrb") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "Body 12", "Theirs"));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:12/2", "Mine")] })).await;
    assert_conflict(&refused);
    assert_eq!(refused["conflicts"], json!([{ "id": "shape:12/2", "reason": "changed" }]), "{refused}");
    assert_eq!(refused["others"]["changed"], json!([text_edit("shape:12/2", "Body 12", "Theirs")]), "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    let ran = f.ok(ME, "run", json!({ "basis": refused["revision"], "steps": [text_of("shape:12/2", "Mine")] })).await;
    assert_eq!(ran["changes"]["changed"], json!([text_edit("shape:12/2", "Theirs", "Mine")]), "{ran}");
    f.shutdown().await;
}

/// c. The colleague inserts a slide at the front: a write naming the shape by its composite id
/// applies (the shape did not change, only its slide's number); one addressing the slide by
/// number is refused as `relocated`, by the slide's tool id, with its number now, and writes
/// nothing.
#[tokio::test]
async fn reread_a_slide_inserted_before_my_part_relocates_a_part_number_and_not_a_composite_id() {
    let Some(f) = Fixture::talk("rrc") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "11@Title:", "21@Plain:1=New\n11@Title:"));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:15/2", "Mine")] })).await;
    assert_eq!(ids(&ran["others"]["created"]), ["shape:21/1", "slide:21"], "{ran}");
    assert_eq!(ids(&ran["others"]["changed"]), Vec::<&str>::new(), "{ran}");
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "target": { "slide": 5 }, "steps": [text_of("shape:15/1", "Mine")] })).await;
    assert_conflict(&refused);
    assert_eq!(refused["conflicts"], json!([{ "id": "slide:15", "reason": "relocated", "now": { "slide": 6 } }]), "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    f.shutdown().await;
}

/// c. The parts' list is followed through the agent's own earlier write and a read of the file that
/// gave the deck's root a new object id: after my slide inserted at the front and the colleague's
/// deletion of the slide after it, my write addressing the slide my basis numbered 2 (slide 12)
/// is told it was relocated, not that slide 11 was deleted.
#[tokio::test]
async fn reread_a_part_number_is_followed_through_my_write_and_the_files_new_root() {
    let Some(f) = Fixture::talk("rrcroot") else { return };
    let basis = f.revision(ME).await;
    f.ok(ME, "run", json!({ "steps": [{ "command": "slide.insert", "params": { "index": 0 } }] })).await;
    f.colleague(|text| replaced(text, "11@Title:1=Title 11|2=Body 11|3=Footer 11\n", ""));
    let refused = f.refused(ME, "run", json!({ "basis": basis, "target": { "slide": 2 }, "steps": [text_of("shape:12/1", "Mine")] })).await;
    assert_eq!(refused["conflicts"], json!([{ "id": "slide:12", "reason": "relocated", "now": { "slide": 2 } }]), "{refused}");
    f.shutdown().await;
}

/// d. The colleague deletes my target's slide: refused as `deleted`, by the shape's id and by the
/// slide's number alike.
#[tokio::test]
async fn reread_my_targets_part_deleted_in_the_file_conflicts_as_deleted() {
    let Some(f) = Fixture::talk("rrd") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "15@Title:1=Title 15|2=Body 15|3=Footer 15\n", ""));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:15/2", "Mine")] })).await;
    assert_eq!(conflict(&refused, "shape:15/2")["reason"], "deleted", "{refused}");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "target": { "slide": 5 }, "steps": [text_of("shape:15/1", "Mine")] })).await;
    assert_eq!(conflict(&refused, "slide:15")["reason"], "deleted", "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    f.shutdown().await;
}

/// e. The colleague edits the shape with my target's per-slide number on another slide: my write
/// applies, by the shape's tool id and with the slide addressed by number.
#[tokio::test]
async fn reread_the_same_shape_number_edited_on_another_part_refuses_nothing() {
    let Some(f) = Fixture::talk("rre") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "Body 19", "Theirs"));
    f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:12/2", "Mine")] })).await;
    let ran = f.ok(ME, "run", json!({ "basis": basis, "target": { "slide": 2 }, "steps": [text_of("shape:12/2", "Mine again")] })).await;
    assert_eq!(ids(&ran["others"]["changed"]), ["shape:19/2"], "{ran}");
    assert!(f.read().contains("2=Mine again") && f.read().contains("2=Theirs"), "{}", f.read());
    f.shutdown().await;
}

/// f. `--guard epoch` refuses a's write; `--guard off` applies it and reports the same `others`.
#[tokio::test]
async fn reread_the_epoch_guard_refuses_and_the_guard_off_reports_the_same_small_others() {
    let Some(mut f) = Fixture::talk("rrf") else { return };
    f.options = CallOptions { guard: Guard::Epoch, ..CallOptions::default() };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "Body 19", "Edited outside"));
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:12/2", "Mine")] })).await;
    assert_eq!(refused["conflicts"], json!([{ "reason": "changed" }]), "{refused}");
    let told = json!({ "by": ["outside"], "created": [], "changed": [text_edit("shape:19/2", "Body 19", "Edited outside")], "moved": [], "deleted": [] });
    assert_eq!(refused["others"], told, "{refused}");
    f.options = CallOptions { guard: Guard::Off, ..CallOptions::default() };
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:12/2", "Mine")] })).await;
    assert_eq!(ran["others"], told, "{ran}");
    assert!(ran["others"].to_string().len() < SMALL);
    f.shutdown().await;
}

/// g. The colleague changes only a shared object without a tool id: the medium behind the picture,
/// or a layout slides use. `others` counts it by type (`unnamed`) instead of naming object ids
/// minted on this read; a write to the picture, or to a slide using the layout, is not refused:
/// their own fields did not change (a ref to an object paired across the read is equal), and a
/// shared object's change is another object's change, as for any object a write does not act on.
#[tokio::test]
async fn reread_a_shared_object_changed_in_the_file_is_counted_and_refuses_no_write_to_what_points_at_it() {
    let Some(f) = Fixture::talk("rrg") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "media logo=PNG1", "media logo=PNG9"));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:20/4", "Our logo")] })).await;
    assert_eq!(
        ran["others"],
        json!({ "by": ["outside"], "created": [], "changed": [], "moved": [], "deleted": [], "unnamed": { "Media": { "changed": 1 } } }),
        "{ran}"
    );
    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.colleague(|text| replaced(text, "layout Title=big", "layout Title=huge"));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "target": { "slide": 1 }, "steps": [text_of("shape:11/1", "Mine")] })).await;
    assert_eq!(ran["others"]["unnamed"], json!({ "Layout": { "changed": 1 } }), "{ran}");
    assert!(ran["others"].to_string().len() < SMALL);
    assert!(f.read().contains("media logo=PNG9") && f.read().contains("layout Title=huge") && f.read().contains("4=Our logo^logo"), "{}", f.read());
    f.shutdown().await;
}

/// h. The file is written again with the same deck (re-saved, byte-different): nothing changed,
/// so `others` is empty and nothing is refused, with `basis` or without.
#[tokio::test]
async fn reread_a_file_saved_again_unchanged_reports_and_refuses_nothing() {
    let Some(f) = Fixture::talk("rrh") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| format!("{text}\n\n"));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:12/2", "Mine")] })).await;
    assert!(ran.get("others").is_none(), "{ran}");
    f.colleague(|text| format!("\n{text}\n"));
    let ran = f.ok(ME, "run", json!({ "steps": [text_of("shape:12/2", "Mine again")] })).await;
    assert!(ran.get("changedOutside").is_none(), "{ran}");
    f.shutdown().await;
}

/// i. Two changes made in the file before my next call: `others` is both, merged, still small.
#[tokio::test]
async fn reread_two_file_changes_in_a_row_are_told_as_one_small_change() {
    let Some(f) = Fixture::talk("rri") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "Body 17", "First"));
    f.colleague(|text| replaced(text, "Body 18", "Second"));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:12/2", "Mine")] })).await;
    assert_eq!(ran["others"]["changed"], json!([text_edit("shape:17/2", "Body 17", "First"), text_edit("shape:18/2", "Body 18", "Second")]), "{ran}");
    assert!(ran["others"].to_string().len() < SMALL);
    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.colleague(|text| replaced(text, "First", "Third"));
    f.ok(ME, "inspect", json!({})).await;
    f.colleague(|text| replaced(text, "Second", "Fourth"));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:12/2", "Mine again")] })).await;
    assert_eq!(ran["others"]["changed"], json!([text_edit("shape:17/2", "First", "Third"), text_edit("shape:18/2", "Second", "Fourth")]), "{ran}");
    f.shutdown().await;
}

// ---- What a real slide kit showed after ----

/// p. A connector names the shapes it joins by their object ids inside its `look`, as a real slide
/// kit's do, though those shapes have tool ids: across a read of the file the ids are new, the
/// connector is not. An unrelated change in the file refuses no write on it, and `others` names
/// only the colleague's shape (the cause of a write refused as `changed` on an untouched target).
#[tokio::test]
async fn reread_a_connector_naming_shapes_by_object_id_is_unchanged_by_a_read() {
    let Some(f) = Fixture::talk("rrp") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "Body 19", "Edited outside"));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [{ "command": "shape.color", "params": { "id": "shape:16/6", "color": "red" } }] })).await;
    assert_eq!(ids(&ran["others"]["changed"]), ["shape:19/2"], "{ran}");
    assert!(ran["others"].to_string().len() < SMALL, "{ran}");
    assert!(f.read().contains("6>1,2#red"), "{}", f.read());
    f.shutdown().await;
}

/// j. The file is written again unchanged by another program in another form (a comment, its
/// lines in another order, `\r\n`): the deck's root keeps its id on every read, object ids sit in
/// json values and map keys. No notice, no refusal, no `others`, with `basis` or without.
#[tokio::test]
async fn reread_a_file_saved_again_in_another_form_with_a_constant_root_is_no_change() {
    let Some(f) = Fixture::talk("rrj") else { return };
    let basis = f.revision(ME).await;
    f.colleague(resaved);
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:12/2", "Mine")] })).await;
    assert!(ran.get("others").is_none(), "{ran}");
    assert!(ran.get("changedOutside").is_none(), "{ran}");
    f.colleague(resaved);
    let seen = f.ok(ME, "inspect", json!({})).await;
    assert!(seen.get("changedOutside").is_none(), "{seen}");
    f.colleague(resaved);
    let ran = f.ok(ME, "run", json!({ "steps": [text_of("shape:12/2", "Mine again")] })).await;
    assert!(ran.get("changedOutside").is_none(), "{ran}");
    assert_eq!(ran["changes"]["changed"], json!([text_edit("shape:12/2", "Mine", "Mine again")]), "{ran}");
    f.shutdown().await;
}

/// k. A layout change: counted in `unnamed`; writes on the slides using the layout (whose `props`
/// name the layout's id as a key) and on the picture (whose `look` names its medium) apply.
#[tokio::test]
async fn reread_a_layout_change_is_counted_and_writes_on_slides_and_pictures_apply() {
    let Some(f) = Fixture::talk("rrk") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "layout Title=big", "layout Title=huge"));
    let set = f.ok(ME, "batch", json!({ "basis": basis, "ops": [{ "op": "set", "target": "slide:13", "field": "props", "value": { "note": "mine" } }] })).await;
    assert_eq!(set["others"]["unnamed"], json!({ "Layout": { "changed": 1 } }), "{set}");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [{ "command": "shape.color", "params": { "id": "shape:13/1", "color": "red" } }] })).await;
    assert_eq!(
        ran["others"],
        json!({ "by": ["outside"], "created": [], "changed": [], "moved": [], "deleted": [], "unnamed": { "Layout": { "changed": 1 } } }),
        "{ran}"
    );
    f.ok(ME, "run", json!({ "basis": basis, "steps": [{ "command": "shape.color", "params": { "id": "shape:20/4", "color": "blue" } }] })).await;
    f.shutdown().await;
}

/// l. Another program numbers a slide's shapes again: the title and the body swap numbers, their
/// content unchanged. Nothing is told as changed into the other's text; `others` says in one line
/// which ids were renumbered; a write on either is refused as `unknown` and says to inspect again;
/// a retry with the refusal's revision is refused again (the revision does not make the stale ids
/// current), and after an inspect the agent writes where it means to.
#[tokio::test]
async fn reread_shapes_renumbered_by_another_program_are_unknown_until_inspected_again() {
    let Some(f) = Fixture::talk("rrl") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "12@Plain:1=Title 12|2=Body 12|", "12@Plain:2=Title 12|1=Body 12|"));
    let before = f.read();
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:12/2", "Mine")] })).await;
    assert_eq!(refused["error"]["code"], "conflict", "{refused}");
    assert_eq!(refused["conflicts"], json!([{ "id": "shape:12/2", "reason": "unknown" }]), "{refused}");
    assert!(refused["error"]["message"].as_str().is_some_and(|message| message.contains("renumbered") && message.contains("inspect")), "{refused}");
    let others = &refused["others"];
    assert_eq!(others["changed"], json!([]), "no fabricated text changes: {others}");
    assert_eq!(others["moved"], json!([]), "{others}");
    assert!(others["renumbered"].as_str().is_some_and(|line| line.contains("shape:12/1") && line.contains("shape:12/2")), "{others}");
    assert_eq!(f.read(), before, "nothing written");
    let again = f.refused(ME, "run", json!({ "basis": refused["revision"], "steps": [text_of("shape:12/2", "Mine")] })).await;
    assert_eq!(again["conflicts"], json!([{ "id": "shape:12/2", "reason": "unknown" }]), "the refusal's revision does not launder the stale id: {again}");
    assert_eq!(f.read(), before, "nothing written into the other shape");
    // A write on another shape applies.
    f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:14/2", "Elsewhere")] })).await;
    let seen = f.ok(ME, "inspect", json!({ "target": { "slide": 2 } })).await;
    let body = seen["part"]["shapes"]
        .as_array()
        .and_then(|shapes| shapes.iter().find(|shape| shape["text"] == "Body 12"))
        .cloned()
        .unwrap_or_else(|| panic!("{seen}"));
    assert_eq!(body["id"], "shape:12/1", "{seen}");
    f.ok(ME, "run", json!({ "basis": seen["revision"], "steps": [text_of("shape:12/1", "Mine")] })).await;
    assert!(f.read().contains("12@Plain:2=Title 12|1=Mine|"), "{}", f.read());
    f.shutdown().await;
}

/// m. A slide duplicated by another program after a change of more objects than `others` lists:
/// parts created come first, then the objects the write targets, then the rest; `truncated` counts
/// what was left out by list.
#[tokio::test]
async fn reread_a_duplicated_slide_and_my_targets_are_told_first_when_others_is_capped() {
    let Some(f) = Fixture::new("rrm", NESTED_ENV, &deck_of(25)) else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| {
        let mut text = text.to_owned();
        for id in 11..=30 {
            for n in 1..=3 {
                let kind = ["Title", "Body", "Footer"][n - 1];
                text = replaced(&text, &format!("{n}={kind} {id}"), &format!("{n}={kind} {id}!"));
            }
        }
        let copy = text.lines().find(|line| line.starts_with("33@")).unwrap_or_default().replacen("33@", "99@", 1);
        replaced(&text, "\n34@", &format!("\n{copy}\n34@"))
    });
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:30/2", "Mine")] })).await;
    let others = &refused["others"];
    assert!(ids(&others["created"]).contains(&"slide:99"), "the duplicated slide is named: {others}");
    assert!(ids(&others["changed"]).contains(&"shape:30/2"), "the write's target is named: {others}");
    assert_eq!(others["truncated"]["changed"].as_u64().unwrap_or(0) + ids(&others["changed"]).len() as u64, 60, "{others}");
    assert_eq!(conflict(&refused, "shape:30/2")["reason"], "changed", "{refused}");
    f.shutdown().await;
}

/// n. A table cell edited in the file: one edit under the table's shape, at the path to the cell's
/// text, before and after; no other cell listed. A write on the table is refused as `changed`, one
/// on another shape applies.
#[tokio::test]
async fn reread_a_table_cell_edit_is_one_edit_under_the_tables_shape() {
    let Some(f) = Fixture::talk("rrn") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "5%a,b;c,d", "5%a,B!;c,d"));
    let refused =
        f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "shape.color", "params": { "id": "shape:13/5", "color": "red" } }] })).await;
    assert_eq!(refused["conflicts"], json!([{ "id": "shape:13/5", "reason": "changed" }]), "{refused}");
    let changed = &refused["others"]["changed"];
    assert_eq!(ids(changed), ["shape:13/5"], "{refused}");
    let fields = changed[0]["fields"].as_array().cloned().unwrap_or_default();
    assert_eq!(fields.len(), 1, "one cell: {changed}");
    let field = fields[0].as_str().unwrap_or_default();
    assert!(field.starts_with("table.cells.") && field.ends_with(".body.paragraphs.0.text"), "{changed}");
    assert_eq!(changed[0]["edits"], json!([{ "field": field, "before": "b", "after": "B!" }]), "{changed}");
    assert!(refused["others"].to_string().len() < SMALL, "{} bytes", refused["others"].to_string().len());
    f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:13/2", "Other")] })).await;
    f.shutdown().await;
}

/// o. On a deck of 40 slides and over 400 objects, an outside change followed by a write with
/// `basis` on an untouched target, 50 times in a row: every write applies, and `others` names only
/// the colleague's shape.
#[tokio::test]
async fn reread_fifty_outside_changes_on_a_large_deck_never_refuse_an_untouched_target() {
    let Some(f) = Fixture::new("rro", NESTED_ENV, &deck_of(40)) else { return };
    let mut basis = f.revision(ME).await;
    for at in 0..50u64 {
        let was = if at == 0 { "Footer 29\n".to_owned() } else { format!("Footer 29 {}\n", at - 1) };
        f.colleague(|text| replaced(text, &was, &format!("Footer 29 {at}\n")));
        let target = format!("shape:{}/2", 11 + (at % 15));
        let ran = f.call(ME, "run", json!({ "basis": basis, "steps": [text_of(&target, &format!("m{at}"))] })).await;
        let ran = ran.unwrap_or_else(|refused| panic!("write {at} on {target} refused: {refused}"));
        assert_eq!(ids(&ran["others"]["changed"]), ["shape:29/3"], "{at}: {ran}");
        basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    }
    f.shutdown().await;
}

/// R6: what a write with `basis` costs on the talk (ten slides, thirty shapes with text): (a) with
/// no change made in the file, (b) after an unrelated change (it applies), (c) after a change of
/// its target (refused); and the size of `others` in (b). Reported (median of 10), not asserted:
/// the machine is shared.
#[tokio::test]
async fn overhead_of_a_write_after_a_file_change_on_a_deck() {
    let Some(f) = Fixture::talk("rrcost") else { return };
    let mut report = Vec::new();
    let mut bytes = 0;
    for case in ["no change", "unrelated change", "conflicting change"] {
        let mut times = Vec::new();
        for at in 0..10 {
            let basis = f.revision(ME).await;
            // Each case writes its own shape, so one case's writes leave the next case's alone.
            let target = match case {
                "unrelated change" => {
                    let was = if at == 0 { "Footer 19\n".to_owned() } else { format!("Footer 19 {}\n", at - 1) };
                    f.colleague(|text| replaced(text, &was, &format!("Footer 19 {at}\n")));
                    "shape:14/3"
                }
                "conflicting change" => {
                    f.colleague(|text| replaced(text, "|3=Footer 15", &format!("|3=Footer 15 {at}")));
                    "shape:15/3"
                }
                _ => "shape:13/3",
            };
            let input = json!({ "basis": basis, "steps": [text_of(target, &format!("m{at}"))] });
            let started = Instant::now();
            let answer = f.call(ME, "run", input).await;
            times.push(started.elapsed());
            match (case, &answer) {
                ("conflicting change", Err(refused)) => assert_eq!(refused["error"]["code"], "conflict", "{refused}"),
                ("unrelated change", Ok(ran)) => bytes = ran["others"].to_string().len(),
                ("no change", Ok(_)) => {}
                _ => panic!("{case}: {answer:?}"),
            }
        }
        times.sort();
        report.push(format!("{case}: {:.2} ms", times[times.len() / 2].as_secs_f64() * 1000.0));
    }
    eprintln!("a write with basis on a 10-slide deck (median of 10): {}; `others` after an unrelated change: {bytes} bytes", report.join("; "));
    f.shutdown().await;
}

// ---- Every object a step names is a premise  ----

/// q. A command declares its targets as `ids` and takes one shape as `id` too (a real slide kit's
/// `drawing.delete`): named in `id`, the shape the colleague changed is a premise all the same, and
/// the step is refused as `changed` with nothing written; in `ids`, as before.
#[tokio::test]
async fn named_a_target_in_a_parameter_the_command_does_not_declare_is_a_premise() {
    let Some(f) = Fixture::talk("nmid") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "Body 12", "Theirs"));
    let before = f.read();
    for params in [json!({ "id": "shape:12/2" }), json!({ "ids": ["shape:12/2"] })] {
        let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "shapes.delete", "params": params }] })).await;
        assert_conflict(&refused);
        assert_eq!(refused["conflicts"], json!([{ "id": "shape:12/2", "reason": "changed" }]), "{params}: {refused}");
        assert_eq!(f.read(), before, "nothing written");
    }
    f.shutdown().await;
}

/// q. A step names shapes in parameters that are no targets (`from`, `to` of a connector): the
/// shape the colleague deleted is refused as `deleted`; a text parameter whose value names no
/// object is no premise, so a write on another shape applies; one naming an untouched shape applies.
#[tokio::test]
async fn named_ids_in_any_parameter_are_premises_and_free_text_is_not() {
    let Some(f) = Fixture::talk("nmconn") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "|3=Footer 17", ""));
    let before = f.read();
    let connect = |to: &str| json!({ "command": "shape.connect", "params": { "id": "shape:16/6", "from": "shape:16/1", "to": to } });
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [connect("shape:17/3")] })).await;
    assert_conflict(&refused);
    assert_eq!(refused["conflicts"], json!([{ "id": "shape:17/3", "reason": "deleted" }]), "{refused}");
    assert_eq!(f.read(), before, "nothing written");
    f.ok(ME, "run", json!({ "basis": basis, "steps": [connect("shape:17/2")] })).await;
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:12/2", "Footer 17"), text_of("shape:12/1", "shape:99/9")] })).await;
    assert_eq!(ids(&ran["others"]["deleted"]), ["shape:17/3"], "{ran}");
    f.shutdown().await;
}

/// q. Another agent changed a shape a batch's `command` operation names in a parameter its command
/// does not declare: refused as `changed`, as a run's step is.
#[tokio::test]
async fn named_a_batch_command_operation_names_premises_in_any_parameter() {
    let Some(f) = Fixture::new("nmbatch", &format!("{NESTED_ENV} KITION_KIT_MOCK_BATCH=commands"), &talk()) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [text_of("shape:16/2", "Theirs")] })).await;
    let op = json!({ "op": "command", "id": "shape.connect", "params": { "id": "shape:16/6", "from": "shape:16/1", "to": "shape:16/2" } });
    let refused = f.refused(ME, "batch", json!({ "basis": basis, "ops": [op] })).await;
    assert_eq!(refused["conflicts"], json!([{ "id": "shape:16/2", "reason": "changed" }]), "{refused}");
    f.shutdown().await;
}

// ---- No id the agent cannot use  ----

/// s. A table cell edited in the file is told at a path naming the cell by the positions of its
/// row and column (`table.cells.0:1`), never by their object ids, which the next read mints anew;
/// a slide created in the file with a layout names the layout `{ "unnamed": "Layout" }`, not by
/// its object id.
#[tokio::test]
async fn usable_others_name_a_cell_by_position_and_a_shared_layout_as_unnamed() {
    let Some(f) = Fixture::talk("usable") else { return };
    let basis = f.revision(ME).await;
    f.colleague(|text| replaced(text, "5%a,b;c,d", "5%a,B!;c,d"));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:13/2", "Other")] })).await;
    assert_eq!(
        ran["others"]["changed"],
        json!([{ "id": "shape:13/5", "type": "Shape", "fields": ["table.cells.0:1.body.paragraphs.0.text"], "edits": [{ "field": "table.cells.0:1.body.paragraphs.0.text", "before": "b", "after": "B!" }] }]),
        "{ran}"
    );
    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.colleague(|text| replaced(text, "11@Title:", "21@Plain:1=New\n11@Title:"));
    // `others` tells a created object's values in full only for `changes: "all"`.
    let ran = f.ok(ME, "run", json!({ "basis": basis, "changes": "all", "steps": [text_of("shape:13/2", "Again")] })).await;
    let slide = ran["others"]["created"]
        .as_array()
        .and_then(|created| created.iter().find(|item| item["id"] == "slide:21"))
        .cloned()
        .unwrap_or_else(|| panic!("{ran}"));
    assert_eq!(slide["values"]["layout"], json!({ "unnamed": "Layout" }), "{ran}");
    f.shutdown().await;
}

// ---- Documents of any size  ----

/// r. A deck of over 20,000 objects (2,100 slides of ten objects each: the slide, three shapes,
/// their bodies and paragraphs), as a real 1,044-slide deck was: an unrelated change made in the
/// file is told object by object, and a write with `basis` on an untouched shape applies, three
/// times in a row (each takes tens of seconds in a debug build). Before, a document over 20,000 objects was not walked, so every such write was
/// refused as `unknown`.
#[tokio::test]
async fn large_a_deck_over_twenty_thousand_objects_keeps_the_precise_guard() {
    let Some(f) = Fixture::new("lgdeck", NESTED_ENV, &deck_of(2100)) else { return };
    let mut basis = f.revision(ME).await;
    let mut refused = 0;
    for at in 0..3u64 {
        let was = if at == 0 { "Footer 29\n".to_owned() } else { format!("Footer 29 {}\n", at - 1) };
        f.colleague(|text| replaced(text, &was, &format!("Footer 29 {at}\n")));
        let started = Instant::now();
        match f.call(ME, "run", json!({ "basis": basis, "steps": [text_of(&format!("shape:{}/2", 1000 + at), &format!("m{at}"))] })).await {
            Ok(ran) => {
                assert_eq!(ids(&ran["others"]["changed"]), ["shape:29/3"], "{at}: {ran}");
                basis = ran["revision"].as_str().unwrap_or_default().to_owned();
            }
            Err(error) => {
                eprintln!("write {at} refused: {}", error["conflicts"]);
                refused += 1;
                basis = error["revision"].as_str().unwrap_or_default().to_owned();
            }
        }
        eprintln!("write {at} after a file change on a 2,100-slide deck: {:.2} s", started.elapsed().as_secs_f64());
    }
    assert_eq!(refused, 0, "no write on an untouched shape is refused");
    f.shutdown().await;
}

/// r. The journal's object budget drops old entries, never the newest: a change of more objects
/// than the budget keeps the revision handed out before it usable (the change is told, a write on
/// an untouched shape applies); the entry before it is dropped, so a basis before that is
/// `unknown`.
#[tokio::test]
async fn large_the_journals_budget_never_drops_the_newest_entry() {
    let Some(f) = Fixture::with("lgbudget", NESTED_ENV, &talk(), |kits| kits.with_journal_limits(256, 5)) else { return };
    let oldest = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [text_of("shape:11/1", "Theirs")] })).await;
    let basis = f.revision(ME).await;
    f.colleague(|text| {
        let mut text = text.to_owned();
        for id in 14..=20 {
            text = replaced(&text, &format!("Footer {id}"), &format!("Footer {id}!"));
        }
        text
    });
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:12/2", "Mine")] })).await;
    assert_eq!(ids(&ran["others"]["changed"]).len(), 7, "{ran}");
    let refused = f.refused(ME, "run", json!({ "basis": oldest, "steps": [text_of("shape:12/1", "Mine")] })).await;
    assert_eq!(refused["conflicts"], json!([{ "reason": "unknown" }]), "{refused}");
    f.shutdown().await;
}

// ---- Options and bounds ----

#[tokio::test]
async fn options_require_basis_refuses_writes_without_one_and_says_where_a_revision_comes_from() {
    let Some(mut f) = Fixture::deck("gdreq") else { return };
    f.options = CallOptions { require_basis: true, ..CallOptions::default() };
    let refused = f.refused(ME, "run", json!({ "steps": [text_of("shape:1", "Mine")] })).await;
    assert_eq!(refused["error"]["code"], "invalid-params", "{refused}");
    assert!(refused["error"]["message"].as_str().is_some_and(|message| message.contains("revision") && message.contains("basis")), "{refused}");
    let refused = f.refused(ME, "batch", json!({ "ops": [{ "op": "set", "target": "shape:1", "field": "text", "value": "x" }] })).await;
    assert_eq!(refused["error"]["code"], "invalid-params", "{refused}");
    let basis = f.revision(ME).await;
    f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:1", "Mine")] })).await;
    f.shutdown().await;
}

#[tokio::test]
async fn options_a_basis_older_than_the_journal_is_unknown_and_the_journal_keeps_its_bound() {
    let Some(f) = Fixture::with("gdbound", "KITION_KIT_MOCK_PARTS=deck", DECK, |kits| kits.with_journal_limits(3, 1000)) else { return };
    let basis = f.revision(ME).await;
    for at in 0..4 {
        f.ok(OTHER, "run", json!({ "steps": [text_of("shape:5", &format!("v{at}"))] })).await;
    }
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:1", "Mine")] })).await;
    assert_eq!(refused["conflicts"], json!([{ "reason": "unknown" }]), "{refused}");
    // A basis the journal still covers works.
    let recent = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [text_of("shape:5", "v4")] })).await;
    let ran = f.ok(ME, "run", json!({ "basis": recent, "steps": [text_of("shape:1", "Mine")] })).await;
    assert_eq!(ids(&ran["others"]["changed"]), ["shape:5"], "{ran}");
    f.shutdown().await;

    // The object budget bounds it too, dropping old entries and never the newest: one
    // write of more objects than the budget is kept alone, so the basis before it is still
    // covered; the next entry drops it, and that basis is then unknown.
    let Some(f) = Fixture::with("gdbudget", "KITION_KIT_MOCK_PARTS=deck", DECK, |kits| kits.with_journal_limits(100, 5)) else { return };
    let basis = f.revision(ME).await;
    let ops: Vec<Value> = (0..8).map(|_| json!({ "op": "create", "type": "Shape", "in": "slide:2.shapes", "fields": { "text": "new" } })).collect();
    f.ok(OTHER, "batch", json!({ "ops": ops })).await;
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:1", "Mine")] })).await;
    assert_eq!(ran["others"]["by"], json!([OTHER]), "{ran}");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [text_of("shape:1", "Mine again")] })).await;
    assert_eq!(refused["conflicts"], json!([{ "reason": "unknown" }]), "{refused}");
    f.shutdown().await;
}

#[tokio::test]
async fn options_the_revision_is_short_and_on_every_result_and_others_is_capped() {
    let Some(f) = Fixture::deck("gdshort") else { return };
    let inspected = f.ok(ME, "inspect", json!({})).await;
    let queried = f.ok(ME, "query", json!({})).await;
    let ran = f.ok(ME, "run", json!({ "steps": [text_of("shape:1", "Mine")] })).await;
    let set = f.ok(ME, "batch", json!({ "ops": [{ "op": "set", "target": "shape:2", "field": "text", "value": "Mine" }] })).await;
    for answer in [&inspected, &queried, &ran, &set] {
        let revision = answer["revision"].as_str().unwrap_or_else(|| panic!("a revision: {answer}"));
        assert!(!revision.is_empty() && revision.len() <= 6, "a revision is a few characters: {revision}");
    }
    assert_eq!(inspected["revision"], queried["revision"], "nothing changed between the two reads");
    assert_ne!(ran["revision"], inspected["revision"], "a write moves the revision");
    assert!(inspected["interface"].as_str().is_some_and(|interface| interface.contains("kit.gdshort") && interface.contains("0.3.1")), "{inspected}");

    let basis = set["revision"].as_str().unwrap_or_default().to_owned();
    let ops: Vec<Value> =
        (0..60).map(|at| json!({ "op": "create", "type": "Shape", "in": "slide:2.shapes", "fields": { "text": format!("n{at}") } })).collect();
    f.ok(OTHER, "batch", json!({ "ops": ops })).await;
    let seen = f.ok(ME, "inspect", json!({ "basis": basis })).await;
    let others = &seen["others"];
    let listed: usize = ["created", "changed", "moved", "deleted"].iter().map(|list| others[*list].as_array().map_or(0, Vec::len)).sum();
    assert_eq!(listed, 50, "others is capped as receipts are: {others}");
    // 60 shapes created and no entry for slide 2's list: 10 left out.
    assert_eq!(others["truncated"]["created"], 10, "{others}");
    f.shutdown().await;
}

// ---- Principals ----

/// An MCP connection to `kits`: its session, and its tool calls.
struct Connection<'a> {
    kits: &'a KitManager,
    session: mcp::Session,
    next: std::cell::Cell<u64>,
}

impl<'a> Connection<'a> {
    async fn open(kits: &'a KitManager, client: &str) -> (Self, Value) {
        let connection = Self { kits, session: mcp::Session::default(), next: std::cell::Cell::new(1) };
        let init = connection
            .request("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": client, "version": "1" } }))
            .await;
        (connection, init)
    }

    async fn request(&self, method: &str, params: Value) -> Value {
        let id = self.next.get();
        self.next.set(id + 1);
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        mcp::handle_in(self.kits, &self.session, &message, CallOptions::default()).await.unwrap_or_default()["result"].clone()
    }

    /// A tool's structured content.
    async fn tool(&self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({ "name": name, "arguments": arguments })).await["structuredContent"].clone()
    }
}

#[tokio::test]
async fn principals_two_connections_are_two_agents_and_an_agents_undo_never_takes_back_anothers_edit() {
    let Some(f) = Fixture::deck("gdwho") else { return };
    let path = f.path();
    let (alpha, init) = Connection::open(&f.kits, "alpha client").await;
    let (beta, _) = Connection::open(&f.kits, "alpha client").await;
    assert_eq!(init["serverInfo"]["version"], "0.3.1", "{init}");

    let seen = alpha.tool("gdwho_inspect", json!({ "path": path })).await;
    assert!(seen["interface"].as_str().is_some_and(|interface| interface.contains(init["serverInfo"]["version"].as_str().unwrap_or("?"))), "{seen}");
    let basis = seen["revision"].clone();
    beta.tool("gdwho_run", json!({ "path": path, "steps": [text_of("shape:3", "Beta")] })).await;
    let ran = alpha.tool("gdwho_run", json!({ "path": path, "basis": basis, "steps": [text_of("shape:1", "Alpha")] })).await;
    let by = ran["others"]["by"].as_array().cloned().unwrap_or_default();
    assert_eq!(by.len(), 1, "{ran}");
    let beta_name = by[0].as_str().unwrap_or_default().to_owned();
    assert!(beta_name.starts_with("alpha-client-"), "the client's name and a suffix: {beta_name}");
    let mine = beta.tool("gdwho_inspect", json!({ "path": path, "basis": basis })).await;
    let alpha_name = mine["others"]["by"][0].as_str().unwrap_or_default().to_owned();
    assert!(alpha_name.starts_with("alpha-client-") && alpha_name != beta_name, "same client, another connection, another agent: {alpha_name} {beta_name}");

    // Beta's edit is the latest: alpha's undo would take it back, so it is refused.
    beta.tool("gdwho_run", json!({ "path": path, "steps": [text_of("shape:4", "Beta again")] })).await;
    let undo = alpha.tool("gdwho_run", json!({ "path": path, "steps": [{ "command": "edit.undo" }] })).await;
    assert_eq!(undo["error"]["code"], "conflict", "{undo}");
    assert_eq!(f.read(), "1:1=Alpha|2=Body|3=Beta\n2:4=Beta again|5=More", "nothing was undone");
    let undone = beta.tool("gdwho_run", json!({ "path": path, "steps": [{ "command": "edit.undo" }] })).await;
    assert!(undone.get("error").is_none(), "{undone}");
    assert_eq!(f.read(), "1:1=Alpha|2=Body|3=Beta\n2:4=Second|5=More", "beta's undo took back beta's last edit only");
    f.shutdown().await;
}

#[tokio::test]
async fn principals_a_server_without_sessions_still_names_its_agent_and_the_editor_path_says_the_guard_is_unavailable() {
    let live = kit("gdlive");
    let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(live, None)]);
    let bridge = kits.bridge().clone();
    let (session, mut rx) = bridge.connect();
    tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let Some(id) = message["id"].as_u64() else { continue };
            let mut reply = match (message["method"].as_str(), message["params"]["tool"].as_str()) {
                (Some("kit/documents"), _) => {
                    json!({ "result": { "documents": [{ "path": "a.gdlive", "kit": "kit.gdlive", "dirty": false, "revision": 1 }] } })
                }
                (Some("kit/call"), Some("run")) => {
                    json!({ "result": { "completed": [{ "command": "text.append" }], "saved": true, "document": { "summary": "x" } } })
                }
                (Some("kit/preview"), _) => json!({ "error": { "code": -32000, "message": "no preview" } }),
                _ => json!({ "error": { "code": -32000, "message": "unexpected call" } }),
            };
            reply["jsonrpc"] = json!("2.0");
            reply["id"] = json!(id);
            let _ = bridge.receive(session, &reply);
        }
    });
    let input = json!({ "path": "a.gdlive", "basis": "x1", "steps": [{ "command": "text.append", "params": { "text": "!" } }] });
    let answer = tools::call(&kits, "gdlive_run", &input).await.unwrap_or_else(|| panic!("a kit tool")).expect_err("a basis needs editor history").structured();
    assert_eq!(answer["error"]["code"], "conflict", "{answer}");
    assert_eq!(answer["conflicts"][0]["reason"], "unknown", "{answer}");
    kits.shutdown().await;
}

// ---- Cost ----

/// What the journal and the guard cost on the mock: runs of one step without and with `basis`.
/// Reported (median of 20), not asserted: the machine is shared.
#[tokio::test]
async fn overhead_of_the_journal_and_the_guard_on_the_mock() {
    let Some(f) = Fixture::deck("gdcost") else { return };
    let mut report = Vec::new();
    for with_basis in [false, true] {
        let mut times = Vec::new();
        for at in 0..21 {
            let basis = f.revision(ME).await;
            f.ok(OTHER, "run", json!({ "steps": [text_of("shape:5", &format!("o{at}"))], "save": false })).await;
            let mut input = json!({ "steps": [text_of("shape:1", &format!("m{at}"))], "save": false });
            if with_basis {
                input["basis"] = json!(basis);
            }
            let started = Instant::now();
            let ran = f.ok(ME, "run", input).await;
            if at > 0 {
                times.push(started.elapsed());
            }
            if at == 1 && with_basis {
                eprintln!("a typical `others`: {} bytes, `revision` {} bytes", ran["others"].to_string().len(), ran["revision"].to_string().len());
            }
        }
        times.sort();
        report.push(format!("{}: {:.2} ms", if with_basis { "with basis" } else { "without basis" }, times[times.len() / 2].as_secs_f64() * 1000.0));
    }
    eprintln!("journal and guard on the mock (median of 20 runs): {}", report.join("; "));
    f.shutdown().await;
}
