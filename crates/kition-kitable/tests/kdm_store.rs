//! Storing a table's KDM replica inside its `.kitable` file.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use kition_kdm::{ActorId, DocId, ObjectId, Origin, Replica, Schema};
use kition_kitable::kdm::store;
use kition_kitable::{CreateOptions, KitableFile};
use rusqlite::{Connection, Transaction, params};
use serde_json::{Map, json};

/// A small schema for these tests: a `Base` holding a list of `Record`s, each a bag of cells.
/// Mirrors the Table kit's shape without depending on its real schema (built by a parallel task).
const SCHEMA: &str = r#"{
    "kdm": 1,
    "kit": "kit.test-table",
    "schemaVersion": 1,
    "root": "Base",
    "types": {
        "Base": {
            "fields": {
                "records": { "kind": "list", "of": "Record" }
            }
        },
        "Record": {
            "fields": {
                "cells": { "kind": "map" }
            }
        }
    }
}"#;

fn temp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap_or_else(|err| panic!("tempdir: {err}"))
}

/// A fresh `.kitable` file with the KDM tables and columns installed.
fn create_file(dir: &Path) -> KitableFile {
    let file = KitableFile::create(
        &dir.join("doc.kitable"),
        &CreateOptions {
            title: "Test".into(),
            ..Default::default()
        },
    )
    .unwrap_or_else(|err| panic!("create: {err}"));
    store::ensure_tables(file.conn()).unwrap_or_else(|err| panic!("ensure_tables: {err}"));
    file
}

fn schema() -> Arc<Schema> {
    Arc::new(Schema::parse(SCHEMA).unwrap_or_else(|err| panic!("schema: {err}")))
}

fn actor(id: u64) -> ActorId {
    ActorId::from_u64(id).unwrap_or_else(|err| panic!("actor: {err}"))
}

fn person() -> Origin {
    Origin::person("user:test")
}

fn ok<T>(result: kition_kitable::Result<T>) -> T {
    result.unwrap_or_else(|err| panic!("unexpected error: {err}"))
}

fn kok<T>(result: kition_kdm::Result<T>) -> T {
    result.unwrap_or_else(|err| panic!("unexpected kdm error: {err}"))
}

/// Runs `f` inside its own committed SQL transaction, as a caller of `store` would.
fn with_tx<T>(
    conn: &Connection,
    f: impl FnOnce(&Transaction<'_>) -> kition_kitable::Result<T>,
) -> T {
    let tx = conn
        .unchecked_transaction()
        .unwrap_or_else(|err| panic!("begin transaction: {err}"));
    let value = f(&tx).unwrap_or_else(|err| panic!("transaction body: {err}"));
    tx.commit().unwrap_or_else(|err| panic!("commit: {err}"));
    value
}

/// Builds a document with one `Base` object (id `"table"`) and `count` `Record`s under it,
/// each with one cell. Returns the replica and the base's id.
fn seed_replica(schema: Arc<Schema>, actor: ActorId, count: usize) -> (Replica, ObjectId) {
    let base = ObjectId::from_string("table");
    let (replica, ()) = kok(Replica::create_with(
        schema,
        DocId::new(),
        actor,
        &Origin::system("seed"),
        |tx| {
            tx.create_with_id("Base", &base, Map::new())?;
            for index in 0..count {
                let record = tx.create("Record", Map::new())?;
                tx.map_set(&record, "cells", "name", json!(format!("row-{index}")))?;
                tx.list_insert(&base, "records", index, &record)?;
            }
            Ok(())
        },
    ));
    (replica, base)
}

/// Adds one more record under `base`, in its own transaction.
fn add_record(replica: &mut Replica, base: &ObjectId, label: &str) {
    kok(replica.transact(&person(), |tx| {
        let record = tx.create("Record", Map::new())?;
        tx.map_set(&record, "cells", "name", json!(label))?;
        let index = tx.list_items(base, "records")?.len();
        tx.list_insert(base, "records", index, &record)
    }));
}

fn column_names(conn: &Connection, table: &str) -> Vec<String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap_or_else(|err| panic!("prepare: {err}"));
    statement
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap_or_else(|err| panic!("query_map: {err}"))
        .collect::<std::result::Result<Vec<_>, _>>()
        .unwrap_or_else(|err| panic!("collect: {err}"))
}

