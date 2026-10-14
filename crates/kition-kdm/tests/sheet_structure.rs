// Copied from kition-sdk crates/kition-kdm/tests/sheet_structure.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Sheet structural edits under concurrency: the case cited against CRDTs for spreadsheets.
//!
//! Rows and columns are lists of stable line ids. A cell is keyed `<rowId>|<colId>`, and a
//! formula names cells by those ids (`@<rowId>|<colId>`), so A1 references are a view computed
//! from the current order and follow inserted and deleted lines.

use std::sync::Arc;

use kition_kdm::testing::Network;
use kition_kdm::{ObjectId, Origin, Replica, Result, Schema, Tx};
use serde_json::{Map, Value, json};

fn network(seed: u64) -> Network {
    let schema = Arc::new(Schema::parse(include_str!("fixtures/sheet-schema.json")).unwrap());
    Network::new(schema, 2, seed).unwrap()
}

fn person() -> Origin {
    Origin::person("user:test")
}

/// A sheet with `rows` × `cols` lines; answers `(sheet, rows, cols)`.
fn sheet(replica: &mut Replica, rows: usize, cols: usize) -> (ObjectId, Vec<ObjectId>, Vec<ObjectId>) {
    replica
        .transact(&person(), |tx| {
            let sheet = tx.create("Sheet", Map::new())?;
            let rows = lines(tx, &sheet, "rows", rows)?;
            let cols = lines(tx, &sheet, "cols", cols)?;
            Ok((sheet, rows, cols))
        })
        .unwrap()
}

fn lines(tx: &mut Tx<'_>, sheet: &ObjectId, field: &str, count: usize) -> Result<Vec<ObjectId>> {
    let mut ids = Vec::new();
    for index in 0..count {
        let line = tx.create("Line", Map::new())?;
        tx.list_insert(sheet, field, index, &line)?;
        ids.push(line);
    }
    Ok(ids)
}

fn key(row: &ObjectId, col: &ObjectId) -> String {
    format!("{row}|{col}")
}

/// `A1`-style name of a cell from the current line order, or `#REF!` when a line is gone.
fn a1(replica: &Replica, sheet: &ObjectId, row: &str, col: &str) -> String {
    let rows = replica.list(sheet, "rows").unwrap();
    let cols = replica.list(sheet, "cols").unwrap();
    let r = rows.iter().position(|id| id.as_str() == row);
    let c = cols.iter().position(|id| id.as_str() == col);
    match (r, c) {
        (Some(r), Some(c)) => format!("{}{}", (b'A' + c as u8) as char, r + 1),
        _ => "#REF!".into(),
    }
}

/// A formula's display text: every `@row|col` reference rendered as A1.
fn display(replica: &Replica, sheet: &ObjectId, formula: &str) -> String {
    let mut out = String::new();
    for (index, part) in formula.split('@').enumerate() {
        if index == 0 {
            out.push_str(part);
            continue;
        }
        let end = part.find(['+', ' ']).unwrap_or(part.len());
        let (reference, rest) = part.split_at(end);
        let (row, col) = reference.split_once('|').unwrap_or((reference, ""));
        out.push_str(&a1(replica, sheet, row, col));
        out.push_str(rest);
    }
    out
}

fn input(replica: &Replica, sheet: &ObjectId, row: &ObjectId, col: &ObjectId) -> Value {
    replica.map_get(sheet, "cells", &key(row, col)).unwrap()
}

#[test]
fn a_formula_follows_a_row_inserted_concurrently_above_its_target() {
    let mut net = network(1);
    let (sheet, rows, cols) = sheet(&mut net.replicas[0], 3, 2);
    net.sync_all().unwrap();
    // Replica 0 inserts a row at the top; replica 1 writes C1 := B2 + 1 in its own view.
    net.replicas[0]
        .transact(&person(), |tx| {
            let line = tx.create("Line", Map::new())?;
            tx.list_insert(&sheet, "rows", 0, &line)
        })
        .unwrap();
    let formula = format!("=@{}+1", key(&rows[1], &cols[1]));
    net.replicas[1].transact(&person(), |tx| tx.map_set(&sheet, "cells", &key(&rows[0], &cols[0]), json!(formula))).unwrap();
    assert_eq!(display(&net.replicas[1], &sheet, &formula), "=B2+1");
    net.sync_all().unwrap();
    net.converged().unwrap();
    for replica in &net.replicas {
        assert_eq!(display(replica, &sheet, &formula), "=B3+1", "the reference follows its row");
        assert_eq!(a1(replica, &sheet, rows[0].as_str(), cols[0].as_str()), "A2", "the edited cell moved down too");
        assert_eq!(input(replica, &sheet, &rows[0], &cols[0]), json!(formula));
    }
}

