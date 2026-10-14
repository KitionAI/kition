// Copied from kition-sdk crates/kition-kdm/tests/cross_language.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Documents made by the TypeScript KDM (`packages/kdm`) open in this crate to the same canonical
//! state. `fixtures/ts-page.{bin,json}` are written by
//! `KDM_WRITE_FIXTURE=1 pnpm vitest run packages/kdm/test/write-ts-fixture.test.ts`; never
//! regenerate them to make this test pass.

use kition_kdm::{ActorId, DocId, Replica};

mod common;
use common::{person, schema};

#[test]
fn a_typescript_document_opens_to_the_identical_canonical_state() {
    let replica = Replica::load(schema(), include_bytes!("fixtures/ts-page.bin"), ActorId::from_u64(9).unwrap()).unwrap();
    assert_eq!(replica.doc_id(), DocId::parse("01920000-0000-7000-8000-0000000000aa").unwrap());
    assert_eq!(replica.state_json().unwrap().to_string(), include_str!("fixtures/ts-page.json"));
}

#[test]
fn a_typescript_document_keeps_converging_when_edited_from_rust() {
    let mut a = Replica::load(schema(), include_bytes!("fixtures/ts-page.bin"), ActorId::from_u64(10).unwrap()).unwrap();
    let mut b = Replica::load(schema(), include_bytes!("fixtures/ts-page.bin"), ActorId::from_u64(11).unwrap()).unwrap();
    let shape = a.objects_of_type("Shape").into_iter().next().unwrap();
    a.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "RS:")).unwrap();
    b.transact(&person(), |tx| tx.set(&shape, "x", serde_json::json!(1.25))).unwrap();
    let bytes = b.export_changes(&a.version()).unwrap();
    a.import_changes(&bytes).unwrap();
    let bytes = a.export_changes(&b.version()).unwrap();
    b.import_changes(&bytes).unwrap();
    assert_eq!(a.state_hash().unwrap(), b.state_hash().unwrap());
    assert!(a.text(&shape, "label").unwrap().starts_with("RS:"));
}
