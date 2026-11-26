// Copied from kition-sdk crates/kition-kdm/tests/schema_version.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The document's minimum schema version (rule M20): raises, merges, and the refusals of readers
//! with an older schema. The TypeScript twin is `packages/kdm/test/schema-version.test.ts`.

use std::sync::Arc;

use kition_kdm::{ActorId, DocId, KdmError, Origin, Replica, Schema};
use serde_json::{Value, json};

mod common;
use common::{page_with_shape, person};

/// The test schema at `version`.
fn schema_at(version: u32) -> Arc<Schema> {
    let mut json: Value = serde_json::from_str(include_str!("fixtures/test-schema.json")).unwrap();
    json["schemaVersion"] = json!(version);
    Arc::new(Schema::parse(&json.to_string()).unwrap())
}

fn actor(id: u64) -> ActorId {
    ActorId::from_u64(id).unwrap()
}

fn migration() -> Origin {
    Origin::system("migrate")
}

/// Raises `replica` to `version` in a `system` transaction; answers whether it rose.
fn raise(replica: &mut Replica, version: u32) -> bool {
    replica.transact(&migration(), |tx| tx.raise_schema_version(version)).unwrap()
}

/// The `schemaVersion` a snapshot's bytes hold.
fn stored_register(snapshot: &[u8]) -> Value {
    serde_json::from_slice::<Value>(snapshot).unwrap().get("schemaVersion").cloned().unwrap_or(Value::Null)
}

#[test]
fn a_replica_created_at_a_version_stores_it_as_its_minimum() {
    let replica = Replica::create(schema_at(2), DocId::new(), actor(1)).unwrap();
    assert_eq!(replica.min_schema_version(), 2);
    assert_eq!(replica.state_json().unwrap()["meta"]["schemaVersion"], json!(2));
}

#[test]
fn a_raise_records_the_minimum_as_replicated_data() {
    let old = Replica::create(schema_at(1), DocId::new(), actor(1)).unwrap();
    let mut new = Replica::load(schema_at(2), &old.snapshot().unwrap(), actor(2)).unwrap();
    assert_eq!(new.min_schema_version(), 1);
    assert!(raise(&mut new, 2));
    assert_eq!(new.min_schema_version(), 2);
    assert_eq!(new.state_json().unwrap()["meta"]["schemaVersion"], json!(2));
    let snapshot = new.snapshot().unwrap();
    assert_eq!(stored_register(&snapshot), json!(2));
    let loaded = Replica::load(schema_at(2), &snapshot, actor(3)).unwrap();
    assert_eq!(loaded.min_schema_version(), 2);
    assert_eq!(loaded.state_json().unwrap(), new.state_json().unwrap());
}

#[test]
fn a_raise_to_the_current_or_a_lower_version_changes_nothing() {
    let mut replica = Replica::create(schema_at(3), DocId::new(), actor(1)).unwrap();
    let before = (replica.version(), replica.state_json().unwrap());
    assert!(!raise(&mut replica, 3));
    assert!(!raise(&mut replica, 2));
    assert_eq!((replica.version(), replica.state_json().unwrap()), before);
    let old = Replica::create(schema_at(1), DocId::new(), actor(2)).unwrap();
    let mut new = Replica::load(schema_at(3), &old.snapshot().unwrap(), actor(3)).unwrap();
    let raised = new
        .transact(&migration(), |tx| {
            let first = tx.raise_schema_version(3)?;
            let again = tx.raise_schema_version(2)?;
            assert_eq!(tx.min_schema_version(), 3);
            Ok((first, again))
        })
        .unwrap();
    assert_eq!(raised, (true, false));
    let version = new.version();
    assert!(!raise(&mut new, 2));
    assert_eq!(new.version(), version);
    assert_eq!(new.min_schema_version(), 3);
}

