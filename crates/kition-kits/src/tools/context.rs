// Copied from kition-sdk crates/kition-kits/src/tools/context.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Explicit call context: every `<prefix>_run` step says what it acts on and where, and
//! the kit's editor state (its selection, current part, current time) is set for the call and
//! put back after it, so no call leaves hidden state behind (KHP A46, A54).
//!
//! A step is `{command, params?, on?, at?}`: `on` lists the ids of the objects it acts on, as
//! `<prefix>_inspect` lists them; `at` is `{part?, time?}`, its `part` overriding the run's
//! `target` for that step. A command says what it acts on in its parameter schema: the
//! parameter marked `"x-khp-role": "targets"` takes `on` (one id, or a list when it is an
//! array), and `"x-khp-reads"` at the top lists the editor state it reads (`selection`, `part`,
//! `time`; Kit Process Protocol section 6).
//!
//! Before the first step the server saves the kit's editor state (`context.get`, section 7a);
//! before each step that names a part, a time, or a selection for a command that reads it, it
//! sets them (`context.set`); after the last step, and after a failed run is rolled back, it puts
//! the saved state back (`context.restore`). A kit without these requests still has its part
//! addressed through its `slide.go` or `page.go`, which it is then left on.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use super::{ErrorCode, KitToolError};
use crate::manager::{Caller, CommandView, KitManager};

/// The keys a step takes.
const STEP_KEYS: [&str; 4] = ["command", "params", "on", "at"];

/// The kit's editor state as `context.get` answered it before a call.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Saved {
    /// The kit has no `context.*` requests (no editor-state hooks).
    Unsupported,
    /// What `context.get` answered; `Null` for a kit that keeps no such state, left alone.
    State(Value),
}

impl Saved {
    /// Whether the kit sets and restores its editor state: it answered state that is not `Null`.
    pub(crate) fn hooks(&self) -> bool {
        matches!(self, Self::State(state) if !state.is_null())
    }
}

/// Saves the editor state of document `document_id` before a call (`context.get`).
pub(crate) async fn save(kits: &KitManager, kit_id: &str, document_id: &str) -> Result<Saved, KitToolError> {
    match kits.context(Caller::Agent, kit_id, document_id, "context.get", Map::new()).await {
        Ok(Some(answer)) => Ok(Saved::State(answer.get("state").cloned().unwrap_or(Value::Null))),
        Ok(None) => Ok(Saved::Unsupported),
        Err(error) => Err(KitToolError::from(error).context("cannot read the kit's editor state (`context.get`): ")),
    }
}

/// Puts the state `saved` back on document `document_id` (`context.restore`); a kit without
/// hooks, or one that answered `Null`, is left alone.
pub(crate) async fn restore(kits: &KitManager, kit_id: &str, document_id: &str, saved: &Saved) -> Result<(), String> {
    let Saved::State(state) = saved else { return Ok(()) };
    if state.is_null() {
        return Ok(());
    }
    let params = Map::from_iter([("state".to_owned(), state.clone())]);
    match kits.context(Caller::Agent, kit_id, document_id, "context.restore", params).await {
        Ok(_) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// [`restore`] after a call that went well: a failure is said in the call's summary, since the
/// call's edits stand.
pub(crate) async fn restore_noted(kits: &KitManager, kit_id: &str, document_id: &str, saved: &Saved) -> Option<String> {
    restore(kits, kit_id, document_id, saved).await.err().map(|reason| {
        tracing::warn!(kit = kit_id, reason = %reason, "editor state not restored");
        format!(" The kit's selection and current part could not be put back ({reason}).")
    })
}

/// What a command says about what it acts on, from its parameter schema.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Acts {
    /// The parameter marked `"x-khp-role": "targets"`, and whether it takes a list of ids.
    pub(crate) targets: Option<(String, bool)>,
    /// The JSON type of the ids the target parameter takes, when it names one: `integer` or
    /// `string` (`on` is handed to the command in that type).
    pub(crate) id_type: Option<&'static str>,
    /// `"x-khp-index"` on the target parameter: the prefix of the spelling by which it also takes
    /// an object by its place in a list, counted from 1 (`"#"`: `"#3"`, the third). Such a value
    /// is a place, not an id.
    pub(crate) index: Option<String>,
    /// `"x-khp-index-order": "reversed"` beside the index spelling: `"#1"` is the last item stored
    ///.
    pub(crate) index_reversed: bool,
    /// `"x-khp-index-numbers": true` on the target parameter: a whole number naming no object is a
    /// place in the list, counted from 1.
    pub(crate) index_numbers: bool,
    /// `"x-khp-reads"`: `selection`, `part`, `time` (set from the call context), `mode`, `active`,
    /// `area`.
    pub(crate) reads: Vec<String>,
    /// The parameters marked `"x-khp-role": "place"`: they name a place (a track, a time), not an
    /// object.
    pub(crate) places: Vec<String>,
    /// `"x-khp-position": "independent"`: what the command does to its target does not depend on
    /// where the target is.
    pub(crate) independent: bool,
    /// The parameters the command takes, when its schema takes no others
    /// (`additionalProperties: false`).
    pub(crate) known: Option<Vec<String>>,
    /// Each top-level parameter's JSON Schema, for the type a value must have.
    pub(crate) properties: Map<String, Value>,
}

/// Whether `value` has a type `schema` allows: its `type` (a name or a list of them), or one of
/// its `oneOf`/`anyOf` branches; a schema that states no type takes anything.
fn fits_type(schema: &Value, value: &Value) -> bool {
    if let Some(branches) = schema.get("oneOf").or_else(|| schema.get("anyOf")).and_then(Value::as_array) {
        return branches.iter().any(|branch| fits_type(branch, value));
    }
    let one = |kind: &str| match kind {
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.is_i64() || value.is_u64() || value.as_f64().is_some_and(|number| number.is_finite() && number.fract() == 0.0),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        _ => true,
    };
    match schema.get("type") {
        Some(Value::String(kind)) => one(kind),
        Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).any(one),
        _ => true,
    }
}

