// Copied from kition-sdk crates/kition-kdm/src/store/tests.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The store's operations: each one applied and then inverted gives back the state; one whose
//! preconditions do not hold changes nothing; a change applies whole or not at all; position
//! transforms keep later changes; a change's JSON reads back as itself.

use serde_json::{Value, json};

use super::op::{Change, Name, Op, TreePlace, inverse, inverse_all};
use super::text::Marks;
use super::transform::through;
use super::{Field, Object, Store};
use crate::{ActorId, DocId, KdmError, ObjectId, Origin, Schema};

fn schema() -> Schema {
    Schema::parse(include_str!("../../tests/fixtures/content/schema.json")).expect("the content schema parses")
}

fn id(name: &str) -> ObjectId {
    ObjectId::from_string(name)
}

fn page(fields: Value) -> Box<Object> {
    let mut map = fields.as_object().cloned().unwrap_or_default();
    map.insert("$type".into(), json!("Page"));
    Box::new(Object::from_content(&map, &schema()).expect("a page"))
}

fn bold() -> Marks {
    [("bold".to_owned(), json!(true))].into_iter().collect()
}

/// A board `b1` titled `Q4` with pages `p1`, `p2`, `p3` in its list and its outline (`p2` under
/// `p1`), `vars` `{gap: 8}`, notes `hello world`; `p1`'s body is `Ship it` with `it` bold.
fn base() -> Store {
    let schema = schema();
    let mut store = Store::new(DocId::new(), "kit.content".into(), 1);
    let board =
        Object::from_content(json!({ "$type": "Board", "title": "Q4", "notes": "hello world", "vars": { "gap": 8 } }).as_object().unwrap(), &schema).unwrap();
    let mut ops = vec![Op::Create { id: id("b1"), object: Box::new(board), trees: Vec::new() }];
    for (index, (page_id, name)) in [("p1", "One"), ("p2", "Two"), ("p3", "Three")].into_iter().enumerate() {
        ops.push(Op::Create { id: id(page_id), object: page(json!({ "name": name })), trees: Vec::new() });
        ops.push(Op::ListInsert { id: id("b1"), field: super::op::Name::from("pages"), index, item: id(page_id) });
    }
    ops.push(Op::TreeCreate { id: id("b1"), field: Name::from("outline"), node: id("p1"), parent: None, index: None });
    ops.push(Op::TreeCreate { id: id("b1"), field: Name::from("outline"), node: id("p3"), parent: None, index: None });
    ops.push(Op::TreeCreate { id: id("b1"), field: Name::from("outline"), node: id("p2"), parent: Some(id("p1")), index: None });
    ops.push(Op::TextInsert { id: id("p1"), field: Name::from("body"), index: 0, text: "Ship it".into(), marks: None });
    ops.push(Op::TextMark { id: id("p1"), field: Name::from("body"), start: 5, end: 7, key: "bold".into(), value: json!(true), was: Vec::new() });
    store.apply_all(ops, &schema).expect("the base state applies");
    store
}

fn text_of(store: &Store, object: &str, field: &str) -> String {
    match store.field(&id(object), field) {
        Some(Field::Text(text)) => text.string(),
        None => String::new(),
        Some(other) => panic!("{object}.{field} is {other:?}"),
    }
}

fn list_of(store: &Store, object: &str, field: &str) -> Vec<ObjectId> {
    match store.field(&id(object), field) {
        Some(Field::List(items)) => items.clone(),
        None => Vec::new(),
        Some(other) => panic!("{object}.{field} is {other:?}"),
    }
}