#[test]
fn only_a_system_transaction_raises_and_never_above_its_schema() {
    let old = Replica::create(schema_at(1), DocId::new(), actor(1)).unwrap();
    let mut new = Replica::load(schema_at(2), &old.snapshot().unwrap(), actor(2)).unwrap();
    let version = new.version();
    let error = new.transact(&person(), |tx| tx.raise_schema_version(2)).unwrap_err();
    assert!(matches!(&error, KdmError::InvalidValue { field, .. } if field == "schemaVersion"), "{error:?}");
    let error = new.transact(&migration(), |tx| tx.raise_schema_version(3)).unwrap_err();
    assert!(matches!(&error, KdmError::InvalidValue { field, .. } if field == "schemaVersion"), "{error:?}");
    assert_eq!(new.version(), version);
    assert_eq!(new.min_schema_version(), 1);
}

#[test]
fn a_raise_is_not_an_undo_step() {
    let old = Replica::create(schema_at(1), DocId::new(), actor(1)).unwrap();
    let mut new = Replica::load(schema_at(2), &old.snapshot().unwrap(), actor(2)).unwrap();
    let (_, shape) = page_with_shape(&mut new);
    assert!(raise(&mut new, 2));
    new.transact(&person(), |tx| tx.set(&shape, "x", json!(5))).unwrap();
    assert!(new.undo().unwrap().is_done());
    assert!(new.undo().unwrap().is_done());
    assert!(!new.can_undo());
    assert_eq!(new.min_schema_version(), 2);
}

#[test]
fn an_older_reader_refuses_to_load_a_migrated_document() {
    let old = Replica::create(schema_at(1), DocId::new(), actor(1)).unwrap();
    let mut new = Replica::load(schema_at(2), &old.snapshot().unwrap(), actor(2)).unwrap();
    // A replica written under schema 2 but not migrated still opens in a version 1 reader.
    page_with_shape(&mut new);
    assert!(Replica::load(schema_at(1), &new.snapshot().unwrap(), actor(3)).is_ok());
    assert!(raise(&mut new, 2));
    let error = Replica::load(schema_at(1), &new.snapshot().unwrap(), actor(3)).err().unwrap();
    assert_eq!(error, KdmError::NewerSchema { found: 2, reads: 1 });
    assert!(error.to_string().contains("schema version 2"), "{error}");
    assert!(Replica::load(schema_at(2), &new.snapshot().unwrap(), actor(3)).is_ok());
}

#[test]
fn a_refused_import_leaves_the_replica_unchanged() {
    let mut old = Replica::create(schema_at(1), DocId::new(), actor(1)).unwrap();
    let (start, empty) = (old.version(), old.snapshot().unwrap());
    let (page, _) = page_with_shape(&mut old);
    let mut new = Replica::load(schema_at(2), &old.snapshot().unwrap(), actor(2)).unwrap();
    let base = new.version();
    // The migration: the rewrite and the raise in one system transaction.
    new.transact(&migration(), |tx| {
        tx.set(&page, "title", json!("Migrated"))?;
        tx.raise_schema_version(2).map(drop)
    })
    .unwrap();
    old.take_changed();
    let before = (old.version(), old.state_json().unwrap(), old.snapshot().unwrap());
    let exported = old.export_changes(&start).unwrap();
    let error = old.import_changes(&new.export_changes(&base).unwrap()).unwrap_err();
    assert_eq!(error, KdmError::NewerSchema { found: 2, reads: 1 });
    assert_eq!(old.version(), before.0);
    assert_eq!(old.state_json().unwrap(), before.1);
    assert_eq!(old.min_schema_version(), 1);
    assert!(old.take_changed().is_empty());
    // Its snapshot is the one before: a fresh replica loads it to the same state.
    assert_eq!(old.snapshot().unwrap(), before.2);
    let copy = Replica::load(schema_at(1), &before.2, actor(4)).unwrap();
    assert_eq!(copy.state_json().unwrap(), before.1);
    // Its changes are exactly the ones before: the replica they follow takes them to the same state.
    assert_eq!(old.export_changes(&start).unwrap(), exported);
    let mut copy = Replica::load(schema_at(1), &empty, actor(5)).unwrap();
    copy.import_changes(&exported).unwrap();
    assert_eq!(copy.state_json().unwrap(), before.1);
    // The replica keeps working.
    old.transact(&person(), |tx| tx.set(&page, "title", json!("Later"))).unwrap();
    assert_eq!(old.get(&page, "title").unwrap(), json!("Later"));
}