/// The type a schema allows, in words (`a number`, `an integer or a string`).
fn type_words(schema: &Value) -> String {
    if let Some(branches) = schema.get("oneOf").or_else(|| schema.get("anyOf")).and_then(Value::as_array) {
        return branches.iter().map(type_words).collect::<Vec<_>>().join(" or ");
    }
    let word = |kind: &str| match kind {
        "integer" | "array" | "object" => format!("an {kind}"),
        other => format!("a {other}"),
    };
    match schema.get("type") {
        Some(Value::String(kind)) => word(kind),
        Some(Value::Array(kinds)) => kinds.iter().filter_map(Value::as_str).map(word).collect::<Vec<_>>().join(" or "),
        _ => "any value".to_owned(),
    }
}

/// The list a target parameter takes: the parameter itself when it is an `array`, else an
/// `array` branch of its `oneOf` (one id or a list).
fn list_branch(property: &Value) -> Option<&Value> {
    if property.get("type").and_then(Value::as_str) == Some("array") {
        return Some(property);
    }
    property.get("oneOf")?.as_array()?.iter().find(|branch| branch.get("type").and_then(Value::as_str) == Some("array"))
}

impl Acts {
    pub(crate) fn of(params: &Value) -> Self {
        let properties = params.get("properties").and_then(Value::as_object);
        let role = |property: &Value, role: &str| property.get("x-khp-role").and_then(Value::as_str) == Some(role);
        let targets = properties.and_then(|properties| {
            properties.iter().find(|(_, property)| role(property, "targets")).map(|(name, property)| (name.clone(), list_branch(property).is_some()))
        });
        // The id type: the list's items' (one id or a list, `oneOf [integer, string, array]`: the
        // list's), else the parameter's.
        let id_type = targets.as_ref().and_then(|(name, many)| {
            let property = properties?.get(name)?;
            let id = if *many { list_branch(property)?.get("items")? } else { property };
            match id.get("type").and_then(Value::as_str) {
                Some("integer") => Some("integer"),
                Some("string") => Some("string"),
                _ => None,
            }
        });
        let prefix = |property: &Value| property.get("x-khp-index").and_then(Value::as_str).filter(|prefix| !prefix.is_empty()).map(str::to_owned);
        // The target parameter's index spelling; any other parameter may say it too (`parent`,
        // ), and a value in it is a place wherever it is.
        let spelled = targets
            .as_ref()
            .and_then(|(name, _)| properties?.get(name).filter(|property| prefix(property).is_some()))
            .or_else(|| properties.and_then(|properties| properties.values().find(|property| prefix(property).is_some())));
        let index = spelled.and_then(prefix);
        let index_reversed = spelled.is_some_and(|property| property.get("x-khp-index-order").and_then(Value::as_str) == Some("reversed"));
        let index_numbers = targets.as_ref().is_some_and(|(name, _)| {
            properties.and_then(|properties| properties.get(name)).is_some_and(|property| property.get("x-khp-index-numbers") == Some(&Value::Bool(true)))
        });
        let reads = params
            .get("x-khp-reads")
            .and_then(Value::as_array)
            .map(|reads| reads.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default();
        let places = properties
            .map(|properties| properties.iter().filter(|(_, property)| role(property, "place")).map(|(name, _)| name.clone()).collect())
            .unwrap_or_default();
        let independent = params.get("x-khp-position").and_then(Value::as_str) == Some("independent");
        let known = (params.get("additionalProperties") == Some(&Value::Bool(false)))
            .then(|| properties.map(|properties| properties.keys().cloned().collect()).unwrap_or_default());
        let properties = properties.cloned().unwrap_or_default();
        Self { targets, id_type, index, index_reversed, index_numbers, reads, places, independent, known, properties }
    }

    pub(crate) fn named_values(&self, params: &Value) -> Vec<(String, String, Option<Vec<String>>)> {
        fn walk(schema: &Value, value: &Value, out: &mut Vec<(String, String, Option<Vec<String>>)>) {
            if !fits_type(schema, value) {
                return;
            }
            if let Some(field) = schema["x-khp-name"].as_str().filter(|field| !field.is_empty()) {
                let types = schema["x-khp-types"].as_array().map(|types| types.iter().filter_map(Value::as_str).map(str::to_owned).collect());
                for text in value.as_str().into_iter().chain(value.as_array().into_iter().flatten().filter_map(Value::as_str)).filter(|text| !text.is_empty()) {
                    out.push((text.to_owned(), field.to_owned(), types.clone()));
                }
            }
            for branch in schema.get("oneOf").or_else(|| schema.get("anyOf")).and_then(Value::as_array).into_iter().flatten() {
                walk(branch, value, out);
            }
            if let Some(items) = value.as_array() {
                if let Some(schema) = schema.get("items") {
                    for item in items {
                        walk(schema, item, out);
                    }
                }
            } else if let Some(members) = value.as_object() {
                for (name, member) in members {
                    if let Some(schema) = schema["properties"].get(name) {
                        walk(schema, member, out);
                    }
                }
            }
        }
        let mut out = Vec::new();
        for (name, schema) in &self.properties {
            if let Some(value) = params.get(name) {
                let mut names = Vec::new();
                walk(schema, value, &mut names);
                if self.targets.as_ref().is_some_and(|(target, _)| target == name) {
                    names.retain(|(text, _, _)| self.index_of(&json!(text)).is_none());
                }
                out.extend(names);
            }
        }
        out
    }

    /// The place (counted from 0) a target value names by the command's index spelling
    /// (`"#3"` → 2); `None` for an id, or when the command declares no index spelling.
    pub(crate) fn index_of(&self, value: &Value) -> Option<usize> {
        let prefix = self.index.as_deref()?;
        let digits = value.as_str()?.strip_prefix(prefix)?;
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        digits.parse::<usize>().ok()?.checked_sub(1)
    }

    /// Whether a whole number in the parameter `name` may be an object's integer tool id
    ///: the parameter says it names objects (`"x-khp-role": "object"`, on it, its
    /// items or a `oneOf` branch) or takes the index spelling (`"x-khp-index"`, which only a
    /// parameter naming objects does). A plain integer (a count, a frame delta, an element index)
    /// names none, whatever object has that number as its id.
    pub(crate) fn names_objects(&self, name: &str) -> bool {
        fn marked(schema: &Value) -> bool {
            schema.get("x-khp-role").and_then(Value::as_str) == Some(OBJECT_ROLE)
                || schema.get("x-khp-index").is_some()
                || schema.get("oneOf").or_else(|| schema.get("anyOf")).and_then(Value::as_array).is_some_and(|branches| branches.iter().any(marked))
                || schema.get("items").is_some_and(marked)
        }
        self.properties.get(name).is_some_and(marked)
    }

    pub(crate) fn names_objects_at(&self, name: &str, value: &Value) -> bool {
        // A name declaration at a union's position names the scalar, not the coordinates
        // of its point branch. Lists of references declare their item position (`items`).
        if !self.names_objects(name) {
            return false;
        }
        fn marked(schema: &Value, value: &Value) -> bool {
            if !fits_type(schema, value) {
                return false;
            }
            if (schema["x-khp-role"] == OBJECT_ROLE || schema.get("x-khp-index").is_some())
                && !(schema.get("x-khp-name").is_some() && (value.is_array() || value.is_object()))
            {
                return true;
            }
            schema
                .get("oneOf")
                .or_else(|| schema.get("anyOf"))
                .and_then(Value::as_array)
                .is_some_and(|branches| branches.iter().any(|schema| marked(schema, value)))
                || schema.get("items").is_some_and(|schema| value.as_array().is_some_and(|items| items.iter().any(|value| marked(schema, value))))
        }
        self.properties.get(name).is_some_and(|schema| marked(schema, value))
    }

    /// The types of the objects the parameter `name` names (`"x-khp-types"` on it, its items or a
    /// `oneOf` branch); `None`: any type.
    pub(crate) fn types_of(&self, name: &str) -> Option<Vec<String>> {
        fn types(schema: &Value) -> Option<Vec<String>> {
            if let Some(listed) = schema.get("x-khp-types").and_then(Value::as_array) {
                return Some(listed.iter().filter_map(Value::as_str).map(str::to_owned).collect());
            }
            schema
                .get("oneOf")
                .or_else(|| schema.get("anyOf"))
                .and_then(Value::as_array)
                .and_then(|branches| branches.iter().find_map(types))
                .or_else(|| schema.get("items").and_then(types))
        }
        self.properties.get(name).and_then(types)
    }

    /// Ids held only at schema-declared reference positions, at any depth.
    pub(crate) fn nested_ids(&self, name: &str, value: &Value, out: &mut std::collections::BTreeSet<String>) {
        fn ids(value: &Value, out: &mut std::collections::BTreeSet<String>) {
            match value {
                Value::String(text) if !text.is_empty() && !text.starts_with('$') => {
                    out.insert(text.clone());
                }
                Value::Number(number) if number.is_u64() => {
                    out.insert(number.to_string());
                }
                Value::Array(items) => items.iter().for_each(|item| ids(item, out)),
                _ => {}
            }
        }
        fn walk(schema: &Value, value: &Value, out: &mut std::collections::BTreeSet<String>) {
            if !fits_type(schema, value) {
                return;
            }
            if (schema.get("x-khp-role").and_then(Value::as_str) == Some(OBJECT_ROLE) || schema.get("x-khp-name").is_some())
                && !(schema.get("x-khp-name").is_some() && (value.is_array() || value.is_object()))
            {
                ids(value, out);
                return;
            }
            for branch in schema.get("oneOf").or_else(|| schema.get("anyOf")).and_then(Value::as_array).into_iter().flatten() {
                walk(branch, value, out);
            }
            match value {
                Value::Object(members) => {
                    for (key, member) in members {
                        if let Some(schema) = schema.get("properties").and_then(|properties| properties.get(key)) {
                            walk(schema, member, out);
                        }
                    }
                }
                Value::Array(items) => {
                    if let Some(schema) = schema.get("items") {
                        for item in items {
                            walk(schema, item, out);
                        }
                    }
                }
                _ => {}
            }
        }
        if let Some(schema) = self.properties.get(name) {
            walk(schema, value, out);
        }
    }

    /// `params` with each numeric string the target parameter or a parameter naming objects holds
    /// where its schema takes integers and no strings (`clip: "9"`) given as that integer, as `on`
    /// is: receipts print such ids as numbers, and an agent may write them either way.
    pub(crate) fn coerced(&self, params: &Map<String, Value>) -> Map<String, Value> {
        fn integer_only(schema: &Value) -> bool {
            let kinds: Vec<&str> = match schema.get("oneOf").or_else(|| schema.get("anyOf")).and_then(Value::as_array) {
                Some(branches) => branches.iter().filter_map(|branch| branch.get("type").and_then(Value::as_str)).collect(),
                None => schema.get("type").and_then(Value::as_str).into_iter().collect(),
            };
            kinds.contains(&"integer") && !kinds.contains(&"string")
        }
        let digits = |text: &str| !text.is_empty() && text.len() < 20 && text.bytes().all(|byte| byte.is_ascii_digit());
        let mut out = params.clone();
        let target = self.targets.as_ref().map(|(name, _)| name.as_str());
        for (name, value) in out.iter_mut() {
            if Some(name.as_str()) != target && !self.names_objects_at(name, value) {
                continue;
            }
            let Some(schema) = self.properties.get(name) else { continue };
            let one = |value: &mut Value, schema: &Value| {
                if let Value::String(text) = value
                    && integer_only(schema)
                    && digits(text)
                    && let Ok(number) = text.parse::<u64>()
                {
                    *value = json!(number);
                }
            };
            match value {
                Value::Array(items) => {
                    let item_schema = list_branch(schema).and_then(|list| list.get("items")).cloned().unwrap_or(Value::Null);
                    items.iter_mut().for_each(|item| one(item, &item_schema));
                }
                other => one(other, schema),
            }
        }
        out
    }

    pub(crate) fn reads(&self, state: &str) -> bool {
        self.reads.iter().any(|read| read == state)
    }

    /// An id as `on` gives it, in the type the command's target parameter takes: a numeric string
    /// for an integer parameter is that integer, a number for a string parameter its digits.
    pub(crate) fn id_as_declared(&self, id: &Value) -> Value {
        match (self.id_type, id) {
            (Some("integer"), Value::String(text)) => text.parse::<u64>().map_or_else(|_| id.clone(), |number| json!(number)),
            (Some("string"), Value::Number(number)) => Value::String(number.to_string()),
            _ => id.clone(),
        }
    }

    /// Refuses a parameter the command's schema does not take, in the words a kit answers
    /// (`kition_kit::schema::refuse_unknown`): checked before the premise guard, so a step the kit
    /// would refuse is never answered as a conflict.
    pub(crate) fn refuse_unknown(&self, command: &str, params: Option<&Value>) -> Result<(), KitToolError> {
        let coerced = params.and_then(Value::as_object).map(|params| self.coerced(params));
        let given = coerced.as_ref();
        if let Some(known) = &self.known
            && let Some(unknown) = given.into_iter().flatten().map(|(key, _)| key).find(|key| !known.contains(key))
        {
            let taken = if known.is_empty() {
                "it takes no parameters".to_owned()
            } else {
                format!("it takes {}", known.iter().map(|name| format!("`{name}`")).collect::<Vec<_>>().join(", "))
            };
            return Err(KitToolError::invalid(format!("`{command}` has no parameter `{unknown}` ({taken})")));
        }
        // A top-level value of a type its parameter does not take (`null` is a value left out):
        // the kit would refuse it too, so it is never answered as a conflict.
        if let Some((name, value, schema)) = given
            .into_iter()
            .flatten()
            .filter(|(_, value)| !value.is_null())
            .find_map(|(name, value)| self.properties.get(name).filter(|schema| !fits_type(schema, value)).map(|schema| (name, value, schema)))
        {
            return Err(KitToolError::invalid(format!("`{command}`: `{name}` is {value}: expected {}", type_words(schema))));
        }
        Ok(())
    }

    /// What the command reads that no call context sets (`mode`, `active`, `area`), said to the model so
    /// it sets that state with the kit's own command earlier in the same run; `None` when the call
    /// context sets everything it reads. The server saves the editor state before a run and puts
    /// it back after, so what the run sets does not outlive it.
    pub(crate) fn depends_on(&self) -> Option<String> {
        let named: Vec<&str> = UNSET.iter().filter(|(state, _)| self.reads(state)).map(|(_, words)| *words).collect();
        if named.is_empty() {
            return None;
        }
        Some(format!(
            "It acts in {}, which neither `on` nor `at` sets: set it with the kit's own command in an earlier step of the same run. The editor state is put back after the call, so a later call sets it again.",
            named.join(" and ")
        ))
    }
}

/// The role a parameter that names objects besides the command's targets has
/// (`"x-khp-role": "object"`): a whole number there is an id.
pub(crate) const OBJECT_ROLE: &str = "object";

/// Editor state a command may read (`x-khp-reads`) that no call context member sets, and how the
/// model is told of it.
const UNSET: [(&str, &str); 3] =
    [("mode", "the editor's current mode (`mode`)"), ("active", "the active layer, track or object (`active`)"), ("area", "the selected area (`area`)")];

/// One step as the server runs it: its command and parameters (with `on` written in), and what to
/// set before it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Planned {
    pub(crate) command: String,
    pub(crate) params: Map<String, Value>,
    /// `context.set`'s `{on?, part?, time?}` for this step, when there is any.
    pub(crate) set: Option<Map<String, Value>>,
    /// The part to go to through the kit's `slide.go` or `page.go` (a kit without hooks).
    pub(crate) go: Option<Value>,
}

