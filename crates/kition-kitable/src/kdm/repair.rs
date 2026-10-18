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
//! the same values and stay converged. A full pass ([`repair`], [`run`]) reads the whole document,
//! every object once per type: its cost grows with the document, not with the change.
//!
//! [`run_since`] writes exactly what a full pass would, at a cost that grows with the change: it
//! relies on the state before the change being repaired already (every write a
//! [`crate::KitableFile`] stores is), so only what the change touched can break a rule. It reads
//! the lists of the base and its tables (cheap reads, no per-object lookups) and keeps the
//! document's bases and links in a [`RepairIndex`] carried from write to write.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use kition_kdm::{ObjectId, Origin, Replica, Tx, Version};
use serde_json::{Value, json};

use super::model::{
    self, BASE, DASHBOARD, FIELD, LINK, LinkEnds, RECORD, TABLE, VIEW, all_links, is_a,
    is_single_target, string, unique_name,
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
    let bases = tx.objects_of_type(BASE);
    let (mut wrote, reachable) = repair_lists(tx, &bases, |_| true)?;
    for ty in ORPHAN_TYPES {
        for id in tx.objects_of_type(ty) {
            if !reachable.contains(&id) {
                tx.delete(&id)?;
                wrote = true;
            }
        }
    }
    wrote |= repair_links(tx, all_links(tx)?)?;
    Ok(wrote)
}

/// The types of objects a list must reach, in the order orphans are deleted.
const ORPHAN_TYPES: [&str; 5] = [TABLE, FIELD, VIEW, RECORD, DASHBOARD];

/// The list rules, for every base in `bases` (sorted) and every table they list: dangling
/// entries removed, unique names, valid primary fields. `suspect` says which entries may name a
/// missing object; the others are known to exist. Answers whether it wrote anything, and every
/// object the lists reach.
fn repair_lists(
    tx: &mut Tx<'_>,
    bases: &[ObjectId],
    suspect: impl Fn(&ObjectId) -> bool,
) -> Result<(bool, HashSet<ObjectId>)> {
    let mut wrote = false;
    let mut reachable = HashSet::new();
    for base in bases {
        let (dropped, tables) = drop_dangling(tx, base, "tables", &suspect)?;
        wrote |= dropped;
        let (dropped, dashboards) = drop_dangling(tx, base, "dashboards", &suspect)?;
        wrote |= dropped;
        reachable.extend(dashboards);
        wrote |= unique_names(tx, &tables)?;
        for table in tables {
            if reachable.insert(table.clone()) {
                wrote |= repair_table(tx, &table, &mut reachable, &suspect)?;
            }
        }
    }
    Ok((wrote, reachable))
}

/// What [`run_since`] needs to know of the document before a change: every object the lists of
/// its bases and their tables named. Take it with [`RepairIndex::before`] right before the
/// change.
#[derive(Debug, Default)]
pub struct Before {
    listed: HashSet<ObjectId>,
}

/// The document's bases and (once a repair needed them) links, as of one replica version, kept
/// from write to write so [`run_since`] need not scan every object of the document. Bring it
/// along with [`RepairIndex::advance`] after each change; an index left behind is rebuilt (one
/// scan of the document) the next time it is needed.
#[derive(Debug, Default)]
pub struct RepairIndex {
    version: Option<Version>,
    bases: BTreeSet<ObjectId>,
    links: Option<LinkIndex>,
}

/// Every live link with its ends, and the links of each end (record or field).
#[derive(Debug, Default)]
struct LinkIndex {
    links: HashMap<ObjectId, LinkEnds>,
    by_end: HashMap<ObjectId, BTreeSet<ObjectId>>,
}

impl LinkIndex {
    fn build(tx: &Tx<'_>) -> Result<Self> {
        let mut index = Self::default();
        for link in all_links(tx)? {
            index.insert(link);
        }
        Ok(index)
    }

    fn insert(&mut self, link: LinkEnds) {
        for end in [&link.from, &link.field, &link.to] {
            self.by_end
                .entry(end.clone())
                .or_default()
                .insert(link.id.clone());
        }
        self.links.insert(link.id.clone(), link);
    }

    fn remove(&mut self, id: &ObjectId) {
        let Some(link) = self.links.remove(id) else {
            return;
        };
        for end in [&link.from, &link.field, &link.to] {
            if let Some(ids) = self.by_end.get_mut(end) {
                ids.remove(id);
                if ids.is_empty() {
                    self.by_end.remove(end);
                }
            }
        }
    }

