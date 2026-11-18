// Copied from kition-sdk crates/kition-kits/src/tools/selector.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Premises that name a list item by a member, not by its index:
//! `transform/opacity.keys[time=254016000000]`, `sequence.markers[id=7]`, `body.keys[time=2].value`.
//!
//! A path premise (`Premise::fields`) may hold one selector, `<list>[<member>=<value>]`, after the
//! path of a list (an object list or a json array), optionally followed by a path inside the
//! item. `<value>` is a JSON value (`7`, `"a b"`, `true`) or bare text; it matches an item whose
//! `<member>` is equal to it as JSON, or as text (`time=2` matches `2`, `2.0` and `"2"`).
//!
//! The guard resolves it against every journal entry since `basis`, newest first, from the list
//! as it is now: each entry's edits under the list (items created, deleted, moved and changed, or
//! the whole json list) are undone in turn, so the items' members are known before and after each
//! entry. The premise is touched by an entry by others that changed or removed an item matching it
//! (before or after the entry), or put in an item that matches it (created, moved in, or changed so
//! that it matches). Index shifts of other items do not touch it. What cannot be followed (a value
//! told as an excerpt, an edit of what holds the list, a list that cannot be read) touches it.

use serde_json::Value;

use super::guard::overlaps;
use super::journal::Entry;

/// A path premise with a selector.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Selector {
    pub(crate) path: String,
    /// The list's path from the object (`body.keys`, or in the kit's words `transform/opacity.keys`).
    pub(crate) list: String,
    pub(crate) member: String,
    value: Value,
    /// The path inside the item, when the premise names less than the whole item (`value`).
    rest: String,
}

impl Selector {
    /// `path` as a selector, when it holds one.
    pub(crate) fn parse(path: &str) -> Option<Self> {
        if path.starts_with('/') {
            return None;
        }
        let open = path.find('[')?;
        let (member, value) = path[open + 1..].split_once('=')?;
        let member = member.trim();
        let list = &path[..open];
        if member.is_empty() || list.is_empty() {
            return None;
        }
        let value = value.trim_start();
        // Let the JSON parser consume quoted delimiters and escapes before reading `]`.
        let mut values = serde_json::Deserializer::from_str(value).into_iter::<Value>();
        let parsed = values.next().and_then(Result::ok).and_then(|parsed| Some((parsed, value.get(values.byte_offset()..)?.trim_start().strip_prefix(']')?)));
        let (value, rest) = match parsed {
            Some(parsed) => parsed,
            None => {
                let close = value.find(']')?;
                (Value::String(value[..close].trim().to_owned()), &value[close + 1..])
            }
        };
        let rest = rest.strip_prefix('.').unwrap_or(rest);
        Some(Self { path: path.to_owned(), list: list.to_owned(), member: member.to_owned(), value, rest: rest.to_owned() })
    }

    /// Whether the list is named in the kit's words (`transform/opacity.keys`).
    fn named(&self) -> bool {
        self.list.contains(['/', '#'])
    }

    /// Whether an item whose member is `member` matches; `None` when it is not known.
    fn matches(&self, member: &Option<Value>) -> Option<bool> {
        let member = member.as_ref()?;
        if member == &self.value {
            return Some(true);
        }
        let text = |value: &Value| match value {
            Value::String(text) => Some(text.clone()),
            Value::Number(_) | Value::Bool(_) => Some(value.to_string()),
            _ => None,
        };
        let number = |value: &Value| value.as_f64().or_else(|| value.as_str()?.trim().parse::<f64>().ok());
        if let (Some(a), Some(b)) = (number(member), number(&self.value)) {
            return Some(a == b);
        }
        Some(matches!((text(member), text(&self.value)), (Some(a), Some(b)) if a == b))
    }

    /// The member of an item's value (a json item, or an object's values as a created or deleted
    /// one is told); `None` when the value does not say.
    fn member_of(&self, item: &Value) -> Option<Value> {
        self.member.split('.').try_fold(item, |at, key| at.get(key)).cloned()
    }

    /// Whether a change at `rest` inside a matching item touches the premise.
    fn inside(&self, rest: &str) -> bool {
        self.rest.is_empty() || rest.is_empty() || overlaps(rest, &self.rest) || overlaps(rest, &self.member)
    }
}