/// The part members a kit that declares none takes: a slide or page counted from 1, or its id.
const DEFAULT_PARTS: [&str; 4] = ["slide", "page", "slideId", "pageId"];

/// `slide`, `page` or `comp`, each in backticks, joined with `or`.
fn either(names: &[&str]) -> String {
    let quoted: Vec<String> = names.iter().map(|name| format!("`{name}`")).collect();
    match quoted.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} or {last}", rest.join(", ")),
        _ => quoted.concat(),
    }
}

/// A part as a run's `target` or a step's `at.part` names it. A kit that declares its part nouns
/// (`agent.parts`, `parts`) takes exactly one of them, naming a part by the kit's own id (a whole
/// number or a string), which goes to the kit unchanged; a kit that declares none takes `slide`,
/// `page`, `slideId` or `pageId`, a slide or page counted from 1 or a part's id. `at` names it in
/// messages.
pub(crate) fn check_part(part: &Value, at: &str, parts: Option<&[&str]>) -> Result<(), KitToolError> {
    let accepted: &[&str] = parts.unwrap_or(&DEFAULT_PARTS);
    let Some(fields) = part.as_object().filter(|fields| !fields.is_empty()) else {
        return Err(KitToolError::invalid(match parts {
            Some(nouns) => format!(
                "`{at}` is {part}: a part of this kit is {}, by the id the inspect tool lists",
                nouns.iter().map(|noun| format!("{{\"{noun}\": id}}")).collect::<Vec<_>>().join(" or ")
            ),
            None => format!(
                "`{at}` is {part}: a part is {{\"slide\": n}} or {{\"page\": n}} (counted from 1), or {{\"slideId\": id}} or {{\"pageId\": id}} as the inspect tool lists it"
            ),
        }));
    };
    for (key, value) in fields {
        if !accepted.contains(&key.as_str()) {
            return Err(KitToolError::invalid(format!("`{at}` has `{key}`, which names no part of this kit: a part is {}", either(accepted))));
        }
        match key.as_str() {
            // A declared noun carries the part's id as the kit lists it, even `slide` or `page`.
            _ if parts.is_some() => {
                if !(value.is_u64() || value.as_str().is_some_and(|id| !id.trim().is_empty())) {
                    return Err(KitToolError::invalid(format!(
                        "`{at}.{key}` is {value}: it names a `{key}` by the id the inspect tool lists, a whole number or a string"
                    )));
                }
            }
            "slide" | "page" if value.as_u64().is_none_or(|n| n < 1) => {
                return Err(KitToolError::invalid(format!("`{at}.{key}` is {value}: {key}s are counted from 1 here (the first is 1)")));
            }
            "slideId" | "pageId" if value.as_u64().is_none() => {
                return Err(KitToolError::invalid(format!("`{at}.{key}` is {value}: it is the `id` the inspect tool lists for a part, a whole number")));
            }
            _ => {}
        }
    }
    if fields.len() > 1 {
        return Err(KitToolError::invalid(format!("`{at}` names {} parts: give one of {}", fields.len(), either(accepted))));
    }
    Ok(())
}

