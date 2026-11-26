// Copied from kition-sdk crates/kition-kdm/tests/reply_costs.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! An agent's reply named in tool ids costs about the reply, not the document (`ToolIds::show_reply`,
//! `Replica::tool_ids`): every `ai/inspect`, `document/check` and `ai/run` reply of an engine passes
//! through `modelReply`, and building the tool ids reads every object (Kition Sheet measured 1.5 to
//! 3.7 s a reply at 200,000 cells). A reply naming no object reads none; one naming objects reads
//! the tool ids once per state, and a change of the state reads them again.

use std::sync::Arc;
use std::time::{Duration, Instant};

use kition_kdm::tool_ids::ToolIds;
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema};
use serde_json::{Map, Value, json};

const SCHEMA: &str = r#"{
  "kdm": 1, "kit": "kit.reply-costs", "schemaVersion": 1, "root": "Sheet",
  "types": {
    "Sheet": { "fields": { "cells": { "kind": "list", "of": "Cell" } } },
    "Cell": { "fields": { "number": { "kind": "integer", "optional": true, "readOnly": true }, "text": { "kind": "string", "optional": true } }, "toolId": { "field": "number", "prefix": "cell:" } }
  }
}"#;

const CELLS: usize = 100_000;

fn cell(number: usize) -> Map<String, Value> {
    Map::from_iter([("number".to_owned(), json!(number)), ("text".to_owned(), json!("x"))])
}

/// A sheet of [`CELLS`] numbered cells; answers it, the sheet, and the first cell.
fn sheet() -> (Replica, ObjectId, ObjectId) {
    let schema = Arc::new(Schema::parse(SCHEMA).expect("schema"));
    let (replica, (sheet, first)) = Replica::create_with(schema, DocId::new(), ActorId::from_u64(1).expect("actor"), &Origin::system("import"), |tx| {
        let sheet = tx.create("Sheet", Map::new())?;
        let mut first = None;
        for at in 0..CELLS {
            let made = tx.create("Cell", cell(at + 1))?;
            tx.list_insert(&sheet, "cells", at, &made)?;
            if at == 0 {
                first = Some(made);
            }
        }
        Ok((sheet, first.unwrap_or_default()))
    })
    .expect("sheet");
    (replica, sheet, first)
}

#[test]
fn replies_naming_no_object_read_no_tool_ids_and_named_ones_read_them_once_per_state() {
    let (mut replica, sheet, first) = sheet();

    // A reply that names no object comes back as it is, without a walk of the document.
    let plain = json!({ "ok": true, "summary": "Sum of column B", "rows": [1, 2, 3], "cells": { "B2:B9": "range" }, "notes": ["cell:1"] });
    let started = Instant::now();
    for _ in 0..100 {
        assert_eq!(ToolIds::show_reply(&replica, &plain), plain);
    }
    let plain_took = started.elapsed();
    assert!(plain_took < Duration::from_millis(500), "100 replies naming nothing took {plain_took:?}");

    // A reply naming a cell: the first reads the tool ids, the next 100 reuse them.
    let named = json!({ "target": first.to_string(), "details": { first.to_string(): [first.to_string()] } });
    let expected = json!({ "target": "cell:1", "details": { "cell:1": ["cell:1"] } });
    assert_eq!(ToolIds::show_reply(&replica, &named), expected);
    let started = Instant::now();
    for _ in 0..100 {
        assert_eq!(ToolIds::show_reply(&replica, &named), expected);
    }
    let named_took = started.elapsed();
    assert!(named_took < Duration::from_secs(1), "100 replies naming one cell took {named_took:?}");

    // A cell made after the tool ids were read is named too: the change dropped them.
    let made = replica
        .transact(&Origin::person("user:test"), |tx| {
            let made = tx.create("Cell", cell(CELLS + 1))?;
            tx.list_insert(&sheet, "cells", CELLS, &made)?;
            Ok(made)
        })
        .expect("new cell");
    assert_eq!(ToolIds::show_reply(&replica, &json!({ "target": made.to_string() })), json!({ "target": format!("cell:{}", CELLS + 1) }));
    // And an undo of it drops them again: its id is shown as it is (no object, no tool id).
    assert!(replica.undo().expect("undo").is_done());
    assert_eq!(ToolIds::show_reply(&replica, &json!({ "target": made.to_string() })), json!({ "target": made.to_string() }));
    assert!(Arc::ptr_eq(&replica.tool_ids(), &replica.tool_ids()), "one state, one table");
}

/// What the editor asks after every change costs about what it names or what the change touched,
/// not the document: on a 200,000-object document, 100 rounds of one edit and one reply naming
/// the edited cell, 100 rounds of one edit and its receipt (`changes_since`), and 100 descriptions
/// of the object model (its root found without a walk) each take well under a second.
#[test]
fn a_reply_a_receipt_and_a_description_after_each_edit_cost_what_they_name() {
    const LARGE: usize = 200_000;
    let schema = Arc::new(Schema::parse(SCHEMA).expect("schema"));
    let (mut replica, (sheet, cells)) = Replica::create_with(schema, DocId::new(), ActorId::from_u64(1).expect("actor"), &Origin::system("import"), |tx| {
        let sheet = tx.create("Sheet", Map::new())?;
        let mut cells = Vec::new();
        for at in 0..LARGE {
            let made = tx.create("Cell", cell(at + 1))?;
            tx.list_insert(&sheet, "cells", at, &made)?;
            if at % 2_000 == 0 {
                cells.push((made, at + 1));
            }
        }
        Ok((sheet, cells))
    })
    .expect("sheet");
    let person = Origin::person("user:test");

    let started = Instant::now();
    for (round, (made, number)) in cells.iter().enumerate() {
        replica.transact(&person, |tx| tx.set(made, "text", json!(format!("edit {round}")))).expect("edit");
        let shown = ToolIds::show_reply(&replica, &json!({ "target": made.to_string() }));
        assert_eq!(shown, json!({ "target": format!("cell:{number}") }));
    }
    let replies = started.elapsed();
    assert!(replies < Duration::from_secs(1), "100 edits and replies took {replies:?}");

    let started = Instant::now();
    for (round, (made, _)) in cells.iter().enumerate() {
        let since = replica.version();
        replica.transact(&person, |tx| tx.set(made, "text", json!(format!("again {round}")))).expect("edit");
        let receipt = replica.changes_since(&since).expect("receipt").to_json();
        assert!(receipt.to_string().contains("cell:"), "{receipt}");
    }
    let receipts = started.elapsed();
    assert!(receipts < Duration::from_secs(1), "100 edits and receipts took {receipts:?}");

    let started = Instant::now();
    for _ in 0..100 {
        assert_eq!(kition_kdm::batch::describe(&replica)["rootId"], json!(sheet.to_string()));
    }
    let described = started.elapsed();
    assert!(described < Duration::from_millis(500), "100 descriptions took {described:?}");
}