/// A JSON path with optional stable-member selectors, used when a window is inside JSON.
pub(crate) fn value_at<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    if path.starts_with('/') {
        return value.pointer(path);
    }
    if path.is_empty() {
        return Some(value);
    }
    if let Some(selector) = Selector::parse(path) {
        let list = value_at(value, &selector.list)?.as_array()?;
        let mut matching = list.iter().filter(|item| selector.matches(&selector.member_of(item)) == Some(true));
        let item = matching.next()?;
        if matching.next().is_some() {
            return None;
        }
        return value_at(item, &selector.rest);
    }
    path.split('.').try_fold(value, |at, key| match key.parse::<usize>() {
        Ok(i) => at.get(i),
        Err(_) => at.get(key),
    })
}

/// The list's items now, by their member's value (`None`: not known).
pub(crate) type Items = Vec<Option<Value>>;

/// Reconstruct a complete JSON value from one journal entry. Missing edit values cannot
/// establish equality and must propagate as unknown.
pub(crate) fn before_value(path: &str, after: &Value, change: &Value) -> Option<Value> {
    fn restore(at: &mut Value, path: &[&str], value: &Value) -> Option<()> {
        let (key, rest) = path.split_first()?;
        if let Some(object) = at.as_object_mut() {
            if rest.is_empty() {
                if value.is_null() {
                    object.remove(*key);
                } else {
                    object.insert((*key).to_owned(), value.clone());
                }
                return Some(());
            }
            return restore(object.entry((*key).to_owned()).or_insert_with(|| serde_json::json!({})), rest, value);
        }
        let at = at.get_mut(key.parse::<usize>().ok()?)?;
        if rest.is_empty() {
            *at = value.clone();
            Some(())
        } else {
            restore(at, rest, value)
        }
    }
    let mut before = after.clone();
    for field in change["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|field| overlaps(path, field)) {
        if !change["edits"].as_array().into_iter().flatten().any(|edit| edit["field"] == field) {
            return None;
        }
    }
    for edit in change["edits"].as_array().into_iter().flatten().filter(|edit| edit["field"].as_str().is_some_and(|field| overlaps(path, field))) {
        let value = edit.get("before")?;
        let field = edit["field"].as_str()?;
        if field == path {
            before = value.clone();
        } else if let Some(rest) = field.strip_prefix(path).and_then(|s| s.strip_prefix('.')) {
            restore(&mut before, &rest.split('.').collect::<Vec<_>>(), value)?;
        } else if let Some(rest) = path.strip_prefix(field).and_then(|s| s.strip_prefix('.')) {
            before = rest
                .split('.')
                .try_fold(value, |at, key| match key.parse::<usize>() {
                    Ok(i) => at.get(i),
                    Err(_) => at.get(key),
                })?
                .clone();
        }
    }
    Some(before)
}

/// Rebuild JSON lists before classifying selectors. Leaf diffs otherwise make a permutation
/// indistinguishable from edits of the selected item at its former index.
pub(crate) fn whole_entries(list: &str, now: &Value, entries: &[Entry], id: &str) -> Vec<Entry> {
    let mut entries = entries.to_vec();
    let mut after = now.clone();
    for entry in entries.iter_mut().rev() {
        let Some(change) = entry
            .changes
            .as_mut()
            .and_then(|c| c["changed"].as_array_mut())
            .and_then(|items| items.iter_mut().find(|i| id_text(&i["id"]).as_deref() == Some(id)))
        else {
            continue;
        };
        let edits = change["edits"].as_array().cloned().unwrap_or_default();
        let relevant: Vec<_> = edits.iter().filter(|e| e["field"].as_str().is_some_and(|f| overlaps(list, f))).collect();
        if relevant.is_empty() {
            continue;
        }
        let mut before = after.clone();
        let complete = relevant.iter().all(|edit| {
            let Some(value) = edit.get("before") else { return false };
            let field = edit["field"].as_str().unwrap();
            if field == list {
                before = value.clone();
                return true;
            }
            if let Some(rest) = field.strip_prefix(list).and_then(|s| s.strip_prefix('.')) {
                let mut at = &mut before;
                for key in rest.split('.') {
                    let next = match key.parse::<usize>() {
                        Ok(i) => at.get_mut(i),
                        Err(_) => at.get_mut(key),
                    };
                    let Some(next) = next else { return false };
                    at = next;
                }
                *at = value.clone();
                return true;
            }
            if let Some(rest) = list.strip_prefix(field).and_then(|s| s.strip_prefix('.')) {
                let Some(value) = rest.split('.').try_fold(value, |at, key| match key.parse::<usize>() {
                    Ok(i) => at.get(i),
                    Err(_) => at.get(key),
                }) else {
                    return false;
                };
                before = value.clone();
                return true;
            }
            false
        });
        if !complete || !before.is_array() {
            break;
        }
        let mut untouched: Vec<_> = edits.into_iter().filter(|e| !e["field"].as_str().is_some_and(|f| overlaps(list, f))).collect();
        untouched.push(serde_json::json!({"field":list,"before":before,"after":after}));
        change["edits"] = Value::Array(untouched);
        let mut fields: Vec<_> =
            change["fields"].as_array().into_iter().flatten().filter(|f| !f.as_str().is_some_and(|f| overlaps(list, f))).cloned().collect();
        fields.push(Value::String(list.to_owned()));
        change["fields"] = Value::Array(fields);
        after = before;
    }
    entries
}

