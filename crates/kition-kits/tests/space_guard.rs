// Copied from kition-sdk crates/kition-kits/tests/space_guard.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The premise guard in space, against the mock kit's scenes of nodes
//! (`KITION_KIT_MOCK_PARTS=space`: nodes with integer keys, a json `location` and an integer
//! `parent` the schema marks as their position, a mesh whose faces and vertices commands address
//! by index, and commands that name a node by key, by name, or by a world point, `pick`).
//!
//! - A position field told at a leaf (`location.0`, one coordinate) is a position: a one-axis move
//!   is `relocated`, a position-independent write applies after it.
//! - Where a refused object is now (`now`) keeps the list it is in (`parent`, `field`, `index`)
//!   apart from its position fields; a position field named like one of those is in `now.fields`.
//! - A target parameter that takes one id or a list (`oneOf [integer, string, array]`) is a
//!   declared target.
//! - A place in space the kit cannot declare as a window (`pick`) says `covers`, and the guard asks
//!   the kit (`context.covered`) whether the objects others moved were under it at `basis`.
//! - A derived value (`~topology`) is in change sets, the journal and premises.
//!
//! Cases: `regressions/issue-guard-position-leaf`, `regressions/issue-guard-now-fields`,
//! `regressions/issue-guard-targets-one-or-many`, `sdk.agent.premise-guard/covers`,
//! `sdk.agent.premise-guard/derived`, `regressions/issue-guard-integer-params`.
//!
//! The mock kit executable is built with the workspace (`cargo build -p kition-kit-mock`); when
//! it is missing locally, tests that can skip it say so and pass. CI requires it.
#![cfg(unix)]

#[path = "support/editor.rs"]
mod editor;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use kition_kits::tools::{self, CallOptions, Guard};
use kition_kits::{KitDefinition, KitManager};
use serde_json::{Value, json};