#[test]
fn ensure_tables_is_idempotent_and_keeps_existing_data() {
    let dir = temp();
    let file = KitableFile::create(
        &dir.path().join("doc.kitable"),
        &CreateOptions {
            title: "Test".into(),
            ..Default::default()
        },
    )
    .unwrap_or_else(|err| panic!("create: {err}"));
    let conn = file.conn();
    let document_id = ok(file.info()).document_id;
    conn.execute(
        "INSERT INTO kition_tables (document_id, name, title, created_at, updated_at) \
         VALUES (?1, 'things', 'Things', 0, 0)",
        params![document_id],
    )
    .unwrap_or_else(|err| panic!("insert: {err}"));

    store::ensure_tables(conn).unwrap_or_else(|err| panic!("ensure_tables: {err}"));
    for table in [
        "kition_tables",
        "kition_fields",
        "kition_views",
        "kition_record_links",
    ] {
        assert!(
            column_names(conn, table)
                .iter()
                .any(|name| name == "kdm_id"),
            "{table} should have a kdm_id column"
        );
    }
    for table in ["kition_kdm", "kition_kdm_changes"] {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .unwrap_or_else(|err| panic!("query: {err}"));
        assert_eq!(count, 1, "{table} should exist");
    }

    // Calling it again changes nothing.
    store::ensure_tables(conn).unwrap_or_else(|err| panic!("ensure_tables again: {err}"));

    let (name, title): (String, String) = conn
        .query_row(
            "SELECT name, title FROM kition_tables WHERE name = 'things'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or_else(|err| panic!("query: {err}"));
    assert_eq!(name, "things");
    assert_eq!(title, "Things");
}

#[test]
fn save_initial_then_load_round_trips() {
    let dir = temp();
    let file = create_file(dir.path());
    let conn = file.conn();
    let (replica, _base) = seed_replica(schema(), actor(1), 3);

    with_tx(conn, |tx| store::save_initial(tx, &replica, 1_000));

    let loaded =
        ok(store::load(conn, schema(), actor(2))).unwrap_or_else(|| panic!("expected a replica"));
    assert_eq!(kok(loaded.state_hash()), kok(replica.state_hash()));
}

#[test]
fn save_initial_fails_when_a_row_already_exists() {
    let dir = temp();
    let file = create_file(dir.path());
    let conn = file.conn();
    let (replica, _base) = seed_replica(schema(), actor(1), 1);
    with_tx(conn, |tx| store::save_initial(tx, &replica, 1_000));
    let result = conn
        .unchecked_transaction()
        .unwrap_or_else(|err| panic!("begin: {err}"));
    assert!(store::save_initial(&result, &replica, 2_000).is_err());
}

#[test]
fn appended_changes_reload_to_the_same_state() {
    let dir = temp();
    let file = create_file(dir.path());
    let conn = file.conn();
    let (mut replica, base) = seed_replica(schema(), actor(1), 2);
    with_tx(conn, |tx| store::save_initial(tx, &replica, 1_000));

    for index in 0..5 {
        let since = replica.version();
        add_record(&mut replica, &base, &format!("extra-{index}"));
        let seq = with_tx(conn, |tx| {
            store::append(tx, &replica, &since, "test", 1_000 + index)
        });
        assert!(seq > 0, "append should return a positive seq");
    }

    let loaded =
        ok(store::load(conn, schema(), actor(2))).unwrap_or_else(|| panic!("expected a replica"));
    assert_eq!(kok(loaded.state_hash()), kok(replica.state_hash()));

    let (generation, seq) = ok(store::stored_position(conn));
    assert_eq!(generation, 1);
    assert_eq!(seq, 5);
}

#[test]
fn append_with_no_new_changes_is_a_no_op() {
    let dir = temp();
    let file = create_file(dir.path());
    let conn = file.conn();
    let (replica, _base) = seed_replica(schema(), actor(1), 1);
    with_tx(conn, |tx| store::save_initial(tx, &replica, 1_000));

    let since = replica.version();
    let seq = with_tx(conn, |tx| {
        store::append(tx, &replica, &since, "test", 1_000)
    });
    assert_eq!(seq, 0);
    let (_, stored_seq) = ok(store::stored_position(conn));
    assert_eq!(stored_seq, 0);
}

#[test]
fn compact_snapshots_and_clears_the_change_log() {
    let dir = temp();
    let file = create_file(dir.path());
    let conn = file.conn();
    let (mut replica, base) = seed_replica(schema(), actor(1), 2);
    with_tx(conn, |tx| store::save_initial(tx, &replica, 1_000));

    for index in 0..3 {
        let since = replica.version();
        add_record(&mut replica, &base, &format!("extra-{index}"));
        with_tx(conn, |tx| {
            store::append(tx, &replica, &since, "test", 1_000 + index)
        });
    }
    let (generation_before, seq_before) = ok(store::stored_position(conn));
    assert_eq!(generation_before, 1);
    assert_eq!(seq_before, 3);

    with_tx(conn, |tx| store::compact(tx, &replica, 2_000));

    let (generation_after, seq_after) = ok(store::stored_position(conn));
    assert_eq!(generation_after, 2);
    assert_eq!(seq_after, 0);
    let change_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM kition_kdm_changes", [], |row| {
            row.get(0)
        })
        .unwrap_or_else(|err| panic!("query: {err}"));
    assert_eq!(change_rows, 0);

    let loaded =
        ok(store::load(conn, schema(), actor(2))).unwrap_or_else(|| panic!("expected a replica"));
    assert_eq!(kok(loaded.state_hash()), kok(replica.state_hash()));
}

