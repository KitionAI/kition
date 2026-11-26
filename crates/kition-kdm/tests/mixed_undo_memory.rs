// Copied from kition-sdk crates/kition-kdm/tests/mixed_undo_memory.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Undo of a step older than a large write keeps memory bounded (case
//! regressions/issue-kdm-mixed-undo-memory). A table's record created, then a whole column
//! cleared, then both undone and the creation redone: on a page (4 GiB of WebAssembly memory)
//! "create a record, clear a column, undo, undo" on 100,000 records ran out of memory when undo
//! read the document's history. An undo now writes back what its step's change recorded and reads
//! no history. The resident memory of each step is printed: this file holds one test, so no other
//! test allocates while it runs.

#![cfg(unix)]

use std::process::Command;

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica};
use serde_json::json;

mod common;
use common::{fields, person, schema};

/// This process's resident memory in bytes, as `ps` reports it.
fn resident() -> i64 {
    let output = Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().expect("ps runs");
    String::from_utf8_lossy(&output.stdout).trim().parse::<i64>().expect("ps prints the resident set in KiB") * 1024
}

const SHEETS: usize = 4_000;
const KEYS: usize = 25;

/// A saved document of [`SHEETS`] sheets with [`KEYS`] cells each, opened as a page opens a file:
/// its history is loaded from bytes and read lazily.
fn opened() -> (Replica, Vec<ObjectId>) {
    let (made, ids) = Replica::create_with(schema(), DocId::new(), ActorId::from_u64(1).unwrap(), &Origin::system("import"), |tx| {
        (0..SHEETS)
            .map(|sheet| {
                let id = tx.create("Sheet", fields(json!({})))?;
                for key in 0..KEYS {
                    tx.map_set(&id, "cells", &format!("k{key}"), json!(format!("cell {sheet}.{key}")))?;
                }
                Ok(id)
            })
            .collect::<kition_kdm::Result<Vec<_>>>()
    })
    .unwrap();
    let bytes = made.snapshot().unwrap();
    drop(made);
    (Replica::load(schema(), &bytes, ActorId::from_u64(2).unwrap()).unwrap(), ids)
}

/// Clears cell `key` of every sheet in one person's transaction, as a column clear does.
fn clear(replica: &mut Replica, ids: &[ObjectId], key: &str) {
    replica
        .transact(&person(), |tx| {
            for id in ids {
                tx.map_delete(id, "cells", key)?;
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn undo_of_a_creation_older_than_a_large_write_keeps_nothing_of_the_history_it_read() {
    let (mut replica, ids) = opened();
    let made = replica.transact(&person(), |tx| tx.create("Sheet", fields(json!({})))).unwrap();
    let start = resident();
    clear(&mut replica, &ids, "k0");
    let wrote = resident();
    assert!(replica.undo().unwrap().is_done(), "the clear is undone");
    assert_eq!(replica.map_get(&ids[7], "cells", "k0").unwrap(), json!("cell 7.0"));
    let undone = resident();
    assert!(replica.undo().unwrap().is_done(), "the creation is undone");
    assert!(!replica.exists(&made));
    let engine_undone = resident();
    assert!(replica.redo().unwrap().is_done(), "the creation is redone");
    assert!(replica.exists(&made));
    // A second write as large as the first, after the history was released.
    clear(&mut replica, &ids, "k1");
    let wrote_again = resident();
    assert_eq!(replica.map_get(&ids[7], "cells", "k0").unwrap(), json!("cell 7.0"));
    assert_eq!(replica.map_get(&ids[7], "cells", "k1").unwrap(), json!(null));
    assert_eq!(replica.map_get(&ids[7], "cells", "k2").unwrap(), json!("cell 7.2"));
    eprintln!(
        "resident growth: write {} B, its undo {} B, the creation's undo {} B, a second write {} B ({SHEETS} cells)",
        wrote - start,
        undone - wrote,
        engine_undone - undone,
        wrote_again - engine_undone
    );
}