fn kit(name: &str) -> &'static KitDefinition {
    let manifest = json!({
        "khp": "1.0", "id": format!("kit.{name}"), "name": format!("Kition {name}"), "version": "0.3.1",
        "formats": [{ "id": name, "extensions": [name], "role": "edit" }],
        "agent": { "prefix": name, "tools": "document" },
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
    let world = if matches!(name, "mderived" | "msmodes" | "mderivedprivate" | "mderivedfailure") { "KITION_KIT_MOCK_WORLD_DERIVED=1" } else { "" };
    let private = match name {
        "mderivedprivate" => "KITION_KIT_MOCK_PRIVATE_DERIVED=1",
        "mprivatecoverage" => "KITION_KIT_MOCK_PRIVATE_BOUNDS=1",
        _ => "",
    };
    let failure = if name == "mderivedfailure" { "KITION_KIT_MOCK_DERIVED_FAILURE=1" } else { "" };
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nKITION_KIT_MOCK_AS=kit.{name}:{name} KITION_KIT_MOCK_VERSION=0.3.1 KITION_KIT_MOCK_PARTS=space {world} {private} {failure} exec '{}' \"$@\"\n",
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
async fn root_list_window_alone_is_a_premise() {
    for outside in [false, true] {
        for edit in ["reorder", "delete", "before", "after"] {
            let initial = scene(9);
            let f = Fixture::new("mrootwindow", &initial).expect("build mock");
            let basis = f.revision(ME).await;
            let mut changed = initial["nodes"].as_array().unwrap().clone();
            let ops = match edit {
                "delete" => {
                    changed.remove(3);
                    json!([{"op":"delete","target":4}])
                }
                "reorder" => {
                    changed.swap(3, 4);
                    json!([{"op":"list.move","target":"root","field":"nodes","from":3,"to":5}])
                }
                "before" => {
                    changed.remove(0);
                    json!([{"op":"delete","target":1}])
                }
                _ => {
                    changed.remove(8);
                    json!([{"op":"delete","target":9}])
                }
            };
            if outside {
                f.outside(|nodes| *nodes = changed);
            } else {
                f.ok(OTHER, "batch", json!({"ops":ops})).await;
            }
            let saved = std::fs::read(f.file()).unwrap();
            let result = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"node.rename","params":{"rootIndex":3,"name":"Agent"}}]})).await;
            if edit == "after" {
                result.unwrap_or_else(|e| panic!("{outside}/{edit}: {e}"));
            } else {
                let error = result.expect_err("a root-held window alone must refuse");
                assert_eq!(error["error"]["code"], "conflict", "{outside}/{edit}: {error}");
                assert_eq!(std::fs::read(f.file()).unwrap(), saved);
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn held_order_forms_matrix() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for mode in ["exact", "relative", "anchored", "window"] {
            for region in ["below", "between", "above", "held", "reparent"] {
                for edit in ["insert", "delete", "move"] {
                    if (region == "held" || region == "reparent") && edit != "move" {
                        continue;
                    }
                    let initial = scene(9);
                    let f = Fixture::new("morder", &initial).expect("build mock");
                    let basis = f.revision(ME).await;
                    let index = match region {
                        "below" => 0,
                        "between" => 4,
                        "above" => 7,
                        _ => 3,
                    };
                    let mut changed = initial["nodes"].as_array().unwrap().clone();
                    let ops = match edit {
                        "insert" => {
                            let mut node = changed[0].clone();
                            node["key"] = json!(10);
                            node["name"] = json!("New");
                            changed.insert(index, node);
                            json!([{"op":"create","type":"Node","fields":{"key":10,"name":"New","location":[50,0,0],"parent":null,"hidden":false,"mesh":cube()},"in":"root.nodes","at":index}])
                        }
                        "delete" => {
                            let id = changed.remove(index)["key"].clone();
                            json!([{"op":"delete","target":id}])
                        }
                        _ if region == "reparent" => {
                            changed.remove(index);
                            json!([{"op":"list.remove","target":"root","field":"nodes","index":index}])
                        }
                        _ => {
                            let to = if region == "held" { 7 } else { index + 1 };
                            let node = changed.remove(index);
                            changed.insert(to, node);
                            json!([{"op":"list.move","target":"root","field":"nodes","from":index,"to":if to > index {to+1} else {to}}])
                        }
                    };
                    if outside {
                        f.outside(|nodes| *nodes = changed);
                    } else {
                        f.ok(OTHER, "batch", json!({"ops":ops})).await;
                    }
                    let saved = std::fs::read(f.file()).unwrap();
                    let held = if mode == "anchored" { json!([4, 5, 6, 7]) } else { json!([4, 7]) };
                    let result = f
                        .call(
                            ME,
                            "run",
                            json!({"basis":basis,"steps":[{"command":"node.rename","params":{"node":4,"name":"Agent","orderMode":mode,"held":held}}]}),
                        )
                        .await;
                    let conflict = region == "held"
                        || region == "reparent"
                        || match mode {
                            "exact" => region != "above" && edit != "move",
                            "anchored" => region == "between" && edit != "insert",
                            "window" => region != "above" && !(region == "below" && edit == "move"),
                            _ => false,
                        };
                    if conflict {
                        if !result.as_ref().err().is_some_and(|e| {
                            e["error"]["code"] == "conflict"
                                && e["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == "relocated" || c["reason"] == "deleted"))
                        }) {
                            failures.push(format!("{outside}/{mode}/{region}/{edit}: expected refusal: {result:?}"));
                        }
                        assert_eq!(std::fs::read(f.file()).unwrap(), saved, "refusal changed bytes");
                    } else if let Err(error) = result {
                        failures.push(format!("{outside}/{mode}/{region}/{edit}: false refusal: {error}"));
                    }
                    f.shutdown().await;
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn failed_indirect_derived_reads_refuse_unknown() {
    for outside in [false, true] {
        let mut initial = scene(3);
        initial["nodes"][1]["parent"] = json!(1);
        let f = Fixture::new("mderivedfailure", &initial).expect("build mock");
        let basis = f.revision(ME).await;
        if outside {
            f.outside(|nodes| {
                nodes[0]["location"] = json!([10, 0, 0]);
                nodes[0]["name"] = json!("Fail derived");
            });
        } else {
            f.ok(
                OTHER,
                "batch",
                json!({"ops":[{"op":"set","target":1,"field":"location","value":[10,0,0]},{"op":"set","target":1,"field":"name","value":"Fail derived"}]}),
            )
            .await;
        }
        let before = std::fs::read(f.file()).unwrap();
        let error = f.refused(ME, "run", json!({"basis":basis,"steps":[{"command":"node.rename","params":{"node":2,"name":"Agent","world":true}}]})).await;
        assert_eq!(error["error"]["code"], json!("conflict"), "{error}");
        assert!(error["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "unknown"), "{error}");
        assert_eq!(std::fs::read(f.file()).unwrap(), before);
        f.shutdown().await;
    }
}

#[tokio::test]
async fn premise_only_derived_facts_guard_without_public_changes() {
    for private in [false, true] {
        for outside in [false, true] {
            let mut initial = scene(3);
            initial["nodes"][1]["parent"] = json!(1);
            let f = Fixture::new(if private { "mderivedprivate" } else { "mderived" }, &initial).expect("build mock");
            let basis = f.revision(ME).await;
            if outside {
                f.outside(|nodes| nodes[0]["location"] = json!([10, 0, 0]));
            } else {
                let receipt = f.ok(OTHER, "batch", json!({"ops":[{"op":"set","target":1,"field":"location","value":[10,0,0]}]})).await;
                assert_eq!(receipt["changes"].to_string().contains("worldLocation"), !private, "{receipt}");
                assert_eq!(receipt["changes"]["changed"].as_array().unwrap().iter().any(|c| c["id"] == 2), !private, "{receipt}");
            }
            let saved = std::fs::read(f.file()).unwrap();
            let refused =
                f.refused(ME, "run", json!({"basis":basis,"steps":[{"command":"node.rename","params":{"node":2,"name":"Agent","world":true}}]})).await;
            assert_eq!(refused["error"]["code"], "conflict", "{refused}");
            assert!(refused["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "changed"), "{refused}");
            assert_eq!(refused["others"].to_string().contains("worldLocation"), !private, "{refused}");
            assert_eq!(std::fs::read(f.file()).unwrap(), saved);
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn mixed_public_private_coverage_keeps_the_earliest_private_value() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for related in [false, true] {
            for edits in [1, 2] {
                let f = Fixture::new("mprivatecoverage", &scene_with_floor(4)).expect("build the mock kit first");
                let basis = f.revision(ME).await;
                for step in 0..edits {
                    let mut mesh = cube();
                    for vertex in 4..8 {
                        mesh["verts"][vertex][0] = json!(-0.3 - f64::from(step) * 0.05);
                    }
                    if outside {
                        f.outside(|nodes| node_in(nodes, 2)["mesh"] = mesh);
                        // Observe each outside version so both edits enter the journal.
                        f.revision(OTHER).await;
                    } else {
                        let receipt = f.ok(OTHER, "batch", json!({"changes":"all","ops":[{"op":"set","target":2,"field":"mesh","value":mesh}]})).await;
                        assert!(!receipt["changes"].to_string().contains("~bounds"), "{receipt}");
                        assert!(receipt["changes"].get("$premises").is_none(), "{receipt}");
                        assert_eq!(receipt["changes"]["changed"].as_array().unwrap().iter().filter(|item| item["id"] == 2).count(), 1, "{receipt}");
                    }
                }
                let saved = std::fs::read(f.file()).unwrap();
                let point = json!([if related { 3.4 } else { 2.6 }, 0.0, 0.0]);
                let result = f.call(ME, "run", json!({"basis":basis,"changes":"all","steps":[rename_at(point, "Picked")]})).await;
                let label = format!("outside={outside}, related={related}, edits={edits}");
                if related {
                    match result {
                        Err(error) => {
                            assert_eq!(error["error"]["code"], "conflict", "{label}: {error}");
                            assert_eq!(conflict_on(&error, 2)["reason"], "relocated", "{label}: {error}");
                            assert!(!error["others"].to_string().contains("~bounds"), "{error}");
                            assert_eq!(std::fs::read(f.file()).unwrap(), saved, "{label}: a refusal must not write");
                        }
                        Ok(answer) => failures.push(format!("{label}: stale pick applied: {answer}")),
                    }
                } else {
                    let answer = result.unwrap_or_else(|error| panic!("{label}: unrelated pick must apply: {error}"));
                    assert_eq!(f.node(2)["name"], "Picked", "{label}");
                    assert!(!answer["others"].to_string().contains("~bounds"), "{answer}");
                    assert!(answer["others"].get("$premises").is_none(), "{answer}");
                }
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn derived_holder_named_or_not_matrix() {
    for outside in [false, true] {
        for named in [false, true] {
            for changed in [false, true] {
                let mut initial = scene(3);
                initial["nodes"][1]["parent"] = json!(1);
                let f = Fixture::new("mderived", &initial).expect("build mock");
                let basis = f.revision(ME).await;
                let target = if named { 2 } else { 1 };
                let field = if changed { "location" } else { "hidden" };
                let value = if changed { json!([10, 0, 0]) } else { json!(true) };
                if outside {
                    f.outside(|nodes| nodes[target - 1][field] = value.clone());
                } else {
                    f.ok(OTHER, "batch", json!({"ops":[{"op":"set","target":target,"field":field,"value":value}]})).await;
                }
                let saved = std::fs::read(f.file()).unwrap();
                let answer =
                    f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"node.rename","params":{"node":2,"name":"Agent","world":true}}]})).await;
                if changed {
                    let error = answer.expect_err("held derived fact changed");
                    assert_eq!(error["error"]["code"], "conflict", "{outside}/{named}: {error}");
                    assert!(error["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "changed"), "{error}");
                    assert_eq!(std::fs::read(f.file()).unwrap(), saved);
                } else {
                    answer.unwrap_or_else(|error| panic!("{outside}/{named}: {error}"));
                }
                println!("MATRIX derived-holder/{outside}/{named}/{changed}: PASS");
                f.shutdown().await;
            }
        }
    }
}

#[tokio::test]
async fn remaining_spatial_modes_matrix() {
    for outside in [false, true] {
        for premise in ["covers", "derived", "carried"] {
            for mode in [Guard::Premise, Guard::Epoch, Guard::Off] {
                let mut initial = scene_with_floor(2);
                if premise != "covers" {
                    initial["nodes"][1]["parent"] = json!(1);
                }
                let mut f = Fixture::new("msmodes", &initial).expect("build mock");
                let basis = f.revision(ME).await;
                if outside {
                    f.outside(|nodes| nodes[0]["location"] = json!([20, 0, 0]));
                } else {
                    f.ok(OTHER, "batch", json!({"ops":[{"op":"set","target":1,"field":"location","value":[20,0,0]}]})).await;
                }
                f.options.guard = mode;
                let step = if premise == "derived" {
                    json!({"command":"node.rename","params":{"node":2,"name":"Agent","world":true}})
                } else {
                    rename_at(if premise == "covers" { spot(1) } else { spot(2) }, "Agent")
                };
                let answer = f.call(ME, "run", json!({"basis":basis,"steps":[step]})).await;
                let expected = match mode {
                    Guard::Off => None,
                    Guard::Epoch => Some("changed"),
                    _ => Some(if premise == "derived" { "changed" } else { "relocated" }),
                };
                match expected {
                    None => assert!(answer.as_ref().err().is_none_or(|e| e["error"]["code"] != "conflict"), "{outside}/{premise}/{mode:?}: {answer:?}"),
                    Some(reason) => assert!(
                        answer.as_ref().err().is_some_and(|e| e["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == reason))),
                        "{outside}/{premise}/{mode:?}: {answer:?}"
                    ),
                }
                println!("MATRIX modes/{outside}/{premise}/{mode:?}: PASS");
                f.shutdown().await;
            }
        }
    }
}

#[tokio::test]
async fn remaining_coverage_matrix() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for window in [false, true] {
            for change in ["away", "in", "delete", "order", "occluded-order", "hidden", "unrelated", "cannot"] {
                let mut initial = scene_with_floor(3);
                if change == "in" {
                    initial["nodes"][1]["mesh"] = boxed(0.25);
                }
                if change == "occluded-order" {
                    initial["nodes"][1]["location"] = spot(1);
                }
                if change == "order" {
                    initial["nodes"][2]["location"] = spot(1);
                    initial["nodes"][2]["mesh"] = boxed(2.0);
                }
                let f = Fixture::new("mcov", &initial).expect("build mock");
                let basis = f.revision(ME).await;
                let mut changed = initial.clone();
                let (field, id, value) = match change {
                    "away" => ("location", 1, json!([20, 0, 0])),
                    "in" => ("location", 2, spot(1)),
                    "hidden" => ("hidden", 1, json!(true)),
                    _ => ("location", 3, json!([30, 0, 0])),
                };
                let ops = match change {
                    "delete" => {
                        changed["nodes"].as_array_mut().unwrap().remove(0);
                        vec![json!({"op":"delete","target":1})]
                    }
                    "order" | "occluded-order" => {
                        changed["nodes"].as_array_mut().unwrap().swap(0, 1);
                        vec![json!({"op":"list.move","target":"root","field":"nodes","from":0,"to":2})]
                    }
                    _ => {
                        changed["nodes"][id - 1][field] = value.clone();
                        vec![json!({"op":"set","target":id,"field":field,"value":value})]
                    }
                };
                if outside {
                    f.outside(|nodes| *nodes = changed["nodes"].as_array().unwrap().clone());
                } else {
                    f.ok(OTHER, "batch", json!({"ops":ops})).await;
                }
                let saved = std::fs::read(f.file()).unwrap();
                let params = json!({"pick":spot(1),"name":"Agent","window":window,"cannot":change=="cannot"});
                let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"node.rename","params":params}]})).await;
                let reason = match change {
                    "delete" => Some("deleted"),
                    "away" | "in" | "hidden" | "occluded-order" => Some("relocated"),
                    "order" if window => Some("relocated"),
                    "cannot" => Some("unknown"),
                    _ => None,
                };
                let valid = match (&answer, reason) {
                    (Ok(_), None) => true,
                    (Err(e), Some(reason)) => {
                        e["error"]["code"] == "conflict"
                            && e["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == reason)
                            && std::fs::read(f.file()).unwrap() == saved
                    }
                    _ => false,
                };
                println!("MATRIX coverage/{outside}/{window}/{change}: {} {}", reason.unwrap_or("apply"), if valid { "PASS" } else { "FAIL" });
                if !valid {
                    failures.push(format!("{outside}/{window}/{change}: expected {reason:?}, got {answer:?}"));
                }
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn remaining_derived_and_carried_matrix() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for premise in ["topology", "world", "carried"] {
            for changes in [false, true] {
                let mut initial = scene(3);
                initial["nodes"][1]["parent"] = json!(1);
                let f = Fixture::new("mderived", &initial).expect("build mock");
                let basis = f.revision(ME).await;
                let mut changed = initial.clone();
                let ops = if premise == "topology" {
                    if changes {
                        changed["nodes"][1]["mesh"]["faces"].as_array_mut().unwrap().push(json!([0, 1, 2]));
                    } else {
                        changed["nodes"][1]["mesh"]["verts"][0][0] = json!(-0.4);
                    }
                    vec![json!({"op":"set","target":2,"field":"mesh","value":changed["nodes"][1]["mesh"]})]
                } else if changes {
                    changed["nodes"][0]["location"] = json!([10, 0, 0]);
                    vec![json!({"op":"set","target":1,"field":"location","value":[10,0,0]})]
                } else if premise == "world" {
                    changed["nodes"][0]["location"] = json!([10, 0, 0]);
                    changed["nodes"][1]["location"] = json!([-7, 0, 0]);
                    vec![json!({"op":"set","target":1,"field":"location","value":[10,0,0]}), json!({"op":"set","target":2,"field":"location","value":[-7,0,0]})]
                } else {
                    changed["nodes"][0]["name"] = json!("Renamed");
                    vec![json!({"op":"set","target":1,"field":"name","value":"Renamed"})]
                };
                if outside {
                    f.outside(|nodes| *nodes = changed["nodes"].as_array().unwrap().clone());
                } else {
                    f.ok(OTHER, "batch", json!({"ops":ops})).await;
                }
                let step = match premise {
                    "topology" => extrude(2, 0),
                    "world" => json!({"command":"node.rename","params":{"node":2,"name":"Agent","world":true}}),
                    _ => rename_at(spot(2), "Agent"),
                };
                let saved = std::fs::read(f.file()).unwrap();
                let answer = f.call(ME, "run", json!({"basis":basis,"steps":[step]})).await;
                let expected = if changes { Some(if premise == "carried" { "relocated" } else { "changed" }) } else { None };
                let valid = match (&answer, expected) {
                    (Ok(_), None) => true,
                    (Err(e), Some(reason)) => {
                        e["error"]["code"] == "conflict"
                            && e["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == reason)
                            && std::fs::read(f.file()).unwrap() == saved
                    }
                    _ => false,
                };
                println!("MATRIX derived/{outside}/{premise}/{changes}: {} {}", expected.unwrap_or("apply"), if valid { "PASS" } else { "FAIL" });
                if !valid {
                    failures.push(format!("{outside}/{premise}/{changes}: {answer:?}"));
                }
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn nested_position_premise_refuses_a_child_move_after_parent_transform_changes() {
    for outside in [false, true] {
        let mut initial = scene(2);
        initial["nodes"][0]["frame"] = json!({ "transform": [1, 0, 0, 1, 0, 0], "transformOrigin": [0, 0] });
        initial["nodes"][1]["parent"] = json!(1);
        let f = Fixture::new(if outside { "nestedposout" } else { "nestedposagent" }, &initial).expect("build the mock kit first");
        let basis = f.revision(ME).await;
        if outside {
            f.outside(|nodes| nodes[0]["frame"]["transform"][4] = json!(20));
        } else {
            f.ok(OTHER, "batch", json!({ "ops": [{ "op": "set", "target": 1, "field": "frame.transform.4", "value": 20 }] })).await;
        }
        let before = std::fs::read(f.file()).unwrap();
        let refused =
            f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "node.move", "params": { "node": 2, "offset": [1, 0, 0] } }] })).await;
        assert!(refused["conflicts"].as_array().unwrap().iter().any(|conflict| conflict["id"] == 1 && conflict["reason"] == "relocated"), "{refused}");
        assert_eq!(std::fs::read(f.file()).unwrap(), before);
        f.shutdown().await;
    }
}

#[tokio::test]
async fn nested_position_premise_does_not_match_a_similarly_named_member() {
    let mut initial = scene(2);
    initial["nodes"][0]["frame"] = json!({ "transform": [1, 0, 0, 1, 0, 0], "transformOrigin": [0, 0] });
    initial["nodes"][1]["parent"] = json!(1);
    let f = Fixture::new("nestedposorigin", &initial).expect("build the mock kit first");
    let basis = f.revision(ME).await;
    f.outside(|nodes| nodes[0]["frame"]["transformOrigin"][0] = json!(20));
    f.ok(ME, "run", json!({ "basis": basis, "steps": [{ "command": "node.move", "params": { "node": 2, "offset": [1, 0, 0] } }] })).await;
    assert_eq!(f.node(2)["location"][0], 4.0);
    f.shutdown().await;
}

/// A unit cube's mesh around its node's origin.
fn cube() -> Value {
    boxed(0.5)
}

/// A cube's mesh of half extent `half` around its node's origin.
fn boxed(half: f64) -> Value {
    let mut verts = Vec::new();
    for x in [-half, half] {
        for y in [-half, half] {
            for z in [-half, half] {
                verts.push(json!([x, y, z]));
            }
        }
    }
    json!({ "verts": verts, "faces": [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]] })
}

/// `count` unit cubes named `N1`…, keyed from 1, the n-th at x = 3 (n - 1).
fn scene(count: u64) -> Value {
    let nodes: Vec<Value> = (1..=count)
        .map(|key| json!({ "key": key, "name": format!("N{key}"), "location": [3.0 * (key - 1) as f64, 0.0, 0.0], "hidden": false, "mesh": cube() }))
        .collect();
    json!({ "nodes": nodes })
}

/// Where node `key` stood in [`scene`]: a point inside it.
fn spot(key: u64) -> Value {
    json!([3.0 * (key - 1) as f64, 0.0, 0.0])
}

/// [`scene`] with a large box (`9`, half extent 2) behind node 2's place: unchanged, it is what a
/// pick there names once node 2 has gone.
fn scene_with_floor(count: u64) -> Value {
    let mut scene = scene(count);
    if let Some(nodes) = scene["nodes"].as_array_mut() {
        nodes.push(json!({ "key": 9, "name": "Floor", "location": [3.0, 0.0, 0.0], "hidden": false, "mesh": boxed(2.0) }));
    }
    scene
}

struct Fixture {
    kits: KitManager,
    options: CallOptions,
    name: String,
    workspace: tempfile::TempDir,
    _bin: tempfile::TempDir,
}

impl Fixture {
    fn new(name: &str, scene: &Value) -> Option<Self> {
        let Some(mock) = mock_binary() else {
            eprintln!("skipped: build kition-kit-mock first (cargo build -p kition-kit-mock)");
            return None;
        };
        let bin = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let workspace = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(workspace.path().join(format!("a.{name}")), scene.to_string()).unwrap_or_else(|err| panic!("{err}"));
        let kits = KitManager::new(Some(workspace.path().to_path_buf()), vec![(kit(name), Some(as_kit(bin.path(), &mock, name)))]);
        editor::attach(&kits, workspace.path(), kit(name), &as_kit(bin.path(), &mock, name), &format!("a.{name}"));
        Some(Self { kits, options: CallOptions::default(), name: name.to_owned(), workspace, _bin: bin })
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

    fn scene(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.file()).unwrap_or_else(|err| panic!("{err}"))).unwrap_or_else(|err| panic!("{err}"))
    }

    fn node(&self, key: u64) -> Value {
        self.scene()["nodes"].as_array().and_then(|nodes| nodes.iter().find(|node| node["key"] == key).cloned()).unwrap_or(Value::Null)
    }

    /// Writes the scene as a colleague's program would, an hour before its own time: `change`
    /// edits it.
    fn outside(&self, change: impl FnOnce(&mut Vec<Value>)) {
        let mut scene = self.scene();
        if let Some(nodes) = scene["nodes"].as_array_mut() {
            change(nodes);
        }
        let at = std::fs::metadata(self.file()).and_then(|meta| meta.modified()).unwrap_or_else(|err| panic!("{err}")) - Duration::from_secs(3600);
        write_at(&self.file(), &scene.to_string(), at);
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

/// The node keyed `key` among `nodes`.
fn node_in(nodes: &mut [Value], key: u64) -> &mut Value {
    nodes.iter_mut().find(|node| node["key"] == key).unwrap_or_else(|| panic!("no node {key}"))
}

fn conflict_on(refused: &Value, id: u64) -> &Value {
    refused["conflicts"]
        .as_array()
        .and_then(|conflicts| conflicts.iter().find(|conflict| conflict["id"] == json!(id)))
        .unwrap_or_else(|| panic!("no conflict on {id}: {refused}"))
}

fn rename(node: Value, name: &str) -> Value {
    json!({ "command": "node.rename", "params": { "node": node, "name": name } })
}

fn rename_at(at: Value, name: &str) -> Value {
    json!({ "command": "node.rename", "params": { "pick": at, "name": name } })
}

fn move_by(node: u64, offset: [f64; 3]) -> Value {
    json!({ "command": "node.move", "on": [node], "params": { "offset": offset } })
}

// ---- 1. A position told at a leaf is a position ----

/// A colleague moves node 2 along x alone: the change set tells the leaf `location.0`. A rename by
/// id (position-independent) applies, `others` telling the move; a move by id (it depends on
/// where the node is) is refused as `relocated`, not `changed`, with where the node is now.
#[tokio::test]
async fn leaf_a_one_axis_move_is_a_move() {
    let Some(f) = Fixture::new("spleaf", &scene(4)) else { return };
    let basis = f.revision(ME).await;
    f.outside(|nodes| node_in(nodes, 2)["location"][0] = json!(33.0));
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [move_by(2, [1.0, 0.0, 0.0])] })).await;
    let conflict = conflict_on(&refused, 2);
    assert_eq!(conflict["reason"], "relocated", "{refused}");
    assert_eq!(conflict["now"]["location"][0].as_f64(), Some(33.0), "where it is now, the whole field: {refused}");
    assert_eq!(conflict["now"]["location"].as_array().map(Vec::len), Some(3), "{refused}");
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [rename(json!(2), "Mine")] })).await;
    assert_eq!(ran["others"]["changed"][0]["fields"], json!(["location.0"]), "{ran}");
    assert_eq!(f.node(2)["name"], "Mine");
    f.shutdown().await;
}

/// Between agents too: another agent's one-axis move of node 3 (`node.place`, one coordinate
/// changes) refuses a move by id as `relocated`, and a rename applies.
#[tokio::test]
async fn leaf_a_one_axis_move_between_agents_is_a_move() {
    let Some(f) = Fixture::new("spleaf2", &scene(4)) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "node.place", "on": [3], "params": { "location": [6.0, 5.0, 0.0] } }] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [move_by(3, [0.0, 0.0, 1.0])] })).await;
    assert_eq!(conflict_on(&refused, 3)["reason"], "relocated", "{refused}");
    f.ok(ME, "run", json!({ "basis": basis, "steps": [rename(json!(3), "Mine")] })).await;
    f.shutdown().await;
}

