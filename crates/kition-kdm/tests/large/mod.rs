// Copied from kition-sdk crates/kition-kdm/tests/large/mod.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Synthetic large documents, written as content bytes without the KDM, and what loading, holding
//! and saving them costs (plan 2026-11-24, plain model, section 10).
//!
//! Two shapes, the two that ran out of memory on a page: a table's records, each holding its
//! cells in one `map` keyed by field id (Kition Table's `Record.cells`: 100,000 records of 50
//! fields in its performance fixture), and a sheet's cells, one `Cell` object each, owned by one
//! `map` keyed `<row id>:<column id>` (Kition Sheet: a million cells). The bytes are the content
//! encoding's canonical form, so a document saved again is the same bytes.
//!
//! The memory is the heap the test binary's allocator counts ([`cap::Cap`], with its peak): each
//! test binary that uses this module defines `HEAP` and holds one test, so nothing else allocates
//! while it measures.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema, Tx};
use serde_json::json;

pub const DOC: &str = "0193a5c4-0000-7000-8000-000000000001";

pub fn schema() -> Arc<Schema> {
    Arc::new(
        Schema::parse(
            &json!({
                "kdm": 1,
                "kit": "kit.large",
                "schemaVersion": 1,
                "root": "Book",
                "types": {
                    "Book": { "fields": { "title": { "kind": "string", "optional": true } } },
                    "Record": { "fields": { "cells": { "kind": "map" }, "order": { "kind": "number", "optional": true } } },
                    "Sheet": { "fields": { "cells": { "kind": "map" }, "name": { "kind": "string", "optional": true } } },
                    "Row": { "fields": { "index": { "kind": "integer", "optional": true } } },
                    "Column": { "fields": { "index": { "kind": "integer", "optional": true } } },
                    "Cell": { "fields": {
                        "address": { "kind": "string", "optional": true },
                        "input": { "kind": "string", "optional": true },
                        "key": { "kind": "string", "optional": true },
                        "style": { "kind": "string", "optional": true }
                    } }
                }
            })
            .to_string(),
        )
        .expect("the schema parses"),
    )
}

/// The `n`-th id of kind `kind` (one hex digit): UUIDs in lowercase hyphenated form, ascending
/// with `n` and grouped by kind.
pub fn uuid(kind: u8, n: usize) -> String {
    format!("0193a5c4-{kind:x}000-7000-8000-{n:012x}")
}

/// xorshift64*, from a fixed seed: the same document on every machine.
pub struct Rng(u64);

impl Rng {
    pub fn seeded() -> Self {
        Self(0x7a6b_0b5e_ed00_0001)
    }

    pub fn draw(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    pub fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.draw() % u64::try_from(n.max(1)).unwrap_or(1)).unwrap_or(0)
    }
}

const WORDS: [&str; 16] = [
    "alpha", "beta", "gamma", "delta", "review", "shipping", "invoice", "customer", "launch", "budget", "design", "roadmap", "meeting", "draft", "final",
    "report",
];

/// A synthetic document's content and what it holds.
pub struct Built {
    pub bytes: Vec<u8>,
    /// The map entries it holds.
    pub entries: usize,
    /// The objects it holds.
    pub objects: usize,
    /// The bytes of the strings longer than a value holds inline (22 bytes), which the store
    /// keeps on the heap.
    pub payload: usize,
    /// An object to edit and its field or map key.
    pub object: ObjectId,
    pub key: String,
    pub took: Duration,
}

/// Content of the objects `objects` writes, ids ascending: each object `"<id>":{...}` in one or
/// more pieces, the first one marked. Written twice: once to count its bytes, once into a buffer
/// of exactly that size, so writing it holds little more than it.
fn content(objects: impl Fn(&mut dyn FnMut(bool, &str))) -> Vec<u8> {
    let header = format!("{{\"kdm\":1,\"kit\":\"kit.large\",\"docId\":\"{DOC}\",\"schemaVersion\":1,\"objects\":{{\n");
    let mut size = header.len() + 4;
    objects(&mut |starts, piece| size += piece.len() + if starts { 2 } else { 0 });
    let mut bytes = Vec::with_capacity(size);
    bytes.extend_from_slice(header.as_bytes());
    let mut first = true;
    objects(&mut |starts, piece| {
        if starts && !first {
            bytes.extend_from_slice(b",\n");
        }
        first &= !starts;
        bytes.extend_from_slice(piece.as_bytes());
    });
    if !first {
        bytes.push(b'\n');
    }
    bytes.extend_from_slice(b"}}\n");
    bytes
}