/// One edit of an entry, relative to the selector's list.
enum ListEdit {
    /// The whole list (a json list told whole): before and after.
    Whole(Value, Value),
    /// Something holding the list, or a value it cannot follow.
    Opaque,
    Created(usize, Value),
    Deleted(usize, Value),
    /// An item changed at a path inside it (its index after the entry), with the value before.
    Changed(usize, String, Value),
    /// A move: from (an index in the list, or elsewhere) to (an index in the list, or elsewhere).
    Moved(Option<usize>, Option<usize>),
}

/// The positional path of the list in a change: the list itself when positional, else the edit
/// whose `named` path is under the named list tells it (`named` `transform/opacity.keys.2.value`
/// and field `props.children.2.keys.2.value` give `props.children.2.keys`).
pub(crate) fn positional(selector: &Selector, entries: &[&Entry], id: &str) -> Option<String> {
    if !selector.named() {
        return Some(selector.list.clone());
    }
    for edit in edits_of(entries, id) {
        let (Some(field), Some(named)) = (edit["field"].as_str(), edit["named"].as_str()) else { continue };
        let Some(suffix) = named.strip_prefix(selector.list.as_str()).filter(|suffix| suffix.is_empty() || suffix.starts_with('.')) else { continue };
        if let Some(list) = field.strip_suffix(suffix) {
            return Some(list.to_owned());
        }
    }
    None
}