// ---- 2. Where an object is now ----

/// A colleague deletes node 1 (node 2's index in the scene's list shifts) and makes node 4 node
/// 2's parent: the conflict on a move of node 2 says the list it is in (`parent: "scene"`,
/// `field`, `index`) and, apart, its position field `parent` (`now.fields.parent: 4`).
#[tokio::test]
async fn now_a_position_field_named_parent_does_not_hide_the_list() {
    let Some(f) = Fixture::new("spnow", &scene(4)) else { return };
    let basis = f.revision(ME).await;
    f.outside(|nodes| {
        nodes.remove(0);
        node_in(nodes, 2)["parent"] = json!(4);
    });
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [move_by(2, [1.0, 0.0, 0.0])] })).await;
    let now = &conflict_on(&refused, 2)["now"];
    assert_eq!((now["parent"].clone(), now["field"].clone(), now["index"].clone()), (json!("scene"), json!("nodes"), json!(0)), "{refused}");
    assert_eq!(now["fields"]["parent"], json!(4), "{refused}");
    f.shutdown().await;
}

// ---- 3. A target parameter that takes one id or a list ----

/// `node.hide` declares `nodes` (`oneOf [integer, string, array of integers]`) its targets: `on`
/// with two nodes fills it as a list, and after a colleague renamed node 2 a hide of it by a
/// number in `nodes` with `basis` is refused as `changed`.
#[tokio::test]
async fn targets_one_or_many_ids_are_targets() {
    let Some(f) = Fixture::new("sptgt", &scene(4)) else { return };
    f.ok(ME, "run", json!({ "steps": [{ "command": "node.hide", "on": [1, 3] }] })).await;
    assert_eq!((f.node(1)["hidden"].clone(), f.node(3)["hidden"].clone()), (json!(true), json!(true)));
    let basis = f.revision(ME).await;
    f.outside(|nodes| node_in(nodes, 2)["name"] = json!("Theirs"));
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "node.hide", "params": { "nodes": [2] } }] })).await;
    assert_eq!(conflict_on(&refused, 2)["reason"], "changed", "{refused}");
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "node.hide", "params": { "nodes": 2 } }] })).await;
    assert_eq!(conflict_on(&refused, 2)["reason"], "changed", "{refused}");
    f.shutdown().await;
}

