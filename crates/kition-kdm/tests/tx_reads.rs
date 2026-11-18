// Copied from kition-sdk crates/kition-kdm/tests/tx_reads.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Reads of map fields and of the objects of a type, on `Replica` and inside a transaction.

use kition_kdm::{ActorId, DocId, KdmError, ObjectId, Replica};
use serde_json::{Value, json};

mod common;
use common::{fields, page_with_shape, person, schema};

fn replica() -> Replica {
    Replica::create(schema(), DocId::new(), ActorId::from_u64(1).unwrap()).unwrap()
}

fn entries(pairs: &[(&str, Value)]) -> Vec<(String, Value)> {
    pairs.iter().map(|(key, value)| ((*key).to_owned(), value.clone())).collect()
}

/// A sheet whose `cells` hold `a: 1`, `b: {"v": 2.0}`, `c: "x"`.
fn sheet(replica: &mut Replica) -> ObjectId {
    replica
        .transact(&person(), |tx| {
            let sheet = tx.create("Sheet", fields(json!({})))?;
            tx.map_set(&sheet, "cells", "b", json!({ "v": 2.0 }))?;
            tx.map_set(&sheet, "cells", "a", json!(1))?;
            tx.map_set(&sheet, "cells", "c", json!("x"))?;
            Ok(sheet)
        })
        .unwrap()
}

#[test]
fn replica_lists_map_entries_sorted_by_key_in_canonical_form() {
    let mut replica = replica();
    let sheet = sheet(&mut replica);
    assert_eq!(replica.map_entries(&sheet, "cells").unwrap(), entries(&[("a", json!(1)), ("b", json!({ "v": 2 })), ("c", json!("x"))]));
    replica
        .transact(&person(), |tx| {
            tx.map_set(&sheet, "cells", "😀", json!(true))?;
            tx.map_set(&sheet, "cells", "\u{ffff}", json!(null))?;
            tx.map_delete(&sheet, "cells", "a")
        })
        .unwrap();
    let keys: Vec<String> = replica.map_entries(&sheet, "cells").unwrap().into_iter().map(|(key, _)| key).collect();
    assert_eq!(keys, ["b", "c", "\u{ffff}", "😀"], "code point order, as the canonical state");
}

#[test]
fn tx_reads_committed_and_pending_map_keys() {
    let mut replica = replica();
    let sheet = sheet(&mut replica);
    replica
        .transact(&person(), |tx| {
            assert_eq!(tx.map_get(&sheet, "cells", "a")?, json!(1));
            assert_eq!(tx.map_get(&sheet, "cells", "b")?, json!({ "v": 2 }));
            assert_eq!(tx.map_get(&sheet, "cells", "missing")?, Value::Null);
            tx.map_set(&sheet, "cells", "a", json!({ "w": 3.0, "f": "=1" }))?;
            assert_eq!(tx.map_get(&sheet, "cells", "a")?, json!({ "f": "=1", "w": 3 }));
            tx.map_set(&sheet, "cells", "d", json!([1.0, 2.5]))?;
            assert_eq!(tx.map_get(&sheet, "cells", "d")?, json!([1, 2.5]));
            tx.map_delete(&sheet, "cells", "b")?;
            assert_eq!(tx.map_get(&sheet, "cells", "b")?, Value::Null);
            tx.map_delete(&sheet, "cells", "d")?;
            assert_eq!(tx.map_get(&sheet, "cells", "d")?, Value::Null);
            tx.map_set(&sheet, "cells", "b", json!("back"))?;
            assert_eq!(tx.map_get(&sheet, "cells", "b")?, json!("back"));
            assert_eq!(tx.map_entries(&sheet, "cells")?, entries(&[("a", json!({ "f": "=1", "w": 3 })), ("b", json!("back")), ("c", json!("x"))]));
            Ok(())
        })
        .unwrap();
    assert_eq!(replica.map_entries(&sheet, "cells").unwrap(), entries(&[("a", json!({ "f": "=1", "w": 3 })), ("b", json!("back")), ("c", json!("x"))]));
}

#[test]
fn tx_map_entries_merge_committed_and_pending_writes() {
    let mut replica = replica();
    let sheet = sheet(&mut replica);
    replica
        .transact(&person(), |tx| {
            assert_eq!(tx.map_entries(&sheet, "cells")?, entries(&[("a", json!(1)), ("b", json!({ "v": 2 })), ("c", json!("x"))]));
            tx.map_set(&sheet, "cells", "0", json!(0))?;
            tx.map_set(&sheet, "cells", "b", json!(20))?;
            tx.map_delete(&sheet, "cells", "c")?;
            tx.map_delete(&sheet, "cells", "never")?;
            tx.map_set(&sheet, "cells", "z", json!(null))?;
            assert_eq!(tx.map_entries(&sheet, "cells")?, entries(&[("0", json!(0)), ("a", json!(1)), ("b", json!(20)), ("z", json!(null))]));
            Ok(())
        })
        .unwrap();
    assert_eq!(replica.map_entries(&sheet, "cells").unwrap(), entries(&[("0", json!(0)), ("a", json!(1)), ("b", json!(20)), ("z", json!(null))]));
}