#[test]
fn a_reference_to_a_row_deleted_concurrently_becomes_ref_error_everywhere() {
    let mut net = network(2);
    let (sheet, rows, cols) = sheet(&mut net.replicas[0], 3, 2);
    net.sync_all().unwrap();
    net.replicas[0].transact(&person(), |tx| tx.list_remove(&sheet, "rows", 1)).unwrap();
    let formula = format!("=@{}+1", key(&rows[1], &cols[0]));
    net.replicas[1].transact(&person(), |tx| tx.map_set(&sheet, "cells", &key(&rows[2], &cols[1]), json!(formula))).unwrap();
    net.sync_all().unwrap();
    net.converged().unwrap();
    for replica in &net.replicas {
        assert_eq!(display(replica, &sheet, &formula), "=#REF!+1");
        assert_eq!(a1(replica, &sheet, rows[2].as_str(), cols[1].as_str()), "B2");
    }
}

#[test]
fn concurrent_edits_after_structural_changes_land_on_their_intended_cells() {
    let mut net = network(3);
    let (sheet, rows, cols) = sheet(&mut net.replicas[0], 2, 2);
    net.sync_all().unwrap();
    net.replicas[0]
        .transact(&person(), |tx| {
            let line = tx.create("Line", Map::new())?;
            tx.list_insert(&sheet, "cols", 0, &line)?;
            tx.map_set(&sheet, "cells", &key(&rows[1], &cols[1]), json!("from zero"))
        })
        .unwrap();
    net.replicas[1]
        .transact(&person(), |tx| {
            let line = tx.create("Line", Map::new())?;
            tx.list_insert(&sheet, "rows", 0, &line)?;
            tx.map_set(&sheet, "cells", &key(&rows[0], &cols[0]), json!("from one"))
        })
        .unwrap();
    net.sync_all().unwrap();
    net.converged().unwrap();
    let replica = &net.replicas[0];
    assert_eq!(a1(replica, &sheet, rows[1].as_str(), cols[1].as_str()), "C3");
    assert_eq!(a1(replica, &sheet, rows[0].as_str(), cols[0].as_str()), "B2");
    assert_eq!(input(replica, &sheet, &rows[1], &cols[1]), json!("from zero"));
    assert_eq!(input(replica, &sheet, &rows[0], &cols[0]), json!("from one"));
}

#[test]
fn a_column_inserted_inside_a_merged_range_widens_it() {
    let mut net = network(4);
    let (sheet, rows, cols) = sheet(&mut net.replicas[0], 2, 3);
    // A1:C1 merged, stored by line ids.
    let merge = json!({ "top": rows[0].as_str(), "left": cols[0].as_str(), "bottom": rows[0].as_str(), "right": cols[2].as_str() });
    net.replicas[0].transact(&person(), |tx| tx.map_set(&sheet, "merges", "m1", merge.clone())).unwrap();
    net.sync_all().unwrap();
    net.replicas[1]
        .transact(&person(), |tx| {
            let line = tx.create("Line", Map::new())?;
            tx.list_insert(&sheet, "cols", 1, &line)
        })
        .unwrap();
    net.sync_all().unwrap();
    net.converged().unwrap();
    for replica in &net.replicas {
        let stored = replica.map_get(&sheet, "merges", "m1").unwrap();
        let right = a1(replica, &sheet, stored["bottom"].as_str().unwrap(), stored["right"].as_str().unwrap());
        assert_eq!(right, "D1", "the merge now spans A1:D1");
    }
}