// ---- 4. A place the kit tells by being asked (`covers`) ----

/// The ids a refusal's conflicts name, with their reasons.
fn reasons(refused: &Value) -> Vec<(Value, Value)> {
    refused["conflicts"].as_array().into_iter().flatten().map(|conflict| (conflict["id"].clone(), conflict["reason"].clone())).collect()
}

/// A colleague moves node 2 away (along x): a pick at its old point names the large box behind
/// it now (9, unchanged). The write by that point is refused as `relocated` on node 2, `now`
/// saying where it went and the place what is under it now; nothing is written.
#[tokio::test]
async fn covers_the_target_moved_away_and_an_unchanged_object_behind_it_is_hit() {
    let Some(f) = Fixture::new("spaway", &scene_with_floor(4)) else { return };
    let basis = f.revision(ME).await;
    f.outside(|nodes| node_in(nodes, 2)["location"][0] = json!(63.0));
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [rename_at(spot(2), "Picked")] })).await;
    let conflict = conflict_on(&refused, 2);
    assert_eq!(conflict["reason"], "relocated", "{refused}");
    assert_eq!(conflict["now"]["location"][0].as_f64(), Some(63.0), "where it went: {refused}");
    assert_eq!(conflict["place"]["under"], json!([9]), "what is there now: {refused}");
    assert_eq!(f.node(9)["name"], "Floor", "nothing written");
    eprintln!("covers: target moved away: refusal {} bytes: {}", refused.to_string().len(), refused["conflicts"]);
    f.shutdown().await;
}