/// Every kind of operation, as a transaction stages it, on [`base`].
fn operations() -> Vec<(&'static str, Op)> {
    let field = Name::from;
    vec![
        ("create", Op::Create { id: id("p4"), object: page(json!({ "name": "Four", "count": 2 })), trees: Vec::new() }),
        (
            "create in a tree",
            Op::Create {
                id: id("p4"),
                object: page(json!({ "name": "Four" })),
                trees: vec![TreePlace { owner: id("b1"), field: field("outline"), parent: Some(id("p1")), index: 1 }],
            },
        ),
        ("delete a root node's object", Op::Delete { id: id("p3"), was: None, trees: Vec::new() }),
        ("delete a child node's object", Op::Delete { id: id("p2"), was: None, trees: Vec::new() }),
        ("delete a tree's owner", Op::Delete { id: id("b1"), was: None, trees: Vec::new() }),
        ("set", Op::Set { id: id("p1"), field: field("name"), value: json!("New"), was: Value::Null }),
        ("set a new field", Op::Set { id: id("p1"), field: field("count"), value: json!(3), was: Value::Null }),
        ("unset", Op::Set { id: id("p1"), field: field("name"), value: Value::Null, was: Value::Null }),
        ("text insert", Op::TextInsert { id: id("b1"), field: field("notes"), index: 5, text: ", big".into(), marks: None }),
        ("text insert in an empty field", Op::TextInsert { id: id("p2"), field: field("body"), index: 0, text: "new \u{1f600}".into(), marks: None }),
        ("text insert after a mark", Op::TextInsert { id: id("p1"), field: field("body"), index: 7, text: "!".into(), marks: None }),
        ("text insert with marks", Op::TextInsert { id: id("p1"), field: field("body"), index: 0, text: "Now ".into(), marks: Some(bold()) }),
        ("text delete across runs", Op::TextDelete { id: id("p1"), field: field("body"), index: 3, count: 3, was: Vec::new() }),
        ("text delete all", Op::TextDelete { id: id("b1"), field: field("notes"), index: 0, count: 11, was: Vec::new() }),
        ("text mark", Op::TextMark { id: id("p1"), field: field("body"), start: 0, end: 6, key: "bold".into(), value: json!(true), was: Vec::new() }),
        ("text unmark", Op::TextMark { id: id("p1"), field: field("body"), start: 0, end: 7, key: "bold".into(), value: Value::Null, was: Vec::new() }),
        (
            "text mark another key",
            Op::TextMark { id: id("p1"), field: field("body"), start: 2, end: 6, key: "link".into(), value: json!("x"), was: Vec::new() },
        ),
        ("list insert", Op::ListInsert { id: id("b1"), field: field("pages"), index: 1, item: id("p9") }),
        ("list remove", Op::ListRemove { id: id("b1"), field: field("pages"), index: 0, item: Some(id("p1")) }),
        ("list move forward", Op::ListMove { id: id("b1"), field: field("pages"), from: 0, to: 2, item: None }),
        ("list move back", Op::ListMove { id: id("b1"), field: field("pages"), from: 2, to: 0, item: Some(id("p3")) }),
        ("map set", Op::MapSet { id: id("b1"), field: field("vars"), key: "gap".into(), value: Some(json!(9)), was: None }),
        ("map set a new key", Op::MapSet { id: id("b1"), field: field("vars"), key: "zoom".into(), value: Some(json!(1.5)), was: None }),
        ("map delete the last key", Op::MapSet { id: id("b1"), field: field("vars"), key: "gap".into(), value: None, was: None }),
        ("tree create", Op::TreeCreate { id: id("b1"), field: field("outline"), node: id("p9"), parent: Some(id("p3")), index: None }),
        ("tree create first", Op::TreeCreate { id: id("b1"), field: field("outline"), node: id("p9"), parent: None, index: Some(0) }),
        ("tree move to the roots", Op::TreeMove { id: id("b1"), field: field("outline"), node: id("p2"), parent: None, index: Some(0), was: None }),
        ("tree move under another", Op::TreeMove { id: id("b1"), field: field("outline"), node: id("p3"), parent: Some(id("p2")), index: None, was: None }),
        ("tree move among siblings", Op::TreeMove { id: id("b1"), field: field("outline"), node: id("p1"), parent: None, index: Some(1), was: None }),
        ("tree delete", Op::TreeDelete { id: id("b1"), field: field("outline"), node: id("p2"), was: None }),
        ("schema version", Op::SchemaVersion { version: 2, was: 0 }),
    ]
}

#[test]
fn every_operation_applied_then_inverted_gives_back_the_state() {
    let schema = schema();
    for (what, op) in operations() {
        let mut store = base();
        let before = store.clone();
        let applied = store.apply(op, &schema).unwrap_or_else(|error| panic!("{what}: {error}"));
        assert_ne!(store, before, "{what}: changed nothing");
        for inverse in inverse(&applied) {
            store.apply(inverse, &schema).unwrap_or_else(|error| panic!("{what}: the inverse: {error}"));
        }
        assert_eq!(store, before, "{what}: the inverse did not give back the state");
        // The content (what a file holds) is the same as well.
        assert_eq!(store.to_content(None), before.to_content(None), "{what}");
    }
}

