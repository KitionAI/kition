// Copied from kition-sdk crates/kition-kdm/tests/marks.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Marks on text (rule M19): schema declarations, transactions, reads, the canonical state, and
//! two-replica merges. `packages/kdm/test/marks.test.ts` is the TypeScript twin; the canonical
//! texts asserted here are asserted there too, so both implementations write the same state.

use std::sync::Arc;

use kition_kdm::{ActorId, DocId, Expand, KdmError, ObjectId, Replica, Schema, TextRun};
use serde_json::{Value, json};

mod common;
use common::{QUARTER, fields, from_code_points, person};

fn marks_schema() -> Arc<Schema> {
    Arc::new(Schema::parse(include_str!("fixtures/marks-schema.json")).expect("marks schema parses"))
}

const DOC: &str = "01920000-0000-7000-8000-0000000000bb";

fn replica(actor: u64) -> Replica {
    Replica::create(marks_schema(), DocId::parse(DOC).unwrap(), ActorId::from_u64(actor).unwrap()).unwrap()
}

fn id(text: &str) -> ObjectId {
    ObjectId::from_string(text.to_owned())
}

/// A replica holding paragraph `p1` with `text` in its marked field.
fn paragraph(actor: u64, text: &str) -> Replica {
    let mut replica = replica(actor);
    replica
        .transact(&person(), |tx| {
            let para = tx.create_with_id("Para", &id("p1"), fields(json!({})))?;
            tx.text_insert(&para, "text", 0, text)
        })
        .unwrap();
    replica
}

/// A second replica of `replica`'s document, loaded from its snapshot.
fn peer(replica: &Replica, actor: u64) -> Replica {
    Replica::load(marks_schema(), &replica.snapshot().unwrap(), ActorId::from_u64(actor).unwrap()).unwrap()
}

fn sync(a: &mut Replica, b: &mut Replica) {
    let to_b = a.export_changes(&b.version()).unwrap();
    let to_a = b.export_changes(&a.version()).unwrap();
    b.import_changes(&to_b).unwrap();
    a.import_changes(&to_a).unwrap();
    assert_eq!(a.state_json().unwrap(), b.state_json().unwrap(), "replicas converge");
}

fn run(text: &str, marks: Value) -> TextRun {
    let mut out = TextRun::new(text);
    for (key, value) in marks.as_object().cloned().unwrap_or_default() {
        out = out.with(key, value);
    }
    out
}

fn delta(replica: &Replica) -> Vec<TextRun> {
    replica.text_delta(&id("p1"), "text").unwrap()
}

/// The canonical text of a paragraph whose text is "Hello world", bold over "Hello", italic over
/// "lo wo", and a link over "world". The TypeScript twin asserts the same text.
const MARKED_PARAGRAPH: &str = r#""p1":{"$type":"Para","plain":"","text":[{"attributes":{"bold":true},"insert":"Hel"},{"attributes":{"bold":true,"italic":true},"insert":"lo"},{"attributes":{"italic":true},"insert":" "},{"attributes":{"italic":true,"link":"https://x"},"insert":"wo"},{"attributes":{"link":"https://x"},"insert":"rld"}]}"#;

#[test]
fn the_canonical_state_holds_a_marked_fields_runs_and_a_plain_fields_string() {
    let mut replica = paragraph(1, "Hello world");
    replica
        .transact(&person(), |tx| {
            let para = id("p1");
            tx.text_mark(&para, "text", 0, 5, "bold", json!(true))?;
            tx.text_mark(&para, "text", 3, 8, "italic", json!(true))?;
            tx.text_mark(&para, "text", 6, 11, "link", json!("https://x"))
        })
        .unwrap();
    let state = replica.state_json().unwrap().to_string();
    assert!(state.contains(MARKED_PARAGRAPH), "{state}");
    assert_eq!(replica.text(&id("p1"), "text").unwrap(), "Hello world", "the plain read is unchanged");
    assert_eq!(
        delta(&replica),
        vec![
            run("Hel", json!({ "bold": true })),
            run("lo", json!({ "bold": true, "italic": true })),
            run(" ", json!({ "italic": true })),
            run("wo", json!({ "italic": true, "link": "https://x" })),
            run("rld", json!({ "link": "https://x" })),
        ]
    );
    // A reloaded replica reads the same state.
    assert_eq!(peer(&replica, 2).state_json().unwrap(), replica.state_json().unwrap());
}

