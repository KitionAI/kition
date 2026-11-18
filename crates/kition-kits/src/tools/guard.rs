// Copied from kition-sdk crates/kition-kits/src/tools/guard.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The premise guard: a write that passes `basis` is checked, before anything runs, against
//! what others changed since (the journal's entries after `basis` by another author).
//!
//! A write's premises are what it acts on as the agent was told about them: its targets (every id
//! in a step's `on` and in the parameter a command declares as its `targets`, every object a batch
//! operation names, and the declared targets of a batch's `command` operations), every object any
//! other parameter names (below), the part a step addresses (`at.part`, the run's `target`), and
//! the fields a batch replaces (`set`, `text.set`).
//!
//! An object a parameter names: in a step's or a batch `command` operation's parameters other than
//! the declared target, a `set` operation's `value` and a `create` operation's `fields`, each string
//! that is a parameter's whole value, an item of a list, or a member of an object or of a list's
//! objects (one level deep, nothing deeper) is a premise on any field when the WHOLE string names
//! an object of the document as it was at `basis`: one others' changes name (and did not create),
//! or one the document has now, by tool id or object id. A string that names none (free text) is
//! nothing; a part of a string never counts.
//! The write is refused as a whole (`conflict`) when others:
//!
//! - deleted a target, or the part it names by id (`deleted`);
//! - relocated a target: moved it, moved an object holding it, or created, deleted or moved
//!   objects before it in its list so that its index changed; or changed which part a part number
//!   names (`relocated`, with `now`). The parts are the objects of the type whose tool id carries
//!   the part's noun (`slide:` for `{"slide": 3}` and `{"slideId": 260}`; a kit's declared nouns,
//!   `agent.parts`, by id only), in the root's list of that type;
//! - changed a field a batch replaces, or any field of a command's target, whose written fields
//!   are not known (`changed`). A change inside the target counts: change sets name a change of
//!   an object without a tool id under the nearest object holding it that has one, at a path
//!   (`body.paragraphs.0.text`, which a batch replacing `body` conflicts with), and a change of an
//!   object with a tool id the target holds (a text body inside a shape) is a change of the
//!   target. Holding is the schema's ownership: list and tree fields, and refs declared `owns`.
//!
//! A step that names what it acts on by a place (`at.time`, a place parameter, or a target value in
//! the command's index spelling, `"#3"`) has the premise that the place names what it named at
//! `basis`. A step that names no object (no `on`, no target, no place, no parameter naming an
//! object) and addresses a part acts on the part: others' changes of the part's own fields refuse
//! it (`changed`); with object targets the part is a premise of existence (and position) only.
//!
//! An index is followed through every entry after `basis`, the caller's own included (they moved
//! nothing it did not see), by where each entry put and took objects in that list: objects that
//! stayed keep their order. When an entry by others cannot say what it changed, or the journal no
//! longer covers `basis`, the answer is `unknown`.
//!
//! Every read is a batch of no operations sent as the agent (origin `{ kind: agent }`), as a kit
//! process requires on the agent's connection; it makes no edit and no undo step.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{Map, Value, json};

use super::context::Acts;
use super::journal::Entry;
use super::model::agent_origin;
use super::receipts;
use crate::bridge::LiveDocument;
use crate::manager::{Caller, DocumentView, KitManager};

/// What a step needs of one object it names: the fields or paths it reads or replaces, and the
/// positions it depends on (fields the schema marks `position`, and the list holding it by the
/// field a change set names, for its index there). `None`: every one.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Need {
    fields: Option<BTreeSet<String>>,
    positions: Option<BTreeSet<String>>,
    identities: BTreeMap<String, BTreeSet<String>>,
}

impl Need {
    /// Every field and every position: what a step needs of an object it names when neither the
    /// kit nor the command's declarations say less.
    fn all() -> Self {
        Self::default()
    }

    /// Every field; no position when `independent` (`x-khp-position: independent`).
    fn of_command(independent: bool) -> Self {
        Self { positions: independent.then(BTreeSet::new), ..Self::default() }
    }

    /// These fields, every position (a batch's `set` of a field).
    fn fields(fields: BTreeSet<String>) -> Self {
        Self { fields: Some(fields), ..Self::default() }
    }

    /// What two steps need together: every field either needs (every one when one needs every
    /// one), and every position.
    fn merge(&mut self, other: &Need) {
        fn union(into: &mut Option<BTreeSet<String>>, more: &Option<BTreeSet<String>>) {
            match (into.as_mut(), more) {
                (Some(known), Some(more)) => known.extend(more.iter().cloned()),
                _ => *into = None,
            }
        }
        union(&mut self.fields, &other.fields);
        union(&mut self.positions, &other.positions);
        for (selector, members) in &other.identities {
            self.identities.entry(selector.clone()).or_default().extend(members.iter().cloned());
        }
    }

    /// What a kit's premise (`context.under`'s `premises`) says one call needs.
    fn of_premise(premise: &Value) -> Self {
        let set = |key: &str| premise.get(key).and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect());
        let identities = premise["identities"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(selector, member)| Some((selector.clone(), BTreeSet::from([member.as_str()?.to_owned()]))))
            .collect();
        Self { fields: set("fields"), positions: set("positions"), identities }
    }

    /// Whether the position `name` (a field marked `position` or a path inside one, `location.0`,
    /// or a list's field) matters.
    fn position(&self, name: &str) -> bool {
        self.positions.as_ref().is_none_or(|positions| positions.iter().any(|wanted| overlaps(name, wanted)))
    }

    /// Whether any position matters.
    fn any_position(&self) -> bool {
        self.positions.as_ref().is_none_or(|positions| !positions.is_empty())
    }
}

/// The field a path starts at (`location` of `location.0`).
fn root_field(path: &str) -> &str {
    if let Some(pointer) = path.strip_prefix('/') { pointer.split('/').next().unwrap_or(pointer) } else { path.split('.').next().unwrap_or(path) }
}

/// The members of `now` that say where an object is in a list: a position field of the same name
/// goes in `now.fields`.
const LIST_PLACE: [&str; 3] = ["parent", "field", "index"];

fn add_need(into: &mut BTreeMap<String, Need>, id: String, need: Need) {
    match into.get_mut(&id) {
        Some(known) => known.merge(&need),
        None => {
            into.insert(id, need);
        }
    }
}

/// One call as the kit is asked about it (`context.under`): its command and parameters, with the
/// part and time the step sets.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Ask {
    step: usize,
    command: String,
    /// The step's `on` when the command takes it through the selection (no target parameter):
    /// set as the selection for the question, as for the step.
    on: Vec<Value>,
    /// The step's parameters, as the kit gets them.
    params: Value,
    part: Option<Value>,
    time: Option<f64>,
}

/// One step of a run: what it asks the kit, and the objects it names itself (`on`, its declared
/// targets) with what it needs of each by its command's declarations.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Step {
    state: BTreeSet<String>,
    ask: Ask,
    under: Option<Value>,
    ids: BTreeMap<String, Need>,
    /// A step with no time of its own (no `at.time`) whose command reads the time, after an
    /// earlier step of the same run that may have moved it: the time it reads is not known before
    /// the run.
    later_time: Option<Value>,
    /// The target values that may be names (the command declares `x-khp-name`): each
    /// with the field holding names.
    names: Vec<(String, String, Option<Vec<String>>)>,
}

/// What a write acts on, as the agent was told about it.
#[derive(Clone, Debug, Default)]
pub(crate) struct Premises {
    /// A batch's targets, and what it needs of each: the fields `set` and `text.set` replace, any
    /// field for a command.
    targets: BTreeMap<String, Need>,
    /// A run's steps: each asks the kit what it depends on.
    steps: Vec<Step>,
    /// The parts addressed by number: the part's noun (`slide`) and the number, from 1.
    numbered: BTreeSet<(String, u64)>,
    /// The parts addressed by their stable id: the part's noun and the id (`slide`, `260`).
    named: BTreeSet<(String, String)>,
    /// Every other string a step's or operation's parameters hold where an id may be (module
    /// docs), and every whole number a parameter that names objects holds (`"x-khp-role":
    /// "object"` or an index spelling): a premise, on any
    /// field, when it names an object of the document as it was at `basis` ([`conflicts`] reads
    /// which do).
    mentioned: BTreeSet<String>,
    /// The mentioned values of a parameter that names objects of given types (`x-khp-types`,
    /// ): such a value is a premise only when it names an object of one of them.
    typed: BTreeMap<String, Vec<String>>,
    /// The steps that name what they act on by a place (module docs).
    places: Vec<PlaceStep>,
    /// The steps that name no object (no `on`, no target, not by a place) and address a part:
    /// unless a parameter names an object, the part is what they act on (module docs).
    part_steps: Vec<PartStep>,
    state: BTreeSet<String>,
    batch: Vec<Value>,
    text_ranges: Vec<TextRange>,
    raw_values: Option<(Vec<Value>, BTreeSet<String>)>,
}

#[derive(Clone, Debug)]
struct TextRange {
    owner: String,
    paths: Vec<Place>,
    from: usize,
    to: usize,
}

/// A part as a step addresses it: by the id of a declared noun or `slideId`/`pageId`, or by
/// number (`{"slide": 3}`).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum PartRef {
    Named(String, String),
    Numbered(String, u64),
}

/// A step that names no object and addresses a part: the strings its parameters hold that may be
/// ids. When none names an object, the part is its target: others' changes of the part's own
/// fields refuse it (`changed`), not those of the objects with tool ids it holds nor of its lists.
#[derive(Clone, Debug, PartialEq)]
struct PartStep {
    part: PartRef,
    mentioned: BTreeSet<String>,
}

/// A step that names what it acts on by a place: a command given a parameter it marks
/// `x-khp-role: place` (a track, a time, an index), also beside its declared targets (where a
/// placed clip lands), a value in its index spelling in any parameter, a command that reads the
/// time given `at.time` (also beside `on` or its declared targets), or, with neither,
/// one that reads the current time. Its
/// premise: the objects under that place (`context.under`) are those that were there at `basis`,
/// and their content as the step needs it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PlaceStep {
    /// The step's index in [`Premises::steps`].
    step: usize,
    /// The place as the agent named it: `time`, `part` and the place parameters.
    named: Value,
    /// The places in a list a parameter names by the command's index spelling (`"#3"`, counted
    /// from 0 here): the premise is that each still names the object it named at `basis`.
    indexes: Vec<usize>,
    /// Whole numbers in the target parameter of a command that reads one naming no object as a
    /// place (`x-khp-index-numbers`): each an index (counted from 0) when it names no object at
    /// `basis` or now, else an id.
    numbers: Vec<(usize, String)>,
    /// The types the target parameter names (`x-khp-types`): a number naming an object
    /// of another type names none of these, and is a place.
    types: Option<Vec<String>>,
    /// Whether the step names a place besides `numbers`.
    placed: bool,
    /// The command's index spelling (`"#"`), and whether it counts from the other end of the list
    /// (`x-khp-index-order: "reversed"`: `"#1"` the last item stored).
    spelling: Option<String>,
    reversed: bool,
}

/// The values of a parameter that may be ids: the value itself, the items of a list, and the
/// members of an object or of a list's objects, one level deep; nothing deeper, and never a part
/// of a string. Strings always; whole numbers when `integers` (a parameter that names objects,
///; any that took integers in ).
fn mentioned_in(value: &Value, integers: bool, out: &mut BTreeSet<String>) {
    let mut one = |value: &Value| {
        if let Some(text) = value.as_str().filter(|text| !text.is_empty() && !text.starts_with('$') && *text != "root") {
            out.insert(text.to_owned());
        } else if let Some(number) = value.as_u64().filter(|_| integers) {
            out.insert(number.to_string());
        }
    };
    let members = |object: &Map<String, Value>, one: &mut dyn FnMut(&Value)| object.values().for_each(one);
    match value {
        Value::Array(items) => {
            for item in items {
                match item {
                    Value::Object(object) => members(object, &mut one),
                    other => one(other),
                }
            }
        }
        Value::Object(object) => members(object, &mut one),
        other => one(other),
    }
}

/// The values of a parameter in the command's index spelling (`"#2"`), one level deep as
/// [`mentioned_in`] reads: each an index counted from 0.
fn indexes_in(value: &Value, acts: &Acts, out: &mut Vec<usize>) {
    let mut one = |value: &Value| out.extend(acts.index_of(value));
    match value {
        Value::Array(items) => {
            for item in items {
                match item {
                    Value::Object(object) => object.values().for_each(&mut one),
                    other => one(other),
                }
            }
        }
        Value::Object(object) => object.values().for_each(&mut one),
        other => one(other),
    }
}

/// One conflict: the object or part, why, and where it is now when it still exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unavailable {
    History,
    Place,
    State,
    Input,
    ContentBasis,
    Content,
    FactBasis,
    Fact,
    Identity,
    Renumbered,
    Type,
    Selector,
}

impl Unavailable {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::History => "Change history unavailable: the server cannot reconstruct the changes since the basis",
            Self::Place => "Place basis unavailable: the objects, order or content at the held place cannot be compared",
            Self::State => "Editor state unavailable: the state this command reads cannot be compared with its basis",
            Self::Input => "External input basis unavailable: a consumed input has no comparable observed fingerprint",
            Self::ContentBasis => "Content basis unavailable: the complete prior field value was not retained or cannot be reconstructed",
            Self::Content => "Content comparison unavailable: the kit cannot compare the held region, or its historical blob bytes are unavailable",
            Self::FactBasis => "Fact basis unavailable or evicted: the retained model checkpoint does not cover this basis",
            Self::Fact => "Derived fact comparison unavailable: the kit or its recorded fact history cannot establish equality",
            Self::Identity => "Identity unprovable: the kit cannot establish that this id still names the basis object",
            Self::Renumbered => "Objects renumbered: another program reassigned tool ids, which may now name other objects",
            Self::Type => "Object type changed: the id no longer has its basis object type",
            Self::Selector => "Selector identity unprovable: the selected entry or its identity history cannot be reconstructed",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Conflict {
    pub(crate) id: Option<String>,
    pub(crate) reason: &'static str,
    pub(crate) now: Option<Value>,
    /// For a step that names what it acts on by a place: that place as the step named it, and
    /// `under`, the objects it names now.
    pub(crate) place: Option<Value>,
    /// The object's type, when a change set or a read says it: its id is answered in the form its
    /// type's tool ids take, not by the "all digits" rule.
    pub(crate) ty: Option<String>,
    pub(crate) cause: Option<Unavailable>,
}

impl Conflict {
    pub(crate) fn unknown() -> Self {
        Self::of(None, "unknown", None).because(Unavailable::History)
    }

    pub(crate) fn of(id: Option<String>, reason: &'static str, now: Option<Value>) -> Self {
        Self { id, reason, now, place: None, ty: None, cause: None }
    }

    pub(crate) fn because(mut self, cause: Unavailable) -> Self {
        if self.reason == "unknown" {
            self.cause = Some(cause);
        }
        self
    }

    pub(crate) fn explanation(&self) -> String {
        let message = self.cause.unwrap_or(Unavailable::Place).message();
        match self.place.as_ref().and_then(|place| place["unknown"].as_str()) {
            Some(detail) => format!("{message} ({detail})"),
            None => message.into(),
        }
    }

    pub(crate) fn is_renumbered(&self) -> bool {
        self.reason == "unknown" && self.cause == Some(Unavailable::Renumbered)
    }

    pub(crate) fn to_json(&self) -> Value {
        let mut conflict = json!({ "reason": self.reason });
        if let Some(id) = &self.id {
            conflict["id"] = json!(id);
        }
        if let Some(now) = &self.now {
            conflict["now"] = now.clone();
        }
        if let Some(place) = &self.place {
            conflict["place"] = place.clone();
        }
        conflict
    }
}

fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(id) if !id.is_empty() => Some(id.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// The part nouns a kit takes when it declares none (`agent.parts`): a slide or a page, by number
/// from 1 (`{"slide": 3}`) or by id (`{"slideId": 260}`).
const DEFAULT_NOUNS: [&str; 2] = ["slide", "page"];

impl Premises {
    pub(crate) fn reads_state(&self) -> bool {
        !self.state.is_empty()
    }
    /// A command's parameters: the declared target parameter's ids are targets (into `ids`, with
    /// what the command needs of them). Other parameters hold ids only at schema-declared
    /// reference positions; ordinary values never infer a reference from their spelling.
    fn params(&mut self, params: Option<&Value>, acts: Option<&Acts>, ids: &mut BTreeMap<String, Need>) {
        let declared = acts.and_then(|acts| acts.targets.as_ref()).map(|(param, _)| param.as_str());
        let independent = acts.is_some_and(|acts| acts.independent);
        for (name, given) in params.and_then(Value::as_object).into_iter().flatten() {
            if Some(name.as_str()) == declared {
                // A value in the command's index spelling (`"#3"`) is a place, not an id.
                let values: Vec<&Value> = match given {
                    Value::Array(items) => items.iter().collect(),
                    other => vec![other],
                };
                for id in values.into_iter().filter(|id| acts.is_none_or(|acts| acts.index_of(id).is_none())).filter_map(id_text) {
                    if !id.starts_with('$') && id != "root" {
                        add_need(ids, id, Need::of_command(independent));
                    }
                }
            } else if !acts.is_some_and(|acts| acts.places.contains(name)) {
                let mut found = BTreeSet::new();
                if let Some(acts) = acts {
                    acts.nested_ids(name, given, &mut found);
                } else {
                    // Raw creation fields are resolved against the model schema before use.
                    mentioned_in(given, false, &mut found);
                }
                found.retain(|text| acts.is_none_or(|acts| acts.index_of(&Value::String(text.clone())).is_none()));
                if let Some(types) = acts.and_then(|acts| acts.types_of(name)) {
                    for text in &found {
                        self.typed.entry(text.clone()).or_default().extend(types.iter().cloned());
                    }
                }
                self.mentioned.extend(found);
            }
        }
    }

    /// The values a step's parameters hold that may be ids, but for its target and place
    /// parameters ([`Premises::params`]).
    fn mentions(params: Option<&Value>, acts: Option<&Acts>) -> BTreeSet<String> {
        let mut one = Self::default();
        one.params(params, acts, &mut BTreeMap::new());
        one.mentioned
    }

    /// The part a step addresses, as a [`PartRef`]: a declared noun's id, else a slide or page by
    /// id or number.
    fn part_ref(part: &Value, nouns: Option<&[&str]>) -> Option<PartRef> {
        match nouns {
            Some(nouns) => nouns.iter().find_map(|noun| part.get(*noun).and_then(id_text).map(|id| PartRef::Named((*noun).to_owned(), id))),
            None => DEFAULT_NOUNS.iter().find_map(|noun| {
                part.get(*noun)
                    .and_then(Value::as_u64)
                    .map(|number| PartRef::Numbered((*noun).to_owned(), number))
                    .or_else(|| part.get(format!("{noun}Id")).and_then(id_text).map(|id| PartRef::Named((*noun).to_owned(), id)))
            }),
        }
    }

    /// A part as a call gives it: one of the kit's declared nouns (`nouns`, by the part's id), or
    /// else a slide or page by number or id.
    fn part(&mut self, part: &Value, nouns: Option<&[&str]>) {
        match nouns {
            Some(nouns) => {
                for noun in nouns {
                    if let Some(id) = part.get(*noun).and_then(id_text) {
                        self.named.insert(((*noun).to_owned(), id));
                    }
                }
            }
            None => {
                for noun in DEFAULT_NOUNS {
                    if let Some(number) = part.get(noun).and_then(Value::as_u64) {
                        self.numbered.insert((noun.to_owned(), number));
                    }
                    if let Some(id) = part.get(format!("{noun}Id")).and_then(id_text) {
                        self.named.insert((noun.to_owned(), id));
                    }
                }
            }
        }
    }

    /// The premises of a run's `steps` (in the agent's undo scope already), with the run's
    /// `target`, what each command acts on (`acts`) and the kit's part nouns (`agent.parts`).
    pub(crate) fn of_run(steps: &[Value], target: Option<&Value>, acts: &HashMap<String, Acts>, nouns: Option<&[&str]>) -> Self {
        let mut premises = Self::default();
        for (number, step) in steps.iter().enumerate() {
            let mut state = BTreeSet::new();
            let command = step.get("command").and_then(Value::as_str).unwrap_or_default();
            let declared = acts.get(command);
            let independent = declared.is_some_and(|acts| acts.independent);
            let mut ids: BTreeMap<String, Need> = BTreeMap::new();
            for id in step.get("on").and_then(Value::as_array).into_iter().flatten().filter_map(id_text) {
                add_need(&mut ids, id, Need::of_command(independent));
            }
            premises.params(step.get("params"), declared, &mut ids);
            let part = step.get("at").and_then(|at| at.get("part")).filter(|part| !part.is_null()).or(target);
            if let Some(part) = part {
                premises.part(part, nouns);
            }
            let params = step.get("params").cloned().unwrap_or_else(|| json!({}));
            let given_targets =
                declared.and_then(|acts| acts.targets.as_ref()).and_then(|(param, _)| step.get("params")?.get(param)).filter(|ids| !ids.is_null());
            if let Some(acts) = declared {
                for read in &acts.reads {
                    let explicit = match read.as_str() {
                        "selection" => step.get("on").is_some() || given_targets.is_some(),
                        "part" => part.is_some(),
                        "time" => step.get("at").and_then(|at| at.get("time")).is_some(),
                        _ => false,
                    };
                    if !explicit {
                        premises.state.insert(read.clone());
                        state.insert(read.clone());
                    }
                }
            }
            let target_values: Vec<Value> = match given_targets {
                Some(Value::Array(items)) => items.clone(),
                Some(other) => vec![other.clone()],
                None => Vec::new(),
            };
            // The target parameter's values in the command's index spelling (`"#3"`), and those in
            // any other parameter (`parent: "#2"`): places.
            let mut indexes: Vec<usize> = target_values.iter().filter_map(|value| declared.and_then(|acts| acts.index_of(value))).collect();
            let mut spelled: Map<String, Value> = Map::new();
            if let Some(acts) = declared {
                let target = acts.targets.as_ref().map(|(param, _)| param.as_str());
                for (name, value) in params.as_object().into_iter().flatten().filter(|(name, _)| Some(name.as_str()) != target) {
                    let count = indexes.len();
                    if !acts.places.contains(name) && acts.names_objects_at(name, value) {
                        indexes_in(value, acts, &mut indexes);
                    }
                    if indexes.len() > count {
                        spelled.insert(name.clone(), value.clone());
                    }
                }
            }
            // Whole numbers a command reads as a place when they name no object.
            let numbers: Vec<(usize, String)> = target_values
                .iter()
                .filter(|_| declared.is_some_and(|acts| acts.index_numbers))
                .filter_map(|value| Some((usize::try_from(value.as_u64()?.checked_sub(1)?).ok()?, value.as_u64()?.to_string())))
                .collect();
            let by_id = step.get("on").is_some() || target_values.iter().any(|value| declared.is_none_or(|acts| acts.index_of(value).is_none()));
            let reads_time = declared.is_some_and(|acts| acts.reads("time"));
            let at_time = step.get("at").and_then(|at| at.get("time")).and_then(Value::as_f64);
            let time = at_time.filter(|_| reads_time);
            let mut given: Map<String, Value> = declared
                .into_iter()
                .flat_map(|acts| acts.places.iter())
                .filter_map(|name| params.get(name).filter(|value| !value.is_null()).map(|value| (name.clone(), value.clone())))
                .collect();
            // A step that names no object and addresses a part acts on the part, unless a
            // parameter names an object ([`conflicts`] reads which do).
            let named_by_place = !indexes.is_empty() || !given.is_empty() || (reads_time && at_time.is_some());
            if step.get("on").is_none()
                && given_targets.is_none()
                && !named_by_place
                && let Some(part) = part.and_then(|part| Self::part_ref(part, nouns))
            {
                premises.part_steps.push(PartStep { part, mentioned: Self::mentions(step.get("params"), declared) });
            }
            // No time of its own, and an earlier step of the run that may have moved it: what it
            // reads is not known before the run.
            let current_time = reads_time && at_time.is_none() && !by_id && indexes.is_empty() && given.is_empty() && step.get("on").is_none();
            let later_time = (current_time && number > 0).then(|| json!({ "command": command, "time": "set by an earlier step of the run" }));
            // The kit is asked with `on` in the target parameter, as the command gets it.
            let mut asked = params.clone();
            let selected: Vec<Value> = match declared.and_then(|acts| acts.targets.as_ref()) {
                Some(_) => Vec::new(),
                None => step.get("on").and_then(Value::as_array).cloned().unwrap_or_default(),
            };
            if let (Some(acts), Some(on)) = (declared, step.get("on").and_then(Value::as_array))
                && let Some((param, many)) = &acts.targets
                && let Some(asked) = asked.as_object_mut()
            {
                let ids: Vec<Value> = on.iter().map(|id| acts.id_as_declared(id)).collect();
                match (many, ids.as_slice()) {
                    (true, _) => {
                        asked.insert(param.clone(), Value::Array(ids));
                    }
                    (false, [one]) => {
                        asked.insert(param.clone(), one.clone());
                    }
                    _ => {}
                }
            }
            let ask = Ask { step: number, command: command.to_owned(), on: selected, params: asked, part: part.cloned(), time };
            // Target strings that may be names: told apart from ids when the document is read.
            let names = declared.map(|acts| acts.named_values(&params)).unwrap_or_default();
            premises.steps.push(Step { state, ask, under: None, ids, later_time, names });
            // A place: a place parameter (also beside the declared targets: where a placed clip
            // lands), an index spelling, or the time the command reads, also for a step that
            // names objects by id; the kit's
            // `under` decides what the time names (nothing, for a time that selects no object).
            let placed = !indexes.is_empty() || !given.is_empty() || time.is_some() || (current_time && number == 0);
            if !placed && numbers.is_empty() {
                continue;
            }
            if let Some((param, _)) = declared.and_then(|acts| acts.targets.as_ref()).filter(|(param, _)| {
                target_values.iter().any(|value| declared.is_some_and(|acts| acts.index_of(value).is_some()))
                    || (!numbers.is_empty() && params.get(param).is_some())
            }) {
                given.insert(param.clone(), params[param].clone());
            }
            given.extend(spelled);
            let mut named = Value::Object(given);
            if let Some(time) = time {
                named["time"] = json!(time);
            }
            if let Some(part) = part {
                named["part"] = part.clone();
            }
            let types = declared.and_then(|acts| acts.targets.as_ref().and_then(|(param, _)| acts.types_of(param)));
            let spelling = declared.and_then(|acts| acts.index.clone());
            let reversed = declared.is_some_and(|acts| acts.index_reversed);
            premises.places.push(PlaceStep { step: number, named, indexes, numbers, types, placed, spelling, reversed });
        }
        premises
    }

    /// The premises of a batch's `ops`: the objects each names, the fields `set` and `text.set`
    /// replace, and the targets a `command` operation's command declares (`acts`), on any field.
    pub(crate) fn of_batch(ops: &[Value], acts: &HashMap<String, Acts>) -> Self {
        let commands: Vec<_> = ops
            .iter()
            .filter(|op| op["op"] == "command")
            .map(|op| {
                let mut step = json!({"command":op["id"],"params":op.get("params").cloned().unwrap_or_else(||json!({}))});
                for key in ["on", "at"] {
                    if let Some(value) = op.get(key) {
                        step[key] = value.clone();
                    }
                }
                step
            })
            .collect();
        let mut premises = Self::of_run(&commands, None, acts, None);
        premises.raw_values = Some((ops.to_vec(), premises.mentioned.clone()));
        let named = |text: &str| !text.is_empty() && !text.starts_with('$') && text != "root";
        let mut targets: BTreeMap<String, Need> = BTreeMap::new();
        for op in ops {
            let name = op.get("op").and_then(Value::as_str).unwrap_or_default();
            let positional =
                matches!(name, "list.insert" | "list.move" | "list.remove" | "tree.insert" | "tree.move") || name == "create" && op["in"].is_string();
            if positional {
                premises.batch.push(op.clone());
            }
            if matches!(name, "text.insert" | "text.delete" | "text.set")
                && op["field"].as_str().is_some_and(|field| field.contains('.') && !field.contains('/'))
            {
                premises.batch.push(op.clone());
            }
            // The objects a value set or given to a new object names (a ref, a list of them).
            if let Some(value) = op.get("value") {
                mentioned_in(value, false, &mut premises.mentioned);
            }
            if let Some(fields) = op.get("fields").filter(|_| name == "create") {
                premises.params(Some(fields), None, &mut targets);
            }
            if let Some(target) = op.get("target").and_then(id_text).filter(|id| named(id)) {
                let fields = match (name, op.get("field").and_then(Value::as_str)) {
                    ("set" | "text.set", Some(field)) => BTreeSet::from([field.to_owned()]),
                    // One key of a map: a change of that key conflicts, not one of another
                    // (changes of a map are told by key, `attrs.label`).
                    ("map.set" | "map.delete", Some(field)) => {
                        op.get("key").and_then(Value::as_str).map(|key| BTreeSet::from([format!("{field}.{key}")])).unwrap_or_default()
                    }
                    _ => BTreeSet::new(),
                };
                add_need(&mut targets, target, Need::fields(fields));
            }
            if let Some((owner, _)) = op.get("in").and_then(Value::as_str).and_then(|place| place.rsplit_once('.'))
                && named(owner)
                && (!positional || !owner.contains('.'))
            {
                let mut need = Need::fields(BTreeSet::new());
                if positional {
                    need.positions = Some(BTreeSet::new());
                }
                add_need(&mut targets, owner.to_owned(), need);
            }
            for key in ["node", "parent"] {
                if let Some(id) = op.get(key).and_then(id_text).filter(|id| named(id)) {
                    add_need(&mut targets, id, Need::fields(BTreeSet::new()));
                }
            }
        }
        for (id, need) in targets {
            add_need(&mut premises.targets, id, need);
        }
        premises
    }

    fn window(&mut self, place: &Place, from: usize, to: usize, listed: &[String], indexed: bool) {
        let objects: Vec<_> = listed.iter().skip(from).take(to - from).cloned().collect();
        let under = json!({"objects":objects,"premises":objects.iter().map(|id|json!({"id":id,"fields":[],"positions":[]})).collect::<Vec<_>>(),"within":[{"parent":place.0,"field":place.1,"from":from,"to":to}]});
        let named = json!({"target":place.0,"field":place.1,"from":from,"to":to});
        self.places.push(PlaceStep {
            step: self.steps.len(),
            named,
            indexes: if indexed { vec![from] } else { vec![] },
            numbers: vec![],
            types: None,
            placed: true,
            spelling: None,
            reversed: false,
        });
        self.steps.push(Step {
            state: BTreeSet::new(),
            ask: Ask { step: self.steps.len(), command: String::new(), on: vec![], params: Value::Null, part: None, time: None },
            under: Some(under),
            ids: BTreeMap::new(),
            later_time: None,
            names: vec![],
        });
    }

    /// What the write needs of each object it names itself, before the kit is asked: a batch's
    /// targets and every step's.
    #[cfg(test)]
    fn named_targets(&self) -> BTreeMap<String, Need> {
        let mut all = self.targets.clone();
        for step in &self.steps {
            for (id, need) in &step.ids {
                add_need(&mut all, id.clone(), need.clone());
            }
        }
        all
    }
}

/// How many of the strings a write's parameters mention the guard reads from the document, at
/// most, to tell whether they name objects.
const MENTIONED_READS: usize = 64;

/// The lists of a change set, in order.
const LISTS: [&str; 4] = ["created", "changed", "moved", "deleted"];

/// A place in a list: its owner and field.
type Place = (String, String);

fn place_of_position(position: &Value) -> Option<(Place, usize)> {
    let parent = position.get("parent")?.as_str()?.to_owned();
    let field = position.get("field")?.as_str()?.to_owned();
    Some(((parent, field), usize::try_from(position.get("index")?.as_u64()?).ok()?))
}

/// What one entry did to one list: the indexes, before it, of the items it took out (deleted, or
/// moved away or within), and the indexes, after it, of those it put in (created, or moved there
/// or within); the items it kept keep their order.
#[derive(Debug, Default)]
struct ListEdit {
    removed: BTreeSet<usize>,
    added: BTreeSet<usize>,
}

impl ListEdit {
    /// The index after the entry of the item that was at `index` before it, unless it was taken out.
    fn forward(&self, index: usize) -> Option<usize> {
        if self.removed.contains(&index) {
            return None;
        }
        let rank = index - self.removed.range(..index).count();
        Some(nth_free(&self.added, rank))
    }

    /// The index before the entry of the item at `index` after it, unless it was put in.
    fn backward(&self, index: usize) -> Option<usize> {
        if self.added.contains(&index) {
            return None;
        }
        let rank = index - self.added.range(..index).count();
        Some(nth_free(&self.removed, rank))
    }
}

/// The `rank`-th index (from 0) not in `taken`.
fn nth_free(taken: &BTreeSet<usize>, rank: usize) -> usize {
    let mut seen = 0;
    let mut index = 0;
    loop {
        if !taken.contains(&index) {
            if seen == rank {
                return index;
            }
            seen += 1;
        }
        index += 1;
    }
}

/// Every list an entry's change set changed, with what it did there.
fn list_edits(changes: &Value) -> HashMap<Place, ListEdit> {
    let mut edits: HashMap<Place, ListEdit> = HashMap::new();
    for created in changes["created"].as_array().into_iter().flatten() {
        if let Some((place, index)) = created.get("at").and_then(place_of_position) {
            edits.entry(place).or_default().added.insert(index);
        }
    }
    for deleted in changes["deleted"].as_array().into_iter().flatten() {
        if let Some((place, index)) = deleted.get("at").and_then(place_of_position) {
            edits.entry(place).or_default().removed.insert(index);
        }
    }
    for moved in changes["moved"].as_array().into_iter().flatten() {
        if let Some((place, index)) = moved.get("from").and_then(place_of_position) {
            edits.entry(place).or_default().removed.insert(index);
        }
        if let Some((place, index)) = moved.get("to").and_then(place_of_position) {
            edits.entry(place).or_default().added.insert(index);
        }
    }
    edits
}

fn listed<'a>(changes: &'a Value, list: &str, id: &str) -> Option<&'a Value> {
    changes[list].as_array()?.iter().find(|item| item["id"] == id)
}