#[test]
fn a_change_applied_then_inverted_gives_back_the_state() {
    let schema = schema();
    let mut store = base();
    let before = store.clone();
    let applied = store
        .apply_all(operations().into_iter().map(|(_, op)| op).filter(|op| !matches!(op, Op::Delete { .. } | Op::Create { .. })).take(12).collect(), &schema);
    // Some of them conflict with each other once the earlier ones applied; the change is
    // refused whole, or applies whole.
    match applied {
        Ok(applied) => {
            store.revert(&applied, &schema);
            assert_eq!(store, before);
        }
        Err(_) => assert_eq!(store, before),
    }
    let ops = vec![
        Op::Set { id: id("p1"), field: Name::from("name"), value: json!("A"), was: Value::Null },
        Op::TextInsert { id: id("p1"), field: Name::from("body"), index: 0, text: "x".into(), marks: None },
        Op::ListMove { id: id("b1"), field: Name::from("pages"), from: 2, to: 0, item: None },
        Op::Delete { id: id("p2"), was: None, trees: Vec::new() },
        Op::TreeMove { id: id("b1"), field: Name::from("outline"), node: id("p3"), parent: Some(id("p1")), index: Some(0), was: None },
    ];
    let applied = store.apply_all(ops, &schema).expect("applies");
    assert_eq!(text_of(&store, "p1", "body"), "xShip it");
    for op in inverse_all(applied.iter()) {
        store.apply(op, &schema).expect("the inverse applies");
    }
    assert_eq!(store, before);
}

#[test]
fn an_operation_whose_preconditions_fail_changes_nothing() {
    let schema = schema();
    let field = Name::from;
    let refused = vec![
        ("create an existing id", Op::Create { id: id("p1"), object: page(json!({})), trees: Vec::new() }),
        (
            "create into a missing parent",
            Op::Create {
                id: id("p4"),
                object: page(json!({})),
                trees: vec![TreePlace { owner: id("b1"), field: field("outline"), parent: Some(id("p9")), index: 0 }],
            },
        ),
        ("delete a missing object", Op::Delete { id: id("p9"), was: None, trees: Vec::new() }),
        ("delete an object whose node has children", Op::Delete { id: id("p1"), was: None, trees: Vec::new() }),
        ("set a container", Op::Set { id: id("b1"), field: field("notes"), value: json!("x"), was: Value::Null }),
        ("set on a missing object", Op::Set { id: id("p9"), field: field("name"), value: json!("x"), was: Value::Null }),
        ("text insert beyond the end", Op::TextInsert { id: id("p1"), field: field("body"), index: 8, text: "x".into(), marks: None }),
        ("text insert into a register", Op::TextInsert { id: id("b1"), field: field("title"), index: 0, text: "x".into(), marks: None }),
        ("text delete beyond the end", Op::TextDelete { id: id("p1"), field: field("body"), index: 5, count: 3, was: Vec::new() }),
        (
            "text mark beyond the end",
            Op::TextMark { id: id("p1"), field: field("body"), start: 0, end: 9, key: "bold".into(), value: json!(true), was: Vec::new() },
        ),
        ("list insert beyond the end", Op::ListInsert { id: id("b1"), field: field("pages"), index: 4, item: id("p9") }),
        ("list remove of another item", Op::ListRemove { id: id("b1"), field: field("pages"), index: 0, item: Some(id("p2")) }),
        ("list remove beyond the end", Op::ListRemove { id: id("b1"), field: field("pages"), index: 3, item: None }),
        ("list move beyond the end", Op::ListMove { id: id("b1"), field: field("pages"), from: 0, to: 3, item: None }),
        ("list move of another item", Op::ListMove { id: id("b1"), field: field("pages"), from: 1, to: 0, item: Some(id("p1")) }),
        ("map set on a list", Op::MapSet { id: id("b1"), field: field("pages"), key: "k".into(), value: Some(json!(1)), was: None }),
        ("tree create of a node it holds", Op::TreeCreate { id: id("b1"), field: field("outline"), node: id("p2"), parent: None, index: None }),
        ("tree create under a missing parent", Op::TreeCreate { id: id("b1"), field: field("outline"), node: id("p9"), parent: Some(id("p8")), index: None }),
        ("tree create beyond the siblings", Op::TreeCreate { id: id("b1"), field: field("outline"), node: id("p9"), parent: None, index: Some(3) }),
        (
            "tree move into its own subtree",
            Op::TreeMove { id: id("b1"), field: field("outline"), node: id("p1"), parent: Some(id("p2")), index: None, was: None },
        ),
        ("tree move of a missing node", Op::TreeMove { id: id("b1"), field: field("outline"), node: id("p9"), parent: None, index: None, was: None }),
        ("tree delete of a node with children", Op::TreeDelete { id: id("b1"), field: field("outline"), node: id("p1"), was: None }),
    ];
    for (what, op) in refused {
        let mut store = base();
        let before = store.clone();
        let error = store.apply(op, &schema).expect_err(what);
        assert!(matches!(error, KdmError::Stale(_) | KdmError::Cycle), "{what}: {error:?}");
        assert_eq!(store, before, "{what}: a refused operation changed the state");
    }
}

