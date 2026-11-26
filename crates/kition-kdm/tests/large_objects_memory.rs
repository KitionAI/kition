// Copied from kition-sdk crates/kition-kdm/tests/large_objects_memory.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! A large sheet loads, is held and saves in about its own memory (case
//! regressions/issue-kdm-large-documents). Kition Sheet holds a million cells as a million `Cell`
//! objects, each named in one `map` keyed `<row id>:<column id>`. An object is held once: its id
//! (a UUID inline, 40 bytes), its type and field names shared with every object, its values inline;
//! a map key of two ids is their 32 bytes, an id value its 16.
//!
//! The memory is the heap this test binary's allocator counts, with its peak; this file holds one
//! test, so nothing else allocates while it measures. A fifth of a million cells keeps it a few
//! seconds.

use std::alloc::System;

use cap::Cap;
use serde_json::json;

mod large;

#[global_allocator]
static HEAP: Cap<System> = Cap::new(System, usize::MAX);

#[test]
fn a_sheet_of_200_000_cell_objects_loads_and_saves_in_about_its_own_memory() {
    let built = large::sheet(400, 500);
    let costs = large::costs(&built, || HEAP.allocated(), || HEAP.max_allocated(), |tx| tx.set(&built.object, &built.key, json!("42")));
    let per_cell = costs.store as f64 / built.entries as f64;
    println!(
        "{} objects, {} cells: content {}, store {} ({per_cell:.1} bytes a cell, its map entry and its key), loading held {}, saving held {}",
        built.objects,
        built.entries,
        large::mb(costs.content),
        large::mb(costs.store),
        large::mb(costs.load_peak),
        large::mb(costs.snapshot_peak)
    );
    // A cell object of four short fields (its id, its shape shared, four 24-byte values: about 190
    // bytes), its `key` field's two ids (32 bytes), and its map entry (a key of two ids, 24 bytes
    // and 32, and a 24-byte id).
    assert!(costs.store <= built.entries * 320, "the store holds {} for {} cells", costs.store, built.entries);
    assert!(costs.load_peak <= costs.store / 10 * 13 + (1 << 20), "loading held {} for a store of {}", costs.load_peak, costs.store);
    assert!(costs.snapshot_peak <= costs.snapshot_bytes / 10 * 13 + (1 << 20), "saving held {} for {} bytes", costs.snapshot_peak, costs.snapshot_bytes);
    assert!(costs.change < 2048, "one cell's change is {} bytes", costs.change);
    large::saves_to_itself(&built);
}
