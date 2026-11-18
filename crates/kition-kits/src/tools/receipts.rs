// Copied from kition-sdk crates/kition-kits/src/tools/receipts.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Receipts: every accepted write of `<prefix>_run` and `<prefix>_batch` answers what it
//! changed, so an agent need not inspect again to see it. The SDK computes it from the document's
//! data model, with no work in the kits:
//!
//! - `changes`: the change set of the whole call (KDM `Replica::changes_since`, through the Kit
//!   Process Protocol's `model.version` before the first step and `model.changes` after the last),
//!   objects named by the ids the tools use (tool ids where the kit declares them); at most
//!   [`DEFAULT_CAP`] objects across its lists unless the call asks `changes: "all"`, with
//!   `truncated` counting what was left out; `changes: false` leaves it out.
//! - `revision`: the document's revision after the call (`journal.rs`), set by the caller from
//!   the change set this records ([`Recorded`]), whatever the call asked to be answered.
//! - `changesUnavailable`: why there is no change set (`changes` is then `null`): a kit without an
//!   object model, a document replaced while the call ran, a file open in an editor that does not
//!   list the capability `changes`. Never an empty change set, which would read as "nothing
//!   changed".
//!
//! A file open in an editor that lists `changes` (C3b) gets the same receipt: the editor answers
//! the bridge's `version`, `changes` and `check` from its replica ([`Source::Editor`]).
//! - `diagnostics: { new, resolved }`: the kit's check (`document.check`) before the first step and
//!   after the last, matched by `code` and `target`; `check: false` skips both checks.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use super::errors::KitToolError;
use crate::bridge::LiveDocument;
use crate::manager::{Caller, KitError, KitManager};

/// How many objects a receipt lists at most across `created`, `changed`, `moved` and `deleted`.
pub const DEFAULT_CAP: usize = 50;

/// The lists of a change set, in the order a cut receipt keeps their objects.
const LISTS: [&str; 4] = ["created", "changed", "moved", "deleted"];

/// What a call asks of its receipt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Wanted {
    /// `changes`: `None` for `false`, else the most objects listed (`None` inside for `"all"`).
    pub changes: Option<Option<usize>>,
    /// `check`: run the kit's check before and after.
    pub check: bool,
}

/// `changes` (`true`, absent: capped; `false`; `"all"`) and `check` (a boolean, `true` when absent).
pub fn wanted(input: &Value) -> Result<Wanted, KitToolError> {
    let changes = match input.get("changes") {
        None | Some(Value::Null) | Some(Value::Bool(true)) => Some(Some(DEFAULT_CAP)),
        Some(Value::Bool(false)) => None,
        Some(Value::String(all)) if all == "all" => Some(None),
        Some(other) => {
            return Err(KitToolError::invalid(format!(
                "`changes` is {other}: true (the default: what the call changed, at most {DEFAULT_CAP} objects), \"all\" (every object), or false (leave it out)"
            )));
        }
    };
    let check = match input.get("check") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(check)) => *check,
        Some(other) => return Err(KitToolError::invalid(format!("`check` is {other}: a boolean (true by default)"))),
    };
    Ok(Wanted { changes, check })
}

/// What a write changed, for the document's journal: its whole change set, whatever the call
/// asked to be answered.
#[derive(Clone, Debug, PartialEq)]
pub enum Recorded {
    Changes(Value),
    /// The kit has an object model but could not say (the document was replaced meanwhile).
    Unknown,
    /// The kit has no object model.
    NoModel,
}

/// What was read before the first step.
pub struct Before {
    /// The document's version, or why it has none (and whether that is for want of an object
    /// model).
    version: Result<String, (String, bool)>,
    /// The kit's diagnostics, when it checks documents and the call asked for them.
    diagnostics: Option<Vec<Value>>,
    editor_model: Option<Map<String, Value>>,
    projected: bool,
    projection_model: Option<Map<String, Value>>,
}

/// Why a kit cannot say what changed, from its answer to `model.version` or `model.changes`, and
/// whether that is for want of an object model.
fn unavailable(kit_name: &str, error: &KitError) -> (String, bool) {
    let text = error.to_string();
    if text.contains("method not found") || text.contains("has no object model") {
        (format!("{kit_name} has no object model, so it cannot say which objects a call changed"), true)
    } else {
        (format!("{kit_name} could not say what changed: {text}"), false)
    }
}

/// Where a receipt reads the document: a kit session's document through the Kit Process Protocol, or
/// the document in its open editor through the Kit AI bridge, when the editor lists the capability
/// `changes` (C3b: the bridge's `version`, `changes` and `check`, answered from the editor's
/// replica as `model.version`, `model.changes` and `document.check` are).
#[derive(Clone, Copy)]
pub enum Source<'a> {
    Kit { kit_id: &'a str, document_id: &'a str },
    Editor(&'a LiveDocument),
}