#[test]
fn tx_reads_the_map_of_an_object_it_created() {
    let mut replica = replica();
    replica
        .transact(&person(), |tx| {
            let sheet = tx.create("Sheet", fields(json!({})))?;
            assert_eq!(tx.map_get(&sheet, "cells", "a")?, Value::Null);
            assert!(tx.map_entries(&sheet, "cells")?.is_empty());
            tx.map_set(&sheet, "cells", "a", json!(1))?;
            tx.map_set(&sheet, "cells", "b", json!(2))?;
            tx.map_delete(&sheet, "cells", "a")?;
            assert_eq!(tx.map_get(&sheet, "cells", "b")?, json!(2));
            assert_eq!(tx.map_entries(&sheet, "cells")?, entries(&[("b", json!(2))]));
            tx.delete(&sheet)?;
            assert!(matches!(tx.map_get(&sheet, "cells", "b"), Err(KdmError::NotFound(_))));
            assert!(matches!(tx.map_entries(&sheet, "cells"), Err(KdmError::NotFound(_))));
            Ok(())
        })
        .unwrap();
}

#[test]
fn map_reads_of_a_deleted_object_or_the_wrong_field_fail_as_other_accessors_do() {
    let mut replica = replica();
    let sheet = sheet(&mut replica);
    let (page, shape) = page_with_shape(&mut replica);
    let unknown = ObjectId::from_string("nope".to_owned());
    // On the replica: the same errors as `map_get`; in a transaction, the same again.
    let cases = [(&page, "shapes"), (&shape, "x"), (&shape, "label"), (&sheet, "nope")];
    let expected: Vec<KdmError> = cases.iter().map(|(id, field)| replica.map_get(id, field, "k").unwrap_err()).collect();
    assert!(matches!(&expected[0], KdmError::InvalidValue { reason, .. } if reason == "is not a map field"), "{:?}", expected[0]);
    assert!(matches!(&expected[3], KdmError::UnknownField { .. }), "{:?}", expected[3]);
    for ((id, field), expected) in cases.iter().zip(&expected) {
        assert_eq!(&replica.map_entries(id, field).unwrap_err(), expected);
    }
    assert!(matches!(replica.map_entries(&unknown, "cells"), Err(KdmError::NotFound(_))));
    replica
        .transact(&person(), |tx| {
            for ((id, field), expected) in cases.iter().zip(&expected) {
                assert_eq!(&tx.map_get(id, field, "k").unwrap_err(), expected);
                assert_eq!(&tx.map_entries(id, field).unwrap_err(), expected);
            }
            assert!(matches!(tx.map_get(&unknown, "cells", "k"), Err(KdmError::NotFound(_))));
            assert!(matches!(tx.map_entries(&unknown, "cells"), Err(KdmError::NotFound(_))));
            tx.delete(&sheet)?;
            assert!(matches!(tx.map_get(&sheet, "cells", "a"), Err(KdmError::NotFound(_))));
            assert!(matches!(tx.map_entries(&sheet, "cells"), Err(KdmError::NotFound(_))));
            Ok(())
        })
        .unwrap();
}

#[test]
fn tx_lists_objects_of_a_type_with_its_creations_and_deletions() {
    let mut replica = replica();
    let id = |text: &str| ObjectId::from_string(text.to_owned());
    let shape = |tx: &mut kition_kdm::Tx<'_>, name: &str| tx.create_with_id("Shape", &id(name), fields(json!({ "kind": "rect", "x": 1, "y": 2 })));
    replica
        .transact(&person(), |tx| {
            for name in ["b", "d"] {
                shape(tx, name)?;
            }
            tx.create_with_id("Page", &id("P"), fields(json!({ "title": "One" })))
        })
        .unwrap();
    replica
        .transact(&person(), |tx| {
            assert_eq!(tx.objects_of_type("Shape"), vec![id("b"), id("d")]);
            shape(tx, "c")?;
            shape(tx, "a")?;
            shape(tx, "B")?;
            assert_eq!(tx.objects_of_type("Shape"), vec![id("B"), id("a"), id("b"), id("c"), id("d")]);
            tx.delete(&id("d"))?;
            tx.delete(&id("a"))?;
            assert_eq!(tx.objects_of_type("Shape"), vec![id("B"), id("b"), id("c")]);
            assert_eq!(tx.objects_of_type("Page"), vec![id("P")]);
            assert!(tx.objects_of_type("Nope").is_empty());
            Ok(())
        })
        .unwrap();
    assert_eq!(replica.objects_of_type("Shape"), vec![id("B"), id("b"), id("c")]);
}