/// The part a run's `target` names, checked against the kit's part nouns (`parts`, [`check_part`]):
/// `None` without a target.
pub(crate) fn run_part(input: &Value, parts: Option<&[&str]>) -> Result<Option<Value>, KitToolError> {
    let Some(target) = input.get("target").filter(|target| !target.is_null()) else { return Ok(None) };
    check_part(target, "target", parts)?;
    Ok(Some(target.clone()))
}

/// Whether any step gives `on`, or a numeric string a declaration may make an integer.
pub(crate) fn any_on(steps: &[Value]) -> bool {
    steps.iter().any(|step| step.get("on").is_some() || has_digits(step.get("params")))
}

/// Whether a step's parameters hold a numeric string at their top level or in a list there: an
/// id an integer parameter takes as that integer ([`Acts::coerced`]), for which the
/// commands' declarations are read.
fn has_digits(params: Option<&Value>) -> bool {
    let digits = |value: &Value| value.as_str().is_some_and(|text| !text.is_empty() && text.len() < 20 && text.bytes().all(|byte| byte.is_ascii_digit()));
    params.and_then(Value::as_object).into_iter().flatten().any(|(_, value)| match value {
        Value::Array(items) => items.iter().any(digits),
        other => digits(other),
    })
}

/// The commands' [`Acts`], by id.
pub(crate) fn acts_by_id(commands: &[CommandView]) -> HashMap<String, Acts> {
    commands.iter().map(|command| (command.id.clone(), Acts::of(&command.params))).collect()
}