impl Source<'_> {
    async fn snapshot(&self, kits: &KitManager) -> Option<Map<String, Value>> {
        match self {
            Self::Kit { kit_id, document_id } => {
                let view = kits.document(Caller::Agent, kit_id, document_id).await.ok()?;
                super::guard::objects(kits, &view).await
            }
            Self::Editor(document) => super::derived::editor_snapshot(kits, document).await,
        }
    }
    /// `model.version` or `model.changes` (`method`), with `params`.
    async fn model(&self, kits: &KitManager, kit_name: &str, method: &str, params: Map<String, Value>) -> Result<Value, (String, bool)> {
        match self {
            Self::Kit { kit_id, document_id } => {
                kits.model(Caller::Agent, kit_id, document_id, method, params).await.map_err(|error| unavailable(kit_name, &error))
            }
            Self::Editor(document) => {
                let tool = if method == "model.version" { "version" } else { "changes" };
                kits.bridge()
                    .call(document, tool, Value::Object(params))
                    .await
                    .map_err(|failure| (format!("{kit_name} could not say what changed in its open editor: {}", failure.message), false))
            }
        }
    }

    /// A batch of no operations that only loads `load`, sent as the agent: its answer.
    pub(crate) async fn load(&self, kits: &KitManager, load: Value) -> Option<Value> {
        let request = json!({ "origin": super::model::agent_origin(), "ops": [], "load": load });
        match self {
            Self::Kit { kit_id, document_id } => {
                let Value::Object(params) = request else { return None };
                kits.model(Caller::Agent, kit_id, document_id, "model.batch", params).await.ok()
            }
            Self::Editor(document) => kits.bridge().call(document, "batch", request).await.ok(),
        }
    }

    /// What the kit's object model describes (`model.describe`), as this server keeps it; a kit
    /// session is asked when the server has not read it yet.
    pub(crate) async fn described(&self, kits: &KitManager) -> Option<Value> {
        match self {
            Self::Kit { kit_id, document_id } => match kits.described(kit_id) {
                Some(described) => Some(described),
                None => kits.model(Caller::Agent, kit_id, document_id, "model.describe", Map::new()).await.ok(),
            },
            // The open editor is asked nothing more for an answer: what the server has read of
            // its description, if anything.
            Self::Editor(document) => kits.described(&document.kit),
        }
    }

    async fn diagnostics(&self, kits: &KitManager) -> Option<Vec<Value>> {
        match self {
            Self::Kit { kit_id, document_id } => match kits.check(Caller::Agent, kit_id, document_id).await {
                Ok(Some(answer)) => answer["diagnostics"].as_array().cloned(),
                _ => None,
            },
            Self::Editor(document) => kits.bridge().call(document, "check", json!({})).await.ok()?["diagnostics"].as_array().cloned(),
        }
    }
}

/// The document's version (`model.version`), or why there is none. In the open editor, the
/// version the call's journal was just brought up to, when it was (C3b).
async fn version(kits: &KitManager, kit_name: &str, source: Source<'_>) -> Result<String, (String, bool)> {
    if let (Source::Editor(_), Some(version)) = (source, super::version_before()) {
        return Ok(version);
    }
    let answer = source.model(kits, kit_name, "model.version", Map::new()).await?;
    answer["version"].as_str().map(str::to_owned).ok_or_else(|| (format!("{kit_name} answered no version"), false))
}

/// Reads what the receipt compares against, before the first step: the version always, since the
/// document's journal records every write's change set.
pub async fn before(kits: &KitManager, kit_name: &str, source: Source<'_>, wanted: Wanted) -> Before {
    let version = version(kits, kit_name, source).await;
    // The derived values before the write, read once for a document this server holds none of
    //.
    if let (Source::Kit { kit_id, document_id }, Ok(version)) = (source, &version) {
        super::derived::before_write(kits, kit_id, document_id, version, source.described(kits).await.as_ref()).await;
    }
    let diagnostics = if wanted.check { source.diagnostics(kits).await } else { None };
    let editor_model = match source {
        Source::Editor(document) => super::derived::editor_snapshot(kits, document).await,
        _ => None,
    };
    let projected =
        source.described(kits).await.is_some_and(|schema| schema["types"].as_object().into_iter().flatten().any(|(_, def)| def["projected"] == true));
    let projection_model = if projected {
        match source {
            Source::Editor(_) => editor_model.clone(),
            _ => source.snapshot(kits).await,
        }
    } else {
        None
    };
    Before { version, diagnostics, editor_model, projected, projection_model }
}

/// Supplement native changes with computed objects, including unsaved human editor edits.
pub(crate) fn projected_changes(
    described: Option<&Value>,
    before: Option<&Map<String, Value>>,
    after: Option<&Map<String, Value>>,
    changes: &mut Value,
) -> Result<(), &'static str> {
    let Some(described) = described.filter(|schema| schema["types"].as_object().into_iter().flatten().any(|(_, def)| def["projected"] == true)) else {
        return Ok(());
    };
    let (Some(before), Some(after)) = (before, after) else { return Err("projected objects could not be compared before and after this write") };
    let schema = crate::drafts::schema_of(described).map_err(|_| "projected schema unavailable")?;
    let projected = |item: &Value| item["type"].as_str().is_some_and(|ty| schema.types.get(ty).is_some_and(|def| def.projected));
    let diff = kition_kdm::diff::diff_states(&json!({"objects":before}), &json!({"objects":after})).to_recorded_json(&schema);
    for list in LISTS {
        let items = changes[list].as_array_mut().ok_or("projected change lists unavailable")?;
        items.retain(|item| !projected(item));
        items.extend(diff[list].as_array().into_iter().flatten().filter(|item| projected(item)).cloned());
    }
    for key in ["$text", "$marks"] {
        for (id, value) in diff[key].as_object().into_iter().flatten() {
            changes[key][id] = value.clone();
        }
    }
    Ok(())
}