/// A colleague moves node 2 away and node 3 to node 2's point, along x alone and along all three
/// axes: the write by that point is refused, naming node 3 (put there) and node 2 (gone from
/// there); nothing is written. Between agents the same.
#[tokio::test]
async fn covers_another_object_moved_into_the_point_is_refused() {
    // Node 3 stood at [6, 0, 0]: along x alone, then along x, y and z.
    for (n, to) in [[3.0, 0.0, 0.0], [3.0, 0.2, 0.25]].into_iter().enumerate() {
        let Some(f) = Fixture::new(&format!("spinto{n}"), &scene(4)) else { return };
        let basis = f.revision(ME).await;
        f.outside(|nodes| {
            node_in(nodes, 2)["location"][0] = json!(63.0);
            node_in(nodes, 3)["location"] = json!(to);
        });
        let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [rename_at(spot(2), "Picked")] })).await;
        let found = reasons(&refused);
        assert!(found.contains(&(json!(3), json!("relocated"))), "{n}: node 3 was put there: {refused}");
        assert!(found.contains(&(json!(2), json!("relocated"))), "{n}: node 2 went: {refused}");
        assert_eq!(conflict_on(&refused, 3)["place"]["under"], json!([3]), "{refused}");
        assert_eq!(f.node(3)["name"], "N3", "nothing written");
        f.shutdown().await;
    }
    let Some(f) = Fixture::new("spinto2", &scene(4)) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "node.place", "on": [2], "params": { "location": [63.0, 0.0, 0.0] } }] })).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "node.place", "on": [3], "params": { "location": [3.0, 0.0, 0.0] } }] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [rename_at(spot(2), "Picked")] })).await;
    assert!(reasons(&refused).contains(&(json!(3), json!("relocated"))), "between agents: {refused}");
    f.shutdown().await;
}

/// Node 2 is node 4's child (its location relative to node 4's). A colleague moves node 4 20 m
/// along y: node 2's stored fields do not change, but it is no longer at its point. The write by
/// that point is refused as `relocated` on node 4 (what was there derives its place from it).
#[tokio::test]
async fn covers_the_targets_parent_moved_is_refused() {
    let mut start = scene(4);
    if let Some(nodes) = start["nodes"].as_array_mut() {
        node_in(nodes, 2)["location"] = json!([-6.0, 0.0, 0.0]);
        node_in(nodes, 2)["parent"] = json!(4);
    }
    let Some(f) = Fixture::new("spparent", &start) else { return };
    let basis = f.revision(ME).await;
    f.outside(|nodes| node_in(nodes, 4)["location"][1] = json!(20.0));
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [rename_at(spot(2), "Picked")] })).await;
    assert!(reasons(&refused).contains(&(json!(4), json!("relocated"))), "{refused}");
    f.shutdown().await;
}

/// Changes away from the point refuse no write by it: another node moved elsewhere, another
/// node's mesh subdivided, another node deleted, another node given a parent; the write applies to
/// node 2, and `others` tells the change.
#[tokio::test]
async fn covers_changes_away_from_the_point_apply() {
    type Change = fn(&mut Vec<Value>);
    let changes: [(&str, Change); 4] = [
        ("moved", |nodes| node_in(nodes, 4)["location"][2] = json!(0.5)),
        ("subdivided", |nodes| {
            let mesh = &mut node_in(nodes, 3)["mesh"];
            if let Some(verts) = mesh["verts"].as_array_mut() {
                verts.push(json!([0.0, -0.5, -0.5]));
            }
            if let Some(faces) = mesh["faces"].as_array_mut() {
                faces.push(json!([0, 8, 1]));
            }
        }),
        ("deleted", |nodes| nodes.retain(|node| node["key"] != 4)),
        ("reparented", |nodes| node_in(nodes, 3)["parent"] = json!(1)),
    ];
    for (what, change) in changes {
        let Some(f) = Fixture::new(&format!("spelse{what}"), &scene(4)) else { return };
        let basis = f.revision(ME).await;
        f.outside(change);
        let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [rename_at(spot(2), "Picked")] })).await;
        assert!(ran["others"].is_object(), "{what}: {ran}");
        assert_eq!(f.node(2)["name"], "Picked", "{what}");
        f.shutdown().await;
    }
}

