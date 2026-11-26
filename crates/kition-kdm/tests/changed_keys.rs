// Copied from kition-sdk crates/kition-kdm/tests/changed_keys.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! What a replica reports changed, with the map keys written and their values (case
//! regressions/issue-kition-table-bulk-write): a projection of a large write reads nothing back.
//! A transaction, an import of it, its undo and its redo report the same keys with the values
//! they leave; an object with any other change is reported whole.

use std::collections::{BTreeMap, BTreeSet};

use kition_kdm::{ActorId, Changes, DocId, ObjectId, Origin, Replica};
use serde_json::{Value, json};

mod common;
use common::{fields, person, schema};

/// Two sheets with cells `a` and `b`, and a shape, made before undo history starts.
fn document() -> (Replica, ObjectId, ObjectId, ObjectId) {
    let (replica, (one, two, shape)) = Replica::create_with(schema(), DocId::new(), ActorId::from_u64(1).unwrap(), &Origin::system("import"), |tx| {
        let one = tx.create("Sheet", fields(json!({})))?;
        let two = tx.create("Sheet", fields(json!({})))?;
        for sheet in [&one, &two] {
            tx.map_set(sheet, "cells", "a", json!(1))?;
            tx.map_set(sheet, "cells", "b", json!(2))?;
        }
        let shape = tx.create("Shape", fields(json!({ "kind": "rect", "x": 1, "y": 2 })))?;
        Ok((one, two, shape))
    })
    .unwrap();
    (replica, one, two, shape)
}

/// Keys written, with their values, by field.
type Written = BTreeMap<String, Vec<(String, Option<Value>)>>;

fn keys(changes: &Changes, id: &ObjectId) -> Option<Written> {
    changes.map_writes(id).map(|fields| fields.iter().map(|(field, keys)| (field.clone(), keys.clone().into_iter().collect())).collect())
}

fn cells(written: &[(&str, Option<Value>)]) -> Option<Written> {
    Some(BTreeMap::from([("cells".to_owned(), written.iter().map(|(key, value)| ((*key).to_owned(), value.clone())).collect())]))
}

/// Writes `a` of the first sheet, deletes `b` of it, writes `b` of the second, moves the shape.
fn write(replica: &mut Replica, one: &ObjectId, two: &ObjectId, shape: &ObjectId) {
    replica
        .transact(&person(), |tx| {
            tx.map_set(one, "cells", "a", json!(10))?;
            tx.map_delete(one, "cells", "b")?;
            tx.map_set(two, "cells", "b", json!(20))?;
            tx.set(shape, "x", json!(5))
        })
        .unwrap();
}

/// The changes report the three objects, and the cells written with their values: those
/// [`write`] wrote (`done`), or those it replaced.
fn reported(changes: &Changes, one: &ObjectId, two: &ObjectId, shape: &ObjectId, done: bool, what: &str) {
    assert_eq!(changes.objects(), &BTreeSet::from([one.clone(), two.clone(), shape.clone()]), "{what}");
    let (a, b, b2) = if done { (json!(10), None, json!(20)) } else { (json!(1), Some(json!(2)), json!(2)) };
    assert_eq!(keys(changes, one), cells(&[("a", Some(a)), ("b", b)]), "{what}");
    assert_eq!(keys(changes, two), cells(&[("b", Some(b2))]), "{what}");
    assert_eq!(keys(changes, shape), None, "{what}: a register written is the whole object");
}

#[test]
fn a_write_its_import_undo_and_redo_report_the_map_keys_written() {
    let (mut replica, one, two, shape) = document();
    let mut copy = Replica::load(schema(), &replica.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    replica.take_changes();
    let since = replica.version();
    write(&mut replica, &one, &two, &shape);
    reported(&replica.take_changes(), &one, &two, &shape, true, "the transaction");

    copy.take_changes();
    copy.import_changes(&replica.export_changes(&since).unwrap()).unwrap();
    reported(&copy.take_changes(), &one, &two, &shape, true, "the import");

    assert!(replica.undo().unwrap().is_done());
    reported(&replica.take_changes(), &one, &two, &shape, false, "the undo");
    assert!(replica.redo().unwrap().is_done());
    reported(&replica.take_changes(), &one, &two, &shape, true, "the redo");
}

#[test]
fn a_created_or_deleted_object_is_reported_whole() {
    let (mut replica, one, two, _) = document();
    replica.take_changes();
    let created = replica
        .transact(&person(), |tx| {
            let created = tx.create("Sheet", fields(json!({})))?;
            tx.map_set(&created, "cells", "a", json!(1))?;
            tx.map_set(&one, "cells", "a", json!(3))?;
            tx.delete(&one)?;
            tx.map_set(&two, "cells", "c", json!(4))?;
            Ok(created)
        })
        .unwrap();
    let changes = replica.take_changes();
    assert_eq!(keys(&changes, &created), None);
    assert_eq!(keys(&changes, &one), None);
    assert_eq!(keys(&changes, &two), cells(&[("c", Some(json!(4)))]));
    assert!(replica.take_changes().is_empty(), "taken once");
}

/// An undo keeps a cell another replica wrote later; the change reports the value kept, which is
/// what the replica holds.
#[test]
fn an_undo_that_keeps_another_replicas_later_write_reports_the_value_kept() {
    let (mut replica, one, _, _) = document();
    let mut other = Replica::load(schema(), &replica.snapshot().unwrap(), ActorId::from_u64(2).unwrap()).unwrap();
    let since = replica.version();
    replica.transact(&person(), |tx| tx.map_set(&one, "cells", "a", json!(10))).unwrap();
    other.import_changes(&replica.export_changes(&since).unwrap()).unwrap();
    let theirs = other.version();
    other.transact(&person(), |tx| tx.map_set(&one, "cells", "a", json!(99))).unwrap();
    replica.import_changes(&other.export_changes(&theirs).unwrap()).unwrap();
    replica.take_changes();

    assert!(replica.undo().unwrap().is_done());
    assert_eq!(replica.map_get(&one, "cells", "a").unwrap(), json!(99));
    let changes = replica.take_changes();
    let written = changes.map_writes(&one).and_then(|fields| fields.get("cells")).and_then(|keys| keys.get("a")).cloned();
    assert_eq!(written, Some(Some(json!(99))));
}