    /// The links of `end`, as it is the `from`, `field`, or `to` of each.
    fn of(&self, end: &ObjectId) -> impl Iterator<Item = &LinkEnds> {
        self.by_end
            .get(end)
            .into_iter()
            .flatten()
            .filter_map(|id| self.links.get(id))
    }
}

impl RepairIndex {
    /// An index of `replica` as it is now, with the bases the caller already found (every Base
    /// object, as [`Replica::objects_of_type`] answers).
    pub fn with_bases(replica: &Replica, bases: impl IntoIterator<Item = ObjectId>) -> Self {
        Self {
            version: Some(replica.version()),
            bases: bases.into_iter().collect(),
            links: None,
        }
    }

    /// Brings the index from the replica's state at `from` to its current state, given every
    /// object changed since (`changed`, as [`Replica::take_changed`] reports them; more is
    /// harmless). An index not at `from` is left behind, to be rebuilt when needed.
    pub fn advance(&mut self, from: &Version, replica: &Replica, changed: &BTreeSet<ObjectId>) {
        if self.version.as_ref() != Some(from) {
            self.version = None;
            return;
        }
        for id in changed {
            let ty = replica.object_type(id).ok();
            if ty.as_deref() == Some(BASE) {
                self.bases.insert(id.clone());
            } else {
                self.bases.remove(id);
            }
            let Some(links) = &mut self.links else {
                continue;
            };
            links.remove(id);
            if ty.as_deref() == Some(LINK) {
                let end = |name: &str| {
                    replica
                        .get(id, name)
                        .map(|value| ObjectId::from_string(value.as_str().unwrap_or_default()))
                };
                match (end("from"), end("field"), end("to")) {
                    (Ok(from), Ok(field), Ok(to)) => links.insert(LinkEnds {
                        id: id.clone(),
                        from,
                        field,
                        to,
                    }),
                    // Unreadable now: the next repair that needs links rereads them all.
                    _ => self.links = None,
                }
            }
        }
        self.version = Some(replica.version());
    }

    /// Rebuilds the index unless it describes `replica`'s current state.
    fn ensure(&mut self, replica: &Replica) {
        let version = replica.version();
        if self.version.as_ref() != Some(&version) {
            self.bases = replica.objects_of_type(BASE).into_iter().collect();
            self.links = None;
            self.version = Some(version);
        }
    }

    /// What [`run_since`] needs of the replica's current state, before a change.
    pub fn before(&mut self, replica: &Replica) -> Result<Before> {
        self.ensure(replica);
        let mut listed = HashSet::new();
        let mut tables = Vec::new();
        for base in &self.bases {
            tables.extend(replica.list(base, "tables")?);
            listed.extend(replica.list(base, "dashboards")?);
        }
        for table in tables {
            if !replica.exists(&table) {
                continue;
            }
            for list in ["fields", "views", "records"] {
                listed.extend(replica.list(&table, list)?);
            }
            listed.insert(table);
        }
        Ok(Before { listed })
    }
}

/// Repairs what a change broke, writing exactly what [`repair`] would, in a `system:repair`
/// transaction of `replica`: `changed` is every object the change changed (as
/// [`Replica::take_changed`] reports them), `before` what [`RepairIndex::before`] answered right
/// before it, and the document before it was repaired. `index` describes the replica after the
/// change ([`RepairIndex::advance`]; it is rebuilt otherwise) and is brought along with the
/// repair's own writes. Takes the change's objects from the replica first
/// ([`Replica::take_changed`]): this takes the repair's. Answers whether the repair wrote
/// anything, and the objects it changed.
pub fn run_since(
    replica: &mut Replica,
    changed: &BTreeSet<ObjectId>,
    before: &Before,
    index: &mut RepairIndex,
) -> Result<(bool, BTreeSet<ObjectId>)> {
    if changed.is_empty() {
        return Ok((false, BTreeSet::new()));
    }
    index.ensure(replica);
    let from = replica.version();
    let wrote = model::transact(replica, &Origin::system("repair"), |tx| {
        repair_since(tx, changed, before, index)
    })?;
    let repaired = replica.take_changed();
    index.advance(&from, replica, &repaired);
    Ok((wrote, repaired))
}

