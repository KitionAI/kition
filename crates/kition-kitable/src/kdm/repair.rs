//! Validation after a merge: restores the invariants the model keeps but concurrent edits can
//! break.
//!
//! - A list entry naming a missing object is removed. Repeated entries of one id are kept:
//!   which copy to remove depends on the replica (two replicas removing different copies would
//!   lose the object), so readers and positions use the first occurrence instead.
//! - Fields of one table (and tables of the base) with one `name`: the lowest object id keeps
//!   it, the others, by id order, become `name_2`, `name_3`, ... (the first suffix not taken).
//!   A later merge can rename a field again (`name_2` to `name_3`); references by name (view
//!   configs, formulas) follow the field that keeps the name.
//! - A table whose `primaryField` is unset or names a field that is not one of its fields gets
//!   its first field.
//! - Orphans are deleted: tables and dashboards the base does not list, and fields, views, and
//!   records no listed table lists (a table deleted while another replica added to it).
//! - A `Link` whose `from`, `field`, or `to` is gone is deleted; links with the same
//!   `(from, field, to)` keep the lowest id, and so do links of one `(from, field)` of a
//!   single-target field (`allow_multiple: false`).
//!
//! Every rule depends only on the document's state, so replicas that repair the same state write
//! the same values and stay converged. A pass reads the whole document: about 25 ms for 10,000
//! records and 2,000 links in a release build.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use kition_kdm::{ObjectId, Origin, Replica, Tx};
use serde_json::{Value, json};

use super::model::{
    self, BASE, DASHBOARD, FIELD, RECORD, TABLE, VIEW, all_links, is_a, is_single_target, string,
    unique_name,
};
use crate::Result;

/// Repairs the document after the objects in `changed` changed (as
/// [`Replica::take_changed`] reports them); with nothing changed there is nothing to repair.
/// The pass covers the whole document. Answers whether it wrote anything. Run it in a `system`
/// transaction ([`run`]), which is not an undo step.
pub fn repair(tx: &mut Tx<'_>, changed: &BTreeSet<ObjectId>) -> Result<bool> {
    if changed.is_empty() {
        return Ok(false);
    }
    repair_all(tx)
}

/// One repair pass over the whole document, whatever changed.
pub fn repair_all(tx: &mut Tx<'_>) -> Result<bool> {
    let mut wrote = false;
    let mut reachable = HashSet::new();
    for base in tx.objects_of_type(BASE) {
        let (dropped, tables) = drop_dangling(tx, &base, "tables")?;
        wrote |= dropped;
        let (dropped, dashboards) = drop_dangling(tx, &base, "dashboards")?;
        wrote |= dropped;
        reachable.extend(dashboards);
        wrote |= unique_names(tx, &tables)?;
        for table in tables {
            if reachable.insert(table.clone()) {
                wrote |= repair_table(tx, &table, &mut reachable)?;
            }
        }
    }
    for ty in [TABLE, FIELD, VIEW, RECORD, DASHBOARD] {
        for id in tx.objects_of_type(ty) {
            if !reachable.contains(&id) {
                tx.delete(&id)?;
                wrote = true;
            }
        }
    }
    wrote |= repair_links(tx)?;
    Ok(wrote)
}

/// Runs [`repair`] in a `system:repair` transaction of `replica`.
pub fn run(replica: &mut Replica, changed: &BTreeSet<ObjectId>) -> Result<bool> {
    model::transact(replica, &Origin::system("repair"), |tx| repair(tx, changed))
}

fn repair_table(
    tx: &mut Tx<'_>,
    table: &ObjectId,
    reachable: &mut HashSet<ObjectId>,
) -> Result<bool> {
    let mut wrote = false;
    let mut fields = Vec::new();
    for list in ["fields", "views", "records"] {
        let (dropped, live) = drop_dangling(tx, table, list)?;
        wrote |= dropped;
        if list == "fields" {
            fields.clone_from(&live);
        }
        reachable.extend(live);
    }
    wrote |= unique_names(tx, &fields)?;
    let primary = tx.get(table, "primaryField")?;
    let valid = primary
        .as_str()
        .is_some_and(|primary| fields.iter().any(|field| field.as_str() == primary));
    if !valid {
        let first = fields
            .first()
            .map_or(Value::Null, |field| json!(field.as_str()));
        if first != primary {
            tx.set(table, "primaryField", first)?;
            wrote = true;
        }
    }
    Ok(wrote)
}

/// Removes the entries naming missing objects; answers whether there were any, and the live
/// items (first occurrence only), as the model reads them.
fn drop_dangling(tx: &mut Tx<'_>, id: &ObjectId, field: &str) -> Result<(bool, Vec<ObjectId>)> {
    let items = tx.list_items(id, field)?;
    let mut doomed = Vec::new();
    let mut seen = HashSet::with_capacity(items.len());
    let mut live = Vec::with_capacity(items.len());
    for (index, item) in items.into_iter().enumerate() {
        if !tx.exists(&item) {
            doomed.push(index);
        } else if seen.insert(item.clone()) {
            live.push(item);
        }
    }
    for index in doomed.iter().rev() {
        tx.list_remove(id, field, *index)?;
    }
    Ok((!doomed.is_empty(), live))
}

/// Gives every object of `ids` a distinct `name`: in each group sharing a name, the lowest id
/// keeps it and the others, by id order, get the first free `name_2`, `name_3`, ...
fn unique_names(tx: &mut Tx<'_>, ids: &[ObjectId]) -> Result<bool> {
    let mut groups: BTreeMap<String, Vec<ObjectId>> = BTreeMap::new();
    for id in ids {
        groups
            .entry(string(tx, id, "name")?)
            .or_default()
            .push(id.clone());
    }
    let mut taken: HashSet<String> = groups.keys().cloned().collect();
    let mut wrote = false;
    for (name, mut group) in groups {
        if group.len() < 2 {
            continue;
        }
        group.sort();
        for id in group.iter().skip(1) {
            let renamed = unique_name(&name, &taken);
            tx.set(id, "name", json!(renamed))?;
            taken.insert(renamed);
            wrote = true;
        }
    }
    Ok(wrote)
}

/// Deletes links with a missing end, repeated links but the lowest id, and extra links of
/// single-target fields but the lowest id. Runs after orphans are deleted, so links touching
/// them go too.
fn repair_links(tx: &mut Tx<'_>) -> Result<bool> {
    let mut seen = HashSet::new();
    let mut single_seen = HashSet::new();
    let mut single: HashMap<ObjectId, bool> = HashMap::new();
    let mut wrote = false;
    for link in all_links(tx)? {
        let live = is_a(tx, &link.from, RECORD)
            && is_a(tx, &link.to, RECORD)
            && is_a(tx, &link.field, FIELD);
        let keep =
            live && seen.insert((link.from.clone(), link.field.clone(), link.to.clone())) && {
                let is_single = match single.get(&link.field) {
                    Some(found) => *found,
                    None => {
                        let found = is_single_target(tx, &link.field)?;
                        single.insert(link.field.clone(), found);
                        found
                    }
                };
                !is_single || single_seen.insert((link.from.clone(), link.field.clone()))
            };
        if !keep {
            tx.delete(&link.id)?;
            wrote = true;
        }
    }
    Ok(wrote)
}
