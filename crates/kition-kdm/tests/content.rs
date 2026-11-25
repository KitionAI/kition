// Copied from kition-sdk crates/kition-kdm/tests/content.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The content encoding (data model 7.4): every rule is a test here, through [`Replica::load`],
//! [`Replica::content_snapshot`] and [`Replica::snapshot`], the one reader and writer. The
//! fixtures under `fixtures/content/` are the bytes it writes; they are written by hand from the
//! rules and never regenerated to make a test pass. Every byte comparison prints both sides in
//! full when it fails.

use std::sync::Arc;
use std::time::{Duration, Instant};

use kition_kdm::{ActorId, DocId, KdmError, ObjectId, Origin, Replica, Schema};
use serde_json::{Map, Value, json};

const DOC: &str = "0193a5c4-0000-7000-8000-000000000001";

fn schema() -> Arc<Schema> {
    Arc::new(Schema::parse(include_str!("fixtures/content/schema.json")).expect("content schema parses"))
}

/// The content schema grown: marks on `Board.notes`, a new register `Board.subtitle` and a new
/// list `Page.tags`.
fn grown_schema() -> Arc<Schema> {
    let mut json: Value = serde_json::from_str(include_str!("fixtures/content/schema.json")).expect("the schema is JSON");
    json["schemaVersion"] = json!(3);
    json["types"]["Board"]["fields"]["notes"]["marks"] = json!({ "em": { "expand": "after" } });
    json["types"]["Board"]["fields"]["subtitle"] = json!({ "kind": "string", "optional": true });
    json["types"]["Page"]["fields"]["tags"] = json!({ "kind": "list", "of": "Page" });
    Arc::new(Schema::parse(&json.to_string()).expect("the grown schema parses"))
}

fn actor() -> ActorId {
    ActorId::from_u64(7).expect("an actor")
}

fn person() -> Origin {
    Origin::person("user:test")
}

fn id(name: &str) -> ObjectId {
    ObjectId::from_string(name)
}

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Fails unless `actual` is `expected` byte for byte, printing both in full.
#[track_caller]
fn assert_bytes(actual: &[u8], expected: &[u8], what: &str) {
    if actual != expected {
        panic!(
            "{what}: the bytes differ\n--- actual ({} bytes) ---\n{}\n--- expected ({} bytes) ---\n{}\n--- actual, escaped ---\n{:?}\n--- expected, escaped ---\n{:?}",
            actual.len(),
            text(actual),
            expected.len(),
            text(expected),
            text(actual),
            text(expected)
        );
    }
}

/// Content of `kit.content` (document [`DOC`], schema version 2) holding these object lines.
fn file(objects: &[&str]) -> String {
    let mut out = format!("{{\"kdm\":1,\"kit\":\"kit.content\",\"docId\":\"{DOC}\",\"schemaVersion\":2,\"objects\":{{\n");
    out.push_str(&objects.join(",\n"));
    if !objects.is_empty() {
        out.push('\n');
    }
    out.push_str("}}\n");
    out
}

#[track_caller]
fn load(bytes: &[u8]) -> Replica {
    Replica::load(schema(), bytes, actor()).unwrap_or_else(|error| panic!("{error}: {}", text(bytes)))
}

/// Loads `bytes` and saves them again: the content written.
#[track_caller]
fn resaved(bytes: &[u8]) -> Vec<u8> {
    load(bytes).content_snapshot().expect("the content writes")
}

/// Fails unless loading `bytes` is refused as not the encoding.
#[track_caller]
fn assert_refused(bytes: &[u8], what: &str) {
    match Replica::load(schema(), bytes, actor()) {
        Err(KdmError::Encoding(_)) => {}
        Err(other) => panic!("{what}: refused as {other:?}, not as an encoding error: {}", text(bytes)),
        Ok(_) => panic!("{what}: loaded: {}", text(bytes)),
    }
}

/// A new document of `kit.content` with id [`DOC`], its objects made by `build`.
fn built(schema: Arc<Schema>, build: impl FnOnce(&mut kition_kdm::Tx<'_>) -> kition_kdm::Result<()>) -> Replica {
    let mut replica = Replica::create(schema, DocId::parse(DOC).expect("a doc id"), actor()).expect("a document");
    replica.transact(&person(), build).expect("the transaction applies");
    replica
}

/// A state's JSON in canonical form: keys sorted, whole doubles within ±2^53 as integers.
fn canonical(value: Value) -> Value {
    match value {
        Value::Number(number) if !number.is_i64() && !number.is_u64() => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() <= 9_007_199_254_740_992.0 => Value::from(float as i64),
            _ => Value::Number(number),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(canonical).collect()),
        Value::Object(fields) => Value::Object(fields.into_iter().map(|(key, value)| (key, canonical(value))).collect()),
        other => other,
    }
}