/// Fifty rounds on 24 nodes: a colleague moves a random node other than node 7 0.5 m up, then the
/// agent writes node 7 by its point and by id, with the revision of its last answer. None is
/// refused.
#[tokio::test]
async fn covers_fifty_unrelated_moves_refuse_nothing() {
    let Some(f) = Fixture::new("spfifty", &scene(24)) else { return };
    let mut basis = f.revision(ME).await;
    let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
    let (mut by_point, mut by_id) = (0, 0);
    let mut times = (Vec::new(), Vec::new());
    for round in 0..50u32 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let theirs = 1 + seed % 23;
        let theirs = if theirs >= 7 { theirs + 1 } else { theirs };
        f.outside(|nodes| {
            let z = node_in(nodes, theirs)["location"][2].as_f64().unwrap_or(0.0);
            node_in(nodes, theirs)["location"][2] = json!(z + 0.5);
        });
        for (by, count, times) in [("point", &mut by_point, &mut times.0), ("id", &mut by_id, &mut times.1)] {
            let step = if by == "point" { rename_at(spot(7), &format!("P{round}")) } else { rename(json!(7), &format!("I{round}")) };
            let started = Instant::now();
            match f.call(ME, "run", json!({ "basis": basis, "steps": [step] })).await {
                Ok(ran) => basis = ran["revision"].as_str().unwrap_or_default().to_owned(),
                Err(error) => {
                    *count += 1;
                    basis = error["revision"].as_str().unwrap_or_default().to_owned();
                }
            }
            times.push(started.elapsed().as_secs_f64() * 1000.0);
        }
    }
    let median = |mut values: Vec<f64>| {
        values.sort_by(f64::total_cmp);
        values[values.len() / 2]
    };
    eprintln!("covers: 50 rounds: {by_point} writes by point and {by_id} by id refused; median {:.1} ms and {:.1} ms", median(times.0), median(times.1));
    assert_eq!((by_point, by_id), (0, 0));
    f.shutdown().await;
}

// ---- 5. Derived values ----

fn extrude(node: u64, face: u64) -> Value {
    json!({ "command": "mesh.extrude", "on": [node], "params": { "face": face, "distance": 0.5 } })
}

/// The colleague's subdivide of node 2's mesh, as their program writes it: one face more per face,
/// through a new vertex.
fn subdivided(nodes: &mut [Value], key: u64) {
    let mesh = &mut node_in(nodes, key)["mesh"];
    let faces: Vec<Value> = mesh["faces"].as_array().cloned().unwrap_or_default();
    for face in faces {
        let (a, b) = (face[0].as_u64().unwrap_or(0) as usize, face[1].as_u64().unwrap_or(0) as usize);
        let (pa, pb) = (mesh["verts"][a].clone(), mesh["verts"][b].clone());
        let mid: Vec<f64> = (0..3).map(|axis| (pa[axis].as_f64().unwrap_or(0.0) + pb[axis].as_f64().unwrap_or(0.0)) / 2.0).collect();
        let verts = mesh["verts"].as_array_mut().unwrap_or_else(|| panic!("verts"));
        verts.push(json!(mid));
        let at = verts.len() - 1;
        mesh["faces"].as_array_mut().unwrap_or_else(|| panic!("faces")).push(json!([a, at, b]));
    }
}

/// A write by face index (`mesh.extrude`, the kit's premise `~topology`) applies after a
/// colleague moved a vertex of the mesh (its topology unchanged), in the file and between agents;
/// after a colleague's subdivide it is refused as `changed`, nothing written.
#[tokio::test]
async fn derived_a_write_by_face_index_holds_the_topology() {
    let Some(f) = Fixture::new("sptopo", &scene(4)) else { return };
    let basis = f.revision(ME).await;
    f.outside(|nodes| node_in(nodes, 2)["mesh"]["verts"][7][2] = json!(0.75));
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [extrude(2, 0)] })).await;
    assert_eq!(ran["others"]["changed"][0]["fields"].as_array().map(|fields| fields.contains(&json!("~topology"))), Some(false), "{ran}");
    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "mesh.moveVertex", "on": [2], "params": { "vertex": 3, "offset": [0.0, 0.0, 0.1] } }] })).await;
    let ran = f.ok(ME, "run", json!({ "basis": basis, "steps": [extrude(2, 1)] })).await;
    let basis = ran["revision"].as_str().unwrap_or_default().to_owned();
    f.outside(|nodes| subdivided(nodes, 2));
    let before = f.node(2);
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [extrude(2, 0)] })).await;
    assert_eq!(conflict_on(&refused, 2)["reason"], "changed", "{refused}");
    assert!(refused["others"]["changed"][0]["fields"].as_array().is_some_and(|fields| fields.contains(&json!("~topology"))), "{refused}");
    assert_eq!(f.node(2), before, "nothing written");
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "mesh.subdivide", "on": [2] }] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [extrude(2, 0)] })).await;
    assert_eq!(conflict_on(&refused, 2)["reason"], "changed", "between agents: {refused}");
    f.shutdown().await;
}

/// The receipt of a subdivide tells the topology changed (`~topology`, before and after) beside the
/// mesh; a vertex move tells the mesh alone.
#[tokio::test]
async fn derived_a_receipt_tells_the_topology() {
    let Some(f) = Fixture::new("sprcpt", &scene(4)) else { return };
    let ran = f.ok(ME, "run", json!({ "steps": [{ "command": "mesh.subdivide", "on": [2] }] })).await;
    let change = &ran["changes"]["changed"][0];
    let fields = |change: &Value| change["fields"].as_array().cloned().unwrap_or_default();
    assert!(fields(change).contains(&json!("~topology")) && !fields(change).contains(&json!("~bounds")), "{ran}");
    let topology = change["edits"].as_array().and_then(|edits| edits.iter().find(|edit| edit["field"] == "~topology")).cloned().unwrap_or_default();
    assert!(topology["before"].as_str().is_some_and(|before| before.starts_with("8v6f")), "{ran}");
    assert!(topology["after"].as_str().is_some_and(|after| after.starts_with("14v12f")), "{ran}");
    eprintln!("derived: subdivide receipt {} bytes: {}", ran["changes"].to_string().len(), ran["changes"]);
    let ran = f.ok(ME, "run", json!({ "steps": [{ "command": "mesh.moveVertex", "on": [2], "params": { "vertex": 0, "offset": [0.0, 0.0, -0.1] } }] })).await;
    let change = &ran["changes"]["changed"][0];
    assert!(fields(change).contains(&json!("~bounds")) && !fields(change).contains(&json!("~topology")), "{ran}");
    eprintln!("derived: vertex move receipt {} bytes: {}", ran["changes"].to_string().len(), ran["changes"]);
    assert!(ran["changes"].get("derived").is_none(), "the journal's mark is not shown: {ran}");
    f.shutdown().await;
}