/// The canonical state of a migrated document, as the TypeScript test expects it too.
#[test]
fn the_canonical_state_shows_the_minimum_as_meta_schema_version() {
    let doc_id = DocId::parse("01920000-0000-7000-8000-0000000000bb").unwrap();
    let old = Replica::create(schema_at(1), doc_id, actor(1)).unwrap();
    let mut a = Replica::load(schema_at(3), &old.snapshot().unwrap(), actor(2)).unwrap();
    let mut b = Replica::load(schema_at(3), &old.snapshot().unwrap(), actor(3)).unwrap();
    let base = a.version();
    raise(&mut a, 2);
    raise(&mut a, 3);
    b.import_changes(&a.export_changes(&base).unwrap()).unwrap();
    for replica in [&a, &b] {
        assert_eq!(
            replica.state_json().unwrap().to_string(),
            r#"{"meta":{"docId":"01920000-0000-7000-8000-0000000000bb","kdm":1,"kit":"kit.test","schemaVersion":3},"objects":{}}"#
        );
    }
    // The later raise keeps the largest: raising again to it or below changes nothing.
    assert_eq!(b.min_schema_version(), 3);
    assert!(!raise(&mut b, 3));
    assert!(!raise(&mut b, 2));
}

// Each change's author schema version (rule M5a).

#[test]
fn every_commit_records_its_authors_schema_version_and_the_newest_is_read_back() {
    let mut old = Replica::create(schema_at(1), DocId::new(), actor(1)).unwrap();
    assert_eq!(old.author_schema_version(), Some(1));
    let (page, _) = page_with_shape(&mut old);
    let mut newer = Replica::load(schema_at(3), &old.snapshot().unwrap(), actor(2)).unwrap();
    // Loading changes nothing: only a newer replica's own commits record its version.
    assert_eq!(newer.author_schema_version(), Some(1));
    let base = old.version();
    newer.transact(&person(), |tx| tx.set(&page, "title", json!("Edited with a newer kit"))).unwrap();
    assert_eq!(newer.author_schema_version(), Some(3));
    // The older reader takes the change (nothing migrated), and can tell it was written under schema 3.
    old.import_changes(&newer.export_changes(&base).unwrap()).unwrap();
    assert_eq!(old.get(&page, "title").unwrap(), json!("Edited with a newer kit"));
    assert_eq!(old.author_schema_version(), Some(3));
    assert_eq!(old.min_schema_version(), 1);
    let loaded = Replica::load(schema_at(1), &old.snapshot().unwrap(), actor(4)).unwrap();
    assert_eq!(loaded.author_schema_version(), Some(3));
}

#[test]
fn the_commit_message_is_kind_principal_label_and_schema_version_which_older_readers_decode() {
    let mut replica = Replica::create(schema_at(2), DocId::new(), actor(1)).unwrap();
    let base = replica.version();
    page_with_shape(&mut replica);
    let changes: Value = serde_json::from_slice(&replica.export_changes(&base).unwrap()).unwrap();
    let messages: Vec<String> = changes["changes"].as_array().unwrap().iter().map(|change| change["origin"].to_string()).collect();
    assert!(messages.contains(&r#"["person","user:test",null,2]"#.to_owned()), "{messages:?}");
    for message in &messages {
        assert!(Origin::decode(message).is_some(), "{message}");
    }
    assert_eq!(Origin::decode_commit(r#"["person","user:test",null,2]"#), Some((person(), Some(2))));
    assert_eq!(Origin::decode_commit(r#"["person","user:test",null]"#), Some((person(), None)));
    assert_eq!(Origin::decode_commit(r#"["person","user:test",null,"2"]"#), Some((person(), None)));
    assert_eq!(Origin::decode_commit("not json"), None);
    assert_eq!(Origin::system("migrate").encode_commit(4), r#"["system","kdm","migrate",4]"#);
}
