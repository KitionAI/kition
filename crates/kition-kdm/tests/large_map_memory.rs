// Copied from kition-sdk crates/kition-kdm/tests/large_map_memory.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! A large table loads, is held and saves in about its own memory (case
//! regressions/issue-kdm-large-documents). Kition Table's performance fixture (100,000 records of 50
//! cells, each record's cells one `map` keyed by field id) is 462.6 MB of content; the page's engine
//! (4 GiB of WebAssembly memory) ran out of memory loading it: the reader built a JSON tree of the
//! whole document, then a second one, then the store, and the store held each cell as a JSON value
//! under its own copy of the field id. The reader now streams the bytes into the store, a cell is a
//! 24-byte key (a field id as its 16 bytes) and a 24-byte value (a short string, a number or an id
//! inline) in one sorted array per record, and a save writes the store into one buffer.
//!
//! The memory is the heap this test binary's allocator counts, with its peak; this file holds one
//! test, so nothing else allocates while it measures. A tenth of the fixture (a million cells, of
//! short values only, so that each cell's cost is its key and value) keeps it a few seconds.

use std::alloc::System;

use cap::Cap;
use serde_json::json;

mod large;

#[global_allocator]
static HEAP: Cap<System> = Cap::new(System, usize::MAX);

#[test]
fn a_table_of_a_million_short_cells_loads_and_saves_in_about_its_own_memory() {
    let built = large::table(20_000, 50, false);
    let costs = large::costs(&built, || HEAP.allocated(), || HEAP.max_allocated(), |tx| tx.map_set(&built.object, "cells", &built.key, json!("edited")));
    let per_cell = costs.store as f64 / built.entries as f64;
    println!(
        "{} records, {} cells: content {}, store {} ({per_cell:.1} bytes a cell), loading held {}, saving held {}",
        built.objects,
        built.entries,
        large::mb(costs.content),
        large::mb(costs.store),
        large::mb(costs.load_peak),
        large::mb(costs.snapshot_peak)
    );
    // A cell is its key and its value, 48 bytes; a record adds its object, its fields and its
    // map's array (about 250 bytes).
    assert!(costs.store <= built.entries * 48 + built.payload + built.objects * 320, "the store holds {} for {} cells", costs.store, built.entries);
    assert!(costs.load_peak <= costs.store / 10 * 13 + (1 << 20), "loading held {} for a store of {}", costs.load_peak, costs.store);
    assert!(costs.snapshot_peak <= costs.snapshot_bytes / 10 * 13 + (1 << 20), "saving held {} for {} bytes", costs.snapshot_peak, costs.snapshot_bytes);
    assert!(costs.change < 2048, "one cell's change is {} bytes", costs.change);
    large::saves_to_itself(&built);
}