/// A point at the edge of node 2 (0.4 m from its origin) with a large box behind: a colleague's
/// vertex move that shrinks node 2 away from the point, or its delete, leaves the box under it.
/// The write by that point is refused, from node 2's bounds before (`~bounds`, a derived value the
/// journal keeps, in a deleted node's `$was` too); a vertex move inside the bounds is not.
#[tokio::test]
async fn derived_bounds_tell_a_place_what_a_mesh_edit_or_a_delete_did() {
    let edge = json!([3.4, 0.0, 0.0]);
    let Some(f) = Fixture::new("spbounds", &scene_with_floor(4)) else { return };
    let basis = f.revision(ME).await;
    f.outside(|nodes| {
        for vertex in 4..8 {
            node_in(nodes, 2)["mesh"]["verts"][vertex][0] = json!(-0.3);
        }
    });
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [rename_at(edge.clone(), "Picked")] })).await;
    assert!(reasons(&refused).contains(&(json!(2), json!("relocated"))), "{refused}");
    assert_eq!(f.node(9)["name"], "Floor", "nothing written");
    let basis = f.revision(ME).await;
    f.outside(|nodes| nodes.retain(|node| node["key"] != 2));
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [rename_at(json!([2.6, 0.0, 0.0]), "Picked")] })).await;
    assert!(reasons(&refused).contains(&(json!(2), json!("deleted"))), "{refused}");
    f.shutdown().await;
    let Some(f) = Fixture::new("spbounds2", &scene_with_floor(4)) else { return };
    let basis = f.revision(ME).await;
    f.outside(|nodes| node_in(nodes, 2)["mesh"]["verts"][0][2] = json!(-0.4));
    f.ok(ME, "run", json!({ "basis": basis, "steps": [rename_at(edge, "Picked")] })).await;
    assert_eq!(f.node(2)["name"], "Picked");
    f.shutdown().await;
}

// ---- 6. A whole number is an id only where the parameter names objects ----

/// `mesh.moveVertex` takes `vertex: 3`, an element index the schema does not mark as naming an
/// object: after a colleague renamed node 3 it applies to node 2's vertex. `node.parent` takes
/// `parent: 4`, marked `"x-khp-role": "object"`: after a colleague renamed node 4 it is refused as
/// `changed` on node 4.
#[tokio::test]
async fn integers_a_number_names_an_object_only_in_a_parameter_that_says_so() {
    let Some(f) = Fixture::new("spint", &scene(4)) else { return };
    let basis = f.revision(ME).await;
    f.outside(|nodes| {
        node_in(nodes, 3)["name"] = json!("Theirs");
        node_in(nodes, 4)["name"] = json!("Theirs too");
    });
    let step = json!({ "command": "mesh.moveVertex", "on": [2], "params": { "vertex": 3, "offset": [0.0, 0.0, 0.1] } });
    f.ok(ME, "run", json!({ "basis": basis, "steps": [step] })).await;
    let basis = f.revision(ME).await;
    f.outside(|nodes| node_in(nodes, 4)["name"] = json!("Again"));
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "node.parent", "on": [2], "params": { "parent": 4 } }] })).await;
    assert_eq!(conflict_on(&refused, 4)["reason"], "changed", "{refused}");
    f.shutdown().await;
}

/// Node 2 is node 4's child. A colleague moves node 4 to node 2's point: node 2 goes with it (20 m
/// along y) and node 4 is what a pick there names now. The write by that point is refused naming
/// node 4 (put there) and node 2 (gone), though node 4 "was or held" what was there at `basis`:
/// what the place named then is compared with what it names now.
#[tokio::test]
async fn covers_a_parent_moved_onto_its_childs_point_is_refused() {
    let mut start = scene(4);
    if let Some(nodes) = start["nodes"].as_array_mut() {
        node_in(nodes, 2)["location"] = json!([-6.0, 20.0, 0.0]);
        node_in(nodes, 2)["parent"] = json!(4);
        node_in(nodes, 4)["location"] = json!([9.0, -20.0, 0.0]);
    }
    let Some(f) = Fixture::new("spontop", &start) else { return };
    let basis = f.revision(ME).await;
    f.outside(|nodes| node_in(nodes, 4)["location"] = json!([3.0, 0.0, 0.0]));
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [rename_at(spot(2), "Picked")] })).await;
    let found = reasons(&refused);
    assert!(found.contains(&(json!(4), json!("relocated"))), "node 4 was put there: {refused}");
    assert!(found.contains(&(json!(2), json!("relocated"))), "node 2 went: {refused}");
    assert_eq!(f.node(4)["name"], "N4", "nothing written");
    f.shutdown().await;
}

/// `node` also takes a node by its name (`x-khp-name: "name"`). A colleague
/// renames N2 away (to `Gone`), or renames N2 away and N3 to `N2`: the agent's move of `"N2"` with
/// `basis` is refused as `relocated`, naming the node the name named and its name now (and the
/// node given it). Before, the first applied nowhere (the kit's not-found) and the second moved N3.
/// A rename of another node applies.
#[tokio::test]
async fn names_a_target_by_its_name_holds_the_object_it_named() {
    for case in ["away", "swapped", "elsewhere"] {
        let Some(f) = Fixture::new(&format!("spname{}", case.len()), &scene(4)) else { return };
        let basis = f.revision(ME).await;
        let theirs = match case {
            "away" => vec![rename(json!(2), "Gone")],
            "swapped" => vec![rename(json!(2), "Gone"), rename(json!(3), "N2")],
            _ => vec![rename(json!(4), "Other")],
        };
        f.ok(OTHER, "run", json!({ "steps": theirs })).await;
        let step = json!({ "command": "node.move", "params": { "node": "N2", "offset": [0.0, 1.0, 0.0] } });
        let answer = f.call(ME, "run", json!({ "basis": basis, "steps": [step] })).await;
        match case {
            "elsewhere" => {
                answer.unwrap_or_else(|error| panic!("{case}: {error}"));
            }
            _ => {
                let refused = answer.expect_err(case);
                assert_eq!(conflict_on(&refused, 2)["reason"], "relocated", "{case}: {refused}");
                assert_eq!(conflict_on(&refused, 2)["now"]["name"], "Gone", "{case}: {refused}");
                if case == "swapped" {
                    assert_eq!(conflict_on(&refused, 3)["reason"], "relocated", "{case}: {refused}");
                }
            }
        }
        f.shutdown().await;
    }
}

#[tokio::test]
async fn names_ignore_another_types_rename_to_the_target_name() {
    let mut start = scene(4);
    start["materials"] = json!(["M"]);
    let Some(f) = Fixture::new("spnametype", &start) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "batch", json!({ "ops": [{ "op": "set", "target": "material-0", "field": "name", "value": "N2" }] })).await;
    let answer = f.call(ME, "run", json!({ "basis": basis, "steps": [{ "command": "node.move", "params": { "node": "N2", "offset": [0, 1, 0] } }] })).await;
    f.shutdown().await;
    assert!(answer.is_ok(), "{answer:?}");
}

#[tokio::test]
async fn names_in_non_target_parameters_are_guarded() {
    let Some(f) = Fixture::new("spnameparam", &scene(4)) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [rename(json!(3), "Gone")] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "node.parent", "params": { "node": 2, "parent": "N3" } }] })).await;
    f.shutdown().await;
    assert_eq!(conflict_on(&refused, 3)["reason"], "relocated", "{refused}");
}