/// Adds the receipt to a successful call's `answer`: `changes` (or `changes: null` and
/// `changesUnavailable`) and `diagnostics: { new, resolved }`; and records the whole change set
/// for the document's journal, which the caller reads ([`super::recorded`]).
pub async fn add(kits: &KitManager, kit_name: &str, source: Source<'_>, before: Before, wanted: Wanted, answer: &mut Value) {
    let unavailable_as = |answer: &mut Value, why: String| {
        if wanted.changes.is_some() {
            set_unavailable(answer, why);
        }
    };
    let recorded = match &before.version {
        Ok(since) => {
            let mut params = Map::new();
            params.insert("since".into(), Value::String(since.clone()));
            let mut found = source.model(kits, kit_name, "model.changes", params).await;
            if before.projected && found.is_ok() {
                let now = source.snapshot(kits).await;
                let described = source.described(kits).await;
                if let Ok(answer) = &mut found
                    && let Err(why) = projected_changes(described.as_ref(), before.projection_model.as_ref(), now.as_ref(), &mut answer["changes"])
                {
                    found = Err((why.into(), false));
                }
            }
            match found {
                Ok(found) => match found.get("changes").filter(|changes| changes.is_object()) {
                    Some(changes) if matches!(source, Source::Editor(_)) => {
                        let mut changes = changes.clone();
                        if let Source::Editor(document) = source {
                            let after = super::derived::editor_snapshot(kits, document).await;
                            super::derived::editor_changes(before.editor_model.as_ref(), after.as_ref(), &mut changes);
                            super::derived::privatize(&mut changes, source.described(kits).await.as_ref());
                        }
                        super::carried::mark_from(kits, source, &mut changes).await;
                        // The editor's replica is followed from after this write (C3b).
                        if let Some(version) = found["version"].as_str() {
                            super::saw_version(version.to_owned());
                        }
                        if let Some(cap) = wanted.changes {
                            answer["changes"] = shown(kits, source, &changes, cap).await;
                        }
                        Recorded::Changes(changes)
                    }
                    Some(changes) => {
                        // The derived values the write changed.
                        let mut changes = changes.clone();
                        if let Source::Kit { kit_id, document_id } = source {
                            let described = source.described(kits).await;
                            super::derived::after_write(kits, kit_id, document_id, described.as_ref(), since, found["version"].as_str(), &mut changes).await;
                            // What the changes carry with them.
                            super::carried::mark(kits, kit_id, document_id, &mut changes).await;
                        }
                        if let Some(cap) = wanted.changes {
                            answer["changes"] = shown(kits, source, &changes, cap).await;
                        }
                        Recorded::Changes(changes)
                    }
                    None => {
                        let why = found["unavailable"].as_str().unwrap_or("the kit did not say why");
                        unavailable_as(answer, format!("the document was replaced while the call ran, so what it changed is not known ({why})"));
                        Recorded::Unknown
                    }
                },
                Err((why, no_model)) => {
                    unavailable_as(answer, why);
                    if no_model { Recorded::NoModel } else { Recorded::Unknown }
                }
            }
        }
        Err((why, no_model)) => {
            unavailable_as(answer, why.clone());
            if *no_model { Recorded::NoModel } else { Recorded::Unknown }
        }
    };
    super::record(recorded);
    if let Some(was) = before.diagnostics
        && let Some(now) = source.diagnostics(kits).await
    {
        answer["diagnostics"] = delta(&was, &now);
    }
}

/// A change set as an answer shows it (`changes`, and `others` through [`compacted`]): a shift of
/// many objects stated once (`footprint`) unless the call asked for `"all"`, at most
/// `cap` objects, and integer tool ids as numbers ([`IdForm`]). The journal keeps the change set as
/// it was, object by object.
async fn shown(kits: &KitManager, source: Source<'_>, changes: &Value, cap: Option<usize>) -> Value {
    let set = match cap {
        Some(_) => compacted(kits, source, changes).await,
        None => changes.clone(),
    };
    let mut set = capped(set, cap);
    IdForm::of(source.described(kits).await.as_ref()).changes(&mut set);
    unrecorded(&mut set);
    set
}

/// A change set as answers show it: without what only the journal keeps (a deleted object's
/// `$was`, the times the premise guard replays).
pub(crate) fn unrecorded(set: &mut Value) {
    let mut span_bytes = 0;
    for edit in set
        .get_mut("changed")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
        .flat_map(|object| object.get_mut("edits").and_then(Value::as_array_mut).into_iter().flatten())
    {
        let Some(edit) = edit.as_object_mut() else { continue };
        for key in ["span", "spans"] {
            let size = edit.get(key).map_or(0, |span| span.to_string().len());
            if span_bytes + size > 65_536 {
                edit.remove(key);
                edit.insert("spansTruncated".into(), json!(true));
            } else {
                span_bytes += size;
            }
        }
    }
    if let Some(set) = set.as_object_mut() {
        set.remove("derived");
        set.remove("$unnamed");
        set.remove("$premises");
        set.remove("$objects");
        set.remove("$references");
        set.remove("$identity");
        set.remove("$text");
    }
    for deleted in set.get_mut("deleted").and_then(Value::as_array_mut).into_iter().flatten() {
        if let Some(deleted) = deleted.as_object_mut() {
            deleted.remove("$was");
        }
    }
}