/// Each fixture: its name, its canonical state, its bytes, and whether it is a snapshot.
fn fixtures() -> Vec<(&'static str, &'static str, &'static [u8], bool)> {
    vec![
        ("empty", include_str!("fixtures/content/empty.state.json"), include_bytes!("fixtures/content/empty.content.json"), false),
        ("board", include_str!("fixtures/content/board.state.json"), include_bytes!("fixtures/content/board.content.json"), false),
        ("numbers", include_str!("fixtures/content/numbers.state.json"), include_bytes!("fixtures/content/numbers.content.json"), false),
        ("keys", include_str!("fixtures/content/keys.state.json"), include_bytes!("fixtures/content/keys.content.json"), false),
        ("snapshot", include_str!("fixtures/content/snapshot.state.json"), include_bytes!("fixtures/content/snapshot.content.json"), true),
        ("changes-start", include_str!("fixtures/content/changes-start.state.json"), include_bytes!("fixtures/content/changes-start.content.json"), true),
    ]
}

// ---- F5: one reader and one writer, and the fixtures are their bytes ----

#[test]
fn every_fixture_loads_to_its_state_and_saves_to_its_bytes_exactly() {
    for (name, state, bytes, snapshot) in fixtures() {
        let replica = Replica::load(schema(), bytes, actor()).unwrap_or_else(|error| panic!("{name}: {error}"));
        let saved = if snapshot { replica.snapshot() } else { replica.content_snapshot() }.unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_bytes(&saved, bytes, name);
        let state: Value = serde_json::from_str(state).expect("the state is JSON");
        assert_eq!(replica.state_json().expect("the state reads"), canonical(state), "{name}: the state read");
    }
}

// ---- C1 to C4: the layout ----

