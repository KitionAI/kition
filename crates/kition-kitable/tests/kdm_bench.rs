//! Opt-in benchmark for the Table on the KDM, not a correctness test (like
//! `documentKdm.bench.spec.ts` on the Markdown document side): prints a timing table at 10,000
//! and 100,000 records (10 fields), and how the 10k numbers compare with this phase's budgets
//! (edit < 16 ms, a 1,000-cell paste < 100 ms, open < 1.5 s), without enforcing them — a budget
//! miss is something to read and report, not a reason to fail CI on a shared, noisy machine.
//!
//! Run in release (debug is much slower and not representative):
//!
//! ```sh
//! cargo test --release -p kition-kitable --test kdm_bench -- --ignored --nocapture
//! ```

use std::path::Path;
use std::time::{Duration, Instant};

use kition_kdm::Origin;
use kition_kitable::kdm::migrate;
use kition_kitable::kdm::project;
use kition_kitable::kdm::store;
use kition_kitable::{CellEdit, CreateOptions, FieldSpec, KitableFile, TableOp, TableSpec};
use rusqlite::Connection;
use serde_json::{Map, Value};

const FIELD_COUNT: usize = 10;
const CREATE_CHUNK: usize = 1_000;
const PASTE_CELLS: usize = 1_000;

fn ok<T, E: std::fmt::Display>(result: Result<T, E>) -> T {
    result.unwrap_or_else(|err| panic!("unexpected error: {err}"))
}

fn field_specs() -> Vec<FieldSpec> {
    (0..FIELD_COUNT)
        .map(|index| FieldSpec {
            name: format!("field_{index}"),
            title: format!("Field {index}"),
            field_type: "text".into(),
            primary: index == 0,
            required: index == 0,
            ..Default::default()
        })
        .collect()
}

fn row(seed: usize) -> Map<String, Value> {
    (0..FIELD_COUNT)
        .map(|index| {
            (
                format!("field_{index}"),
                Value::from(format!("v{seed}-{index}")),
            )
        })
        .collect()
}

fn one_cell(field: &str, value: &str) -> Map<String, Value> {
    Map::from_iter([(field.to_owned(), Value::from(value))])
}

/// Builds a fresh `.kitable` at `path` with one table, [`FIELD_COUNT`] fields, and `count`
/// records, created in chunks of [`CREATE_CHUNK`] (each its own `transact`) under a `system`
/// origin, so the bulk load itself is not undo history. Returns the table id and every created
/// row key, in creation order.
fn build(path: &Path, count: usize) -> (i64, Vec<String>) {
    let mut file = ok(KitableFile::create(path, &CreateOptions::default()));
    file.set_origin(Origin::system("bench-setup"));
    let table = ok(file.create_table(&TableSpec {
        name: "Items".into(),
        fields: field_specs(),
        ..Default::default()
    }));
    let mut row_keys = Vec::with_capacity(count);
    let mut created = 0usize;
    while created < count {
        let chunk = CREATE_CHUNK.min(count - created);
        let records = (0..chunk)
            .map(|index| row(created + index))
            .collect::<Vec<_>>();
        let (ids, _) = ok(file.transact(&[TableOp::RecordsCreate {
            table_id: table.id,
            at: None,
            records,
        }]));
        row_keys.extend(ids);
        created += chunk;
    }
    file.close();
    (table.id, row_keys)
}

#[derive(Debug, Default)]
struct Timings {
    records: usize,
    open: Duration,
    open_with_migration: Duration,
    edit: Duration,
    paste_1000: Duration,
    undo_first: Duration,
    undo_later: Duration,
    compact: Duration,
    rebuild: Duration,
}