/// Plans `steps` (KHP A53: every step is checked before any runs): each step's command and
/// parameters, `on` written into the command's target parameter, and the context to set before it
/// (`part` from `at.part`, else the run's `target`). `acts` holds the commands' declarations (needed
/// only when a step gives `on`); `hooks` says whether the kit sets its editor state, else a part
/// is gone to through `slide.go` or `page.go` and a selection or time cannot be set. `parts` are the
/// kit's declared part nouns ([`check_part`]).
pub(crate) fn plan(
    steps: &[Value],
    target: Option<&Value>,
    acts: &HashMap<String, Acts>,
    hooks: bool,
    parts: Option<&[&str]>,
) -> Result<Vec<Planned>, KitToolError> {
    steps
        .iter()
        .enumerate()
        .map(|(index, step)| plan_step(step, target, acts, hooks, parts).map_err(|error| error.at(Some(index)).context(&format!("step {index}: "))))
        .collect()
}

fn plan_step(step: &Value, target: Option<&Value>, acts: &HashMap<String, Acts>, hooks: bool, parts: Option<&[&str]>) -> Result<Planned, KitToolError> {
    let Some(fields) = step.as_object() else {
        return Err(KitToolError::invalid("a step is an object `{command, params?, on?, at?}`"));
    };
    if let Some(other) = fields.keys().find(|key| !STEP_KEYS.contains(&key.as_str())) {
        return Err(KitToolError::invalid(format!("a step has no `{other}`: it is `{{command, params?, on?, at?}}`")));
    }
    let command = fields.get("command").and_then(Value::as_str).map(str::trim).unwrap_or_default().to_owned();
    if command.is_empty() {
        return Err(KitToolError::invalid("it has no `command`"));
    }
    let mut params = match fields.get("params") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(params)) => params.clone(),
        Some(other) => return Err(KitToolError::invalid(format!("`params` is {other}: an object of the command's parameters"))),
    };
    let (part, time) = match fields.get("at") {
        None | Some(Value::Null) => (None, None),
        Some(Value::Object(at)) => {
            if let Some(other) = at.keys().find(|key| *key != "part" && *key != "time") {
                return Err(KitToolError::invalid(format!("`at` has no `{other}`: it is `{{part?, time?}}`")));
            }
            let part = at.get("part").filter(|part| !part.is_null());
            if let Some(part) = part {
                check_part(part, "at.part", parts)?;
            }
            let time = match at.get("time") {
                None | Some(Value::Null) => None,
                Some(time) => Some(
                    time.as_f64()
                        .filter(|time| time.is_finite() && *time >= 0.0)
                        .ok_or_else(|| KitToolError::invalid(format!("`at.time` is {time}: a time in seconds, 0 or more")))?,
                ),
            };
            (part.cloned(), time)
        }
        Some(other) => return Err(KitToolError::invalid(format!("`at` is {other}: it is `{{part?, time?}}`"))),
    };
    let part = part.or_else(|| target.cloned());
    if let Some(declared) = acts.get(&command) {
        params = declared.coerced(&params);
    }
    let mut set = Map::new();
    if let Some(on) = fields.get("on") {
        let ids = on
            .as_array()
            .filter(|ids| !ids.is_empty() && ids.iter().all(|id| id.is_string() || id.is_u64() || id.is_i64()))
            .ok_or_else(|| KitToolError::invalid(format!("`on` is {on}: a non-empty list of the ids the inspect tool lists")))?;
        // A command the kit does not list is the kit's to refuse (unknown command) when it runs.
        if let Some(declared) = acts.get(&command) {
            // `on` takes ids: a value the command reads as a place in a list is refused, so that
            // it is checked as a place (given in the target parameter) or replaced by the id.
            if let (Some(spelled), Some((name, _))) = (ids.iter().find_map(|id| declared.index_of(id).and(id.as_str())), &declared.targets) {
                return Err(KitToolError::invalid(format!(
                    "`on` takes ids, and `{spelled}` names an object by its place in a list: give the object's id as the inspect tool lists it, or give `{spelled}` in `params.{name}`, where a write with `basis` is refused when what it names changed"
                )));
            }
            match &declared.targets {
                Some((name, _)) if params.contains_key(name) => {
                    return Err(KitToolError::invalid(format!(
                        "`on` and `{name}` both name what `{command}` acts on: give the ids once, in `on` or in `params.{name}`"
                    )));
                }
                Some((name, false)) if ids.len() > 1 => {
                    return Err(KitToolError::invalid(format!(
                        "`{command}` acts on one object (its `{name}`), and `on` names {}: give one id, or one step per object",
                        ids.len()
                    )));
                }
                Some((name, many)) => {
                    let ids: Vec<Value> = ids.iter().map(|id| declared.id_as_declared(id)).collect();
                    params.insert(name.clone(), if *many { Value::Array(ids) } else { ids[0].clone() });
                }
                None if declared.reads("selection") => {
                    if !hooks {
                        return Err(KitToolError::new(
                            ErrorCode::Unsupported,
                            format!(
                                "`{command}` acts on the selection, and this kit cannot set its selection for a call (it has no `context.set`), so `on` cannot say which objects; nothing was run. Use a command that takes the objects' ids."
                            ),
                        ));
                    }
                    set.insert("on".into(), Value::Array(ids.clone()));
                }
                None => {
                    return Err(KitToolError::invalid(format!(
                        "`{command}` acts on no object: it has no parameter for ids and does not read the selection, so `on` has nothing to set. Leave `on` out."
                    )));
                }
            }
        }
    }
    if let Some(time) = time {
        if !hooks {
            return Err(KitToolError::new(
                ErrorCode::Unsupported,
                "this kit cannot set its current time for a call (it has no `context.set`), so `at.time` cannot be honoured; nothing was run.",
            ));
        }
        set.insert("time".into(), json!(time));
    }
    let mut go = None;
    if let Some(part) = part {
        if hooks {
            set.insert("part".into(), part);
        } else if parts.is_some() {
            // A declared part noun has no command to go to it: only `context.set` reaches it.
            return Err(KitToolError::new(
                ErrorCode::Unsupported,
                format!("this kit cannot set its current part for a call (it has no `context.set`), so the part {part} cannot be honoured; nothing was run."),
            ));
        } else {
            go = Some(part);
        }
    }
    Ok(Planned { command, params, set: (!set.is_empty()).then_some(set), go })
}