/// Rebuild a list before one entry, undoing additions before restoring removals in index order.
fn previous_list(now: &[String], place: &Place, changes: &Value) -> Option<Vec<String>> {
    let mut before = now.to_vec();
    for (list, side) in [("created", "at"), ("moved", "to")] {
        for item in changes[list].as_array().into_iter().flatten() {
            if item.get(side).and_then(place_of_position).is_some_and(|(at, _)| at == *place) {
                let id = id_text(&item["id"])?;
                let index = before.iter().position(|item| *item == id)?;
                before.remove(index);
            }
        }
    }
    let mut removed = BTreeMap::new();
    for (list, side) in [("deleted", "at"), ("moved", "from")] {
        for item in changes[list].as_array().into_iter().flatten() {
            if let Some((_, index)) = item.get(side).and_then(place_of_position).filter(|(at, _)| at == place)
                && removed.insert(index, id_text(&item["id"])?).is_some()
            {
                return None;
            }
        }
    }
    for (index, id) in removed {
        if index > before.len() || before.contains(&id) {
            return None;
        }
        before.insert(index, id);
    }
    Some(before)
}

async fn relative_order(kits: &KitManager, view: Reader<'_>, order: &Value, entries: &[Entry], agent: &str) -> Vec<Conflict> {
    let unknown = || vec![Conflict::unknown().because(Unavailable::Place)];
    let (Some(parent), Some(field), Some(objects)) = (id_text(&order["parent"]), order["field"].as_str(), order["objects"].as_array()) else {
        return unknown();
    };
    let Some(held) = objects.iter().map(id_text).collect::<Option<BTreeSet<_>>>().filter(|held| !held.is_empty() && held.len() == objects.len()) else {
        return unknown();
    };
    let place = (parent, field.to_owned());
    let Some((_, mut now)) = lists_now(kits, view, std::iter::once(&place)).await.into_iter().next() else { return unknown() };
    let project = |items: &[String]| items.iter().filter(|id| held.contains(*id)).cloned().collect::<Vec<_>>();
    let mut found = Vec::new();
    for entry in entries.iter().rev() {
        let Some(before) = entry.changes.as_ref().and_then(|changes| previous_list(&now, &place, changes)) else { return unknown() };
        if entry.author != agent && project(&before) != project(&now) {
            for id in &held {
                let reason = if entry.changes.as_ref().and_then(|changes| listed(changes, "deleted", id)).is_some() { "deleted" } else { "relocated" };
                found.push(Conflict::of(Some(id.clone()), reason, None));
            }
        }
        now = before;
    }
    if project(&now).len() != held.len() && found.is_empty() {
        return unknown();
    }
    found
}

/// Where the guard reads the document as it is now: a kit session's document (`model.batch`), or
/// the document in its open editor (the bridge's `batch`, C3b). Every read is a batch of no
/// operations sent as the agent (origin `{ kind: agent }`): a kit process refuses any other batch
/// on the agent's connection, and a batch without operations makes no edit and no undo step.
#[derive(Clone, Copy)]
pub(crate) enum Reader<'a> {
    Kit(&'a DocumentView),
    Editor(&'a LiveDocument),
    Plan { source: &'a Reader<'a>, token: &'a str },
}

impl Reader<'_> {
    fn source(&self) -> Self {
        match self {
            Self::Plan { source, .. } => source.source(),
            _ => *self,
        }
    }

    pub(crate) async fn model(&self, kits: &KitManager, method: &str, params: Value) -> Option<Value> {
        match self {
            Self::Plan { source, token } => Box::pin(source.context(
                kits,
                "plan",
                Map::from_iter([("action".into(), json!("read")), ("token".into(), json!(token)), ("method".into(), json!(method)), ("params".into(), params)]),
            ))
            .await
            .ok()
            .flatten(),
            Self::Kit(view) => kits.model(Caller::Agent, view.kit_id, &view.document_id, method, params.as_object().cloned().unwrap_or_default()).await.ok(),
            Self::Editor(document) => {
                if method == "model.blob.read" {
                    return kits.bridge().call(document, "premise", json!({"method":"blob","params":params})).await.ok();
                }
                let tool = method.strip_prefix("model.")?;
                kits.bridge().call(document, tool, params).await.ok()
            }
        }
    }
    pub(crate) async fn context(&self, kits: &KitManager, method: &str, params: Map<String, Value>) -> Result<Option<Value>, super::KitToolError> {
        match self {
            Self::Plan { source, token } => {
                Box::pin(source.context(
                    kits,
                    "plan",
                    Map::from_iter([
                        ("action".into(), json!("read")),
                        ("token".into(), json!(token)),
                        ("method".into(), json!(method)),
                        ("params".into(), json!(params)),
                    ]),
                ))
                .await
            }
            Self::Kit(view) => kits.context(Caller::Agent, view.kit_id, &view.document_id, &format!("context.{method}"), params).await.map_err(Into::into),
            Self::Editor(document) => {
                let mut params = params;
                if method == "plan"
                    && let Some(given) = params.get_mut("params").and_then(Value::as_object_mut)
                    && let Some(token) = given.remove("history").and_then(|token| token.as_str().map(str::to_owned))
                {
                    given.insert("history".into(), kits.inner.history.editor_history(&kits.inner.journals, &document.kit, &token, &json!(given)));
                }
                if let Some(token) = params.remove("history").and_then(|token| token.as_str().map(str::to_owned)) {
                    params.insert("history".into(), kits.inner.history.editor_history(&kits.inner.journals, &document.kit, &token, &json!(params)));
                }
                kits.bridge()
                    .call(document, "premise", json!({"method":method,"params":params}))
                    .await
                    .map(|value| (!value.is_null()).then_some(value))
                    .map_err(Into::into)
            }
        }
    }

    /// A batch that only loads `load`: its answer.
    async fn load(&self, kits: &KitManager, load: Value) -> Option<Value> {
        self.model(kits, "model.batch", json!({"origin":agent_origin(),"ops":[],"load":load})).await
    }

    /// One object as a load answers it (`{ id, type, fields }`).
    async fn object(&self, kits: &KitManager, id: &str) -> Option<Value> {
        let answer = self.load(kits, json!([{ "target": id }])).await?;
        answer["loaded"].get(0).cloned()
    }

    /// What one step depends on (`context.under`): `{ objects, within?, premises? }`; `None` when
    /// the kit declares no additional premises. An unavailable editor request fails closed.
    async fn under(&self, kits: &KitManager, ask: &Ask) -> Option<Value> {
        let mut params = Map::new();
        params.insert("command".into(), json!(ask.command));
        params.insert("step".into(), json!(ask.step));
        params.insert("params".into(), ask.params.clone());
        if !ask.on.is_empty() {
            params.insert("on".into(), json!(ask.on));
        }
        if let Some(part) = &ask.part {
            params.insert("part".into(), part.clone());
        }
        if let Some(time) = ask.time {
            params.insert("time".into(), json!(time));
        }
        match self.context(kits, "under", params).await {
            Ok(Some(answer)) if answer.is_null() => None,
            Ok(Some(answer)) if answer["objects"].is_array() => Some(answer),
            Ok(Some(_)) if matches!(self, Self::Editor(_) | Self::Plan { .. }) => Some(json!({"objects":[],"$unavailable":true})),
            Ok(_) => None,
            Err(_) if matches!(self, Self::Editor(_) | Self::Plan { .. }) => Some(json!({"objects":[],"$unavailable":true})),
            Err(_) => None,
        }
    }

    /// Whether each of `objects` (`{ id, before, deleted?, unknown? }`) was under the place `ask`
    /// names at `basis` (`context.covered`): `{ covered: [{ id, covered }] }`; `None`
    /// when the kit cannot say.
    async fn covered(&self, kits: &KitManager, ask: &Ask, objects: Vec<Value>) -> Option<Value> {
        let mut params = Map::new();
        params.insert("command".into(), json!(ask.command));
        params.insert("step".into(), json!(ask.step));
        params.insert("params".into(), ask.params.clone());
        if !ask.on.is_empty() {
            params.insert("on".into(), json!(ask.on));
        }
        if let Some(part) = &ask.part {
            params.insert("part".into(), part.clone());
        }
        if let Some(time) = ask.time {
            params.insert("time".into(), json!(time));
        }
        params.insert("objects".into(), Value::Array(objects));
        if let Self::Kit(view) = self.source()
            && kits.described(view.kit_id).is_some_and(|model| model["blobBytes"] == true)
            && let Ok(token) = super::history::TOKEN.try_with(Clone::clone)
        {
            params.insert("history".into(), json!(token));
        }
        if matches!(self.source(), Self::Editor(_))
            && let Ok(token) = super::history::TOKEN.try_with(Clone::clone)
        {
            params.insert("history".into(), json!(token));
        }
        self.context(kits, "covered", params).await.ok().flatten().filter(|answer| answer["covered"].is_array())
    }

    /// What the kit's object model describes (`model.describe`): its types, their fields and
    /// tool ids.
    pub(crate) async fn described(&self, kits: &KitManager) -> Option<Value> {
        match self {
            Self::Plan { source, .. } => Box::pin(source.described(kits)).await,
            Self::Kit(view) => match kits.described(view.kit_id) {
                Some(described) => Some(described),
                None => kits.model(Caller::Agent, view.kit_id, &view.document_id, "model.describe", Map::new()).await.ok(),
            },
            Self::Editor(document) => match kits.described(&document.kit) {
                Some(described) => Some(described),
                None => {
                    let mut described = kits.bridge().call(document, "describe", json!({})).await.ok()?;
                    if described.get("blobBytes").is_none() {
                        let support = kits.bridge().call(document, "premise", json!({"method":"blob-support","params":{}})).await.ok();
                        described["blobBytes"] = json!(support.is_some_and(|answer| answer["available"] == true));
                    }
                    kits.remember_described(&document.kit, &described);
                    Some(described)
                }
            },
        }
    }
}

/// What the guard reads from a kit's description: which fields own their objects, and which type
/// a part's noun names.
struct Described(Option<Value>);

impl Described {
    fn is_known(&self) -> bool {
        self.0.is_some()
    }

    fn field<'a>(&'a self, ty: &str, field: &str) -> Option<&'a Value> {
        self.0.as_ref()?.get("types")?.get(ty)?.get("fields")?.get(field)
    }

    /// Whether `path` from an object of `ty` says where its object is, not what it is: a field the
    /// schema marks `position`, or a path inside one (`location.0`, one coordinate of a json
    /// position, which a change set tells at its leaf). A path into a held object
    /// (`body.paragraphs.0.text`) is content. Every test of "is this a position" goes through
    /// here.
    fn position(&self, ty: &str, path: &str) -> bool {
        self.field(ty, root_field(path)).is_some_and(|def| def["position"] == true)
    }

    /// Whether `path` from an object of `ty` (`clips`, `comp.layers`) ends at a list or tree field:
    /// a change there is told by the objects created, deleted or moved in it, not as content of
    /// the object. A path into a value (`comp.attrs`) or to an item (`body.paragraphs.2`) does not.
    fn holds_objects(&self, ty: &str, path: &str) -> bool {
        let mut ty = ty.to_owned();
        let segments: Vec<&str> = path.split('.').collect();
        for (at, segment) in segments.iter().enumerate() {
            if segment.parse::<usize>().is_ok() {
                continue;
            }
            let Some(def) = self.field(&ty, segment) else { return false };
            let kind = def["kind"].as_str().unwrap_or_default();
            if at + 1 == segments.len() {
                return matches!(kind, "list" | "tree");
            }
            match (kind, def["of"].as_str()) {
                ("ref" | "list" | "tree", Some(of)) => ty = of.to_owned(),
                _ => return false,
            }
        }
        false
    }

    /// Whether objects of `ty` have tool ids (`toolId`).
    fn has_tool_id(&self, ty: &str) -> bool {
        self.0.as_ref().and_then(|described| described["types"].get(ty)).is_some_and(|def| def.get("toolId").is_some_and(Value::is_object))
    }

    /// Whether an object of `ty` may hold, through owning fields at any depth (list and tree
    /// fields, refs and maps declared `owns`), an object of a type with tool ids. Without a
    /// description, yes. A layer that holds only its property nodes holds none: a change of
    /// another layer is never inside it.
    fn may_hold_tool_ids(&self, ty: &str) -> bool {
        let Some(types) = self.0.as_ref().and_then(|described| described["types"].as_object()) else { return true };
        let mut seen: BTreeSet<String> = BTreeSet::new();
        let mut frontier = vec![ty.to_owned()];
        while let Some(ty) = frontier.pop() {
            for def in types.get(&ty).and_then(|def| def["fields"].as_object()).into_iter().flat_map(|fields| fields.values()) {
                let owns = match def["kind"].as_str() {
                    Some("list" | "tree") => true,
                    Some("ref" | "map") => def["owns"] == true,
                    _ => false,
                };
                let Some(of) = def["of"].as_str().filter(|_| owns) else {
                    // An owning map without a declared type may hold anything.
                    if owns {
                        return true;
                    }
                    continue;
                };
                if self.has_tool_id(of) {
                    return true;
                }
                if seen.insert(of.to_owned()) {
                    frontier.push(of.to_owned());
                }
            }
        }
        false
    }

    /// Whether the kit marks any field as a position: then a place is followed by those fields,
    /// not by indexes.
    fn has_positions(&self) -> bool {
        self.0.as_ref().and_then(|described| described["types"].as_object()).is_some_and(|types| {
            types.values().any(|def| def["fields"].as_object().is_some_and(|fields| fields.values().any(|field| field["position"] == true)))
        })
    }

    /// Whether `path` from an object of `ty` starts at a field holding objects (a list or tree
    /// field, a ref or map declared `owns`), so that it may lead to objects named in the kit's
    /// words (`pathName`); without a description, or a field it does not describe, yes.
    fn leads_into_held(&self, ty: &str, path: &str) -> bool {
        match self.field(ty, root_field(path)) {
            Some(def) => match def["kind"].as_str() {
                Some("list" | "tree") => true,
                Some("ref" | "map") => def["owns"] == true,
                _ => false,
            },
            None => true,
        }
    }

    /// Whether `ty.field` holds parts of its object: a list or tree field, or a ref or map
    /// declared `owns`. Without a description, a field holding a list.
    fn owning(&self, ty: &str, field: &str, value: &Value) -> bool {
        match self.field(ty, field) {
            Some(def) => match def["kind"].as_str() {
                Some("list" | "tree") => true,
                Some("ref" | "map") => def["owns"] == true,
                _ => false,
            },
            None => self.0.is_none() && value.is_array(),
        }
    }

    /// The type whose tool id carries `noun` (`slide` → the type with prefix `slide:` and no
    /// parent), and that prefix; else, for a kit's declared noun whose parts' tool ids have no
    /// such prefix (a sheet listed by its id `3`), the type named as the noun (`Sheet`) with its
    /// tool id as it is (prefix empty).
    fn part_type(&self, noun: &str) -> Option<(String, String)> {
        let prefix = format!("{noun}:");
        let types = self.0.as_ref()?["types"].as_object()?;
        let prefixed = types.iter().find_map(|(ty, def)| {
            let tool = def.get("toolId")?;
            (tool["prefix"].as_str() == Some(prefix.as_str()) && tool.get("parent").is_none_or(Value::is_null)).then(|| (ty.clone(), prefix.clone()))
        });
        prefixed.or_else(|| {
            types.iter().find_map(|(ty, def)| {
                let unprefixed =
                    def.get("toolId").is_none_or(|tool| tool["prefix"].as_str().is_none_or(str::is_empty) && tool.get("parent").is_none_or(Value::is_null));
                (ty.eq_ignore_ascii_case(noun) && unprefixed).then(|| (ty.clone(), String::new()))
            })
        })
    }

    /// The root's list field holding objects of `ty`: where the parts are.
    fn parts_field(&self, ty: &str) -> Option<String> {
        let described = self.0.as_ref()?;
        let root = described["root"].as_str()?;
        described["types"][root]["fields"].as_object()?.iter().find(|(_, def)| def["kind"] == "list" && def["of"] == ty).map(|(name, _)| name.clone())
    }
}

/// The ids a loaded field's value names: a list's items, a tree's objects, a ref, and the values
/// of a map that owns (each a string, or a member of an object value: candidates, which a read
/// confirms).
fn held_ids(value: &Value) -> Vec<String> {
    match value {
        Value::String(id) if !id.is_empty() => vec![id.clone()],
        Value::Array(items) => items.iter().filter_map(|item| item.as_str().or_else(|| item["object"].as_str()).map(str::to_owned)).collect(),
        Value::Object(_) => kition_kdm::FieldDef::map_held(value, |_| true).into_iter().map(|(id, _)| id).collect(),
        _ => Vec::new(),
    }
}

/// The ids `path` (`body.paragraphs`: field names, and positions) ends at from `start`, at most
/// `budget` reads.
async fn follow(kits: &KitManager, view: Reader<'_>, start: &str, path: &str, budget: &mut usize) -> Option<Vec<String>> {
    let mut current = vec![start.to_owned()];
    for segment in path.split('.').filter(|segment| !segment.is_empty()) {
        if let Ok(position) = segment.parse::<usize>() {
            current = vec![current.get(position)?.clone()];
            continue;
        }
        let [object] = current.as_slice() else { return None };
        if *budget == 0 {
            return None;
        }
        *budget -= 1;
        let answer = view.load(kits, json!([{ "target": object, "fields": [segment] }])).await?;
        current = held_ids(&answer["loaded"][0]["fields"][segment]);
    }
    Some(current)
}

/// Resolve held container paths while retaining every intermediate ordinal dependency.
async fn batch_place(kits: &KitManager, view: Reader<'_>, premises: &mut Premises, target: &str, path: &str) -> Option<(Place, Value)> {
    let mut target = target.to_owned();
    let mut segments = path.split('.').peekable();
    while let Some(field) = segments.next() {
        let answer = view.load(kits, json!([{"target":target,"fields":[field]}])).await?;
        let object = &answer["loaded"][0];
        let owner = id_text(&object["id"])?;
        let value = object["fields"].get(field)?.clone();
        if segments.peek().is_none() {
            return Some(((owner, field.to_owned()), value));
        }
        if let Some(id) = value.as_str() {
            target = id.to_owned();
        } else if let Some(members) = value.as_object() {
            target = members.get(segments.next()?)?.as_str()?.to_owned();
        } else {
            let at = segments.next()?.parse::<usize>().ok()?;
            let listed = strings(&value)?;
            premises.window(&(owner, field.to_owned()), at, at + 1, &listed, true);
            target = listed.get(at)?.clone();
        }
    }
    None
}

