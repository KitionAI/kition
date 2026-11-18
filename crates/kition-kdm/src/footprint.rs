// Copied from kition-sdk crates/kition-kdm/src/footprint.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A change set's `footprint`: what a change touched stated once instead of object by
//! object. A ripple edit on a track of 200 clips changes every later clip's `start` by the same
//! amount; a receipt listing each is about 120 bytes a clip. When at least [`MIN_RUN`] objects
//! that sit one after another in one list had one numeric field changed by the same amount and
//! nothing else changed in them, their entries are replaced by one footprint entry:
//!
//! ```json
//! { "parent": "V1", "field": "clips", "from": 3, "count": 196, "shift": { "field": "start", "by": -1 } }
//! ```
//!
//! `from` and `count` are the run's indexes in the list as it is after the change. A parent's
//! entry that says only that its list changed (`fields: ["clips"]`, no edits) is dropped when the
//! footprint, or a created, deleted or moved object of that list, already says what happened.
//!
//! Objects whose every change is a shift, the same shifts for at least [`MIN_RUN`] of them, that sit
//! in no such run (scattered through a list, or in no list a change set names: a 3D kit's objects
//! moved by one offset) are stated once by their ids, in the order the change set lists
//! them:
//!
//! ```json
//! { "ids": ["4", "9", "17", "30"], "edits": [{ "field": "location.2", "by": 1 }] }
//! ```
//!
//! `shift.by` is the difference of the values: a number (whole when both are), or for fields that
//! hold whole numbers as strings (a video kit's ticks) a string. `@kition/kdm`'s `withFootprint`
//! answers the same for the same change set and lists (`tests/fixtures/footprint.json`).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

/// An object's shifts: each field and its amount, by field.
type Shifts = Vec<(String, Value)>;

/// The fewest objects one footprint entry stands for.
pub const MIN_RUN: usize = 4;

/// The lists a change set changed, which its footprint may name: where its created, deleted and
/// moved objects are, and the list fields of the objects it says changed without edits. Each
/// `(parent, field)` once, in order.
pub fn lists(changes: &Value) -> Vec<(String, String)> {
    let mut found: BTreeSet<(String, String)> = BTreeSet::new();
    let mut place = |position: &Value| {
        if let (Some(parent), Some(field)) = (position["parent"].as_str(), position["field"].as_str()) {
            found.insert((parent.to_owned(), field.to_owned()));
        }
    };
    for item in items(changes, "created").chain(items(changes, "deleted")) {
        place(&item["at"]);
    }
    for item in items(changes, "moved") {
        place(&item["from"]);
        place(&item["to"]);
    }
    for item in items(changes, "changed").filter(|item| item["edits"].as_array().is_some_and(Vec::is_empty)) {
        if let Some(id) = item["id"].as_str() {
            for field in item["fields"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                found.insert((id.to_owned(), field.to_owned()));
            }
        }
    }
    found.into_iter().collect()
}

fn items<'a>(changes: &'a Value, list: &str) -> impl Iterator<Item = &'a Value> {
    changes[list].as_array().into_iter().flatten()
}

/// The difference `after - before` of a field's two values, as the footprint states it; `None`
/// for values that are no numbers (nor whole numbers written as strings).
pub fn shift(before: &Value, after: &Value) -> Option<Value> {
    if let (Some(before), Some(after)) = (before.as_i64(), after.as_i64()) {
        return after.checked_sub(before).map(|by| json!(by));
    }
    if let (Some(before), Some(after)) = (before.as_f64(), after.as_f64()) {
        let by = after - before;
        if !by.is_finite() {
            return None;
        }
        // A whole difference is written as a whole number, as JavaScript writes it.
        if by.fract() == 0.0 && by.abs() < 9.0e15 {
            return Some(json!(by as i64));
        }
        return Some(json!(by));
    }
    let whole = |value: &Value| value.as_str().filter(|text| !text.is_empty()).and_then(|text| text.parse::<i128>().ok());
    let (before, after) = (whole(before)?, whole(after)?);
    Some(Value::String(after.checked_sub(before)?.to_string()))
}

