// Copied from kition-sdk crates/kition-kdm/tests/cross_language.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Documents made by the TypeScript KDM (`packages/kdm`) open in this crate to the same canonical
//! state. `fixtures/ts-page.{bin,json,sha256}` are written by
//! `KDM_WRITE_FIXTURE=1 pnpm vitest run packages/kdm/test/write-ts-fixture.test.ts`; never
//! regenerate them to make this test pass. This test compares the state's SHA-256
//! (`ts-page.sha256`) rather than its JSON (`ts-page.json`, compared by the TypeScript suite), so
//! hosts that carry this crate without the non-ASCII fixture text run it too.

use kition_kdm::{ActorId, DocId, Replica};

mod common;
use common::{person, schema};

#[test]
fn a_typescript_document_opens_to_the_identical_canonical_state() {
    let replica = Replica::load(schema(), include_bytes!("fixtures/ts-page.bin"), ActorId::from_u64(9).unwrap()).unwrap();
    assert_eq!(replica.doc_id(), DocId::parse("01920000-0000-7000-8000-0000000000aa").unwrap());
    let state = replica.state_json().unwrap().to_string();
    assert_eq!(replica.state_hash().unwrap(), include_str!("fixtures/ts-page.sha256"), "canonical state differs from fixtures/ts-page.json:\n{state}");
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

/// A shallow snapshot made by the TypeScript KDM (`fixtures/ts-shallow.*`, written by
/// `KDM_WRITE_SHALLOW_FIXTURE=1 pnpm vitest run packages/kdm/test/write-ts-fixture.test.ts`) opens
/// here as a shallow replica with the identical canonical state, and keeps converging when edited
/// from Rust.
#[test]
fn a_typescript_shallow_snapshot_opens_to_the_identical_canonical_state() {
    let mut shallow = Replica::load(schema(), include_bytes!("fixtures/ts-shallow.bin"), ActorId::from_u64(12).unwrap()).unwrap();
    assert!(shallow.is_shallow());
    let state = shallow.state_json().unwrap().to_string();
    assert_eq!(shallow.state_hash().unwrap(), include_str!("fixtures/ts-shallow.sha256"), "canonical state differs from fixtures/ts-shallow.json:\n{state}");
    let shape = shallow.objects_of_type("Shape").into_iter().next().unwrap();
    shallow.transact(&person(), |tx| tx.text_insert(&shape, "label", 0, "RS:")).unwrap();
    let mut other = Replica::load(schema(), include_bytes!("fixtures/ts-shallow.bin"), ActorId::from_u64(14).unwrap()).unwrap();
    other.transact(&person(), |tx| tx.set(&shape, "x", serde_json::json!(7))).unwrap();
    let to_other = shallow.export_changes(&other.version()).unwrap();
    other.import_changes(&to_other).unwrap();
    let to_shallow = other.export_changes(&shallow.version()).unwrap();
    shallow.import_changes(&to_shallow).unwrap();
    assert_eq!(shallow.state_hash().unwrap(), other.state_hash().unwrap());
    assert!(other.text(&shape, "label").unwrap().starts_with("RS:"));
}