fn edits_of<'a>(entries: &'a [&'a Entry], id: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
    entries.iter().filter_map(|entry| entry.changes.as_ref()).flat_map(move |changes| {
        changes["changed"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(move |item| item["id"].as_str() == Some(id) || id_text(&item["id"]).as_deref() == Some(id))
            .flat_map(|item| item["edits"].as_array().into_iter().flatten())
    })
}

fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// The edits of one entry's change of object `id` that concern the list at `list` (positional),
/// as [`ListEdit`]s; `named` also takes an edit whose `named` path is under the selector's list.
fn list_edits(change: &Value, list: &str, model: Option<&Value>) -> Vec<ListEdit> {
    let mut out = Vec::new();
    let index_of = |path: &str| -> Option<usize> { path.strip_prefix(list)?.strip_prefix('.')?.split('.').next()?.parse().ok() };
    // Only owned object records repeat descendants. A survivor's JSON edit can use the same
    // old index and null/object values, so the declared field kinds must distinguish them.
    let owned_object = |path: &str| -> Option<()> {
        let model = model?;
        let mut ty = change["type"].as_str()?;
        let mut parts = path.split('.').peekable();
        while let Some(field) = parts.next() {
            let def = &model["types"][ty]["fields"][field];
            match def["kind"].as_str()? {
                "list" | "tree" => {
                    parts.next()?.parse::<usize>().ok()?;
                }
                "map" if def["owns"] == true => {
                    parts.next()?;
                }
                "ref" if def["owns"] == true => {}
                _ => return None,
            }
            ty = def["of"].as_str()?;
            if parts.peek().is_none() {
                return Some(());
            }
        }
        None
    };
    let subtree = |edit: &Value| {
        owned_object(edit["field"].as_str()?)?;
        let (before, after) = (&edit["before"], &edit["after"]);
        if before.is_null() && after.is_object() {
            Some(false)
        } else if after.is_null() && before.is_object() {
            Some(true)
        } else {
            None
        }
    };
    let subtrees: Vec<_> = change["edits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|edit| {
            let deleted = subtree(edit)?;
            Some((edit["field"].as_str()?, deleted))
        })
        .collect();
    for edit in change["edits"].as_array().into_iter().flatten() {
        let Some(field) = edit["field"].as_str() else { continue };
        if let Some(deleted) = subtree(edit)
            && subtrees.iter().any(|(parent, side)| *side == deleted && field.strip_prefix(parent).is_some_and(|rest| rest.starts_with('.')))
        {
            continue;
        }
        let (before, after) = (&edit["before"], &edit["after"]);
        if field == list {
            // A move (paths before and after), else the whole json list.
            if before.is_string() || after.is_string() {
                out.push(ListEdit::Moved(before.as_str().and_then(index_of), after.as_str().and_then(index_of)));
            } else if before.is_array() && after.is_array() {
                out.push(ListEdit::Whole(before.clone(), after.clone()));
            } else {
                out.push(ListEdit::Opaque);
            }
            continue;
        }
        // A json value holding the list told whole (`sequence.captionTracks` for the list
        // `sequence.captionTracks.0.captions`): the list read inside it before and after; unchanged
        // there, nothing; else, what holds the list (`body`) is not followed.
        if overlaps(field, list) && !field.starts_with(&format!("{list}.")) {
            let inside = |value: &Value| -> Option<Value> {
                list.strip_prefix(field)?.strip_prefix('.')?.split('.').try_fold(value.clone(), |value, key| match key.parse::<usize>() {
                    Ok(index) => value.get(index).cloned(),
                    Err(_) => value.get(key).cloned(),
                })
            };
            match (inside(before), inside(after)) {
                (Some(was), Some(now)) if was == now => {}
                (Some(was), Some(now)) if was.is_array() && now.is_array() => out.push(ListEdit::Whole(was, now)),
                _ => out.push(ListEdit::Opaque),
            }
            continue;
        }
        let Some(rest) = field.strip_prefix(list).and_then(|rest| rest.strip_prefix('.')) else { continue };
        let (index, inner) = match rest.split_once('.') {
            Some((index, inner)) => (index, inner),
            None => (rest, ""),
        };
        let Ok(index) = index.parse::<usize>() else {
            out.push(ListEdit::Opaque);
            continue;
        };
        match (inner.is_empty(), before.is_null(), after.is_null()) {
            (true, true, false) => out.push(ListEdit::Created(index, after.clone())),
            (true, false, true) => out.push(ListEdit::Deleted(index, before.clone())),
            _ => out.push(ListEdit::Changed(index, inner.to_owned(), before.clone())),
        }
    }
    // Fields told without an edit under the list: not followed.
    let told = |field: &str| change["edits"].as_array().into_iter().flatten().any(|edit| edit["field"].as_str() == Some(field));
    for field in change["fields"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        // The list's own field is named beside its items' edits (`body.keys`): nothing more.
        if (field.starts_with(&format!("{list}.")) || (overlaps(field, list) && field.len() < list.len())) && !told(field) {
            out.push(ListEdit::Opaque);
        }
    }
    out
}

