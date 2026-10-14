// Copied from kition-sdk crates/kition-kdm/tests/common.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
#![allow(dead_code)]

use std::sync::Arc;

use kition_kdm::{ObjectId, Origin, Replica, Schema};
use serde_json::{Map, Value, json};

pub fn schema() -> Arc<Schema> {
    Arc::new(Schema::parse(include_str!("fixtures/test-schema.json")).expect("test schema parses"))
}

pub fn person() -> Origin {
    Origin::person("user:test")
}

pub fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// Creates a page and one shape in it; answers `(page, shape)`.
pub fn page_with_shape(replica: &mut Replica) -> (ObjectId, ObjectId) {
    replica
        .transact(&person(), |tx| {
            let page = tx.create("Page", fields(json!({ "title": "One" })))?;
            let shape = tx.create("Shape", fields(json!({ "kind": "rect", "x": 10, "y": 20 })))?;
            tx.list_insert(&page, "shapes", 0, &shape)?;
            Ok((page, shape))
        })
        .expect("page and shape")
}

/// Wraps engine bytes the way the KDM exports them: magic, document UUID, engine bytes.
pub fn envelope(doc: &kition_kdm::DocId, bytes: &[u8]) -> Vec<u8> {
    let uuid = uuid::Uuid::parse_str(&doc.to_string()).expect("doc ids are UUIDs");
    [b"KDM\x01".as_slice(), uuid.as_bytes(), bytes].concat()
}

/// The test schema's next version: a new `Note` type and a new `caption` text on `Shape`.
pub fn schema_v2() -> Arc<Schema> {
    let mut json: Value = serde_json::from_str(include_str!("fixtures/test-schema.json")).expect("test schema is JSON");
    json["schemaVersion"] = json!(2);
    json["types"]["Shape"]["fields"]["caption"] = json!({ "kind": "text" });
    json["types"]["Note"] = json!({ "fields": { "body": { "kind": "string" } } });
    Arc::new(Schema::parse(&json.to_string()).expect("v2 schema parses"))
}

/// A snapshot of an empty `kit.test` document written directly with the engine, with the given
/// `meta.kdm` and `meta.schemaVersion`.
pub fn raw_snapshot(kdm: i64, schema_version: i64) -> Vec<u8> {
    let doc = loro::LoroDoc::new();
    let meta = doc.get_map("meta");
    let doc_id = kition_kdm::DocId::new();
    meta.insert("docId", doc_id.to_string()).expect("meta");
    meta.insert("kit", "kit.test").expect("meta");
    meta.insert("schemaVersion", schema_version).expect("meta");
    meta.insert("kdm", kdm).expect("meta");
    doc.commit();
    envelope(&doc_id, &doc.export(loro::ExportMode::Snapshot).expect("snapshot"))
}
