// Copied from kition-sdk crates/kition-kdm/tests/load_from.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `Replica::load_from` reads content from a reader in chunks (data model 7.4): the same replica
//! as `Replica::load` of the same bytes, every fixture byte for byte, the same refusals, and a
//! large document streamed a few kilobytes at a time.

use std::io::Read;
use std::sync::Arc;

use kition_kdm::{ActorId, DocId, KdmError, Origin, Replica, Schema};
use serde_json::{Map, json};

fn schema() -> Arc<Schema> {
    Arc::new(Schema::parse(include_str!("fixtures/content/schema.json")).expect("content schema parses"))
}

fn actor() -> ActorId {
    ActorId::from_u64(3).expect("actor")
}

/// A reader that hands out at most `step` bytes a call, as a file or a container entry may.
struct Trickle<'a> {
    bytes: &'a [u8],
    step: usize,
}

impl Read for Trickle<'_> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let count = self.step.min(out.len()).min(self.bytes.len());
        let (now, rest) = self.bytes.split_at(count);
        out.get_mut(..count).unwrap_or_default().copy_from_slice(now);
        self.bytes = rest;
        Ok(count)
    }
}

const FIXTURES: [(&str, &[u8]); 6] = [
    ("empty", include_bytes!("fixtures/content/empty.content.json")),
    ("board", include_bytes!("fixtures/content/board.content.json")),
    ("numbers", include_bytes!("fixtures/content/numbers.content.json")),
    ("keys", include_bytes!("fixtures/content/keys.content.json")),
    ("snapshot", include_bytes!("fixtures/content/snapshot.content.json")),
    ("changes-start", include_bytes!("fixtures/content/changes-start.content.json")),
];

#[test]
fn every_fixture_streamed_in_any_chunks_loads_as_its_bytes_do() {
    for (name, bytes) in FIXTURES {
        let loaded = Replica::load(schema(), bytes, actor()).unwrap_or_else(|error| panic!("{name}: {error}"));
        for step in [1, 2, 3, 7, 4096] {
            let streamed = Replica::load_from(schema(), Trickle { bytes, step }, actor()).unwrap_or_else(|error| panic!("{name} by {step}: {error}"));
            // Content starts a new line of changes at each load; a snapshot continues its own.
            if name == "snapshot" || name == "changes-start" {
                assert_eq!(streamed.version(), loaded.version(), "{name} by {step}: the version");
                assert_eq!(streamed.snapshot().expect("snapshot"), loaded.snapshot().expect("snapshot"), "{name} by {step}");
            }
            assert_eq!(streamed.state_json().expect("state"), loaded.state_json().expect("state"), "{name} by {step}: the state");
            assert_eq!(streamed.content_snapshot().expect("content"), loaded.content_snapshot().expect("content"), "{name} by {step}");
        }
    }
}

#[test]
fn what_load_refuses_load_from_refuses_alike() {
    let board = String::from_utf8(include_bytes!("fixtures/content/board.content.json").to_vec()).expect("UTF-8");
    let mut with_mark = vec![0xEF, 0xBB, 0xBF];
    with_mark.extend_from_slice(board.as_bytes());
    let refused: Vec<(&str, Vec<u8>)> = vec![
        ("a byte order mark", with_mark),
        ("a key twice", board.replacen("\"kit\":", "\"kit\":\"kit.x\",\"kit\":", 1).into_bytes()),
        ("cut short", board.as_bytes().get(..board.len() / 2).unwrap_or_default().to_vec()),
        ("not JSON", b"{\"kdm\":1,".to_vec()),
        ("nothing", Vec::new()),
        ("another kit", board.replacen("\"kit\":\"", "\"kit\":\"other.", 1).into_bytes()),
        ("trailing bytes", format!("{board}x").into_bytes()),
    ];
    for (what, bytes) in refused {
        let loaded = Replica::load(schema(), &bytes, actor()).err().unwrap_or_else(|| panic!("{what}: load refuses it"));
        for step in [1, 5, 4096] {
            let streamed =
                Replica::load_from(schema(), Trickle { bytes: &bytes, step }, actor()).err().unwrap_or_else(|| panic!("{what}: load_from refuses it"));
            assert_eq!(std::mem::discriminant(&streamed), std::mem::discriminant(&loaded), "{what} by {step}: {streamed:?} and {loaded:?}");
        }
    }
    // A reader that fails is an encoding error, not a panic.
    struct Failing;
    impl Read for Failing {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("the disk is gone"))
        }
    }
    assert!(matches!(Replica::load_from(schema(), Failing, actor()), Err(KdmError::Encoding(_))));
}

#[test]
fn a_large_document_streams_a_few_kilobytes_at_a_time() {
    let schema = Arc::new(
        Schema::parse(
            r#"{ "kdm": 1, "kit": "kit.stream", "schemaVersion": 1, "root": "Sheet",
                 "types": { "Sheet": { "fields": { "cells": { "kind": "map" }, "rows": { "kind": "list", "of": "Row" } } },
                            "Row": { "fields": { "name": { "kind": "string" }, "body": { "kind": "text" } } } } }"#,
        )
        .expect("schema"),
    );
    let (built, ()) = Replica::create_with(Arc::clone(&schema), DocId::new(), actor(), &Origin::system("import"), |tx| {
        let sheet = tx.create("Sheet", Map::new())?;
        for at in 0..20_000 {
            tx.map_set(&sheet, "cells", &format!("r{at}:c{}", at % 7), json!(at as f64 / 8.0))?;
            if at % 4 == 0 {
                let row = tx.create("Row", Map::from_iter([("name".to_owned(), json!(format!("Row \"{at}\"")))]))?;
                tx.text_insert(&row, "body", 0, "caf\u{e9} \u{1F600}")?;
                tx.list_insert(&sheet, "rows", at / 4, &row)?;
            }
        }
        Ok(())
    })
    .expect("built");
    let content = built.content_snapshot().expect("content");
    let streamed = Replica::load_from(schema, Trickle { bytes: &content, step: 4096 }, actor()).expect("streamed");
    assert_eq!(streamed.content_snapshot().expect("content"), content);
}