#[test]
fn a_failed_transaction_that_read_its_own_writes_leaves_nothing() {
    let mut replica = replica();
    let sheet = sheet(&mut replica);
    let before = replica.state_hash().unwrap();
    let version = replica.version();
    let error = replica
        .transact(&person(), |tx| {
            tx.map_set(&sheet, "cells", "a", json!(99))?;
            tx.map_delete(&sheet, "cells", "b")?;
            let created = tx.create("Sheet", fields(json!({})))?;
            assert_eq!(tx.map_get(&sheet, "cells", "a")?, json!(99));
            assert_eq!(tx.objects_of_type("Sheet").len(), 2);
            tx.map_set(&created, "cells", "k", json!(1))?;
            tx.map_set(&sheet, "cells", "bad", json!(9_007_199_254_740_993_i64))
        })
        .unwrap_err();
    assert!(matches!(error, KdmError::InvalidValue { .. }), "{error:?}");
    assert_eq!(replica.state_hash().unwrap(), before);
    assert_eq!(replica.version(), version);
    assert_eq!(replica.objects_of_type("Sheet"), vec![sheet.clone()]);
    replica
        .transact(&person(), |tx| {
            assert_eq!(tx.map_get(&sheet, "cells", "a")?, json!(1));
            assert_eq!(tx.objects_of_type("Sheet"), vec![sheet.clone()]);
            Ok(())
        })
        .unwrap();
}

#[test]
fn a_refused_map_write_is_not_seen_by_later_reads() {
    let mut replica = replica();
    let sheet = sheet(&mut replica);
    replica
        .transact(&person(), |tx| {
            assert!(tx.map_set(&sheet, "cells", "a", json!(9_007_199_254_740_993_i64)).is_err());
            assert_eq!(tx.map_get(&sheet, "cells", "a")?, json!(1));
            Ok(())
        })
        .unwrap();
}

#[test]
fn a_refused_create_is_not_listed_among_the_objects_of_its_type() {
    let mut replica = replica();
    let (_, shape) = page_with_shape(&mut replica);
    replica
        .transact(&person(), |tx| {
            let missing_y = tx.create("Shape", fields(json!({ "kind": "rect", "x": 1 }))).unwrap_err();
            assert!(matches!(missing_y, KdmError::InvalidValue { field, .. } if field == "y"));
            let taken = tx.create_with_id("Shape", &shape, fields(json!({ "kind": "rect", "x": 1, "y": 2 }))).unwrap_err();
            assert!(matches!(taken, KdmError::InvalidValue { .. }));
            assert_eq!(tx.objects_of_type("Shape"), vec![shape.clone()]);
            Ok(())
        })
        .unwrap();
    assert_eq!(replica.objects_of_type("Shape"), vec![shape]);
}

/// An object written before its type had a map field has no map container: reads see it empty.
#[test]
fn a_map_field_the_stored_object_lacks_reads_as_empty() {
    let mut old = replica();
    let (_, shape) = page_with_shape(&mut old);
    let mut json: Value = serde_json::from_str(include_str!("fixtures/test-schema.json")).unwrap();
    json["schemaVersion"] = json!(2);
    json["types"]["Shape"]["fields"]["meta"] = json!({ "kind": "map" });
    let schema = std::sync::Arc::new(kition_kdm::Schema::parse(&json.to_string()).unwrap());
    let mut new = Replica::load(schema, &old.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    assert_eq!(new.map_get(&shape, "meta", "k").unwrap(), Value::Null);
    assert!(new.map_entries(&shape, "meta").unwrap().is_empty());
    new.transact(&person(), |tx| {
        assert_eq!(tx.map_get(&shape, "meta", "k")?, Value::Null);
        assert!(tx.map_entries(&shape, "meta")?.is_empty());
        assert!(matches!(tx.map_set(&shape, "meta", "k", json!(1)), Err(KdmError::NotFound(_))));
        assert_eq!(tx.map_get(&shape, "meta", "k")?, Value::Null);
        Ok(())
    })
    .unwrap();
}

#[test]
fn transaction_reads_object_types_including_its_own_creations_and_deletions() {
    let mut replica = replica();
    let (page, shape) = page_with_shape(&mut replica);
    let sheet = replica
        .transact(&person(), |tx| {
            assert_eq!(tx.object_type(&page)?, "Page");
            let sheet = tx.create("Sheet", fields(json!({})))?;
            assert_eq!(tx.object_type(&sheet)?, "Sheet");
            tx.delete(&shape)?;
            assert!(matches!(tx.object_type(&shape), Err(KdmError::NotFound(_))));
            assert!(matches!(tx.object_type(&ObjectId::from_string("missing")), Err(KdmError::NotFound(_))));
            Ok(sheet)
        })
        .unwrap();
    assert_eq!(replica.object_type(&sheet).unwrap(), "Sheet");
}