fn bench_size(dir: &Path, count: usize) -> Timings {
    let path = dir.join(format!("bench-{count}.kitable"));
    let (table_id, row_keys) = build(&path, count);

    // Plain open.
    let start = Instant::now();
    let mut file = ok(KitableFile::open(&path));
    let open = start.elapsed();
    file.set_origin(Origin::person("bench"));

    // One cell edit: a single field of a single record.
    let start = Instant::now();
    ok(file.transact(&[TableOp::CellsSet {
        table_id,
        records: vec![CellEdit {
            row_key: row_keys[0].clone(),
            values: one_cell("field_0", "edited"),
        }],
    }]));
    let edit = start.elapsed();

    // A 1,000-cell transact (one column pasted over 1,000 rows, as one op).
    let paste_rows: Vec<CellEdit> = row_keys
        .iter()
        .take(PASTE_CELLS)
        .map(|key| CellEdit {
            row_key: key.clone(),
            values: one_cell("field_1", "pasted"),
        })
        .collect();
    let start = Instant::now();
    ok(file.transact(&[TableOp::CellsSet {
        table_id,
        records: paste_rows,
    }]));
    let paste_1000 = start.elapsed();

    // Undo: first and later. Two more separate (ungrouped) edits give two undo steps on this
    // handle, on top of the edit and the paste already made above (four in total).
    ok(file.transact(&[TableOp::CellsSet {
        table_id,
        records: vec![CellEdit {
            row_key: row_keys[1].clone(),
            values: one_cell("field_2", "a"),
        }],
    }]));
    ok(file.transact(&[TableOp::CellsSet {
        table_id,
        records: vec![CellEdit {
            row_key: row_keys[2].clone(),
            values: one_cell("field_2", "b"),
        }],
    }]));
    let start = Instant::now();
    let (done, _) = ok(file.undo());
    let undo_first = start.elapsed();
    assert!(done, "expected an undo step at {count} records");
    let start = Instant::now();
    let (done, _) = ok(file.undo());
    let undo_later = start.elapsed();
    assert!(done, "expected a second undo step at {count} records");

    // Compaction and rebuild, directly on the stored replica (not through the manager).
    let now = kition_time::now_millis();
    let start = Instant::now();
    ok(store::compact(file.conn(), file.replica(), now));
    let compact = start.elapsed();
    let start = Instant::now();
    ok(project::rebuild(file.conn(), file.replica(), now));
    let rebuild = start.elapsed();

    file.close();

    // First open with migration from schema 3: downgrade (test-only support), then open, which
    // runs `migrate::upgrade` because the file has no stored replica.
    let mut conn = Connection::open(&path).unwrap_or_else(|err| panic!("{err}"));
    ok(migrate::downgrade(&mut conn));
    drop(conn);
    let start = Instant::now();
    let migrated = ok(KitableFile::open(&path));
    let open_with_migration = start.elapsed();
    migrated.close();

    Timings {
        records: count,
        open,
        open_with_migration,
        edit,
        paste_1000,
        undo_first,
        undo_later,
        compact,
        rebuild,
    }
}

#[test]
#[ignore]
fn kdm_bench() {
    let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
    let rows: Vec<Timings> = [10_000usize, 100_000usize]
        .into_iter()
        .map(|size| bench_size(dir.path(), size))
        .collect();

    println!();
    println!(
        "{:>9} | {:>10} | {:>14} | {:>9} | {:>10} | {:>11} | {:>11} | {:>9} | {:>9}",
        "records",
        "open",
        "open+migrate",
        "edit",
        "1k-paste",
        "undo 1st",
        "undo 2nd",
        "compact",
        "rebuild",
    );
    for t in &rows {
        println!(
            "{:>9} | {:>10?} | {:>14?} | {:>9?} | {:>10?} | {:>11?} | {:>11?} | {:>9?} | {:>9?}",
            t.records,
            t.open,
            t.open_with_migration,
            t.edit,
            t.paste_1000,
            t.undo_first,
            t.undo_later,
            t.compact,
            t.rebuild,
        );
    }
    println!();

    // This phase's budgets, reported against 10k (100k is printed above for context only): a
    // miss is logged, not failed — see the module doc.
    let ten_k = rows
        .first()
        .unwrap_or_else(|| panic!("expected a 10k result"));
    report_budget("open at 10k", ten_k.open, Duration::from_millis(1_500));
    report_budget("edit at 10k", ten_k.edit, Duration::from_millis(16));
    report_budget(
        "1,000-cell paste at 10k",
        ten_k.paste_1000,
        Duration::from_millis(100),
    );
}

fn report_budget(label: &str, actual: Duration, budget: Duration) {
    let verdict = if actual < budget {
        "within budget"
    } else {
        "OVER budget"
    };
    println!("[budget] {label}: {actual:?} ({verdict}: {budget:?})");
}