/// `changes` with its footprint: each run of at least [`MIN_RUN`] objects one after another in a
/// list ([`lists`], whose items `items` answers as they are after the change, by the ids the
/// change set uses) whose only change is one field shifted by one amount stated once in
/// `footprint`, and the parents' entries that say no more than the footprint or the list's
/// created, deleted and moved objects left out. A change set without such a run is answered as it
/// is, but for those parents' entries.
pub fn with_footprint(changes: &Value, items_of: &dyn Fn(&str, &str) -> Option<Vec<String>>) -> Value {
    let mut out = changes.clone();
    // Objects that were created, deleted or moved changed more than one field.
    let placed: BTreeSet<&str> = ["created", "deleted", "moved"].iter().flat_map(|list| items(changes, list)).filter_map(|item| item["id"].as_str()).collect();
    // Each changed object whose one change is a shift: its field and amount.
    let mut shifted: BTreeMap<&str, (String, Value)> = BTreeMap::new();
    // Each changed object whose every change is a shift: its shifts, by field.
    let mut shifts_of: Vec<(&str, Shifts)> = Vec::new();
    for item in items(changes, "changed") {
        let Some(id) = item["id"].as_str().filter(|id| !placed.contains(id)) else { continue };
        let Some(edits) = item["edits"].as_array().filter(|edits| !edits.is_empty()) else { continue };
        let mut shifts: Vec<(String, Value)> = Vec::new();
        for edit in edits {
            let (Some(field), Some(by)) = (edit["field"].as_str(), shift(&edit["before"], &edit["after"])) else { break };
            shifts.push((field.to_owned(), by));
        }
        let fields: Vec<&str> = item["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        if shifts.len() != edits.len() || fields.len() != shifts.len() || !shifts.iter().all(|(field, _)| fields.contains(&field.as_str())) {
            continue;
        }
        shifts.sort_by(|a, b| a.0.cmp(&b.0));
        if let [(field, by)] = shifts.as_slice() {
            shifted.insert(id, (field.clone(), by.clone()));
        }
        shifts_of.push((id, shifts));
    }
    let mut footprint: Vec<Value> = Vec::new();
    let mut covered: BTreeSet<String> = BTreeSet::new();
    let lists = lists(changes);
    if shifted.len() >= MIN_RUN {
        for (parent, field) in &lists {
            let Some(listed) = items_of(parent, field) else { continue };
            let key_at = |index: usize| listed.get(index).and_then(|id| shifted.get(id.as_str()));
            let mut index = 0;
            while index < listed.len() {
                let Some(key) = key_at(index) else {
                    index += 1;
                    continue;
                };
                let mut end = index + 1;
                while end < listed.len() && key_at(end) == Some(key) {
                    end += 1;
                }
                if end - index >= MIN_RUN {
                    footprint.push(json!({ "parent": parent, "field": field, "from": index, "count": end - index, "shift": { "field": key.0, "by": key.1 } }));
                    covered.extend(listed.iter().skip(index).take(end - index).cloned());
                }
                index = end;
            }
        }
    }
    // The rest, the same shifts for at least MIN_RUN objects: by their ids.
    let mut groups: Vec<(&Shifts, Vec<&str>)> = Vec::new();
    for (id, shifts) in shifts_of.iter().filter(|(id, _)| !covered.contains(*id)) {
        match groups.iter_mut().find(|(known, _)| *known == shifts) {
            Some((_, ids)) => ids.push(id),
            None => groups.push((shifts, vec![id])),
        }
    }
    for (shifts, ids) in groups.into_iter().filter(|(_, ids)| ids.len() >= MIN_RUN) {
        let edits: Vec<Value> = shifts.iter().map(|(field, by)| json!({ "field": field, "by": by })).collect();
        footprint.push(json!({ "ids": ids, "edits": edits }));
        covered.extend(ids.iter().map(|id| (*id).to_owned()));
    }
    type AssignmentValues = Vec<(String, Value)>;
    let mut assignments: Vec<(AssignmentValues, Vec<String>)> = Vec::new();
    for item in items(changes, "changed") {
        let Some(id) = item["id"].as_str().filter(|id| !covered.contains(*id) && !placed.contains(id)) else { continue };
        let Some(edits) = item["edits"].as_array().filter(|edits| !edits.is_empty()) else { continue };
        let values: Option<Vec<_>> = edits
            .iter()
            .map(|edit| {
                let value = edit.get("after")?;
                // Excerpts and blob-size summaries do not prove equal complete values.
                if value.as_object().is_some_and(|value| value.contains_key("excerpt") || value.len() == 1 && value.contains_key("size")) {
                    return None;
                }
                Some((edit["field"].as_str()?.to_owned(), value.clone()))
            })
            .collect();
        let Some(mut values) = values else { continue };
        let fields: Vec<_> = item["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        if fields.len() != values.len() || !values.iter().all(|(field, _)| fields.contains(&field.as_str())) {
            continue;
        }
        values.sort_by(|a, b| a.0.cmp(&b.0));
        match assignments.iter_mut().find(|(known, _)| known == &values) {
            Some((_, ids)) => ids.push(id.to_owned()),
            None => assignments.push((values, vec![id.to_owned()])),
        }
    }
    for (values, ids) in assignments.into_iter().filter(|(_, ids)| ids.len() >= MIN_RUN) {
        let edits: Vec<_> = values.into_iter().map(|(field, after)| json!({"field":field,"after":after})).collect();
        footprint.push(json!({"ids":ids,"edits":edits}));
        covered.extend(ids);
    }
    // The lists the footprint or the list's own objects tell.
    let mut told: BTreeSet<(String, String)> =
        footprint.iter().filter_map(|print| Some((print["parent"].as_str()?.to_owned(), print["field"].as_str()?.to_owned()))).collect();
    let mut place = |position: &Value| {
        if let (Some(parent), Some(field)) = (position["parent"].as_str(), position["field"].as_str()) {
            told.insert((parent.to_owned(), field.to_owned()));
        }
    };
    for item in items(changes, "created").chain(items(changes, "deleted")) {
        place(&item["at"]);
    }
    for item in items(changes, "moved") {
        place(&item["from"]);
        place(&item["to"]);
    }
    if let Some(changed) = out.get_mut("changed").and_then(Value::as_array_mut) {
        changed.retain_mut(|item| {
            let Some(id) = item["id"].as_str().map(str::to_owned) else { return true };
            if covered.contains(&id) {
                return false;
            }
            if !item["edits"].as_array().is_some_and(Vec::is_empty) {
                return true;
            }
            if let Some(fields) = item["fields"].as_array_mut() {
                fields.retain(|field| field.as_str().is_none_or(|field| !told.contains(&(id.clone(), field.to_owned()))));
                return !fields.is_empty();
            }
            true
        });
    }
    if !footprint.is_empty()
        && let Some(object) = out.as_object_mut()
    {
        object.insert("footprint".into(), Value::Array(footprint));
    }
    member_shifts(out)
}