#[test]
fn a_change_applies_whole_or_not_at_all() {
    let schema = schema();
    let mut store = base();
    let before = store.clone();
    let ops = vec![
        Op::Set { id: id("b1"), field: Name::from("title"), value: json!("Changed"), was: Value::Null },
        Op::TextInsert { id: id("b1"), field: Name::from("notes"), index: 0, text: "> ".into(), marks: None },
        Op::Delete { id: id("p3"), was: None, trees: Vec::new() },
        Op::ListRemove { id: id("b1"), field: Name::from("pages"), index: 0, item: Some(id("p2")) },
    ];
    assert!(matches!(store.apply_all(ops, &schema), Err(KdmError::Stale(_))));
    assert_eq!(store, before);
}

#[test]
fn deleting_an_object_takes_its_nodes_out_of_trees_and_its_list_entries_stay() {
    let schema = schema();
    let mut store = base();
    let applied = store.apply(Op::Delete { id: id("p2"), was: None, trees: Vec::new() }, &schema).unwrap();
    let Op::Delete { trees, was: Some(_), .. } = &applied else { panic!("{applied:?}") };
    assert_eq!(trees, &vec![TreePlace { owner: id("b1"), field: Name::from("outline"), parent: Some(id("p1")), index: 0 }]);
    assert!(store.holders(&id("p2")).is_empty());
    assert_eq!(list_of(&store, "b1", "pages"), vec![id("p1"), id("p2"), id("p3")]);
    // Its own tree's nodes leave the index with it.
    store.apply(Op::Delete { id: id("b1"), was: None, trees: Vec::new() }, &schema).unwrap();
    assert!(store.holders(&id("p1")).is_empty() && store.holders(&id("p3")).is_empty());
}

#[test]
fn empty_containers_are_not_kept() {
    let schema = schema();
    let mut store = base();
    store.apply(Op::TextDelete { id: id("b1"), field: Name::from("notes"), index: 0, count: 11, was: Vec::new() }, &schema).unwrap();
    store.apply(Op::MapSet { id: id("b1"), field: Name::from("vars"), key: "gap".into(), value: None, was: None }, &schema).unwrap();
    for index in (0..3).rev() {
        store.apply(Op::ListRemove { id: id("b1"), field: Name::from("pages"), index, item: None }, &schema).unwrap();
    }
    for node in ["p2", "p1", "p3"] {
        store.apply(Op::TreeDelete { id: id("b1"), field: Name::from("outline"), node: id(node), was: None }, &schema).unwrap();
    }
    let board = store.object(&id("b1")).unwrap();
    assert_eq!(board.fields().map(|(name, _)| name.to_string()).collect::<Vec<_>>(), vec!["title"]);
}

#[test]
fn a_text_insert_takes_the_marks_of_its_neighbours_by_their_expand() {
    let schema = schema();
    let mut store = base();
    // After the bold `it`: bold expands after.
    let applied = store.apply(Op::TextInsert { id: id("p1"), field: Name::from("body"), index: 7, text: "!".into(), marks: None }, &schema).unwrap();
    assert!(matches!(&applied, Op::TextInsert { marks: Some(marks), .. } if *marks == bold()));
    // Before it: not bold.
    let applied = store.apply(Op::TextInsert { id: id("p1"), field: Name::from("body"), index: 5, text: "_".into(), marks: None }, &schema).unwrap();
    assert!(matches!(&applied, Op::TextInsert { marks: Some(marks), .. } if marks.is_empty()));
    // A link (expand none) does not grow at its end, but text typed inside it is linked.
    store
        .apply(Op::TextMark { id: id("p1"), field: Name::from("body"), start: 0, end: 4, key: "link".into(), value: json!("u"), was: Vec::new() }, &schema)
        .unwrap();
    let at_end = store.apply(Op::TextInsert { id: id("p1"), field: Name::from("body"), index: 4, text: "-".into(), marks: None }, &schema).unwrap();
    assert!(matches!(&at_end, Op::TextInsert { marks: Some(marks), .. } if marks.is_empty()));
    let inside = store.apply(Op::TextInsert { id: id("p1"), field: Name::from("body"), index: 2, text: "-".into(), marks: None }, &schema).unwrap();
    assert!(matches!(&inside, Op::TextInsert { marks: Some(marks), .. } if marks.get("link") == Some(&json!("u"))));
}