async fn batch_windows(kits: &KitManager, view: Reader<'_>, premises: &mut Premises, entries: &[Entry]) -> bool {
    for op in std::mem::take(&mut premises.batch) {
        let name = op["op"].as_str().unwrap_or_default();
        let (target, path) = if name == "create" {
            let Some((target, path)) = op["in"].as_str().and_then(|s| s.split_once('.')) else { continue };
            (target.to_owned(), path.to_owned())
        } else {
            let (Some(target), Some(path)) = (id_text(&op["target"]), op["field"].as_str()) else { continue };
            (target, path.to_owned())
        };
        if target.starts_with('$') {
            continue;
        }
        let Some(((owner, field), value)) = batch_place(kits, view, premises, &target, &path).await else {
            // A deleted container has no current list window. Keep its identity hold so the
            // object guard reports the deletion instead of an unavailable place.
            if entries.iter().any(|entry| entry.changes.as_ref().is_some_and(|changes| listed(changes, "deleted", &target).is_some())) {
                continue;
            }
            return false;
        };
        if matches!(name, "text.insert" | "text.delete" | "text.set") {
            // The numeric path holds each ordinal on the way, while content is held by
            // the resolved object's identity. A later sibling edit changes neither.
            if let Some(fields) = premises.targets.get_mut(&target).and_then(|need| need.fields.as_mut()) {
                fields.remove(&path);
            }
            let fields = if name == "text.set" {
                BTreeSet::from([field.clone()])
            } else {
                let Some(from) = op["index"].as_u64().and_then(|at| usize::try_from(at).ok()) else { return false };
                let count = if name == "text.delete" {
                    let Some(count) = op["count"].as_u64().and_then(|count| usize::try_from(count).ok()) else { return false };
                    count
                } else {
                    0
                };
                let Some(to) = from.checked_add(count) else { return false };
                premises.text_ranges.push(TextRange { owner: owner.clone(), paths: vec![(owner.clone(), field), (target, path)], from, to });
                BTreeSet::new()
            };
            add_need(&mut premises.targets, owner, Need::fields(fields));
            continue;
        }
        let tree = is_flat_tree(&value);
        let place = (if tree { id_text(&op["parent"]).unwrap_or(owner.clone()) } else { owner.clone() }, field.clone());
        let listed = if tree {
            tree_children(&value, id_text(&op["parent"]).as_deref())
        } else {
            let Some(listed) = strings(&value) else { return false };
            listed
        };
        // An omitted/end index names the gap at basis, even after the current length changed.
        let basis_len = entries
            .iter()
            .filter_map(|entry| entry.changes.as_ref())
            .map(list_edits)
            .filter_map(|mut edits| edits.remove(&place))
            .fold(listed.len() as isize, |len, edit| len + edit.removed.len() as isize - edit.added.len() as isize)
            .max(0) as usize;
        let index = if tree {
            None
        } else {
            op[if name == "create" {
                "at"
            } else if name == "list.move" {
                "to"
            } else {
                "index"
            }]
            .as_u64()
            .and_then(|at| usize::try_from(at).ok())
        };
        let at = index.unwrap_or(basis_len);
        if (name == "list.move" || name == "list.remove")
            && let Some(from) = op[if name == "list.move" { "from" } else { "index" }].as_u64().and_then(|at| usize::try_from(at).ok())
        {
            premises.window(&place, from, from + 1, &listed, true);
        }
        if name != "list.remove" {
            premises.window(&place, at, at, &listed, false);
        }
        let need = Need { fields: Some(BTreeSet::new()), positions: Some(BTreeSet::new()), identities: BTreeMap::new() };
        add_need(&mut premises.targets, owner, need.clone());
        if tree
            && name == "tree.move"
            && let Some(item) = id_text(&op["item"]).filter(|s| !s.starts_with('$'))
        {
            add_need(&mut premises.targets, item, need);
        }
    }
    true
}

/// Compare a numeric text gap/range against each recorded replacement in scalar offsets.
fn text_range_reason(range: &TextRange, entries: &[Entry], agent: &str) -> Option<&'static str> {
    let mut reason = None;
    let (mut from, mut to) = (range.from, range.to);
    // A planned prefix can shift the range past an earlier outside edit.
    for entry in entries.iter().rev() {
        let Some(changes) = entry.changes.as_ref() else { return Some("unknown") };
        let relevant = range.paths.iter().enumerate().find_map(|(index, (id, field))| {
            if index > 0 && changes["$objects"]["changed"].is_array() {
                return None;
            }
            let change = listed(changes, "changed", id)?;
            change["fields"].as_array()?.iter().any(|changed| changed == field).then_some((change, field))
        });
        let Some((change, field)) = relevant else { continue };
        let mut known = false;
        for edit in change["edits"].as_array().into_iter().flatten().rev().filter(|edit| edit["field"] == *field) {
            known = true;
            if edit["spansTruncated"] == true {
                return Some("unknown");
            }
            let spans = edit["spans"].as_array().cloned().unwrap_or_else(|| edit.get("span").cloned().into_iter().collect());
            let replacements: Option<Vec<(usize, usize, usize)>> = if spans.is_empty() {
                match (edit["before"].as_str(), edit["after"].as_str()) {
                    (Some(before), Some(after)) => {
                        let (before, after) = (before.chars().collect::<Vec<_>>(), after.chars().collect::<Vec<_>>());
                        let offset = before.iter().zip(&after).take_while(|(a, b)| a == b).count();
                        let suffix = before[offset..].iter().rev().zip(after[offset..].iter().rev()).take_while(|(a, b)| a == b).count();
                        Some(vec![(offset, before.len() - offset - suffix, after.len() - offset - suffix)])
                    }
                    _ => None,
                }
            } else {
                spans
                    .iter()
                    .map(|span| {
                        Some((
                            usize::try_from(span["offset"].as_u64()?).ok()?,
                            usize::try_from(span["removedLength"].as_u64()?).ok()?,
                            usize::try_from(span["insertedLength"].as_u64()?).ok()?,
                        ))
                    })
                    .collect()
            };
            let Some(replacements) = replacements else { return Some("unknown") };
            for (at, removed, inserted) in replacements.into_iter().rev() {
                let end = at.saturating_add(inserted);
                if entry.author != agent {
                    if (removed == 0 && inserted > 0 && at == from) || (at < from && (end > from || removed != inserted)) {
                        reason = Some("relocated");
                    } else if from < to && at < to && (end > from || removed > 0 && at >= from) && reason.is_none() {
                        reason = Some("changed");
                    }
                }
                let back = |index: usize| {
                    if index <= at {
                        Some(index)
                    } else if index >= end {
                        Some(index.saturating_sub(inserted).saturating_add(removed))
                    } else {
                        None
                    }
                };
                let (Some(before_from), Some(before_to)) = (back(from), back(to)) else { return reason.or(Some("unknown")) };
                (from, to) = (before_from, before_to);
            }
        }
        if !known {
            return Some("unknown");
        }
    }
    reason
}

/// The items of `owner.field` now (a field may be a path from the owner, `body.paragraphs`), by
/// the ids the tools use; a tree's children of `owner` ([`tree_items`]); `None` for a field that
/// is no list or tree.
async fn items(kits: &KitManager, view: Reader<'_>, place: &Place) -> Option<Vec<String>> {
    if place.1.contains('.') {
        let mut budget = 16;
        return follow(kits, view, &place.0, &place.1, &mut budget).await;
    }
    let answer = view.load(kits, json!([{ "target": place.0, "fields": [place.1] }])).await;
    match answer.as_ref().map(|answer| &answer["loaded"][0]["fields"][&place.1]) {
        Some(value) if strings(value).is_some() => strings(value),
        Some(value) if is_flat_tree(value) => Some(tree_children(value, None)),
        _ => tree_items(kits, view, place).await,
    }
}

/// A list's items as a load answers them: ids.
fn strings(value: &Value) -> Option<Vec<String>> {
    value.as_array()?.iter().map(|item| item.as_str().map(str::to_owned)).collect()
}

/// Whether a loaded value is a tree as a load answers it: `[{ object, parent }]`.
fn is_flat_tree(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|nodes| nodes.iter().all(|node| node.get("object").is_some_and(|object| id_text(object).is_some()) && node.get("parent").is_some()))
}

/// The objects of a tree (as a load answers it, nodes in pre-order) whose parent is `parent`
/// (`None`: the top level), in order.
fn tree_children(value: &Value, parent: Option<&str>) -> Vec<String> {
    value.as_array().into_iter().flatten().filter(|node| id_text(&node["parent"]).as_deref() == parent).filter_map(|node| id_text(&node["object"])).collect()
}

/// The children of a tree node: a place in a tree is named, as change sets name it,
/// by the parent's id and the tree field (`{ parent: 2, field: "layers" }`, the top level by the
/// tree's owner), and the owner of a node's tree is not in it. Read as the children of the node
/// in the root's tree of that field; `None` when the root has no such tree or it does not hold
/// the node (a tree another object holds is not looked for).
async fn tree_items(kits: &KitManager, view: Reader<'_>, place: &Place) -> Option<Vec<String>> {
    let described = Described(view.described(kits).await);
    let mut frontier = vec!["root".to_owned()];
    let mut seen = BTreeSet::new();
    while let Some(target) = frontier.pop() {
        if !seen.insert(target.clone()) {
            continue;
        }
        if seen.len() > 200 {
            return None;
        }
        let answer = view.load(kits, json!([{"target":target}])).await?;
        let loaded = &answer["loaded"][0];
        let tree = &loaded["fields"][&place.1];
        if is_flat_tree(tree) {
            if id_text(&loaded["id"]).as_deref() == Some(place.0.as_str()) {
                return Some(tree_children(tree, None));
            }
            if tree.as_array().into_iter().flatten().any(|node| id_text(&node["object"]).as_deref() == Some(place.0.as_str())) {
                return Some(tree_children(tree, Some(&place.0)));
            }
        }
        for (field, value) in loaded["fields"].as_object().into_iter().flatten() {
            if described.owning(loaded["type"].as_str().unwrap_or_default(), field, value) {
                frontier.extend(held_ids(value));
            }
        }
    }
    None
}

/// The ids a loaded field's value names, each with its place in the field: a list's items at
/// their index (`3`), a tree's objects at theirs in its order, a ref as the field itself (empty),
/// an owning map's values at their keys (`<key>`, `<key>.<member>`).
fn held_places(value: &Value) -> Vec<(String, String)> {
    match value {
        Value::String(id) if !id.is_empty() => vec![(id.clone(), String::new())],
        Value::Array(items) => items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| item.as_str().or_else(|| item["object"].as_str()).map(|id| (id.to_owned(), index.to_string())))
            .collect(),
        Value::Object(_) => kition_kdm::FieldDef::map_held(value, |_| true),
        _ => Vec::new(),
    }
}

/// The objects `under` holds now, at any depth, through owning fields (list and tree fields, refs
/// declared `owns`), each at its path from `under` (`sequence.videoTracks.0.items.3`: the fields
/// and indexes on the way, as receipts name a held object's place, where every object
/// held through a ref read as held at the ref's field and overlapped every path under it); no
/// more than `budget` reads.
async fn held_by(kits: &KitManager, view: Reader<'_>, described: &Described, under: &str, budget: &mut usize) -> HashMap<String, String> {
    let mut found: HashMap<String, String> = HashMap::new();
    let mut frontier: Vec<(String, String)> = vec![(under.to_owned(), String::new())];
    // Level by level, each level's objects in one load; one by one when a load
    // of them all fails (one of them is gone).
    while !frontier.is_empty() && *budget > 0 {
        let level: Vec<(String, String)> = frontier.drain(..frontier.len().min(*budget)).collect();
        *budget -= level.len();
        let load = Value::Array(level.iter().map(|(object, _)| json!({ "target": object })).collect());
        let loaded: Vec<Option<Value>> = match view.load(kits, load).await {
            Some(answer) => {
                let all = answer["loaded"].as_array().cloned().unwrap_or_default();
                level.iter().enumerate().map(|(at, _)| all.get(at).cloned()).collect()
            }
            None => {
                let mut each = Vec::with_capacity(level.len());
                for (object, _) in &level {
                    each.push(view.object(kits, object).await);
                }
                each
            }
        };
        frontier.clear();
        for ((_, path), loaded) in level.iter().zip(loaded) {
            let Some(loaded) = loaded else { continue };
            let ty = loaded["type"].as_str().unwrap_or_default();
            for (field, value) in loaded["fields"].as_object().into_iter().flatten() {
                if !described.owning(ty, field, value) {
                    continue;
                }
                let at = if path.is_empty() { field.clone() } else { format!("{path}.{field}") };
                for (item, place) in held_places(value) {
                    let item_path = if place.is_empty() { at.clone() } else { format!("{at}.{place}") };
                    if item != under && !found.contains_key(&item) {
                        found.insert(item.clone(), item_path.clone());
                        frontier.push((item, item_path));
                    }
                }
            }
        }
    }
    found
}

/// The members `member` of the items of the list at `path` from object `id` now (an object list's
/// items read in one load, or a json array's items), for a selector premise ([`super::selector`]);
/// `None` when the path does not lead to a list.
async fn list_members(kits: &KitManager, view: Reader<'_>, described: &Described, id: &str, path: &str, member: &str) -> Option<super::selector::Items> {
    enum At {
        Object(String),
        Objects(Vec<String>),
        Json(Value),
    }
    let mut at = At::Object(id.to_owned());
    for segment in path.split('.').filter(|segment| !segment.is_empty()) {
        at = match at {
            At::Object(object) => {
                let answer = view.load(kits, json!([{ "target": object, "fields": [segment] }])).await?;
                let loaded = &answer["loaded"][0];
                let value = loaded["fields"].get(segment)?.clone();
                let kind = described.field(loaded["type"].as_str().unwrap_or_default(), segment).and_then(|def| def["kind"].as_str()).unwrap_or("json");
                match kind {
                    "ref" => At::Object(value.as_str()?.to_owned()),
                    "list" => At::Objects(value.as_array()?.iter().map(|item| item.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>()?),
                    "tree" => return None,
                    _ => At::Json(value),
                }
            }
            At::Objects(items) => At::Object(items.get(segment.parse::<usize>().ok()?)?.clone()),
            At::Json(value) => At::Json(match segment.parse::<usize>() {
                Ok(index) => value.get(index)?.clone(),
                Err(_) => value.get(segment)?.clone(),
            }),
        };
    }
    match at {
        At::Objects(items) => {
            if items.is_empty() {
                return Some(Vec::new());
            }
            let load = Value::Array(items.iter().map(|item| json!({ "target": item, "fields": [root_field(member)] })).collect());
            let answer = view.load(kits, load).await?;
            let loaded = answer["loaded"].as_array()?;
            Some(items.iter().enumerate().map(|(at, _)| loaded.get(at).and_then(|item| super::selector::value_at(&item["fields"], member)).cloned()).collect())
        }
        At::Json(Value::Array(items)) => Some(items.iter().map(|item| super::selector::value_at(item, member).cloned()).collect()),
        _ => None,
    }
}

/// Records a conflict, the first found for each object.
fn add_to(found: &mut BTreeMap<String, Conflict>, conflict: Conflict) {
    let key = conflict.id.clone().unwrap_or_default();
    found.entry(key).or_insert(conflict);
}

/// The items of each list `places` names now, by the ids the tools use: the lists that are fields
/// of their owner in one load, those at a path from it (`body.paragraphs`) followed, a tree's
/// children of a node ([`tree_items`]); a list that cannot be read is left out.
async fn lists_now<'a>(kits: &KitManager, view: Reader<'_>, places: impl Iterator<Item = &'a Place>) -> Vec<(Place, Vec<String>)> {
    let places: Vec<Place> = places.cloned().collect();
    let (direct, paths): (Vec<Place>, Vec<Place>) = places.into_iter().partition(|place| !place.1.contains('.'));
    let mut found = Vec::new();
    if !direct.is_empty() {
        let load: Vec<Value> = direct.iter().map(|place| json!({ "target": place.0, "fields": [place.1] })).collect();
        match view.load(kits, Value::Array(load)).await {
            Some(answer) => {
                for (place, loaded) in direct.iter().zip(answer["loaded"].as_array().into_iter().flatten()) {
                    let value = &loaded["fields"][&place.1];
                    if let Some(listed) = strings(value) {
                        found.push((place.clone(), listed));
                    } else if is_flat_tree(value) {
                        // A tree's top level, held by the place's owner.
                        found.push((place.clone(), tree_children(value, None)));
                    }
                }
            }
            // One of them is gone: each alone.
            None => {
                for place in &direct {
                    if let Some(listed) = items(kits, view, place).await {
                        found.push((place.clone(), listed));
                    }
                }
            }
        }
    }
    for place in &paths {
        if let Some(listed) = items(kits, view, place).await {
            found.push((place.clone(), listed));
        }
    }
    found
}

/// Whether a changed path (`text`, `body.paragraphs.0.text`) and a wanted one are the same, or one
/// is inside the other (a change of `body` touches `body.paragraphs.0.text`, and the reverse).
pub(crate) fn overlaps(changed: &str, wanted: &str) -> bool {
    let literal =
        |path: &str| path.strip_prefix('/').map(|path| path.split('/').map(|part| part.replace("~1", "/").replace("~0", "~")).collect::<Vec<_>>().join("."));
    let changed_literal = literal(changed);
    let wanted_literal = literal(wanted);
    let changed = changed_literal.as_deref().unwrap_or(changed);
    let wanted = wanted_literal.as_deref().unwrap_or(wanted);
    let inside = |long: &str, short: &str| long.strip_prefix(short).is_some_and(|rest| rest.starts_with('.'));
    changed == wanted || inside(changed, wanted) || inside(wanted, changed)
}

/// Whether a change (`{ fields, edits }`) touches one of `wanted` (paths as receipts give them, or
/// in the kit's words, `named`); `skip` leaves out fields that are no content (positions);
/// `held` says whether a path leads into objects the object holds, which alone the kit's words
/// name.
fn touches_any(change: &Value, wanted: &BTreeSet<String>, skip: &dyn Fn(&str) -> bool, held: &dyn Fn(&str) -> bool) -> bool {
    let edits: Vec<&Value> = change["edits"].as_array().into_iter().flatten().collect();
    for field in change["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|field| !skip(field)) {
        if wanted.iter().any(|wanted| overlaps(field, wanted)) {
            return true;
        }
        // The same change in the kit's words: the edits at or inside this field that give one.
        let mut named =
            edits.iter().filter(|edit| edit["field"].as_str().is_some_and(|edit| overlaps(edit, field))).filter_map(|edit| edit["named"].as_str()).peekable();
        if named.peek().is_none() {
            // No word of the kit's for it: a path the kit gave in its own words may name it, when
            // it leads into what the object holds.
            if field.contains('.') && held(field) && wanted.iter().any(|wanted| !wanted.starts_with('/') && wanted.contains(['/', '#'])) {
                return true;
            }
            continue;
        }
        if named.any(|named| wanted.iter().any(|wanted| overlaps(named, wanted))) {
            return true;
        }
    }
    false
}

/// A value of a field that says when an item is (a number, or a numeric string such as a tick
/// count).
fn time_of(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str().and_then(|text| text.trim().parse::<f64>().ok())).filter(|number| number.is_finite())
}

/// A place in time in a list (`within.time`, [`kition_kit::TimeSpan`]).
#[derive(Clone, Debug)]
struct Span {
    from: f64,
    to: f64,
    start: String,
    end: Option<String>,
    duration: Option<String>,
    identity: Option<String>,
}

impl Span {
    fn of(time: &Value) -> Option<Self> {
        let span = Self {
            from: time_of(&time["from"])?,
            to: time_of(&time["to"]).or_else(|| time_of(&time["from"]))?,
            start: time["start"].as_str()?.to_owned(),
            end: time["end"].as_str().map(str::to_owned),
            duration: time["duration"].as_str().map(str::to_owned),
            identity: time["identity"].as_str().map(str::to_owned),
        };
        (span.from <= span.to).then_some(span)
    }

    /// The fields an item's time is read from.
    fn fields(&self) -> Vec<String> {
        std::iter::once(self.start.clone()).chain(self.end.clone()).chain(self.duration.clone()).collect()
    }

    /// Whether an item with these field values covers the place; `None` when a value is missing.
    fn covers(&self, values: &Map<String, Value>) -> Option<bool> {
        let start = time_of(values.get(&self.start)?)?;
        if self.end.is_none() && self.duration.is_none() {
            return Some(if self.to > self.from { self.from <= start && start < self.to } else { start == self.from });
        }
        let end = match (&self.end, &self.duration) {
            (Some(end), _) => time_of(values.get(end)?)?,
            (None, Some(duration)) => start + time_of(values.get(duration)?)?,
            (None, None) => return None,
        };
        Some(if self.to > self.from { start < self.to && end > self.from } else { start <= self.from && self.from < end })
    }
}

/// JSON windows replay the complete JSON field, so deletions and selector parents that have
/// disappeared from the current answer remain visible in history.
async fn json_window(
    kits: &KitManager,
    view: Reader<'_>,
    described: &Described,
    place: &Place,
    span: &Span,
    entries: &[Entry],
    agent: &str,
) -> Option<Option<&'static str>> {
    let mut owner = place.0.clone();
    let mut path = place.1.as_str();
    loop {
        let (field, rest) = path.split_once('.').unwrap_or((path, ""));
        let object = view.object(kits, &owner).await?;
        let kind = described.field(object["type"].as_str()?, field)?["kind"].as_str()?;
        let value = object["fields"].get(field)?;
        if kind == "ref" {
            owner = value.as_str()?.to_owned();
            path = rest;
            continue;
        }
        if kind != "json" {
            return None;
        }
        owner = id_text(&object["id"])?;
        let project = |value: &Value| -> Option<BTreeMap<String, Vec<Value>>> {
            let mut selected = BTreeMap::new();
            let entries: Vec<_> = match super::selector::value_at(value, rest)? {
                Value::Array(items) => items.iter().map(|item| (None, item)).collect(),
                Value::Object(items) => items.iter().map(|(key, item)| (Some(key), item)).collect(),
                _ => return None,
            };
            for (map_key, item) in entries {
                let fields = item.as_object()?;
                if !span.covers(fields)? {
                    continue;
                }
                let ordering: Vec<Value> = span.fields().iter().map(|field| fields.get(field).cloned()).collect::<Option<_>>()?;
                let identity = match &span.identity {
                    Some(key) => super::selector::value_at(item, key)?.clone(),
                    None => map_key.map_or_else(|| json!(ordering), |key| json!(key)),
                };
                if !(identity.is_string() || identity.is_number() || span.identity.is_none()) || selected.insert(identity.to_string(), ordering).is_some() {
                    return None;
                }
            }
            Some(selected)
        };
        let mut after = value.clone();
        for entry in entries.iter().rev() {
            let Some(change) = entry.changes.as_ref().and_then(|changes| listed(changes, "changed", &owner)) else { continue };
            let Some(before) = super::selector::before_value(field, &after, change) else { return Some(Some("unknown")) };
            if entry.author != agent {
                let (Some(was), Some(now)) = (project(&before), project(&after)) else { return Some(Some("unknown")) };
                if was != now {
                    return Some(Some("relocated"));
                }
            }
            after = before;
        }
        return Some(None);
    }
}

