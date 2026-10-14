//! Validation after a merge: restores the invariants the model keeps but concurrent edits can
//! break.
//!
//! - A list entry naming a missing object is removed; an entry repeated in one list keeps its
//!   first occurrence (a record listed twice, a table listed twice, ...).
//! - Fields of one table (and tables of the base) with one `name`: the lowest object id keeps
//!   it, the others, by id order, become `name_2`, `name_3`, ... (the first suffix not taken).
//! - A table whose `primaryField` is unset or names a field that is not one of its fields gets
//!   its first field.
//! - A `Link` whose `from`, `field`, or `to` is gone is deleted; links with the same
//!   `(from, field, to)` keep the lowest id.
//!
//! Every rule depends only on the document's state, so replicas that repair the same state write
//! the same values and stay converged.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use kition_kdm::{ObjectId, Origin, Replica, Tx};
use serde_json::{Value, json};

use super::model::{self, BASE, FIELD, RECORD, all_links, is_a, string, unique_name};
use crate::Result;

/// Repairs what `changed` (the objects changed since the last repair, as
/// [`Replica::take_changed`] reports them) can have broken: the base's lists, table names,
/// links, and the tables that changed or whose fields changed. Answers whether it wrote anything.
/// Run it in a `system` transaction ([`run`]), which is not an undo step.
pub fn repair(tx: &mut Tx<'_>, changed: &BTreeSet<ObjectId>) -> Result<bool> {
    if changed.is_empty() {
        return Ok(false);
    }
    pass(tx, Some(changed))
}

/// [`repair`] of every table, whatever changed.
pub fn repair_all(tx: &mut Tx<'_>) -> Result<bool> {
    pass(tx, None)
}

/// Runs [`repair`] in a `system:repair` transaction of `replica`.
pub fn run(replica: &mut Replica, changed: &BTreeSet<ObjectId>) -> Result<bool> {
    model::transact(replica, &Origin::system("repair"), |tx| repair(tx, changed))
}

fn pass(tx: &mut Tx<'_>, changed: Option<&BTreeSet<ObjectId>>) -> Result<bool> {
    let mut wrote = false;
    for base in tx.objects_of_type(BASE) {
        wrote |= clean_list(tx, &base, "tables")?;
        wrote |= clean_list(tx, &base, "dashboards")?;
        let tables = tx.list_items(&base, "tables")?;
        wrote |= unique_names(tx, &tables)?;
        for table in &tables {
            if let Some(changed) = changed {
                let fields = tx.list_items(table, "fields")?;
                if !changed.contains(table) && !fields.iter().any(|field| changed.contains(field)) {
                    continue;
                }
            }
            wrote |= repair_table(tx, table)?;
        }
    }
    wrote |= repair_links(tx)?;
    Ok(wrote)
}

fn repair_table(tx: &mut Tx<'_>, table: &ObjectId) -> Result<bool> {
    let mut wrote = clean_list(tx, table, "fields")?;
    wrote |= clean_list(tx, table, "views")?;
    wrote |= clean_list(tx, table, "records")?;
    let fields = tx.list_items(table, "fields")?;
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

/// Removes entries naming missing objects and repeated entries (keeping the first).
fn clean_list(tx: &mut Tx<'_>, id: &ObjectId, field: &str) -> Result<bool> {
    let items = tx.list_items(id, field)?;
    let mut seen = HashSet::with_capacity(items.len());
    let doomed: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, item)| !(tx.exists(item) && seen.insert(*item)))
        .map(|(index, _)| index)
        .collect();
    for index in doomed.iter().rev() {
        tx.list_remove(id, field, *index)?;
    }
    Ok(!doomed.is_empty())
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

/// Deletes links with a missing end, and repeated links but the lowest id.
fn repair_links(tx: &mut Tx<'_>) -> Result<bool> {
    let mut seen = HashSet::new();
    let mut wrote = false;
    for link in all_links(tx)? {
        let live = is_a(tx, &link.from, RECORD)
            && is_a(tx, &link.to, RECORD)
            && is_a(tx, &link.field, FIELD);
        if !live || !seen.insert((link.from, link.field, link.to)) {
            tx.delete(&link.id)?;
            wrote = true;
        }
    }
    Ok(wrote)
}