/// `changes` with its footprint ([`kition_kdm::footprint::with_footprint`]), the lists it names
/// read from the document as it is now, in one load; then, in each object's edits, many edits of
/// one leaf shifted by one amount stated once ([`leaf_runs`]), and the indexes a list's created,
/// deleted and moved objects shifted ([`index_shifts`]).
pub(crate) async fn compacted(kits: &KitManager, source: Source<'_>, changes: &Value) -> Value {
    let changed = changes["changed"].as_array().map_or(0, Vec::len);
    let mut lists = kition_kdm::footprint::lists(changes);
    let structural = structural_lists(changes);
    for place in &structural {
        if !lists.contains(place) {
            lists.push(place.clone());
        }
    }
    let mut items: std::collections::HashMap<(String, String), Vec<String>> = std::collections::HashMap::new();
    if (changed >= kition_kdm::footprint::MIN_RUN || !structural.is_empty()) && !lists.is_empty() {
        // A list that is a field of its parent in one load; one at a path through a ref
        // (`comp.layers` of a motion kit's item) by following it.
        let (direct, paths): (Vec<&Place>, Vec<&Place>) = lists.iter().partition(|(_, field)| !field.contains('.'));
        let load: Vec<Value> = direct.iter().map(|(parent, field)| json!({ "target": parent, "fields": [field] })).collect();
        let loaded = if load.is_empty() { None } else { source.load(kits, Value::Array(load)).await };
        for ((parent, field), object) in direct.iter().zip(loaded.as_ref().and_then(|answer| answer["loaded"].as_array()).into_iter().flatten()) {
            if let Some(listed) = object["fields"][field].as_array() {
                items.insert((parent.clone(), field.clone()), listed.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect());
            }
        }
        for (parent, field) in paths {
            if let Some(listed) = list_at(kits, source, parent, field).await {
                items.insert((parent.clone(), field.clone()), listed);
            }
        }
    }
    let mut set = if changed < kition_kdm::footprint::MIN_RUN {
        kition_kdm::footprint::with_footprint(changes, &|_, _| None)
    } else {
        kition_kdm::footprint::with_footprint(changes, &|parent, field| items.get(&(parent.to_owned(), field.to_owned())).cloned())
    };
    leaf_runs(&mut set);
    index_shifts(&mut set, &items);
    set
}

/// A list: its owner and field.
type Place = (String, String);

/// The items of the list at `path` from `parent` (`comp.layers`: the ref `comp`, then its list
/// `layers`), one load a segment; `None` when a segment is no ref or list.
async fn list_at(kits: &KitManager, source: Source<'_>, parent: &str, path: &str) -> Option<Vec<String>> {
    let mut at = parent.to_owned();
    let segments: Vec<&str> = path.split('.').collect();
    for (index, segment) in segments.iter().enumerate() {
        let answer = source.load(kits, json!([{ "target": at, "fields": [segment] }])).await?;
        let value = &answer["loaded"][0]["fields"][*segment];
        if index + 1 == segments.len() {
            return value.as_array()?.iter().map(|item| item.as_str().map(str::to_owned)).collect();
        }
        at = value.as_str()?.to_owned();
    }
    None
}

/// The lists a change set's created, deleted and moved objects changed.
fn structural_lists(changes: &Value) -> Vec<(String, String)> {
    let mut lists: Vec<(String, String)> = Vec::new();
    let mut add = |position: &Value| {
        if let (Some(parent), Some(field)) = (position["parent"].as_str(), position["field"].as_str()) {
            let place = (parent.to_owned(), field.to_owned());
            if !lists.contains(&place) {
                lists.push(place);
            }
        }
    };
    for list in ["created", "deleted"] {
        for item in changes[list].as_array().into_iter().flatten() {
            add(&item["at"]);
        }
    }
    for item in changes["moved"].as_array().into_iter().flatten() {
        add(&item["from"]);
        add(&item["to"]);
    }
    lists
}

/// A path's items with each numeric segment but the first replaced (`keys.3.time` →
/// `keys.*.time`, and the number): the edits of one leaf of many items of one list.
fn leaf_pattern(path: &str) -> Option<(String, String)> {
    let segments: Vec<&str> = path.split('.').collect();
    let at = segments.iter().rposition(|segment| segment.parse::<usize>().is_ok())?;
    let mut pattern = segments.clone();
    let index = pattern[at].to_owned();
    pattern[at] = "*";
    Some((pattern.join("."), index))
}

/// In each changed object, at least [`kition_kdm::footprint::MIN_RUN`] edits of one leaf of the
/// items of one held list (`keys.0.time`, `keys.1.time`, …) shifted by one amount (200 keys moved
/// half a second) stated once: `{ field: "<list>.*.<leaf>", named?, count, shift: { by } }` in
/// place of those edits, and `fields` likewise. `changes: "all"` lists each.
fn leaf_runs(set: &mut Value) {
    for item in set.get_mut("changed").and_then(Value::as_array_mut).into_iter().flatten() {
        let Some(edits) = item.get("edits").and_then(Value::as_array).cloned() else { continue };
        if edits.len() < kition_kdm::footprint::MIN_RUN {
            continue;
        }
        // Each edit's pattern and amount; the runs of one pattern and one amount.
        let mut runs: BTreeMap<(String, String), Vec<usize>> = BTreeMap::new();
        for (at, edit) in edits.iter().enumerate() {
            let Some((pattern, _)) = edit["field"].as_str().and_then(leaf_pattern) else { continue };
            let Some(by) = kition_kdm::footprint::shift(&edit["before"], &edit["after"]) else { continue };
            runs.entry((pattern, by.to_string())).or_default().push(at);
        }
        let mut gone: BTreeSet<usize> = BTreeSet::new();
        let mut told: Vec<Value> = Vec::new();
        let mut patterns: BTreeSet<String> = BTreeSet::new();
        for ((pattern, _), at) in runs.into_iter().filter(|(_, at)| at.len() >= kition_kdm::footprint::MIN_RUN) {
            let first = &edits[at[0]];
            let mut entry = json!({ "field": pattern, "count": at.len(), "shift": { "by": kition_kdm::footprint::shift(&first["before"], &first["after"]) } });
            if let Some((named, _)) = first["named"].as_str().and_then(leaf_pattern) {
                entry["named"] = json!(named);
            }
            patterns.insert(pattern);
            gone.extend(at);
            told.push(entry);
        }
        if told.is_empty() {
            continue;
        }
        let kept: Vec<Value> = edits.iter().enumerate().filter(|(at, _)| !gone.contains(at)).map(|(_, edit)| edit.clone()).chain(told).collect();
        let fields: BTreeSet<String> = kept.iter().filter_map(|edit| edit["field"].as_str().map(str::to_owned)).collect();
        item["edits"] = json!(kept);
        item["fields"] = json!(fields);
    }
}