/// One cell value of field `field` as JSON, and the bytes the store keeps of it on the heap. With
/// `mixed`, the mix of Kition Table's performance fixture (texts of one to six words, numbers,
/// choices, lists of choices, dates, checkboxes, ratings, users, attachments); else only values
/// held inline (short strings, numbers, booleans, ids).
fn cell(rng: &mut Rng, field: usize, mixed: bool) -> (String, usize) {
    let choice = |rng: &mut Rng| uuid(0xc, field * 8 + rng.below(8));
    match (field % 50, mixed) {
        (0..20, true) => {
            let words: Vec<&str> = (0..1 + rng.below(6)).map(|_| WORDS[rng.below(WORDS.len())]).collect();
            let text = words.join(" ");
            let heap = if text.len() > 22 { text.len() } else { 0 };
            (format!("\"{text}\""), heap)
        }
        (0..20, false) => (format!("\"{}\"", WORDS[rng.below(WORDS.len())]), 0),
        (20..28, _) if rng.below(2) == 0 => (format!("{}", rng.below(100_000)), 0),
        (20..28, _) => (format!("{}.5", rng.below(10_000)), 0),
        (28..34, _) => (format!("\"{}\"", choice(rng)), 0),
        (34..37, true) => {
            let picked: Vec<String> = (0..1 + rng.below(3)).map(|_| format!("\"{}\"", choice(rng))).collect();
            (format!("[{}]", picked.join(",")), 0)
        }
        (34..37, false) => (format!("\"{}\"", choice(rng)), 0),
        (37..41, _) => (format!("\"2024-{:02}-{:02}\"", 1 + rng.below(12), 1 + rng.below(28)), 0),
        (41..44, _) => ((if rng.below(2) == 0 { "false" } else { "true" }).to_owned(), 0),
        (44..46, _) => (format!("{}", 1 + rng.below(5)), 0),
        (46..48, _) => (format!("\"user-{}\"", rng.below(6)), 0),
        (_, true) => (format!("{{\"hash\":\"{:016x}\",\"mime\":\"image/png\",\"size\":{}}}", rng.draw(), 1 + rng.below(100_000)), 0),
        (_, false) => (format!("{}", rng.below(1000)), 0),
    }
}

/// A table of `records` records with `fields` cells each, in `Record.cells` keyed by field id.
pub fn table(records: usize, fields: usize, mixed: bool) -> Built {
    let started = Instant::now();
    let keys: Vec<String> = (0..fields).map(|field| uuid(0xf, field)).collect();
    let payload = std::cell::Cell::new(0_usize);
    let bytes = content(|object| {
        let mut rng = Rng::seeded();
        let mut held = 0;
        for record in 0..records {
            let cells: Vec<String> = keys
                .iter()
                .enumerate()
                .map(|(field, key)| {
                    let (value, heap) = cell(&mut rng, field, mixed);
                    held += heap;
                    format!("\"{key}\":{value}")
                })
                .collect();
            object(true, &format!("\"{}\":{{\"$type\":\"Record\",\"cells\":{{{}}},\"order\":{record}}}", uuid(0xa, record), cells.join(",")));
        }
        payload.set(held);
    });
    Built {
        bytes,
        entries: records * fields,
        objects: records,
        payload: payload.get(),
        object: ObjectId::from_string(uuid(0xa, 0)),
        key: keys.first().cloned().unwrap_or_default(),
        took: started.elapsed(),
    }
}

/// A sheet of `rows` x `columns` cells: one `Sheet` whose `cells` map holds each cell's id under
/// `<row id>:<column id>`, a `Row` and a `Column` object for each, and one `Cell` object per cell
/// with its address, input, key and style.
pub fn sheet(rows: usize, columns: usize) -> Built {
    let started = Instant::now();
    let key = |cell: usize| format!("{}:{}", uuid(2, cell / columns), uuid(3, cell % columns));
    let cells = rows * columns;
    let bytes = content(|object| {
        object(true, &format!("\"{}\":{{\"$type\":\"Sheet\",\"cells\":{{", uuid(1, 0)));
        for cell in 0..cells {
            object(false, &format!("{}\"{}\":\"{}\"", if cell > 0 { "," } else { "" }, key(cell), uuid(4, cell)));
        }
        object(false, "},\"name\":\"Sheet1\"}");
        for row in 0..rows {
            object(true, &format!("\"{}\":{{\"$type\":\"Row\",\"index\":{row}}}", uuid(2, row)));
        }
        for column in 0..columns {
            object(true, &format!("\"{}\":{{\"$type\":\"Column\",\"index\":{column}}}", uuid(3, column)));
        }
        let mut rng = Rng::seeded();
        for cell in 0..cells {
            let input = if rng.below(4) == 0 { format!("=R{}C{}+1", cell / columns, cell % columns) } else { format!("{}", rng.below(1_000_000)) };
            object(
                true,
                &format!(
                    "\"{}\":{{\"$type\":\"Cell\",\"address\":\"R{}C{}\",\"input\":\"{input}\",\"key\":\"{}\",\"style\":\"s{}\"}}",
                    uuid(4, cell),
                    cell / columns,
                    cell % columns,
                    key(cell),
                    rng.below(20)
                ),
            );
        }
    });
    Built {
        bytes,
        entries: cells,
        objects: 1 + rows + columns + cells,
        // Each cell's key, two ids, is held as their 32 bytes twice: as the cell's `key` field and as
        // its map key.
        payload: cells * 64,
        object: ObjectId::from_string(uuid(4, 0)),
        key: "input".into(),
        took: started.elapsed(),
    }
}

