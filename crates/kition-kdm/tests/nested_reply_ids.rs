// Copied from kition-sdk crates/kition-kdm/tests/nested_reply_ids.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use kition_kdm::{Schema, diff::diff_states, tool_ids::ToolIds};
use serde_json::json;

#[test]
fn nested_receipt_references_use_tool_ids() {
    let schema = Schema::parse(
        &json!({"kdm":1,"kit":"kit.mock","schemaVersion":1,"root":"Root","types":{
            "Root":{"fields":{"catalog":{"kind":"map","owns":true},"data":{"kind":"json"}}},
            "Node":{"fields":{"key":{"kind":"string","readOnly":true}},"toolId":{"field":"key","prefix":"node:"}}
        }})
        .to_string(),
    )
    .unwrap();
    let before = json!({"objects":{"root":{"$type":"Root","catalog":{},"data":{}},"raw-node":{"$type":"Node","key":"7"}}});
    let mut after = before.clone();
    after["objects"]["root"]["catalog"] = json!({"direct":"raw-node","wrapped":{"body":"raw-node","label":"literal"}});
    after["objects"]["root"]["data"] = json!({"deep":[{"target":"raw-node"}],"raw-node":"raw-node","literal":"text raw-node"});
    let names = ToolIds::of_state(&schema, &after);
    assert_eq!(names.show_json(&after["objects"]["root"]["data"]), json!({"deep":[{"target":"node:7"}],"node:7":"node:7","literal":"text raw-node"}));
    let diff = diff_states(&before, &after).with_tool_ids(&schema, &ToolIds::of_state(&schema, &before), &names).to_json();
    let edits = diff["changed"][0]["edits"].as_array().unwrap();
    assert_eq!(edits[0]["after"], json!({"direct":"node:7","wrapped":{"body":"node:7","label":"literal"}}));
    assert_eq!(edits[1]["after"], names.show_json(&after["objects"]["root"]["data"]));
}
