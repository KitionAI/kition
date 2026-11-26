// Copied from kition-sdk crates/kition-kdm/tests/bulk_undo_memory.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Undo and redo of a large write keep memory bounded (case regressions/issue-kdm-bulk-undo-memory).
//! A table's whole column cleared writes one key in every record's cells; its undo and redo used
//! the engine's undo, which looked up each key's previous value in the document's history and
//! kept every part of that history it read: on a page (4 GiB of WebAssembly memory) undo and redo
//! of a 100,000-record column ran out of memory. Undo and redo of writes to registers and map
//! keys now write back the values the write replaced, which the replica noted when it committed.
//!
//! The memory a step keeps is the heap it leaves allocated: this test binary's global allocator
//! counts the bytes allocated and not yet freed, so each step's growth is exact and the same on
//! every machine. (The process's resident memory, read before, depends on the C allocator: the
//! free memory the document's creation left behind absorbs a step's growth or not, so the steps
//! measured differently on different Linux runners.) This file holds one test, so no other test
//! allocates while it runs.

use std::alloc::System;

use cap::Cap;
use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica};
use serde_json::json;

mod common;
use common::{fields, person, schema};

#[global_allocator]
static HEAP: Cap<System> = Cap::new(System, usize::MAX);

/// The heap bytes allocated and not yet freed, by every thread of this process.
fn live() -> i64 {
    i64::try_from(HEAP.allocated()).expect("the heap fits in an i64")
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

/// Clears cell `k0` of every sheet in one person's transaction, as a column clear does.
fn clear_column(replica: &mut Replica, ids: &[ObjectId]) {
    replica
        .transact(&person(), |tx| {
            for id in ids {
                tx.map_delete(id, "cells", "k0")?;
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn undo_and_redo_of_a_large_write_keep_little_more_than_the_write_itself() {
    let (mut replica, ids) = opened();
    let opened = live();
    clear_column(&mut replica, &ids);
    let wrote = live();
    assert!(replica.undo().unwrap().is_done());
    let undone = live();
    assert!(replica.redo().unwrap().is_done());
    let redone = live();
    for (id, value) in [(&ids[0], json!(null)), (&ids[SHEETS - 1], json!(null))] {
        assert_eq!(replica.map_get(id, "cells", "k0").unwrap(), value);
    }
    assert!(replica.undo().unwrap().is_done());
    assert_eq!(replica.map_get(&ids[7], "cells", "k0").unwrap(), json!("cell 7.0"));
    assert_eq!(replica.map_get(&ids[7], "cells", "k1").unwrap(), json!("cell 7.1"));

    let write = wrote - opened;
    let (undo, redo) = (undone - wrote, redone - undone);
    eprintln!("retained: write {write} B, undo {undo} B, redo {redo} B ({SHEETS} cells)");
    // The write keeps the states of the maps it wrote and a note of each cell's previous value;
    // an undo and a redo keep a note of each cell they write back, and nothing of the history.
    assert!(undo <= write / 2, "undo kept {undo} B after a write that kept {write} B");
    assert!(redo <= write / 2, "redo kept {redo} B after a write that kept {write} B");
}
