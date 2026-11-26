// Copied from kition-sdk crates/kition-kdm/tests/large_documents.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Large documents at full size (plan 2026-11-24, plain model, section 10): Kition Table's
//! performance fixture (100,000 records of 50 cells, 5,000,000 cells, the fixture's mix of values)
//! and a sheet of a million cell objects. Each prints what building, loading, holding, saving and
//! editing it cost; `tests/large_map_memory.rs` and `tests/large_objects_memory.rs` are the gating
//! tests at a tenth and a fifth of the size. Run one at a time, in release, each in its own
//! process (the allocator's peak is the process's):
//!
//! `cargo test --release -p kition-kdm --test large_documents -- --ignored --nocapture --exact <name>`

use std::alloc::System;
use std::time::Instant;

use cap::Cap;
use serde_json::json;

mod large;

#[global_allocator]
static HEAP: Cap<System> = Cap::new(System, usize::MAX);

fn report(what: &str, built: &large::Built) {
    let costs = large::costs(
        built,
        || HEAP.allocated(),
        || HEAP.max_allocated(),
        |tx| {
            if what.starts_with("table") {
                tx.map_set(&built.object, "cells", &built.key, json!("edited"))
            } else {
                tx.set(&built.object, &built.key, json!("42"))
            }
        },
    );
    println!(
        "{what}: {} objects, {} map entries; content {} written in {:?}; load {:?}, held at most {}; store {} ({:.1} bytes an entry); snapshot {:?}, {} held at most {} beyond the store; one edit {:?}, its change {} bytes",
        built.objects,
        built.entries,
        large::mb(costs.content),
        built.took,
        costs.load,
        large::mb(costs.load_peak),
        large::mb(costs.store),
        costs.store as f64 / built.entries as f64,
        costs.snapshot,
        large::mb(costs.snapshot_bytes),
        large::mb(costs.snapshot_peak),
        costs.edit,
        costs.change
    );
    large::saves_to_itself(built);
}

#[test]
#[ignore = "full size: minutes and gigabytes; run by hand in release"]
fn table_at_full_size() {
    report("table 100,000 x 50", &large::table(100_000, 50, true));
}

#[test]
#[ignore = "full size: minutes and gigabytes; run by hand in release"]
fn sheet_at_full_size() {
    report("sheet 1,000 x 1,000", &large::sheet(1_000, 1_000));
}

#[test]
#[ignore = "full size: minutes and gigabytes; run by hand in release"]
fn table_built_through_transactions_at_full_size() {
    let (took, replica) = large::build_table(100_000, 50);
    let (live, peak) = (HEAP.allocated(), HEAP.max_allocated());
    let started = Instant::now();
    let bytes = replica.snapshot().expect("a snapshot");
    println!(
        "table 100,000 x 50 built through one transaction in {took:?}: held {} after, {} at most; snapshot {} in {:?}, {} at most",
        large::mb(live),
        large::mb(peak),
        large::mb(bytes.len()),
        started.elapsed(),
        large::mb(HEAP.max_allocated())
    );
}
