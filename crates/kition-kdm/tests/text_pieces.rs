// Copied from kition-sdk crates/kition-kdm/tests/text_pieces.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Long text inserts go to the engine in pieces (the engine scans a text element on every edit
//! inside it), and the result reads as one insert: the text, its marks, undo, and other replicas
//! see the content as inserted. The release-only test holds the cost of an edit independent of
//! the document's size; `examples/text_edits.rs` measures it against the merge budget.

use std::sync::Arc;

use kition_kdm::{ActorId, DocId, ObjectId, Replica, Schema, TextRun};
use serde_json::json;

mod common;
use common::{CHARACTER, QUARTER, fields, from_code_points, person};

fn marks_schema() -> Arc<Schema> {
    Arc::new(Schema::parse(include_str!("fixtures/marks-schema.json")).expect("marks schema parses"))
}

fn id(text: &str) -> ObjectId {
    ObjectId::from_string(text.to_owned())
}

/// About `chars` characters of prose mixing ASCII, CJK ideographs, and an emoji.
fn mixed(chars: usize) -> String {
    let emoji = from_code_points(&[0x1F642]);
    let line = format!("Goals for the quarter {} and {} {emoji}\n", from_code_points(&QUARTER), from_code_points(&CHARACTER));
    line.repeat(chars / line.chars().count() + 1)
}

fn paragraph(actor: u64, text: &str) -> Replica {
    let mut replica = Replica::create(marks_schema(), DocId::new(), ActorId::from_u64(actor).unwrap()).unwrap();
    replica.transact(&person(), |tx| tx.create_with_id("Para", &id("p1"), fields(json!({}))).map(drop)).unwrap();
    replica.transact(&person(), |tx| tx.text_insert(&id("p1"), "text", 0, text)).unwrap();
    replica
}

#[test]
fn a_long_insert_reads_as_inserted_in_the_replica_its_snapshot_and_its_peers() {
    let long = mixed(5_000);
    let mut replica = paragraph(1, "[]");
    replica.transact(&person(), |tx| tx.text_insert(&id("p1"), "text", 1, &long)).unwrap();
    let expected = format!("[{long}]");
    assert_eq!(replica.text(&id("p1"), "text").unwrap(), expected);

    let loaded = Replica::load(marks_schema(), &replica.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    assert_eq!(loaded.text(&id("p1"), "text").unwrap(), expected);

    let mut peer = Replica::create(marks_schema(), replica.doc_id(), ActorId::from_u64(3).unwrap()).unwrap();
    peer.import_changes(&replica.export_changes(&peer.version()).unwrap()).unwrap();
    assert_eq!(peer.text(&id("p1"), "text").unwrap(), expected);
    assert_eq!(peer.state_hash().unwrap(), replica.state_hash().unwrap());
}

#[test]
fn a_long_insert_is_one_undo_step_and_marks_span_its_pieces() {
    let long = mixed(3_000);
    let count = long.chars().count();
    let mut replica = paragraph(1, "");
    replica
        .transact(&person(), |tx| {
            tx.text_insert(&id("p1"), "text", 0, &long)?;
            tx.text_mark(&id("p1"), "text", 10, count - 10, "bold", json!(true))
        })
        .unwrap();
    let head: String = long.chars().take(10).collect();
    let middle: String = long.chars().skip(10).take(count - 20).collect();
    let tail: String = long.chars().skip(count - 10).collect();
    assert_eq!(replica.text_delta(&id("p1"), "text").unwrap(), vec![TextRun::new(head), TextRun::new(middle).with("bold", json!(true)), TextRun::new(tail)]);

    assert!(replica.undo().unwrap());
    assert_eq!(replica.text(&id("p1"), "text").unwrap(), "");
    assert!(replica.redo().unwrap());
    assert_eq!(replica.text(&id("p1"), "text").unwrap(), long);
}

/// Milliseconds for `edits` scattered one-character replacements, last first, in one `system`
/// transaction, on `text` imported in one insert; the fastest of three.
#[cfg(not(debug_assertions))]
fn edits_ms(text: &str, edits: usize) -> f64 {
    let schema = Arc::new(
        Schema::parse(r#"{"kdm":1,"kit":"kit.test-note","schemaVersion":1,"root":"Note","types":{"Note":{"fields":{"body":{"kind":"text"}}}}}"#).unwrap(),
    );
    let step = text.chars().count() / (edits + 1);
    (0..3)
        .map(|_| {
            let (mut replica, note) = Replica::create_with(Arc::clone(&schema), DocId::new(), ActorId::random(), &kition_kdm::Origin::system("import"), |tx| {
                let note = tx.create("Note", fields(json!({})))?;
                tx.text_insert(&note, "body", 0, text)?;
                Ok(note)
            })
            .unwrap();
            let start = std::time::Instant::now();
            replica
                .transact(&kition_kdm::Origin::system("import"), |tx| {
                    for k in (1..=edits).rev() {
                        tx.text_delete(&note, "body", k * step, 1)?;
                        tx.text_insert(&note, "body", k * step, "x")?;
                    }
                    Ok(())
                })
                .unwrap();
            start.elapsed().as_secs_f64() * 1000.0
        })
        .fold(f64::INFINITY, f64::min)
}

/// An edit on 1 MB costs about what one on 64 KB costs (with the text in one element it cost
/// 26 times as much, and the note's 1 MB merge took seconds).
#[cfg(not(debug_assertions))]
#[test]
fn an_edit_costs_the_same_on_a_large_text_as_on_a_small_one() {
    let large = edits_ms(&mixed(1_000_000), 5_817) / 5_817.0;
    let small = edits_ms(&mixed(64_000), 372) / 372.0;
    assert!(large < small * 4.0, "an edit on 1 MB costs {:.1} times one on 64 KB", large / small);
}