fn numeric_leaves(path: &str, before: &Value, after: &Value, out: &mut Vec<Value>, maps: &mut BTreeSet<String>) -> bool {
    if before == after {
        return true;
    }
    if let (Some(a), Some(b)) = (before.as_object(), after.as_object()) {
        if a.len() != b.len() || a.keys().any(|key| !b.contains_key(key) || key.is_empty() || key.contains(['.', '*'])) {
            return false;
        }
        maps.insert(path.to_owned());
        return a.iter().all(|(key, value)| numeric_leaves(&format!("{path}.{key}"), value, &b[key], out, maps));
    }
    if let (Some(a), Some(b)) = (before.as_array(), after.as_array()) {
        if a.len() != b.len() {
            return false;
        }
        return a.iter().zip(b).enumerate().all(|(index, (a, b))| numeric_leaves(&format!("{path}.{index}"), a, b, out, maps));
    }
    if shift(before, after).is_none() {
        return false;
    }
    out.push(json!({"field":path,"before":before,"after":after}));
    true
}

/// Uniform shifts at map-keyed member paths, including JSON registers whose leaf budget
/// made the recorded edit a whole object. Exact keys keep the public footprint unambiguous.
fn member_shifts(mut out: Value) -> Value {
    for object in out.get_mut("changed").and_then(Value::as_array_mut).into_iter().flatten() {
        let Some(original) = object.get("edits").and_then(Value::as_array) else { continue };
        let mut edits = Vec::new();
        let mut maps = BTreeSet::new();
        for edit in original {
            let mut leaves = Vec::new();
            if let Some(path) = edit["field"].as_str()
                && (edit["before"].is_object() || edit["before"].is_array())
                && numeric_leaves(path, &edit["before"], &edit["after"], &mut leaves, &mut maps)
            {
                edits.extend(leaves);
            } else {
                edits.push(edit.clone());
            }
        }
        let mut groups: BTreeMap<(String, String), Vec<(usize, String)>> = BTreeMap::new();
        for (index, edit) in edits.iter().enumerate() {
            let Some(by) = shift(&edit["before"], &edit["after"]) else { continue };
            let Some(path) = edit["field"].as_str() else { continue };
            let segments: Vec<_> = path.split('.').collect();
            for (at, member) in segments.iter().enumerate().take(segments.len().saturating_sub(1)).skip(1) {
                if member.parse::<usize>().is_ok() && !maps.contains(&segments.iter().take(at).copied().collect::<Vec<_>>().join(".")) {
                    continue;
                }
                let pattern = segments.iter().enumerate().map(|(index, segment)| if index == at { "*" } else { *segment }).collect::<Vec<_>>();
                groups.entry((pattern.join("."), by.to_string())).or_default().push((index, (*member).into()));
            }
        }
        let mut covered = BTreeSet::new();
        let mut prints = Vec::new();
        for ((field, _), members) in groups {
            let members: Vec<_> = members.into_iter().filter(|(index, _)| !covered.contains(index)).collect();
            let keys: BTreeSet<_> = members.iter().map(|(_, key)| key).collect();
            if keys.len() < MIN_RUN || keys.len() != members.len() {
                continue;
            }
            let Some((first, _)) = members.first() else { continue };
            let Some(first) = edits.get(*first) else { continue };
            prints.push(json!({"field":field,"count":keys.len(),"keys":keys,"shift":{"by":shift(&first["before"],&first["after"])}}));
            covered.extend(members.into_iter().map(|(index, _)| index));
        }
        if prints.is_empty() {
            continue;
        }
        let edits: Vec<_> = edits.into_iter().enumerate().filter(|(index, _)| !covered.contains(index)).map(|(_, edit)| edit).chain(prints).collect();
        let fields: BTreeSet<_> = edits.iter().filter_map(|edit| edit["field"].as_str()).collect();
        let fields = json!(fields);
        object["edits"] = json!(edits);
        object["fields"] = fields;
    }
    out
}