#[test]
fn a_rolled_back_transaction_leaves_no_change_row() {
    let dir = temp();
    let file = create_file(dir.path());
    let conn = file.conn();
    let (mut replica, base) = seed_replica(schema(), actor(1), 1);
    with_tx(conn, |tx| store::save_initial(tx, &replica, 1_000));
    let before_hash = kok(replica.state_hash());

    let since = replica.version();
    add_record(&mut replica, &base, "never-persisted");
    {
        let tx = conn
            .unchecked_transaction()
            .unwrap_or_else(|err| panic!("begin: {err}"));
        ok(store::append(&tx, &replica, &since, "test", 1_000));
        // Dropped without commit: rusqlite rolls the transaction back.
    }

    let change_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM kition_kdm_changes", [], |row| {
            row.get(0)
        })
        .unwrap_or_else(|err| panic!("query: {err}"));
    assert_eq!(change_rows, 0);

    let loaded =
        ok(store::load(conn, schema(), actor(2))).unwrap_or_else(|| panic!("expected a replica"));
    assert_eq!(kok(loaded.state_hash()), before_hash);
}

#[test]
fn corrupted_change_bytes_error_instead_of_panicking() {
    let dir = temp();
    let file = create_file(dir.path());
    let conn = file.conn();
    let (mut replica, base) = seed_replica(schema(), actor(1), 1);
    with_tx(conn, |tx| store::save_initial(tx, &replica, 1_000));

    let since = replica.version();
    add_record(&mut replica, &base, "will-be-corrupted");
    with_tx(conn, |tx| {
        store::append(tx, &replica, &since, "test", 1_000)
    });

    conn.execute(
        "UPDATE kition_kdm_changes SET bytes = ?1 WHERE seq = (SELECT MAX(seq) FROM kition_kdm_changes)",
        params![vec![0xFFu8; 16]],
    )
    .unwrap_or_else(|err| panic!("corrupt: {err}"));

    let result = store::load(conn, schema(), actor(2));
    assert!(
        result.is_err(),
        "corrupted change bytes should error, not panic"
    );
}