/// What a document cost.
#[derive(Debug)]
pub struct Costs {
    pub content: usize,
    pub load: Duration,
    /// The heap the loading held at its most, beyond the content bytes (the caller's).
    pub load_peak: usize,
    /// The heap the loaded replica holds.
    pub store: usize,
    pub snapshot: Duration,
    /// The heap saving held at its most beyond the replica and the content bytes: at most this
    /// (an upper bound when loading held more).
    pub snapshot_peak: usize,
    pub snapshot_bytes: usize,
    pub edit: Duration,
    /// The bytes of the edit's change.
    pub change: usize,
}

/// Loads `built`, saves it, checks that it saves to its own bytes, then edits it once with `edit`.
/// `live` and `peak` read the test binary's allocator.
pub fn costs(built: &Built, live: impl Fn() -> usize, peak: impl Fn() -> usize, edit: impl FnOnce(&mut Tx<'_>) -> kition_kdm::Result<()>) -> Costs {
    let input = built.bytes.capacity();
    let base = live() - input;
    let started = Instant::now();
    let mut replica = Replica::load(schema(), &built.bytes, ActorId::from_u64(1).expect("an actor")).expect("the document loads");
    let load = started.elapsed();
    let store = live() - base - input;
    let load_peak = peak() - base - input;
    let started = Instant::now();
    let saved = replica.snapshot().expect("a snapshot");
    let snapshot = started.elapsed();
    let snapshot_peak = peak().saturating_sub(base + input + store);
    let snapshot_bytes = saved.len();
    drop(saved);
    let at = replica.version();
    let started = Instant::now();
    replica.transact(&Origin::person("user:large"), edit).expect("the edit applies");
    let edit = started.elapsed();
    let change = replica.export_changes(&at).expect("the change").len();
    let costs = Costs { content: built.bytes.len(), load, load_peak, store, snapshot, snapshot_peak, snapshot_bytes, edit, change };
    println!("{costs:?}");
    costs
}

/// Checks that `built` saves to its own bytes.
pub fn saves_to_itself(built: &Built) {
    let replica = Replica::load(schema(), &built.bytes, ActorId::from_u64(1).expect("an actor")).expect("the document loads");
    let saved = replica.content_snapshot().expect("the content");
    assert!(saved == built.bytes, "the document saves to other bytes ({} and {})", saved.len(), built.bytes.len());
}

/// Builds the same table through transactions ([`Replica::create_with`], one map write per
/// cell), as a kit's import does; answers the time it took and the replica.
pub fn build_table(records: usize, fields: usize) -> (Duration, Replica) {
    let started = Instant::now();
    let keys: Vec<String> = (0..fields).map(|field| uuid(0xf, field)).collect();
    let (replica, ()) =
        Replica::create_with(schema(), DocId::parse(DOC).expect("a doc id"), ActorId::from_u64(1).expect("an actor"), &Origin::system("import"), |tx| {
            let mut rng = Rng::seeded();
            for record in 0..records {
                let id = tx.create_with_id(
                    "Record",
                    &ObjectId::from_string(uuid(0xa, record)),
                    json!({ "order": record }).as_object().cloned().unwrap_or_default(),
                )?;
                for (field, key) in keys.iter().enumerate() {
                    let (value, _) = cell(&mut rng, field, true);
                    tx.map_set(&id, "cells", key, serde_json::from_str(&value).unwrap_or_default())?;
                }
            }
            Ok(())
        })
        .expect("the table builds");
    (started.elapsed(), replica)
}

pub fn mb(bytes: usize) -> String {
    format!("{:.1} MB", bytes as f64 / 1e6)
}