#[tokio::test]
async fn name_union_coordinate_ids_do_not_refuse_but_a_stale_name_does() {
    for (case, location, refused) in [("spunionpoint", json!([3, 0, 0]), false), ("spunionname", json!("N3"), true)] {
        let f = Fixture::new(case, &scene(4)).expect("build mock first");
        let basis = f.revision(ME).await;
        f.ok(OTHER, "run", json!({"steps":[rename(json!(3), "Gone")]})).await;
        let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"node.place","params":{"node":2,"location":location}}]})).await;
        if refused {
            assert_eq!(conflict_on(&answer.unwrap_err(), 3)["reason"], "relocated");
        } else {
            answer.unwrap_or_else(|error| panic!("point coordinates are not ids: {error}"));
        }
        f.shutdown().await;
    }
}

#[tokio::test]
async fn names_of_deleted_objects_are_refused_as_deleted() {
    let Some(f) = Fixture::new("spnamedelete", &scene(4)) else { return };
    let basis = f.revision(ME).await;
    f.ok(OTHER, "run", json!({ "steps": [{ "command": "node.delete", "params": { "nodes": [2] } }] })).await;
    let refused = f.refused(ME, "run", json!({ "basis": basis, "steps": [{ "command": "node.move", "params": { "node": "N2", "offset": [0, 1, 0] } }] })).await;
    f.shutdown().await;
    assert_eq!(conflict_on(&refused, 2)["reason"], "deleted", "{refused}");
}

/// The target under the point is a large box (node 2, half
/// extent 2) whose parent (node 4) a colleague moves by 0.5 m: the box still holds the point, so
/// the pick names node 2 as at `basis` and the rename applies. Before, the parent was refused as
/// having carried what was there away (covered at `basis`, not under the point now), though
/// nothing under the point changed. A move of 20 m carries it away: refused.
#[tokio::test]
async fn covers_a_parent_moved_that_left_its_child_at_the_point_applies() {
    for (by, refused) in [(0.5, false), (20.0, true)] {
        let mut start = scene(4);
        if let Some(nodes) = start["nodes"].as_array_mut() {
            node_in(nodes, 2)["location"] = json!([-6.0, 0.0, 0.0]);
            node_in(nodes, 2)["parent"] = json!(4);
            node_in(nodes, 2)["mesh"] = boxed(2.0);
        }
        let Some(f) = Fixture::new(&format!("spstay{}", by as u64), &start) else { return };
        let basis = f.revision(ME).await;
        f.outside(|nodes| node_in(nodes, 4)["location"][1] = json!(by));
        let answer = f.call(ME, "run", json!({ "basis": basis, "steps": [rename_at(spot(2), "Picked")] })).await;
        match refused {
            false => {
                answer.unwrap_or_else(|error| panic!("moved {by}: {error}"));
            }
            true => {
                let refused = answer.expect_err("moved 20");
                assert!(reasons(&refused).contains(&(json!(4), json!("relocated"))), "{refused}");
            }
        }
        f.shutdown().await;
    }
}

/// Objects whose every change is the same shift, in no list run, are stated once by their ids in `footprint`
/// (`{ ids, edits: [{ field, by }] }`): the receipt of moving 200 nodes is one entry, and no
/// object is cut.
#[tokio::test]
async fn receipts_two_hundred_objects_moved_by_one_offset_are_one_entry() {
    let Some(f) = Fixture::new("sp200", &scene(200)) else { return };
    let steps: Vec<Value> = (1..=200).map(|key| move_by(key, [0.0, 0.0, 1.0])).collect();
    let ran = f.ok(OTHER, "run", json!({ "steps": steps })).await;
    let changes = &ran["changes"];
    let size = changes.to_string().len();
    println!("receipt of 200 nodes moved by one offset: {size} bytes");
    assert_eq!(changes["changed"], json!([]), "{changes}");
    assert!(changes.get("truncated").is_none(), "{changes}");
    assert_eq!(changes["footprint"][0]["ids"].as_array().map(Vec::len), Some(200), "{changes}");
    assert_eq!(changes["footprint"][0]["edits"], json!([{ "field": "location.2", "by": 1 }]), "{changes}");
    assert_eq!(changes["footprint"][0]["ids"][0], json!(1), "integer tool ids are numbers: {changes}");
    assert!(size < 2_000, "{size} bytes");
    f.shutdown().await;
}

/// b: a write by point after others moved 1,000 objects is decided in one
/// `context.covered` request (the guard asks up to 4,096 objects at once; it refused beyond 64):
/// a move of every node by 0.1 m leaves node 2 at the point, and the rename applies. The time it
/// takes is printed.
#[tokio::test]
async fn covers_a_thousand_objects_moved_are_asked_at_once() {
    let Some(f) = Fixture::new("sp1000", &scene(1000)) else { return };
    let basis = f.revision(ME).await;
    f.outside(|nodes| nodes.iter_mut().for_each(|node| node["location"][2] = json!(0.1)));
    let started = Instant::now();
    f.ok(ME, "run", json!({ "basis": basis, "steps": [rename_at(spot(2), "Picked")] })).await;
    println!("a write by point after 1000 objects moved: {:?} (the file read again included)", started.elapsed());
    assert_eq!(f.node(2)["name"], "Picked");
    f.shutdown().await;
}

/// c: a parent's move carries its descendants in world space, which no stored field
/// of theirs tells. The kit answers it (`model.carried`), asked once per change set: the parent's
/// change says `carries: { count: 2, what: "world location" }`, in the colleague's receipt, in
/// `others` of the agent's next answer, and after a move of the file made outside.
#[tokio::test]
async fn carries_a_parents_move_tells_what_it_carries() {
    let mut start = scene(4);
    if let Some(nodes) = start["nodes"].as_array_mut() {
        node_in(nodes, 2)["parent"] = json!(4);
        node_in(nodes, 3)["parent"] = json!(2);
    }
    let Some(f) = Fixture::new("spcarry", &start) else { return };
    let basis = f.revision(ME).await;
    let ran = f.ok(OTHER, "run", json!({ "steps": [move_by(4, [0.0, 1.0, 0.0])] })).await;
    let carries = json!({ "count": 2, "what": "world location" });
    let told = |set: &Value| set["changed"].as_array().and_then(|items| items.iter().find(|item| item["id"] == json!(4)).map(|item| item["carries"].clone()));
    assert_eq!(told(&ran["changes"]), Some(carries.clone()), "{ran}");
    let seen = f.ok(ME, "run", json!({ "basis": basis, "steps": [rename(json!(1), "Mine")] })).await;
    assert_eq!(told(&seen["others"]), Some(carries.clone()), "{seen}");
    let basis = f.revision(ME).await;
    f.outside(|nodes| node_in(nodes, 4)["location"][2] = json!(5.0));
    let seen = f.ok(ME, "run", json!({ "basis": basis, "steps": [rename(json!(1), "Again")] })).await;
    assert_eq!(told(&seen["others"]), Some(carries), "{seen}");
    f.shutdown().await;
}

#[tokio::test]
async fn carries_a_parents_rename_carries_no_world_location() {
    let mut start = scene(4);
    if let Some(nodes) = start["nodes"].as_array_mut() {
        node_in(nodes, 2)["parent"] = json!(4);
    }
    let Some(f) = Fixture::new("spcarryname", &start) else { return };
    let ran = f.ok(OTHER, "run", json!({ "steps": [rename(json!(4), "Parent")] })).await;
    f.shutdown().await;
    assert!(ran["changes"]["changed"].as_array().unwrap().iter().all(|item| item.get("carries").is_none()), "{ran}");
}