/// Applies `ops` fitted, skipping what no longer applies, as an undo does.
fn undo_with(store: &mut Store, ops: Vec<Op>, schema: &Schema) {
    for op in ops {
        if let Some(op) = store.fit(op) {
            store.apply(op, schema).ok();
        }
    }
}

#[test]
fn an_undo_of_typed_text_keeps_what_another_scope_typed_inside_it() {
    let schema = schema();
    let mut store = base();
    let notes = Name::from("notes");
    let mine = store.apply(Op::TextInsert { id: id("b1"), field: notes.clone(), index: 0, text: "abc".into(), marks: None }, &schema).unwrap();
    let theirs = store.apply(Op::TextInsert { id: id("b1"), field: notes.clone(), index: 1, text: "Q".into(), marks: None }, &schema).unwrap();
    assert_eq!(text_of(&store, "b1", "notes"), "aQbchello world");
    undo_with(&mut store, through(inverse(&mine), &[theirs]).0, &schema);
    assert_eq!(text_of(&store, "b1", "notes"), "Qhello world");
}

#[test]
fn an_undo_of_a_deletion_puts_the_text_back_where_it_is_now() {
    let schema = schema();
    let mut store = base();
    let notes = Name::from("notes");
    let mine = store.apply(Op::TextDelete { id: id("b1"), field: notes.clone(), index: 5, count: 6, was: Vec::new() }, &schema).unwrap();
    let theirs = vec![
        store.apply(Op::TextInsert { id: id("b1"), field: notes.clone(), index: 0, text: "Hi, ".into(), marks: None }, &schema).unwrap(),
        store.apply(Op::TextDelete { id: id("b1"), field: notes.clone(), index: 4, count: 1, was: Vec::new() }, &schema).unwrap(),
    ];
    assert_eq!(text_of(&store, "b1", "notes"), "Hi, ello");
    undo_with(&mut store, through(inverse(&mine), &theirs).0, &schema);
    assert_eq!(text_of(&store, "b1", "notes"), "Hi, ello world");
}

#[test]
fn an_undo_of_a_deletion_inside_text_another_scope_deleted_keeps_their_deletion() {
    let schema = schema();
    let mut store = base();
    let notes = Name::from("notes");
    // Mine: delete "lo w" (3..7). Theirs, after: delete "hel" + "orld" around it.
    let mine = store.apply(Op::TextDelete { id: id("b1"), field: notes.clone(), index: 3, count: 4, was: Vec::new() }, &schema).unwrap();
    assert_eq!(text_of(&store, "b1", "notes"), "helorld");
    let theirs = vec![store.apply(Op::TextDelete { id: id("b1"), field: notes.clone(), index: 0, count: 2, was: Vec::new() }, &schema).unwrap()];
    assert_eq!(text_of(&store, "b1", "notes"), "lorld");
    undo_with(&mut store, through(inverse(&mine), &theirs).0, &schema);
    assert_eq!(text_of(&store, "b1", "notes"), "llo world");
}

#[test]
fn an_undo_of_a_mark_does_not_spread_over_text_typed_inside_it() {
    let schema = schema();
    let mut store = base();
    let body = Name::from("body");
    let mine = store
        .apply(Op::TextMark { id: id("p1"), field: body.clone(), start: 0, end: 4, key: "link".into(), value: json!("u"), was: Vec::new() }, &schema)
        .unwrap();
    let theirs = store.apply(Op::TextInsert { id: id("p1"), field: body.clone(), index: 2, text: "ZZ".into(), marks: None }, &schema).unwrap();
    undo_with(&mut store, through(inverse(&mine), &[theirs]).0, &schema);
    let Some(Field::Text(text)) = store.field(&id("p1"), "body") else { panic!("no body") };
    let runs = text.runs();
    // `ZZ`, typed inside the link, keeps it; the rest is unlinked again.
    assert_eq!(
        runs.iter().map(|run| (run.insert.as_str(), run.attributes.get("link").cloned())).collect::<Vec<_>>(),
        vec![("Sh", None), ("ZZ", Some(json!("u"))), ("ip ", None), ("it", None)]
    );
}

