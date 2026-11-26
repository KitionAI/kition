// Copied from kition-sdk crates/kition-kdm/tests/write_costs.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The write path's costs (plan 2026-11-24, plain model, section 10): a transaction that writes one
//! key of a large map copies neither the map nor its object, also while a fork of the document
//! (a draft) shares the objects, after its first write; and many small transactions cost about the
//! same each, however large the map grows. `examples/write_path.rs` measures the write path in
//! release.

use std::sync::Arc;
use std::time::{Duration, Instant};

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema};
use serde_json::{Map, json};

const SCHEMA: &str = r#"{"kdm":1,"kit":"kit.write-costs","schemaVersion":1,"root":"Sheet","types":{
  "Sheet":{"fields":{"cells":{"kind":"map"}}},
  "Cell":{"fields":{"value":{"kind":"string"}}}}}"#;

const ENTRIES: usize = 200_000;

fn sheet() -> (Replica, ObjectId) {
    let schema = Arc::new(Schema::parse(SCHEMA).expect("schema"));
    Replica::create_with(schema, DocId::new(), ActorId::from_u64(1).expect("actor"), &Origin::system("import"), |tx| {
        let sheet = tx.create("Sheet", Map::new())?;
        for at in 0..ENTRIES {
            tx.map_set(&sheet, "cells", &format!("k{at}"), json!(at))?;
        }
        Ok(sheet)
    })
    .expect("sheet")
}

/// The time of `count` transactions, each writing one key of the large map and making one cell.
fn writes(replica: &mut Replica, sheet: &ObjectId, count: usize) -> Duration {
    let start = Instant::now();
    for at in 0..count {
        replica
            .transact(&Origin::person("user:test"), |tx| {
                tx.map_set(sheet, "cells", &format!("new{at}"), json!(at))?;
                tx.create("Cell", Map::from_iter([("value".to_owned(), json!("x"))])).map(drop)
            })
            .expect("write");
    }
    start.elapsed()
}

#[test]
fn a_write_of_one_key_copies_no_large_map_and_small_writes_stay_flat() {
    let (mut replica, sheet) = sheet();
    // Copying the 200,000 entries on each write would take seconds for these 1,000 writes.
    let first = writes(&mut replica, &sheet, 1_000);
    assert!(first < Duration::from_secs(3), "1,000 writes into a map of {ENTRIES} took {first:?}");

    // A draft shares the objects: the first write copies the map once, the next ones do not.
    let draft = replica.fork(ActorId::from_u64(9).expect("actor")).expect("fork");
    let with_draft = writes(&mut replica, &sheet, 1_000);
    assert!(with_draft < Duration::from_secs(3), "1,000 writes beside a draft took {with_draft:?}");
    assert_eq!(draft.map_entries(&sheet, "cells").expect("entries").len(), ENTRIES + 1_000, "the draft keeps its own state");

    // Later writes cost about what the first ones did: nothing grows with the map or the log.
    let later = writes(&mut replica, &sheet, 1_000);
    assert!(later < first * 3 + Duration::from_millis(200), "the third 1,000 writes took {later:?}, the first {first:?}");
    // Each round wrote the same 1,000 new keys again.
    assert_eq!(replica.map_entries(&sheet, "cells").expect("entries").len(), ENTRIES + 1_000);
}