/// The indexes a list's created, deleted and moved objects shifted, stated once per run of at
/// least [`kition_kdm::footprint::MIN_RUN`] items kept in the list whose index moved by one amount
/// (`{ parent, field, from, count, shift: { index } }` in `footprint`; the bottom layer moved to
/// the top of 200 shifts the 199 others by one): what the moved objects' `from` and `to` imply,
/// said. A list a footprint of a field already states is left as it is.
fn index_shifts(set: &mut Value, items: &std::collections::HashMap<(String, String), Vec<String>>) {
    let stated: BTreeSet<(String, String)> = set["footprint"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|print| Some((print["parent"].as_str()?.to_owned(), print["field"].as_str()?.to_owned())))
        .collect();
    let mut prints: Vec<Value> = Vec::new();
    for place in structural_lists(set) {
        let Some(listed) = items.get(&place).filter(|_| !stated.contains(&place)) else { continue };
        let at = |item: &Value, side: &str| {
            let position = &item[side];
            (position["parent"].as_str() == Some(place.0.as_str()) && position["field"].as_str() == Some(place.1.as_str()))
                .then(|| position["index"].as_u64().and_then(|index| usize::try_from(index).ok()))
                .flatten()
        };
        let mut removed: BTreeSet<usize> = BTreeSet::new();
        let mut added: BTreeSet<usize> = BTreeSet::new();
        for item in set["created"].as_array().into_iter().flatten() {
            added.extend(at(item, "at"));
        }
        for item in set["deleted"].as_array().into_iter().flatten() {
            removed.extend(at(item, "at"));
        }
        for item in set["moved"].as_array().into_iter().flatten() {
            removed.extend(at(item, "from"));
            added.extend(at(item, "to"));
        }
        // Each item kept: its index before, from its index now.
        let before = |index: usize| -> Option<usize> {
            if added.contains(&index) {
                return None;
            }
            let rank = index - added.range(..index).count();
            let mut seen = 0;
            let mut was = 0;
            loop {
                if !removed.contains(&was) {
                    if seen == rank {
                        return Some(was);
                    }
                    seen += 1;
                }
                was += 1;
            }
        };
        let shifts: Vec<Option<i64>> = (0..listed.len())
            .map(|index| before(index).and_then(|was| i64::try_from(index).ok()?.checked_sub(i64::try_from(was).ok()?)).filter(|by| *by != 0))
            .collect();
        let mut index = 0;
        while index < shifts.len() {
            let Some(by) = shifts[index] else {
                index += 1;
                continue;
            };
            let mut end = index + 1;
            while end < shifts.len() && shifts[end] == Some(by) {
                end += 1;
            }
            if end - index >= kition_kdm::footprint::MIN_RUN {
                prints.push(json!({ "parent": place.0, "field": place.1, "from": index, "count": end - index, "shift": { "index": by } }));
            }
            index = end;
        }
    }
    if !prints.is_empty() {
        let mut all = set["footprint"].as_array().cloned().unwrap_or_default();
        all.extend(prints);
        set["footprint"] = json!(all);
    }
}

/// How the answers name objects whose tool id is a whole number (a kit's `toolId` on an
/// `integer` field, no prefix, no parent: a clip `9`): as that number, the form the kit's commands
/// take, never as the string `"9"`, in change sets, conflicts, `_query` and a batch's
/// `loaded`. An object is named by its type; a position's parent by the type whose
/// field (or path through refs, `comp.layers`) the position names, when the schema says it; only
/// where it does not (no such type, or several that disagree) by its form, all digits.
#[derive(Debug, Default)]
pub(crate) struct IdForm {
    integer: std::collections::BTreeSet<String>,
    /// The kit's description, read for the types of parents and fields.
    described: Option<Value>,
}

impl IdForm {
    pub(crate) fn of(described: Option<&Value>) -> Self {
        let mut integer = std::collections::BTreeSet::new();
        for (ty, def) in described.and_then(|described| described["types"].as_object()).into_iter().flatten() {
            let Some(tool) = def.get("toolId").filter(|tool| tool.is_object()) else { continue };
            let plain = tool["prefix"].as_str().is_none_or(str::is_empty) && tool.get("parent").is_none_or(Value::is_null);
            let field = tool["field"].as_str().unwrap_or_default();
            if plain && def["fields"][field]["kind"] == "integer" {
                integer.insert(ty.clone());
            }
        }
        Self { described: (!integer.is_empty()).then(|| described.cloned()).flatten(), integer }
    }

    /// Whether the objects of `ty` have integer tool ids.
    fn is_integer(&self, ty: &str) -> bool {
        self.integer.contains(ty)
    }