/// Whether any entry by others (`author != agent`) changed something at or under `list` (or what
/// holds it) for object `id`: when none did, the premise holds without reading the list.
pub(crate) fn others_touch(entries: &[&Entry], id: &str, list: &str, agent: &str) -> bool {
    entries.iter().filter(|entry| entry.author != agent).filter_map(|entry| entry.changes.as_ref()).any(|changes| {
        changes["changed"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| id_text(&item["id"]).as_deref() == Some(id))
            .any(|item| item["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).any(|field| overlaps(field, list)))
    })
}

/// Whether an entry by others touched the premise `selector` on object `id`, replayed back from
/// `now` (the list's items now, by member) through `entries` (oldest first, everyone's), with
/// `list` the list's positional path. `now: None`: the list could not be read, and any entry by
/// others that changed it touches the premise.
pub(crate) fn touched(selector: &Selector, list: &str, now: Option<Items>, entries: &[&Entry], id: &str, agent: &str, model: Option<&Value>) -> bool {
    let mut state = now;
    for entry in entries.iter().rev() {
        let others = entry.author != agent;
        let Some(changes) = &entry.changes else {
            if others {
                return true;
            }
            state = None;
            continue;
        };
        let edits: Vec<ListEdit> = changes["changed"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| id_text(&item["id"]).as_deref() == Some(id))
            .flat_map(|item| list_edits(item, list, model))
            .collect();
        if edits.is_empty() {
            continue;
        }
        let Some(items) = state.as_mut() else {
            if others {
                return true;
            }
            continue;
        };
        match step_back(selector, items, &edits) {
            Some(hit) => {
                if others && hit {
                    return true;
                }
            }
            None => {
                if others {
                    return true;
                }
                state = None;
            }
        }
    }
    false
}

/// Classify a name selector using an explicitly declared stable member identity. Reconstruct
/// its identity at `basis`, then follow that entry and the name's assignment at each save.
#[allow(clippy::too_many_arguments)]
pub(crate) fn named_reason(
    selector: &Selector,
    identity: &str,
    list: &str,
    now: Option<Items>,
    keys: Option<Items>,
    entries: &[&Entry],
    id: &str,
    agent: &str,
    model: Option<&Value>,
) -> Option<&'static str> {
    let (Some(now), Some(keys)) = (now, keys) else { return Some("unknown") };
    let valid = |names: &Items, keys: &Items| {
        let mut seen = std::collections::BTreeSet::new();
        names.len() == keys.len() && keys.iter().all(|key| key.as_ref().is_some_and(|key| (key.is_string() || key.is_number()) && seen.insert(key.to_string())))
    };
    let edits = |entry: &Entry| {
        entry.changes.as_ref().map(|changes| {
            changes["changed"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| id_text(&item["id"]).as_deref() == Some(id))
                .flat_map(|item| list_edits(item, list, model))
                .collect::<Vec<_>>()
        })
    };
    let mut key_selector = selector.clone();
    key_selector.member = identity.to_owned();
    key_selector.rest.clear();
    let rewind = |names: &mut Items, keys: &mut Items, edits: &[ListEdit]| -> Option<()> {
        step_back(selector, names, edits)?;
        step_back(&key_selector, keys, edits)?;
        valid(names, keys).then_some(())
    };
    if identity.is_empty() || !valid(&now, &keys) {
        return Some("unknown");
    }
    let (mut names, mut identities) = (now.clone(), keys.clone());
    for entry in entries.iter().rev() {
        let Some(edits) = edits(entry) else { return Some("unknown") };
        if rewind(&mut names, &mut identities, &edits).is_none() {
            return Some("unknown");
        }
    }
    let matching = |names: &Items, keys: &Items| -> Option<Vec<Value>> {
        let mut found = Vec::new();
        for (name, key) in names.iter().zip(keys) {
            if selector.matches(name)? {
                found.push(key.clone()?);
            }
        }
        Some(found)
    };
    let Some(basis) = matching(&names, &identities) else { return Some("unknown") };
    if basis.len() > 1 {
        return Some("unknown");
    }
    let basis_key = basis.first();
    let selected_name =
        |names: &Items, keys: &Items| keys.iter().position(|key| key.as_ref() == basis_key).and_then(|index| names.get(index).cloned()).flatten();
    let (mut names, mut identities) = (now.clone(), keys);
    let mut reason = None;
    for entry in entries.iter().rev() {
        let after = selected_name(&names, &identities);
        let after_matching = matching(&names, &identities);
        let Some(edits) = edits(entry) else { return Some("unknown") };
        if rewind(&mut names, &mut identities, &edits).is_none() {
            return Some("unknown");
        }
        if entry.author == agent {
            continue;
        }
        let before = selected_name(&names, &identities);
        let Some(before_matching) = matching(&names, &identities) else { return Some("unknown") };
        let Some(after_matching) = after_matching else { return Some("unknown") };
        if before_matching.len() > 1 || after_matching.len() > 1 {
            return Some("unknown");
        }
        if before.is_some() && after.is_none() && after_matching.is_empty() {
            reason = Some("deleted");
        } else if (before != after || before_matching != after_matching) && reason != Some("deleted") {
            reason = Some("relocated");
        }
    }
    reason.or_else(|| touched(selector, list, Some(now), entries, id, agent, model).then_some("changed"))
}

/// An indexed JSON resource with an explicitly declared stable member identity.
pub(crate) struct Indexed {
    pub(crate) list: String,
    index: usize,
    rest: String,
}

impl Indexed {
    pub(crate) fn parse(path: &str) -> Option<Self> {
        let parts: Vec<_> = path.split('.').collect();
        let (at, index) = parts.iter().enumerate().skip(1).find_map(|(at, part)| part.parse::<usize>().ok().map(|index| (at, index)))?;
        Some(Self { list: parts[..at].join("."), index, rest: parts[at + 1..].join(".") })
    }

    pub(crate) fn reason(&self, identity: &str, now: Option<Value>, entries: &[Entry], id: &str, agent: &str) -> Option<&'static str> {
        let Some(mut after) = now else { return Some("unknown") };
        let occupant = |value: &Value| -> Option<Option<Value>> {
            let list = value.as_array()?;
            let mut seen = std::collections::BTreeSet::new();
            for item in list {
                let key = value_at(item, identity)?;
                if !(key.is_string() || key.is_number()) || !seen.insert(key.to_string()) {
                    return None;
                }
            }
            Some(list.get(self.index).and_then(|item| value_at(item, identity)).cloned())
        };
        let mut reason = None;
        for entry in entries.iter().rev() {
            let Some(changes) = &entry.changes else { return Some("unknown") };
            let Some(change) = changes["changed"].as_array().into_iter().flatten().find(|item| id_text(&item["id"]).as_deref() == Some(id)) else { continue };
            let Some(before) = before_value(&self.list, &after, change) else { return Some("unknown") };
            let (Some(was), Some(now)) = (occupant(&before), occupant(&after)) else { return Some("unknown") };
            if entry.author != agent {
                if was != now {
                    reason = Some("relocated");
                } else if value_at(&before[self.index], &self.rest) != value_at(&after[self.index], &self.rest) && reason.is_none() {
                    reason = Some("changed");
                }
            }
            after = before;
        }
        reason
    }
}