#[test]
fn an_undo_of_list_edits_follows_the_items_moved_since() {
    let schema = schema();
    let mut store = base();
    let pages = Name::from("pages");
    let mine = store.apply(Op::ListRemove { id: id("b1"), field: pages.clone(), index: 0, item: None }, &schema).unwrap();
    let theirs = vec![
        store.apply(Op::ListInsert { id: id("b1"), field: pages.clone(), index: 0, item: id("x") }, &schema).unwrap(),
        store.apply(Op::ListMove { id: id("b1"), field: pages.clone(), from: 2, to: 0, item: None }, &schema).unwrap(),
    ];
    assert_eq!(list_of(&store, "b1", "pages"), vec![id("p3"), id("x"), id("p2")]);
    undo_with(&mut store, through(inverse(&mine), &theirs).0, &schema);
    // At the same place, the item put back comes before the one inserted there since.
    assert_eq!(list_of(&store, "b1", "pages"), vec![id("p1"), id("p3"), id("x"), id("p2")]);

    // Undoing an insertion removes that item wherever it went.
    let mine = store.apply(Op::ListInsert { id: id("b1"), field: pages.clone(), index: 4, item: id("y") }, &schema).unwrap();
    let theirs = vec![store.apply(Op::ListMove { id: id("b1"), field: pages.clone(), from: 4, to: 0, item: None }, &schema).unwrap()];
    undo_with(&mut store, through(inverse(&mine), &theirs).0, &schema);
    assert_eq!(list_of(&store, "b1", "pages"), vec![id("p1"), id("p3"), id("x"), id("p2")]);

    // An item another scope removed since is not removed twice.
    let mine = store.apply(Op::ListInsert { id: id("b1"), field: pages.clone(), index: 0, item: id("z") }, &schema).unwrap();
    let theirs = vec![store.apply(Op::ListRemove { id: id("b1"), field: pages.clone(), index: 0, item: None }, &schema).unwrap()];
    undo_with(&mut store, through(inverse(&mine), &theirs).0, &schema);
    assert_eq!(list_of(&store, "b1", "pages"), vec![id("p1"), id("p3"), id("x"), id("p2")]);
}

#[test]
fn a_change_reads_back_from_its_json() {
    let schema = schema();
    let mut store = base();
    let ops: Vec<Op> = operations()
        .into_iter()
        .map(|(_, op)| op)
        .filter_map(|op| {
            let mut probe = store.clone();
            probe.apply(op, &schema).ok()
        })
        .collect();
    assert_eq!(ops.len(), operations().len());
    let change = Change { seq: 7, actor: ActorId::from_u64(42).unwrap(), origin: Origin::agent("agent:test").with_label("edit"), schema_version: 2, ops };
    let json = change.to_json();
    let text = json.to_string();
    let read = Change::from_json(&serde_json::from_str(&text).unwrap(), &schema).expect("reads back");
    assert_eq!(read, change);
    assert_eq!(json.get("actor"), Some(&json!("000000000000002a")));
    assert_eq!(json.get("origin"), Some(&json!(["agent", "agent:test", "edit", 2])));
    // A delete carries the whole object in its content form.
    let applied = store.apply(Op::Delete { id: id("p1"), was: None, trees: Vec::new() }, &schema);
    assert!(applied.is_err(), "p1 has a child node");
    let applied = store.apply(Op::Delete { id: id("p2"), was: None, trees: Vec::new() }, &schema).unwrap();
    assert_eq!(
        applied.to_json(),
        json!({ "op": "delete", "id": "p2", "was": { "$type": "Page", "name": "Two" }, "trees": [{ "id": "b1", "field": "outline", "parent": "p1", "index": 0 }] })
    );
}

#[test]
fn content_reads_into_a_store_and_back() {
    let schema = schema();
    let store = base();
    let content = store.to_content(None);
    let bytes = crate::content::encode(&content).unwrap();
    let read = Store::from_content(&crate::content::decode_value(crate::content::parse(&bytes, "KDM content").unwrap()).unwrap(), &schema).unwrap();
    assert_eq!(read, store);
    assert_eq!(read.holders(&id("p2")), &[(id("b1"), Name::from("outline"))]);
}