    /// The type a path of fields from `ty` (`comp.layers`, positions skipped) ends at, with the
    /// last field's definition.
    fn walk<'a>(&'a self, ty: &str, path: &str) -> Option<&'a Value> {
        let types = self.described.as_ref()?.get("types")?;
        let mut ty = ty.to_owned();
        let segments: Vec<&str> = path.split('.').filter(|segment| segment.parse::<usize>().is_err()).collect();
        let (last, through) = segments.split_last()?;
        for segment in through {
            ty = types.get(&ty)?.get("fields")?.get(*segment)?.get("of")?.as_str()?.to_owned();
        }
        types.get(&ty)?.get("fields")?.get(*last)
    }

    /// Whether the parent of a position in `field` (of an object of `child` when known) has an
    /// integer tool id: `Some` when every type with such a list or tree field agrees, `None` when
    /// none has one or they disagree.
    fn parent_is_integer(&self, field: &str, child: Option<&str>) -> Option<bool> {
        let types = self.described.as_ref()?.get("types")?.as_object()?;
        let mut verdict: Option<bool> = None;
        for ty in types.keys() {
            let Some(def) = self.walk(ty, field) else { continue };
            let holds = matches!(def["kind"].as_str(), Some("list" | "tree")) && child.is_none_or(|child| def["of"] == child);
            if !holds {
                continue;
            }
            let integer = self.is_integer(ty);
            match verdict {
                Some(known) if known != integer => return None,
                _ => verdict = Some(integer),
            }
        }
        verdict
    }

    /// A position's parent (`{ parent, field }`) in the form of its type.
    fn parent(&self, position: &mut Value, child: Option<&str>) {
        let field = position["field"].as_str().unwrap_or_default().to_owned();
        match self.parent_is_integer(&field, child) {
            Some(true) => self.number(&mut position["parent"]),
            Some(false) => {}
            None => self.number(&mut position["parent"]),
        }
    }

    /// An id as a number when its object's type `ty` has integer tool ids.
    fn typed(&self, ty: Option<&str>, value: &mut Value) {
        if ty.is_some_and(|ty| self.is_integer(ty)) {
            self.number(value);
        }
    }

    /// Objects as a load answers them (`_query`'s `objects`, a batch's `loaded`): each object's
    /// id by its type, and the ids its ref, list and tree fields hold by the type they declare.
    pub(crate) fn loaded(&self, objects: &mut [Value]) {
        if self.integer.is_empty() {
            return;
        }
        for object in objects {
            let ty = object["type"].as_str().unwrap_or_default().to_owned();
            self.typed(Some(&ty), &mut object["id"]);
            let Some(fields) = object.get_mut("fields").and_then(Value::as_object_mut) else { continue };
            for (name, value) in fields.iter_mut() {
                let Some(def) = self.walk(&ty, name) else { continue };
                let of = def["of"].as_str();
                match def["kind"].as_str() {
                    Some("ref") => self.typed(of, value),
                    Some("list") => value.as_array_mut().into_iter().flatten().for_each(|item| self.typed(of, item)),
                    Some("tree") => {
                        for entry in value.as_array_mut().into_iter().flatten() {
                            for key in ["object", "parent"] {
                                if entry.get(key).is_some_and(Value::is_string) {
                                    self.typed(of, &mut entry[key]);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    /// An id of all digits as a number, when the kit has integer tool ids.
    fn number(&self, value: &mut Value) {
        if self.integer.is_empty() {
            return;
        }
        if let Some(number) = value
            .as_str()
            .filter(|text| !text.is_empty() && text.len() < 20 && text.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|text| text.parse::<u64>().ok())
        {
            *value = json!(number);
        }
    }

    /// A batch's `results`: each created object's id (`types`: each operation's type, for a
    /// `create`) in the form of its type.
    pub(crate) fn results(&self, types: &[Option<String>], results: &mut [Value]) {
        for (ty, result) in types.iter().zip(results.iter_mut()) {
            if ty.is_some() && result.is_string() {
                self.typed(ty.as_deref(), result);
            }
        }
    }

    /// A change set's ids (by their type), positions' parents and footprint parents.
    pub(crate) fn changes(&self, set: &mut Value) {
        if self.integer.is_empty() || !set.is_object() {
            return;
        }
        // Draft comparisons carry `texts` too: their ids take the same form as the receipt's
        // corresponding object, including an attributed text under its holder.
        let types: BTreeMap<String, String> = LISTS
            .iter()
            .flat_map(|list| set[*list].as_array().into_iter().flatten())
            .filter_map(|item| Some((item["id"].as_str()?.to_owned(), item["type"].as_str()?.to_owned())))
            .collect();
        for text in set.get_mut("texts").and_then(Value::as_array_mut).into_iter().flatten() {
            let ty = text["id"].as_str().and_then(|id| types.get(id));
            self.typed(ty.map(String::as_str), &mut text["id"]);
        }
        for list in LISTS {
            for item in set.get_mut(list).and_then(Value::as_array_mut).into_iter().flatten() {
                let ty = item["type"].as_str().map(str::to_owned);
                self.typed(ty.as_deref(), &mut item["id"]);
                for side in ["at", "from", "to"] {
                    if item.get(side).is_some_and(Value::is_object) {
                        self.parent(&mut item[side], ty.as_deref());
                    }
                }
            }
        }
        for print in set.get_mut("footprint").and_then(Value::as_array_mut).into_iter().flatten() {
            // Objects stated by their ids: each id by its form.
            if let Some(ids) = print.get_mut("ids").and_then(Value::as_array_mut) {
                ids.iter_mut().for_each(|id| self.number(id));
                continue;
            }
            self.parent(print, None);
        }
    }

    /// A conflict's id, by its type `ty` when known, else
    /// by its form, and where it is now.
    pub(crate) fn conflict(&self, conflict: &mut Value, ty: Option<&str>) {
        if self.integer.is_empty() {
            return;
        }
        if conflict.get("id").is_some() {
            match ty {
                Some(ty) => self.typed(Some(ty), &mut conflict["id"]),
                None => self.number(&mut conflict["id"]),
            }
        }
        if conflict["now"].get("parent").is_some() {
            self.parent(&mut conflict["now"], None);
        }
    }
}

/// `changes: null` with `changesUnavailable`, unless the call left `changes` out.
pub fn set_unavailable(answer: &mut Value, why: String) {
    answer["changes"] = Value::Null;
    answer["changesUnavailable"] = Value::String(why);
}

/// What a write in a file's open editor that does not list the capability `changes` answers: no
/// change set, and why.
pub fn in_editor(answer: &mut Value, wanted: Wanted, editor: &str) {
    if wanted.changes.is_some() {
        set_unavailable(
            answer,
            format!("the file is open in its {editor} editor, which does not report what a call changed yet; inspect it to see the result"),
        );
    }
}

/// The arguments a writing tool takes for its receipt: `changes` and `check`.
pub fn input_properties() -> [(&'static str, Value); 2] {
    [
        (
            "changes",
            json!({ "type": ["boolean", "string"], "enum": [true, false, "all"], "description": format!("What the answer's `changes` lists: true (the default) the objects the call created, changed, moved and deleted, at most {DEFAULT_CAP} with `truncated` counting the rest; \"all\" every one; false leaves `changes` out.") }),
        ),
        (
            "check",
            json!({ "type": "boolean", "description": "Check the document before and after the call and answer `diagnostics: { new, resolved }`. Defaults to true; false skips both checks." }),
        ),
    ]
}

/// The sentence a writing tool's description adds about its receipt.
pub const DESCRIBED: &str = "The answer says what the call changed (`changes`: created, changed with each field before and after, moved, deleted, by the ids the inspect and query tools use; `revision`), so there is no need to inspect again just to see that, and which diagnostics it introduced or resolved (`diagnostics: { new, resolved }`); `changesUnavailable` says why when it cannot.";

/// One line on a receipt for a call's summary: how many objects of each kind changed, and the
/// diagnostics the call introduced and resolved. Empty without a change set.
pub fn summary(answer: &Value) -> String {
    let mut parts = Vec::new();
    if answer["changes"].is_object() {
        let count = |list: &str| answer["changes"][list].as_array().map_or(0, Vec::len) as u64 + answer["changes"]["truncated"][list].as_u64().unwrap_or(0);
        let counts: Vec<String> = LISTS.iter().map(|list| (list, count(list))).filter(|(_, n)| *n > 0).map(|(list, n)| format!("{n} {list}")).collect();
        parts.push(if counts.is_empty() { "no object changed".to_owned() } else { format!("objects {}", counts.join(", ")) });
    }
    let diagnostics = |kind: &str| answer["diagnostics"][kind].as_array().map_or(0, Vec::len);
    if answer["diagnostics"].is_object() && diagnostics("new") + diagnostics("resolved") > 0 {
        parts.push(format!("{} new diagnostic(s), {} resolved", diagnostics("new"), diagnostics("resolved")));
    }
    if parts.is_empty() { String::new() } else { format!(" Changes: {}.", parts.join("; ")) }
}

/// The change set with at most `cap` objects across its lists (`None`: all), taken from each list
/// in turn so every kind of change shows; `truncated` counts what each list left out.
pub fn capped(changes: Value, cap: Option<usize>) -> Value {
    capped_by(changes, cap, &|_, _| 0)
}

/// [`capped`], the objects of a lower `rank` (given each object's list and entry) taken first:
/// within one rank, from each list in turn. The objects kept keep their order in their lists.
pub fn capped_by(mut changes: Value, cap: Option<usize>, rank: &dyn Fn(&str, &Value) -> u8) -> Value {
    let Some(cap) = cap else { return changes };
    let lengths: Vec<usize> = LISTS.iter().map(|list| changes[*list].as_array().map_or(0, Vec::len)).collect();
    if lengths.iter().sum::<usize>() <= cap {
        return changes;
    }
    // Each list's items by rank, in order.
    let mut ranks: std::collections::BTreeMap<u8, Vec<Vec<usize>>> = std::collections::BTreeMap::new();
    for (at, list) in LISTS.iter().enumerate() {
        for (index, item) in changes[*list].as_array().into_iter().flatten().enumerate() {
            ranks.entry(rank(list, item)).or_insert_with(|| vec![Vec::new(); LISTS.len()]).get_mut(at).into_iter().for_each(|items| items.push(index));
        }
    }
    let mut kept: Vec<std::collections::BTreeSet<usize>> = vec![std::collections::BTreeSet::new(); LISTS.len()];
    let mut left = cap;
    for lists in ranks.values() {
        let mut next = vec![0usize; LISTS.len()];
        while left > 0 {
            let mut took = false;
            for (at, items) in lists.iter().enumerate() {
                if left > 0
                    && let Some(index) = items.get(next[at])
                {
                    kept[at].insert(*index);
                    next[at] += 1;
                    left -= 1;
                    took = true;
                }
            }
            if !took {
                break;
            }
        }
    }
    let mut truncated = Map::new();
    for ((list, length), keep) in LISTS.iter().zip(&lengths).zip(&kept) {
        if let Some(items) = changes[*list].as_array_mut() {
            let mut index = 0;
            items.retain(|_| {
                index += 1;
                keep.contains(&(index - 1))
            });
        }
        truncated.insert((*list).to_owned(), json!(length - keep.len()));
    }
    changes["truncated"] = Value::Object(truncated);
    changes
}

/// The diagnostics `now` has that `was` had not (`new`) and those it no longer has (`resolved`),
/// matched by `code` and `target`, each as many times as it occurs.
pub fn delta(was: &[Value], now: &[Value]) -> Value {
    let key = |diagnostic: &Value| (diagnostic["code"].to_string(), diagnostic.get("target").cloned().unwrap_or(Value::Null).to_string());
    let only = |these: &[Value], those: &[Value]| -> Vec<Value> {
        let mut unmatched: Vec<(String, String)> = those.iter().map(key).collect();
        these
            .iter()
            .filter(|diagnostic| match unmatched.iter().position(|other| *other == key(diagnostic)) {
                Some(at) => {
                    unmatched.remove(at);
                    false
                }
                None => true,
            })
            .cloned()
            .collect()
    };
    json!({ "new": only(now, was), "resolved": only(was, now) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn objects(prefix: &str, count: usize) -> Value {
        Value::Array((0..count).map(|at| json!({ "id": format!("{prefix}{at:03}"), "type": "T" })).collect())
    }

    #[test]
    fn a_receipt_is_cut_from_every_list_in_turn_and_says_what_it_left_out() {
        let changes = json!({ "created": objects("c", 40), "changed": objects("h", 3), "moved": [], "deleted": objects("d", 20) });
        let cut = capped(changes.clone(), Some(DEFAULT_CAP));
        let count = |list: &str| cut[list].as_array().map_or(0, Vec::len);
        assert_eq!((count("created"), count("changed"), count("moved"), count("deleted")), (27, 3, 0, 20));
        assert_eq!(cut["truncated"], json!({ "created": 13, "changed": 0, "moved": 0, "deleted": 0 }));
        assert_eq!(cut["created"][26]["id"], "c026", "the first objects of each list are kept");
        assert_eq!(capped(changes.clone(), None), changes, "\"all\" lifts the cap");
        let small = json!({ "created": objects("c", 2), "changed": [], "moved": [], "deleted": [] });
        assert_eq!(capped(small.clone(), Some(DEFAULT_CAP)), small, "nothing cut, no `truncated`");
    }

    /// regressions/issue-guard-id-forms: a conflict's id takes its type's form when the
    /// guard knows the type (a track named `2` stays `"2"`, a clip `2` is `2`), else the all-digits
    /// rule; a batch's created ids take their type's form.
    #[test]
    fn conflicts_and_results_name_ids_in_their_types_form() {
        let described = json!({ "root": "Timeline", "types": {
            "Timeline": { "fields": { "tracks": { "kind": "list", "of": "Track" } } },
            "Track": { "fields": { "name": { "kind": "string" }, "clips": { "kind": "list", "of": "Clip" } }, "toolId": { "field": "name", "prefix": "" } },
            "Clip": { "fields": { "id": { "kind": "integer" } }, "toolId": { "field": "id", "prefix": "" } }
        } });
        let form = IdForm::of(Some(&described));
        let mut track = json!({ "id": "2", "reason": "changed" });
        form.conflict(&mut track, Some("Track"));
        assert_eq!(track["id"], json!("2"));
        let mut clip = json!({ "id": "2", "reason": "changed" });
        form.conflict(&mut clip, Some("Clip"));
        assert_eq!(clip["id"], json!(2));
        let mut unknown = json!({ "id": "7", "reason": "unknown" });
        form.conflict(&mut unknown, None);
        assert_eq!(unknown["id"], json!(7));
        let mut results = vec![json!("12"), json!(null), json!("V3")];
        form.results(&[Some("Clip".to_owned()), None, Some("Track".to_owned())], &mut results);
        assert_eq!(results, [json!(12), json!(null), json!("V3")]);
    }

    #[test]
    fn diagnostics_match_by_code_and_target() {
        let todo = json!({ "code": "k.todo", "severity": "warning", "target": {}, "message": "a" });
        let on = |id: &str| json!({ "code": "k.empty", "severity": "error", "target": { "objectId": id }, "message": id });
        let reworded = json!({ "code": "k.todo", "severity": "warning", "target": {}, "message": "another wording" });
        let found = delta(&[todo.clone(), on("a")], &[reworded, on("b")]);
        assert_eq!(found, json!({ "new": [on("b")], "resolved": [on("a")] }));
        assert_eq!(delta(&[], &[]), json!({ "new": [], "resolved": [] }));
    }

    #[test]
    fn a_call_asks_for_its_receipt_with_changes_and_check() {
        assert_eq!(wanted(&json!({})).ok(), Some(Wanted { changes: Some(Some(DEFAULT_CAP)), check: true }));
        assert_eq!(wanted(&json!({ "changes": "all", "check": false })).ok(), Some(Wanted { changes: Some(None), check: false }));
        assert_eq!(wanted(&json!({ "changes": false })).ok().map(|wanted| wanted.changes), Some(None));
        assert!(wanted(&json!({ "changes": "some" })).is_err());
        assert!(wanted(&json!({ "check": "yes" })).is_err());
    }
}
