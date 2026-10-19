// Copied from kition-sdk crates/kition-kdm/tests/schema_version.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The document's minimum schema version (rule M20): raises, merges, and the refusals of readers
//! with an older schema. The TypeScript twin is `packages/kdm/test/schema-version.test.ts`.

use std::sync::Arc;

use kition_kdm::{ActorId, DocId, KdmError, Origin, Replica, Schema};
use serde_json::{Value, json};

mod common;
use common::{fields, page_with_shape, person};

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

/// The `meta.schemaVersion` register as builds before rule M20 read it: straight from the engine.
fn stored_register(snapshot: &[u8]) -> Value {
    let doc = loro::LoroDoc::new();
    doc.import(&snapshot[20..]).unwrap();
    match doc.get_map("meta").get("schemaVersion") {
        Some(loro::ValueOrContainer::Value(value)) => loro::ToJson::to_json_value(&value),
        _ => Value::Null,
    }
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
fn concurrent_raises_keep_the_largest() {
    for (high_actor, low_actor) in [(2, 3), (3, 2)] {
        let old = Replica::create(schema_at(1), DocId::new(), actor(1)).unwrap();
        let mut high = Replica::load(schema_at(3), &old.snapshot().unwrap(), actor(high_actor)).unwrap();
        let mut low = Replica::load(schema_at(3), &old.snapshot().unwrap(), actor(low_actor)).unwrap();
        let base = high.version();
        assert!(raise(&mut high, 3));
        assert!(raise(&mut low, 2));
        let from_high = high.export_changes(&base).unwrap();
        let from_low = low.export_changes(&base).unwrap();
        high.import_changes(&from_low).unwrap();
        low.import_changes(&from_high).unwrap();
        assert_eq!(high.min_schema_version(), 3);
        assert_eq!(low.min_schema_version(), 3);
        assert_eq!(high.state_json().unwrap(), low.state_json().unwrap());
        assert_eq!(high.state_json().unwrap()["meta"]["schemaVersion"], json!(3));
        assert!(!raise(&mut low, 3));
    }
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
    assert!(new.undo().unwrap());
    assert!(new.undo().unwrap());
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
    let (page, _) = page_with_shape(&mut old);
    let mut new = Replica::load(schema_at(2), &old.snapshot().unwrap(), actor(2)).unwrap();
    let base = new.version();
    // The migration: the rewrite and the raise in one system transaction.
    new.transact(&migration(), |tx| {
        tx.set(&page, "title", json!("Migrated"))?;
        tx.raise_schema_version(2).map(drop)
    })
    .unwrap();
    old.transact(&person(), |tx| tx.create("Page", fields(json!({ "title": "Local" })))).unwrap();
    old.take_changed();
    let before = (old.version(), old.state_json().unwrap(), old.export_changes(&kition_kdm::Version::empty()).unwrap());
    let error = old.import_changes(&new.export_changes(&base).unwrap()).unwrap_err();
    assert_eq!(error, KdmError::NewerSchema { found: 2, reads: 1 });
    assert_eq!(old.version(), before.0);
    assert_eq!(old.state_json().unwrap(), before.1);
    assert_eq!(old.min_schema_version(), 1);
    assert!(old.take_changed().is_empty());
    assert!(!old.has_pending_changes());
    // The exports still hold exactly the old changes: a fresh replica loads them to the same state.
    let mut copy = Replica::load(schema_at(1), &old.snapshot().unwrap(), actor(4)).unwrap();
    copy.import_changes(&before.2).unwrap();
    assert_eq!(copy.state_json().unwrap(), before.1);
    // The replica keeps working, and a reader of the new schema takes its changes.
    let since = old.version();
    old.transact(&person(), |tx| tx.set(&page, "title", json!("Later"))).unwrap();
    assert_eq!(old.get(&page, "title").unwrap(), json!("Later"));
    new.import_changes(&old.export_changes(&base).unwrap()).unwrap();
    assert_eq!(new.min_schema_version(), 2);
    assert!(new.version().includes(&since));
}

#[test]
fn a_refused_import_keeps_the_changes_still_pending() {
    let mut old = Replica::create(schema_at(1), DocId::new(), actor(1)).unwrap();
    page_with_shape(&mut old);
    let mut other = Replica::load(schema_at(1), &old.snapshot().unwrap(), actor(2)).unwrap();
    let mut new = Replica::load(schema_at(2), &old.snapshot().unwrap(), actor(3)).unwrap();
    let base = other.version();
    other.transact(&person(), |tx| tx.create("Page", fields(json!({ "title": "first" })))).unwrap();
    let middle = other.version();
    other.transact(&person(), |tx| tx.create("Page", fields(json!({ "title": "second" })))).unwrap();
    old.import_changes(&other.export_changes(&middle).unwrap()).unwrap();
    assert!(old.has_pending_changes());
    assert!(raise(&mut new, 2));
    assert!(old.import_changes(&new.export_changes(&base).unwrap()).is_err());
    assert!(old.has_pending_changes());
    // The pending change is missing again; a sync from the version fetches it.
    old.import_changes(&other.export_changes(&old.version()).unwrap()).unwrap();
    assert!(!old.has_pending_changes());
    assert_eq!(old.state_json().unwrap(), other.state_json().unwrap());
}

/// The canonical state of a migrated document, as the TypeScript test expects it too.
#[test]
fn the_canonical_state_shows_the_minimum_as_meta_schema_version() {
    let doc_id = DocId::parse("01920000-0000-7000-8000-0000000000bb").unwrap();
    let old = Replica::create(schema_at(1), doc_id, actor(1)).unwrap();
    let mut a = Replica::load(schema_at(3), &old.snapshot().unwrap(), actor(2)).unwrap();
    let mut b = Replica::load(schema_at(3), &old.snapshot().unwrap(), actor(3)).unwrap();
    let base = a.version();
    raise(&mut a, 3);
    raise(&mut b, 2);
    a.import_changes(&b.export_changes(&base).unwrap()).unwrap();
    assert_eq!(
        a.state_json().unwrap().to_string(),
        r#"{"meta":{"docId":"01920000-0000-7000-8000-0000000000bb","kdm":1,"kit":"kit.test","schemaVersion":3},"objects":{}}"#
    );
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
    page_with_shape(&mut replica);
    let doc = loro::LoroDoc::new();
    doc.import(&replica.snapshot().unwrap()[20..]).unwrap();
    let mut messages = Vec::new();
    for (peer, end) in doc.oplog_vv().iter() {
        let mut counter = 0;
        while counter < *end {
            let change = doc.get_change(loro::ID::new(*peer, counter)).unwrap();
            messages.push(change.message.as_deref().unwrap_or_default().to_owned());
            counter = change.id.counter + i32::try_from(change.len).unwrap();
        }
    }
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
