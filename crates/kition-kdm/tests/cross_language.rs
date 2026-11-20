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

/// The committed `fixtures/ts-page.bin` copied as a new document by the TypeScript KDM
/// (`fixtures/ts-new-document.*`, written by
/// `KDM_WRITE_NEW_DOCUMENT_FIXTURE=1 pnpm vitest run packages/kdm/test/write-ts-fixture.test.ts`)
/// opens here as the new document with the source's objects, and the two refuse each other.
#[test]
fn a_typescript_copy_as_a_new_document_opens_with_the_new_id_and_the_same_content() {
    let mut copy = Replica::load(schema(), include_bytes!("fixtures/ts-new-document.bin"), ActorId::from_u64(15).unwrap()).unwrap();
    let mut source = Replica::load(schema(), include_bytes!("fixtures/ts-page.bin"), ActorId::from_u64(16).unwrap()).unwrap();
    assert_eq!(copy.doc_id(), DocId::parse("01920000-0000-7000-8000-0000000000ab").unwrap());
    assert!(copy.is_shallow());
    let state = copy.state_json().unwrap().to_string();
    assert_eq!(
        copy.state_hash().unwrap(),
        include_str!("fixtures/ts-new-document.sha256"),
        "canonical state differs from fixtures/ts-new-document.json:\n{state}"
    );
    assert_eq!(copy.state_json().unwrap()["objects"], source.state_json().unwrap()["objects"]);
    assert!(matches!(copy.rebase(include_bytes!("fixtures/ts-page.bin")), Err(kition_kdm::KdmError::WrongDocument { .. })));
    let changes = copy.export_changes(&source.version()).unwrap();
    assert!(matches!(source.import_changes(&changes), Err(kition_kdm::KdmError::WrongDocument { .. })));
}

/// regressions/issue-kdm-shallow-export: a shallow replica's export of every change, made by the
/// TypeScript KDM (`fixtures/ts-shallow-export.*`: the committed `ts-new-document.bin` with its
/// page retitled, `exportChanges(Version.empty())`, written by
/// `KDM_WRITE_SHALLOW_EXPORT_FIXTURE=1 pnpm vitest run packages/kdm/test/write-ts-fixture.test.ts`),
/// loads here as the forked document with its edit, as a shallow replica.
#[test]
fn a_typescript_shallow_export_of_every_change_loads_as_the_document() {
    let exported = Replica::load(schema(), include_bytes!("fixtures/ts-shallow-export.bin"), ActorId::from_u64(17).unwrap()).unwrap();
    let copy = Replica::load(schema(), include_bytes!("fixtures/ts-new-document.bin"), ActorId::from_u64(18).unwrap()).unwrap();
    assert_eq!(exported.doc_id(), DocId::parse("01920000-0000-7000-8000-0000000000ab").unwrap());
    assert!(exported.is_shallow());
    assert_eq!(exported.shallow_root(), copy.shallow_root());
    let state = exported.state_json().unwrap().to_string();
    assert_eq!(
        exported.state_hash().unwrap(),
        include_str!("fixtures/ts-shallow-export.sha256"),
        "canonical state differs from fixtures/ts-shallow-export.json:\n{state}"
    );
    let page = exported.objects_of_type("Page").into_iter().next().unwrap();
    assert_eq!(exported.get(&page, "title").unwrap(), serde_json::json!("Forked page"));
    // Exported again from here, every change still loads.
    let again = Replica::load(schema(), &exported.export_changes(&kition_kdm::Version::empty()).unwrap(), ActorId::from_u64(19).unwrap()).unwrap();
    assert_eq!(again.state_hash().unwrap(), exported.state_hash().unwrap());
}

/// A copy made by the TypeScript KDM and retitled (`fixtures/ts-birth*.bin`, written by
/// `KDM_WRITE_BIRTH_FIXTURE=1 pnpm vitest run packages/kdm/test/write-ts-fixture.test.ts`) carries
/// the whole history here as its snapshot (rooted at its birth), and not as a shallow snapshot at
/// its last version: both implementations read the same birth (sync protocol S20).
#[test]
fn a_typescript_copy_carries_its_whole_history_and_its_truncation_does_not() {
    let born = Replica::load(schema(), include_bytes!("fixtures/ts-birth.bin"), ActorId::from_u64(20).unwrap()).unwrap();
    let truncated = Replica::load(schema(), include_bytes!("fixtures/ts-birth-truncated.bin"), ActorId::from_u64(21).unwrap()).unwrap();
    for replica in [&born, &truncated] {
        assert_eq!(replica.doc_id(), DocId::parse("01920000-0000-7000-8000-0000000000ac").unwrap());
        assert!(replica.is_shallow());
        let page = replica.objects_of_type("Page").into_iter().next().unwrap();
        assert_eq!(replica.get(&page, "title").unwrap(), serde_json::json!("Born page"));
    }
    assert!(born.carries_whole_history());
    assert!(!truncated.carries_whole_history());
    // A replica loaded from the copy and copied again here is born again.
    assert!(born.copy_as_new_document(DocId::new(), ActorId::from_u64(22).unwrap()).unwrap().carries_whole_history());
}