/// Undoes one entry's `edits` on `items` (after the entry → before it): whether the entry touched
/// the premise; `None` when it cannot be followed.
fn step_back(selector: &Selector, items: &mut Items, edits: &[ListEdit]) -> Option<bool> {
    let mut hit = false;
    let mut unsure = false;
    let mut flag = |matched: Option<bool>| match matched {
        Some(true) => hit = true,
        Some(false) => {}
        None => unsure = true,
    };
    if edits.iter().any(|edit| matches!(edit, ListEdit::Opaque)) {
        return None;
    }
    if let Some(ListEdit::Whole(before, after)) = edits.iter().find(|edit| matches!(edit, ListEdit::Whole(..))) {
        let matching = |list: &Value| -> Option<Vec<Value>> {
            let mut found = Vec::new();
            for item in list.as_array()? {
                if selector.matches(&selector.member_of(item))? {
                    found.push(item.clone());
                }
            }
            Some(found)
        };
        let (was, now) = (matching(before)?, matching(after)?);
        *items = before.as_array()?.iter().map(|item| selector.member_of(item)).collect();
        let touched = match selector.rest.as_str() {
            "" => was != now,
            rest => {
                was.len() != now.len()
                    || was.iter().zip(&now).any(|(a, b)| {
                        let path: Vec<&str> = rest.split('.').collect();
                        let at = |value: &Value| path.iter().try_fold(value.clone(), |value, key| value.get(*key).cloned());
                        at(a) != at(b)
                    })
            }
        };
        return Some(touched);
    }
    // Changed items, at their indexes after the entry.
    for edit in edits {
        if let ListEdit::Changed(index, inner, before) = edit {
            let slot = items.get_mut(*index)?;
            let after_match = selector.matches(slot);
            if inner == &selector.member {
                *slot = Some(before.clone());
            } else if inner.is_empty() {
                *slot = selector.member_of(before);
            } else if overlaps(inner, &selector.member) {
                *slot = None;
            }
            let before_match = selector.matches(slot);
            if selector.inside(inner) {
                flag(match (after_match, before_match) {
                    (Some(a), Some(b)) => Some(a || b),
                    (Some(true), _) | (_, Some(true)) => Some(true),
                    _ => None,
                });
            } else if after_match != before_match {
                // Changed so that it matches, or no longer does: another item is named.
                flag(Some(true));
            }
        }
    }
    // Put in by the entry (indexes after it): taken out, last first.
    let mut taken: Vec<(usize, Option<Value>, bool)> = Vec::new();
    for edit in edits {
        match edit {
            ListEdit::Created(index, after) => taken.push((*index, selector.member_of(after), true)),
            ListEdit::Moved(_, Some(index)) => taken.push((*index, None, false)),
            _ => {}
        }
    }
    taken.sort_by_key(|item| std::cmp::Reverse(item.0));
    let mut carried: Vec<Option<Value>> = Vec::new();
    for (index, member, created) in taken {
        if index >= items.len() {
            return None;
        }
        let value = items.remove(index);
        if created {
            flag(selector.matches(&member).or(selector.matches(&value)));
        } else {
            carried.push(value);
        }
    }
    // Taken out by the entry (indexes before it): put back, first first.
    let mut put: Vec<(usize, Option<Value>, Option<bool>)> = Vec::new();
    for edit in edits {
        match edit {
            ListEdit::Deleted(index, before) => {
                let member = selector.member_of(before);
                put.push((*index, member.clone(), Some(selector.matches(&member).unwrap_or(true))));
            }
            ListEdit::Moved(Some(index), to) => {
                // Within the list: the item it carried; out of it: not known.
                let value = if to.is_some() { carried.pop().flatten() } else { None };
                let out = to.is_none();
                put.push((*index, value.clone(), out.then(|| selector.matches(&value).unwrap_or(true))));
            }
            _ => {}
        }
    }
    // Moved in from elsewhere: matching it puts a new item under the premise.
    let moved_in = edits.iter().filter(|edit| matches!(edit, ListEdit::Moved(None, Some(_)))).count();
    if moved_in > 0 {
        flag(None);
    }
    put.sort_by_key(|item| item.0);
    for (index, member, touches) in put {
        if index > items.len() {
            return None;
        }
        items.insert(index, member);
        if let Some(touches) = touches {
            flag(Some(touches));
        }
    }
    if unsure {
        return Some(true);
    }
    Some(hit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(author: &str, edits: Value) -> Entry {
        Entry {
            seq: 1,
            author: author.to_owned(),
            changes: Some(json!({ "created": [], "deleted": [], "moved": [], "changed": [{ "id": "r", "type": "R", "fields": [], "edits": edits }] })),
        }
    }

    #[test]
    fn named_json_selectors_parse_quoted_delimiters() {
        for name in ["A]B", "A=B", "A\"B", "A\\B", "[Alpha]"] {
            let path = format!("channels[name={}].value", json!(name));
            let selector = Selector::parse(&path).unwrap();
            assert_eq!(selector.matches(&Some(json!(name))), Some(true), "{path}");
            assert_eq!(selector.rest, "value", "{path}");
        }
    }

    #[test]
    fn named_json_identity_follows_history_and_refuses_ambiguous_keys() {
        let s = Selector::parse("channels[name=Alpha]").unwrap();
        let rename = entry("other", json!([{ "field": "channels.0.name", "before": "Alpha", "after": "Away" }]));
        let restore = entry("other", json!([{ "field": "channels.0.name", "before": "Away", "after": "Alpha" }]));
        let names = || Some(vec![Some(json!("Alpha"))]);
        let keys = || Some(vec![Some(json!("stable"))]);
        assert_eq!(named_reason(&s, "key", "channels", names(), keys(), &[&rename, &restore], "r", "me", None), Some("relocated"));
        let mine = entry("me", rename.changes.as_ref().unwrap()["changed"][0]["edits"].clone());
        assert_eq!(named_reason(&s, "key", "channels", Some(vec![Some(json!("Away"))]), keys(), &[&mine], "r", "me", None), None);
        let deleted = entry("other", json!([{ "field": "channels", "before": [{ "key": "stable", "name": "Alpha" }], "after": [] }]));
        assert_eq!(named_reason(&s, "key", "channels", Some(vec![]), Some(vec![]), &[&deleted], "r", "me", None), Some("deleted"));
        assert_eq!(named_reason(&s, "key", "channels", names(), Some(vec![None]), &[&rename], "r", "me", None), Some("unknown"));
        assert_eq!(
            named_reason(
                &s,
                "key",
                "channels",
                Some(vec![Some(json!("Alpha")), Some(json!("Beta"))]),
                Some(vec![Some(json!(1)), Some(json!(1))]),
                &[],
                "r",
                "me",
                None
            ),
            Some("unknown")
        );
        assert_eq!(named_reason(&s, "key", "channels", None, keys(), &[&rename], "r", "me", None), Some("unknown"));
    }

    #[test]
    fn a_selector_is_parsed_and_matches_by_json_or_text() {
        let s = Selector::parse("transform/opacity.keys[time=254016000000]").unwrap_or_else(|| panic!("parsed"));
        assert_eq!((s.list.as_str(), s.member.as_str(), s.rest.as_str()), ("transform/opacity.keys", "time", ""));
        assert_eq!(s.matches(&Some(json!("254016000000"))), Some(true));
        assert_eq!(s.matches(&Some(json!(254016000000_u64))), Some(true));
        assert_eq!(s.matches(&Some(json!(1))), Some(false));
        let s = Selector::parse("captions[name=\"a b\"].text").unwrap_or_else(|| panic!("parsed"));
        assert_eq!((s.value.clone(), s.rest.as_str()), (json!("a b"), "text"));
        assert!(Selector::parse("body.keys.2").is_none());
    }

    /// Keys at 1, 2, 3 (the agent keyed 2): a change of the key at 2, then a key added at 1.5 in
    /// a second save: touched, though the index of the key at 2 shifted after its change.
    #[test]
    fn a_change_then_an_insert_before_is_followed_across_saves() {
        let s = Selector::parse("keys[time=2]").unwrap_or_else(|| panic!("parsed"));
        let first = entry("other", json!([{ "field": "keys.1.value", "before": 20, "after": 25 }]));
        let second = entry("other", json!([{ "field": "keys.1", "before": null, "after": { "time": 1.5, "value": 15 } }]));
        let now: Items = [1.0, 1.5, 2.0, 3.0].iter().map(|t| Some(json!(t))).collect();
        assert!(touched(&s, "keys", Some(now.clone()), &[&first, &second], "r", "me", None));
        assert!(!touched(&s, "keys", Some(now), &[&second], "r", "me", None), "an insert before it alone does not");
        let after = entry("other", json!([{ "field": "keys.3", "before": null, "after": { "time": 3.5, "value": 35 } }]));
        let now: Items = [1.0, 2.0, 3.0, 3.5].iter().map(|t| Some(json!(t))).collect();
        assert!(!touched(&s, "keys", Some(now), &[&after], "r", "me", None));
        let theirs = entry("other", json!([{ "field": "keys.2.value", "before": 30, "after": 31 }]));
        let now: Items = [1.0, 2.0, 3.0].iter().map(|t| Some(json!(t))).collect();
        assert!(!touched(&s, "keys", Some(now), &[&theirs], "r", "me", None), "another key's change");
    }

    #[test]
    fn a_whole_json_list_is_compared_by_its_matching_items() {
        let s = Selector::parse("markers[id=7]").unwrap_or_else(|| panic!("parsed"));
        let added = entry("other", json!([{ "field": "markers", "before": [{ "id": 7, "name": "a" }], "after": [{ "id": 9 }, { "id": 7, "name": "a" }] }]));
        assert!(!touched(&s, "markers", Some(vec![Some(json!(9)), Some(json!(7))]), &[&added], "r", "me", None));
        let renamed = entry("other", json!([{ "field": "markers", "before": [{ "id": 7, "name": "a" }], "after": [{ "id": 9 }, { "id": 7, "name": "b" }] }]));
        assert!(touched(&s, "markers", Some(vec![Some(json!(9)), Some(json!(7))]), &[&renamed], "r", "me", None));
        // The list inside a json value told whole: unchanged there, nothing; changed, compared.
        let s = Selector::parse("seq.tracks.0.captions[id=7]").unwrap_or_else(|| panic!("parsed"));
        let tracks = |captions: Value, other: Value| json!([{ "captions": captions }, { "captions": other }]);
        let other_track = entry(
            "other",
            json!([{ "field": "seq.tracks", "before": tracks(json!([{ "id": 7, "text": "a" }]), json!([])), "after": tracks(json!([{ "id": 7, "text": "a" }]), json!([{ "id": 8 }])) }]),
        );
        assert!(!touched(&s, "seq.tracks.0.captions", Some(vec![Some(json!(7))]), &[&other_track], "r", "me", None));
        let this_track = entry(
            "other",
            json!([{ "field": "seq.tracks", "before": tracks(json!([{ "id": 7, "text": "a" }]), json!([])), "after": tracks(json!([{ "id": 7, "text": "b" }]), json!([])) }]),
        );
        assert!(touched(&s, "seq.tracks.0.captions", Some(vec![Some(json!(7))]), &[&this_track], "r", "me", None));
        let s = Selector::parse("markers[id=7]").unwrap_or_else(|| panic!("parsed"));
        let excerpt = entry("other", json!([{ "field": "markers", "before": { "size": 9000 }, "after": { "size": 9100 } }]));
        assert!(touched(&s, "markers", None, &[&excerpt], "r", "me", None), "not followed: touched");
    }
}