#[test]
fn positions_count_unicode_scalar_values_and_the_state_matches_typescript() {
    // "a", a grinning face (one scalar, two UTF-16 units), two ideographs, "b".
    let text = format!("a{}{}b", from_code_points(&[0x1F600]), from_code_points(&QUARTER));
    let mut replica = paragraph(1, &text);
    // The face and the first ideograph: scalars 1..3 here, UTF-16 units 1..4 in TypeScript.
    replica.transact(&person(), |tx| tx.text_mark(&id("p1"), "text", 1, 3, "bold", json!(1.0))).unwrap();
    let marked = format!("{}{}", from_code_points(&[0x1F600]), from_code_points(&QUARTER[..1]));
    let rest = format!("{}b", from_code_points(&QUARTER[1..]));
    assert_eq!(delta(&replica), vec![TextRun::new("a"), run(&marked, json!({ "bold": 1 })), TextRun::new(rest.as_str())]);
    let expected = format!(r#""text":[{{"insert":"a"}},{{"attributes":{{"bold":1}},"insert":"{marked}"}},{{"insert":"{rest}"}}]"#);
    let state = replica.state_json().unwrap().to_string();
    assert!(state.contains(&expected), "{state}");
}

#[test]
fn a_field_without_marks_reads_as_one_run_and_an_empty_text_as_none() {
    let mut replica = paragraph(1, "");
    assert!(delta(&replica).is_empty());
    replica.transact(&person(), |tx| tx.text_insert(&id("p1"), "plain", 0, "just text")).unwrap();
    assert_eq!(replica.text_delta(&id("p1"), "plain").unwrap(), vec![TextRun::new("just text")]);
    let state = replica.state_json().unwrap();
    assert_eq!(state["objects"]["p1"]["plain"], json!("just text"));
    assert_eq!(state["objects"]["p1"]["text"], json!([]));
}

#[test]
fn concurrent_insertions_at_one_position_of_a_marked_text_are_both_kept() {
    let mut a = paragraph(1, "ab");
    a.transact(&person(), |tx| tx.text_mark(&id("p1"), "text", 0, 2, "bold", json!(true))).unwrap();
    let mut b = peer(&a, 2);
    a.transact(&person(), |tx| tx.text_insert(&id("p1"), "text", 1, "X")).unwrap();
    b.transact(&person(), |tx| tx.text_insert(&id("p1"), "text", 1, "Y")).unwrap();
    sync(&mut a, &mut b);
    let text = a.text(&id("p1"), "text").unwrap();
    assert!(text == "aXYb" || text == "aYXb", "{text}");
    assert_eq!(delta(&a), vec![run(&text, json!({ "bold": true }))], "text typed inside a mark takes it");
}

#[test]
fn concurrent_bold_and_italic_over_overlapping_ranges_both_apply() {
    let mut a = paragraph(1, "Hello world");
    let mut b = peer(&a, 2);
    a.transact(&person(), |tx| tx.text_mark(&id("p1"), "text", 0, 5, "bold", json!(true))).unwrap();
    b.transact(&person(), |tx| tx.text_mark(&id("p1"), "text", 3, 8, "italic", json!(true))).unwrap();
    sync(&mut a, &mut b);
    assert_eq!(
        delta(&a),
        vec![
            run("Hel", json!({ "bold": true })),
            run("lo", json!({ "bold": true, "italic": true })),
            run(" wo", json!({ "italic": true })),
            TextRun::new("rld"),
        ]
    );
}

#[test]
fn concurrent_values_of_one_mark_resolve_to_one_value_per_character() {
    let mut a = paragraph(1, "Hello world");
    let mut b = peer(&a, 2);
    a.transact(&person(), |tx| tx.text_mark(&id("p1"), "text", 0, 8, "link", json!("https://a"))).unwrap();
    b.transact(&person(), |tx| tx.text_mark(&id("p1"), "text", 3, 11, "link", json!("https://b"))).unwrap();
    sync(&mut a, &mut b);
    let runs = delta(&a);
    let values: Vec<&Value> = runs.iter().filter_map(|run| run.attributes.get("link")).collect();
    assert!(!values.is_empty() && values.len() <= 3, "{runs:?}");
    assert_eq!(runs.iter().map(|run| run.insert.as_str()).collect::<String>(), "Hello world");
}

#[test]
fn typing_at_a_marks_end_follows_its_expand() {
    let mut replica = paragraph(1, "aaa bbb ccc ddd");
    let para = id("p1");
    replica
        .transact(&person(), |tx| {
            tx.text_mark(&para, "text", 0, 3, "bold", json!(true))?; // after
            tx.text_mark(&para, "text", 4, 7, "link", json!("u"))?; // none
            tx.text_mark(&para, "text", 8, 11, "lead", json!(true))?; // before
            tx.text_mark(&para, "text", 12, 15, "wide", json!(true)) // both
        })
        .unwrap();
    // Each insertion goes at both ends of a range, last range first so earlier positions hold.
    for (start, end) in [(12, 15), (8, 11), (4, 7), (0, 3)] {
        replica
            .transact(&person(), |tx| {
                tx.text_insert(&para, "text", end, "]")?;
                tx.text_insert(&para, "text", start, "[")
            })
            .unwrap();
    }
    assert_eq!(replica.text(&para, "text").unwrap(), "[aaa] [bbb] [ccc] [ddd]");
    assert_eq!(
        delta(&replica),
        vec![
            TextRun::new("["),
            run("aaa]", json!({ "bold": true })),
            TextRun::new(" ["),
            run("bbb", json!({ "link": "u" })),
            TextRun::new("] "),
            run("[ccc", json!({ "lead": true })),
            TextRun::new("] "),
            run("[ddd]", json!({ "wide": true })),
        ]
    );
}

#[test]
fn a_remote_replica_expands_a_mark_it_received() {
    let mut a = paragraph(1, "bold");
    a.transact(&person(), |tx| tx.text_mark(&id("p1"), "text", 0, 4, "bold", json!(true))).unwrap();
    let mut b = peer(&a, 2);
    b.transact(&person(), |tx| tx.text_insert(&id("p1"), "text", 4, "er")).unwrap();
    sync(&mut a, &mut b);
    assert_eq!(delta(&a), vec![run("bolder", json!({ "bold": true }))]);
}

#[test]
fn unmark_removes_a_mark_from_part_of_a_range() {
    let mut replica = paragraph(1, "Hello world");
    let para = id("p1");
    replica.transact(&person(), |tx| tx.text_mark(&para, "text", 0, 11, "bold", json!(true))).unwrap();
    replica.transact(&person(), |tx| tx.text_unmark(&para, "text", 3, 8, "bold")).unwrap();
    assert_eq!(delta(&replica), vec![run("Hel", json!({ "bold": true })), TextRun::new("lo wo"), run("rld", json!({ "bold": true }))]);
    // Unmarking unmarked characters changes nothing.
    replica.transact(&person(), |tx| tx.text_unmark(&para, "text", 3, 8, "italic")).unwrap();
    assert_eq!(delta(&replica).len(), 3);
}

#[test]
fn a_concurrent_unmark_and_insertion_converge() {
    let mut a = paragraph(1, "Hello");
    a.transact(&person(), |tx| tx.text_mark(&id("p1"), "text", 0, 5, "bold", json!(true))).unwrap();
    let mut b = peer(&a, 2);
    a.transact(&person(), |tx| tx.text_unmark(&id("p1"), "text", 0, 5, "bold")).unwrap();
    b.transact(&person(), |tx| tx.text_insert(&id("p1"), "text", 2, "XY")).unwrap();
    sync(&mut a, &mut b);
    assert_eq!(a.text(&id("p1"), "text").unwrap(), "HeXYllo");
}

#[test]
fn marks_are_undone_like_any_transaction() {
    let mut replica = paragraph(1, "Hello");
    replica.transact(&person(), |tx| tx.text_mark(&id("p1"), "text", 0, 5, "bold", json!(true))).unwrap();
    assert!(replica.undo().unwrap());
    assert_eq!(delta(&replica), vec![TextRun::new("Hello")]);
    assert!(replica.redo().unwrap());
    assert_eq!(delta(&replica), vec![run("Hello", json!({ "bold": true }))]);
}

#[test]
fn a_mark_in_the_transaction_that_typed_the_text_uses_the_pending_length() {
    let mut replica = replica(1);
    replica
        .transact(&person(), |tx| {
            let para = tx.create_with_id("Para", &id("p1"), fields(json!({})))?;
            tx.text_insert(&para, "text", 0, "new")?;
            tx.text_mark(&para, "text", 0, 3, "italic", json!(true))?;
            assert!(matches!(tx.text_mark(&para, "text", 0, 4, "italic", json!(true)), Err(KdmError::OutOfRange { index: 4, len: 3 })));
            Ok(())
        })
        .unwrap();
    assert_eq!(delta(&replica), vec![run("new", json!({ "italic": true }))]);
}

#[test]
fn undeclared_keys_bad_values_and_bad_ranges_are_refused() {
    let mut replica = paragraph(1, "Hello");
    let para = id("p1");
    let before = replica.version();
    let refused = |replica: &mut Replica, f: &dyn Fn(&mut kition_kdm::Tx<'_>) -> kition_kdm::Result<()>| replica.transact(&person(), |tx| f(tx)).unwrap_err();
    assert!(
        matches!(refused(&mut replica, &|tx| tx.text_mark(&para, "text", 0, 2, "color", json!("red"))), KdmError::InvalidValue { reason, .. } if reason.contains("declares no mark `color`"))
    );
    assert!(matches!(refused(&mut replica, &|tx| tx.text_mark(&para, "plain", 0, 0, "bold", json!(true))), KdmError::InvalidValue { .. }));
    assert!(matches!(refused(&mut replica, &|tx| tx.text_unmark(&para, "text", 0, 2, "color")), KdmError::InvalidValue { .. }));
    assert!(matches!(refused(&mut replica, &|tx| tx.text_mark(&para, "text", 0, 2, "bold", Value::Null)), KdmError::InvalidValue { .. }));
    assert!(matches!(refused(&mut replica, &|tx| tx.text_mark(&para, "text", 0, 2, "bold", json!({ "n": 1u64 << 60 }))), KdmError::InvalidValue { .. }));
    assert!(matches!(refused(&mut replica, &|tx| tx.text_mark(&para, "text", 0, 6, "bold", json!(true))), KdmError::OutOfRange { index: 6, len: 5 }));
    assert!(matches!(refused(&mut replica, &|tx| tx.text_mark(&para, "text", 4, 2, "bold", json!(true))), KdmError::OutOfRange { index: 4, len: 2 }));
    assert!(matches!(refused(&mut replica, &|tx| tx.text_mark(&para, "nope", 0, 2, "bold", json!(true))), KdmError::UnknownField { .. }));
    // An empty range is no operation: the transaction changes nothing.
    replica.transact(&person(), |tx| tx.text_mark(&para, "text", 2, 2, "bold", json!(true))).unwrap();
    assert_eq!(replica.version(), before);
}

#[test]
fn a_mark_key_a_newer_schema_declares_is_left_out_of_an_older_readers_state() {
    let mut json: Value = serde_json::from_str(include_str!("fixtures/marks-schema.json")).unwrap();
    json["schemaVersion"] = json!(2);
    json["types"]["Para"]["fields"]["text"]["marks"]["color"] = json!({ "expand": "after" });
    let newer = Arc::new(Schema::parse(&json.to_string()).unwrap());
    let old = paragraph(1, "Hello");
    let mut new = Replica::load(newer, &old.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    new.transact(&person(), |tx| tx.text_mark(&id("p1"), "text", 0, 5, "color", json!("red"))).unwrap();
    assert_eq!(new.text_delta(&id("p1"), "text").unwrap(), vec![run("Hello", json!({ "color": "red" }))]);
    let mut old = old;
    old.import_changes(&new.export_changes(&old.version()).unwrap()).unwrap();
    assert_eq!(delta(&old), vec![TextRun::new("Hello")], "rule M15: the canonical state follows the reader's schema");
}

fn schema_with_field(field: Value) -> kition_kdm::Result<Schema> {
    Schema::parse(&json!({ "kdm": 1, "kit": "k", "schemaVersion": 1, "root": "A", "types": { "A": { "fields": { "f": field } } } }).to_string())
}

#[test]
fn the_schema_declares_marks_on_text_fields_only_with_valid_keys_and_one_expand_each() {
    let marks = schema_with_field(json!({ "kind": "text", "marks": { "bold": { "expand": "after" }, "link": { "expand": "none" } } })).unwrap();
    let field = marks.field("A", "f").unwrap();
    assert!(field.has_marks());
    assert_eq!(field.marks["link"].expand, Expand::None);
    for bad in [
        json!({ "kind": "string", "marks": { "bold": { "expand": "after" } } }),
        json!({ "kind": "text", "marks": { "a:b": { "expand": "after" } } }),
        json!({ "kind": "text", "marks": { "$bold": { "expand": "after" } } }),
        json!({ "kind": "text", "marks": { "": { "expand": "after" } } }),
        json!({ "kind": "text", "marks": { "__proto__": { "expand": "after" } } }),
        json!({ "kind": "text", "marks": { "bold": { "expand": "sideways" } } }),
        json!({ "kind": "text", "marks": { "bold": {} } }),
        json!({ "kind": "text", "marks": { "bold": { "expand": "after", "color": 1 } } }),
        json!({ "kind": "text", "marks": ["bold"] }),
    ] {
        assert!(matches!(schema_with_field(bad.clone()), Err(KdmError::Schema(_))), "{bad}");
    }
    let conflicting = json!({
        "kdm": 1, "kit": "k", "schemaVersion": 1, "root": "A",
        "types": {
            "A": { "fields": { "f": { "kind": "text", "marks": { "bold": { "expand": "after" } } } } },
            "B": { "fields": { "g": { "kind": "text", "marks": { "bold": { "expand": "none" } } } } }
        }
    });
    assert!(matches!(Schema::parse(&conflicting.to_string()), Err(KdmError::Schema(message)) if message.contains("one expand")));
}