fn repair_since(
    tx: &mut Tx<'_>,
    changed: &BTreeSet<ObjectId>,
    before: &Before,
    index: &mut RepairIndex,
) -> Result<bool> {
    // Before the change every listed entry named an object (the document was repaired), and an
    // object that is gone now but was listed is one the change deleted: only entries the change
    // touched, or that were not listed, can name a missing object.
    let gone: Vec<ObjectId> = changed
        .iter()
        .filter(|id| !tx.exists(id))
        .cloned()
        .collect();
    let bases: Vec<ObjectId> = index.bases.iter().cloned().collect();
    let (mut wrote, reachable) = repair_lists(tx, &bases, |item| {
        changed.contains(item) || !before.listed.contains(item)
    })?;
    // Every live object was reachable before the change (no orphans), so an orphan now is one
    // that was listed before, or one the change touched (created, for instance).
    let mut orphans = Vec::new();
    for id in before.listed.iter().chain(changed) {
        if reachable.contains(id) {
            continue;
        }
        if let Ok(ty) = tx.object_type(id)
            && let Some(rank) = ORPHAN_TYPES.iter().position(|orphan| *orphan == ty)
        {
            orphans.push((rank, id.clone()));
        }
    }
    orphans.sort();
    orphans.dedup();
    for (_, id) in &orphans {
        tx.delete(id)?;
        wrote = true;
    }
    // A link's verdict depends on its ends, its field's options, and the other links of its
    // `(from, field)`: only groups the change or the deletions above touched can change.
    let fields: Vec<&ObjectId> = changed.iter().filter(|id| is_a(tx, id, FIELD)).collect();
    let touched_links = changed.iter().any(|id| is_a(tx, id, LINK));
    if gone.is_empty() && orphans.is_empty() && fields.is_empty() && !touched_links {
        return Ok(wrote);
    }
    if index.links.is_none() {
        index.links = Some(LinkIndex::build(tx)?);
    }
    let Some(links) = &index.links else {
        return Ok(wrote);
    };
    let mut groups: BTreeSet<(ObjectId, ObjectId)> = BTreeSet::new();
    for id in changed {
        if let Some(link) = links.links.get(id) {
            groups.insert((link.from.clone(), link.field.clone()));
        }
    }
    for end in gone
        .iter()
        .chain(orphans.iter().map(|(_, id)| id))
        .chain(fields)
    {
        for link in links.of(end) {
            groups.insert((link.from.clone(), link.field.clone()));
        }
    }
    let mut affected: Vec<LinkEnds> = Vec::new();
    for (from, field) in &groups {
        affected.extend(
            links
                .of(from)
                .filter(|link| link.from == *from && link.field == *field)
                .cloned(),
        );
    }
    affected.sort_by(|a, b| a.id.cmp(&b.id));
    affected.dedup_by(|a, b| a.id == b.id);
    wrote |= repair_links(tx, affected)?;
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
    suspect: &impl Fn(&ObjectId) -> bool,
) -> Result<bool> {
    let mut wrote = false;
    let mut fields = Vec::new();
    for list in ["fields", "views", "records"] {
        let (dropped, live) = drop_dangling(tx, table, list, suspect)?;
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
/// items (first occurrence only), as the model reads them. Only entries `suspect` names are
/// looked up; the others are known to exist.
fn drop_dangling(
    tx: &mut Tx<'_>,
    id: &ObjectId,
    field: &str,
    suspect: &impl Fn(&ObjectId) -> bool,
) -> Result<(bool, Vec<ObjectId>)> {
    let items = tx.list_items(id, field)?;
    let mut doomed = Vec::new();
    let mut seen = HashSet::with_capacity(items.len());
    let mut live = Vec::with_capacity(items.len());
    for (index, item) in items.into_iter().enumerate() {
        if suspect(&item) && !tx.exists(&item) {
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
/// them go too. `links` is sorted by id and holds every link of each `(from, field)` it holds
/// one of (every link, for a full pass).
fn repair_links(tx: &mut Tx<'_>, links: Vec<LinkEnds>) -> Result<bool> {
    let mut seen = HashSet::new();
    let mut single_seen = HashSet::new();
    let mut single: HashMap<ObjectId, bool> = HashMap::new();
    let mut wrote = false;
    for link in links {
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
