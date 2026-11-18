// Copied from kition-sdk crates/kition-kits/tests/support/guard_regressions.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;

#[tokio::test]
async fn owned_register_changes_conflict_only_with_held_members() {
    let mut failures = Vec::new();
    for route in ["run", "batch"] {
        for hold in ["data.parts.b", "data.parts.a", "data.parts"] {
            let file = json!({"items":[{"key":"A","name":"Alpha","data":{"a":"Original A","b":"Original B"},"extra":0}],"other":[]});
            let f =
                Fixture::new("ownedregister", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_BATCH=commands KITION_KIT_MOCK_OWNED_JSON=1", &file.to_string())
                    .expect("build mock");
            let basis = f.revision(ME).await;
            let mut after = file.clone();
            after["items"][0]["data"]["a"] = json!("Colleague");
            f.write_outside(&after.to_string());
            let params = json!({"item":"A","hold":[hold],"write":"extra","value":42});
            let input = if route == "run" {
                json!({"basis":basis,"steps":[{"command":"matrix.write","params":params}]})
            } else {
                json!({"basis":basis,"ops":[{"op":"command","id":"matrix.write","params":params}]})
            };
            let result = f.call(ME, route, input).await;
            let receipt = result.as_ref().unwrap_or_else(|error| error);
            assert_public(receipt);
            assert!(receipt["others"].get("$objects").is_none() && receipt["others"].get("$premises").is_none(), "{receipt}");
            if hold == "data.parts.b" {
                if let Err(error) = &result {
                    failures.push(format!("{route}/{hold}: unrelated member refused: {error}"));
                } else {
                    after["items"][0]["extra"] = json!(42);
                }
            } else {
                let error = result.expect_err("held member and whole register must refuse");
                assert!(error["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == "changed"), "{route}/{hold}: {error}");
            }
            assert_eq!(serde_json::from_str::<Value>(&f.read()).unwrap(), after);
            f.shutdown().await;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn raw_list_moves_use_pre_removal_destination_gaps() {
    for stale in [false, true] {
        for (from, to, order) in
            [(0, 2, vec![1, 0, 2, 3]), (0, 4, vec![1, 2, 3, 0]), (3, 1, vec![0, 3, 1, 2]), (1, 2, vec![0, 1, 2, 3]), (1, 1, vec![0, 1, 2, 3])]
        {
            let file = paragraphs_for_move();
            let f = Fixture::new("rawmove", "KITION_KIT_MOCK_ORDER=paragraphs", &file.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            let mut after = file.clone();
            if stale {
                after["paragraphs"][3]["text"] = json!("Unrelated text");
                f.write_outside(&after.to_string());
            }
            let result =
                f.call(ME, "batch", json!({"basis":basis,"ops":[{"op":"list.move","target":"shape:1","field":"body.paragraphs","from":from,"to":to}]})).await;
            assert!(result.is_ok(), "{stale}/{from}/{to}: {result:?}");
            let saved: Value = serde_json::from_str(&f.read()).unwrap();
            assert_eq!(saved["paragraphs"], json!(order.into_iter().map(|at| after["paragraphs"][at].clone()).collect::<Vec<_>>()), "{stale}/{from}/{to}");
            f.shutdown().await;
        }
    }
}

fn paragraphs_for_move() -> Value {
    json!({"paragraphs":(0..4).map(|index|json!({"id":format!("00000000-0000-0000-0000-{:012}",100+index),"text":format!("Paragraph {index}")})).collect::<Vec<_>>()})
}

#[tokio::test]
async fn indexed_json_relocation_wins_over_another_changed_member() {
    for outside in [false, true] {
        for change in ["both", "changed", "unrelated"] {
            let original = records();
            let f = Fixture::new("indexedpriority", "KITION_KIT_MOCK_ORDER=matrix", &original.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            let mut after = original;
            if change != "unrelated" {
                after["items"][0]["data"]["members"][0]["value"] = json!(9);
            }
            if change == "both" {
                after["items"][0]["data"]["members"].as_array_mut().unwrap().push(json!({"key":"c","name":"Gamma","value":3}));
                after["items"][0]["data"]["members"].as_array_mut().unwrap().swap(1, 2);
            } else if change == "unrelated" {
                after["items"][0]["name"] = json!("Colleague");
            }
            matrix_change(
                &f,
                outside,
                &after,
                vec![
                    json!({"op":"set","target":"A","field":"data","value":after["items"][0]["data"]}),
                    json!({"op":"set","target":"A","field":"name","value":after["items"][0]["name"]}),
                ],
            )
            .await;
            let answer = f.call(ME, "run", json!({"basis":basis,"steps":[{"command":"matrix.write","params":{"item":"A","holds":[{"fields":["data.members.0.value","data.members.1.value"],"identities":{"data.members.0.value":"key","data.members.1.value":"key"},"positions":[]}]}}]})).await;
            if change == "unrelated" {
                assert!(answer.is_ok(), "{outside}/{change}: {answer:?}");
            } else {
                let error = answer.expect_err("changed indexed resource must refuse");
                let reason = if change == "both" { "relocated" } else { "changed" };
                assert!(error["conflicts"].as_array().unwrap().iter().any(|c| c["reason"] == reason), "{outside}/{change}: {error}");
                assert_eq!(serde_json::from_str::<Value>(&f.read()).unwrap(), after);
            }
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn outside_register_changes_conflict_only_with_held_members() {
    let mut failures = Vec::new();
    for raw in [false, true] {
        for route in ["run", "batch"] {
            for hold in ["data.b", "data.a", "data"] {
                let file = json!({"items":[{"key":"A","name":"Alpha","data":{"a":"Original A","b":"Original B"},"extra":0}],"other":[]});
                let f = Fixture::new(
                    "registerreread",
                    &format!("KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_BATCH=commands {}", if raw { "KITION_KIT_MOCK_RAW_RECORDS=1" } else { "" }),
                    &file.to_string(),
                )
                .expect("build mock");
                let basis = f.revision(ME).await;
                let mut after = file.clone();
                after["items"][0]["data"]["a"] = json!("Colleague");
                f.write_outside(&after.to_string());
                let before = f.read();
                let params =
                    json!({"item":"A","hold":[hold],"write":hold,"value":if hold == "data" {json!({"a":"Agent A","b":"Agent B"})} else {json!("Agent")}});
                let input = if route == "run" {
                    json!({"basis":basis,"steps":[{"command":"matrix.write","params":params}]})
                } else {
                    json!({"basis":basis,"ops":[{"op":"command","id":"matrix.write","params":params}]})
                };
                let result = f.call(ME, route, input).await;
                let receipt = result.as_ref().unwrap_or_else(|error| error);
                assert_eq!(
                    receipt["others"]["changed"],
                    json!([{"id":"A","type":"Item","fields":["data.a"],"edits":[{"field":"data.a","before":"Original A","after":"Colleague"}]}]),
                    "raw={raw}/{route}/{hold}: {receipt}"
                );
                if hold == "data.b" {
                    if let Err(error) = &result {
                        failures.push(format!("raw={raw}/{route}/{hold}: unrelated member refused: {error}"));
                    } else {
                        let saved: Value = serde_json::from_str(&f.read()).unwrap();
                        assert_eq!(saved["items"][0]["data"], json!({"a":"Colleague","b":"Agent"}));
                    }
                } else {
                    let error = result.expect_err("changed member and whole register must refuse");
                    assert!(
                        error["conflicts"].as_array().unwrap().iter().any(|c| c["id"] == "A" && c["reason"] == "changed"),
                        "raw={raw}/{route}/{hold}: {error}"
                    );
                    assert_eq!(f.read(), before);
                }
                f.shutdown().await;
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn raw_ids_survive_outside_list_deletions() {
    let target = "00000000-0000-0000-0000-000000000002";
    for route in ["batch", "run"] {
        for change in ["earlier", "held", "deleted"] {
            let file = json!({"items":[{"id":"00000000-0000-0000-0000-000000000001","name":"Alpha"},{"id":target,"name":"Beta"},{"id":"00000000-0000-0000-0000-000000000003","name":"Later"}],"other":[]});
            let f = Fixture::new(
                "rawidcheckpoint",
                "KITION_KIT_MOCK_ORDER=list KITION_KIT_MOCK_BATCH_INDEPENDENT=1 KITION_KIT_MOCK_ORDER_ROOT_ID=1",
                &file.to_string(),
            )
            .expect("build mock");
            let basis = f.revision(ME).await;
            let mut after = file.clone();
            after["items"].as_array_mut().unwrap().remove(0);
            if change == "held" {
                after["items"][0]["name"] = json!("Changed later");
            } else if change == "deleted" {
                after["items"].as_array_mut().unwrap().remove(0);
            }
            f.write_outside(&after.to_string());
            let before = f.read();
            let input = if route == "batch" {
                json!({"basis":basis,"ops":[{"op":"set","target":target,"field":"name","value":"Agent"}]})
            } else {
                // The kit declares an empty content premise for this id.
                json!({"basis":basis,"steps":[{"command":"order.index","params":{"item":target,"at":"#100"}}]})
            };
            let result = f.call(ME, route, input).await;
            let reason = if change == "deleted" {
                Some("deleted")
            } else if change == "held" && route == "batch" {
                Some("changed")
            } else {
                None
            };
            if let Some(reason) = reason {
                let error = result.expect_err("held facts must still refuse");
                assert!(error["conflicts"].is_array(), "{route}/{change}: {error}");
                assert!(error["conflicts"].as_array().unwrap().iter().any(|c| c["id"] == target && c["reason"] == reason), "{route}/{change}: {error}");
                assert_eq!(f.read(), before);
            } else {
                assert!(result.is_ok(), "{route}/{change}: {result:?}");
            }
            f.shutdown().await;
        }
    }
}

fn assert_public(value: &Value) {
    match value {
        Value::Object(fields) => {
            for (name, value) in fields {
                assert!(!name.starts_with('~'), "private key: {name}");
                assert_public(value);
            }
        }
        Value::Array(items) => items.iter().for_each(assert_public),
        Value::String(text) => assert!(!text.starts_with('~'), "private field: {text}"),
        _ => {}
    }
}

#[tokio::test]
async fn outside_receipts_hide_created_changed_and_deleted_private_facts() {
    for change in ["created", "changed", "deleted"] {
        let mut file = records();
        file["other"] = json!([{"key":"X","name":"Related","data":{"layer":if change == "created" {"C"} else {"A"}},"extra":0}]);
        let f = Fixture::new("privatereceipts", "KITION_KIT_MOCK_ORDER=matrix KITION_KIT_MOCK_DERIVED=1", &file.to_string()).expect("build mock");
        let basis = f.revision(ME).await;
        let mut after = file.clone();
        match change {
            "created" => after["items"].as_array_mut().unwrap().push(json!({"key":"C","name":"Created","data":{"privateValue":"secret"},"extra":3})),
            "changed" => after["items"][0]["data"] = json!({"changed":true}),
            _ => {
                after["items"].as_array_mut().unwrap().remove(0);
            }
        }
        f.write_outside(&after.to_string());
        let answer = f.ok(ME, "inspect", json!({"basis":basis})).await;
        assert!(answer["others"].is_object(), "{answer}");
        assert_public(&answer);
        f.shutdown().await;
    }
}

#[tokio::test]
async fn invalid_on_precedes_premise_conflicts() {
    for stale in [false, true] {
        for on in [json!(["shape:1", "shape:2"]), json!([]), json!(["shape:1"])] {
            let f = Fixture::deck("invalidonfirst").expect("build mock");
            let basis = f.revision(ME).await;
            if stale {
                f.ok(OTHER, "run", json!({"steps":[{"command":"shape.text","params":{"id":"shape:1","text":"Outside"}}]})).await;
            }
            let before = f.read();
            let params = if on == json!(["shape:1"]) { json!({"id":"shape:1","text":"Agent"}) } else { json!({"text":"Agent"}) };
            let error = f.refused(ME, "run", json!({"basis":basis,"steps":[{"command":"shape.text","on":on,"params":params}]})).await;
            assert_eq!(error["error"]["code"], "invalid-params", "{stale}/{on}: {error}");
            assert_eq!(error["error"]["index"], 0);
            assert_eq!(f.read(), before);
            f.shutdown().await;
        }
    }
}

#[tokio::test]
async fn invalid_raw_values_precede_contract_admission() {
    for stale in [false, true] {
        for (target, field, value) in [("root", "items", json!([])), ("A", "name", json!(17)), ("A", "name", Value::Null)] {
            let file = json!({"items":[{"id":"A","name":"Alpha"}],"other":[]});
            // This kit intentionally declares no raw contracts.
            let f = Fixture::new("batchcontract", "KITION_KIT_MOCK_ORDER=list", &file.to_string()).expect("build mock");
            let basis = f.revision(ME).await;
            if stale {
                let mut after = file.clone();
                after["items"][0]["name"] = json!("Outside");
                f.write_outside(&after.to_string());
            }
            let before = f.read();
            let op = if value.is_null() {
                json!({"op":"list.move","target":target,"field":field,"from":0,"to":0})
            } else {
                json!({"op":"set","target":target,"field":field,"value":value})
            };
            let error = f.refused(ME, "batch", json!({"basis":basis,"ops":[op]})).await;
            assert_eq!(error["error"]["code"], "invalid-value", "{stale}/{field}: {error}");
            assert_eq!(error["error"]["index"], 0);
            assert_eq!(f.read(), before);
            f.shutdown().await;
        }
    }
}