#[test]
fn should_compact_reports_too_many_rows_or_too_many_bytes() {
    let dir = temp();
    let file = create_file(dir.path());
    let conn = file.conn();
    let (replica, _base) = seed_replica(schema(), actor(1), 1);
    with_tx(conn, |tx| store::save_initial(tx, &replica, 1_000));
    assert!(!ok(store::should_compact(conn)));

    for seq in 0..501 {
        conn.execute(
            "INSERT INTO kition_kdm_changes (bytes, origin, created_at) VALUES (?1, 'test', ?2)",
            params![vec![0u8; 4], seq],
        )
        .unwrap_or_else(|err| panic!("insert: {err}"));
    }
    assert!(ok(store::should_compact(conn)), "too many change rows");

    conn.execute("DELETE FROM kition_kdm_changes", [])
        .unwrap_or_else(|err| panic!("delete: {err}"));
    assert!(!ok(store::should_compact(conn)));

    conn.execute(
        "INSERT INTO kition_kdm_changes (bytes, origin, created_at) VALUES (?1, 'test', 0)",
        params![vec![0u8; 1_200_000]],
    )
    .unwrap_or_else(|err| panic!("insert large: {err}"));
    assert!(ok(store::should_compact(conn)), "too many change bytes");
}

#[test]
fn projected_position_round_trips_through_kition_meta() {
    let dir = temp();
    let file = create_file(dir.path());
    let conn = file.conn();
    assert_eq!(ok(store::projected_position(conn)), (0, 0));
    ok(store::set_projected_position(conn, (3, 42)));
    assert_eq!(ok(store::projected_position(conn)), (3, 42));
    ok(store::set_projected_position(conn, (4, 43)));
    assert_eq!(ok(store::projected_position(conn)), (4, 43));
}

#[test]
fn stored_position_is_zero_before_the_replica_is_saved() {
    let dir = temp();
    let file = create_file(dir.path());
    assert_eq!(ok(store::stored_position(file.conn())), (0, 0));
}

#[test]
fn load_is_none_before_the_replica_is_saved() {
    let dir = temp();
    let file = create_file(dir.path());
    assert!(ok(store::load(file.conn(), schema(), actor(1))).is_none());
}

/// Builds a 10k-record replica, appends 100 small changes one at a time, then compacts; prints
/// how long each phase of storage takes. Run with
/// `cargo test -p kition-kitable --test kdm_store -- --ignored large_replica_timings`.
#[test]
#[ignore = "prints timings; not a correctness check"]
fn large_replica_timings() {
    let dir = temp();
    let file = create_file(dir.path());
    let conn = file.conn();
    let (mut replica, base) = seed_replica(schema(), actor(1), 10_000);

    let save_start = Instant::now();
    with_tx(conn, |tx| store::save_initial(tx, &replica, 0));
    println!("save_initial (10k records): {:?}", save_start.elapsed());

    let append_start = Instant::now();
    for index in 0..100 {
        let since = replica.version();
        add_record(&mut replica, &base, &format!("extra-{index}"));
        with_tx(conn, |tx| store::append(tx, &replica, &since, "test", 0));
    }
    println!("100 appends: {:?}", append_start.elapsed());

    let load_start = Instant::now();
    let loaded =
        ok(store::load(conn, schema(), actor(2))).unwrap_or_else(|| panic!("expected a replica"));
    println!("load (10k + 100 records): {:?}", load_start.elapsed());
    assert_eq!(kok(loaded.state_hash()), kok(replica.state_hash()));

    let compact_start = Instant::now();
    with_tx(conn, |tx| store::compact(tx, &replica, 0));
    println!("compact: {:?}", compact_start.elapsed());
}