/// Which items of the list `place` covered the place in time `span` after each entry since
/// `basis`, replayed back from now (the items `listed` now, their times read in one load) through
/// every entry's change set (created, deleted with `$was`, moved in and out, the edits of the
/// time fields): for each entry by others, the items it put under the place (`relocated`) and
/// those it took from there (`deleted` or `relocated`). An item whose time an entry does not tell
/// (a deletion without `$was`, a time field changed without its edit) counts as changed there
/// when that entry is by others.
async fn covering(
    kits: &KitManager,
    view: Reader<'_>,
    place: &Place,
    span: &Span,
    listed: &[String],
    entries: &[Entry],
    agent: &str,
) -> Vec<(String, &'static str)> {
    let fields = span.fields();
    let at_place = |position: &Value| place_of_position(position).is_some_and(|(was, _)| was == *place);
    // Every item the replay meets: those listed now, and those moved out of the list since.
    let mut ids: Vec<String> = listed.to_vec();
    for entry in entries {
        for moved in entry.changes.as_ref().and_then(|changes| changes["moved"].as_array()).into_iter().flatten() {
            if moved.get("from").is_some_and(at_place)
                && !moved.get("to").is_some_and(at_place)
                && let Some(id) = moved["id"].as_str()
                && !ids.iter().any(|known| known == id)
            {
                ids.push(id.to_owned());
            }
        }
    }
    let mut values: HashMap<String, Map<String, Value>> = HashMap::new();
    if !ids.is_empty() {
        let load: Vec<Value> = ids.iter().map(|id| json!({ "target": id, "fields": fields })).collect();
        if let Some(answer) = view.load(kits, Value::Array(load)).await {
            for (id, loaded) in ids.iter().zip(answer["loaded"].as_array().into_iter().flatten()) {
                values.insert(id.clone(), loaded["fields"].as_object().cloned().unwrap_or_default());
            }
        }
    }
    let mut members: BTreeSet<String> = listed.iter().cloned().collect();
    let created_since: BTreeSet<&str> = entries
        .iter()
        .filter_map(|entry| entry.changes.as_ref())
        .flat_map(|changes| changes["created"].as_array().into_iter().flatten())
        .filter_map(|item| item["id"].as_str())
        .collect();
    let mut found: Vec<(String, &'static str)> = Vec::new();
    for entry in entries.iter().rev() {
        let Some(changes) = &entry.changes else { continue };
        let after = members.clone();
        let after_values = values.clone();
        let mut unsure: BTreeSet<String> = BTreeSet::new();
        let mut gone: BTreeSet<String> = BTreeSet::new();
        // The time fields as they were before the entry.
        for change in changes["changed"].as_array().into_iter().flatten() {
            let Some(id) = change["id"].as_str() else { continue };
            let told: Vec<&str> = change["fields"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|field| fields.iter().any(|wanted| wanted == field))
                .collect();
            if told.is_empty() {
                continue;
            }
            let item = values.entry(id.to_owned()).or_default();
            for field in told {
                match change["edits"].as_array().into_iter().flatten().find(|edit| edit["field"] == field) {
                    Some(edit) => {
                        item.insert(field.to_owned(), edit["before"].clone());
                    }
                    None => {
                        unsure.insert(id.to_owned());
                    }
                }
            }
        }
        for created in changes["created"].as_array().into_iter().flatten().filter(|item| item.get("at").is_some_and(at_place)) {
            if let Some(id) = created["id"].as_str() {
                members.remove(id);
            }
        }
        for deleted in changes["deleted"].as_array().into_iter().flatten().filter(|item| item.get("at").is_some_and(at_place)) {
            let Some(id) = deleted["id"].as_str() else { continue };
            members.insert(id.to_owned());
            gone.insert(id.to_owned());
            match deleted["$was"].as_object() {
                Some(was) => {
                    values.insert(id.to_owned(), was.clone());
                }
                None => {
                    unsure.insert(id.to_owned());
                }
            }
        }
        for moved in changes["moved"].as_array().into_iter().flatten() {
            let Some(id) = moved["id"].as_str() else { continue };
            let (from, to) = (moved.get("from").is_some_and(at_place), moved.get("to").is_some_and(at_place));
            if from && !to {
                members.insert(id.to_owned());
            } else if to && !from {
                members.remove(id);
            }
        }
        if entry.author == agent {
            continue;
        }
        let state = |members: &BTreeSet<String>, values: &HashMap<String, Map<String, Value>>, id: &str| {
            if members.contains(id) { values.get(id).and_then(|item| span.covers(item)) } else { Some(false) }
        };
        let mut touched: BTreeSet<&String> = after.iter().chain(members.iter()).collect();
        touched.retain(|id| unsure.contains(*id) || after.contains(*id) != members.contains(*id) || after_values.get(*id) != values.get(*id));
        for id in touched {
            let (was, now) = (state(&members, &values, id), state(&after, &after_values, id));
            let reason = if gone.contains(id) && !created_since.contains(id.as_str()) { "deleted" } else { "relocated" };
            match (was, now) {
                (Some(was), Some(now)) if !unsure.contains(id) => {
                    if was != now {
                        found.push((id.clone(), if was { reason } else { "relocated" }));
                    }
                }
                // What it was is not told: it may have been under the place.
                _ => found.push((id.clone(), reason)),
            }
        }
    }
    found
}

/// How many objects one `context.covered` request carries at most; beyond, the guard refuses a
/// write by such a place without asking. One request, not
/// chunks: the kit answers what the place named with every object put back at once (a parent and
/// its child in two chunks would each be answered with the other where it is now).
pub(crate) const COVERED_BUDGET: usize = 4096;

/// What others did to one object since `basis`, as a place the kit tells by being asked reads it.
#[derive(Default)]
struct Touched {
    created: bool,
    deleted: Option<Map<String, Value>>,
    moved: bool,
}

/// The objects others put under, or took from, a place the kit tells by being asked
/// ([`kition_kit::Covers`]), with the reason; `Err` with why when it cannot be told.
///
/// Every object others created, deleted, moved in a list, or changed in a field that is a position
/// (or a path inside one) or one of `covers` since `basis` is asked about in one request, with its
/// values at `basis` (each field rebuilt from now back through every entry's edits, the earliest
/// `before` winning; a deleted object's from the `$was` the journal kept; a created one as not
/// there). The kit answers what the place named at `basis`: an object under it now and not then
/// was put there, one under it then and not now was taken away (`deleted` when others deleted
/// it), and an object others moved that held what was there (a parent) and is not there now
/// carried it away.
#[allow(clippy::too_many_arguments)]
async fn covered_by(
    kits: &KitManager,
    view: Reader<'_>,
    described: &Described,
    ask: &Ask,
    now_under: &[String],
    covers: &[String],
    entries: &[Entry],
    agent: &str,
) -> Result<Vec<(String, &'static str)>, String> {
    let relevant = |ty: &str, field: &str| described.position(ty, field) || covers.iter().any(|wanted| overlaps(field, wanted));
    let mut touched: BTreeMap<String, Touched> = BTreeMap::new();
    let mut types: BTreeMap<String, String> = BTreeMap::new();
    // Created since `basis` by anyone: not there at `basis`.
    let mut new: BTreeSet<String> = BTreeSet::new();
    for entry in entries {
        let Some(changes) = &entry.changes else { return Err("a change since your basis is not known".to_owned()) };
        let others = entry.author != agent;
        for item in changes["created"].as_array().into_iter().flatten() {
            let Some(id) = id_text(&item["id"]) else { continue };
            new.insert(id.clone());
            if others {
                touched.entry(id).or_default().created = true;
            }
        }
        for item in changes["deleted"].as_array().into_iter().flatten() {
            let Some(id) = id_text(&item["id"]) else { continue };
            types.insert(id.clone(), item["type"].as_str().unwrap_or_default().to_owned());
            if new.contains(&id) {
                touched.remove(&id);
                continue;
            }
            if others {
                touched.entry(id).or_default().deleted = Some(item["$was"].as_object().cloned().unwrap_or_default());
            }
        }
        for item in changes["moved"].as_array().into_iter().flatten().filter(|_| others) {
            if let Some(id) = id_text(&item["id"]) {
                touched.entry(id).or_default().moved = true;
            }
        }
        for item in changes["changed"].as_array().into_iter().flatten() {
            let Some(id) = id_text(&item["id"]) else { continue };
            let ty = item["type"].as_str().unwrap_or_default();
            types.insert(id.clone(), ty.to_owned());
            // A change that carries others with it, when the place says so.
            let carries = item.get("carries").is_some() && covers.iter().any(|field| field == "carries");
            if others && (carries || item["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).any(|field| relevant(ty, field))) {
                touched.entry(id).or_default().moved = true;
            }
        }
    }
    let mut found: Vec<(String, &'static str)> = Vec::new();
    // Every object others touched: those they created since are asked as not there at `basis`.
    let asked: Vec<String> = touched.keys().cloned().collect();
    if asked.is_empty() {
        return Ok(found);
    }
    if asked.len() > COVERED_BUDGET {
        return Err(format!(
            "others changed {} objects since your basis that may have moved into or out of this place, more than the guard asks the kit about at once ({COVERED_BUDGET}): inspect again and name the objects by id",
            asked.len()
        ));
    }
    // The relevant fields each asked object changed since `basis` (by anyone), by the field they
    // start at.
    let mut roots: BTreeMap<&str, BTreeSet<String>> = BTreeMap::new();
    for entry in entries {
        for item in entry.changes.as_ref().and_then(|changes| changes["changed"].as_array()).into_iter().flatten() {
            let Some(id) = item["id"].as_str().and_then(|id| asked.iter().find(|asked| *asked == id)) else { continue };
            let ty = item["type"].as_str().unwrap_or_default();
            for field in item["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|field| relevant(ty, field)) {
                roots.entry(id.as_str()).or_default().insert(root_field(field).to_owned());
            }
        }
    }
    // The values now of the stored fields to rebuild, in one load (a deleted object's are its `$was`).
    let live: Vec<(&String, Vec<String>)> = asked
        .iter()
        .filter(|id| touched.get(*id).is_some_and(|touched| touched.deleted.is_none() && !touched.created))
        .map(|id| (id, roots.get(id.as_str()).map(|roots| roots.iter().filter(|root| !root.starts_with('~')).cloned().collect()).unwrap_or_default()))
        .filter(|(_, fields): &(&String, Vec<String>)| !fields.is_empty())
        .collect();
    let mut current: HashMap<String, Map<String, Value>> = HashMap::new();
    if !live.is_empty() {
        let load = Value::Array(live.iter().map(|(id, fields)| json!({ "target": id, "fields": fields })).collect());
        if let Some(answer) = view.load(kits, load).await {
            for ((id, _), loaded) in live.iter().zip(answer["loaded"].as_array().into_iter().flatten()) {
                current.insert((*id).clone(), loaded["fields"].as_object().cloned().unwrap_or_default());
            }
        }
    }
    let mut objects = Vec::with_capacity(asked.len());
    for id in &asked {
        if touched.get(id).is_some_and(|touched| touched.created) {
            objects.push(json!({ "id": id, "before": {}, "created": true }));
            continue;
        }
        let deleted = touched.get(id).and_then(|touched| touched.deleted.clone());
        let mut before: Map<String, Value> = match &deleted {
            Some(was) => was.clone(),
            None => current.get(id).cloned().unwrap_or_default(),
        };
        let mut unknown: BTreeSet<String> = BTreeSet::new();
        // A deletion the journal kept nothing of (no `$was`): where it was is not known.
        if deleted.as_ref().is_some_and(Map::is_empty) {
            unknown.insert("$was".to_owned());
        }
        // Back from now through every entry, newest first: each edit's `before` replaces the
        // value at its path, so the earliest wins.
        for entry in entries.iter().rev() {
            let Some(change) = entry.changes.as_ref().and_then(|changes| listed(changes, "changed", id)) else { continue };
            let ty = change["type"].as_str().unwrap_or_default();
            for field in change["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|field| relevant(ty, field)) {
                let edits: Vec<&Value> =
                    change["edits"].as_array().into_iter().flatten().filter(|edit| edit["field"].as_str().is_some_and(|edit| overlaps(edit, field))).collect();
                if edits.is_empty() || edits.iter().any(|edit| edit.get("before").is_none()) {
                    unknown.insert(root_field(field).to_owned());
                    continue;
                }
                for edit in edits {
                    let path = edit["field"].as_str().unwrap_or_default();
                    set_path(&mut before, path, edit["before"].clone());
                }
            }
            if let Some(fields) = entry.changes.as_ref().and_then(|changes| changes["$text"][id].as_object()) {
                for (path, value) in fields {
                    if relevant(ty, path) {
                        set_path(&mut before, path, value.clone());
                        unknown.remove(root_field(path));
                    }
                }
            }
        }
        // Only what changed since `basis` is told: the kit takes the rest as it is now.
        let told: BTreeSet<String> = roots.get(id.as_str()).cloned().unwrap_or_default();
        if deleted.is_none() {
            before.retain(|field, _| told.contains(field));
        }
        // List order is part of a kit's hit test too. This reserved metadata is not a model field.
        if let Some(at) = entries.iter().find_map(|entry| {
            entry.changes.as_ref().and_then(|changes| {
                listed(changes, "moved", id).and_then(|item| item.get("from")).or_else(|| listed(changes, "deleted", id).and_then(|item| item.get("at")))
            })
        }) {
            before.insert("$at".into(), at.clone());
        }
        let mut object = json!({ "id": id, "before": before });
        if deleted.is_some() {
            object["deleted"] = json!(true);
        }
        if !unknown.is_empty() {
            object["unknown"] = json!(unknown);
        }
        objects.push(object);
    }
    let cannot = "the kit cannot say what was at this place at your basis: inspect again and name the objects by id";
    let Some(answer) = view.covered(kits, ask, objects).await else { return Err(cannot.to_owned()) };
    let Some(then) = answer["under"].as_array() else { return Err(cannot.to_owned()) };
    let then: Vec<String> = then.iter().filter_map(id_text).collect();
    let said: HashMap<String, Option<bool>> =
        answer["covered"].as_array().into_iter().flatten().filter_map(|item| Some((id_text(&item["id"])?, item["covered"].as_bool()))).collect();
    if let Some(id) = asked.iter().filter(|id| touched.get(*id).is_some_and(|touched| !touched.created)).find(|id| said.get(*id).copied().flatten().is_none()) {
        return Err(format!("the kit cannot say whether `{id}` was at this place at your basis: inspect again and name the objects by id"));
    }
    for item in answer["covered"].as_array().into_iter().flatten() {
        if item.get("gone").is_some_and(|value| !value.is_boolean()) {
            return Err("the kit cannot say whether a covered object still exists".into());
        }
    }
    let gone = |id: &str| {
        touched.get(id).is_some_and(|touched| touched.deleted.is_some())
            || answer["covered"].as_array().into_iter().flatten().any(|item| id_text(&item["id"]).as_deref() == Some(id) && item["gone"] == true)
    };
    for item in answer["covered"].as_array().into_iter().flatten() {
        let Some(id) = id_text(&item["id"]).filter(|id| asked.contains(id) && then.contains(id)) else { continue };
        if item["content"] == "deleted" || (gone(&id) && now_under.contains(&id)) {
            found.push((id, "deleted"));
            continue;
        }
        if !now_under.contains(&id) {
            continue;
        }
        match item.get("content") {
            Some(Value::String(value)) if value == "changed" => found.push((id, "changed")),
            None => {}
            Some(Value::String(value)) if value == "same" => {}
            _ => return Err(format!("the kit cannot compare covered content of `{id}` at your basis")),
        }
    }
    // Put there: under the place now, not at `basis`.
    for id in now_under.iter().filter(|id| !then.contains(id)) {
        found.push((id.clone(), "relocated"));
    }
    // Taken away: under the place at `basis`, not now; and what carried it away (a parent others
    // moved, covered at `basis` and not under the place now).
    for id in then.iter().filter(|id| !now_under.contains(id)) {
        found.push((id.clone(), if gone(id) { "deleted" } else { "relocated" }));
    }
    // Only when what the place names changed: a parent moved that left what it holds
    // under the place carried nothing away.
    let same = then.iter().collect::<BTreeSet<_>>() == now_under.iter().collect::<BTreeSet<_>>();
    for id in asked.iter().filter(|id| !same && said.get(*id).copied().flatten() == Some(true) && !now_under.contains(id) && !then.contains(id)) {
        found.push((id.clone(), if gone(id) { "deleted" } else { "relocated" }));
    }
    Ok(found)
}

/// Sets the value at `path` (`location`, `location.0`) in `fields`, making the containers on the
/// way.
fn set_path(fields: &mut Map<String, Value>, path: &str, value: Value) {
    let mut segments = path.split('.');
    let Some(first) = segments.next() else { return };
    let rest: Vec<&str> = segments.collect();
    if rest.is_empty() {
        fields.insert(first.to_owned(), value);
        return;
    }
    let mut at = fields.entry(first.to_owned()).or_insert(Value::Null);
    for segment in rest {
        at = match segment.parse::<usize>() {
            Ok(index) => {
                if !at.is_array() {
                    *at = Value::Array(Vec::new());
                }
                let Some(items) = at.as_array_mut() else { return };
                while items.len() <= index {
                    items.push(Value::Null);
                }
                &mut items[index]
            }
            Err(_) => {
                if !at.is_object() {
                    *at = Value::Object(Map::new());
                }
                let Some(members) = at.as_object_mut() else { return };
                members.entry(segment.to_owned()).or_insert(Value::Null)
            }
        };
    }
    *at = value;
}

/// The conflicts of `premises` with the entries after `basis` (`entries`, oldest first) by
/// authors other than `agent`, on the document `view` reads. Empty: the write may run.
/// A missing contract stays a conflict; an invalid input keeps the model's error.
pub(crate) enum ContractError {
    Missing,
    Invalid(super::KitToolError),
}

impl From<()> for ContractError {
    fn from((): ()) -> Self {
        Self::Missing
    }
}

/// Resolve the kit's declared premise contract without writing to the source document.
pub(crate) async fn batch_contract(kits: &KitManager, view: Reader<'_>, ops: &[Value]) -> Result<Vec<Value>, ContractError> {
    let described = view.described(kits).await.ok_or(())?;
    let schema = crate::drafts::schema_of(&described).ok();
    let targets: Vec<_> = ops
        .iter()
        .filter(|op| op["op"] != "command" && op["op"] != "create")
        .filter_map(|op| id_text(&op["target"]))
        .filter(|target| target != "root" && !target.starts_with('$'))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut types = BTreeMap::new();
    for targets in targets.chunks(256) {
        let loads: Vec<_> = targets.iter().map(|target| json!({"target":target,"fields":[]})).collect();
        if let Some(answer) = view.load(kits, json!(loads)).await
            && let Some(loaded) = answer["loaded"].as_array().filter(|loaded| loaded.len() == targets.len())
        {
            for (target, object) in targets.iter().zip(loaded) {
                if let Some(ty) = object["type"].as_str() {
                    types.insert(target.clone(), ty.to_owned());
                }
            }
        }
    }
    let mut aliases: BTreeMap<String, String> = BTreeMap::new();
    let mut guarded = Vec::new();
    for (index, op) in ops.iter().enumerate() {
        if op["op"] == "command" {
            guarded.push(op.clone());
            continue;
        }
        let mut name = op["op"].as_str().ok_or(())?;
        let ty = if name == "create" {
            op["type"].as_str().map(str::to_owned)
        } else {
            let target = op["target"].as_str().map(str::to_owned).or_else(|| id_text(&op["target"])).unwrap_or_default();
            if target == "root" {
                described["root"].as_str().map(str::to_owned)
            } else if let Some(ty) = aliases.get(&target) {
                Some(ty.clone())
            } else if let Some(ty) = types.get(&target) {
                Some(ty.clone())
            } else {
                view.load(kits, json!([{"target":target,"fields":[]}])).await.and_then(|answer| answer["loaded"][0]["type"].as_str().map(str::to_owned))
            }
        };
        // A gone target must reach the identity guard, which can report `deleted` precisely.
        let Some(mut ty) = ty else {
            if op["target"].as_str().is_some_and(|target| target.starts_with('$')) {
                let prefix: Vec<_> = ops.iter().take(index).cloned().collect();
                let plan = view
                    .context(
                        kits,
                        "plan",
                        Map::from_iter([
                            ("action".into(), json!("begin")),
                            ("steps".into(), json!([])),
                            ("ops".into(), json!(prefix)),
                            ("step".into(), json!(index)),
                        ]),
                    )
                    .await
                    .map_err(|_| ())?
                    .ok_or(())?;
                let token = plan["token"].as_str().ok_or(())?;
                let references =
                    plan["refs"].as_object().into_iter().flatten().filter_map(|(key, value)| id_text(value).map(|value| (key.clone(), value))).collect();
                let current = remap_batch(&json!({"ops":[op]}), &references);
                let resolved = id_text(&current["ops"][0]["target"]).is_some_and(|target| !target.starts_with('$'));
                let result = if resolved {
                    Box::pin(batch_contract(kits, Reader::Plan { source: &view, token }, current["ops"].as_array().ok_or(())?)).await
                } else {
                    Err(ContractError::Missing)
                };
                let _ = view.context(kits, "plan", Map::from_iter([("action".into(), json!("end")), ("token".into(), json!(token))])).await;
                guarded.extend(result?);
                continue;
            }
            guarded.push(op.clone());
            continue;
        };
        if name == "create"
            && let Some(alias) = op["ref"].as_str()
        {
            aliases.insert(alias.to_owned(), ty.clone());
        }
        let mut def = &described["types"][&ty];
        if def["readOnly"] == true || op["field"].as_str().is_some_and(|field| def["fields"][field]["readOnly"] == true) {
            guarded.push(op.clone());
            continue;
        }
        // Validate literal register values before contract admission. This reads only the
        // schema: neither the kit nor a scratch command can write through a stale premise.
        if name == "set"
            && let (Some(schema), Some(field)) = (&schema, op["field"].as_str())
            && schema.field(&ty, field).is_ok_and(|field| field.kind != kition_kdm::FieldKind::Ref)
            && let Err(error @ kition_kdm::KdmError::InvalidValue { .. }) = schema.check_value(&ty, field, &op["value"])
        {
            return Err(ContractError::Invalid(
                super::KitToolError::new(super::ErrorCode::Batch(kition_kdm::batch::BatchErrorCode::InvalidValue), error.to_string()).at(Some(index)),
            ));
        }
        let mut mapped_op = op.clone();
        if let Some(field) = op["field"].as_str() {
            let field_def = &def["fields"][field];
            if let Some(child) = field_def["of"].as_str().filter(|child| described["types"][*child]["projected"] == true)
                && (name.starts_with("list.") || name.starts_with("tree.") || name == "set" && field_def["kind"] == "ref" && field_def["owns"] == true)
            {
                // Container edits use the projected child's contract, just as projection routing does.
                let mut item = op.get("item").or_else(|| op.get("node")).cloned();
                if field_def["kind"] == "ref" {
                    item = item.or_else(|| op.get("value").cloned());
                    name = "ref.set";
                    mapped_op.as_object_mut().ok_or(())?.remove("field");
                }
                if item.is_none()
                    && let Some(index) = op[if name == "list.move" { "from" } else { "index" }].as_u64()
                {
                    item = view
                        .load(kits, json!([{"target":op["target"],"fields":[field]}]))
                        .await
                        .and_then(|loaded| loaded["loaded"][0]["fields"][field].get(index as usize).cloned());
                }
                if let Some(item) = item {
                    mapped_op["target"] = item;
                    mapped_op["in"] = json!(format!("{}.{field}", id_text(&op["target"]).ok_or(())?));
                }
                ty = child.to_owned();
                def = &described["types"][&ty];
            }
        }
        let keyed = mapped_op["field"].as_str().map(|field| format!("{name}.{field}"));
        let mappings = if def["projected"] == true { &def["projectedOps"] } else { &def["batchOps"] };
        let mapping = keyed.as_ref().and_then(|key| mappings.get(key)).or_else(|| mappings.get(name)).or_else(|| mappings.get("*"));
        let Some(mapping) = mapping else {
            // Ask the actual model to validate a rejected raw prefix in an isolated fork.
            // Its literal-field rules may differ from KDM's held paths. Never execute a
            // command here: a missing contract must not trigger a command's side effects.
            if ops[..=index].iter().all(|op| op["op"] != "command") {
                let plan = view
                    .context(
                        kits,
                        "plan",
                        Map::from_iter([
                            ("action".into(), json!("begin")),
                            ("steps".into(), json!([])),
                            ("ops".into(), json!(&ops[..=index])),
                            ("step".into(), json!(index + 1)),
                        ]),
                    )
                    .await;
                match plan {
                    Err(error) if matches!(error.code, super::ErrorCode::Batch(_)) => return Err(ContractError::Invalid(error)),
                    Ok(Some(plan)) => {
                        if let Some(token) = plan["token"].as_str() {
                            let _ = view.context(kits, "plan", Map::from_iter([("action".into(), json!("end")), ("token".into(), json!(token))])).await;
                        }
                    }
                    _ => {}
                }
            }
            return Err(ContractError::Missing);
        };
        if mapping["direct"] == true {
            guarded.push(op.clone());
        } else {
            let command = mapping["command"].as_str().filter(|command| !command.is_empty()).ok_or(())?;
            let mut params = Map::new();
            for (parameter, path) in mapping["params"].as_object().into_iter().flatten() {
                let value = path.as_str().ok_or(())?.split('.').try_fold(&mapped_op, |value, key| match value {
                    Value::Array(items) => key.parse::<usize>().ok().and_then(|index| items.get(index)),
                    _ => value.get(key),
                });
                if let Some(value) = value {
                    params.insert(parameter.clone(), value.clone());
                }
            }
            guarded.push(json!({"op":"command","id":command,"params":params,"on":op.get("on"),"at":op.get("at")}));
        }
    }
    Ok(guarded)
}

pub(crate) async fn batch_conflicts(
    kits: &KitManager,
    view: Reader<'_>,
    batch: (&[Value], &HashMap<String, Acts>),
    entries: &[Entry],
    agent: &str,
    inputs: Option<&Value>,
    basis_model: Option<&Value>,
) -> Vec<Conflict> {
    let (ops, acts) = batch;
    if entries.is_empty()
        && let Ok(contract) = batch_contract(kits, view, ops).await
        && contract.iter().all(|op| op["op"] != "command")
    {
        return conflicts_at(kits, view, &Premises::of_batch(&contract, acts), entries, agent, inputs, basis_model).await;
    }
    let mut found = BTreeMap::new();
    let mut active: Option<String> = None;
    for index in 0..ops.len() {
        let plan = if index == 0 {
            None
        } else {
            view.context(
                kits,
                "plan",
                Map::from_iter([
                    ("action".into(), json!(if active.is_some() { "advance" } else { "begin" })),
                    ("token".into(), json!(active)),
                    ("steps".into(), json!([])),
                    ("ops".into(), json!(if active.is_some() { &ops[index - 1..index] } else { &ops[..index] })),
                    ("step".into(), json!(index)),
                ]),
            )
            .await
            .ok()
            .flatten()
        };
        let token = plan.as_ref().and_then(|plan| plan["token"].as_str());
        if index > 0 && token.is_none() {
            add_to(&mut found, Conflict::unknown().because(Unavailable::State));
            break;
        }
        if let Some(token) = token {
            active = Some(token.to_owned());
        }
        let reader = token.map(|token| Reader::Plan { source: &view, token }).unwrap_or(view);
        let mut history = entries.to_vec();
        if let Some(plan) = &plan {
            history.push(Entry { seq: history.last().map_or(1, |entry| entry.seq + 1), author: agent.to_owned(), changes: Some(plan["changes"].clone()) });
        }
        let references = plan
            .as_ref()
            .and_then(|plan| plan["refs"].as_object())
            .into_iter()
            .flatten()
            .filter_map(|(key, value)| id_text(value).map(|value| (key.clone(), value)))
            .collect();
        let current = remap_batch(&json!({"ops":[ops[index]]}), &references);
        let contract = batch_contract(kits, reader, current["ops"].as_array().expect("batch operations")).await;
        if let Ok(contract) = contract {
            let mut one = Premises::of_batch(&contract, acts);
            if let Some(plan) = &plan {
                one.state.retain(|field| plan["beforeState"].get(field) == plan["state"].get(field));
            }
            for step in &mut one.steps {
                step.ask.step = index;
            }
            for conflict in conflicts_at(kits, reader, &one, &history, agent, inputs, basis_model).await {
                add_to(&mut found, conflict);
            }
        } else {
            add_to(&mut found, Conflict::unknown());
        }
        if !found.is_empty() {
            break;
        }
    }
    if let Some(token) = active {
        let _ = view.context(kits, "plan", Map::from_iter([("action".into(), json!("end")), ("token".into(), json!(token))])).await;
    }
    found.into_values().collect()
}

pub(crate) async fn conflicts(
    kits: &KitManager,
    view: Reader<'_>,
    premises: &Premises,
    entries: &[Entry],
    agent: &str,
    inputs: Option<&Value>,
    basis_model: Option<&Value>,
) -> Vec<Conflict> {
    if premises.steps.len() < 2 || premises.raw_values.is_some() {
        return conflicts_at(kits, view, premises, entries, agent, inputs, basis_model).await;
    }
    let mut found = BTreeMap::new();
    let mut prefix: Vec<Value> = Vec::new();
    let mut active: Option<String> = None;
    for (index, step) in premises.steps.iter().enumerate() {
        let mut one = premises.clone();
        one.steps = vec![step.clone()];
        one.state = step.state.clone();
        one.places.retain(|place| place.step == index);
        for place in &mut one.places {
            place.step = 0;
        }
        let plan = if index == 0 {
            None
        } else {
            view.context(
                kits,
                "plan",
                Map::from_iter([
                    ("action".into(), json!(if active.is_some() { "advance" } else { "begin" })),
                    ("token".into(), json!(active)),
                    ("steps".into(), json!(if active.is_some() { &prefix[prefix.len() - 1..] } else { &prefix[..] })),
                    ("step".into(), json!(index)),
                ]),
            )
            .await
            .ok()
            .flatten()
        };
        if plan.as_ref().is_some_and(|plan| plan["closed"] == true) {
            break;
        }
        if index > 0 && plan.as_ref().and_then(|plan| plan["token"].as_str()).is_none() {
            add_to(&mut found, Conflict::unknown().because(Unavailable::State));
            break;
        }
        let token = plan.as_ref().and_then(|plan| plan["token"].as_str());
        if let Some(token) = token {
            active = Some(token.to_owned());
        }
        let planned = token.map(|token| Reader::Plan { source: &view, token }).unwrap_or(view);
        let mut history = entries.to_vec();
        if let Some(plan) = &plan {
            one.steps[0].later_time = None;
            one.state.retain(|field| plan["beforeState"].get(field) == plan["state"].get(field));
            history.push(Entry { seq: history.last().map_or(1, |entry| entry.seq + 1), author: agent.to_owned(), changes: Some(plan["changes"].clone()) });
        }
        for conflict in conflicts_at(kits, planned, &one, &history, agent, inputs, basis_model).await {
            add_to(&mut found, conflict);
        }
        let mut context = Map::new();
        if !step.ask.on.is_empty() {
            context.insert("on".into(), json!(step.ask.on));
        }
        if let Some(part) = &step.ask.part {
            context.insert("part".into(), part.clone());
        }
        if let Some(time) = step.ask.time {
            context.insert("time".into(), json!(time));
        }
        prefix.push(json!({"command":step.ask.command,"params":step.ask.params,"context":context}));
        if !found.is_empty() {
            break;
        }
    }
    if let Some(token) = active {
        let _ = view.context(kits, "plan", Map::from_iter([("action".into(), json!("end")), ("token".into(), json!(token))])).await;
    }
    found.into_values().collect()
}

async fn conflicts_at(
    kits: &KitManager,
    view: Reader<'_>,
    premises: &Premises,
    entries: &[Entry],
    agent: &str,
    inputs: Option<&Value>,
    basis_model: Option<&Value>,
) -> Vec<Conflict> {
    let mut answers = Vec::with_capacity(premises.steps.len());
    for step in &premises.steps {
        answers.push(match &step.under {
            Some(under) => Some(under.clone()),
            None => view.under(kits, &step.ask).await,
        });
    }
    let mut found: BTreeMap<String, Conflict> = BTreeMap::new();
    for input in answers.iter().flatten().flat_map(|answer| answer["inputs"].as_array().into_iter().flatten()) {
        let Some(name) = input.as_str() else {
            add_to(&mut found, Conflict::unknown().because(Unavailable::Input));
            continue;
        };
        let mut reason = inputs.and_then(|inputs| inputs.get(name)).and_then(Value::as_str).is_none().then_some("unknown");
        for change in entries.iter().filter_map(|entry| entry.changes.as_ref().and_then(|changes| changes.get("externalInputs"))) {
            let before = change["before"].get(name).and_then(Value::as_str);
            let after = change["after"].get(name).and_then(Value::as_str);
            if before.is_none() || after.is_none() {
                reason = Some("unknown");
            } else if before != after && reason != Some("unknown") {
                reason = Some("changed");
            }
        }
        if let Some(reason) = reason {
            found.insert(format!("$input.{name}"), Conflict::of(None, reason, Some(json!({"input":name}))).because(Unavailable::Input));
        }
    }
    // Public rereads count unnamed objects; the private journal retains their positional edits.
    let entries: Vec<Entry> = entries
        .iter()
        .cloned()
        .map(|mut entry| {
            if let Some(changes) = &mut entry.changes
                && let Some(raw) = changes.get("$objects").cloned()
            {
                for list in LISTS {
                    if let Some(items) = raw[list].as_array()
                        && let Some(all) = changes[list].as_array_mut()
                    {
                        // Kit-declared premises can add targets after this expansion.
                        all.extend(items.iter().cloned());
                    }
                }
            }
            if let Some(changes) = &mut entry.changes
                && let Some(hidden) = changes.as_object_mut().and_then(|changes| changes.remove("$unnamed"))
            {
                for list in LISTS {
                    if let Some(items) = hidden[list].as_array()
                        && let Some(all) = changes[list].as_array_mut()
                    {
                        all.extend(items.iter().cloned());
                    }
                }
            }
            if let Some(changes) = &mut entry.changes
                && let Some(private) = changes.as_object_mut().and_then(|changes| changes.remove("$premises")).and_then(|private| private.as_array().cloned())
                && let Some(changed) = changes["changed"].as_array_mut()
            {
                for item in private {
                    if let Some(existing) = changed.iter_mut().find(|existing| existing["id"] == item["id"]) {
                        // Guard readers expect one record per object, including coverage's
                        // historical before values. Restore private edits on that same record.
                        for key in ["fields", "edits"] {
                            let mut values = existing[key].as_array().cloned().unwrap_or_default();
                            for value in item[key].as_array().into_iter().flatten() {
                                if key != "fields" || !values.contains(value) {
                                    values.push(value.clone());
                                }
                            }
                            existing[key] = json!(values);
                        }
                    } else {
                        changed.push(item);
                    }
                }
            }
            entry
        })
        .collect();
    let entries = entries.as_slice();
    let others: Vec<&Entry> = entries.iter().filter(|entry| entry.author != agent).collect();
    if others.is_empty() {
        return found.into_values().collect();
    }
    if answers.iter().flatten().any(|answer| answer["$unavailable"] == true) {
        let mut conflict = Conflict::unknown().because(Unavailable::Place);
        conflict.place = Some(json!({"unknown":"the editor's kit cannot determine this call's premises"}));
        return vec![conflict];
    }
    if others.iter().any(|entry| entry.changes.is_none()) {
        return vec![Conflict::unknown()];
    }
    let mut expanded = premises.clone();
    if !batch_windows(kits, view, &mut expanded, entries).await {
        return vec![Conflict::unknown().because(Unavailable::Place)];
    }
    let premises = &expanded;
    let described = Described(view.described(kits).await);
    let by_others = |entry: &Entry| entry.author != agent;
    for range in &premises.text_ranges {
        if let Some(reason) = text_range_reason(range, entries, agent) {
            add_to(&mut found, Conflict::of(Some(range.owner.clone()), reason, None));
        }
    }
    for state in &premises.state {
        for entry in &others {
            if let Some(change) = entry.changes.as_ref().and_then(|changes| changes.get("editorState")) {
                let before = change["before"].get(state);
                let after = change["after"].get(state);
                if before != after {
                    found.insert(format!("$state.{state}"), Conflict::of(None, "changed", Some(json!({"state": state}))));
                } else if before.is_none() && change["before"] != change["after"] {
                    found.insert(format!("$state.{state}"), Conflict::unknown().because(Unavailable::State));
                }
            }
        }
    }
    // Where each list others changed holds its items now, read once.
    let mut touched: BTreeSet<Place> = BTreeSet::new();
    for entry in &others {
        touched.extend(entry.changes.as_ref().map(list_edits).unwrap_or_default().into_keys());
    }
    let mut now: HashMap<Place, Vec<String>> = HashMap::new();
    for (place, listed) in lists_now(kits, view, touched.iter()).await {
        now.insert(place, listed);
    }
    let position = |id: &str| now.iter().find_map(|(place, items)| items.iter().position(|item| item == id).map(|index| (place.clone(), index)));
    let at = |place: &Place, index: usize| json!({ "parent": place.0, "field": place.1, "index": index });
    // Every object others' change sets name, and the changes naming it, with their list.
    let mut named: BTreeMap<&str, Vec<(&str, &Value)>> = BTreeMap::new();
    for entry in &others {
        for list in LISTS {
            for item in entry.changes.as_ref().and_then(|changes| changes[list].as_array()).into_iter().flatten() {
                if let Some(id) = item["id"].as_str() {
                    named.entry(id).or_default().push((list, item));
                }
            }
        }
    }
    let renumbered: BTreeSet<String> = others.iter().filter_map(|entry| entry.changes.as_ref()).flat_map(renumbered_in).collect();
    // The objects others changed in a change set whose derived values were not read: a premise
    // on one of their derived values (`~topology`) is touched by any change.
    let untold: BTreeSet<&str> = others
        .iter()
        .filter_map(|entry| entry.changes.as_ref())
        .filter(|changes| !super::derived::told(changes))
        .flat_map(|changes| changes["changed"].as_array().into_iter().flatten().filter_map(|item| item["id"].as_str()))
        .collect();
    // Whether a change names a field the schema marks as a position (`start`) that `need` depends
    // on: a move.
    let positional_for = |change: &Value, need: &Need| {
        let ty = change["type"].as_str().unwrap_or_default();
        change["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).any(|field| described.position(ty, field) && need.position(field))
    };
    let positional = |change: &Value| positional_for(change, &Need::all());
    // Where an object is now by the position fields changed since `basis` (the agent's own
    // changes included), each by its field: a leaf's change (`location.0`) names the whole field,
    // whose value [`with_positions_now`] reads after. A field named like a list's place
    // (`parent`) is in `now.fields`.
    let placed_now = |id: &str, mut now: Value| {
        for entry in entries {
            let Some(change) = entry.changes.as_ref().and_then(|changes| listed(changes, "changed", id)) else { continue };
            let ty = change["type"].as_str().unwrap_or_default();
            for field in change["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|field| described.position(ty, field)) {
                let root = root_field(field);
                let whole = change["edits"].as_array().into_iter().flatten().find(|edit| edit["field"] == root).map(|edit| edit["after"].clone());
                let slot = if LIST_PLACE.contains(&root) { &mut now["fields"][root] } else { &mut now[root] };
                *slot = whole.unwrap_or(Value::Null);
            }
        }
        now
    };
    // Others moved it, as far as `need` depends on where it is: within or out of its list (when
    // `list` matters), or a position field it needs.
    let moved_for = |id: &str, need: &Need, list: bool| {
        named.get(id).into_iter().flatten().any(|(kind, change)| (*kind == "moved" && list) || (*kind == "changed" && positional_for(change, need)))
    };
    let moved_by_others = |id: &str| moved_for(id, &Need::all(), true);
    let mut budget = 200usize;
    // What the kit says each step depends on: asked for every step of a run.
    for step in premises.steps.iter().skip(answers.len()) {
        answers.push(match &step.under {
            Some(under) => Some(under.clone()),
            None => view.under(kits, &step.ask).await,
        });
    }
    // Declared places also hold absence when the command names its target by id.
    let mut windowed = premises.clone();
    for (step, answer) in answers.iter().enumerate() {
        if answer.as_ref().is_none_or(|answer| answer["within"].as_array().is_none_or(Vec::is_empty) && !answer["covers"].is_object()) {
            continue;
        }
        if let Some(place) = windowed.places.iter_mut().find(|place| place.step == step) {
            place.placed = true;
        } else {
            windowed.places.push(PlaceStep {
                step,
                named: json!({"within":answer.as_ref().unwrap()["within"],"covers":answer.as_ref().unwrap()["covers"]}),
                indexes: Vec::new(),
                numbers: Vec::new(),
                types: None,
                placed: true,
                spelling: None,
                reversed: false,
            });
        }
    }
    let premises = &windowed;
    for order in answers.iter().flatten().flat_map(|under| under["orders"].as_array().into_iter().flatten()) {
        for conflict in relative_order(kits, view, order, entries, agent).await {
            add_to(&mut found, conflict);
        }
    }
    // A separate content premise never erases another step's whole-field hold.
    for content in answers.iter().flatten().flat_map(|under| under["content"].as_array().into_iter().flatten()) {
        let (Some(id), Some(field)) = (content.get("id").and_then(id_text), content["field"].as_str().filter(|field| !field.is_empty())) else {
            add_to(&mut found, Conflict::unknown().because(Unavailable::ContentBasis));
            continue;
        };
        let relevant = |item: &Value| {
            item["id"].as_str() == Some(&id)
                && item["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).any(|changed| overlaps(changed, field))
        };
        if !others.iter().any(|entry| {
            entry.changes.as_ref().is_some_and(|changes| {
                changes["changed"].as_array().into_iter().flatten().any(relevant)
                    || ["created", "deleted"].iter().any(|list| listed(changes, list, &id).is_some())
            })
        }) {
            continue;
        }
        let current = view.object(kits, &id).await;
        let mut before = current.as_ref().and_then(|object| object["fields"].as_object()).cloned().unwrap_or_default();
        let mut known = current.is_some();
        for entry in entries.iter().rev() {
            let Some(changes) = &entry.changes else {
                known = false;
                continue;
            };
            if ["created", "deleted"].iter().any(|list| listed(changes, list, &id).is_some()) {
                known = false;
            }
            if let Some(item) = listed(changes, "changed", &id).filter(|item| relevant(item)) {
                let edits: Vec<&Value> =
                    item["edits"].as_array().into_iter().flatten().filter(|edit| edit["field"].as_str().is_some_and(|path| overlaps(path, field))).collect();
                if edits.is_empty() {
                    known = false;
                }
                for edit in edits {
                    if let Some(path) = edit["field"].as_str()
                        && let Some(value) = changes["$text"][&id].get(path).or_else(|| edit.get("before"))
                    {
                        set_path(&mut before, path, value.clone());
                    } else {
                        known = false;
                    }
                }
            }
        }
        let mut value = json!(before);
        for segment in field.split('.') {
            value = value.get(segment).cloned().unwrap_or(Value::Null);
        }
        // Eager derived edits may omit large values from the journal's public diff.
        // Their complete private checkpoints share the on-demand facts' retention bound.
        if field.starts_with(super::derived::MARK)
            && let Some(complete) = basis_model.and_then(|basis| basis["derived"].get(&id)).and_then(|object| object.get(field))
        {
            value = complete.clone();
            known = true;
        }
        // Public excerpts cannot establish a content basis after private history was bounded out.
        if value.get("excerpt").is_some() && value.get("length").is_some() {
            known = false;
        }
        let changed = if known {
            let mut params = content.as_object().cloned().unwrap_or_default();
            params.insert("before".into(), value);
            if let Ok(token) = super::history::TOKEN.try_with(Clone::clone) {
                params.insert("history".into(), json!(token));
            }
            view.context(kits, "content", params).await.ok().flatten().and_then(|answer| answer["changed"].as_bool())
        } else {
            None
        };
        if changed != Some(false) {
            add_to(
                &mut found,
                Conflict::of(Some(id), if changed == Some(true) { "changed" } else { "unknown" }, Some(content.clone())).because(if known {
                    Unavailable::Content
                } else {
                    Unavailable::ContentBasis
                }),
            );
        }
    }
    // A whole number the command reads as a place when it names no object: an id when others'
    // changes name it (and did not create it) or the document has it now, else a place.
    // With the types the parameter names (`x-khp-types`), a number naming an object of
    // another type (a comp item `1` for a layer parameter) names none, and is a place.
    let mut is_object: BTreeMap<String, bool> = BTreeMap::new();
    for place in &premises.places {
        for (_, text) in &place.numbers {
            if is_object.contains_key(text) {
                continue;
            }
            let of_type = |ty: Option<&str>| place.types.as_ref().is_none_or(|types| ty.is_some_and(|ty| types.iter().any(|wanted| wanted == ty)));
            let known = match named.get(text.as_str()) {
                Some(changes) => !changes.iter().any(|(list, _)| *list == "created") && of_type(changes.iter().find_map(|(_, change)| change["type"].as_str())),
                None => view
                    .load(kits, json!([{ "target": text, "fields": [] }]))
                    .await
                    .is_some_and(|answer| answer["loaded"][0]["id"].as_str().is_some_and(|id| !id.is_empty()) && of_type(answer["loaded"][0]["type"].as_str())),
            };
            is_object.insert(text.clone(), known);
        }
    }
    // What the write needs of each object: what its steps and operations name, narrowed or widened
    // by what the kit says each step needs (its `premises`); the objects a place names now are
    // named as if by id.
    let mut targets: BTreeMap<String, Need> = premises.targets.clone();
    if let Some((ops, _)) = &premises.raw_values {
        for (id, need) in &mut targets {
            let writes: Vec<_> = ops.iter().filter(|op| id_text(&op["target"]).as_ref() == Some(id)).collect();
            if writes.is_empty() || !writes.iter().all(|op| matches!(op["op"].as_str(), Some("set" | "text.set" | "map.set" | "map.delete"))) {
                continue;
            }
            if let Some(object) = view.object(kits, id).await
                && described.0.as_ref().is_some_and(|model| model["types"][object["type"].as_str().unwrap_or_default()]["batchIndependent"] == true)
            {
                need.positions = need.fields.clone();
            }
        }
    }
    // The objects each place step names now, with the step: their conflicts carry the place.
    let mut placed: BTreeMap<String, usize> = BTreeMap::new();
    for (number, step) in premises.steps.iter().enumerate() {
        let mut ids = step.ids.clone();
        let place = premises.places.iter().position(|place| place.step == number);
        if let Some(place) = place.map(|place| &premises.places[place]) {
            for (_, text) in &place.numbers {
                if is_object.get(text) == Some(&false) {
                    ids.remove(text);
                }
            }
        }
        let answer = answers[number].as_ref();
        let place =
            place.filter(|place| premises.places[*place].placed || premises.places[*place].numbers.iter().any(|(_, text)| is_object.get(text) == Some(&false)));
        let reversed = place.is_some_and(|place| premises.places[place].reversed);
        for id in answer.map(|answer| &answer["objects"]).and_then(Value::as_array).into_iter().flatten().filter_map(id_text) {
            if let Some(place) = place {
                placed.entry(id.clone()).or_insert(place);
            }
            ids.entry(id).or_insert_with(|| if reversed { Need::of_command(true) } else { Need::all() });
        }
        let mut declared = BTreeMap::new();
        for premise in answer.map(|answer| &answer["premises"]).and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = premise.get("id").and_then(id_text) {
                add_need(&mut declared, id, Need::of_premise(premise));
            }
        }
        ids.extend(declared);
        for (id, need) in ids {
            add_need(&mut targets, id, need);
        }
    }
    // The strings the parameters mention that name an object of the document at `basis`: one
    // others' changes name (unless others created it since), or one the document has now, by the
    // id a load answers for it (its tool id when it has one).
    // The mentioned strings that name an object: a step whose parameters name one acts on it,
    // not on its part.
    let mut resolved: BTreeSet<String> = BTreeSet::new();
    let mut asked = 0usize;
    let mut mentioned = premises.mentioned.clone();
    if let Some((ops, command_mentions)) = &premises.raw_values {
        mentioned = command_mentions.clone();
        for op in ops {
            let object = match op["target"].as_str() {
                Some(id) => view.object(kits, id).await,
                None => None,
            };
            let ty = op["type"].as_str().or_else(|| object.as_ref().and_then(|object| object["type"].as_str()));
            let Some(ty) = ty else { continue };
            let values: Vec<(&str, &Value)> = if op["op"] == "create" {
                op["fields"].as_object().into_iter().flatten().map(|(field, value)| (field.as_str(), value)).collect()
            } else {
                op["field"].as_str().zip(op.get("value")).into_iter().collect()
            };
            for (field, value) in values {
                let Some(def) = described.field(ty, root_field(field)) else { continue };
                if matches!(def["kind"].as_str(), Some("ref" | "list" | "tree")) || def["kind"] == "map" && def["owns"] == true {
                    mentioned_in(value, false, &mut mentioned);
                }
            }
        }
    }
    for text in &mentioned {
        if targets.contains_key(text) {
            resolved.insert(text.clone());
            continue;
        }
        let typed = premises.typed.get(text);
        let of_type = |ty: Option<&str>| typed.is_none_or(|types| ty.is_some_and(|ty| types.iter().any(|wanted| wanted == ty)));
        if let Some(changes) = named.get(text.as_str()) {
            if !changes.iter().any(|(list, _)| *list == "created") && of_type(changes.iter().find_map(|(_, change)| change["type"].as_str())) {
                targets.entry(text.clone()).or_insert_with(Need::all);
                resolved.insert(text.clone());
            }
            continue;
        }
        if renumbered.contains(text) {
            targets.entry(text.clone()).or_insert_with(Need::all);
            resolved.insert(text.clone());
            continue;
        }
        if asked == MENTIONED_READS {
            break;
        }
        asked += 1;
        let answer = view.load(kits, json!([{ "target": text, "fields": [] }])).await;
        if let Some(id) = answer
            .as_ref()
            .filter(|answer| of_type(answer["loaded"][0]["type"].as_str()))
            .and_then(|answer| answer["loaded"][0]["id"].as_str())
            .filter(|id| !id.is_empty())
        {
            targets.entry(id.to_owned()).or_insert_with(Need::all);
            resolved.insert(text.clone());
        }
    }
    // The steps that name what they act on by a place: the objects under it now are those that
    // were there at `basis`, told exactly for a place in time.
    let others_changed = others.iter().filter_map(|entry| entry.changes.as_ref()).any(|changes| !is_nothing(changes));
    for (number, step) in premises.steps.iter().enumerate().filter(|(_, step)| step.later_time.is_some()) {
        let names_nothing = answers[number]
            .as_ref()
            .is_some_and(|answer| answer["objects"].as_array().is_some_and(Vec::is_empty) && answer["within"].as_array().is_none_or(Vec::is_empty));
        if others_changed && !names_nothing {
            let mut place = step.later_time.clone().unwrap_or_default();
            place["unknown"] = json!(
                "the step reads the time an earlier step of the run sets, which is not known before the run: give the step `at.time`, or name its objects by id"
            );
            add_to(&mut found, Conflict { id: None, reason: "relocated", now: None, place: Some(place), ty: None, cause: None });
        }
    }
    if !premises.places.is_empty() {
        let edits: Vec<HashMap<Place, ListEdit>> = entries.iter().map(|entry| entry.changes.as_ref().map(list_edits).unwrap_or_default()).collect();
        // The index at `basis` of the item at `index` of `place` after the first `upto` entries;
        // `None` for one an entry put there.
        let to_basis = |place: &Place, index: usize, upto: usize| {
            let mut index = index;
            for edit in edits[..upto].iter().rev() {
                if let Some(edit) = edit.get(place) {
                    index = edit.backward(index)?;
                }
            }
            Some(index)
        };
        let by_positions = described.has_positions();
        let structural = others.iter().filter_map(|entry| entry.changes.as_ref()).any(|changes| {
            ["created", "deleted", "moved"].iter().any(|list| changes[*list].as_array().is_some_and(|items| !items.is_empty()))
                || changes["changed"].as_array().into_iter().flatten().any(positional)
        });
        let mut lists: HashMap<Place, Vec<String>> = HashMap::new();
        for step in &premises.places {
            // A number that names an object is an id, and no place.
            let indexes: Vec<usize> = step
                .indexes
                .iter()
                .copied()
                .chain(step.numbers.iter().filter(|(_, text)| is_object.get(text) == Some(&false)).map(|(index, _)| *index))
                .collect();
            if !step.placed && indexes.is_empty() {
                continue;
            }
            let Some(under) = answers[step.step].as_ref() else {
                // The kit cannot say what the place names: any move by others may have changed it.
                if structural {
                    let mut place = step.named.clone();
                    place["unknown"] = json!("the kit cannot say what this place names: inspect again and name the objects by id");
                    add_to(&mut found, Conflict { id: None, reason: "relocated", now: None, place: Some(place), ty: None, cause: None });
                }
                continue;
            };
            let objects: Vec<String> = under["objects"].as_array().into_iter().flatten().filter_map(id_text).collect();
            let mut place_of = step.named.clone();
            place_of["under"] = under["objects"].clone();
            // A place the kit tells by being asked: which objects others moved were
            // under it at `basis`, from their values then.
            if let Some(covers) = under.get("covers").filter(|covers| covers.is_object()) {
                let fields: Vec<String> = covers["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
                match covered_by(kits, view, &described, &premises.steps[step.step].ask, &objects, &fields, entries, agent).await {
                    Ok(found_here) => {
                        for (id, reason) in found_here {
                            let now = Some(placed_now(&id, json!({}))).filter(|now| now.as_object().is_some_and(|now| !now.is_empty()));
                            let mut place = place_of.clone();
                            if reason == "deleted"
                                && !others.iter().any(|entry| entry.changes.as_ref().and_then(|changes| listed(changes, "deleted", &id)).is_some())
                            {
                                place["content"] = json!("deleted");
                            }
                            add_to(&mut found, Conflict { id: Some(id), reason, now, place: Some(place), ty: None, cause: None });
                        }
                    }
                    Err(why) => {
                        let mut place = place_of.clone();
                        place["unknown"] = json!(why);
                        add_to(&mut found, Conflict { id: None, reason: "unknown", now: None, place: Some(place), ty: None, cause: Some(Unavailable::Place) });
                    }
                }
                if under["within"].as_array().is_none_or(Vec::is_empty) {
                    continue;
                }
            }
            let mut windows: Vec<(Place, usize, usize, Option<Span>)> = under["within"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|window| {
                    let place = (id_text(&window["parent"])?, window["field"].as_str()?.to_owned());
                    let from = usize::try_from(window["from"].as_u64().unwrap_or(0)).ok()?;
                    let to = usize::try_from(window["to"].as_u64().unwrap_or(0)).ok()?;
                    Some((place, from, to, window.get("time").and_then(Span::of)))
                })
                .collect();
            if windows.is_empty() {
                // The kit names no window: each object's place in a list others changed.
                windows = objects.iter().filter_map(|id| position(id)).map(|(place, index)| (place, index, index + 1, None)).collect();
            }
            let wanted: Vec<Place> = windows.iter().map(|(place, ..)| place.clone()).filter(|place| !lists.contains_key(place)).collect();
            for (place, listed) in lists_now(kits, view, wanted.iter()).await {
                lists.insert(place, listed);
            }
            // Each index (counted from 0 in the command's order) as the stored index the kit's
            // window gives it now (`now`) and the stored index it named at `basis` (`basis`;
            // `None` past the list's end then). From the other end, both are read from
            // the list's length now and at `basis`, followed back through every entry.
            let stored: Vec<(Option<usize>, Option<usize>)> = indexes
                .iter()
                .map(|&index| {
                    if !step.reversed {
                        return (Some(index), Some(index));
                    }
                    let place = windows
                        .iter()
                        .find(|(place, from, ..)| lists.get(place).is_some_and(|listed| listed.len().checked_sub(index + 1) == Some(*from)))
                        .or(windows.first())
                        .map(|(place, ..)| place.clone());
                    let Some(length) = place.as_ref().and_then(|place| lists.get(place)).map(Vec::len) else { return (None, None) };
                    let place = place.unwrap_or_default();
                    let at_basis = edits
                        .iter()
                        .filter_map(|edit| edit.get(&place))
                        .fold(length as isize, |length, edit| length - edit.added.len() as isize + edit.removed.len() as isize);
                    (length.checked_sub(index + 1), usize::try_from(at_basis).ok().and_then(|length| length.checked_sub(index + 1)))
                })
                .collect();
            let where_now = |id: &str| {
                let found = lists.iter().find_map(|(place, items)| items.iter().position(|item| item == id).map(|index| at(place, index)));
                Some(placed_now(id, found.unwrap_or_else(|| json!({})))).filter(|now| now.as_object().is_some_and(|now| !now.is_empty()))
            };
            let conflict = |id: &str, reason: &'static str| Conflict {
                id: Some(id.to_owned()),
                reason,
                now: where_now(id),
                place: Some(place_of.clone()),
                ty: None,
                cause: None,
            };
            let gap = |window: &(Place, usize, usize, Option<Span>)| window.3.is_none() && window.1 == window.2 && stored.is_empty();
            for (place, from, _, _) in windows.iter().filter(|window| gap(window)) {
                let others_here = entries.iter().enumerate().any(|(at, entry)| by_others(entry) && edits[at].contains_key(place));
                if !lists.contains_key(place) && others_here {
                    let mut place = place_of.clone();
                    place["unknown"] = json!("the list holding this insertion gap cannot be read");
                    add_to(&mut found, Conflict { id: None, reason: "unknown", now: None, place: Some(place), ty: None, cause: Some(Unavailable::Place) });
                    continue;
                }
                let mut index = *from;
                let mut length = lists.get(place).map_or(0, Vec::len) as isize;
                for edit in edits.iter().filter_map(|edits| edits.get(place)) {
                    length += edit.removed.len() as isize - edit.added.len() as isize;
                }
                for (at, entry) in entries.iter().enumerate() {
                    let Some(edit) = edits[at].get(place) else { continue };
                    // The gap holds the item to its left and right (or the boundary), not an
                    // empty set of items. Follow our own edits too, without refusing them.
                    let left_changed = index.checked_sub(1).is_some_and(|left| edit.forward(left) != Some(left));
                    let right_changed = (index as isize) < length && edit.forward(index) != Some(index);
                    let end_changed = index as isize == length && edit.added.contains(&index);
                    let rank = index - edit.removed.range(..index).count();
                    index = nth_free(&edit.added, rank);
                    length += edit.added.len() as isize - edit.removed.len() as isize;
                    if by_others(entry) && (left_changed || right_changed || end_changed) {
                        add_to(&mut found, Conflict { id: None, reason: "relocated", now: None, place: Some(place_of.clone()), ty: None, cause: None });
                        break;
                    }
                }
            }
            // Exactly told: time, an index spelling, or an insertion gap.
            let exact =
                |window: &(Place, usize, usize, Option<Span>)| gap(window) || window.3.is_some() || stored.iter().any(|(now, _)| *now == Some(window.1));
            for (place, _, _, span) in &windows {
                let Some(span) = span else { continue };
                if let Some(reason) = json_window(kits, view, &described, place, span, entries, agent).await {
                    if let Some(reason) = reason {
                        add_to(&mut found, conflict(&place.0, reason));
                    }
                    continue;
                }
                let listed = lists.get(place).cloned().unwrap_or_default();
                for (id, reason) in covering(kits, view, place, span, &listed, entries, agent).await {
                    add_to(&mut found, conflict(&id, reason));
                }
            }
            if !windows.iter().all(exact) {
                // An object under the place now that others put there: created, moved, its
                // position changed, or (for a kit that marks no position) its index shifted.
                let mut selected = Vec::new();
                for (place, from, to, _) in windows.iter().filter(|w| !exact(w)) {
                    selected.extend(lists.get(place).into_iter().flatten().skip(*from).take(to - from).cloned());
                }
                selected.sort();
                selected.dedup();
                for id in &selected {
                    let created = named.get(id.as_str()).into_iter().flatten().any(|(list, _)| *list == "created");
                    let shifted = (!by_positions || under["within"].as_array().is_some_and(|windows| !windows.is_empty()))
                        && lists.iter().find_map(|(place, items)| items.iter().position(|item| item == id).map(|index| (place, index))).is_some_and(
                            |(place, index)| {
                                let mut index = index;
                                let mut shifted = false;
                                for (at, entry) in entries.iter().enumerate().rev() {
                                    let Some(edit) = edits[at].get(place) else { continue };
                                    match edit.backward(index) {
                                        Some(before) => {
                                            shifted |= by_others(entry) && before != index;
                                            index = before;
                                        }
                                        None => break,
                                    }
                                }
                                shifted
                            },
                        );
                    if created || moved_by_others(id) || shifted {
                        add_to(&mut found, conflict(id, "relocated"));
                    }
                }
            }
            // A window told by indexes alone (not by time, not an index spelling): an object
            // that was inside the window at `basis` and that others deleted, moved
            // away or moved along its list.
            for window in windows.iter().filter(|window| !exact(window)) {
                let (place, from, to, _) = window;
                let listed = lists.get(place).cloned().unwrap_or_default();
                let near = |index: Option<usize>| index.is_some_and(|index| (*from..*to).contains(&index));
                for (at, entry) in entries.iter().enumerate().filter(|(_, entry)| by_others(entry)) {
                    let Some(changes) = &entry.changes else { continue };
                    for (list, side, reason) in [("deleted", "at", "deleted"), ("moved", "from", "relocated")] {
                        for item in changes[list].as_array().into_iter().flatten() {
                            let Some((was, index)) = item.get(side).and_then(place_of_position) else { continue };
                            if was == *place
                                && near(to_basis(place, index, at))
                                && let Some(id) = item["id"].as_str()
                            {
                                add_to(&mut found, conflict(id, reason));
                            }
                        }
                    }
                    for item in changes["changed"].as_array().into_iter().flatten().filter(|item| positional(item)) {
                        let Some(id) = item["id"].as_str() else { continue };
                        if near(listed.iter().position(|listed| listed == id).and_then(|index| to_basis(place, index, entries.len()))) {
                            add_to(&mut found, conflict(id, "relocated"));
                        }
                    }
                }
            }
            // A place in a list named by the index spelling (`"#3"`): the object at that index at
            // `basis`, followed through every entry since, must be there still.
            // Where an object is now in the command's spelling (`"#2"`), when it is in `place`.
            let spelled = |place: &Place, id: &str| {
                let listed = lists.get(place)?;
                let at = listed.iter().position(|item| item == id)?;
                let number = if step.reversed { listed.len() - at } else { at + 1 };
                Some(format!("{}{number}", step.spelling.as_deref()?))
            };
            for (now_index, basis_index) in &stored {
                let Some(place) = windows.iter().find(|(_, from, _, _)| Some(*from) == *now_index).or(windows.first()).map(|(place, ..)| place.clone()) else {
                    continue;
                };
                let Some(basis_index) = basis_index else {
                    // It named nothing at `basis` (past the list's end, counted from its other
                    // end): refused when it names an object now that others' changes put in reach.
                    let others_here = entries.iter().enumerate().any(|(at, entry)| by_others(entry) && edits[at].contains_key(&place));
                    if let (true, Some(id)) = (others_here, now_index.and_then(|now| lists.get(&place)?.get(now).cloned())) {
                        add_to(&mut found, conflict(&id, "relocated"));
                    }
                    continue;
                };
                let mut now_at = *basis_index;
                let mut verdict: Option<(&'static str, Option<String>)> = None;
                let mut ended = false;
                for (at, entry) in entries.iter().enumerate() {
                    let Some(edit) = edits[at].get(&place) else { continue };
                    if let Some(after) = edit.forward(now_at) {
                        // Counted from the other end, a shift of its stored index is no move:
                        // where it ends is compared below.
                        if by_others(entry) && after != now_at && !step.reversed {
                            verdict.get_or_insert(("relocated", None));
                        }
                        now_at = after;
                        continue;
                    }
                    let item_at = |list: &str, side: &str| {
                        entry
                            .changes
                            .as_ref()
                            .and_then(|changes| changes[list].as_array())
                            .into_iter()
                            .flatten()
                            .find(|item| item.get(side).and_then(place_of_position).is_some_and(|(was, index)| was == place && index == now_at))
                    };
                    let gone = |item: &Value| item["id"].as_str().map(str::to_owned);
                    if let Some(item) = item_at("deleted", "at") {
                        if by_others(entry) {
                            verdict = Some(("deleted", gone(item)));
                        }
                        ended = true;
                        break;
                    }
                    match item_at("moved", "from") {
                        Some(item) => match item.get("to").and_then(place_of_position) {
                            Some((to_place, to)) if to_place == place => {
                                if by_others(entry) && !step.reversed {
                                    verdict.get_or_insert(("relocated", None));
                                }
                                now_at = to;
                            }
                            _ => {
                                if by_others(entry) {
                                    verdict = Some(("relocated", gone(item)));
                                }
                                ended = true;
                                break;
                            }
                        },
                        None => {
                            ended = true;
                            break;
                        }
                    }
                }
                // Counted from the other end: the object it named must be where the
                // index names now, after others' changes of the list.
                let others_here = || entries.iter().enumerate().any(|(at, entry)| by_others(entry) && edits[at].contains_key(&place));
                if step.reversed && verdict.is_none() && !ended && Some(now_at) != *now_index && others_here() {
                    verdict = Some(("relocated", None));
                }
                let Some((reason, gone)) = verdict else { continue };
                let id = gone.or_else(|| if ended { None } else { lists.get(&place).and_then(|listed| listed.get(now_at)).cloned() });
                match id {
                    Some(id) => {
                        let mut named = conflict(&id, reason);
                        if let (Some(now), Some(spelled)) = (named.now.as_mut(), spelled(&place, &id)) {
                            now["spelled"] = json!(spelled);
                        }
                        add_to(&mut found, named);
                    }
                    // The list cannot be read now: the place changed, and what it
                    // names cannot be said; refused, never dropped.
                    None if !ended && !lists.contains_key(&place) => {
                        let mut place = place_of.clone();
                        place["unknown"] = json!("the list this index counts in cannot be read: inspect again and name the object by id");
                        add_to(&mut found, Conflict { id: None, reason: "unknown", now: None, place: Some(place), ty: None, cause: Some(Unavailable::Place) });
                    }
                    None => {}
                }
            }
        }
    }
    // A target given by its name (`x-khp-name`): the name must name the object it named
    // at `basis`. Others' renames away from it, renames to it and objects created with it refuse
    // the write as `relocated`, naming the object and its name now.
    for (number, step) in premises.steps.iter().enumerate() {
        for (text, field, types) in &step.names {
            let of_type = |item: &Value| types.as_ref().is_none_or(|types| item["type"].as_str().is_some_and(|ty| types.iter().any(|wanted| wanted == ty)));
            let by_id = others.iter().any(|entry| entry.changes.as_ref().is_some_and(|changes| changes["$renamed"].get(text).is_some()))
                || match named.get(text.as_str()) {
                    Some(changes) => {
                        (changes.iter().any(|(list, _)| *list == "deleted") || !changes.iter().any(|(list, _)| *list == "created"))
                            && changes.iter().any(|(_, item)| of_type(item))
                    }
                    None => view
                        .load(kits, json!([{ "target": text, "fields": [] }]))
                        .await
                        .is_some_and(|answer| answer["loaded"][0]["id"].as_str().is_some_and(|id| !id.is_empty()) && of_type(&answer["loaded"][0])),
                };
            if by_id {
                continue;
            }
            targets.remove(text);
            let wanted = Value::String(text.clone());
            let mut place = json!({ "name": text, "command": step.ask.command });
            if let Some(answer) = answers[number].as_ref() {
                place["under"] = answer["objects"].clone();
            }
            for entry in &others {
                let Some(changes) = &entry.changes else { continue };
                for item in changes["changed"].as_array().into_iter().flatten().filter(|item| of_type(item)) {
                    let Some(id) = id_text(&item["id"]) else { continue };
                    for edit in item["edits"].as_array().into_iter().flatten().filter(|edit| edit["field"] == field.as_str()) {
                        if (edit["before"] == wanted) != (edit["after"] == wanted) {
                            let now = json!({ field.as_str(): edit["after"].clone() });
                            add_to(
                                &mut found,
                                Conflict { id: Some(id.clone()), reason: "relocated", now: Some(now), place: Some(place.clone()), ty: None, cause: None },
                            );
                        }
                    }
                    if !item["edits"].as_array().into_iter().flatten().any(|edit| edit["field"] == field.as_str())
                        && view.object(kits, &id).await.is_some_and(|object| object["fields"][field] == wanted)
                    {
                        targets.entry(id).or_insert_with(Need::all);
                    }
                }
                for item in changes["created"].as_array().into_iter().flatten().filter(|item| of_type(item) && item["values"][field.as_str()] == wanted) {
                    if let Some(id) = id_text(&item["id"]) {
                        add_to(&mut found, Conflict { id: Some(id), reason: "relocated", now: None, place: Some(place.clone()), ty: None, cause: None });
                    }
                }
                for item in changes["deleted"].as_array().into_iter().flatten().filter(|item| of_type(item) && item["$was"][field.as_str()] == wanted) {
                    if let Some(id) = id_text(&item["id"]) {
                        add_to(&mut found, Conflict { id: Some(id), reason: "deleted", now: None, place: Some(place.clone()), ty: None, cause: None });
                    }
                }
            }
        }
    }
    // The type of each target, read in one load: a target of a type with tool ids is named by its
    // tool id (no path leads to it), and one whose type holds no object with a tool id has no
    // such object's change inside it.
    let mut type_of: HashMap<String, String> = HashMap::new();
    if described.is_known() && !targets.is_empty() {
        let ids: Vec<&String> =
            targets.keys().filter(|id| !named.get(id.as_str()).is_some_and(|changes| changes.iter().any(|(list, _)| *list == "deleted"))).collect();
        let load = Value::Array(ids.iter().map(|id| json!({ "target": id, "fields": [] })).collect());
        if let Some(answer) = view.load(kits, load).await {
            for (id, loaded) in ids.iter().zip(answer["loaded"].as_array().into_iter().flatten()) {
                if let Some(ty) = loaded["type"].as_str() {
                    type_of.insert((*id).clone(), ty.to_owned());
                }
            }
        }
    }
    let tool_named = |id: &str| type_of.get(id).is_some_and(|ty| described.has_tool_id(ty));
    let may_hold = |id: &str| type_of.get(id).is_none_or(|ty| described.may_hold_tool_ids(ty));
    let mut held_cache: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut follow_cache: HashMap<(String, String), Option<Vec<String>>> = HashMap::new();
    for (id, need) in &targets {
        if let Some(now) = others.iter().find_map(|entry| entry.changes.as_ref()?.get("$renamed")?.get(id)?.as_str()) {
            add_to(&mut found, Conflict { id: Some(id.clone()), reason: "relocated", now: Some(json!({"id":now})), place: None, ty: None, cause: None });
            continue;
        }
        let mut need = need.clone();
        let facts = type_of.get(id).and_then(|ty| described.0.as_ref()?.get("types")?.get(ty)?.get("derived")?.as_object());
        for (name, _) in facts
            .into_iter()
            .flatten()
            .filter(|(name, fact)| {
                fact["onDemand"] == true && need.fields.as_ref().is_none_or(|fields| fields.iter().any(|field| overlaps(field, &format!("~{name}"))))
            })
            .collect::<Vec<_>>()
        {
            let field = format!("~{name}");
            if let Some(fields) = &mut need.fields {
                fields.retain(|held| !overlaps(held, &field));
            }
            if named.get(id.as_str()).is_some_and(|changes| changes.iter().any(|(list, _)| *list == "deleted")) {
                continue;
            }
            let changed = if let Some(before) = basis_model {
                let mut params = Map::from_iter([
                    ("id".into(), json!(id)),
                    ("field".into(), json!(field)),
                    ("region".into(), Value::Null),
                    ("before".into(), before.clone()),
                ]);
                if let Ok(token) = super::history::TOKEN.try_with(Clone::clone) {
                    params.insert("history".into(), json!(token));
                }
                view.context(kits, "content", params).await.ok().flatten().and_then(|answer| answer["changed"].as_bool())
            } else {
                None
            };
            if changed != Some(false) {
                add_to(
                    &mut found,
                    Conflict::of(Some(id.clone()), if changed == Some(true) { "changed" } else { "unknown" }, None).because(if basis_model.is_none() {
                        Unavailable::FactBasis
                    } else {
                        Unavailable::Fact
                    }),
                );
            }
        }
        let need = &need;
        if need.fields.as_ref().is_some_and(|fields| fields.iter().any(|field| field.starts_with(super::derived::MARK)))
            && others.iter().any(|entry| entry.changes.as_ref().is_some_and(|changes| !super::derived::told(changes) && !is_nothing(changes)))
        {
            add_to(&mut found, Conflict::of(Some(id.clone()), "unknown", None).because(Unavailable::Fact));
            continue;
        }
        // A conflict found for it by its place already says it, with the place.
        if found.contains_key(id) {
            continue;
        }
        let place_of = placed.get(id).map(|place| {
            let mut named = premises.places[*place].named.clone();
            named["under"] = answers[premises.places[*place].step].as_ref().map_or(Value::Null, |answer| answer["objects"].clone());
            named
        });
        let with_place = |mut conflict: Conflict| {
            conflict.place = place_of.clone();
            conflict
        };
        // Its tool id was moved between objects by another program: it may name another object
        // now, and what changed in it is not known.
        if renumbered.contains(id) {
            add_to(&mut found, Conflict::of(Some(id.clone()), "unknown", None).because(Unavailable::Renumbered));
            continue;
        }
        if named
            .get(id.as_str())
            .into_iter()
            .flatten()
            .any(|(kind, change)| *kind == "changed" && change["fields"].as_array().is_some_and(|fields| fields.iter().any(|field| field == "$type")))
        {
            add_to(&mut found, with_place(Conflict::of(Some(id.clone()), "unknown", None).because(Unavailable::Type)));
            continue;
        }
        let in_list = |list: &str| others.iter().any(|entry| entry.changes.as_ref().and_then(|changes| listed(changes, list, id)).is_some());
        if in_list("deleted") {
            add_to(&mut found, with_place(Conflict::of(Some(id.clone()), "deleted", None)));
            continue;
        }
        if in_list("created") {
            add_to(&mut found, with_place(Conflict::of(Some(id.clone()), "relocated", None)));
            continue;
        }
        let here = position(id);
        let now_at = here.as_ref().map(|(place, index)| at(place, *index));
        let now_at = match now_at {
            Some(now) => Some(placed_now(id, now)),
            None => Some(placed_now(id, json!({}))).filter(|now| now.as_object().is_some_and(|now| !now.is_empty())),
        };
        // Its index in its list matters when the step depends on every position, or names that
        // list (`clips`, `comp.layers`) among them.
        let list_field = here.as_ref().map(|(place, _)| place.1.clone()).or_else(|| {
            named
                .get(id.as_str())
                .into_iter()
                .flatten()
                .find(|(list, _)| *list == "moved")
                .and_then(|(_, moved)| moved.get("from").and_then(place_of_position))
                .map(|(place, _)| place.1)
        });
        let list_matters = list_field.as_deref().map_or(need.positions.is_none(), |field| need.position(field));
        if moved_for(id, need, list_matters) {
            add_to(&mut found, with_place(Conflict::of(Some(id.clone()), "relocated", now_at)));
            continue;
        }
        // An index others shifted, followed back from now through every entry since `basis`.
        if let Some((place, index)) = here.as_ref().filter(|_| list_matters) {
            let mut index = *index;
            let mut shifted = false;
            for entry in entries.iter().rev() {
                let Some(changes) = &entry.changes else { break };
                if listed(changes, "created", id).is_some() {
                    break;
                }
                let edits = list_edits(changes);
                let Some(edit) = edits.get(place) else { continue };
                match edit.backward(index) {
                    Some(before) => {
                        shifted |= by_others(entry) && before != index;
                        index = before;
                    }
                    None => break,
                }
            }
            if shifted {
                add_to(&mut found, with_place(Conflict::of(Some(id.clone()), "relocated", now_at)));
                continue;
            }
        }
        // An object holding it moved (through the schema's ownership): where it is changed, as
        // far as the step depends on any position.
        // Only an object whose type may hold objects with tool ids can hold a target named by its
        // tool id.
        let holders: Vec<&str> = others
            .iter()
            .filter_map(|entry| entry.changes.as_ref())
            .flat_map(|changes| changes["moved"].as_array().into_iter().flatten())
            .filter(|moved| !tool_named(id) || moved["type"].as_str().is_none_or(|ty| described.may_hold_tool_ids(ty)))
            .filter_map(|moved| moved["id"].as_str())
            .filter(|holder| *holder != id)
            .collect();
        if need.any_position() && !holders.is_empty() {
            let mut moved_holder = false;
            for holder in holders {
                if !held_cache.contains_key(holder) {
                    let held = held_by(kits, view, &described, holder, &mut budget).await;
                    held_cache.insert(holder.to_owned(), held);
                }
                if held_cache.get(holder).is_some_and(|held| held.contains_key(id)) {
                    moved_holder = true;
                    break;
                }
            }
            if moved_holder {
                add_to(&mut found, with_place(Conflict::of(Some(id.clone()), "relocated", now_at)));
                continue;
            }
        }
        // A premise naming list items by a member (`keys[time=2]`): replayed through
        // every entry since `basis` from the list as it is now ([`super::selector`]).
        let (selectors, plain): (Vec<super::selector::Selector>, Option<BTreeSet<String>>) = match &need.fields {
            Some(fields) => {
                let selectors: Vec<super::selector::Selector> = fields.iter().filter_map(|field| super::selector::Selector::parse(field)).collect();
                (selectors, Some(fields.iter().filter(|field| super::selector::Selector::parse(field).is_none()).cloned().collect()))
            }
            None => (Vec::new(), None),
        };
        let mut by_selector = None;
        for selector in &selectors {
            let normalized;
            let mut all: Vec<&Entry> = entries.iter().collect();
            let list = super::selector::positional(selector, &all, id);
            let wanted = list.clone().unwrap_or_else(|| selector.list.clone());
            if let Some(list) = &list {
                let root = root_field(list);
                if let Some(object) = view.object(kits, id).await
                    && described.field(object["type"].as_str().unwrap_or_default(), root).is_some_and(|def| def["kind"] == "json")
                    && let Some(value) = list.split('.').try_fold(&object["fields"], |at, key| match key.parse::<usize>() {
                        Ok(i) => at.get(i),
                        Err(_) => at.get(key),
                    })
                    && value.is_array()
                {
                    normalized = super::selector::whole_entries(list, value, entries, id);
                    all = normalized.iter().collect();
                }
            }
            if !super::selector::others_touch(&all, id, &wanted, agent) {
                // The kit's words, not followed to a path: an edit by others with no words of the
                // kit's under the object may be in the list.
                let unnamed = list.is_none()
                    && others.iter().filter_map(|entry| entry.changes.as_ref()).any(|changes| {
                        listed(changes, "changed", id).is_some_and(|change| {
                            let last = selector.list.rsplit(['.', '/']).next().unwrap_or_default();
                            change["edits"].as_array().into_iter().flatten().any(|edit| {
                                edit.get("named").is_none() && edit["field"].as_str().is_some_and(|field| field.split('.').any(|segment| segment == last))
                            })
                        })
                    });
                if unnamed {
                    by_selector = Some((if need.identities.contains_key(&selector.path) { "unknown" } else { "changed" }, selector));
                    break;
                }
                continue;
            }
            let now = match &list {
                Some(list) => list_members(kits, view, &described, id, list, &selector.member).await,
                None => None,
            };
            let reason = match need.identities.get(&selector.path) {
                Some(keys) if keys.len() == 1 => {
                    let key = keys.first().map(String::as_str).unwrap_or_default();
                    let identities = match &list {
                        Some(list) => list_members(kits, view, &described, id, list, key).await,
                        None => None,
                    };
                    super::selector::named_reason(selector, key, &wanted, now, identities, &all, id, agent, described.0.as_ref())
                }
                Some(_) => Some("unknown"),
                None => super::selector::touched(selector, &wanted, now, &all, id, agent, described.0.as_ref()).then_some("changed"),
            };
            if let Some(reason) = reason {
                by_selector = Some((reason, selector));
                break;
            }
        }
        if let Some((reason, selector)) = by_selector {
            let mut conflict = with_place(Conflict::of(Some(id.clone()), reason, None).because(Unavailable::Selector));
            if need.identities.contains_key(&selector.path) {
                conflict.place.get_or_insert_with(|| json!({}))["selector"] = json!(selector.path);
            }
            add_to(&mut found, conflict);
            continue;
        }
        let mut plain = plain;
        let mut indexed_conflict = None;
        if let Some(fields) = &mut plain {
            for path in fields.clone() {
                let Some(keys) = need.identities.get(&path) else { continue };
                let Some(indexed) = super::selector::Indexed::parse(&path) else { continue };
                let object = view.object(kits, id).await;
                let now = object.as_ref().and_then(|object| super::selector::value_at(&object["fields"], &indexed.list)).cloned();
                let reason = if keys.len() == 1 { indexed.reason(keys.first().unwrap(), now, entries, id, agent) } else { Some("unknown") };
                fields.remove(&path);
                if let Some(reason) = reason {
                    if indexed_conflict.is_none() || reason == "relocated" {
                        indexed_conflict = Some(reason);
                    }
                    if reason == "relocated" {
                        break;
                    }
                }
            }
        }
        if let Some(reason) = indexed_conflict {
            add_to(&mut found, with_place(Conflict::of(Some(id.clone()), reason, None)));
            continue;
        }
        let need = &Need { fields: plain.clone(), ..need.clone() };
        // Changed: the target's own fields, or the fields of what it holds, which change sets
        // name under it (`body.paragraphs.0.text`); a position field is no content.
        let hits = |change: &Value| {
            let ty = change["type"].as_str().unwrap_or_default();
            let skip = |field: &str| described.position(ty, field);
            let derived = need.fields.as_ref().is_some_and(|fields| fields.iter().any(|field| field.starts_with(super::derived::MARK)));
            if derived && untold.contains(id.as_str()) && change["fields"].as_array().is_some_and(|fields| !fields.is_empty()) {
                return true;
            }
            match &need.fields {
                None => change["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).any(|field| !skip(field)),
                Some(fields) => touches_any(change, fields, &skip, &|field: &str| described.leads_into_held(ty, field)),
            }
        };
        if named.get(id.as_str()).into_iter().flatten().any(|(list, change)| *list == "changed" && hits(change)) {
            add_to(&mut found, with_place(Conflict::of(Some(id.clone()), "changed", None)));
            continue;
        }
        // An object with a tool id of its own the target holds (a text body with an id inside a
        // shape): its change is the target's, through the field it is held by. What holds what is
        // the schema's to say: without the kit's description, nothing is taken as held.
        let inside: Vec<&str> = named.keys().copied().filter(|other| *other != id).collect();
        if !inside.is_empty() && described.is_known() && need.fields.as_ref().is_none_or(|fields| !fields.is_empty()) && may_hold(id) {
            if !held_cache.contains_key(id) {
                let held = held_by(kits, view, &described, id, &mut budget).await;
                held_cache.insert(id.clone(), held);
            }
            let held = held_cache.get(id).cloned().unwrap_or_default();
            // At its path under the target: a premise on another path (`sequence.markers.0` beside
            // a clip at `sequence.videoTracks.0.items.3`) is not touched; one in the kit's words
            // (`transform/opacity`) cannot be compared with a path and is.
            let changed = inside.iter().any(|other| {
                held.get(*other).is_some_and(|through| {
                    named[*other].iter().any(|(list, change)| match &need.fields {
                        None => true,
                        Some(fields) if *list != "changed" => fields.iter().any(|field| overlaps(through, field) || field.contains(['/', '#'])),
                        Some(fields) => {
                            let ty = change["type"].as_str().unwrap_or_default();
                            let mut under = (*change).clone();
                            under["fields"] = json!(
                                change["fields"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter_map(Value::as_str)
                                    .filter(|field| !described.position(ty, field))
                                    .map(|field| format!("{through}.{field}"))
                                    .collect::<Vec<_>>()
                            );
                            for edit in under["edits"].as_array_mut().into_iter().flatten() {
                                if let Some(field) = edit["field"].as_str() {
                                    edit["field"] = json!(format!("{through}.{field}"));
                                }
                            }
                            touches_any(&under, fields, &|_| false, &|_| true)
                        }
                    })
                })
            });
            if changed {
                add_to(&mut found, with_place(Conflict::of(Some(id.clone()), "changed", None)));
                continue;
            }
        }
        // A command's journal entry can name a raw object only through its holder's path.
        // A reread retains an exhaustive id-based diff in $objects instead: absence there
        // means unchanged, and following an old numeric path in today's list is unsound.
        if !named.contains_key(id.as_str()) && described.is_known() && !tool_named(id) && need.fields.as_ref().is_none_or(|fields| !fields.is_empty()) {
            'paths: for changes in others.iter().filter_map(|entry| entry.changes.as_ref()).filter(|changes| !changes["$objects"]["changed"].is_array()) {
                for change in changes["changed"].as_array().into_iter().flatten() {
                    let Some(holder) = change["id"].as_str() else { continue };
                    for path in change["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|path| path.contains('.')) {
                        let (object, field) = match path.rsplit_once('.') {
                            Some((object, last)) if last.parse::<usize>().is_err() => (object, Some(last)),
                            _ => (path, None),
                        };
                        let key = (holder.to_owned(), object.to_owned());
                        if !follow_cache.contains_key(&key) {
                            let reached = follow(kits, view, holder, object, &mut budget).await;
                            follow_cache.insert(key.clone(), reached);
                        }
                        let Some(reached) = follow_cache.get(&key).cloned().flatten() else { continue };
                        let wanted = match (&need.fields, field) {
                            (None, _) | (_, None) => true,
                            (Some(fields), Some(field)) => fields.contains(field),
                        };
                        if wanted && reached.as_slice() == [id.clone()] {
                            add_to(&mut found, with_place(Conflict::of(Some(id.clone()), "changed", None)));
                            break 'paths;
                        }
                    }
                }
            }
        }
    }
    for (noun, part) in &premises.named {
        let Some((_, prefix)) = described.part_type(noun) else { continue };
        let id = format!("{prefix}{part}");
        if others.iter().any(|entry| entry.changes.as_ref().and_then(|changes| listed(changes, "deleted", &id)).is_some()) {
            add_to(&mut found, Conflict::of(Some(id), "deleted", None));
        }
    }
    // The parts addressed by number, each with its tool id now when others neither relocated nor
    // deleted it.
    let mut numbered_ids: BTreeMap<(String, u64), String> = BTreeMap::new();
    if !premises.numbered.is_empty() {
        let root = view.object(kits, "root").await.and_then(|root| root["id"].as_str().map(str::to_owned));
        // The root's ids: now, and before each read of the file again (a kit may mint the root a
        // new object id on every read), so an entry from before a read finds the parts' list.
        let mut roots: BTreeSet<String> = entries
            .iter()
            .filter_map(|entry| entry.changes.as_ref())
            .flat_map(|changes| changes["roots"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned))
            .collect();
        roots.extend(root.clone());
        for (noun, number) in &premises.numbered {
            // The list holding the parts: the root's list of the type whose tool id carries the
            // noun (never a list whose items merely start like it).
            let Some((ty, _)) = described.part_type(noun) else { continue };
            let (Some(root), Some(field)) = (root.clone(), described.parts_field(&ty)) else { continue };
            let parts: Place = (root, field);
            let in_parts = |place: &Place| place.1 == parts.1 && roots.contains(&place.0);
            let at_index =
                |item: &Value, side: &str, index: usize| item.get(side).and_then(place_of_position).is_some_and(|(place, at)| in_parts(&place) && at == index);
            let Some(start) = usize::try_from(*number).ok().and_then(|number| number.checked_sub(1)) else { continue };
            let mut index = start;
            let mut verdict: Option<&'static str> = None;
            let mut gone: Option<String> = None;
            for entry in entries {
                let Some(changes) = &entry.changes else { break };
                let edits = list_edits(changes);
                let Some(edit) = edits.iter().find(|(place, _)| in_parts(place)).map(|(_, edit)| edit) else { continue };
                match edit.forward(index) {
                    Some(after) => {
                        if by_others(entry) && after != index {
                            verdict = verdict.or(Some("relocated"));
                        }
                        index = after;
                    }
                    None => {
                        let deleted = changes["deleted"].as_array().into_iter().flatten().find(|item| at_index(item, "at", index));
                        let moved = changes["moved"].as_array().into_iter().flatten().find(|item| at_index(item, "from", index));
                        match (deleted, moved) {
                            (Some(item), _) => {
                                if by_others(entry) {
                                    verdict = Some("deleted");
                                    gone = item["id"].as_str().map(str::to_owned);
                                }
                                break;
                            }
                            (None, Some(item)) => match item.get("to").and_then(place_of_position) {
                                Some((place, to)) if in_parts(&place) => {
                                    if by_others(entry) {
                                        verdict = verdict.or(Some("relocated"));
                                    }
                                    index = to;
                                }
                                _ => break,
                            },
                            (None, None) => break,
                        }
                    }
                }
            }
            let Some(reason) = verdict else {
                let listed = match now.get(&parts) {
                    Some(listed) => listed.get(index).cloned(),
                    None => items(kits, view, &parts).await.and_then(|listed| listed.get(index).cloned()),
                };
                if let Some(id) = listed {
                    numbered_ids.insert((noun.clone(), *number), id);
                }
                continue;
            };
            // The part by its tool id: the one deleted, or the one the number named, now at `index`.
            let id = match gone {
                Some(id) => Some(id),
                None => match now.get(&parts) {
                    Some(listed) => listed.get(index).cloned(),
                    None => items(kits, view, &parts).await.and_then(|listed| listed.get(index).cloned()),
                },
            };
            let now = (reason != "deleted").then(|| json!({ noun.as_str(): index + 1 }));
            add_to(&mut found, Conflict::of(id, reason, now));
        }
    }
    // A step that names no object acts on its part: others' changes of the part's own fields
    // (not its position fields, not its lists of objects, not the objects with tool ids it holds)
    // refuse it.
    for step in &premises.part_steps {
        if step.mentioned.iter().any(|text| resolved.contains(text)) {
            continue;
        }
        let id = match &step.part {
            PartRef::Named(noun, part) => described.part_type(noun).map(|(_, prefix)| format!("{prefix}{part}")),
            PartRef::Numbered(noun, number) => numbered_ids.get(&(noun.clone(), *number)).cloned(),
        };
        let Some(id) = id else { continue };
        let own = |change: &Value| {
            let ty = change["type"].as_str().unwrap_or_default();
            change["fields"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|field| !described.position(ty, field) && !described.holds_objects(ty, field))
        };
        if named.get(id.as_str()).into_iter().flatten().any(|(list, change)| *list == "changed" && own(change)) {
            add_to(&mut found, Conflict::of(Some(id), "changed", None));
        }
    }
    if others
        .iter()
        .any(|entry| entry.author == super::journal::OUTSIDE && entry.changes.as_ref().is_none_or(|changes| changes.get("externalInputs").is_none()))
    {
        let mut objects: BTreeSet<_> = targets.keys().cloned().collect();
        objects.extend(resolved.iter().cloned());
        objects.extend(numbered_ids.values().cloned());
        let objects: Vec<Value> = objects.into_iter().map(Value::String).collect();
        if !objects.is_empty() {
            let mut unproven = match view.context(kits, "identity", Map::from_iter([("objects".into(), json!(objects))])).await {
                Ok(None) => Vec::new(),
                Ok(Some(answer)) => answer["unproven"].as_array().cloned().unwrap_or_else(|| objects.clone()),
                Err(_) => objects.clone(),
            };
            unproven.extend(
                others.iter().filter_map(|entry| entry.changes.as_ref()).flat_map(|changes| changes["$identity"].as_array().into_iter().flatten()).cloned(),
            );
            for id in unproven.iter().filter(|id| objects.contains(id)).filter_map(id_text) {
                found.insert(id.clone(), Conflict::of(Some(id), "unknown", None).because(Unavailable::Identity));
            }
        }
    }
    let mut found: Vec<Conflict> = found.into_values().collect();
    // Each object's type, from others' change sets or the read of the targets.
    for conflict in &mut found {
        let Some(id) = conflict.id.as_deref() else { continue };
        let told = named.get(id).into_iter().flatten().find_map(|(_, change)| change["type"].as_str().map(str::to_owned));
        conflict.ty = told.or_else(|| type_of.get(id).cloned());
    }
    with_positions_now(kits, view, &mut found).await;
    found
}

pub(crate) async fn unproven_identities(kits: &KitManager, document: &DocumentView, objects: &[Value]) -> Vec<Value> {
    let params = Map::from_iter([("objects".into(), json!(objects))]);
    match kits.context(Caller::Agent, document.kit_id, &document.document_id, "context.identity", params).await {
        Ok(None) => Vec::new(),
        Ok(Some(answer)) => answer["unproven"].as_array().cloned().unwrap_or_else(|| objects.to_vec()),
        Err(_) => objects.to_vec(),
    }
}

/// Each conflict's `now` with its position fields' values as the document has them now, read in
/// one load: a change set may tell a field at a leaf (`location.0`) or without its value.
async fn with_positions_now(kits: &KitManager, view: Reader<'_>, found: &mut [Conflict]) {
    let fields_of = |now: &Value| -> Vec<String> {
        let mut fields: Vec<String> =
            now.as_object().into_iter().flatten().map(|(key, _)| key.clone()).filter(|key| !LIST_PLACE.contains(&key.as_str()) && key != "fields").collect();
        fields.extend(now["fields"].as_object().into_iter().flatten().map(|(key, _)| key.clone()));
        fields
    };
    let wanted: Vec<(usize, String, Vec<String>)> = found
        .iter()
        .enumerate()
        .filter_map(|(at, conflict)| {
            let fields = fields_of(conflict.now.as_ref()?);
            Some((at, conflict.id.clone()?, fields)).filter(|(_, _, fields)| !fields.is_empty())
        })
        .collect();
    if wanted.is_empty() {
        return;
    }
    let load = Value::Array(wanted.iter().map(|(_, id, fields)| json!({ "target": id, "fields": fields })).collect());
    let Some(answer) = view.load(kits, load).await else { return };
    for ((at, _, fields), loaded) in wanted.iter().zip(answer["loaded"].as_array().into_iter().flatten()) {
        let Some(now) = found[*at].now.as_mut() else { continue };
        for field in fields {
            let Some(value) = loaded["fields"].get(field) else { continue };
            if LIST_PLACE.contains(&field.as_str()) {
                now["fields"][field] = value.clone();
            } else {
                now[field] = value.clone();
            }
        }
    }
}

/// The change set of the entries `others` (oldest first), merged as one: each object once, a
/// changed field's `before` from the first change and `after` from the last; an object others
/// created and then deleted is in neither list; the counts of objects no tool id names
/// (`unnamed`, by type and list) added up; the ids another program renumbered in one line
/// (`renumbered`). Capped as receipts are, what the agent must see first kept first (`first`,
/// [`Told`]); `by` names the authors. A shift of many objects is stated once (`footprint`), read
/// with the lists `source` holds now, and integer tool ids are numbers ([`receipts::IdForm`]).
///
/// A created object is told by its id, type, where it was put (`at`), its fields' names, and the
/// values of its naming fields ([`NAMING_FIELDS`]) and `position` fields: its other values only
/// for a call that asks for every change (`changes: "all"`, `full`).
pub(crate) async fn merged(
    kits: &KitManager,
    source: Option<receipts::Source<'_>>,
    described: Option<&Value>,
    others: &[&Entry],
    first: &Told,
    full: bool,
) -> Value {
    let mut set = merged_set(others);
    if !full {
        named_values_only(&mut set, described);
    }
    if let Some(source) = source {
        set = receipts::compacted(kits, source, &set).await;
    }
    set = receipts::capped_by(set, Some(receipts::DEFAULT_CAP), &|list, item| first.rank(list, item));
    receipts::IdForm::of(described).changes(&mut set);
    receipts::unrecorded(&mut set);
    set
}

/// The fields that name an object to a person, as kit-env reads labels: a created object's values
/// in `others` keep these (when strings) and its `position` fields.
const NAMING_FIELDS: [&str; 6] = ["name", "title", "label", "text", "caption", "kind"];

/// `set`'s created objects with only the values that name them and say where they are.
fn named_values_only(set: &mut Value, described: Option<&Value>) {
    for created in set.get_mut("created").and_then(Value::as_array_mut).into_iter().flatten() {
        let ty = created["type"].as_str().unwrap_or_default().to_owned();
        let Some(values) = created.get_mut("values").and_then(Value::as_object_mut) else { continue };
        let def = described.map(|described| &described["types"][ty.as_str()]["fields"]);
        values.retain(|field, value| {
            let position = def.is_some_and(|fields| fields[field.as_str()]["position"] == true);
            let naming = NAMING_FIELDS.contains(&field.as_str()) && (value.is_string() || value.is_number());
            position || naming
        });
        // Its fields by name, not every path into what it holds.
        if let Some(fields) = created.get("fields").and_then(Value::as_array) {
            let named: BTreeSet<String> = fields.iter().filter_map(Value::as_str).map(|field| field.split('.').next().unwrap_or(field).to_owned()).collect();
            created["fields"] = json!(named);
        }
    }
}

/// [`merged`]'s change set, object by object and whole.
fn merged_set(others: &[&Entry]) -> Value {
    let mut created: BTreeMap<String, Value> = BTreeMap::new();
    let mut changed: BTreeMap<String, Value> = BTreeMap::new();
    let mut moved: BTreeMap<String, Value> = BTreeMap::new();
    let mut deleted: BTreeMap<String, Value> = BTreeMap::new();
    let mut by: Vec<String> = Vec::new();
    let mut unnamed: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let mut renumbered: BTreeSet<String> = BTreeSet::new();
    for entry in others {
        if !by.contains(&entry.author) {
            by.push(entry.author.clone());
        }
        let Some(changes) = &entry.changes else { continue };
        renumbered.extend(renumbered_in(changes));
        for (ty, counts) in changes["unnamed"].as_object().into_iter().flatten() {
            for (list, count) in counts.as_object().into_iter().flatten() {
                *unnamed.entry(ty.clone()).or_default().entry(list.clone()).or_default() += count.as_u64().unwrap_or(0);
            }
        }
        let items = |list: &str| changes[list].as_array().cloned().unwrap_or_default();
        for item in items("created") {
            let id = item["id"].as_str().unwrap_or_default().to_owned();
            deleted.remove(&id);
            created.insert(id, item);
        }
        for item in items("changed") {
            let id = item["id"].as_str().unwrap_or_default().to_owned();
            match changed.get_mut(&id) {
                Some(was) => merge_change(was, &item),
                None => {
                    changed.insert(id, item);
                }
            }
        }
        for item in items("moved") {
            let id = item["id"].as_str().unwrap_or_default().to_owned();
            match moved.get_mut(&id) {
                Some(was) => was["to"] = item["to"].clone(),
                None => {
                    moved.insert(id, item);
                }
            }
        }
        for item in items("deleted") {
            let id = item["id"].as_str().unwrap_or_default().to_owned();
            changed.remove(&id);
            moved.remove(&id);
            if created.remove(&id).is_none() {
                deleted.insert(id, item);
            }
        }
    }
    let unknown = others.iter().any(|entry| entry.changes.is_none());
    let mut set = json!({
        "created": created.into_values().collect::<Vec<_>>(),
        "changed": changed.into_values().collect::<Vec<_>>(),
        "moved": moved.into_values().collect::<Vec<_>>(),
        "deleted": deleted.into_values().collect::<Vec<_>>(),
    });
    if !unnamed.is_empty() {
        set["unnamed"] = json!(unnamed);
    }
    if !renumbered.is_empty() {
        set["renumbered"] = json!(format!(
            "another program renumbered {}: each id may now name another object, and what changed in them is not known; inspect again before using them",
            renumbered.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }
    set["by"] = json!(by);
    if unknown {
        set["unknown"] = Value::Bool(true);
    }
    set
}

/// What `others` lists first when it lists fewer than changed (F5): parts created, deleted or moved
/// (objects whose tool id is a part's, `<noun>:<id>` for the kit's part nouns), then the objects a
/// pending write names, then the rest.
pub(crate) struct Told {
    /// The kit's part nouns (`agent.parts`, else `slide` and `page`).
    nouns: Vec<String>,
    /// Every string the pending write's input holds: the ids it names among them.
    named: BTreeSet<String>,
}

impl Told {
    pub(crate) fn new(nouns: Option<&[&str]>, input: &Value) -> Self {
        fn strings(value: &Value, out: &mut BTreeSet<String>) {
            match value {
                Value::String(text) => {
                    out.insert(text.clone());
                }
                Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
                Value::Object(entries) => entries.values().for_each(|item| strings(item, out)),
                _ => {}
            }
        }
        let mut named = BTreeSet::new();
        for key in ["steps", "ops", "target"] {
            if let Some(value) = input.get(key) {
                strings(value, &mut named);
            }
        }
        let nouns =
            nouns.map_or_else(|| DEFAULT_NOUNS.iter().map(|noun| (*noun).to_owned()).collect(), |nouns| nouns.iter().map(|noun| (*noun).to_owned()).collect());
        Self { nouns, named }
    }

    /// Whether `id` names a part: `<noun>:<id>`, the id holding no further `:` or `/`.
    fn is_part(&self, id: &str) -> bool {
        self.nouns.iter().any(|noun| {
            id.strip_prefix(noun.as_str()).and_then(|rest| rest.strip_prefix(':')).is_some_and(|rest| !rest.is_empty() && !rest.contains([':', '/']))
        })
    }

    fn rank(&self, list: &str, item: &Value) -> u8 {
        let id = item["id"].as_str().unwrap_or_default();
        if list != "changed" && self.is_part(id) {
            0
        } else if self.named.contains(id) {
            1
        } else {
            2
        }
    }
}

/// The tool ids an entry's change set says another program renumbered.
fn renumbered_in(changes: &Value) -> impl Iterator<Item = String> + '_ {
    changes["renumbered"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned)
}

/// Two changes of one object as one: the fields of both, each edit's `before` from the first.
fn merge_change(was: &mut Value, later: &Value) {
    let mut fields: BTreeSet<String> = was["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
    fields.extend(later["fields"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned));
    was["fields"] = json!(fields);
    let mut edits: Vec<Value> = was["edits"].as_array().cloned().unwrap_or_default();
    for edit in later["edits"].as_array().into_iter().flatten() {
        match edits.iter_mut().find(|known| known["field"] == edit["field"]) {
            Some(known) => {
                let spans = |edit: &Value| edit["spans"].as_array().cloned().unwrap_or_else(|| edit.get("span").cloned().into_iter().collect());
                let mut all = spans(known);
                let next = spans(edit);
                let incomplete = all.is_empty() || next.is_empty() || known["spansTruncated"] == true || edit["spansTruncated"] == true;
                all.extend(next);
                known["after"] = edit["after"].clone();
                if !all.is_empty() {
                    known.as_object_mut().unwrap().remove("span");
                    known["spans"] = json!(all);
                    if incomplete {
                        known["spansTruncated"] = json!(true);
                    }
                }
            }
            None => edits.push(edit.clone()),
        }
    }
    was["edits"] = json!(edits);
    // What the last change carries.
    if let Some(carries) = later.get("carries") {
        was["carries"] = carries.clone();
    }
}

/// The document's objects as the object model answers them (by the ids the tools use), from the
/// root through the fields that own objects (list and tree fields, refs declared `owns`): what a
/// change made outside is compared against. `None` for a kit without an object model. A document
/// of any size is read: what is kept of it afterwards is only the change set ([`compared`]).
pub(crate) async fn objects(kits: &KitManager, view: &DocumentView) -> Option<Map<String, Value>> {
    objects_from(kits, Reader::Kit(view)).await
}

pub(crate) async fn objects_from(kits: &KitManager, reader: Reader<'_>) -> Option<Map<String, Value>> {
    let described = Described(Some(reader.described(kits).await?));
    let mut found = Map::new();
    let inventory = reader.model(kits, "model.batch", json!({"origin":agent_origin(),"ops":[],"objects":true})).await?;
    let mut frontier: Vec<String> = inventory["objects"].as_array()?.iter().filter_map(|object| id_text(&object["id"])).collect();
    // Editor checkpoints have this bound; ordinary guard reads still use the editor's changes.
    if matches!(reader, Reader::Editor(_)) && frontier.len() > 20_000 {
        return None;
    }
    if !frontier.iter().any(|id| id == "root") {
        frontier.push("root".into());
    }
    // What owning maps name: candidates, read one by one when a read of them all fails.
    let mut candidates: Vec<String> = Vec::new();
    // Every id found or queued to be read (`frontier`, `candidates`): each is queued once.
    let mut queued: BTreeSet<String> = frontier.iter().cloned().collect();
    while !frontier.is_empty() || !candidates.is_empty() {
        let load: Vec<Value> = frontier.drain(..).map(|target| json!({ "target": target })).collect();
        let mut loaded: Vec<Value> = match load.is_empty() {
            true => Vec::new(),
            false => reader.load(kits, Value::Array(load)).await?["loaded"].as_array().cloned().unwrap_or_default(),
        };
        let maybe: Vec<Value> = candidates.drain(..).map(|target| json!({ "target": target })).collect();
        if !maybe.is_empty() {
            match reader.load(kits, Value::Array(maybe.clone())).await {
                Some(answer) => loaded.extend(answer["loaded"].as_array().cloned().unwrap_or_default()),
                None => {
                    for one in maybe {
                        if let Some(answer) = reader.load(kits, json!([one])).await {
                            loaded.extend(answer["loaded"].as_array().cloned().unwrap_or_default());
                        }
                    }
                }
            }
        }
        for object in &loaded {
            let id = object["id"].as_str()?.to_owned();
            let ty = object["type"].as_str().unwrap_or_default();
            let mut state = object["fields"].as_object().cloned().unwrap_or_default();
            for (field, value) in &state {
                if !described.owning(ty, field, value) {
                    continue;
                }
                let next = if value.is_object() { &mut candidates } else { &mut frontier };
                for held in held_ids(value) {
                    if held != id && !found.contains_key(&held) && queued.insert(held.clone()) {
                        next.push(held);
                    }
                }
            }
            // A tree as the canonical state holds it (`[{ object, children }]`), so that the
            // change set of two reads tells where a node is.
            for (field, value) in state.iter_mut() {
                if described.field(ty, field).is_some_and(|def| def["kind"] == "tree") && is_flat_tree(value) {
                    *value = nested_tree(value, None);
                }
            }
            state.insert("$type".into(), object["type"].clone());
            queued.insert(id.clone());
            found.insert(id, Value::Object(state));
        }
        frontier.retain(|id| !found.contains_key(id));
        candidates.retain(|id| !found.contains_key(id));
    }
    named_inside(kits, reader, &described, &mut found).await;
    // Derived values as `~<name>` fields, so two reads compare them too.
    if !super::derived::declared(described.0.as_ref()).is_empty() {
        match reader {
            Reader::Kit(view) => {
                let version = reader.model(kits, "model.version", json!({})).await;
                let version = version.as_ref().and_then(|answer| answer["version"].as_str());
                super::derived::into_objects(kits, view.kit_id, &view.document_id, described.0.as_ref(), version, &mut found).await;
            }
            Reader::Editor(_) | Reader::Plan { .. } => {
                let names: BTreeSet<_> = super::derived::declared(described.0.as_ref()).into_values().flatten().collect();
                let answer = reader.context(kits, "derived", Map::from_iter([("names".into(), json!(names))])).await.ok()??;
                for object in answer["objects"].as_array()? {
                    let id = id_text(&object["id"])?;
                    let state = found.get_mut(&id)?.as_object_mut()?;
                    for (name, value) in object["values"].as_object()? {
                        state.insert(format!("~{name}"), value.clone());
                    }
                }
                let declared = super::derived::declared(described.0.as_ref());
                if found.values().any(|object| {
                    object["$type"]
                        .as_str()
                        .and_then(|ty| declared.get(ty))
                        .is_some_and(|names| names.iter().any(|name| object.get(format!("~{name}")).is_none()))
                }) {
                    return None;
                }
            }
        }
    }
    Some(found)
}

/// A tree as a load answers it (`[{ object, parent }]`, pre-order) as the canonical state holds
/// it: the nodes under `parent`, each `{ object, children }`.
fn nested_tree(flat: &Value, parent: Option<&str>) -> Value {
    Value::Array(
        tree_children(flat, parent)
            .into_iter()
            .map(|object| {
                let children = nested_tree(flat, Some(&object));
                json!({ "object": object, "children": children })
            })
            .collect(),
    )
}

/// Whether `text` has the form of an object id kition-kdm mints (a UUID: 8-4-4-4-12 hex digits).
fn minted_form(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5 && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, length)| group.len() == length && group.chars().all(|c| c.is_ascii_hexdigit()))
}

/// The strings in `value` and in its objects' keys (and their `:`-separated segments).
fn strings_in(value: &Value, out: &mut BTreeSet<String>) {
    match value {
        Value::String(text) => {
            out.insert(text.clone());
        }
        Value::Array(items) => items.iter().for_each(|item| strings_in(item, out)),
        Value::Object(entries) => {
            for (key, item) in entries {
                out.insert(key.clone());
                out.extend(key.split(':').map(str::to_owned));
                strings_in(item, out);
            }
        }
        _ => {}
    }
}

/// `value` with each string, key and key segment `names` maps replaced.
fn renamed_inside(value: &Value, names: &HashMap<String, String>) -> Value {
    let key = |key: &str| match names.get(key) {
        Some(name) => name.clone(),
        None if key.contains(':') => key.split(':').map(|segment| names.get(segment).map_or(segment, String::as_str)).collect::<Vec<_>>().join(":"),
        None => key.to_owned(),
    };
    match value {
        Value::String(text) => Value::String(names.get(text).cloned().unwrap_or_else(|| text.clone())),
        Value::Array(items) => Value::Array(items.iter().map(|item| renamed_inside(item, names)).collect()),
        Value::Object(entries) => Value::Object(entries.iter().map(|(name, item)| (key(name), renamed_inside(item, names))).collect()),
        other => other.clone(),
    }
}

/// Loads answer the ids in refs, lists and trees by tool ids, but the ids inside json values and
/// maps as the kit stored them: an object with a tool id named there by its object id (a
/// connector's `look.kind.start`, minted again on every read of the file) would read as changed
/// across a read. Each string there of the form of a minted object id that names no object of the
/// read is asked of the kit (a load of no fields answers the object's tool id), and replaced by
/// the tool id it answers, so both reads name it alike.
async fn named_inside(kits: &KitManager, reader: Reader<'_>, described: &Described, found: &mut Map<String, Value>) {
    let mut wanted: BTreeSet<String> = BTreeSet::new();
    for object in found.values() {
        let ty = object["$type"].as_str().unwrap_or_default();
        for (field, value) in object.as_object().into_iter().flatten() {
            let kind = described.field(ty, field).and_then(|def| def["kind"].as_str()).unwrap_or_default();
            if matches!(kind, "json" | "map") {
                strings_in(value, &mut wanted);
            }
        }
    }
    wanted.retain(|text| minted_form(text) && !found.contains_key(text));
    if wanted.is_empty() {
        return;
    }
    let mut names: HashMap<String, String> = HashMap::new();
    let mut learn = |asked: &[String], answer: &Value| {
        for (raw, loaded) in asked.iter().zip(answer["loaded"].as_array().into_iter().flatten()) {
            if let Some(id) = loaded["id"].as_str().filter(|id| *id != raw) {
                names.insert(raw.clone(), id.to_owned());
            }
        }
    };
    let asked: Vec<String> = wanted.into_iter().collect();
    let load = |ids: &[String]| Value::Array(ids.iter().map(|id| json!({ "target": id, "fields": [] })).collect());
    match reader.load(kits, load(&asked)).await {
        Some(answer) => learn(&asked, &answer),
        None => {
            for one in asked.chunks(1) {
                if let Some(answer) = reader.load(kits, load(one)).await {
                    learn(one, &answer);
                }
            }
        }
    }
    if names.is_empty() {
        return;
    }
    for object in found.values_mut() {
        let ty = object["$type"].as_str().unwrap_or_default().to_owned();
        let Some(fields) = object.as_object_mut() else { continue };
        for (field, value) in fields.iter_mut() {
            let kind = described.field(&ty, field).and_then(|def| def["kind"].as_str()).unwrap_or_default();
            if matches!(kind, "json" | "map") {
                *value = renamed_inside(value, &names);
            }
        }
    }
}

/// The change set between two reads of the document ([`objects`]) across a read of its file, as a
/// receipt names it: a change of an object without a tool id under the nearest object holding it
/// that has one, the objects of the two reads paired rather than matched by object id, which a
/// kit may mint again on every read (`kition_kdm::reread`, read with the kit's described schema).
/// Without a schema, by object id.
pub(crate) async fn compared(kits: &KitManager, view: &DocumentView, before: Map<String, Value>, after: Map<String, Value>) -> Value {
    compared_from(kits, Reader::Kit(view), before, after).await
}

pub(crate) async fn compared_from(kits: &KitManager, reader: Reader<'_>, before: Map<String, Value>, after: Map<String, Value>) -> Value {
    let (before, after) = (json!({ "objects": before }), json!({ "objects": after }));
    let described = reader.described(kits).await;
    let schema = described.as_ref().and_then(|described| crate::drafts::schema_of(described).ok());
    let mut changes = match &schema {
        Some(schema) => {
            let pairing = kition_kdm::reread::pair(schema, &before, &after);
            let mut changes = kition_kdm::reread::diff_read_again(schema, &before, &after).to_recorded_json(schema);
            let pairs: Map<String, Value> = before["objects"]
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(id, _)| minted_form(id))
                .filter_map(|(id, _)| pairing.after(id).filter(|now| *now != id).map(|now| (id.clone(), json!(now))))
                .collect();
            changes["$references"] = json!(pairs);
            changes["$renamed"] = json!(
                before["objects"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter_map(|(id, object)| {
                        let ty = object["$type"].as_str()?;
                        schema.type_def(ty).ok()?.tool_id.as_ref()?;
                        let now = pairing.after(id).filter(|now| *now != id)?;
                        Some((id.clone(), json!(now)))
                    })
                    .collect::<Map<String, Value>>()
            );
            // Keep raw ids for history across list edits, with the same member precision
            // as the public diff. Whole-register edits would also hold untouched members.
            let raw = kition_kdm::diff::diff_states(&pairing.renamed(schema, &before), &after).with_leaf_edits(schema).without_texts().to_recorded_json(schema);
            for list in LISTS {
                changes["$objects"][list] = json!(
                    raw[list]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|object| { object["type"].as_str().is_some_and(|ty| schema.type_def(ty).is_ok_and(|def| def.tool_id.is_none())) })
                        .collect::<Vec<_>>()
                );
            }
            changes
        }
        None => kition_kdm::diff::diff_states(&before, &after).without_texts().to_json(),
    };
    super::derived::privatize(&mut changes, described.as_ref());
    changes
}

/// Resolve live raw object handles, without interpreting literal field values as references.
pub(crate) fn remap_batch(input: &Value, references: &HashMap<String, String>) -> Value {
    let mut input = input.clone();
    for list in ["ops", "load"] {
        for op in input[list].as_array_mut().into_iter().flatten() {
            for key in ["target", "item", "node", "parent"] {
                if let Some(next) = op[key].as_str().and_then(|id| references.get(id)).cloned() {
                    op[key] = json!(next);
                }
            }
            if let Some((owner, path)) = op["in"].as_str().and_then(|path| path.split_once('.'))
                && let Some(next) = references.get(owner)
            {
                op["in"] = json!(format!("{next}.{path}"));
            }
        }
    }
    input
}

pub(crate) fn remap_entries(entries: &[Entry], references: &HashMap<String, String>) -> Vec<Entry> {
    entries
        .iter()
        .cloned()
        .map(|mut entry| {
            if let Some(changes) = &mut entry.changes {
                for group in ["$objects", "$unnamed"] {
                    for list in LISTS {
                        for object in changes[group][list].as_array_mut().into_iter().flatten() {
                            if let Some(next) = object["id"].as_str().and_then(|id| references.get(id)).cloned() {
                                object["id"] = json!(next);
                            }
                            for side in ["at", "from", "to"] {
                                if let Some(next) = object[side]["parent"].as_str().and_then(|id| references.get(id)).cloned() {
                                    object[side]["parent"] = json!(next);
                                }
                            }
                        }
                    }
                }
            }
            entry
        })
        .collect()
}

/// The id of the root object among the objects of one read ([`objects`]).
pub(crate) fn root_of(kits: &KitManager, view: &DocumentView, objects: &Map<String, Value>) -> Option<String> {
    let described = kits.described(view.kit_id)?;
    let root = described["root"].as_str()?;
    objects.iter().find(|(_, object)| object["$type"] == root).map(|(id, _)| id.clone())
}

/// Whether a change set says nothing changed.
pub(crate) fn is_nothing(changes: &Value) -> bool {
    LISTS.iter().all(|list| changes[*list].as_array().is_none_or(Vec::is_empty))
        && changes["$identity"].as_array().is_none_or(Vec::is_empty)
        && changes["$premises"].as_array().is_none_or(Vec::is_empty)
        && changes.get("renumbered").is_none_or(|renumbered| renumbered.as_array().is_none_or(Vec::is_empty))
        && changes.get("unnamed").is_none_or(|unnamed| unnamed.as_object().is_none_or(Map::is_empty))
}

#[cfg(test)]
mod tests {
    use super::*;

    macro_rules! unknown_message {
        ($name:ident, $cause:ident, $prefix:literal) => {
            #[test]
            fn $name() {
                let conflict = Conflict::of(Some("A".into()), "unknown", None).because(Unavailable::$cause);
                assert!(conflict.explanation().starts_with($prefix));
                assert_eq!(conflict.is_renumbered(), Unavailable::$cause == Unavailable::Renumbered);
                assert_eq!(conflict.to_json(), json!({"id":"A","reason":"unknown"}));
            }
        };
    }
    unknown_message!(unknown_cause_messages_are_specific_history, History, "Change history unavailable:");
    unknown_message!(unknown_cause_messages_are_specific_place, Place, "Place basis unavailable:");
    unknown_message!(unknown_cause_messages_are_specific_state, State, "Editor state unavailable:");
    unknown_message!(unknown_cause_messages_are_specific_input, Input, "External input basis unavailable:");
    unknown_message!(unknown_cause_messages_are_specific_content_basis, ContentBasis, "Content basis unavailable:");
    unknown_message!(unknown_cause_messages_are_specific_content, Content, "Content comparison unavailable:");
    unknown_message!(unknown_cause_messages_are_specific_fact_basis, FactBasis, "Fact basis unavailable or evicted:");
    unknown_message!(unknown_cause_messages_are_specific_fact, Fact, "Derived fact comparison unavailable:");
    unknown_message!(unknown_cause_messages_are_specific_identity, Identity, "Identity unprovable:");
    unknown_message!(unknown_cause_messages_are_specific_renumbered, Renumbered, "Objects renumbered:");
    unknown_message!(unknown_cause_messages_are_specific_type, Type, "Object type changed:");
    unknown_message!(unknown_cause_messages_are_specific_selector, Selector, "Selector identity unprovable:");

    #[test]
    fn merged_located_spans_keep_each_transition_and_bound_the_answer() {
        let mut change =
            json!({"id":"A","fields":["body"],"edits":[{"field":"body","before":"old","after":"middle","span":{"offset":10,"removed":"a","inserted":"b"}}]});
        let next =
            json!({"id":"A","fields":["body"],"edits":[{"field":"body","before":"middle","after":"new","span":{"offset":50,"removed":"c","inserted":"d"}}]});
        merge_change(&mut change, &next);
        assert!(change["edits"][0].get("span").is_none());
        assert_eq!(change["edits"][0]["spans"][0]["offset"], 10);
        assert_eq!(change["edits"][0]["spans"][1]["offset"], 50);
        let mut set = json!({"changed":[change]});
        set["changed"][0]["edits"][0]["spans"] = json!([{"inserted":"x".repeat(65_537)}]);
        receipts::unrecorded(&mut set);
        assert!(set["changed"][0]["edits"][0].get("spans").is_none());
        assert_eq!(set["changed"][0]["edits"][0]["spansTruncated"], true);
    }

    fn edit(removed: &[usize], added: &[usize]) -> ListEdit {
        ListEdit { removed: removed.iter().copied().collect(), added: added.iter().copied().collect() }
    }

    #[test]
    fn an_index_is_followed_through_what_an_entry_put_in_and_took_out() {
        // [a b c d]: b deleted, x inserted at 0 → [x a c d].
        let change = edit(&[1], &[0]);
        assert_eq!(change.forward(0), Some(1), "a");
        assert_eq!(change.forward(1), None, "b is gone");
        assert_eq!(change.forward(2), Some(2), "c");
        assert_eq!(change.backward(3), Some(3), "d");
        assert_eq!(change.backward(0), None, "x is new");
        // [a b c]: c moved to the front → [c a b].
        let moved = edit(&[2], &[0]);
        assert_eq!(moved.forward(0), Some(1));
        assert_eq!(moved.backward(2), Some(1));
        // Appended at the end: nothing before it moved.
        assert_eq!(edit(&[], &[3]).forward(1), Some(1));
    }

    #[test]
    fn premises_name_targets_parts_and_replaced_fields() {
        let acts = HashMap::from([("shape.text".to_owned(), Acts::of(&json!({ "properties": { "id": { "type": "string", "x-khp-role": "targets" } } })))]);
        let steps = [
            json!({ "command": "shape.text", "params": { "id": "shape:2" }, "at": { "part": { "slideId": 7 } } }),
            json!({ "command": "x", "on": ["shape:1"] }),
        ];
        let run = Premises::of_run(&steps, Some(&json!({ "slide": 2 })), &acts, None);
        let targets = run.named_targets();
        assert_eq!(targets.keys().collect::<Vec<_>>(), ["shape:1", "shape:2"]);
        assert_eq!(targets["shape:1"], Need::all(), "a command may write any field");
        assert!(run.named.contains(&("slide".to_owned(), "7".to_owned())) && run.numbered.contains(&("slide".to_owned(), 2)));
        let batch = Premises::of_batch(
            &[
                json!({ "op": "set", "target": "shape:1", "field": "text", "value": "x" }),
                json!({ "op": "create", "type": "Shape", "in": "slide:2.shapes", "ref": "$new" }),
                json!({ "op": "set", "target": "$new", "field": "text", "value": "y" }),
            ],
            &HashMap::new(),
        );
        assert_eq!(batch.targets.keys().collect::<Vec<_>>(), ["shape:1", "slide:2"]);
        assert_eq!(batch.targets["shape:1"], Need::fields(BTreeSet::from(["text".to_owned()])));
    }

    #[test]
    fn name_union_points_are_not_mentioned_ids() {
        let acts = HashMap::from([(
            "aim".into(),
            Acts::of(&json!({"properties":{"focus":{
                "oneOf":[{"type":"string"},{"type":"integer"},{"type":"array","items":{"type":"number"}}],
                "x-khp-name":"name","x-khp-role":"object","x-khp-types":["Node"]
            }}})),
        )]);
        let run = Premises::of_run(&[json!({"command":"aim","params":{"focus":[1,2,3]}})], None, &acts, None);
        assert!(run.mentioned.is_empty(), "coordinates are not ids: {run:?}");
    }

    #[test]
    fn a_kits_declared_part_nouns_and_a_batchs_command_targets_are_premises() {
        let steps = [json!({ "command": "clip.trim", "at": { "part": { "sequence": "s2" } } })];
        let run = Premises::of_run(&steps, Some(&json!({ "slide": 2 })), &HashMap::new(), Some(&["sequence"]));
        assert!(run.named.contains(&("sequence".to_owned(), "s2".to_owned())), "{run:?}");
        assert!(run.numbered.is_empty(), "a kit that declares its nouns takes no slide numbers: {run:?}");
        let acts = HashMap::from([("shape.color".to_owned(), Acts::of(&json!({ "properties": { "id": { "type": "string", "x-khp-role": "targets" } } })))]);
        let batch = Premises::of_batch(
            &[
                json!({ "op": "command", "id": "shape.color", "params": { "id": "shape:7/1", "color": "red" } }),
                json!({ "op": "command", "id": "shape.color", "params": { "id": "$new" } }),
                json!({ "op": "command", "id": "unlisted", "params": { "id": "shape:9/1" } }),
            ],
            &acts,
        );
        assert_eq!(batch.named_targets().keys().collect::<Vec<_>>(), ["shape:7/1"]);
        assert_eq!(batch.named_targets()["shape:7/1"], Need::all(), "a command may write any field");
    }

    /// A kit's declared part noun names a part by the id the kit lists: its type is the one whose
    /// tool id has the `<noun>:` prefix, else the type named as the noun, with the id as it is
    /// (regressions/issue-declared-part-noun).
    #[test]
    fn a_declared_part_noun_finds_its_type_without_a_prefixed_tool_id() {
        let described = Described(Some(json!({ "root": "Book", "types": {
            "Book": { "fields": { "sheets": { "kind": "list", "of": "Sheet" } } },
            "Sheet": { "fields": { "id": { "kind": "integer" } }, "toolId": { "field": "id" } }
        } })));
        assert_eq!(described.part_type("sheet"), Some(("Sheet".to_owned(), String::new())));
        let prefixed = Described(Some(json!({ "root": "Deck", "types": {
            "Slide": { "fields": {}, "toolId": { "field": "number", "prefix": "slide:" } }
        } })));
        assert_eq!(prefixed.part_type("slide"), Some(("Slide".to_owned(), "slide:".to_owned())));
    }

    /// Only declared reference positions mention ids; unmarked strings remain literal values.
    #[test]
    fn parameters_mention_whole_strings_one_level_deep() {
        let acts = HashMap::from([(
            "shapes.delete".to_owned(),
            Acts::of(&json!({ "properties": {
            "ids": { "type": "array", "x-khp-role": "targets" },
            "id": {"type":"string","x-khp-role":"object"},
            "to": {"type":"array","items":{"oneOf":[{"type":"string","x-khp-role":"object"},{"type":"object","properties":{"at":{"type":"string","x-khp-role":"object"}}}]}},
            "anchor":{"type":"object","properties":{"shape":{"type":"string","x-khp-role":"object"}}}
        } })),
        )]);
        let steps = [json!({ "command": "shapes.delete", "params": {
            "ids": ["shape:1"], "id": "shape:2", "to": ["shape:3", { "at": "shape:4", "deep": { "id": "shape:5" } }],
            "anchor": { "shape": "shape:6", "list": ["shape:7"] }, "n": 3, "text": "two words"
        } })];
        let run = Premises::of_run(&steps, None, &acts, None);
        assert_eq!(run.named_targets().keys().collect::<Vec<_>>(), ["shape:1"]);
        assert_eq!(run.mentioned.iter().collect::<Vec<_>>(), ["shape:2", "shape:3", "shape:4", "shape:6"]);
        let batch = Premises::of_batch(
            &[
                json!({ "op": "set", "target": "shape:1", "field": "start", "value": "shape:8" }),
                json!({ "op": "create", "type": "Shape", "in": "slide:2.shapes", "fields": { "end": "shape:9", "text": "$new" } }),
            ],
            &HashMap::new(),
        );
        assert_eq!(batch.mentioned.iter().collect::<Vec<_>>(), ["shape:8", "shape:9"]);
    }

    /// a step names what it acts on by a place when its command reads the time and the
    /// step gives `at.time`, or it gives a parameter the command marks as a place, and names no
    /// ids; a place parameter is no object a step mentions; a target only position-independent
    /// commands act on is independent.
    #[test]
    fn a_step_by_place_is_a_premise_and_a_place_parameter_names_no_object() {
        let acts = HashMap::from([
            (
                "timeline.razor".to_owned(),
                Acts::of(&json!({ "x-khp-reads": ["time"], "properties": { "track": { "type": "string", "x-khp-role": "place" } } })),
            ),
            (
                "clip.opacity".to_owned(),
                Acts::of(&json!({ "x-khp-position": "independent", "properties": { "clip": { "type": "integer", "x-khp-role": "targets" } } })),
            ),
            ("clip.trim".to_owned(), Acts::of(&json!({ "properties": { "clip": { "type": "integer", "x-khp-role": "targets" } } }))),
        ]);
        let steps = [
            json!({ "command": "timeline.razor", "params": { "track": "V1" }, "at": { "time": 2.5 } }),
            json!({ "command": "timeline.razor", "on": [5], "at": { "time": 2.5 } }),
            json!({ "command": "timeline.razor" }),
            json!({ "command": "clip.opacity", "on": [3] }),
            json!({ "command": "clip.opacity", "params": { "clip": 4 } }),
            json!({ "command": "clip.trim", "params": { "clip": 4 } }),
        ];
        let run = Premises::of_run(&steps, None, &acts, Some(&["sequence"]));
        // the step by id (`on: [5]`) at a time is checked at its time too.
        assert_eq!(run.places.len(), 2, "{run:?}");
        assert_eq!(run.places[0].named, json!({ "track": "V1", "time": 2.5 }));
        assert_eq!((run.places[1].step, run.places[1].named.clone()), (1, json!({ "time": 2.5 })));
        assert!(run.mentioned.is_empty(), "a track is a place, not an object: {run:?}");
        let targets = run.named_targets();
        assert!(targets["3"] == Need::of_command(true) && targets["4"] == Need::all(), "{run:?}");
    }

    /// a step naming no object addresses its part (a part step), unless it gives `on`,
    /// its targets or a place; a target in the command's index spelling is a place.
    #[test]
    fn a_step_naming_no_object_acts_on_its_part_and_an_index_spelling_is_a_place() {
        let mut acts = HashMap::new();
        acts.insert("comp.marker".to_owned(), Acts::of(&json!({ "properties": { "at": { "type": "number" }, "comment": { "type": "string" } } })));
        acts.insert(
            "prop.set".to_owned(),
            Acts::of(
                &json!({ "properties": { "layer": { "oneOf": [{ "type": "integer" }, { "type": "string" }], "x-khp-role": "targets", "x-khp-index": "#" } } }),
            ),
        );
        let nouns: Option<&[&str]> = Some(&["comp"]);
        let steps = [
            json!({ "command": "comp.marker", "params": { "at": 2, "comment": "x" }, "at": { "part": { "comp": 5 } } }),
            json!({ "command": "prop.set", "params": { "layer": "#3" }, "at": { "part": { "comp": 5 } } }),
            json!({ "command": "prop.set", "params": { "layer": 9 }, "at": { "part": { "comp": 5 } } }),
        ];
        let premises = Premises::of_run(&steps, None, &acts, nouns);
        assert_eq!(premises.part_steps.len(), 1, "{premises:?}");
        assert_eq!(premises.part_steps[0].part, PartRef::Named("comp".into(), "5".into()));
        assert_eq!(premises.part_steps[0].mentioned, BTreeSet::new());
        assert_eq!(premises.places.len(), 1);
        assert_eq!((premises.places[0].indexes.clone(), premises.places[0].named["layer"].clone()), (vec![2], json!("#3")));
        let targets = premises.named_targets();
        assert!(targets.contains_key("9") && !targets.contains_key("#3"), "{premises:?}");
        let described = Described(Some(json!({ "root": "P", "types": {
            "Item": { "fields": { "comp": { "kind": "ref", "of": "Comp", "owns": true } } },
            "Comp": { "fields": { "attrs": { "kind": "map" }, "layers": { "kind": "list", "of": "Layer" } } }
        } })));
        assert!(described.holds_objects("Item", "comp.layers"));
        assert!(!described.holds_objects("Item", "comp.attrs") && !described.holds_objects("Item", "comp.layers.2"));
    }

    /// a layer that holds only its property nodes (no type with tool ids below
    /// it) has no other layer's change inside it, so the guard reads none of its subtree; an item
    /// that owns a comp of layers may.
    #[test]
    fn a_type_holding_no_tool_ids_needs_no_walk() {
        let described = Described(Some(json!({ "root": "Project", "types": {
            "Project": { "fields": { "items": { "kind": "list", "of": "Item" } } },
            "Item": { "fields": { "comp": { "kind": "ref", "of": "Comp", "owns": true } }, "toolId": { "field": "id" } },
            "Comp": { "fields": { "layers": { "kind": "list", "of": "Layer" } } },
            "Layer": { "fields": { "props": { "kind": "ref", "of": "Node", "owns": true }, "source": { "kind": "ref", "of": "Item" } }, "toolId": { "field": "id" } },
            "Node": { "fields": { "children": { "kind": "list", "of": "Node" }, "keys": { "kind": "list", "of": "Key" } } },
            "Key": { "fields": { "time": { "kind": "string" } } }
        } })));
        assert!(!described.may_hold_tool_ids("Layer"));
        assert!(described.may_hold_tool_ids("Item") && described.may_hold_tool_ids("Project"));
        assert!(Described(None).may_hold_tool_ids("Layer"), "without a description, anything may");
    }

    /// ids at members a parameter's schema marks below its top level are read at any
    /// depth (such as `rules[].target`), whole numbers too; a typed parameter's values
    /// carry their types; a target taking names keeps its strings as possible names.
    #[test]
    fn nested_marked_members_typed_values_and_names_are_premises() {
        let schema = json!({ "properties": {
            "node": { "oneOf": [{ "type": "integer" }, { "type": "string" }], "x-khp-role": "targets", "x-khp-name": "name" },
            "boids": { "type": "object", "properties": { "rules": { "type": "array", "items": { "type": "object", "properties": {
                "target": { "type": "integer", "x-khp-role": "object", "x-khp-types": ["Node"] }, "weight": { "type": "integer" }
            } } } } },
            "material": { "type": "integer", "x-khp-role": "object", "x-khp-types": ["Material"] }
        } });
        let acts = HashMap::from([("particles.set".to_owned(), Acts::of(&schema))]);
        let steps = [json!({ "command": "particles.set", "params": {
            "node": "Emitter", "material": 4, "boids": { "rules": [{ "target": 7, "weight": 3 }, { "target": 8, "weight": 9 }] }
        } })];
        let run = Premises::of_run(&steps, None, &acts, None);
        assert_eq!(run.mentioned.iter().collect::<Vec<_>>(), ["4", "7", "8"], "a weight is no id: {run:?}");
        assert_eq!(run.typed.get("4"), Some(&vec!["Material".to_owned()]));
        assert_eq!(run.steps[0].names, vec![("Emitter".to_owned(), "name".to_owned(), None)]);
    }

    /// A premise in the kit's words
    /// (`transform/rotation`) is not touched by a change of a map key of the object's own field
    /// (`attrs.stretch`, a time stretch), which no word of the kit's names; a change inside its
    /// property tree without words still is (it may be that property).
    #[test]
    fn a_premise_in_the_kits_words_is_not_touched_by_a_map_key() {
        let described = Described(Some(json!({ "root": "P", "types": {
            "Layer": { "fields": { "attrs": { "kind": "map" }, "props": { "kind": "ref", "of": "Node", "owns": true }, "outPoint": { "kind": "string", "position": true } } },
            "Node": { "fields": { "children": { "kind": "list", "of": "Node" } }, "pathName": "meta.match" }
        } })));
        let wanted = BTreeSet::from(["transform/rotation".to_owned()]);
        let held = |field: &str| described.leads_into_held("Layer", field);
        let skip = |field: &str| described.position("Layer", field);
        let stretch = json!({ "type": "Layer", "fields": ["attrs.stretch", "outPoint"], "edits": [{ "field": "attrs.stretch", "before": 100, "after": 200 }] });
        assert!(!touches_any(&stretch, &wanted, &skip, &held), "a stretch is no change of the rotation");
        let inside = json!({ "type": "Layer", "fields": ["props.children.2.value"], "edits": [] });
        assert!(touches_any(&inside, &wanted, &skip, &held), "a change in the tree without words may be the rotation");
    }

    #[test]
    fn nested_position_and_field_premises_match_segments_in_both_directions() {
        let need = Need::of_premise(&json!({ "positions": ["frame.transform"] }));
        for path in ["frame.transform", "frame.transform.4", "frame"] {
            assert!(need.position(path), "position {path}");
        }
        assert!(!need.position("frame.transformOrigin"));
        for wanted in ["frame.transform", "~geometry.bounds"] {
            let fields = BTreeSet::from([wanted.to_owned()]);
            for path in [wanted.to_owned(), format!("{wanted}.4"), root_field(wanted).to_owned()] {
                assert!(touches_any(&json!({ "fields": [path] }), &fields, &|_| false, &|_| false), "{wanted}: {path}");
            }
            assert!(!touches_any(&json!({ "fields": [format!("{wanted}Origin")] }), &fields, &|_| false, &|_| false));
        }
    }

    #[test]
    fn a_change_inside_a_replaced_field_touches_it() {
        assert!(overlaps("body", "body") && overlaps("body.paragraphs.0.text", "body"));
        assert!(!overlaps("bodyColor", "body") && !overlaps("color", "body"));
        // a change of what holds a wanted path touches it too.
        assert!(overlaps("effects", "effects.1.params"));
    }

    #[test]
    fn nested_text_offsets_require_complete_prefix_history() {
        let range = TextRange { owner: "paragraph".into(), paths: vec![("paragraph".into(), "text".into())], from: 4, to: 4 };
        let entries = [
            Entry {
                seq: 1,
                author: "other".into(),
                changes: Some(json!({"changed":[{"id":"paragraph","fields":["text"],"edits":[{"field":"text","before":"abcdefghij","after":"Xabcdefghij"}]}]})),
            },
            Entry { seq: 2, author: "me".into(), changes: None },
        ];
        assert_eq!(text_range_reason(&range, &entries, "me"), Some("unknown"));
    }

    #[test]
    fn others_changes_merge_into_one_set() {
        let entry = |author: &str, changes: Value| Entry { seq: 1, author: author.to_owned(), changes: Some(changes) };
        let first = entry(
            "b",
            json!({ "created": [{ "id": "n" }], "changed": [{ "id": "a", "fields": ["x"], "edits": [{ "field": "x", "before": 1, "after": 2 }] }], "moved": [], "deleted": [] }),
        );
        let second = entry(
            "outside",
            json!({ "created": [], "changed": [{ "id": "a", "fields": ["x", "y"], "edits": [{ "field": "x", "before": 2, "after": 3 }] }], "moved": [], "deleted": [{ "id": "n" }] }),
        );
        let merged = merged_set(&[&first, &second]);
        assert_eq!(merged["created"], json!([]), "created and deleted again: neither");
        assert_eq!(merged["deleted"], json!([]));
        assert_eq!(merged["changed"][0]["fields"], json!(["x", "y"]));
        assert_eq!(merged["changed"][0]["edits"][0], json!({ "field": "x", "before": 1, "after": 3 }));
        assert_eq!(merged["by"], json!(["b", "outside"]));
    }
}
