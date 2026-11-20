// Copied from kition-sdk crates/kition-kdm/src/changes.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! What changed in a replica's objects, as [`crate::Replica::take_changes`] hands it out.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::Value;

use crate::ObjectId;

/// The keys of an object's map fields written, by field, each with its value after the change
/// (`None`: deleted), read as [`crate::Replica::map_get`] reads it.
pub type MapWrites = BTreeMap<String, BTreeMap<String, Option<Value>>>;

/// The objects that changed, and for those whose only changes were writes to keys of their map
/// fields, those keys and their values.
///
/// A host that keeps a projection of the document reads back nothing else: for an object listed
/// with [`Changes::map_writes`], every other field and every other key of its map fields holds
/// what it held before.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Changes {
    objects: BTreeSet<ObjectId>,
    /// The map keys written in each object of `objects` with no other change.
    writes: HashMap<ObjectId, MapWrites>,
}

impl Changes {
    /// The changed objects.
    pub fn objects(&self) -> &BTreeSet<ObjectId> {
        &self.objects
    }

    pub fn into_objects(self) -> BTreeSet<ObjectId> {
        self.objects
    }

    pub fn is_empty(&self) -> bool {
        self.objects.is_empty()
    }

    /// The keys of `id`'s map fields written and their values now, when nothing else about it
    /// changed; `None` for an object that changed otherwise (created, deleted, a register, text,
    /// list, or tree field written) or did not change.
    pub fn map_writes(&self, id: &ObjectId) -> Option<&MapWrites> {
        self.writes.get(id)
    }

    /// Notes a change of `id` other than a map key's.
    pub fn insert_object(&mut self, id: ObjectId) {
        self.writes.remove(&id);
        self.objects.insert(id);
    }

    /// Notes that key `key` of map field `field` of `id` now holds `value` (`None`: deleted),
    /// after the writes noted before.
    pub fn insert_map_write(&mut self, id: &ObjectId, field: &str, key: &str, value: Option<Value>) {
        if !self.objects.contains(id) {
            self.objects.insert(id.clone());
            self.writes.insert(id.clone(), BTreeMap::new());
        }
        if let Some(fields) = self.writes.get_mut(id) {
            fields.entry(field.to_owned()).or_default().insert(key.to_owned(), value);
        }
    }

    /// Adds what `other` changed, after what this holds.
    pub fn extend(&mut self, other: Changes) {
        if self.objects.is_empty() {
            *self = other;
            return;
        }
        let Changes { objects, mut writes } = other;
        for id in objects {
            match writes.remove(&id) {
                Some(fields) if !self.objects.contains(&id) || self.writes.contains_key(&id) => {
                    let held = self.writes.entry(id.clone()).or_default();
                    for (field, keys) in fields {
                        held.entry(field).or_default().extend(keys);
                    }
                    self.objects.insert(id);
                }
                Some(_) => {}
                None => self.insert_object(id),
            }
        }
    }
}

impl From<BTreeSet<ObjectId>> for Changes {
    /// Every object changed in any way.
    fn from(objects: BTreeSet<ObjectId>) -> Self {
        Self { objects, writes: HashMap::new() }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn id(name: &str) -> ObjectId {
        ObjectId::from_string(name)
    }

    fn cells(changes: &Changes, name: &str) -> Option<Vec<(String, Option<Value>)>> {
        changes.map_writes(&id(name)).map(|fields| fields.get("cells").into_iter().flatten().map(|(key, value)| (key.clone(), value.clone())).collect())
    }

    #[test]
    fn writes_merge_later_values_win_and_any_other_change_wins() {
        let mut changes = Changes::default();
        changes.insert_map_write(&id("a"), "cells", "x", Some(json!(1)));
        changes.insert_map_write(&id("a"), "cells", "y", None);
        changes.insert_map_write(&id("a"), "cells", "x", Some(json!(2)));
        changes.insert_map_write(&id("b"), "cells", "x", None);
        changes.insert_object(id("b"));
        changes.insert_map_write(&id("b"), "cells", "z", None);
        assert_eq!(cells(&changes, "a"), Some(vec![("x".into(), Some(json!(2))), ("y".into(), None)]));
        assert_eq!(cells(&changes, "b"), None);
        assert!(changes.objects().contains(&id("b")));

        let mut more = Changes::default();
        more.insert_map_write(&id("a"), "cells", "y", Some(json!(3)));
        more.insert_map_write(&id("c"), "widths", "w", Some(json!(80)));
        more.insert_object(id("d"));
        changes.extend(more);
        assert_eq!(cells(&changes, "a"), Some(vec![("x".into(), Some(json!(2))), ("y".into(), Some(json!(3)))]));
        assert!(changes.map_writes(&id("c")).is_some());
        assert_eq!(changes.map_writes(&id("d")), None);

        let mut whole = Changes::default();
        whole.insert_object(id("a"));
        changes.extend(whole);
        assert_eq!(changes.map_writes(&id("a")), None);
        let mut keyed = Changes::default();
        keyed.insert_map_write(&id("a"), "cells", "q", None);
        changes.extend(keyed);
        assert_eq!(changes.map_writes(&id("a")), None);
        assert_eq!(changes.into_objects().len(), 4);
    }
}