#[test]
fn a_file_holds_the_header_then_one_object_per_line_then_the_closing_line() {
    let bytes = text(include_bytes!("fixtures/content/board.content.json"));
    let lines: Vec<&str> = bytes.split('\n').collect();
    assert_eq!(lines.first().copied(), Some(r#"{"kdm":1,"kit":"kit.content","docId":"0193a5c4-0000-7000-8000-000000000001","schemaVersion":2,"objects":{"#));
    // Four objects, the closing line, and the empty string after the last line's `\n`.
    assert_eq!(lines.len(), 7);
    assert_eq!(lines[5], "}}");
    assert_eq!(lines[6], "");
    for line in &lines[1..4] {
        assert!(line.ends_with("},"), "{line}");
    }
    assert!(lines[4].ends_with('}') && !lines[4].ends_with("},"));
    // No whitespace outside strings: the only spaces are inside the texts `Ship `, `Page 1`, `Page 3`.
    let outside: String = bytes.split('"').step_by(2).collect();
    assert!(!outside.contains(' ') && !outside.contains('\t') && !outside.contains('\r'), "{outside}");
}

#[test]
fn an_empty_document_is_its_header_and_the_closing_line() {
    let bytes = include_bytes!("fixtures/content/empty.content.json");
    assert_bytes(
        bytes,
        b"{\"kdm\":1,\"kit\":\"kit.content\",\"docId\":\"0193a5c4-0000-7000-8000-000000000001\",\"schemaVersion\":1,\"objects\":{\n}}\n",
        "empty",
    );
    assert_bytes(&resaved(bytes), bytes, "empty, saved again");
}

#[test]
fn a_snapshot_puts_its_version_after_the_doc_id_and_a_file_has_none() {
    let snapshot = include_bytes!("fixtures/content/snapshot.content.json");
    assert!(text(snapshot).starts_with(
        r#"{"kdm":1,"kit":"kit.content","docId":"0193a5c4-0000-7000-8000-000000000003","version":{"lineage":"0193a5c4-0000-7000-8000-0000000000ff","seq":42},"schemaVersion":2,"objects":{"#
    ));
    let replica = load(snapshot);
    let lineage = uuid::Uuid::parse_str("0193a5c4-0000-7000-8000-0000000000ff").expect("a UUID");
    assert_eq!(replica.version().encode(), [lineage.as_bytes().as_slice(), &42u64.to_be_bytes()].concat());
    assert_bytes(&replica.snapshot().expect("a snapshot"), snapshot, "the snapshot saved again");
    let file = replica.content_snapshot().expect("the content");
    assert_bytes(
        &file,
        b"{\"kdm\":1,\"kit\":\"kit.content\",\"docId\":\"0193a5c4-0000-7000-8000-000000000003\",\"schemaVersion\":2,\"objects\":{\n\"0193a5c4-0000-7000-8000-0000000000a1\":{\"$type\":\"Board\",\"title\":\"Q4\"}\n}}\n",
        "the content of the snapshot",
    );
}

#[test]
fn keys_and_ids_sort_by_their_utf8_bytes_not_by_utf16() {
    // U+FF5A is one UTF-16 unit above U+D83D (the first unit of U+1F600), so UTF-16 order puts
    // the emoji first; UTF-8 bytes (EF.. before F0..) put it last.
    let bytes = text(include_bytes!("fixtures/content/keys.content.json"));
    let fullwidth = bytes.find("\"\u{ff5a}\":5").expect("the fullwidth key");
    let emoji = bytes.find("\"\u{1f600}\":6").expect("the emoji key");
    assert!(fullwidth < emoji);
    let (upper, underscore, lower) = (bytes.find("\n\"Z9\"").unwrap(), bytes.find("\n\"_m\"").unwrap(), bytes.find("\n\"a0\"").unwrap());
    assert!(upper < underscore && underscore < lower);
    // `$type` (0x24) comes first in every object of these fixtures.
    for line in bytes.lines().skip(1).filter(|line| line.starts_with('"')) {
        assert!(line.contains(":{\"$type\":"), "{line}");
    }
    // Written by a transaction in another order, the same order.
    let replica = built(schema(), |tx| {
        let board = tx.create_with_id("Board", &id("a0"), fields(json!({ "title": "T" })))?;
        for (key, value) in [("\u{1f600}", 6), ("\u{ff5a}", 5), ("a", 3), ("_", 2), ("B", 1)] {
            tx.map_set(&board, "vars", key, json!(value))?;
        }
        Ok(())
    });
    assert_bytes(
        &replica.content_snapshot().unwrap(),
        file(&["\"a0\":{\"$type\":\"Board\",\"title\":\"T\",\"vars\":{\"B\":1,\"_\":2,\"a\":3,\"\u{ff5a}\":5,\"\u{1f600}\":6}}"]).as_bytes(),
        "map keys in byte order",
    );
}

// ---- C6, C7: numbers and strings ----

#[test]
fn characters_outside_the_bmp_and_non_ascii_are_written_as_themselves() {
    let bytes = text(include_bytes!("fixtures/content/keys.content.json"));
    assert!(bytes.contains("\u{1f600}") && bytes.contains("\u{1d11e}") && bytes.contains("\u{e9}"));
    assert!(!bytes.contains("\\ud83d") && !bytes.contains("\\u00e9"));
    // Controls are escaped: `\n`, `\t` in their short form, U+0001 as `\u0001`.
    assert!(bytes.contains("line1\\nline2") && bytes.contains("Tab\\there") && bytes.contains("\\u0001"));
}

#[test]
fn whole_numbers_are_integers_and_others_the_shortest_round_trip_form() {
    let bytes = include_bytes!("fixtures/content/numbers.content.json");
    assert!(text(bytes).contains(
        "\"box\":[0,0,5,1.5,0.1,0.30000000000000004,1e21,1e16,9007199254740992,-9007199254740992,9007199254740992,1.5e-7,0.0001,1e-7,123456789.125,5e-324,1.7976931348623157e308,-2.5e-10]"
    ));
    assert!(text(bytes).contains("\"scale\":100}"));
    // Every number reads back as the same double, so saving again gives the same bytes.
    assert_bytes(&resaved(bytes), bytes, "numbers saved again");
}

#[test]
fn integers_beyond_two_to_the_53_are_refused() {
    let big = "9007199254740993";
    for value in [big.to_owned(), format!("[-{big}]"), format!("{{\"deep\":[{big}]}}")] {
        assert_refused(file(&[&format!("\"p\":{{\"$type\":\"Page\",\"box\":{value},\"name\":\"x\"}}")]).as_bytes(), &value);
    }
    assert_refused(file(&[&format!("\"p\":{{\"$type\":\"Page\",\"count\":{big},\"name\":\"x\"}}")]).as_bytes(), "count");
}

// ---- C5: what is left out and what is written ----

#[test]
fn null_and_empty_containers_are_left_out_and_registers_holding_empty_values_are_written() {
    let replica = built(schema(), |tx| {
        for (name, value) in [("p0", json!([])), ("p1", json!({})), ("p2", json!("")), ("p3", json!(false)), ("p4", json!(0))] {
            tx.create_with_id("Page", &id(name), fields(json!({ "name": "n", "box": value })))?;
        }
        let page = tx.create_with_id("Page", &id("p5"), fields(json!({ "name": "n", "kind": null })))?;
        // Typed and deleted: an empty text is left out.
        tx.text_insert(&page, "body", 0, "draft")?;
        tx.text_delete(&page, "body", 0, 5)?;
        let board = tx.create_with_id("Board", &id("b"), fields(json!({ "title": "T" })))?;
        tx.list_insert(&board, "pages", 0, &page)?;
        tx.list_remove(&board, "pages", 0)?;
        tx.map_set(&board, "vars", "k", json!(1))?;
        tx.map_delete(&board, "vars", "k")
    });
    let expected = file(&[
        r#""b":{"$type":"Board","title":"T"}"#,
        r#""p0":{"$type":"Page","box":[],"name":"n"}"#,
        r#""p1":{"$type":"Page","box":{},"name":"n"}"#,
        r#""p2":{"$type":"Page","box":"","name":"n"}"#,
        r#""p3":{"$type":"Page","box":false,"name":"n"}"#,
        r#""p4":{"$type":"Page","box":0,"name":"n"}"#,
        r#""p5":{"$type":"Page","name":"n"}"#,
    ]);
    assert_bytes(&replica.content_snapshot().unwrap(), expected.as_bytes(), "C5");
    // They survive a round trip.
    let read = load(expected.as_bytes());
    for (name, value) in [("p0", json!([])), ("p1", json!({})), ("p2", json!("")), ("p3", json!(false)), ("p4", json!(0)), ("p5", Value::Null)] {
        assert_eq!(read.get(&id(name), "box").unwrap(), value, "{name}");
    }
    assert_bytes(&read.content_snapshot().unwrap(), expected.as_bytes(), "C5 saved again");
}

#[test]
fn a_map_key_set_to_null_is_deleted() {
    let replica = built(schema(), |tx| {
        let board = tx.create_with_id("Board", &id("b"), fields(json!({ "title": "T" })))?;
        tx.map_set(&board, "vars", "gap", json!(8))?;
        tx.map_set(&board, "vars", "zoom", json!(2))?;
        tx.map_set(&board, "vars", "zoom", Value::Null)?;
        tx.map_set(&board, "vars", "none", Value::Null)
    });
    assert_eq!(replica.map_entries(&id("b"), "vars").unwrap(), vec![("gap".to_owned(), json!(8))]);
    assert_bytes(&replica.content_snapshot().unwrap(), file(&[r#""b":{"$type":"Board","title":"T","vars":{"gap":8}}"#]).as_bytes(), "map");
    // A map entry written as null is not the encoding.
    assert_refused(file(&[r#""b":{"$type":"Board","title":"T","vars":{"gap":8,"zoom":null}}"#]).as_bytes(), "a null map entry");
}

// ---- C8 and F3: the shape of each kind, from the state alone ----

#[test]
fn a_text_is_a_string_exactly_when_no_run_carries_a_mark() {
    let replica = built(schema(), |tx| {
        let merged = tx.create_with_id("Page", &id("p"), fields(json!({ "name": "x" })))?;
        tx.text_insert(&merged, "body", 0, "abcd")?;
        tx.text_mark(&merged, "body", 0, 2, "bold", json!(true))?;
        tx.text_mark(&merged, "body", 2, 4, "bold", json!(true))?;
        // `false` is a mark value like any other; only removing the mark leaves the text unmarked.
        let falsy = tx.create_with_id("Page", &id("q"), fields(json!({ "name": "x" })))?;
        tx.text_insert(&falsy, "body", 0, "ab")?;
        tx.text_mark(&falsy, "body", 0, 1, "bold", json!(false))?;
        // A field that declares marks, holding none: a string.
        let plain = tx.create_with_id("Page", &id("r"), fields(json!({ "name": "x" })))?;
        tx.text_insert(&plain, "body", 0, "xy")?;
        tx.text_mark(&plain, "body", 0, 2, "bold", json!(true))?;
        tx.text_unmark(&plain, "body", 0, 2, "bold")
    });
    let expected = file(&[
        r#""p":{"$type":"Page","body":[{"attributes":{"bold":true},"insert":"abcd"}],"name":"x"}"#,
        r#""q":{"$type":"Page","body":[{"attributes":{"bold":false},"insert":"a"},{"insert":"b"}],"name":"x"}"#,
        r#""r":{"$type":"Page","body":"xy","name":"x"}"#,
    ]);
    assert_bytes(&replica.content_snapshot().unwrap(), expected.as_bytes(), "C8");
    let read = load(expected.as_bytes());
    assert_eq!(read.text_delta(&id("r"), "body").unwrap(), vec![kition_kdm::TextRun::new("xy")]);
    assert_eq!(read.text_delta(&id("q"), "body").unwrap(), vec![kition_kdm::TextRun::new("a").with("bold", json!(false)), kition_kdm::TextRun::new("b")]);
    assert_bytes(&read.content_snapshot().unwrap(), expected.as_bytes(), "C8 saved again");
}

#[test]
fn the_bytes_depend_on_the_state_never_on_the_schema_that_writes_them() {
    // Read and written under a schema that adds marks to a field and adds fields: the same bytes.
    let board = include_bytes!("fixtures/content/board.content.json");
    let grown = Replica::load(grown_schema(), board, actor()).unwrap();
    assert_bytes(&grown.content_snapshot().unwrap(), board, "the board fixture under the grown schema");
    // A document of the older schema whose `notes` (no marks there) and `body` (marks there,
    // none set) hold plain text: the same bytes under either schema.
    let older = built(schema(), |tx| {
        let board = tx.create_with_id("Board", &id("b"), fields(json!({ "title": "T" })))?;
        let page = tx.create_with_id("Page", &id("p"), fields(json!({ "name": "P" })))?;
        tx.text_insert(&board, "notes", 0, "plain")?;
        tx.text_insert(&page, "body", 0, "also plain")
    });
    let written = older.content_snapshot().unwrap();
    let expected = file(&[r#""b":{"$type":"Board","notes":"plain","title":"T"}"#, r#""p":{"$type":"Page","body":"also plain","name":"P"}"#]);
    assert_bytes(&written, expected.as_bytes(), "under the older schema");
    let mut grown = Replica::load(grown_schema(), &written, actor()).unwrap();
    assert_bytes(&grown.content_snapshot().unwrap(), &written, "under the grown schema");
    // The new fields set under the grown schema, the older one reads and writes them as they are.
    grown
        .transact(&person(), |tx| {
            tx.set(&id("b"), "subtitle", json!("S"))?;
            tx.list_insert(&id("p"), "tags", 0, &id("p"))
        })
        .unwrap();
    let grown_bytes = grown.content_snapshot().unwrap();
    let expected =
        file(&[r#""b":{"$type":"Board","notes":"plain","subtitle":"S","title":"T"}"#, r#""p":{"$type":"Page","body":"also plain","name":"P","tags":["p"]}"#]);
    assert_bytes(&grown_bytes, expected.as_bytes(), "the new fields");
    assert_bytes(&resaved(&grown_bytes), &grown_bytes, "the new fields under the older schema");
}

// ---- C9: what the reader's schema does not declare ----

#[test]
fn fields_and_types_the_schema_does_not_declare_are_kept_as_they_are() {
    let bytes = file(&[r#""n":{"$type":"Note","body":"from a newer kit","lines":[]}"#, r#""p":{"$type":"Page","later":[],"name":"x","sub":[[0,"n"]]}"#]);
    let replica = load(bytes.as_bytes());
    assert_eq!(replica.state_json().unwrap()["objects"]["n"], json!({ "$type": "Note" }));
    assert_bytes(&replica.content_snapshot().unwrap(), bytes.as_bytes(), "C9");
}

// ---- F1: trees are flat ----

#[test]
fn a_tree_is_its_nodes_in_pre_order_with_their_depths() {
    let replica = built(schema(), |tx| {
        let board = tx.create_with_id("Board", &id("b"), fields(json!({ "title": "T" })))?;
        for page in ["p1", "p2", "p3", "p4"] {
            tx.create_with_id("Page", &id(page), fields(json!({ "name": page })))?;
        }
        let one = tx.tree_create(&board, "outline", None, &id("p1"))?;
        tx.tree_create(&board, "outline", None, &id("p4"))?;
        let two = tx.tree_create(&board, "outline", Some(&one), &id("p2"))?;
        tx.tree_create(&board, "outline", Some(&two), &id("p3"))?;
        Ok(())
    });
    let expected = file(&[
        r#""b":{"$type":"Board","outline":[[0,"p1"],[1,"p2"],[2,"p3"],[0,"p4"]],"title":"T"}"#,
        r#""p1":{"$type":"Page","name":"p1"}"#,
        r#""p2":{"$type":"Page","name":"p2"}"#,
        r#""p3":{"$type":"Page","name":"p3"}"#,
        r#""p4":{"$type":"Page","name":"p4"}"#,
    ]);
    assert_bytes(&replica.content_snapshot().unwrap(), expected.as_bytes(), "F1");
    let read = load(expected.as_bytes());
    let shape = |replica: &Replica| -> Vec<(String, Option<String>)> {
        replica
            .tree(&id("b"), "outline")
            .unwrap()
            .into_iter()
            .map(|entry| (entry.object.to_string(), entry.parent.map(|parent| parent.object().to_string())))
            .collect()
    };
    assert_eq!(shape(&read), shape(&replica));
    assert_eq!(read.state_json().unwrap(), replica.state_json().unwrap());
    assert_bytes(&read.content_snapshot().unwrap(), expected.as_bytes(), "F1 saved again");
}

#[test]
fn a_tree_of_any_depth_loads_and_saves() {
    const DEPTH: usize = 100_000;
    let ids: Vec<String> = (0..DEPTH).map(|n| format!("n{n:06}")).collect();
    let outline: Vec<String> = ids.iter().enumerate().map(|(depth, node)| format!("[{depth},\"{node}\"]")).collect();
    let mut lines = vec![format!("\"b\":{{\"$type\":\"Board\",\"outline\":[{}],\"title\":\"T\"}}", outline.join(","))];
    lines.extend(ids.iter().map(|node| format!("\"{node}\":{{\"$type\":\"Page\",\"name\":\"x\"}}")));
    let bytes = file(&lines.iter().map(String::as_str).collect::<Vec<_>>());
    let started = Instant::now();
    let replica = load(bytes.as_bytes());
    assert_bytes(&replica.content_snapshot().unwrap(), bytes.as_bytes(), "a chain of 100,000 nodes");
    let entries = replica.tree(&id("b"), "outline").unwrap();
    assert_eq!(entries.len(), DEPTH);
    let last = entries.last().expect("a last node");
    assert_eq!((last.object.as_str(), last.parent.as_ref().map(|parent| parent.object().as_str())), ("n099999", Some("n099998")));
    assert!(started.elapsed() < Duration::from_secs(60), "{:?}", started.elapsed());
}

#[test]
fn a_tree_with_a_depth_jump_a_node_twice_or_an_entry_of_another_shape_is_refused() {
    let pages = [r#""p":{"$type":"Page","name":"x"}"#, r#""q":{"$type":"Page","name":"x"}"#];
    let board = |outline: &str| format!("\"b\":{{\"$type\":\"Board\",\"outline\":{outline},\"title\":\"T\"}}");
    for (outline, what) in [
        (r#"[[0,"p"],[1,"q"]]"#, ""),
        (r#"[[1,"p"]]"#, "a first node below depth 0"),
        (r#"[[0,"p"],[2,"q"]]"#, "a depth jump"),
        (r#"[[0,"p"],[1,"p"]]"#, "a node twice"),
        (r#"[[0,"p"],[0,"p"]]"#, "a root twice"),
        (r#"[{"children":[],"object":"p"}]"#, "the nested form"),
        (r#"[[0,"p",0]]"#, "an entry with a third element"),
        (r#"[[0]]"#, "an entry without an id"),
        (r#"[["0","p"]]"#, "a depth that is a string"),
        (r#"[[-1,"p"]]"#, "a negative depth"),
        (r#"[[0.5,"p"]]"#, "a fractional depth"),
        (r#"[[0,5]]"#, "an id that is a number"),
        (r#"{"p":0}"#, "an object"),
    ] {
        let bytes = file(&[&board(outline), pages[0], pages[1]]);
        if what.is_empty() {
            load(bytes.as_bytes());
        } else {
            assert_refused(bytes.as_bytes(), what);
        }
    }
}

// ---- F2: a key at most once ----

#[test]
fn a_key_written_twice_anywhere_is_refused() {
    let page = r#""p":{"$type":"Page","name":"x"}"#;
    let snapshot = text(include_bytes!("fixtures/content/snapshot.content.json"));
    let cases = [
        ("a header key", file(&[page]).replacen("{\"kdm\":1,", "{\"kdm\":1,\"kdm\":1,", 1)),
        ("a version key", snapshot.replacen("\"seq\":42", "\"seq\":42,\"seq\":42", 1)),
        ("an object id", file(&[page, page])),
        ("a field name", file(&[r#""p":{"$type":"Page","name":"x","name":"y"}"#])),
        ("`$type`", file(&[r#""p":{"$type":"Page","$type":"Page","name":"x"}"#])),
        ("a field name, escaped", file(&[r#""p":{"$type":"Page","name":"x","n\u0061me":"y"}"#])),
        ("a map key", file(&[r#""b":{"$type":"Board","title":"T","vars":{"a":1,"a":2}}"#])),
        ("a key inside a json value", file(&[r#""p":{"$type":"Page","box":{"k":[{"z":1,"z":1}]},"name":"x"}"#])),
        ("a mark key", file(&[r#""p":{"$type":"Page","body":[{"attributes":{"bold":true,"bold":false},"insert":"x"}],"name":"x"}"#])),
        ("a run key", file(&[r#""p":{"$type":"Page","body":[{"insert":"x","insert":"y"}],"name":"x"}"#])),
    ];
    for (what, bytes) in cases {
        assert_refused(bytes.as_bytes(), what);
    }
}

// ---- F4: what reading tolerates ----

#[test]
fn whitespace_and_key_order_are_tolerated_and_saved_canonical() {
    let pretty = format!(
        "{{\n  \"objects\" : {{ \"p\" : {{ \"name\" : \"x\" , \"$type\" : \"Page\" }} }} ,\r\n\t\"schemaVersion\" : 2 , \"docId\" : \"{DOC}\" , \"kit\" : \"kit.content\" , \"kdm\" : 1\n}}"
    );
    assert_bytes(&resaved(pretty.as_bytes()), file(&[r#""p":{"$type":"Page","name":"x"}"#]).as_bytes(), "whitespace and key order");
}

#[test]
fn any_valid_string_escape_is_tolerated_and_saved_canonical() {
    let escaped = file(&[r#""\u0070":{"$type":"Page","name":"\u0041\/\u00e9\ud83d\ude00\u001F\n"}"#]);
    let canonical = file(&["\"p\":{\"$type\":\"Page\",\"name\":\"A/\u{e9}\u{1f600}\\u001f\\n\"}"]);
    assert_bytes(&resaved(escaped.as_bytes()), canonical.as_bytes(), "escapes");
}

#[test]
fn runs_that_are_empty_or_alike_and_null_or_empty_marks_are_tolerated_and_saved_canonical() {
    let loose = file(&[
        r#""p":{"$type":"Page","body":[{"insert":""},{"attributes":{},"insert":"a"},{"attributes":{"bold":null},"insert":"b"},{"attributes":{"bold":true},"insert":"c"},{"insert":"d","attributes":{"bold":true}}],"name":"x"}"#,
        r#""q":{"$type":"Page","body":[{"insert":"x"},{"attributes":{"link":null},"insert":"y"}],"name":"y"}"#,
    ]);
    let canonical = file(&[
        r#""p":{"$type":"Page","body":[{"insert":"ab"},{"attributes":{"bold":true},"insert":"cd"}],"name":"x"}"#,
        r#""q":{"$type":"Page","body":"xy","name":"y"}"#,
    ]);
    assert_bytes(&resaved(loose.as_bytes()), canonical.as_bytes(), "runs");
}

#[test]
fn a_missing_final_newline_is_tolerated_and_saved_canonical() {
    let board = include_bytes!("fixtures/content/board.content.json");
    let without = board.strip_suffix(b"\n").expect("the fixture ends with a newline");
    assert_bytes(&resaved(without), board, "no final newline");
}

#[test]
fn a_container_field_written_empty_is_tolerated_and_left_out() {
    let loose = file(&[r#""b":{"$type":"Board","notes":"","outline":[],"pages":[],"title":"T","vars":{}}"#, r#""p":{"$type":"Page","body":[],"name":"x"}"#]);
    let canonical = file(&[r#""b":{"$type":"Board","title":"T"}"#, r#""p":{"$type":"Page","name":"x"}"#]);
    assert_bytes(&resaved(loose.as_bytes()), canonical.as_bytes(), "empty containers");
}

#[test]
fn a_number_in_any_json_form_is_tolerated_and_saved_canonical() {
    let loose = file(&[r#""p":{"$type":"Page","box":[-0,1.50,0.1e1,1E2],"count":5.0,"name":"x","scale":2.5E-1}"#]);
    let canonical = file(&[r#""p":{"$type":"Page","box":[0,1.5,1,100],"count":5,"name":"x","scale":0.25}"#]);
    assert_bytes(&resaved(loose.as_bytes()), canonical.as_bytes(), "numbers");
}

// ---- F4 and C1: what reading refuses ----

#[test]
fn a_byte_order_mark_is_refused() {
    let mut bytes = "\u{feff}".as_bytes().to_vec();
    bytes.extend_from_slice(include_bytes!("fixtures/content/board.content.json"));
    assert_refused(&bytes, "a byte order mark");
}

#[test]
fn a_uuid_not_in_lowercase_hyphenated_form_is_refused() {
    let upper = "0193A5C4-0000-7000-8000-0000000000B1";
    let lower = "0193a5c4-0000-7000-8000-0000000000b1";
    let page = format!("\"{lower}\":{{\"$type\":\"Page\",\"name\":\"x\"}}");
    let snapshot = text(include_bytes!("fixtures/content/snapshot.content.json"));
    let cases = [
        ("an upper-case docId", file(&[&page]).replacen(DOC, &DOC.to_uppercase(), 1)),
        ("a braced docId", file(&[&page]).replacen(DOC, &format!("{{{DOC}}}"), 1)),
        ("a docId without hyphens", file(&[&page]).replacen(DOC, &DOC.replace('-', ""), 1)),
        ("an upper-case lineage", snapshot.replacen("0193a5c4-0000-7000-8000-0000000000ff", "0193A5C4-0000-7000-8000-0000000000FF", 1)),
        ("an upper-case object id", file(&[&format!("\"{upper}\":{{\"$type\":\"Page\",\"name\":\"x\"}}")])),
        ("an object id without hyphens", file(&[&format!("\"{}\":{{\"$type\":\"Page\",\"name\":\"x\"}}", lower.replace('-', ""))])),
        ("an object id as a URN", file(&[&format!("\"urn:uuid:{lower}\":{{\"$type\":\"Page\",\"name\":\"x\"}}")])),
        ("an upper-case ref", file(&[&format!("\"{lower}\":{{\"$type\":\"Page\",\"name\":\"x\",\"next\":\"{upper}\"}}")])),
        ("an upper-case list item", file(&[&format!("\"a\":{{\"$type\":\"Board\",\"pages\":[\"{upper}\"],\"title\":\"T\"}}"), &page])),
        ("an upper-case tree node", file(&[&format!("\"a\":{{\"$type\":\"Board\",\"outline\":[[0,\"{upper}\"]],\"title\":\"T\"}}"), &page])),
        ("an empty object id", file(&[r#""":{"$type":"Page","name":"x"}"#])),
    ];
    for (what, bytes) in cases {
        assert_refused(bytes.as_bytes(), what);
    }
    // The same documents written in lowercase load.
    load(file(&[&format!("\"{lower}\":{{\"$type\":\"Page\",\"name\":\"x\",\"next\":\"{lower}\"}}")]).as_bytes());
}

#[test]
fn an_unknown_key_in_the_header_or_a_run_is_refused() {
    let page = r#""p":{"$type":"Page","name":"x"}"#;
    let snapshot = text(include_bytes!("fixtures/content/snapshot.content.json"));
    let cases = [
        ("a header key", file(&[page]).replacen("\"schemaVersion\":2,", "\"schemaVersion\":2,\"extra\":1,", 1)),
        ("a version key", snapshot.replacen("\"seq\":42", "\"seq\":42,\"extra\":1", 1)),
        ("a run key", file(&[r#""p":{"$type":"Page","body":[{"bold":true,"insert":"x"}],"name":"x"}"#])),
    ];
    for (what, bytes) in cases {
        assert_refused(bytes.as_bytes(), what);
    }
}

#[test]
fn a_value_of_the_wrong_shape_is_refused() {
    let page = r#""p":{"$type":"Page","name":"x"}"#;
    let header = format!(r#""kit":"kit.content","docId":"{DOC}","schemaVersion":2"#);
    let cases = [
        ("not JSON", "KDM\u{1} not json".to_owned()),
        ("an array", "[]".to_owned()),
        ("no kdm", format!(r#"{{{header},"objects":{{}}}}"#)),
        ("no objects", format!(r#"{{"kdm":1,{header}}}"#)),
        ("objects as an array", format!(r#"{{"kdm":1,{header},"objects":[]}}"#)),
        ("a string schemaVersion", file(&[page]).replacen("\"schemaVersion\":2", "\"schemaVersion\":\"2\"", 1)),
        ("a numeric kit", file(&[page]).replacen("\"kit.content\"", "5", 1)),
        ("a version without seq", format!(r#"{{"kdm":1,{header},"version":{{"lineage":"0193a5c4-0000-7000-8000-0000000000ff"}},"objects":{{}}}}"#)),
        ("an object that is a number", file(&[r#""p":5"#])),
        ("an object without $type", file(&[r#""p":{"name":"x"}"#])),
        ("a numeric $type", file(&[r#""p":{"$type":5,"name":"x"}"#])),
        ("a field holding null", file(&[r#""p":{"$type":"Page","kind":null,"name":"x"}"#])),
        ("a list that is a string", file(&[r#""b":{"$type":"Board","pages":"p","title":"T"}"#, page])),
        ("a list item that is a number", file(&[r#""b":{"$type":"Board","pages":["p",5],"title":"T"}"#, page])),
        ("a map that is an array", file(&[r#""b":{"$type":"Board","title":"T","vars":[1]}"#])),
        ("a text that is a number", file(&[r#""b":{"$type":"Board","notes":5,"title":"T"}"#])),
        ("a run that is a string", file(&[r#""p":{"$type":"Page","body":["x"],"name":"x"}"#])),
        ("a run without insert", file(&[r#""p":{"$type":"Page","body":[{"attributes":{"bold":true}}],"name":"x"}"#])),
        ("a run whose insert is a number", file(&[r#""p":{"$type":"Page","body":[{"insert":5}],"name":"x"}"#])),
        ("a run whose attributes are an array", file(&[r#""p":{"$type":"Page","body":[{"attributes":[],"insert":"x"}],"name":"x"}"#])),
    ];
    for (what, bytes) in cases {
        assert_refused(bytes.as_bytes(), what);
    }
    let other_kdm = file(&[page]).replacen("{\"kdm\":1,", "{\"kdm\":2,", 1);
    assert!(matches!(Replica::load(schema(), other_kdm.as_bytes(), actor()), Err(KdmError::Schema(_))));
    let changes = format!(r#"{{"kdm":1,"docId":"{DOC}","changes":[]}}"#);
    assert_refused(changes.as_bytes(), "changes, not content");
}

#[test]
fn values_nest_at_most_127_levels_deep() {
    // A field's value sits at depth 4 (the outer object, `objects`, the object): 124 levels of
    // arrays reach depth 127.
    let nested = |levels: usize| format!("{}{}", "[".repeat(levels), "]".repeat(levels));
    let at_limit = file(&[&format!("\"p\":{{\"$type\":\"Page\",\"box\":{},\"name\":\"x\"}}", nested(124))]);
    assert_bytes(&resaved(at_limit.as_bytes()), at_limit.as_bytes(), "at the limit");
    assert_refused(file(&[&format!("\"p\":{{\"$type\":\"Page\",\"box\":{},\"name\":\"x\"}}", nested(125))]).as_bytes(), "beyond the limit");
    // No transaction writes what no reader reads back.
    let mut deep = Value::Array(Vec::new());
    for _ in 0..200 {
        deep = Value::Array(vec![deep]);
    }
    let mut replica = Replica::create(schema(), DocId::parse(DOC).expect("a doc id"), actor()).expect("a document");
    let refused = replica.transact(&person(), |tx| tx.create_with_id("Page", &id("p"), fields(json!({ "name": "x", "box": deep }))).map(drop));
    assert!(matches!(refused, Err(KdmError::InvalidValue { .. })), "{refused:?}");
}

// ---- Ids a list or tree names: the coordinator's rule on missing objects ----

#[test]
fn list_items_naming_no_object_are_left_out_when_saved_and_refused_when_read() {
    let mut replica = built(schema(), |tx| {
        let board = tx.create_with_id("Board", &id("b"), fields(json!({ "title": "T" })))?;
        for (index, page) in ["p1", "p2"].into_iter().enumerate() {
            tx.create_with_id("Page", &id(page), fields(json!({ "name": page })))?;
            tx.list_insert(&board, "pages", index, &id(page))?;
        }
        Ok(())
    });
    // The store keeps a deleted object's list entries until the kit removes them.
    replica.transact(&person(), |tx| tx.delete(&id("p2"))).unwrap();
    assert_eq!(replica.list(&id("b"), "pages").unwrap(), vec![id("p1"), id("p2")]);
    let expected = file(&[r#""b":{"$type":"Board","pages":["p1"],"title":"T"}"#, r#""p1":{"$type":"Page","name":"p1"}"#]);
    assert_bytes(&replica.content_snapshot().unwrap(), expected.as_bytes(), "a dangling list entry");
    let read = load(expected.as_bytes());
    assert_eq!(read.list(&id("b"), "pages").unwrap(), vec![id("p1")]);
    assert_bytes(&read.content_snapshot().unwrap(), expected.as_bytes(), "saved again");
    // A snapshot holds the state exactly: a replica loaded from it at its version holds the entry,
    // and the kit's removal of it, made on the writer, imports.
    let mut follower = Replica::load(schema(), &replica.snapshot().unwrap(), actor()).unwrap();
    assert_eq!(follower.list(&id("b"), "pages").unwrap(), vec![id("p1"), id("p2")]);
    assert_bytes(&follower.snapshot().unwrap(), &replica.snapshot().unwrap(), "the snapshot saved again");
    let at = replica.version();
    replica.transact(&person(), |tx| tx.list_remove(&id("b"), "pages", 1)).unwrap();
    follower.import_changes(&replica.export_changes(&at).unwrap()).unwrap();
    assert_eq!(follower.list(&id("b"), "pages").unwrap(), vec![id("p1")]);
    // A file that names a missing object is not the encoding.
    let page = r#""p1":{"$type":"Page","name":"p1"}"#;
    assert_refused(file(&[r#""b":{"$type":"Board","pages":["p1","p2"],"title":"T"}"#, page]).as_bytes(), "a list naming a missing object");
    assert_refused(file(&[r#""b":{"$type":"Board","outline":[[0,"p1"],[1,"p2"]],"title":"T"}"#, page]).as_bytes(), "a tree naming a missing object");
}