/// Sets what `step` acts in and on before it runs: `context.set` with the step's members, else
/// the part through the kit's part command (`go`). A kit's refusal names what it could not set.
pub(crate) async fn set(kits: &KitManager, kit_id: &str, document_id: &str, step: &Planned) -> Result<(), KitToolError> {
    let Some(members) = &step.set else { return Ok(()) };
    let named = members.keys().map(|key| format!("`{key}`")).collect::<Vec<_>>().join(", ");
    match kits.context(Caller::Agent, kit_id, document_id, "context.set", members.clone()).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(KitToolError::new(ErrorCode::Unsupported, format!("this kit cannot set {named} for a call (it has no `context.set`)"))),
        Err(error) => {
            let mut failure = KitToolError::from(error).context(&format!("the kit could not set {named}: "));
            if failure.code == ErrorCode::COMMAND_FAILED {
                failure.code = ErrorCode::Unsupported;
            }
            Err(failure)
        }
    }
}

/// Refuses a run on a document open in its editor that names a context (the run's `target`, a
/// step's `on` or `at`): the editor's run takes none, and none is accepted and ignored.
pub(crate) fn refuse_in_editor(input: &Value, steps: &[Value], path: &str, editor: &str) -> Result<(), KitToolError> {
    let member = if input.get("target").is_some_and(|target| !target.is_null()) {
        Some("`target`")
    } else if steps.iter().any(|step| step.get("on").is_some()) {
        Some("a step's `on`")
    } else if steps.iter().any(|step| step.get("at").is_some()) {
        Some("a step's `at`")
    } else {
        None
    };
    match member {
        None => Ok(()),
        Some(member) => Err(KitToolError::new(
            ErrorCode::Unsupported,
            format!(
                "{member} cannot be honoured while `{path}` is open in its {editor} editor: the editor runs steps on its own current part and selection, and takes no call context. Nothing was run. Give the ids in the commands' own parameters, or ask the person to close the document so the kit edits the file."
            ),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acts() -> HashMap<String, Acts> {
        let mut acts = HashMap::new();
        acts.insert(
            "shape.text".to_owned(),
            Acts::of(&json!({ "properties": { "id": { "type": "string", "x-khp-role": "targets" } }, "x-khp-reads": ["part"] })),
        );
        acts.insert("shape.upper".to_owned(), Acts::of(&json!({ "properties": { "ids": { "type": "array", "x-khp-role": "targets" } } })));
        acts.insert("format.mark".to_owned(), Acts::of(&json!({ "type": "object", "x-khp-reads": ["selection", "part"] })));
        acts.insert("text.append".to_owned(), Acts::of(&json!({ "properties": { "text": { "type": "string" } } })));
        acts
    }

    #[test]
    fn a_commands_schema_says_what_it_acts_on() {
        let declared = &acts()["shape.upper"];
        assert_eq!(declared.targets, Some(("ids".to_owned(), true)));
        assert_eq!(acts()["shape.text"].targets, Some(("id".to_owned(), false)));
        assert_eq!(acts()["format.mark"].reads, ["selection", "part"]);
        assert_eq!(Acts::of(&json!({ "type": "object" })), Acts::default());
    }

    #[test]
    fn on_fills_the_target_parameter_and_the_part_comes_from_at_or_the_target() {
        let target = json!({ "slide": 1 });
        let steps = [
            json!({ "command": "shape.text", "on": ["s2"], "params": { "text": "x" } }),
            json!({ "command": "shape.upper", "on": ["s1", "s2"], "at": { "part": { "slideId": 7 } } }),
            json!({ "command": "format.mark", "on": ["s3"] }),
        ];
        let planned = plan(&steps, Some(&target), &acts(), true, None).unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(planned[0].params, Map::from_iter([("text".to_owned(), json!("x")), ("id".to_owned(), json!("s2"))]));
        assert_eq!(planned[0].set, Some(Map::from_iter([("part".to_owned(), target.clone())])));
        assert_eq!(planned[1].params["ids"], json!(["s1", "s2"]));
        assert_eq!(planned[1].set.as_ref().map(|set| set["part"].clone()), Some(json!({ "slideId": 7 })));
        assert_eq!(planned[2].set, Some(Map::from_iter([("on".to_owned(), json!(["s3"])), ("part".to_owned(), target)])));
        assert!(planned.iter().all(|step| step.go.is_none()));
        // Without hooks the part is gone to instead.
        let planned = plan(&steps[..2], Some(&json!({ "slide": 2 })), &acts(), false, None).unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!((planned[0].set.clone(), planned[0].go.clone()), (None, Some(json!({ "slide": 2 }))));
    }

    #[test]
    fn on_that_cannot_be_honoured_is_refused_and_says_why() {
        let refused = |step: Value, hooks: bool| {
            plan(&[json!({ "command": "text.append", "params": { "text": "a" } }), step], None, &acts(), hooks, None).err().unwrap_or_else(|| panic!("refused"))
        };
        let both = refused(json!({ "command": "shape.text", "on": ["s1"], "params": { "id": "s1" } }), true);
        assert_eq!((both.code, both.index), (ErrorCode::InvalidParams, Some(1)));
        assert!(both.message.contains("`on` and `id`"), "{}", both.message);
        let many = refused(json!({ "command": "shape.text", "on": ["s1", "s2"] }), true);
        assert!(many.message.contains("one object"), "{}", many.message);
        let aimless = refused(json!({ "command": "text.append", "on": ["s1"] }), true);
        assert!(aimless.message.contains("acts on no object"), "{}", aimless.message);
        let selection = refused(json!({ "command": "format.mark", "on": ["s1"] }), false);
        assert_eq!(selection.code, ErrorCode::Unsupported);
        let time = refused(json!({ "command": "text.append", "at": { "time": 2.5 } }), false);
        assert_eq!(time.code, ErrorCode::Unsupported);
        for bad in [
            json!({ "command": "x", "on": [] }),
            json!({ "command": "x", "on": "s1" }),
            json!({ "command": "x", "as": 1 }),
            json!({ "command": "x", "at": { "part": { "slide": 1, "page": 1 } } }),
        ] {
            assert_eq!(refused(bad.clone(), true).code, ErrorCode::InvalidParams, "{bad}");
        }
    }

    /// The rule for `on`: it fills the command's declared `targets` when there is one
    /// (and then sets no selection, even for a command that also reads it: explicit ids else the
    /// selection, as the video kit's `clip.enable`); else it becomes the selection when the command
    /// reads it, and the step's other parameters go as given, an id parameter that is not the
    /// declared `targets` among them (the video kit's commands that take clips and items declare
    /// none); else it is refused. Giving both `on` and the declared `targets` parameter is refused,
    /// even with the same ids; no other parameter conflicts with `on`.
    #[test]
    fn on_fills_the_targets_else_the_selection_and_conflicts_only_with_the_targets_parameter() {
        let mut acts = acts();
        acts.insert(
            "clip.enable".to_owned(),
            Acts::of(&json!({ "properties": { "clips": { "type": "array", "x-khp-role": "targets" }, "on": { "type": "boolean" } }, "x-khp-reads": ["selection", "part"] })),
        );
        acts.insert(
            "clip.label".to_owned(),
            Acts::of(&json!({ "properties": { "clips": { "type": "array" }, "items": { "type": "array" } }, "x-khp-reads": ["selection"] })),
        );
        let planned = |step: Value| plan(&[step], None, &acts, true, None);
        let filled = planned(json!({ "command": "clip.enable", "on": [4, 5], "params": { "on": false } })).unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(filled[0].params, Map::from_iter([("on".to_owned(), json!(false)), ("clips".to_owned(), json!([4, 5]))]));
        assert_eq!(filled[0].set, None, "the declared targets take the ids; the selection is not set");
        let selected = planned(json!({ "command": "clip.label", "on": [4], "params": { "items": [9] } })).unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(selected[0].params["items"], json!([9]), "an id parameter that is not the declared targets goes as given");
        assert_eq!(selected[0].set, Some(Map::from_iter([("on".to_owned(), json!([4]))])), "`on` is the selection");
        for both in [
            json!({ "command": "clip.enable", "on": [4], "params": { "clips": [4] } }),
            json!({ "command": "clip.enable", "on": [4], "params": { "clips": [5] } }),
        ] {
            let refused = planned(both.clone()).err().unwrap_or_else(|| panic!("{both} refused"));
            assert_eq!(refused.code, ErrorCode::InvalidParams, "{both}");
            assert!(refused.message.contains("`on` and `clips`"), "{}", refused.message);
        }
        let aimless = planned(json!({ "command": "text.append", "on": [4] })).err().map(|error| error.code);
        assert_eq!(aimless, Some(ErrorCode::InvalidParams), "neither targets nor the selection");
    }

    /// `on` reaches a command in the id type its target parameter declares; a schema
    /// says which parameters name a place, whether the command depends on its target's position,
    /// and which parameters it takes, so one it does not take is refused in the kit's words.
    #[test]
    fn on_takes_the_declared_id_type_and_a_schema_says_places_position_and_parameters() {
        let mut acts = acts();
        let clip = Acts::of(&json!({
            "type": "object", "additionalProperties": false, "x-khp-position": "independent",
            "properties": { "clip": { "type": "integer", "x-khp-role": "targets" }, "track": { "type": "string", "x-khp-role": "place" }, "opacity": { "type": "number" } }
        }));
        assert_eq!((clip.id_type, clip.independent, clip.places.clone()), (Some("integer"), true, vec!["track".to_owned()]));
        acts.insert("clip.opacity".to_owned(), clip.clone());
        let many = Acts::of(&json!({ "properties": { "ids": { "type": "array", "items": { "type": "string" }, "x-khp-role": "targets" } } }));
        acts.insert("shape.many".to_owned(), many);
        let planned = plan(&[json!({ "command": "clip.opacity", "on": ["9"] }), json!({ "command": "shape.many", "on": [7, "s2"] })], None, &acts, true, None)
            .unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(planned[0].params["clip"], json!(9), "a numeric string for an integer id");
        assert_eq!(planned[1].params["ids"], json!(["7", "s2"]), "a number for a string id");
        let refused = clip.refuse_unknown("clip.opacity", Some(&json!({ "clip": 9, "near": "3" }))).err().unwrap_or_else(|| panic!("refused"));
        assert_eq!(refused.code, ErrorCode::InvalidParams);
        assert!(refused.message.contains("`near`") && refused.message.contains("`opacity`"), "{}", refused.message);
        assert!(acts["shape.text"].refuse_unknown("shape.text", Some(&json!({ "anything": 1 }))).is_ok(), "an open schema takes any key");
    }

    /// a target parameter's index spelling (`x-khp-index`) is a place: `on` refuses it
    /// and takes ids; the parameter itself takes it.
    #[test]
    fn on_refuses_a_declared_index_spelling() {
        let mut acts = acts();
        let layer = Acts::of(
            &json!({ "properties": { "layer": { "oneOf": [{ "type": "integer" }, { "type": "string" }], "x-khp-role": "targets", "x-khp-index": "#" } } }),
        );
        assert_eq!(
            (layer.index_of(&json!("#3")), layer.index_of(&json!("#x")), layer.index_of(&json!(3)), layer.index_of(&json!("#0"))),
            (Some(2), None, None, None)
        );
        acts.insert("prop.set".to_owned(), layer);
        let refused = plan(&[json!({ "command": "prop.set", "on": ["#3"] })], None, &acts, true, None).err().unwrap_or_else(|| panic!("refused"));
        assert_eq!(refused.code, ErrorCode::InvalidParams);
        assert!(refused.message.contains("`#3`") && refused.message.contains("params.layer"), "{}", refused.message);
        assert!(plan(&[json!({ "command": "prop.set", "on": [7] })], None, &acts, true, None).is_ok());
        assert!(plan(&[json!({ "command": "prop.set", "params": { "layer": "#3" } })], None, &acts, true, None).is_ok());
        assert!(acts["shape.text"].index_of(&json!("#3")).is_none(), "no spelling declared: an id");
    }

    #[test]
    fn names_in_other_parameters_keep_names_that_look_like_target_indexes() {
        let acts = Acts::of(&json!({ "properties": {
            "object": { "type": "string", "x-khp-role": "targets", "x-khp-index": "#", "x-khp-name": "name", "x-khp-types": ["Object"] },
            "material": { "type": "string", "x-khp-role": "object", "x-khp-name": "name", "x-khp-types": ["Material"] },
            "rules": { "type": "array", "items": { "type": "object", "properties": {
                "source": { "type": "string", "x-khp-name": "name", "x-khp-types": ["Material"] }
            } } }
        } }));
        let names = acts.named_values(&json!({ "object": "#2", "material": "#3", "rules": [{ "source": "#4" }] }));
        assert_eq!(
            names,
            vec![
                ("#3".to_owned(), "name".to_owned(), Some(vec!["Material".to_owned()])),
                ("#4".to_owned(), "name".to_owned(), Some(vec!["Material".to_owned()]))
            ]
        );
    }

    #[test]
    fn name_union_does_not_treat_point_coordinates_as_object_ids() {
        let acts = Acts::of(&json!({"properties":{"focus":{
            "oneOf":[{"type":"string"},{"type":"integer"},{"type":"array","items":{"type":"number"}},{"type":"object","properties":{"x":{"type":"number"}}}],
            "x-khp-name":"name","x-khp-role":"object","x-khp-types":["Node"]
        }}}));
        for value in [json!([1, 2, 3]), json!({"x":1})] {
            let mut ids = std::collections::BTreeSet::new();
            acts.nested_ids("focus", &value, &mut ids);
            assert!(ids.is_empty());
            assert!(acts.named_values(&json!({"focus":value})).is_empty());
        }
        assert!(acts.names_objects("focus"));
        assert_eq!(acts.named_values(&json!({"focus":"Box"}))[0].0, "Box");
    }

    #[test]
    fn a_kit_s_declared_part_nouns_are_its_parts_and_pass_through() {
        let parts: Option<&[&str]> = Some(&["sequence", "comp"]);
        for part in [json!({ "sequence": 2 }), json!({ "sequence": "seq-9" }), json!({ "comp": 0 })] {
            assert!(check_part(&part, "target", parts).is_ok(), "{part}");
        }
        let unknown = check_part(&json!({ "slide": 1 }), "at.part", parts).err().unwrap_or_else(|| panic!("refused"));
        assert_eq!(unknown.code, ErrorCode::InvalidParams);
        assert!(unknown.message.contains("`slide`") && unknown.message.contains("`sequence` or `comp`"), "{}", unknown.message);
        for bad in [json!({ "sequence": true }), json!({ "sequence": "" }), json!({ "sequence": 1, "comp": 1 }), json!({})] {
            assert_eq!(check_part(&bad, "target", parts).err().map(|error| error.code), Some(ErrorCode::InvalidParams), "{bad}");
        }
        let target = json!({ "sequence": "seq-9" });
        let planned = plan(&[json!({ "command": "text.append" })], Some(&target), &acts(), true, parts).unwrap_or_else(|error| panic!("{}", error.message));
        assert_eq!(planned[0].set, Some(Map::from_iter([("part".to_owned(), target.clone())])), "the part goes to the kit unchanged");
        let without_hooks = plan(&[json!({ "command": "text.append" })], Some(&target), &acts(), false, parts).err().map(|error| error.code);
        assert_eq!(without_hooks, Some(ErrorCode::Unsupported), "only context.set reaches a declared part");
        assert!(check_part(&json!({ "sequence": 1 }), "target", None).is_err(), "a kit that declares none keeps slides and pages");
    }

    #[test]
    fn a_run_in_an_open_editor_names_the_context_it_cannot_honour() {
        let steps = [json!({ "command": "a" })];
        assert!(refuse_in_editor(&json!({}), &steps, "a.x", "X").is_ok());
        let refused = refuse_in_editor(&json!({ "target": { "slide": 1 } }), &steps, "a.x", "X").err().unwrap_or_else(|| panic!("refused"));
        assert_eq!(refused.code, ErrorCode::Unsupported);
        assert!(refused.message.contains("`target`") && refused.message.contains("open in its X editor"), "{}", refused.message);
    }
}
