// Copied from kition-sdk crates/kition-kits/tests/support/nested_list_regressions.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;

const BODY: &str = "00000000-0000-0000-0000-000000000020";

fn paragraphs() -> Value {
    json!({"paragraphs":(0..6).map(|index|json!({"id":format!("00000000-0000-0000-0000-{:012}",100+index),"text":format!("Paragraph {index}")})).collect::<Vec<_>>()})
}

#[tokio::test]
async fn nested_raw_text_offsets_hold_only_the_character_gap_and_range() {
    let mut failures = Vec::new();
    for outside in [false, true] {
        for operation in ["text.insert", "text.delete"] {
            for change in ["earlier-insert", "later-insert", "earlier-replace", "inside-replace", "inside-delete"] {
                let mut file = paragraphs();
                file["paragraphs"][3]["text"] = json!("abcdefghij");
                let f = Fixture::new("nestedoffset", "KITION_KIT_MOCK_ORDER=paragraphs", &file.to_string()).expect("build mock");
                let basis = f.revision(ME).await;
                let changed = match change {
                    "earlier-insert" => "Xabcdefghij",
                    "later-insert" => "abcdefghiXj",
                    "earlier-replace" => "Xbcdefghij",
                    "inside-delete" => "abcdfghij",
                    _ => "abcdXfghij",
                };
                let mut after = file;
                after["paragraphs"][3]["text"] = json!(changed);
                if outside {
                    f.write_outside(&after.to_string());
                } else {
                    f.ok(OTHER, "batch", json!({"ops":[{"op":"text.set","target":"shape:1","field":"body.paragraphs.3.text","text":changed}]})).await;
                }
                let answer = f
                    .call(
                        ME,
                        "batch",
                        json!({"basis":basis,"ops":[{"op":operation,"target":"shape:1","field":"body.paragraphs.3.text","index":4,"count":2,"text":"Agent"}]}),
                    )
                    .await;
                let reason = if change == "earlier-insert" {
                    Some("relocated")
                } else if matches!(change, "inside-replace" | "inside-delete") && operation == "text.delete" {
                    Some("changed")
                } else {
                    None
                };
                if let Some(reason) = reason {
                    if !answer.as_ref().is_err_and(|e| e["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == reason))) {
                        failures.push(format!("{outside}/{operation}/{change}: expected {reason}, got {answer:?}"));
                    }
                } else if let Err(error) = answer {
                    failures.push(format!("{outside}/{operation}/{change}: unrelated edit refused: {error}"));
                } else {
                    let mut chars: Vec<_> = changed.chars().collect();
                    if operation == "text.insert" {
                        chars.splice(4..4, "Agent".chars());
                    } else {
                        chars.drain(4..6);
                    }
                    after["paragraphs"][3]["text"] = json!(chars.into_iter().collect::<String>());
                }
                assert_eq!(serde_json::from_str::<Value>(&f.read()).unwrap(), after);
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn nested_raw_text_offsets_hold_only_the_character_gap_and_range_after_a_prefix() {
    let mut file = paragraphs();
    file["paragraphs"][3]["text"] = json!("abcdefghij");
    let f = Fixture::new("nestedoffsetprefix", "KITION_KIT_MOCK_ORDER=paragraphs", &file.to_string()).expect("build mock");
    let basis = f.revision(ME).await;
    file["paragraphs"][3]["text"] = json!("abcdeXfghij");
    f.write_outside(&file.to_string());
    let answer = f
        .call(
            ME,
            "batch",
            json!({"basis":basis,"ops":[
                {"op":"text.delete","target":"shape:1","field":"body.paragraphs.3.text","index":0,"count":2},
                {"op":"text.insert","target":"shape:1","field":"body.paragraphs.3.text","index":4,"text":"Agent"}
            ]}),
        )
        .await;
    let error = answer.expect_err("the first planned edit moves the held gap past the outside insertion");
    assert!(error["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "relocated"), "{error}");
    assert_eq!(serde_json::from_str::<Value>(&f.read()).unwrap(), file);
    f.shutdown().await;
}

#[tokio::test]
async fn nested_raw_text_paths_hold_their_ordinal() {
    for operation in ["text.insert", "text.delete", "text.set"] {
        for index in [1, 4] {
            let file = paragraphs();
            let f = Fixture::new("nestedtext", "KITION_KIT_MOCK_ORDER=paragraphs", &file.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            let mut after = file.clone();
            after["paragraphs"].as_array_mut().unwrap().insert(index, json!({"id":"00000000-0000-0000-0000-000000000200","text":"Outside"}));
            f.write_outside(&after.to_string());
            let result = f
                .call(
                    ME,
                    "batch",
                    json!({"basis":basis,"ops":[{"op":operation,"target":"shape:1","field":"body.paragraphs.3.text","index":0,"count":1,"text":"Agent"}]}),
                )
                .await;
            if index == 1 {
                let error = result.expect_err("an earlier insertion shifts the indexed text target");
                assert!(error["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == "relocated")), "{operation}: {error}");
                assert_eq!(f.read(), after.to_string());
            } else {
                assert!(result.is_ok(), "{operation}: {result:?}");
                let saved: Value = serde_json::from_str(&f.read()).unwrap();
                let expected = match operation {
                    "text.insert" => "AgentParagraph 3",
                    "text.delete" => "aragraph 3",
                    _ => "Agent",
                };
                after["paragraphs"][3]["text"] = json!(expected);
                assert_eq!(saved, after);
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn nested_raw_list_windows_retain_private_position_records() {
    let mut failures = Vec::new();
    for raw in [false, true] {
        for operation in ["create", "list.insert", "list.move", "list.remove"] {
            for deletion in [false, true] {
                for index in [1, 4] {
                    let file = paragraphs();
                    let f = Fixture::new("nestedwindows", "KITION_KIT_MOCK_ORDER=paragraphs", &file.to_string()).expect("build mock");
                    let basis = f.revision(ME).await;
                    let mut after = file.clone();
                    if deletion {
                        after["paragraphs"].as_array_mut().unwrap().remove(index);
                    } else {
                        after["paragraphs"].as_array_mut().unwrap().insert(index, json!({"id":"00000000-0000-0000-0000-000000000200","text":"Outside"}));
                    }
                    f.write_outside(&after.to_string());
                    let (target, field) = if raw { (BODY, "paragraphs") } else { ("shape:1", "body.paragraphs") };
                    let ops = match operation {
                        "create" => json!([{"op":"create","type":"Paragraph","in":format!("{target}.{field}"),"at":3}]),
                        "list.insert" => json!([
                            {"op":"create","type":"Paragraph","ref":"$new"},
                            {"op":"list.insert","target":target,"field":field,"index":3,"item":"$new"}
                        ]),
                        "list.move" => json!([{"op":"list.move","target":target,"field":field,"from":3,"to":2}]),
                        _ => json!([{"op":"list.remove","target":target,"field":field,"index":3}]),
                    };
                    let result = f.call(ME, "batch", json!({"basis":basis,"ops":ops})).await;
                    let label = format!("{raw}/{operation}/{deletion}/{index}");
                    if index == 1 {
                        if !result.as_ref().is_err_and(|error| error["conflicts"].as_array().is_some_and(|cs| cs.iter().any(|c| c["reason"] == "relocated"))) {
                            failures.push(format!("{label}: expected relocated, got {result:?}"));
                        }
                        assert_eq!(f.read(), after.to_string(), "a refused batch must leave the file intact: {label}");
                    } else {
                        if let Err(error) = &result {
                            failures.push(format!("{label}: expected apply, got {error}"));
                        } else {
                            let mut expected =
                                after["paragraphs"].as_array().unwrap().iter().map(|p| p["text"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
                            match operation {
                                "create" | "list.insert" => expected.insert(3, String::new()),
                                "list.move" => {
                                    let item = expected.remove(3);
                                    expected.insert(2, item);
                                }
                                _ => {
                                    expected.remove(3);
                                }
                            }
                            let saved: Value = serde_json::from_str(&f.read()).unwrap();
                            assert_eq!(
                                saved["paragraphs"].as_array().unwrap().iter().map(|p| p["text"].as_str().unwrap().to_owned()).collect::<Vec<_>>(),
                                expected,
                                "{label}"
                            );
                        }
                    }
                    f.shutdown().await;
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn guarded_close_stops_before_later_steps() {
    for prefix in [false, true] {
        for stale in [false, true] {
            let f = Fixture::new("closingplan", "KITION_KIT_MOCK_CLOSE=1", "Original").expect("build mock");
            let basis = f.revision(ME).await;
            if stale {
                f.write_outside("Outside");
            }
            let mut steps = Vec::new();
            if prefix {
                steps.push(json!({"command":"text.append","params":{"text":"Prefix"}}));
            }
            steps.extend([json!({"command":"file.close","params":{"force":true}}), json!({"command":"text.append","params":{"text":"Must not run"}})]);
            let answer = f.ok(ME, "run", json!({"basis":basis,"steps":steps})).await;
            assert_eq!(answer["closed"], true, "{answer}");
            assert_eq!(answer["notRun"], 1, "{answer}");
            assert_eq!(answer["completed"].as_array().unwrap().len(), if prefix { 2 } else { 1 }, "{answer}");
            assert_eq!(f.read(), if stale { "Outside" } else { "Original" });
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn guarded_close_cancellation_keeps_later_steps() {
    let f = Fixture::new("cancelcloseplan", "KITION_KIT_MOCK_CLOSE=cancel", "Original").expect("build mock");
    let basis = f.revision(ME).await;
    let answer = f.ok(ME, "run", json!({"basis":basis,"steps":[{"command":"file.close"},{"command":"text.append","params":{"text":" after"}}]})).await;
    assert_ne!(answer["closed"], true, "{answer}");
    assert_eq!(answer["completed"].as_array().unwrap().len(), 2, "{answer}");
    assert_eq!(f.read(), "Original after");
    f.shutdown().await;
}

/// A receipt names an owned list by its holder's tool id and the nested path (a move of items
/// without tool ids is a change of `1` at `body.paragraphs`; a motion kit's layer move is
/// `{parent: 1, field: "comp.layers"}`); that place is a batch target as given, the number
/// or the string (call-context.md, "Ids in receipts and `others`"), and its raw operation is
/// checked with the contract of the object holding the last field (`list.move.paragraphs` of the
/// text body), with no declaration on the holder's owner (data-model.md, "Positional Batches And
/// Replay"). An operation that object declares no contract for still refuses.
#[tokio::test]
async fn nested_holder_receipts_replay_as_batch_targets() {
    let texts = |f: &Fixture| -> Vec<String> {
        let saved: Value = serde_json::from_str(&f.read()).unwrap();
        saved["paragraphs"].as_array().unwrap().iter().map(|p| p["text"].as_str().unwrap().to_owned()).collect()
    };
    for spelling in [json!(1), json!("1")] {
        for basis in [false, true] {
            let f = Fixture::new("heldcontract", "KITION_KIT_MOCK_ORDER=paragraphs KITION_KIT_MOCK_PARAGRAPHS=numbered", &paragraphs().to_string())
                .expect("build mock");
            let moved = f.ok(ME, "batch", json!({"ops":[{"op":"list.move","target":BODY,"field":"paragraphs","from":0,"to":2}]})).await;
            let changed = &moved["changes"]["changed"][0];
            assert_eq!((&changed["id"], &changed["fields"]), (&json!(1), &json!(["body.paragraphs"])), "the receipt names the holder by its number: {moved}");
            assert_eq!(texts(&f)[..2], ["Paragraph 1", "Paragraph 0"]);
            let mut input = json!({"ops":[{"op":"list.move","target":spelling,"field":"body.paragraphs","from":1,"to":0}]});
            if basis {
                input["basis"] = json!(f.revision(ME).await);
            }
            f.ok(ME, "batch", input).await;
            assert_eq!(texts(&f)[..2], ["Paragraph 0", "Paragraph 1"], "{spelling}/{basis}: the receipt's place replays");
            let before = f.read();
            let refused = f.refused(ME, "batch", json!({"ops":[{"op":"list.remove","target":spelling,"field":"body.paragraphs","index":0}]})).await;
            assert!(refused.to_string().contains("no premise contract"), "{spelling}/{basis}: an undeclared operation still refuses: {refused}");
            assert_eq!(f.read(), before);
            f.shutdown().await;
        }
    }
}
