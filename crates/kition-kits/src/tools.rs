// Copied from kition-sdk crates/kition-kits/src/tools.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Kit tools (KHP A3): for every kit, inspect a file, search its commands, and
//! edit it by running them: `<prefix>_inspect`, `<prefix>_commands`, and `<prefix>_run`, named
//! and worded from the kit's definition (its `kit.json`). The object-model tools `<prefix>_query`
//! and `<prefix>_batch` (`model.rs`) read and edit the document as typed objects, with argument
//! schemas generated from the kit's `model.describe`; `<prefix>_check` reports what the kit finds
//! wrong with the document (standard 2.0 A21 to A23), so the agent can verify its own edits. Every failure carries a structured error
//! code (`errors.rs`) beside its message. An agent may edit a draft instead of
//! the live document (standard 2.0 A12, `draft: true`), and asks for its review with
//! `<prefix>_draft_ready` (or takes it back with `<prefix>_draft_reopen`); merging or
//! discarding a draft is the person's alone, never a tool.
//!
//! One implementation serves every harness: Kition's own agent and any MCP client (DeepSeek
//! Harness through `dsh-mcp-client`, and others) through `mcp.rs`. A file open in a kit editor
//! is edited live through the Kit AI bridge (A7); otherwise through the kit's headless
//! executable on its `agent` connection, so the kit enforces the workspace and the agent role.

mod carried;
mod context;
pub(crate) mod derived;
mod errors;
mod export;
mod guard;
pub(crate) mod history;
mod inputs;
pub mod journal;
pub mod model;
mod outside;
pub mod receipts;
pub mod schemas;
mod selector;

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Map, Value, json};

pub use errors::{ErrorCode, KitToolError};

use crate::bridge::{BridgeFailure, LiveDocument};
use crate::definitions::known;
use crate::drafts::{self, DraftState};
use crate::manager::{Caller, DocumentView, KitDefinition, KitError, KitManager, PreviewRequest};

const PREVIEW_SIZE: u32 = 1024;
const MAX_COMMANDS: usize = 12;
/// Commands a page when `<prefix>_commands` lists every command (no query, KHP A5b): the default
/// and the most a page may hold.
const DEFAULT_LISTED: usize = 50;
const MAX_LISTED: usize = 200;

/// What a kit tool does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Inspect,
    Commands,
    Run,
    /// The agent asks the person to review its draft (standard 2.0 A12).
    DraftReady,
    /// The agent takes its draft back to keep working on it.
    DraftReopen,
    /// Read objects from the document's object model.
    Query,
    /// Edit the document's object model with one `model/batch`.
    Batch,
    /// The kit's diagnostics on the document (standard 2.0 A22).
    Check,
    /// Write the document to a new file in a format the kit exports (KHP A41).
    Export,
    /// A new, empty file of a kind the kit creates (KHP A41).
    Create,
}

impl Action {
    pub const ALL: [Action; 10] = [
        Action::Inspect,
        Action::Commands,
        Action::Run,
        Action::DraftReady,
        Action::DraftReopen,
        Action::Query,
        Action::Batch,
        Action::Check,
        Action::Export,
        Action::Create,
    ];

    fn suffix(self) -> &'static str {
        match self {
            Action::Inspect => "inspect",
            Action::Commands => "commands",
            Action::Run => "run",
            Action::DraftReady => "draft_ready",
            Action::DraftReopen => "draft_reopen",
            Action::Query => "query",
            Action::Batch => "batch",
            Action::Check => "check",
            Action::Export => "export",
            Action::Create => "create",
        }
    }

    /// Whether the tool changes files: edits, or a new file (an export, a created file).
    pub fn writes(self) -> bool {
        matches!(self, Action::Run | Action::Batch | Action::Export | Action::Create)
    }
}

/// How a harness runs kit tools: Kition's agent passes the run's choice of live or draft editing
/// (the agent UI's setting); a tool call's own `draft` argument wins over it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CallOptions {
    /// Edit drafts unless a call says `draft: false`.
    pub draft: bool,
    /// How a write that passes `basis` is checked against what others changed since.
    pub guard: Guard,
    /// Refuse `<prefix>_run` and `<prefix>_batch` without `basis` (`--require-basis`).
    pub require_basis: bool,
}

/// How a write with `basis` is checked against the changes others made since (the server's
/// `--guard`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Guard {
    /// Refuse a write whose premises others changed: a target or its part deleted or relocated,
    /// a field it replaces (a batch) or any field of its target (a command step) changed.
    #[default]
    Premise,
    /// Refuse a write whenever anyone else changed the document since `basis`.
    Epoch,
    /// Never refuse; still say what others changed.
    Off,
}

impl Guard {
    /// `premise`, `epoch` or `off`, as `--guard` takes them.
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "premise" => Self::Premise,
            "epoch" => Self::Epoch,
            "off" => Self::Off,
            _ => return None,
        })
    }
}

/// One kit tool as a harness offers it to a model.
#[derive(Clone, Debug)]
pub struct KitToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema for the arguments.
    pub input_schema: Value,
    /// Whether the tool changes files (`<prefix>_run`, `<prefix>_batch`, `<prefix>_export`).
    pub writes: bool,
}

/// A rendered preview of the document, for the model to see.
#[derive(Clone, Debug)]
pub struct Preview {
    pub caption: String,
    pub png: Vec<u8>,
}

/// A tool's answer: a one-line summary, its canonical output, and previews.
#[derive(Clone, Debug)]
pub struct KitToolOutput {
    pub summary: String,
    pub output: Value,
    pub previews: Vec<Preview>,
}

impl KitToolOutput {
    pub(crate) fn new(summary: String, output: Value) -> Self {
        Self { summary, output, previews: Vec::new() }
    }
}

pub type KitToolResult = Result<KitToolOutput, KitToolError>;

pub fn tool_name(kit: &KitDefinition, action: Action) -> String {
    if unified() {
        return format!("kit_{}", action.suffix());
    }
    format!("{}_{}", kit.agent.prefix, action.suffix())
}

/// One entry point for every kit: tools named `kit_<action>`, routed by the extension of the
/// call's `path`, so the tool list does not grow with the number of kits (`kition-kits-mcp
/// --unified`). Off unless a program turns it on, for the whole process.
static UNIFIED: AtomicBool = AtomicBool::new(false);

/// Turns the unified tool set on or off for this process.
pub fn set_unified(on: bool) {
    UNIFIED.store(on, Ordering::Relaxed);
}

/// Whether the tools are the unified set (`kit_<action>`).
pub fn unified() -> bool {
    UNIFIED.load(Ordering::Relaxed)
}

/// The kit and action of a unified tool call (`kit_run` on `report.xlsx` is Sheet's run).
fn unified_route(name: &str, input: &Value) -> Option<(&'static KitDefinition, Action)> {
    let suffix = name.strip_prefix("kit_")?;
    let action = Action::ALL.into_iter().find(|action| action.suffix() == suffix)?;
    let path = input.get("path")?.as_str()?;
    let extension = path.trim().rsplit_once('.')?.1.to_ascii_lowercase();
    let kit = known().into_iter().find(|kit| kit.extensions.contains(&extension.as_str()))?;
    Some((kit, action))
}

/// The unified tool set: one kit's tools, worded for all the installed kits.
fn unified_specs(on: &[&'static KitDefinition]) -> Vec<KitToolSpec> {
    let first = on[0];
    let formats = on.iter().map(|kit| format!("{}: {}", kit.name, kit.agent.formats)).collect::<Vec<_>>().join("; ");
    let words = |text: &str| {
        text.replace(first.agent.formats, &formats)
            .replace(first.agent.reports, "its structure")
            .replace(&format!(" in {}", first.name), " in the kit for its file type")
            .replace(first.agent.noun, "file")
    };
    specs_of(first)
        .into_iter()
        .map(|spec| KitToolSpec {
            // `kit_<action>` also while the tools are each kit's own (a kit supply's `kit_inspect`).
            name: spec.name.strip_prefix(&format!("{}_", first.agent.prefix)).map_or_else(|| spec.name.clone(), |action| format!("kit_{action}")),
            description: words(&spec.description),
            input_schema: serde_json::from_str(&words(&spec.input_schema.to_string())).unwrap_or(spec.input_schema),
            writes: spec.writes,
        })
        .collect()
}

/// The kit and action a tool name names, if it is a kit tool.
pub fn parse(name: &str) -> Option<(&'static KitDefinition, Action)> {
    Action::ALL.into_iter().find_map(|action| {
        let prefix = name.strip_suffix(action.suffix())?.strip_suffix('_')?;
        let kit = known().into_iter().find(|kit| kit.agent.prefix == prefix)?;
        Some((kit, action))
    })
}

/// The kit's display name without the product prefix: `Slide` for `Kition Slide`.
pub fn short(kit: &KitDefinition) -> &'static str {
    kit.name.strip_prefix("Kition ").unwrap_or(kit.name)
}

pub(crate) fn path_property(kit: &KitDefinition) -> Value {
    json!({ "type": "string", "description": format!("Workspace-relative path to a {} file.", kit.agent.formats) })
}

/// The argument every tool on a document's contents takes for the revision chain.
pub(crate) fn basis_property() -> Value {
    json!({ "type": "string", "description": "The `revision` of the last answer you were given for this file. The answer then says what others (other agents, edits to the file) changed since (`others`); a write whose objects or part they deleted, moved or changed is refused with `conflict` and runs nothing." })
}

/// What a writing tool's description says about `basis` and `conflict`.
pub(crate) const BASIS: &str = "Pass the latest `revision` you were given for the file as `basis`: the answer then lists what others changed since (`others`), and a `conflict` (nothing ran) means others deleted, moved or changed what this call acts on: look at `others` and `conflicts`, decide again, and pass the `revision` the refusal gives.";

pub(crate) fn draft_property() -> Value {
    json!({ "type": "boolean", "description": "Work on your draft of the file instead of the live document: the person reviews it and merges or discards it. Defaults to the run's mode." })
}

/// What a run's `target` and a step's `at.part` take: one of the kit's declared part nouns
/// (`agent.parts`), each a part's id as the inspect tool lists it, or else a slide or page.
fn part_schema(kit: &KitDefinition) -> Value {
    let properties = match kit.agent.parts {
        Some(nouns) => Value::Object(
            nouns
                .iter()
                .map(|noun| {
                    ((*noun).to_owned(), json!({ "type": ["integer", "string"], "description": format!("A {noun}, by the id the inspect tool lists.") }))
                })
                .collect(),
        ),
        None => {
            json!({ "slide": { "type": "integer", "minimum": 1 }, "page": { "type": "integer", "minimum": 1 }, "slideId": { "type": "integer", "minimum": 0 }, "pageId": { "type": "integer", "minimum": 0 } })
        }
    };
    json!({ "type": "object", "properties": properties, "additionalProperties": false, "minProperties": 1, "maxProperties": 1 })
}

/// A run's `target` ([`part_schema`]), described.
fn run_target_schema(kit: &KitDefinition) -> Value {
    let mut schema = part_schema(kit);
    schema["description"] = json!(match kit.agent.parts {
        Some(nouns) => format!(
            "The part the steps act on: {}, by the id the inspect tool lists. The ids the inspect tool listed for that part work in the steps; a step's `at.part` overrides it for that step. The kit's current part is as it was after the call.",
            nouns.iter().map(|noun| format!("{{\"{noun}\": id}}")).collect::<Vec<_>>().join(" or ")
        ),
        None => "The part the steps act on, as in the inspect tool's target: {\"slideId\": 260} (the slide's `id` as inspect lists it; it names the same slide after slides are added, deleted or moved) or {\"slide\": 3} (counted from 1; whatever slide is third then). The ids the inspect tool listed for that part work in the steps; a step's `at.part` overrides it for that step. The kit's current part is as it was after the call.".to_owned(),
    });
    schema
}

fn specs_of(kit: &'static KitDefinition) -> [KitToolSpec; 10] {
    specs_described(kit, None)
}

/// The kit's tools, with the object-model tools' arguments generated from `described` (what the
/// kit's `model.describe` answered) when it is known.
fn specs_described(kit: &'static KitDefinition, described: Option<&Value>) -> [KitToolSpec; 10] {
    let agent = &kit.agent;
    let (name, noun) = (kit.name, agent.noun);
    let commands = tool_name(kit, Action::Commands);
    let run = tool_name(kit, Action::Run);
    let inspect = tool_name(kit, Action::Inspect);
    let part_schema = part_schema(kit);
    let ready = tool_name(kit, Action::DraftReady);
    [
        KitToolSpec {
            name: tool_name(kit, Action::Inspect),
            description: format!(
                "Open a {noun} ({}) in {name} and report {}. With `preview: true` it also attaches a rendered preview to the next turn, for when you need to see it (layout, overlaps, colours); without it, it answers JSON only. With `target` (for example {{\"slide\": 3}}) it looks at only that part and lists its objects (ids, kinds, names, boxes, text, fills), which is the usual way to find what to edit; with `preview`, `target` is also the view drawn (for a timeline {{\"time\": 3}}), and `preview` in the answer says what the picture shows (its size and scale, a timeline's frames and their times). Use it before and after editing. It answers `revision`: pass it as `basis` to your next call on the file.",
                agent.formats, agent.reports
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": path_property(kit),
                    "preview": { "type": "boolean", "description": "Attach a rendered preview image of what you look at. Defaults to false: pass true when you need to see it (layout, overlaps, colours)." },
                    "target": { "type": "object", "description": "Look at one part: {\"slide\": 3} or {\"page\": 2} (counted from 1), or {\"slideId\": 260} or {\"pageId\": 7} (the part's `id` as inspect lists it, which stays the same when parts are added, deleted or moved), lists its objects (and previews it with `preview: true`); a diagnostic's `target` from the check tool (for example {\"path\": \"layer:12\"}) previews what it is about; {\"range\": \"A1:J20\", \"sheet\": \"name\"} lists those cells of a spreadsheet; {\"paragraphs\": [0, 30]} lists those paragraphs of a document (counted from 0). With `preview`, it is the view the picture shows, passed whole to a kit's own render command (`agent.render`): for a timeline {\"time\": 3} (seconds) for one frame or {\"range\": [0, 4], \"frames\": 6} for a contact sheet, with the kit's part, for example {\"sequence\": 2} or {\"comp\": 3}. A kit's render command takes the members its parameter schema lists (the commands tool shows it); any other is `invalid-params`, naming those it takes. A preview of a target the kit cannot draw fails with `unsupported` or `invalid-params`, never the whole document instead: inspect without `target` to see the whole document.", "properties": { "slide": { "type": "integer", "minimum": 1 }, "page": { "type": "integer", "minimum": 1 }, "slideId": { "type": "integer", "minimum": 0 }, "pageId": { "type": "integer", "minimum": 0 }, "path": { "type": "string" }, "objectId": { "type": "string" }, "time": { "type": "number", "minimum": 0, "description": "A timeline's time in seconds: the frame shown then." }, "range": { "type": ["string", "array"], "items": { "type": "number" }, "description": "A spreadsheet's cells (`A1:J20`), or a timeline's [from, to] in seconds for a contact sheet of `frames`." }, "frames": { "type": "integer", "minimum": 1, "description": "How many frames a timeline's contact sheet of `range` shows." }, "sequence": { "type": ["integer", "string"], "description": "A timeline's sequence, as the kit names it." }, "comp": { "type": ["integer", "string"], "description": "A motion-graphics composition, as the kit names it." }, "sheet": { "type": "string" }, "paragraphs": { "type": "array", "items": { "type": "integer" } } } },
                    "scale": { "type": "number", "exclusiveMinimum": 0, "maximum": 2, "description": "Preview pixels per document unit, up to 2 (default 1). A kit that cannot draw that scale fails the preview with `unsupported`, saying the scale it draws at most." },
                    "maxSize": { "type": "integer", "minimum": 16, "maximum": 4096, "description": "The most preview pixels on the longer side (default 1024 for kits without their own render command)." },
                    "basis": basis_property(),
                    "draft": draft_property()
                },
                "required": ["path"]
            }),
            writes: false,
        },
        KitToolSpec {
            name: commands.clone(),
            description: format!(
                "Search {name}'s editing commands ({}) by keywords. Returns command ids, what each does, and its parameters in one line; pass `detail: true` (or a command id as the query) for the full parameter schema, with what the command acts on (`targets`, the parameter a run step's `on` fills) and the editor state it reads (`reads`: selection, part, time). Without a query it lists every command by id, a page at a time (`cursor`, `limit`). Pass an id to {run}.",
                agent.covers
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": path_property(kit),
                    "query": { "type": "string", "description": format!("Keywords to match in the command id, title, or description, for example {}. Leave it out to list every command.", agent.queries) },
                    "detail": { "type": "boolean", "description": "List each command's full parameter and result schemas instead of one line." },
                    "cursor": { "type": "string", "description": "Without a query: the `next` of the previous page." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_LISTED, "description": format!("Without a query: commands a page, at most {MAX_LISTED} (default {DEFAULT_LISTED}).") }
                },
                "required": ["path"]
            }),
            writes: false,
        },
        KitToolSpec {
            name: run.clone(),
            description: format!(
                "Edit a {noun} in {name} by running commands in order, then save the file. Each step is one undoable command with a JSON object of params, as documented by {commands}; `on` names the objects a step acts on by the ids {inspect} lists, and `at` where it acts (a part, a time). The kit's selection and current part are set for each step and put back after the call, so a call leaves no state behind. Stops at the first failing step and rolls the run back: the file and the document are as they were before the call, and nothing is saved. Answers each step's result and a short document summary. {} {BASIS} With `draft`, the steps edit your draft of the file instead (never saved); call {ready} when it is done.",
                receipts::DESCRIBED
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": path_property(kit),
                    "steps": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 50,
                        "items": {
                            "type": "object",
                            "properties": {
                                "command": { "type": "string", "description": format!("A command id from {commands}, for example `{}`.", agent.command) },
                                "params": { "type": "object", "description": "Command parameters." },
                                "on": { "type": "array", "minItems": 1, "items": { "type": ["string", "integer"] }, "description": format!("The objects the step acts on, by the ids {inspect} lists. They go into the command's id parameter (its `targets` in {commands} with `detail`; do not give that parameter too), or are selected for a command that acts on the selection (`reads` lists `selection`); the selection is put back afterwards. A command that takes neither refuses `on`.") },
                                "at": { "type": "object", "description": "Where the step acts, for this step only: `part` as in `target` (it overrides the run's `target`), `time` in seconds for kits with a timeline.", "properties": { "part": part_schema, "time": { "type": "number", "minimum": 0 } }, "additionalProperties": false }
                            },
                            "required": ["command"],
                            "additionalProperties": false
                        }
                    },
                    "save": { "type": "boolean", "description": "Save the file after the steps. Defaults to true; a draft is never saved." },
                    "target": run_target_schema(kit),
                    "preview": { "type": "boolean", "description": "Attach a rendered preview of the document after the steps: the whole document, or `view`. Defaults to false." },
                    "view": { "type": "object", "description": "What the preview shows, for a kit with its own render command (`agent.render`): a view as the inspect tool's `target` names it, for example {\"time\": 3} or {\"slide\": 2}. It is checked before any step runs; `preview` in the answer says what the picture shows. Not for drafts." },
                    "changes": receipts::input_properties()[0].1.clone(),
                    "check": receipts::input_properties()[1].1.clone(),
                    "basis": basis_property(),
                    "draft": draft_property()
                },
                "required": ["path", "steps"]
            }),
            writes: true,
        },
        KitToolSpec {
            name: ready.clone(),
            description: format!(
                "Ask the person to review your draft of a {noun} in {name}: they see a comparison with the document and merge it or discard it. Call it when the draft is done; do not merge or discard it yourself."
            ),
            input_schema: json!({
                "type": "object",
                "properties": { "path": path_property(kit) },
                "required": ["path"]
            }),
            writes: false,
        },
        KitToolSpec {
            name: tool_name(kit, Action::DraftReopen),
            description: format!("Take your draft of a {noun} in {name} back from review to keep editing it (after {ready}); edits with `draft` also do."),
            input_schema: json!({
                "type": "object",
                "properties": { "path": path_property(kit) },
                "required": ["path"]
            }),
            writes: false,
        },
        model::query_spec(kit, described),
        model::batch_spec(kit, described),
        KitToolSpec {
            name: tool_name(kit, Action::Check),
            description: format!(
                "Check a {noun} in {name}: lists what the kit finds wrong with it (broken references, overflowing text, formula errors), each with a stable `code`, a `severity` (error, warning, info), its `target` (object id, slide, page, sheet, cell), a message, and sometimes a `fix` command for {run}. Call it after editing and fix the errors it reports. Changes nothing."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": path_property(kit),
                    "basis": basis_property(),
                    "draft": draft_property()
                },
                "required": ["path"]
            }),
            writes: false,
        },
        KitToolSpec {
            name: tool_name(kit, Action::Export),
            description: format!(
                "Export a {noun} from {name} to a new file{}, as the kit's engine draws it. The file is always new: when `to` exists the next free name is used. Lists the file it wrote; changes nothing in the {noun}.",
                kit.agent.export.as_ref().map(|export| format!(" ({})", export::listed(export))).unwrap_or_default()
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": path_property(kit),
                    "to": { "type": "string", "description": "Workspace-relative path of the new file, for example `exports/Screen.png`." },
                    "format": { "type": "string", "description": "The format, a file extension; defaults to the extension of `to`." },
                    "options": { "type": "object", "description": format!("Parameters for the kit's export command, as {commands} documents it.") },
                    "draft": draft_property()
                },
                "required": ["path", "to"]
            }),
            writes: true,
        },
        KitToolSpec {
            name: tool_name(kit, Action::Create),
            description: format!(
                "Create a new, empty {noun} in {name} at `path` ({}) and save it. The file is always new: when `path` exists the next free name is used. Lists the file it wrote; edit it with the other tools.",
                kit.creates.iter().map(|(extension, _)| format!(".{extension}")).collect::<Vec<_>>().join(", ")
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Workspace-relative path of the new file, for example `deck.kslide`." },
                    "size": { "type": "object", "description": "The document size in pixels, for example {\"width\": 1920, \"height\": 1080}.", "properties": { "width": { "type": "integer", "minimum": 1 }, "height": { "type": "integer", "minimum": 1 } } }
                },
                "required": ["path"]
            }),
            writes: true,
        },
    ]
}

/// Every known kit's tools.
pub fn specs() -> Vec<KitToolSpec> {
    known().into_iter().flat_map(specs_of).collect()
}

/// The tools of the kits installed in this runtime. A kit whose object model Kition has seen
/// (`model.describe`) gets `<prefix>_query` and `<prefix>_batch` arguments generated from it.
pub fn installed(kits: &KitManager) -> Vec<KitToolSpec> {
    let installed: Vec<&str> = kits.statuses().into_iter().filter(|kit| kit.installed).map(|kit| kit.id).collect();
    if unified() {
        let on: Vec<&'static KitDefinition> = kits.definitions().filter(|kit| installed.contains(&kit.id)).collect();
        if !on.is_empty() {
            return unified_offered(&on);
        }
    }
    kits.definitions()
        .filter(|kit| installed.contains(&kit.id))
        .flat_map(|kit| specs_described(kit, kits.described(kit.id).as_ref()).into_iter().filter(|spec| offers(kit, &spec.name)))
        .collect()
}

/// The unified tools `on` the kits `on` (the first one words them), without the tools none of
/// them offers.
fn unified_offered(on: &[&'static KitDefinition]) -> Vec<KitToolSpec> {
    let exports = on.iter().any(|kit| kit.agent.export.is_some());
    let creates = on.iter().any(|kit| !kit.creates.is_empty());
    let drafts = on.iter().any(|kit| kit.agent.drafts);
    let models = on.iter().any(|kit| kit.agent.object_model);
    unified_specs(on)
        .into_iter()
        .filter(|spec| match parse_unified(&spec.name) {
            Some(Action::Export) => exports,
            Some(Action::Create) => creates,
            Some(Action::DraftReady | Action::DraftReopen) => drafts,
            Some(Action::Query | Action::Batch) => models,
            _ => true,
        })
        .collect()
}

/// The tools a server offers: [`installed`], and, when the manager has a kit supply
/// ([`KitManager::with_supply`]) with kits not installed yet, the tools that install them on
/// first use. With the unified tools (`--unified`), those are the `kit_<action>` tools worded for
/// the installed kits and the ones the supply has; else `kit_inspect` beside each installed kit's
/// own tools: inspecting a file of a kit not installed installs it, and its own tools appear
/// (the server announces `notifications/tools/list_changed`).
pub fn offered(kits: &KitManager) -> Vec<KitToolSpec> {
    let mut specs = installed(kits);
    let Some(supply) = kits.supply() else { return specs };
    let installed: Vec<&'static KitDefinition> =
        kits.statuses().into_iter().filter(|status| status.installed).filter_map(|status| kits.definitions().find(|kit| kit.id == status.id)).collect();
    let waiting: Vec<&'static KitDefinition> = supply.available().into_iter().filter(|kit| !installed.iter().any(|known| known.id == kit.id)).collect();
    if waiting.is_empty() {
        return specs;
    }
    let names: Vec<String> = waiting.iter().map(|kit| format!("{} ({})", kit.name, kit.agent.formats)).collect();
    let note = if supply.installs() {
        format!(" A file of a kit that is not installed yet ({}) installs that kit first, which takes a moment; its own tools then appear.", names.join("; "))
    } else {
        format!(" A file of a kit that is not installed ({}) answers how the person installs it.", names.join("; "))
    };
    let on: Vec<&'static KitDefinition> = installed.iter().chain(waiting.iter()).copied().collect();
    let mut extra: Vec<KitToolSpec> = unified_offered(&on);
    if !unified() {
        extra.retain(|spec| parse_unified(&spec.name) == Some(Action::Inspect));
    }
    for spec in &mut extra {
        spec.description.push_str(&note);
    }
    if unified() {
        return extra;
    }
    specs.extend(extra);
    specs
}

/// Whether `kit` offers the tool `name` once installed (KHP A35, A41): `<prefix>_export` only
/// when it exports for the agent, `<prefix>_create` only when it creates files, the draft tools
/// only when its manifest declares drafts (`agent.drafts`), and `<prefix>_query` and
/// `<prefix>_batch` only when it has an object model (`agent.objectModel`); every other tool
/// always.
fn offers(kit: &KitDefinition, name: &str) -> bool {
    let is = |action: Action| name == tool_name(kit, action);
    (kit.agent.export.is_some() || !is(Action::Export))
        && (!kit.creates.is_empty() || !is(Action::Create))
        && (kit.agent.drafts || !(is(Action::DraftReady) || is(Action::DraftReopen)))
        && (kit.agent.object_model || !(is(Action::Query) || is(Action::Batch)))
}

/// The tools `kit` offers the agent once installed, by name (`<prefix>_inspect`, ...), as its
/// manifest declares them (KHP A3, A35, A41).
pub fn tool_names(kit: &KitDefinition) -> Vec<String> {
    Action::ALL.into_iter().map(|action| tool_name(kit, action)).filter(|name| offers(kit, name)).collect()
}

/// The action of a unified tool name (`kit_export`).
fn parse_unified(name: &str) -> Option<Action> {
    let suffix = name.strip_prefix("kit_")?;
    Action::ALL.into_iter().find(|action| action.suffix() == suffix)
}

/// The activity label of a kit tool, for example `Edit layered image in Photo`.
pub fn label(name: &str) -> Option<String> {
    let Some((kit, action)) = parse(name) else {
        // A unified tool (`kit_<action>`): one for every kit.
        let suffix = name.strip_prefix("kit_")?;
        let action = Action::ALL.into_iter().find(|action| action.suffix() == suffix)?;
        return Some(
            match action {
                Action::Inspect => "Inspect a file",
                Action::Commands => "Find a kit's commands",
                Action::Run => "Edit a file",
                Action::DraftReady => "Ask for review of the draft",
                Action::DraftReopen => "Reopen the draft",
                Action::Query => "Read a file's objects",
                Action::Batch => "Edit a file's objects",
                Action::Check => "Check a file",
                Action::Export => "Export a file",
                Action::Create => "Create a file",
            }
            .to_owned(),
        );
    };
    let (noun, kit_name) = (kit.agent.noun, short(kit));
    Some(match action {
        Action::Inspect => format!("Inspect {noun} in {kit_name}"),
        Action::Commands => format!("Find {kit_name} commands"),
        Action::Run => format!("Edit {noun} in {kit_name}"),
        Action::DraftReady => format!("Ask for review of the {kit_name} draft"),
        Action::DraftReopen => format!("Reopen the {kit_name} draft"),
        Action::Query => format!("Read {noun} objects in {kit_name}"),
        Action::Batch => format!("Edit {noun} objects in {kit_name}"),
        Action::Check => format!("Check {noun} in {kit_name}"),
        Action::Export => format!("Export {noun} from {kit_name}"),
        Action::Create => format!("Create {noun} in {kit_name}"),
    })
}

/// The instructions for a file of a kit: inspect and edit it through the kit's tools, never as
/// text. `None` when no kit opens the file.
/// Formats whose text `document_read` extracts (PDF and Office), which a kit also edits.
const TEXT_EXTRACTED: &[&str] = &["pdf", "docx", "xlsx", "pptx"];
/// Text formats a kit edits (Markdown, in the Note kit): `document_read` reads them as they are.
const PLAIN_TEXT: &[&str] = &["md", "markdown"];

pub fn linked_file_prompt(path: &str) -> Option<String> {
    let extension = path.trim().rsplit_once('.')?.1.to_ascii_lowercase();
    let kit = known().into_iter().find(|kit| kit.extensions.contains(&extension.as_str()))?;
    let (inspect, commands, run, check) =
        (tool_name(kit, Action::Inspect), tool_name(kit, Action::Commands), tool_name(kit, Action::Run), tool_name(kit, Action::Check));
    Some(
        [
            format!("Current linked {}: `{}`, open in {}.", kit.agent.noun, path.trim(), kit.name),
            format!("Call {inspect} on this path to see {} (and, with `preview: true`, a rendered preview) before describing or changing it.", kit.agent.reports),
            format!(
                "To edit it, find command ids with {commands} (search by keywords such as {}), then call {run} with the steps. {run} saves the file and returns a new preview; check it, call {check} to list what the kit finds wrong, and fix or undo (`edit.undo`) when the result is wrong.",
                kit.agent.queries
            ),
            if TEXT_EXTRACTED.contains(&extension.as_str()) {
                "document_read extracts its text for reading; edit it only through the kit tools, never with document_write, fs_read, or apply_patch.".to_owned()
            } else if PLAIN_TEXT.contains(&extension.as_str()) {
                format!(
                    "document_read reads its text as it is; edit it only through the kit tools, never with document_write, fs_read, or apply_patch. To put a generated image in it, call image_search, then insert the returned workspace-relative path as a Markdown image link such as `![Title](<Ideas/assets/image.png>)` with {run} (`text.insert`)."
                )
            } else {
                "Do not use document_read, document_write, fs_read, or apply_patch on this file: it is binary data.".to_owned()
            },
        ]
        .join("\n"),
    )
}

fn text_field(input: &Value, key: &str) -> String {
    input.get(key).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_owned()
}

/// The path from the input, which must be a file of `kit`.
pub fn kit_path(input: &Value, kit: &KitDefinition) -> Result<String, KitToolError> {
    let path = text_field(input, "path");
    if path.is_empty() {
        return Err(KitToolError::invalid("missing `path`"));
    }
    let extension = path.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase()).unwrap_or_default();
    if kit.extensions.contains(&extension.as_str()) {
        return Ok(path);
    }
    let hint = known()
        .into_iter()
        .find(|other| other.extensions.contains(&extension.as_str()))
        .map(|other| format!("; use the {}_* tools for it", other.agent.prefix))
        .unwrap_or_default();
    Err(KitToolError::invalid(format!("`{path}` is not a {} ({}){hint}", kit.agent.noun, kit.agent.formats)))
}

fn document_json(view: &DocumentView) -> Value {
    json!({
        "path": view.path,
        "summary": view.summary,
        "dirty": view.dirty,
        "canUndo": view.can_undo,
        "canRedo": view.can_redo,
        "details": view.details,
    })
}

/// A document answer without its structure (`details`): what `<prefix>_run` reports after
/// edits, so a long document's outline is not repeated on every call. `<prefix>_inspect` still
/// answers the whole of it.
fn document_summary_json(view: &DocumentView) -> Value {
    json!({
        "path": view.path,
        "summary": view.summary,
        "dirty": view.dirty,
        "canUndo": view.can_undo,
        "canRedo": view.can_redo,
    })
}

/// A `target.slide` or `target.page` that is not a whole number from 1 is an error: dropped, it
/// left inspect on the whole document and run on whatever part the kit was on. So is a
/// `target.slideId` or `target.pageId` that is not a whole number. A kit that declares its part
/// nouns (`parts`, `agent.parts`) takes each as the part's id as it lists it, even `slide` or
/// `page` ([`context::check_part`]); its `target` may name content of its kind (`range`) too.
fn check_target_part(input: &Value, parts: Option<&[&str]>) -> Result<(), KitToolError> {
    let Some(target) = input.get("target") else {
        return Ok(());
    };
    if let Some(nouns) = parts {
        let named = declared_part(target, nouns);
        return named.map_or(Ok(()), |named| context::check_part(&named, "target", parts));
    }
    for key in ["slide", "page"] {
        if let Some(value) = target.get(key)
            && value.as_u64().is_none_or(|n| n < 1)
        {
            return Err(KitToolError::invalid(format!("`target.{key}` is {value}: {key}s are counted from 1 here (the first is 1)")));
        }
        let id = format!("{key}Id");
        if let Some(value) = target.get(&id)
            && value.as_u64().is_none()
        {
            return Err(KitToolError::invalid(format!("`target.{id}` is {value}: it is the `id` the inspect tool lists for a {key}, a whole number")));
        }
    }
    Ok(())
}

/// The members of `target` that name a part by one of the kit's declared nouns (`nouns`).
fn declared_part(target: &Value, nouns: &[&str]) -> Option<Value> {
    let named: Map<String, Value> =
        target.as_object().into_iter().flatten().filter(|(key, _)| nouns.contains(&key.as_str())).map(|(key, value)| (key.clone(), value.clone())).collect();
    (!named.is_empty()).then_some(Value::Object(named))
}

/// `target.slide` or `target.page` of a `<prefix>_inspect` call, counted from 1; none for a kit
/// that declares its part nouns (`agent.parts`), whose nouns carry the part's id.
fn target_part(kit: &KitDefinition, input: &Value) -> Option<u64> {
    if kit.agent.parts.is_some() {
        return None;
    }
    numbered_part(input)
}

/// `target.slide` or `target.page`, counted from 1, as a kit that declares no part nouns takes it.
fn numbered_part(input: &Value) -> Option<u64> {
    let target = input.get("target")?;
    target.get("slide").or_else(|| target.get("page")).and_then(Value::as_u64).filter(|n| *n >= 1)
}

/// `target.slideId` or `target.pageId`: a part by its stable id, which names the same slide or
/// page after parts are added, deleted or moved, where a number names whatever is at that place.
/// None for a kit that declares its part nouns.
fn target_part_id(kit: &KitDefinition, input: &Value) -> Option<u64> {
    if kit.agent.parts.is_some() {
        return None;
    }
    part_by_id(input)
}

/// `target.slideId` or `target.pageId`, as a kit that declares no part nouns takes it.
fn part_by_id(input: &Value) -> Option<u64> {
    let target = input.get("target")?;
    target.get("slideId").or_else(|| target.get("pageId")).and_then(Value::as_u64)
}

/// How to address an inspected part again: by its stable id when the kit lists one (`id` of
/// `slide.inspect` or `page.inspect`), since a number names whatever is at that place after
/// parts are added, deleted or moved.
fn come_back(input: &Value, objects: &Value) -> String {
    let key = if input.get("target").and_then(|t| t.get("page").or_else(|| t.get("pageId"))).is_some() { "page" } else { "slide" };
    match objects.get("id").and_then(Value::as_u64) {
        Some(id) => format!(
            "to come back to it later, pass `target: {{\"{key}Id\": {id}}}` to the run tool: it names this {key} even after {key}s are added, deleted or moved, where `{{\"{key}\": n}}` names whatever {key} is n-th by then."
        ),
        None => "to come back to it later, pass the same `target` to the run tool.".to_owned(),
    }
}

/// Goes to the `target` part, by number or by id: its number (counted from 1) and the document
/// there. `Ok(None)` without a part target, or when the kit has no `slide.go` or `page.go`.
/// A kit that declares its part nouns is never sent here: its parts are set through `context.set`.
async fn resolve_part(kits: &KitManager, view: &DocumentView, input: &Value) -> Result<Option<(u64, DocumentView)>, KitToolError> {
    if let Some(part) = numbered_part(input) {
        return Ok(go_to_part(kits, view, part).await?.map(|moved| (part, moved)));
    }
    let Some(id) = part_by_id(input) else { return Ok(None) };
    let mut params = Map::new();
    params.insert("id".into(), json!(id));
    let Some(executed) = part_command(kits, view, ["slide.go", "page.go"], params, &format!("part id {id}: ")).await? else {
        return Ok(None);
    };
    let index = executed
        .result
        .as_ref()
        .and_then(|r| r.get("index"))
        .and_then(Value::as_u64)
        .ok_or_else(|| KitToolError::invalid(format!("cannot go to part id {id}: the kit did not say which part it is; use `target: {{\"slide\": n}}`")))?;
    Ok(executed.document.map(|document| (index + 1, document)))
}

/// The part members of a `target` the tools address themselves: a slide or page counted from 1, or
/// its stable id.
const PART_MEMBERS: [&str; 4] = ["slide", "page", "slideId", "pageId"];

/// The view a kit's render command ([`KitAgent::render`]) takes, read from the parameter schema the
/// kit publishes for it (`commands.list`), so a kit adds a view member (`time`, `range`,
/// `sequence`, `comp`, …) without a change here.
///
/// [`KitAgent::render`]: crate::KitAgent::render
#[derive(Clone, Debug, PartialEq)]
enum RenderView {
    /// The kit publishes no parameter schema for it (it does not list the command, or its open
    /// editor does not say): the call's `target` goes as it is, and the kit refuses what it cannot
    /// draw.
    Unknown,
    Declared {
        /// The members its `target` declares; `None` when `target` takes any member.
        members: Option<Vec<String>>,
        /// Whether it takes a `target` at all.
        target: bool,
        /// Whether it takes a part as `slide`, counted from 0, beside its `target`.
        slide: bool,
    },
}

impl RenderView {
    fn of(params: &Value) -> Self {
        let Some(properties) = params.get("properties").and_then(Value::as_object) else { return Self::Unknown };
        let target = properties.get("target");
        let members = target.and_then(|target| match target.get("properties").and_then(Value::as_object) {
            Some(members) => Some(members.keys().cloned().collect()),
            None if target.get("additionalProperties") == Some(&Value::Bool(false)) => Some(Vec::new()),
            None => None,
        });
        Self::Declared { members, target: target.is_some(), slide: properties.contains_key("slide") }
    }

    /// Whether the render command's `target` names `member`.
    fn lists(&self, member: &str) -> bool {
        matches!(self, Self::Declared { members: Some(members), .. } if members.iter().any(|listed| listed == member))
    }

    /// Whether its `target` takes members it does not name (or the kit does not say).
    fn open(&self) -> bool {
        matches!(self, Self::Unknown | Self::Declared { target: true, members: None, .. })
    }

    /// Whether a part (`slide`, `page`, `slideId`, `pageId`) it does not name goes as `slide`.
    fn takes_slide(&self) -> bool {
        matches!(self, Self::Unknown | Self::Declared { slide: true, .. })
    }

    /// The view members a call may give: those its `target` names, and the parts it takes as
    /// `slide`.
    fn accepted(&self) -> Vec<String> {
        let mut accepted = match self {
            Self::Declared { members: Some(members), .. } => members.clone(),
            _ => Vec::new(),
        };
        if self.takes_slide() {
            accepted.extend(PART_MEMBERS.iter().filter(|part| !self.lists(part)).map(|part| (*part).to_owned()));
        }
        accepted
    }
}

/// Why a call's `target` cannot go to the render command.
#[derive(Debug, PartialEq)]
enum ViewRefused {
    /// A member the render command's schema does not declare.
    Undeclared(String),
    /// A part by id the tools could not number (the kit has no `slide.go` or `page.go`).
    Unnumbered(String),
}

/// What the kit's render command draws for a call (KHP A24, A39): the call's whole `target`, as it
/// gives it, at `scale` (1 unless given) and within `maxSize`. A part member (`slide`, `page`,
/// `slideId`, `pageId`) the command's `target` does not name goes as `slide`, counted from 0 (`part`
/// is it counted from 1); any other member it does not declare is refused, never dropped
/// ([`ViewRefused`]). Without a `target` the kit draws the document framed to its content.
fn render_params(input: &Value, part: Option<u64>, view: &RenderView) -> Result<Map<String, Value>, ViewRefused> {
    let mut params = Map::new();
    let mut target = input.get("target").and_then(Value::as_object).cloned().unwrap_or_default();
    let parts: Vec<String> = target.keys().filter(|key| PART_MEMBERS.contains(&key.as_str()) && !view.lists(key)).cloned().collect();
    if let Some(first) = parts.first() {
        if view.takes_slide() {
            let part = part.ok_or_else(|| ViewRefused::Unnumbered(first.clone()))?;
            for key in &parts {
                target.remove(key);
            }
            params.insert("slide".into(), json!(part - 1));
        } else if !view.open() {
            return Err(ViewRefused::Undeclared(first.clone()));
        }
    }
    if !view.open()
        && let Some(member) = target.keys().find(|key| !view.lists(key))
    {
        return Err(ViewRefused::Undeclared(member.clone()));
    }
    if !target.is_empty() {
        params.insert("target".into(), Value::Object(target));
    }
    let scale = input.get("scale").filter(|scale| scale.is_number());
    params.insert("scale".into(), scale.cloned().unwrap_or(json!(1)));
    if let Some(size) = input.get("maxSize").filter(|size| size.is_u64()) {
        params.insert("maxSize".into(), size.clone());
    }
    Ok(params)
}

/// [`ViewRefused`] as the call's error: `invalid-params`, naming the member and the members the
/// kit's render command takes (A18, A48). Nothing was drawn.
fn view_refused(kit: &KitDefinition, command: &str, view: &RenderView, refused: ViewRefused) -> KitToolError {
    let inspect = tool_name(kit, Action::Inspect);
    match refused {
        ViewRefused::Undeclared(member) => {
            let accepted = view.accepted();
            let takes = if accepted.is_empty() {
                "it takes no `target`: call it without one for the whole document".to_owned()
            } else {
                format!("its `target` takes {}", accepted.iter().map(|member| format!("`{member}`")).collect::<Vec<_>>().join(", "))
            };
            KitToolError::invalid(format!(
                "`target.{member}` is not a view {}'s render command `{command}` (`agent.render`) draws: {takes} (its parameter schema, listed by {} with `{command}`). Nothing was drawn; call {inspect} with those members, or without `preview` to read that part as JSON.",
                short(kit),
                tool_name(kit, Action::Commands)
            ))
        }
        ViewRefused::Unnumbered(member) => KitToolError::invalid(format!(
            "cannot preview `target.{member}`: {}'s render command `{command}` takes a part by its number, and the kit has no `slide.go` or `page.go` to find it. Call {inspect} with `target: {{\"slide\": n}}` (counted from 1).",
            short(kit)
        )),
    }
}

/// What a rendered preview shows, for its caption: `part 2 of `a.kdesign``, `layer:12 of `a.kdesign``,
/// `{"time":3} of `a.kfilm``.
fn rendered_caption(kit: &KitDefinition, params: &Map<String, Value>, file: &str) -> String {
    let what = if let Some(target) = params.get("target") {
        match target.get("path").or_else(|| target.get("objectId")).and_then(Value::as_str) {
            Some(named) => format!("Preview of {named} in `{file}`"),
            None => format!("Preview of {target} in `{file}`"),
        }
    } else if let Some(slide) = params.get("slide").and_then(Value::as_u64) {
        format!("Preview of part {} of `{file}`", slide + 1)
    } else {
        format!("Preview of `{file}`")
    };
    format!("{what} from {}.", kit.name)
}

/// The shape of a value, for a message: `{change, result: {png}}`, keys two levels deep.
fn shape(value: &Value, depth: usize) -> String {
    match value {
        Value::Object(fields) if depth > 0 => {
            let keys: Vec<String> = fields
                .iter()
                .take(8)
                .map(|(key, value)| if value.is_object() && depth > 1 { format!("{key}: {}", shape(value, depth - 1)) } else { key.clone() })
                .collect();
            let more = if fields.len() > keys.len() { ", ..." } else { "" };
            format!("{{{}{more}}}", keys.join(", "))
        }
        Value::Object(_) => "{...}".to_owned(),
        Value::Array(_) => "an array".to_owned(),
        Value::String(_) => "a string".to_owned(),
        Value::Number(_) => "a number".to_owned(),
        Value::Bool(_) => "a boolean".to_owned(),
        Value::Null => "null".to_owned(),
    }
}

/// The failure of a kit's declared render command (`agent.render`), which never falls back to the
/// screenshot: the screenshot draws no `target`, so the model would see something other than what
/// it asked for and the kit's author would never learn the render command is broken (KHP A39,
/// A18). The message says what the command did and what it must answer (A48).
fn render_failure(kit: &KitDefinition, command: &str, what: &str, retryable: bool) -> KitToolError {
    let mut failure = KitToolError::new(
        ErrorCode::Failed,
        format!(
            "{} cannot preview: its render command `{command}` (`agent.render` in its kit.json) {what}. A render command takes `scale`, `maxSize`, and `target` or `slide` and answers `{{png}}`, a base64 PNG, at the top of its result. \
             Call {} without `preview` to read the document as JSON; the render command is the kit's to fix.",
            short(kit),
            tool_name(kit, Action::Inspect)
        ),
    );
    failure.retryable = retryable;
    failure
}

/// The base64 PNG a render command answered (`{png}`), decoded, and the rest of its answer: what
/// the picture shows (its size and scale, and for a timeline the frames and their times), which
/// the tools answer as `preview`. Any other answer is the render command's failure.
fn rendered_png(kit: &KitDefinition, command: &str, answer: Option<&Value>) -> Result<(Vec<u8>, Value), KitToolError> {
    use base64::Engine as _;
    let Some(answer) = answer.filter(|answer| !answer.is_null()) else {
        return Err(render_failure(kit, command, "answered nothing", false));
    };
    let Some(data) = answer.get("png").and_then(Value::as_str) else {
        return Err(render_failure(kit, command, &format!("answered `{}`, with no `png` string at the top", shape(answer, 2)), false));
    };
    let png = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| render_failure(kit, command, &format!("answered a `png` that is not base64 ({error})"), false))?;
    let shows: Map<String, Value> =
        answer.as_object().into_iter().flatten().filter(|(key, _)| *key != "png").map(|(key, value)| (key.clone(), value.clone())).collect();
    Ok((png, Value::Object(shows)))
}

/// The render command's own refusal, as a render failure: a kit that stopped or did not answer in
/// time may answer on a retry.
fn render_refused(kit: &KitDefinition, command: &str, error: KitToolError) -> KitToolError {
    render_failure(kit, command, &format!("failed: {}", error.message), error.retryable)
}

/// A preview drawn by the kit's own render command, and what it shows ([`rendered_png`]).
type Rendered = (Vec<Preview>, Value);

/// The view the kit's render command takes ([`RenderView`]), from the commands the kit lists for
/// the document.
async fn render_view(kits: &KitManager, view: &DocumentView, command: &str) -> RenderView {
    match kits.commands(Caller::Agent, view.kit_id, Some(&view.document_id), None).await {
        Ok(listed) => listed.iter().find(|listed| listed.id == command).map_or(RenderView::Unknown, |listed| RenderView::of(&listed.params)),
        Err(_) => RenderView::Unknown,
    }
}

/// [`render_view`] from the file's open editor (A7): the Kit UI protocol's `ai/commands` gives
/// each command's parameter schema as `schema`.
async fn live_render_view(kits: &KitManager, document: &LiveDocument, command: &str) -> RenderView {
    match kits.bridge().call(document, "commands", json!({ "query": command })).await {
        Ok(answer) => answer["commands"]
            .as_array()
            .and_then(|listed| listed.iter().find(|listed| listed["id"] == command))
            .and_then(|listed| listed.get("schema"))
            .map_or(RenderView::Unknown, RenderView::of),
        Err(_) => RenderView::Unknown,
    }
}

/// Whether `request` gives a `target` with members.
fn has_target(request: &Value) -> bool {
    request.get("target").and_then(Value::as_object).is_some_and(|target| !target.is_empty())
}

/// The render command's parameters for `request` (`target`, `scale`, `maxSize`): the view is
/// checked against the command's schema only when there is one to check.
async fn checked_render_params(
    kit: &KitDefinition,
    command: &str,
    request: &Value,
    part: Option<u64>,
    view: impl std::future::Future<Output = RenderView>,
) -> Result<Map<String, Value>, KitToolError> {
    let view = if has_target(request) { view.await } else { RenderView::Unknown };
    render_params(request, part, &view).map_err(|refused| view_refused(kit, command, &view, refused))
}

/// A preview drawn by the kit's own render command (KHP A24, A39) for `request` (`target`,
/// `scale`, `maxSize`, as `<prefix>_inspect` takes them; `part` is a part target's number, counted
/// from 1, when the tools know it): the call's view, never the kit's current part or time.
/// `Ok(None)` when the kit declares no render command, and its screenshot is the preview; a
/// declared one that fails or answers another shape is an error ([`render_failure`]). An inspect
/// is never an edit, whatever the kit reports about the command having changed its view.
async fn rendered_preview(
    kits: &KitManager,
    kit: &KitDefinition,
    view: &DocumentView,
    request: &Value,
    part: Option<u64>,
) -> Result<Option<Rendered>, KitToolError> {
    let Some(command) = kit.agent.render else { return Ok(None) };
    let params = checked_render_params(kit, command, request, part, render_view(kits, view, command)).await?;
    let caption = rendered_caption(kit, &params, view.path.as_deref().unwrap_or(&view.title));
    let executed = kits
        .execute(Caller::Agent, view.kit_id, &view.document_id, command, params)
        .await
        .map_err(|error| render_refused(kit, command, KitToolError::from(error)))?;
    let (png, shows) = rendered_png(kit, command, executed.result.as_ref())?;
    Ok(Some((vec![Preview { caption, png }], shows)))
}

/// [`rendered_preview`] from the file's open editor (A7), through its `ai/run`, never saved.
async fn live_rendered_preview(
    kits: &KitManager,
    kit: &KitDefinition,
    document: &LiveDocument,
    request: &Value,
    part: Option<u64>,
) -> Result<Option<Rendered>, KitToolError> {
    let Some(command) = kit.agent.render else { return Ok(None) };
    let params = checked_render_params(kit, command, request, part, live_render_view(kits, document, command)).await?;
    let caption = rendered_caption(kit, &params, &document.path);
    let answer = kits
        .bridge()
        .call(document, "run", json!({ "steps": [{ "command": command, "params": params }], "save": false }))
        .await
        .map_err(|error| render_refused(kit, command, KitToolError::from(error)))?;
    let (png, shows) = rendered_png(kit, command, export::first_result(&answer))?;
    Ok(Some((vec![Preview { caption, png }], shows)))
}

/// The objects of one slide or page, through the kit's `slide.inspect` or `page.inspect` query
/// (`{index}` counted from 0) when it has one: what an agent needs to find the object to edit.
/// What a spreadsheet or document holds, through the kit's own readers (`sheet.read`,
/// `document.inspect {text}`), cut to a size an agent can read: the content an inspect answer
/// lists, so cells and paragraphs need not be read through the object model. None for kits
/// without them, and for a slide or page target (listed as objects).
async fn part_content(kits: &KitManager, view: &DocumentView, input: &Value) -> Option<Value> {
    let target = input.get("target");
    if target.and_then(|t| t.get("slide").or_else(|| t.get("page"))).is_some() {
        return None;
    }
    let (params, asked) = content_params(target);
    if let Ok(executed) = kits.execute(Caller::Agent, view.kit_id, &view.document_id, "sheet.read", params).await
        && let Some(result) = executed.result
    {
        return Some(sheet_content(&result, asked));
    }
    let mut params = Map::new();
    params.insert("text".into(), json!(true));
    if let Ok(executed) = kits.execute(Caller::Agent, view.kit_id, &view.document_id, "document.inspect", params).await
        && let Some(blocks) = executed.result.as_ref().and_then(|r| r.get("blocks")).and_then(Value::as_array)
    {
        let span = target
            .and_then(|t| t.get("paragraphs"))
            .and_then(Value::as_array)
            .map(|a| (a.first().and_then(Value::as_u64).unwrap_or(0) as usize, a.get(1).and_then(Value::as_u64).map(|n| n as usize)));
        return Some(document_content(blocks, span));
    }
    None
}

/// The parameters of the kit's `sheet.read` for an inspect's `target` (`range`, `sheet`), and
/// whether a range was asked for.
fn content_params(target: Option<&Value>) -> (Map<String, Value>, bool) {
    let mut params = Map::new();
    let asked = target.and_then(|t| t.get("range")).and_then(Value::as_str).map(str::to_owned);
    if let Some(range) = &asked {
        params.insert("range".into(), json!(range));
    }
    // A part noun's value is the part's id as the kit lists it: a string or a whole number.
    if let Some(sheet) = target.and_then(|t| t.get("sheet")).filter(|sheet| sheet.is_string() || sheet.is_u64()) {
        params.insert("sheet".into(), sheet.clone());
    }
    (params, asked.is_some())
}

const CONTENT_ROWS: usize = 40;
const CONTENT_BLOCKS: usize = 80;

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max { text.to_owned() } else { format!("{}…", text.chars().take(max).collect::<String>()) }
}

/// `sheet.read`'s rows as `[row number, values…]` under their column letters.
fn sheet_content(read: &Value, asked: bool) -> Value {
    let range = read["range"].as_str().unwrap_or("A1");
    let start = range.split(':').next().unwrap_or("A1");
    let letters: String = start.chars().take_while(char::is_ascii_alphabetic).collect();
    let first_row: usize = start[letters.len()..].parse().unwrap_or(1);
    let first_col = letters.chars().fold(0usize, |n, c| n * 26 + (c.to_ascii_uppercase() as usize - 'A' as usize + 1));
    let column = |mut n: usize| {
        let mut out = String::new();
        while n > 0 {
            out.insert(0, (b'A' + ((n - 1) % 26) as u8) as char);
            n = (n - 1) / 26;
        }
        out
    };
    let values = read["values"].as_array().cloned().unwrap_or_default();
    let width = values.iter().filter_map(Value::as_array).map(Vec::len).max().unwrap_or(0);
    let shown = if asked { values.len() } else { values.len().min(CONTENT_ROWS) };
    let rows: Vec<Value> = values
        .iter()
        .take(shown)
        .enumerate()
        .map(|(i, row)| {
            let mut out = vec![json!(first_row + i)];
            for v in row.as_array().into_iter().flatten() {
                out.push(match v {
                    Value::String(s) => json!(cut(s, 60)),
                    other => other.clone(),
                });
            }
            Value::Array(out)
        })
        .collect();
    let mut content = json!({
        "sheet": read["sheet"],
        "range": range,
        "columns": (0..width).map(|i| column(first_col + i)).collect::<Vec<_>>(),
        "rows": rows,
    });
    if shown < values.len() {
        content["more"] = json!(format!(
            "rows {}–{} of {} shown; pass target {{\"range\": \"{}{}:...\"}} for the rest",
            first_row,
            first_row + shown - 1,
            first_row + values.len() - 1,
            letters,
            first_row + shown
        ));
    }
    content
}

/// `document.inspect`'s blocks as paragraphs: index, style, kind and text.
fn document_content(blocks: &[Value], span: Option<(usize, Option<usize>)>) -> Value {
    let (from, to) = span.unwrap_or((0, None));
    let to = to.map_or_else(|| blocks.len().min(from + CONTENT_BLOCKS), |t| (t + 1).min(blocks.len()));
    let paragraphs: Vec<Value> = blocks
        .iter()
        .skip(from)
        .take(to.saturating_sub(from))
        .map(|b| json!({ "index": b["index"], "type": b["type"], "style": b["style"], "text": cut(b["text"].as_str().unwrap_or_default(), 200) }))
        .collect();
    let mut content = json!({ "paragraphs": paragraphs, "total": blocks.len() });
    if to < blocks.len() {
        content["more"] =
            json!(format!("paragraphs {from}–{} of {} shown; pass target {{\"paragraphs\": [{to}, {}]}} for the rest", to - 1, blocks.len(), blocks.len() - 1));
    }
    content
}

/// The commands nearest an unknown id, by the words in it (`paragraph.insertAfter` searches
/// `paragraph insert after`), for the error that tells the agent the id does not exist.
async fn nearest_commands(kits: &KitManager, view: &DocumentView, id: &str) -> String {
    let mut words = String::new();
    for ch in id.chars() {
        if ch == '.' || ch == '_' || ch == '-' {
            words.push(' ');
        } else if ch.is_uppercase() {
            words.push(' ');
            words.extend(ch.to_lowercase());
        } else {
            words.push(ch);
        }
    }
    match kits.commands(Caller::Agent, view.kit_id, Some(&view.document_id), Some(&words)).await {
        Ok(found) if !found.is_empty() => {
            let near: Vec<String> = found.iter().take(5).map(|c| format!("{} {}", c.id, c.description.as_deref().unwrap_or_default())).collect();
            format!(" — nearest commands: {}", near.join("; "))
        }
        _ => String::new(),
    }
}

/// Goes to one slide or page (`{index}` counted from 0) through the kit's `slide.go` or
/// `page.go`, so that its commands, which address the part being edited, address this one.
/// The first of `commands` the kit has, run with `params` (`{index: part - 1}` or `{id}`): `Ok(None)`
/// when it has none of them, the kit's error when it has one and refuses (a part past the end, an
/// unknown id), so a missing part is said and never quietly replaced by the whole document or the
/// part the kit was on.
async fn part_command(
    kits: &KitManager,
    view: &DocumentView,
    commands: [&str; 2],
    params: Map<String, Value>,
    context: &str,
) -> Result<Option<crate::manager::ExecuteView>, KitToolError> {
    for command in commands {
        match kits.execute(Caller::Agent, view.kit_id, &view.document_id, command, params.clone()).await {
            Ok(executed) => return Ok(Some(executed)),
            Err(KitError::Kit { reason: Some(kition_kit_process_protocol::ErrorReason::CommandNotFound), .. }) => {}
            Err(error) => return Err(KitToolError::from(error).context(context)),
        }
    }
    Ok(None)
}

fn part_index(part: u64) -> Map<String, Value> {
    Map::from_iter([("index".to_owned(), json!(part - 1))])
}

async fn go_to_part(kits: &KitManager, view: &DocumentView, part: u64) -> Result<Option<DocumentView>, KitToolError> {
    let context = format!("part {part} (counted from 1): ");
    Ok(part_command(kits, view, ["slide.go", "page.go"], part_index(part), &context).await?.and_then(|executed| executed.document))
}

async fn part_objects(kits: &KitManager, view: &DocumentView, part: u64) -> Result<Option<Value>, KitToolError> {
    model::warm(kits, view).await;
    let context = format!("part {part} (counted from 1): ");
    Ok(part_command(kits, view, ["slide.inspect", "page.inspect"], part_index(part), &context).await?.and_then(|executed| executed.result))
}

/// The kit's `view.screenshot` of `view` as `request` asks (KHP A39). A failure is no preview,
/// except when the call asked for a `scale` or a `target`: the kit's refusal then fails the call
/// ([`preview_failed`]) rather than leave the model without the image it asked for.
async fn preview(kits: &KitManager, kit: &KitDefinition, view: &DocumentView, request: &PreviewRequest) -> Result<Vec<Preview>, KitToolError> {
    let file = view.path.as_deref().unwrap_or(&view.title);
    match kits.preview_of(view.kit_id, &view.document_id, request).await {
        Ok(png) => Ok(vec![Preview { caption: format!("Preview of `{file}` from {}.", kit.name), png }]),
        Err(error) if asks_more(request) => Err(preview_failed(kit, file, request, error)),
        Err(error) => {
            tracing::warn!(error = %error, kit = kit.id, "kit preview failed");
            Ok(Vec::new())
        }
    }
}

/// What `<prefix>_inspect` with `preview: true` asks a kit without a render command for (KHP
/// A39): the call's `maxSize` (1024 unless given) and `scale`, and its `target`, less the part
/// the kit already went to (`went_to_part`, through `slide.go` or `page.go`), which its
/// screenshot then draws.
fn screenshot_request(input: &Value, went_to_part: bool) -> Result<PreviewRequest, KitToolError> {
    let max_size =
        match input.get("maxSize") {
            None | Some(Value::Null) => PREVIEW_SIZE,
            Some(size) => size.as_u64().filter(|size| (16..=4096).contains(size)).and_then(|size| u32::try_from(size).ok()).ok_or_else(|| {
                KitToolError::invalid(format!("`maxSize` is {size}: the most preview pixels on the longer side, a whole number from 16 to 4096"))
            })?,
        };
    let scale = match input.get("scale") {
        None | Some(Value::Null) => None,
        Some(scale) => Some(
            scale
                .as_f64()
                .filter(|scale| scale.is_finite() && *scale > 0.0 && *scale <= 2.0)
                .ok_or_else(|| KitToolError::invalid(format!("`scale` is {scale}: preview pixels per document unit, above 0 and at most 2 (default 1)")))?,
        ),
    };
    let mut target = input.get("target").and_then(Value::as_object).cloned().unwrap_or_default();
    if went_to_part {
        for key in ["slide", "page", "slideId", "pageId"] {
            target.remove(key);
        }
    }
    Ok(PreviewRequest { max_size, scale, target: (!target.is_empty()).then_some(target) })
}

/// Whether `request` asks for more than the whole document within a size, which every kit draws.
fn asks_more(request: &PreviewRequest) -> bool {
    request.scale.is_some() || request.target.is_some()
}

/// A preview the kit could not draw as the call asked. The kit's refusal (`invalid_params`: a
/// `target`, or a scale its engine would only enlarge) is `unsupported`, with the kit's reason
/// and the call that previews instead (KHP A18, A24, A39, A48); never another image instead.
fn preview_failed(kit: &KitDefinition, file: &str, request: &PreviewRequest, error: KitError) -> KitToolError {
    let refused = matches!(&error, KitError::Kit { reason: Some(kition_kit_process_protocol::ErrorReason::InvalidParams), .. });
    if !refused {
        return KitToolError::from(error).context(&format!("{} cannot preview `{file}`: ", short(kit)));
    }
    preview_unsupported(kit, file, request, &error.to_string())
}

/// [`preview_failed`]'s `unsupported`: what the call asked, `reason`, and what to call instead.
fn preview_unsupported(kit: &KitDefinition, file: &str, request: &PreviewRequest, reason: &str) -> KitToolError {
    let inspect = tool_name(kit, Action::Inspect);
    let (what, next) = match (&request.target, request.scale) {
        (Some(target), _) => (
            format!("of `target` {}", Value::Object(target.clone())),
            format!(
                "Call {inspect} without `target` for the whole document's preview, or with `target` and without `preview` to read that part as JSON. A kit previews a target through its render command (`agent.render` in its kit.json, KHP A24, A39)."
            ),
        ),
        (None, scale) => (
            format!("at scale {}", scale.unwrap_or(1.0)),
            format!(
                "Call {inspect} without `scale` (or with a smaller one) for its preview at the scale it draws; drawing previews at scale 2 is the kit's to add (KHP A39)."
            ),
        ),
    };
    KitToolError::new(ErrorCode::Unsupported, format!("{} cannot preview `{file}` {what}: {reason}. {next}", short(kit)))
}

/// The preview of a document open in its editor (`ai/preview`, `draft` for the agent's draft
/// there), which draws the whole document at scale 1 within `maxSize`: a `scale` or `target` it
/// cannot draw is refused ([`preview_unsupported`]) before anything is drawn.
fn editor_draws(kit: &KitDefinition, file: &str, request: &PreviewRequest) -> Result<(), KitToolError> {
    if request.target.is_some() || request.scale.is_some_and(|scale| (scale - 1.0).abs() > 1e-9) {
        return Err(preview_unsupported(kit, file, request, "its open editor previews the whole document at scale 1"));
    }
    Ok(())
}

/// The editor in the renderer that has `path` open, if one does (the Kit AI bridge, A7): the
/// agent's edits then go to it, so the person sees them and they join its undo history.
pub(crate) async fn live(kits: &KitManager, kit: &KitDefinition, path: &str) -> Option<LiveDocument> {
    kits.bridge().find(path).await.filter(|document| document.kit == kit.id)
}

async fn live_preview(kits: &KitManager, kit: &KitDefinition, document: &LiveDocument, request: &PreviewRequest) -> Result<Vec<Preview>, KitToolError> {
    editor_draws(kit, &document.path, request)?;
    Ok(match kits.bridge().preview(document, request.max_size).await {
        Ok(png) => vec![Preview { caption: format!("Preview of `{}` from {}.", document.path, kit.name), png }],
        Err(error) => {
            tracing::warn!(error = %error, kit = kit.id, "live kit preview failed");
            Vec::new()
        }
    })
}

/// Runs the kit tool `name` with `input`, editing live documents. `None` when `name` is not a
/// kit tool.
pub async fn call(kits: &KitManager, name: &str, input: &Value) -> Option<KitToolResult> {
    call_with(kits, name, input, CallOptions::default()).await
}

/// Runs the kit tool `name` with `input` and the harness's `options`, as this process's agent.
pub async fn call_with(kits: &KitManager, name: &str, input: &Value, options: CallOptions) -> Option<KitToolResult> {
    call_as(kits, name, input, options, process_agent()).await
}

/// The agent of a server that does not tell its connections apart: `agent-` and a suffix drawn
/// once per process.
pub fn process_agent() -> &'static str {
    static AGENT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| format!("agent-{}", suffix()))
}

/// Four random lower-case letters and digits.
pub(crate) fn suffix() -> String {
    const DIGITS: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    (0..4).map(|_| char::from(DIGITS[usize::from(rand::random::<u8>()) % DIGITS.len()])).collect()
}

/// Runs the kit tool `name` with `input` and the harness's `options` as the agent `agent` (its
/// connection's principal, the author of its writes in the document's journal).
pub async fn call_as(kits: &KitManager, name: &str, input: &Value, options: CallOptions, agent: &str) -> Option<KitToolResult> {
    kits.in_document(kits.document_key(input), call_as_inner(kits, name, input, options, agent)).await
}

async fn call_as_inner(kits: &KitManager, name: &str, input: &Value, options: CallOptions, agent: &str) -> Option<KitToolResult> {
    let (kit, action) = parse(name).or_else(|| unified_route(name, input))?;
    // A kit that supports drafts says so in its manifest (`agent.drafts`, KHP A12), and only such
    // a kit offers the draft tools (A35) that hand a draft to the person. A call that asks another
    // kit for a draft is refused; so is an edit of it while the server makes the agent's edits
    // drafts (`--drafts`), which chose not to edit files directly: unless the call says
    // `draft: false`, nothing is changed, rather than an edit stranded in a draft no tool hands
    // over, or a file edited against the server's mode.
    let asked = input.get("draft").and_then(Value::as_bool);
    if !kit.agent.drafts && (asked == Some(true) || (asked.is_none() && options.draft && matches!(action, Action::Run | Action::Batch))) {
        let path = text_field(input, "path");
        let why = if asked == Some(true) { "so it has no draft to edit or read" } else { "and this server makes the agent's edits drafts (`--drafts`)" };
        return Some(Err(KitToolError::new(
            ErrorCode::Unsupported,
            format!(
                "{} keeps no drafts (its kit.json does not declare `agent.drafts`), {why}: nothing was changed. To edit `{path}` itself, when the person wants that, call again with `draft: false`.",
                kit.name
            ),
        )));
    }
    let draft = kit.agent.drafts && asked.unwrap_or(options.draft);
    if matches!(action, Action::Inspect | Action::Run)
        && let Err(error) = check_target_part(input, kit.agent.parts)
    {
        return Some(Err(error));
    }
    let basis = match input.get("basis") {
        None | Some(Value::Null) => None,
        Some(Value::String(basis)) if !basis.trim().is_empty() => Some(basis.trim().to_owned()),
        Some(other) => {
            return Some(Err(KitToolError::invalid(format!(
                "`basis` is {other}: the `revision` of the last answer you were given for this file (a string, for example \"qx7\")"
            ))));
        }
    };
    let writes = matches!(action, Action::Run | Action::Batch);
    let tracked = matches!(action, Action::Inspect | Action::Run | Action::Check | Action::Query | Action::Batch);
    let path = if tracked { kit_path(input, kit).ok() } else { None };
    // An agent's draft on a server that keeps headless drafts is never the open editor's (R9).
    let editor = match &path {
        Some(path) if !(draft && kits.headless_drafts()) => live(kits, kit, path).await,
        _ => None,
    };
    let in_editor = editor.is_some();
    // The document's journal: the file the headless kit edits, or the agent's headless draft
    // of it; or, for a file open in an editor that says what changed (capability `changes`, C3b),
    // the editor's document, whose edits are followed from its replica (`follow_editor`).
    let journaled = match &path {
        Some(path) if !in_editor && (!draft || kits.headless_drafts()) => kits.resolve(path).ok().map(|file| (path.clone(), file)),
        _ => None,
    };
    let followed = editor.as_ref().filter(|document| !draft && document.can("changes"));
    if writes && basis.is_some() && editor.is_some() && followed.is_none() && options.guard != Guard::Off {
        let mut error = KitToolError::new(ErrorCode::Conflict, "the open editor cannot report changes since this basis; nothing was run");
        error.output = Some(json!({"conflicts":[{"reason":"unknown"}]}));
        return Some(Err(error));
    }
    let key = match (followed, &path) {
        (Some(_), Some(path)) => kits.resolve(path).ok().map(|file| format!("{}{}", file.display(), journal::EDITOR)),
        _ => journaled.as_ref().map(|(_, file)| format!("{}{}", file.display(), if draft { journal::DRAFT } else { "" })),
    };
    if writes && options.require_basis && basis.is_none() && key.is_some() {
        return Some(Err(KitToolError::invalid(format!(
            "this server takes a write only with `basis` (`--require-basis`): pass the `revision` of the last answer you were given for `{}` (every inspect, query, run and batch answers one; call {} for one now). Nothing was run.",
            path.as_deref().unwrap_or_default(),
            tool_name(kit, Action::Inspect)
        ))));
    }
    // A file the agent edits headless (no draft, no open editor): changes made outside its calls.
    let watched = if draft { None } else { journaled.clone() };
    if let Some((path, file)) = &watched
        && outside::known(file)
        && (outside::moved(file) || served(kits, path).await.is_some_and(|now| Some(now) != outside::last_served(file)))
    {
        outside_change(kits, path, file, key.as_deref()).await;
    }
    let mut notice = None;
    if let Some((_, file)) = &watched {
        if basis.is_some() {
            // Told what others changed (`others`) instead.
            outside::clear(file);
        } else if writes {
            if let Some(found) = outside::take_refusal(file) {
                let what = if action == Action::Run { "run" } else { "batch" };
                let mut refused = KitToolError::new(ErrorCode::Failed, format!("{} Nothing was run; {what} it again with the right target.", found.summary));
                refused.retryable = true;
                refused.output = Some(json!({ "changedOutside": found.detail }));
                return Some(Err(refused));
            }
        } else {
            notice = outside::take_report(file);
        }
    }
    let revision_before = key.as_ref().map(|key| kits.inner.journals.revision(key));
    let version_before = match (followed, &key) {
        (Some(document), Some(key)) => follow_editor(kits, document, key).await,
        _ => None,
    };
    if followed.is_some()
        && let Some(key) = &key
    {
        let notice_key = std::path::Path::new(key);
        if revision_before.as_deref() != Some(&kits.inner.journals.revision(key)) {
            outside::note(
                notice_key,
                &outside::Outside {
                    summary: "the editor changed outside your calls; inspect again before editing".into(),
                    detail: json!({"path":path,"now":"editor changed"}),
                },
            );
        }
        if basis.is_some() {
            outside::clear(notice_key);
        } else if writes {
            if let Some(found) = outside::take_refusal(notice_key) {
                let mut error = KitToolError::new(ErrorCode::Failed, found.summary);
                error.retryable = true;
                error.output = Some(json!({"changedOutside":found.detail}));
                return Some(Err(error));
            }
        } else {
            notice = outside::take_report(notice_key);
        }
    }
    if let (Some(document), Some(key)) = (followed.filter(|document| document.can("premises")), &key) {
        let state = guard::Reader::Editor(document)
            .context(kits, "state", Map::new())
            .await
            .ok()
            .flatten()
            .and_then(|answer| answer.get("state").cloned())
            .unwrap_or(Value::Null);
        kits.inner.journals.observe_state(key, state);
        inputs::observe_from(kits, key, guard::Reader::Editor(document)).await;
        derived::capture_from(kits, key, guard::Reader::Editor(document)).await;
        history::capture_from(kits, key, guard::Reader::Editor(document)).await;
    }
    if let (Some(key), Some(path)) = (&key, &path)
        && !in_editor
    {
        let view = if draft {
            match drafts::document(kits, kit, path, writes).await {
                Ok(id) => kits.document(Caller::Agent, kit.id, &id).await,
                Err(error) => return Some(Err(error)),
            }
        } else {
            kits.open(Caller::Agent, path).await
        };
        if let Ok(view) = view {
            let state = match context::save(kits, view.kit_id, &view.document_id).await {
                Ok(context::Saved::State(state)) => state,
                _ => Value::Null,
            };
            kits.inner.journals.observe_state(key, state);
            inputs::observe(kits, key, &view).await;
            history::capture(kits, key, &view).await;
            derived::capture(kits, key, &view).await;
        }
    }
    // What others changed since `basis`, and the guard on a write.
    let since = match (&basis, &key) {
        (Some(basis), Some(key)) => Some(kits.inner.journals.since(key, basis)),
        _ => None,
    };
    let others: Vec<journal::Entry> = match &since {
        Some(journal::Since::Covered(entries)) => entries.iter().filter(|entry| entry.author != agent).cloned().collect(),
        _ => Vec::new(),
    };
    let resolved_input;
    let input = if action == Action::Batch
        && let Some(key) = &key
    {
        resolved_input = guard::remap_batch(input, &kits.inner.journals.references(key));
        &resolved_input
    } else {
        input
    };
    let told = match (others.is_empty(), &path) {
        (false, Some(path)) => Some(told(kits, kit, path, draft, followed, &others, input).await),
        _ => None,
    };
    if writes && let (Some(key), Some(path)) = (&key, &path) {
        let grant = kits.inner.history.grant(kit.id, key, basis.as_deref().unwrap_or_default());
        let refusal = match history::TOKEN
            .scope(grant.token.clone(), guarded(kits, kit, action, input, path, key, draft, followed, since.as_ref(), &others, options.guard, agent))
            .await
        {
            Ok(None) if action == Action::Run => undo_refusal(kits, key, input, agent),
            Ok(other) => other,
            Err(error) => return Some(Err(error)),
        };
        if let Some((message, conflicts)) = refusal {
            // A target whose id another program renumbered (`unknown` with an id): the revision
            // handed back is the agent's own basis, so a retry is refused again until a read gives
            // the agent the ids as they are now. Any later revision would make the stale id current.
            let revision = match &basis {
                Some(basis) if conflicts.iter().any(guard::Conflict::is_renumbered) => basis.clone(),
                _ => kits.inner.journals.revision(key),
            };
            let form = receipts::IdForm::of(kits.described(kit.id).as_ref());
            let conflicts: Vec<Value> = conflicts
                .iter()
                .map(|shown| {
                    let mut json = shown.to_json();
                    form.conflict(&mut json, shown.ty.as_deref());
                    json
                })
                .collect();
            let mut output = json!({ "conflicts": conflicts, "revision": revision });
            if let Some(told) = &told {
                output["others"] = told.clone();
            }
            let mut refused = KitToolError::new(ErrorCode::Conflict, message);
            refused.retryable = true;
            return Some(Err(refused.with_output(output)));
        }
    }
    let call = std::sync::Arc::new(CallContext {
        agent: agent.to_owned(),
        recorded: std::sync::Mutex::new(None),
        version: std::sync::Mutex::new(None),
        version_before,
    });
    let answer = CALL
        .scope(std::sync::Arc::clone(&call), async {
            match action {
                Action::Inspect => inspect(kits, kit, input, draft).await,
                Action::Commands => commands(kits, kit, input).await,
                Action::Run if draft => run_on_draft(kits, kit, input).await,
                Action::Run => run_steps(kits, kit, input).await,
                Action::DraftReady | Action::DraftReopen => draft_state(kits, kit, input, action).await,
                Action::Query => model::query(kits, kit, input, draft).await,
                Action::Batch => model::batch(kits, kit, input, draft).await,
                Action::Check => check(kits, kit, input, draft).await,
                Action::Export => export::export(kits, kit, input, draft).await,
                Action::Create => create(kits, kit, input).await,
            }
        })
        .await;
    let closed = answer.as_ref().is_ok_and(|out| out.output["closed"] == true);
    if !closed && let Some((path, file)) = &watched {
        let summary = answer.as_ref().ok().and_then(|out| out.output.get("summary").or_else(|| out.output["document"].get("summary"))).and_then(Value::as_str);
        outside::remember(file, summary);
        outside::served(file, served(kits, path).await);
    }
    let recorded = call.recorded.lock().ok().and_then(|mut recorded| recorded.take());
    let version_after = call.version.lock().ok().and_then(|mut version| version.take());
    Some(match answer {
        Ok(mut out) => {
            if let Some(key) = &key {
                if !closed
                    && !in_editor
                    && let Some(path) = &path
                    && let Some(view) = kits.held(Caller::Agent, path).await
                {
                    inputs::observe(kits, key, &view).await;
                }
                let revision = if writes { journal_write(kits, key, action, &out.output, recorded, agent) } else { Some(kits.inner.journals.revision(key)) };
                if !closed
                    && writes
                    && !in_editor
                    && let Some(path) = &path
                    && let Some(view) = kits.held(Caller::Agent, path).await
                {
                    history::capture(kits, key, &view).await;
                    derived::capture(kits, key, &view).await;
                }
                // The agent's write is in the journal: the editor's replica is followed from after it.
                if !closed
                    && writes
                    && let Some(document) = followed
                {
                    let after = match version_after {
                        Some(version) => Some(version),
                        None => editor_version(kits, document).await,
                    };
                    kits.inner.journals.set_seen(key, after);
                    if let Some(objects) = derived::editor_snapshot(kits, document).await {
                        kits.inner.history.remember_snapshot(key, &kits.inner.journals.revision(key), objects);
                    }
                    if document.can("premises") {
                        derived::capture_from(kits, key, guard::Reader::Editor(document)).await;
                        inputs::observe_from(kits, key, guard::Reader::Editor(document)).await;
                        history::capture_from(kits, key, guard::Reader::Editor(document)).await;
                    }
                }
                if let Some(revision) = revision.filter(|_| action != Action::Check) {
                    out.output["revision"] = json!(revision);
                }
            } else if basis.is_some() && in_editor {
                out.output["guardUnavailable"] = json!(format!(
                    "the file is open in its {} editor, whose edits this server does not journal yet: what others changed is not known and the write was not checked against it",
                    short(kit)
                ));
            }
            if let Some(told) = told {
                out.summary.push_str(&others_summary(&told));
                out.output["others"] = told;
            }
            if action == Action::Inspect {
                out.output["interface"] = json!(interface(kit));
            }
            if let Some(found) = notice {
                out.summary = format!("{}\n{}", found.summary, out.summary);
                out.output["changedOutside"] = found.detail;
            }
            Ok(out)
        }
        Err(mut failure) => {
            if let Some(told) = told {
                let mut output = match failure.output.take() {
                    Some(Value::Object(fields)) => Value::Object(fields),
                    Some(other) => json!({ "output": other }),
                    None => json!({}),
                };
                output["others"] = told;
                failure.output = Some(output);
            }
            Err(failure)
        }
    })
}

/// What others changed since the call's `basis` (`others`): their entries merged, a shift of
/// many objects stated once with the lists the document holds now, capped, integer tool ids as
/// numbers ([`guard::merged`]).
async fn told(
    kits: &KitManager,
    kit: &'static KitDefinition,
    path: &str,
    draft: bool,
    editor: Option<&LiveDocument>,
    others: &[journal::Entry],
    input: &Value,
) -> Value {
    let first = guard::Told::new(kit.agent.parts, input);
    let others: Vec<&journal::Entry> = others.iter().collect();
    let view = match (editor, draft) {
        (None, false) => kits.open(Caller::Agent, path).await.ok(),
        _ => None,
    };
    let source = match (editor, &view) {
        (Some(document), _) => Some(receipts::Source::Editor(document)),
        (None, Some(view)) => Some(receipts::Source::Kit { kit_id: view.kit_id, document_id: &view.document_id }),
        _ => None,
    };
    let described = match source {
        Some(source) => source.described(kits).await,
        None => kits.described(kit.id),
    };
    // `changes: "all"` tells every value of what others created too.
    let full = input.get("changes").and_then(Value::as_str) == Some("all");
    guard::merged(kits, source, described.as_ref(), &others, &first, full).await
}

/// The document of `path` the kit holds, and its object model's version: what this server served
/// at the end of a call, so the next one can tell whether the kit still holds that state.
async fn served(kits: &KitManager, path: &str) -> Option<(String, String)> {
    let (kit_id, document_id) = kits.held_id(Caller::Agent, path).await?;
    let version = model_version(kits, kit_id, &document_id).await?;
    Some((document_id, version))
}

/// The object model's version of a kit session's document (`model.version`), if it has one.
async fn model_version(kits: &KitManager, kit_id: &str, document_id: &str) -> Option<String> {
    let answer = kits.model(Caller::Agent, kit_id, document_id, "model.version", Map::new()).await.ok()?;
    answer["version"].as_str().map(str::to_owned)
}

/// The file `file` (the agent's `path`) changed since the agent's last call on it ended: the kit
/// reads it again, once, and what changed goes into the document's journal (`key`), by `outside`.
///
/// What changed is the difference between the document as this server last served it and as the
/// kit reads the file now. The kit still holds the first until it reads the file again, so it is
/// read from the document the kit holds, before anything asks the kit to open the file (a kit may
/// read a clean document again when it is opened and its file changed, as kition-headless does,
/// and the two reads would then be of the new file). It is that state only when the kit holds the
/// same document at the same object-model version as at the end of the server's last call;
/// otherwise what changed is unknown, except that an opted-in blob document may have a bounded
/// latest model checkpoint for a session which has already closed.
/// The two reads are compared by pairing their objects, not by object id (`kition_kdm::reread`):
/// a kit that builds its replica from its file gives new object ids on every read.
///
/// A document with unsaved edits keeps them (saving it is then a conflict) and what changed is
/// unknown. A read that finds nothing changed (a file saved again as it was) is no change: no
/// entry, nothing reported or refused.
async fn outside_change(kits: &KitManager, path: &str, file: &std::path::Path, key: Option<&str>) {
    let held = kits.held(Caller::Agent, path).await;
    let last = outside::last_served(file);
    // A local editor transaction can advance the replica while the saved file stays put.
    // Preserve its undo history and use that replica's change stream before considering a reread.
    if !outside::moved(file)
        && let (Some(view), Some((document, since)), Some(key)) = (&held, &last, key)
        && document == &view.document_id
        && let Ok(found) = kits.model(Caller::Agent, view.kit_id, &view.document_id, "model.changes", Map::from_iter([("since".into(), json!(since))])).await
        && let Some(mut changes) = found.get("changes").filter(|changes| changes.is_object()).cloned()
    {
        derived::privatize(&mut changes, kits.described(view.kit_id).as_ref());
        carried::mark(kits, view.kit_id, &view.document_id, &mut changes).await;
        if !guard::is_nothing(&changes) {
            kits.inner.journals.append(key, journal::PERSON, Some(changes));
        }
        outside::served(file, served(kits, path).await);
        return;
    }
    let (view, before, reread) = match held {
        Some(view) if view.dirty => (Some(view), None, false),
        Some(view) => {
            let current = model_version(kits, view.kit_id, &view.document_id).await.map(|version| (view.document_id.clone(), version));
            let snapshot = key.and_then(|key| kits.inner.history.snapshot(&kits.inner.journals, key));
            let before = if current.is_some() && current == last {
                if let Some(key) = key {
                    history::capture(kits, key, &view).await;
                }
                let read = guard::objects(kits, &view).await;
                // The kit may read the file again on its own while these reads run (it handles
                // `document.didChangeOnDisk` on the host's connection, these come on the agent's):
                // what they read is the state last served only if the version did not move.
                let still = model_version(kits, view.kit_id, &view.document_id).await.map(|version| (view.document_id.clone(), version));
                if still == current {
                    read
                } else {
                    if let Some(key) = key {
                        kits.inner.history.restore_snapshot(&kits.inner.journals, key, snapshot.clone());
                    }
                    snapshot
                }
            } else {
                snapshot
            };
            match kits.reload(view.kit_id, &view.document_id).await {
                Ok(read) => (Some(read), before, true),
                Err(_) => (Some(view), None, false),
            }
        }
        None => {
            let before = key.and_then(|key| kits.inner.history.snapshot(&kits.inner.journals, key));
            (kits.open(Caller::Agent, path).await.ok(), before, true)
        }
    };
    let Some(view) = view else { return };
    let found = outside::changed(file, path, &view.summary).unwrap_or_else(|| outside::Outside {
        summary: format!("`{path}` was reloaded outside your calls. Inspect it again before editing."),
        detail: json!({"path":path,"now":view.summary,"reloaded":true}),
    });
    let after = match &before {
        Some(_) => guard::objects(kits, &view).await,
        None => None,
    };
    let changes = match before.zip(after) {
        Some((before, after)) => {
            // The root's object id in each read: entries before this one name the parts' list by
            // the first (`guard::conflicts`).
            let roots: Vec<String> = [&before, &after].iter().filter_map(|objects| guard::root_of(kits, &view, objects)).collect();
            // Both reads carry the derived values (`~<name>` fields): the change set tells them.
            let derived = |objects: &Map<String, Value>| {
                objects.values().any(|object| object.as_object().is_some_and(|fields| fields.keys().any(|field| field.starts_with(derived::MARK))))
            };
            let told = derived(&before) && derived(&after);
            let objects: Vec<Value> = after.keys().cloned().map(Value::String).collect();
            let mut changes = guard::compared(kits, &view, before, after).await;
            if let Some(pairs) = changes.as_object_mut().and_then(|changes| changes.remove("$references"))
                && let Some(key) = key
            {
                kits.inner.journals.remember_references(key, &pairs);
            }
            // What the changes carry.
            carried::mark(kits, view.kit_id, &view.document_id, &mut changes).await;
            if guard::is_nothing(&changes) {
                let unproven = guard::unproven_identities(kits, &view, &objects).await;
                if !unproven.is_empty() {
                    changes["$identity"] = json!(unproven);
                }
            }
            if !guard::is_nothing(&changes) {
                changes["roots"] = json!(roots);
                if told {
                    changes["derived"] = json!(true);
                }
            }
            Some(changes)
        }
        None => None,
    };
    // What the kit holds now is what this call starts from, whether it then runs or is refused.
    outside::remember(file, Some(&view.summary));
    outside::served(file, served(kits, path).await);
    if let Some(key) = key {
        if reread {
            kits.inner.journals.forget_undo(key);
        }
        if changes.as_ref().is_some_and(guard::is_nothing) {
            return;
        }
        kits.inner.journals.append(key, journal::OUTSIDE, changes);
    }
    outside::note(file, &found);
}

/// What a tool call carries down to the code that answers it: the agent, the change set a
/// write recorded for the document's journal, and the open editor's replica version after it
/// (C3b).
pub(crate) struct CallContext {
    pub(crate) agent: String,
    pub(crate) recorded: std::sync::Mutex<Option<receipts::Recorded>>,
    pub(crate) version: std::sync::Mutex<Option<String>>,
    /// The open editor's replica version the journal was brought up to before the call (C3b).
    pub(crate) version_before: Option<String>,
}

tokio::task_local! {
    pub(crate) static CALL: std::sync::Arc<CallContext>;
}

/// Records what the running call's write changed ([`receipts::add`]).
pub(crate) fn record(recorded: receipts::Recorded) {
    let _ = CALL.try_with(|call| {
        if let Ok(mut slot) = call.recorded.lock() {
            *slot = Some(recorded);
        }
    });
}

/// Records the open editor's replica version after the running call's write (C3b), as the change
/// set's answer gave it.
pub(crate) fn saw_version(version: String) {
    let _ = CALL.try_with(|call| {
        if let Ok(mut slot) = call.version.lock() {
            *slot = Some(version);
        }
    });
}

/// The open editor's replica version the running call's journal was brought up to before it (C3b):
/// what its receipt compares against, read once.
pub(crate) fn version_before() -> Option<String> {
    CALL.try_with(|call| call.version_before.clone()).ok().flatten()
}

/// The open editor's replica version now (the bridge's `version`), if it answers one.
async fn editor_version(kits: &KitManager, document: &LiveDocument) -> Option<String> {
    kits.bridge().call(document, "version", json!({})).await.ok()?["version"].as_str().map(str::to_owned)
}

/// Brings the journal `key` of a file open in its editor up to the editor's replica (C3b). What
/// changed since the version it is up to was made by no call of this server (each write moves it
/// past its own change), so it is someone else's: an entry by `person` when the editor reported
/// the document's last change as the person's (`kit.changed`), else by `other`, with the change
/// set the editor answers, or unknown when it answers none. A journal that cannot follow the
/// editor (no version now, or none before though it has entries) records an unknown change, so a
/// basis from before it is refused rather than trusted. Answers the version it is up to now.
async fn follow_editor(kits: &KitManager, document: &LiveDocument, key: &str) -> Option<String> {
    let journals = &kits.inner.journals;
    let was = journals.seen(key);
    let before = kits.inner.history.snapshot(journals, key);
    let Some(now) = editor_version(kits, document).await else {
        journals.append(key, journal::OTHER, None);
        journals.set_seen(key, None);
        return None;
    };
    let author = match kits.bridge().last_change(&document.path) {
        Some((_, by)) if by == journal::PERSON => journal::PERSON,
        _ => journal::OTHER,
    };
    let after = derived::editor_snapshot(kits, document).await;
    match was {
        Some(was) if was == now => {}
        Some(was) => {
            let found = kits.bridge().call(document, "changes", json!({ "since": was })).await.ok();
            let author = if found.as_ref().is_some_and(|found| found["by"] == journal::OUTSIDE) { journal::OUTSIDE } else { author };
            let mut changes = found.and_then(|found| found.get("changes").filter(|changes| changes.is_object()).cloned());
            if author == journal::OUTSIDE
                && let (Some(before), Some(after)) = (&before, &after)
            {
                let mut compared = guard::compared_from(kits, guard::Reader::Editor(document), before.clone(), after.clone()).await;
                let described = kits.described(&document.kit);
                let roots: Vec<_> = [before, after]
                    .into_iter()
                    .filter_map(|objects| {
                        let root = described.as_ref()?["root"].as_str()?;
                        objects.iter().find(|(_, object)| object["$type"] == root).map(|(id, _)| id.clone())
                    })
                    .collect();
                compared["roots"] = json!(roots);
                if guard::is_nothing(&compared) {
                    let objects: Vec<_> = after.keys().map(|id| json!(id)).collect();
                    let answer = guard::Reader::Editor(document).context(kits, "identity", Map::from_iter([("objects".into(), json!(objects))])).await;
                    let unproven = answer.ok().flatten().and_then(|answer| answer["unproven"].as_array().cloned()).unwrap_or(objects);
                    if !unproven.is_empty() {
                        compared["$identity"] = json!(unproven);
                    }
                }
                changes = Some(compared);
            }
            if changes
                .as_mut()
                .is_some_and(|changes| receipts::projected_changes(kits.described(&document.kit).as_ref(), before.as_ref(), after.as_ref(), changes).is_err())
            {
                changes = None;
            }
            if let Some(changes) = &mut changes {
                derived::editor_changes(before.as_ref(), after.as_ref(), changes);
                derived::privatize(changes, kits.described(&document.kit).as_ref());
                carried::mark_from(kits, receipts::Source::Editor(document), changes).await;
                if let Some(pairs) = changes.as_object_mut().and_then(|changes| changes.remove("$references")) {
                    journals.remember_references(key, &pairs);
                }
            }
            let nothing = changes.as_ref().is_some_and(guard::is_nothing);
            if !nothing {
                journals.append(key, author, changes);
            }
        }
        None if journals.has_entries(key) => {
            journals.append(key, author, None);
        }
        None => {}
    }
    journals.set_seen(key, Some(now.clone()));
    if let Some(after) = after {
        kits.inner.history.remember_snapshot(key, &journals.revision(key), after);
    }
    Some(now)
}

/// The agent the running call is made for, if a tool call is running.
pub(crate) fn current_agent() -> Option<String> {
    CALL.try_with(|call| call.agent.clone()).ok()
}

/// One line on the protocol and the kit an inspect answers (`khp/1 kit.slide@1.4.0`): the
/// interface the tools' ids and commands are of, as `serverInfo` reports its version.
fn interface(kit: &KitDefinition) -> String {
    format!("khp/{} {}@{}", kition_kit_process_protocol::PROTOCOL_VERSION, kit.id, kit.version)
}

/// ` Others changed 3 objects since your basis (by outside).`, and the renumbering line.
fn others_summary(told: &Value) -> String {
    let count = |list: &str| told[list].as_array().map_or(0, Vec::len) as u64 + told["truncated"][list].as_u64().unwrap_or(0);
    let total: u64 = ["created", "changed", "moved", "deleted"].iter().map(|list| count(list)).sum();
    let by: Vec<&str> = told["by"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let renumbered = told["renumbered"].as_str().map(|line| format!(" Beware: {line}.")).unwrap_or_default();
    format!(" Others changed {total} object(s) since your basis (by {}): see `others`.{renumbered}", by.join(", "))
}

/// Adds a successful write to the document's journal by `agent`, with the agents' undo
/// history; answers the revision the result carries (none for a kit without an object model).
fn journal_write(kits: &KitManager, key: &str, action: Action, output: &Value, recorded: Option<receipts::Recorded>, agent: &str) -> Option<String> {
    let journals = &kits.inner.journals;
    let steps: Vec<(Option<bool>, bool)> = if action == Action::Run {
        output["completed"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|step| {
                let undo = match step["command"].as_str() {
                    Some("edit.undo") => Some(true),
                    Some("edit.redo") => Some(false),
                    _ => None,
                };
                (undo, step["changed"] != false)
            })
            .collect()
    } else {
        vec![(None, true)]
    };
    let changed_any = steps.iter().any(|(_, changed)| *changed);
    let (changes, revision) = match recorded {
        Some(receipts::Recorded::Changes(changes)) => {
            let empty = ["created", "changed", "moved", "deleted"].iter().all(|list| changes[*list].as_array().is_none_or(Vec::is_empty));
            (if empty { None } else { Some(Some(changes)) }, true)
        }
        Some(receipts::Recorded::Unknown) => (changed_any.then_some(None), true),
        Some(receipts::Recorded::NoModel) => (changed_any.then_some(None), false),
        None => (None, true),
    };
    if let Some(changes) = changes {
        journals.append(key, agent, changes);
        for (undo, changed) in steps {
            if undo.is_some() || changed {
                journals.note_step(key, agent, undo);
            }
        }
    }
    revision.then(|| journals.revision(key))
}

/// A refusal: what to tell the agent, and the conflicts.
type Refusal = (String, Vec<guard::Conflict>);

/// The guard on a write that passes `basis`: `Ok(None)` when it may run.
#[allow(clippy::too_many_arguments)]
async fn guarded(
    kits: &KitManager,
    kit: &'static KitDefinition,
    action: Action,
    input: &Value,
    path: &str,
    key: &str,
    draft: bool,
    editor: Option<&LiveDocument>,
    since: Option<&journal::Since>,
    others: &[journal::Entry],
    mode: Guard,
    agent: &str,
) -> Result<Option<Refusal>, KitToolError> {
    let batch_ops = input.get("ops").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    if action == Action::Batch
        && batch_ops.iter().any(|op| op["op"] != "command")
        && (editor.is_none() || kit.agent.object_model || kits.described(kit.id).is_some())
    {
        let owned;
        let reader = match editor {
            Some(document) => guard::Reader::Editor(document),
            None => {
                owned = if draft {
                    kits.document(Caller::Agent, kit.id, &drafts::document(kits, kit, path, false).await?).await?
                } else {
                    kits.open(Caller::Agent, path).await?
                };
                guard::Reader::Kit(&owned)
            }
        };
        match guard::batch_contract(kits, reader, batch_ops).await {
            Ok(_) => {}
            Err(guard::ContractError::Invalid(error)) => return Err(error),
            Err(guard::ContractError::Missing) => {
                return Ok(Some((
                    "the kit declares no premise contract for this raw batch operation; nothing was run".into(),
                    vec![guard::Conflict::unknown()],
                )));
            }
        }
    }
    let Some(since) = since else { return Ok(None) };
    let ops = batch_ops;
    let needs_acts = action == Action::Run || action == Action::Batch;
    // A step or operation whose parameters the command's schema refuses is the kit's to refuse
    // (`invalid-params`), never a conflict: checked first, as the kit would.
    let refuse_unknown = |acts: &std::collections::HashMap<String, context::Acts>| -> Result<(), KitToolError> {
        let steps = input.get("steps").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        let named = |item: &Value, key: &str| item.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        let calls: Vec<(String, Option<&Value>)> = match action {
            Action::Run => steps.iter().map(|step| (named(step, "command"), step.get("params"))).collect(),
            _ => ops.iter().filter(|op| op.get("op").and_then(Value::as_str) == Some("command")).map(|op| (named(op, "id"), op.get("params"))).collect(),
        };
        for (index, (command, params)) in calls.iter().enumerate() {
            if let Some(declared) = acts.get(command) {
                declared
                    .refuse_unknown(command, *params)
                    .map_err(|error| if action == Action::Run { error.at(Some(index)).context(&format!("step {index}: ")) } else { error })?;
            }
        }
        if action == Action::Run {
            context::plan(steps, input.get("target"), acts, true, kit.agent.parts)?;
        }
        Ok(())
    };
    let owned;
    let reader = match editor {
        Some(document) => guard::Reader::Editor(document),
        None => {
            owned = if draft {
                kits.document(Caller::Agent, kit.id, &drafts::document(kits, kit, path, false).await?).await?
            } else {
                kits.open(Caller::Agent, path).await?
            };
            guard::Reader::Kit(&owned)
        }
    };
    let acts = if needs_acts {
        match editor {
            Some(document) => live_acts(kits, document).await?,
            None => match reader {
                guard::Reader::Kit(view) => context::acts_by_id(&kits.commands(Caller::Agent, view.kit_id, Some(&view.document_id), None).await?),
                _ => unreachable!("headless guard reader"),
            },
        }
    } else {
        Default::default()
    };
    refuse_unknown(&acts)?;
    let inspect = tool_name(kit, Action::Inspect);
    let entries = match since {
        journal::Since::Unknown(why) => {
            if mode == Guard::Off {
                return Ok(None);
            }
            return Ok(Some((
                format!("{why}. Nothing was run: call {inspect} to see `{path}` as it is now, then pass its `revision` as `basis`."),
                vec![guard::Conflict::unknown()],
            )));
        }
        journal::Since::Covered(entries) => entries,
    };
    if mode == Guard::Off {
        return Ok(None);
    }
    let by: Vec<&str> = others.iter().map(|entry| entry.author.as_str()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    if others.iter().any(|entry| entry.changes.is_none()) {
        return Ok(Some((
            format!(
                "`{path}` changed since your basis (by {}) in a way this server cannot describe object by object. Nothing was run: call {inspect} to see it as it is now, then decide again and pass its `revision` as `basis`.",
                by.join(", ")
            ),
            vec![guard::Conflict::unknown()],
        )));
    }
    if mode == Guard::Epoch && !others.is_empty() {
        return Ok(Some((
            format!(
                "`{path}` changed since your basis (by {}): this server refuses any write after another's (`--guard epoch`). Nothing was run: look at `others`, then decide again and pass the `revision` this answer gives as `basis`.",
                by.join(", ")
            ),
            vec![guard::Conflict::of(None, "changed", None)],
        )));
    }
    let remapped_entries = guard::remap_entries(entries, &kits.inner.journals.references(key));
    let entries = remapped_entries.as_slice();
    let premises_of = |acts: &std::collections::HashMap<String, context::Acts>| {
        if action == Action::Run {
            let steps = input.get("steps").and_then(Value::as_array).cloned().unwrap_or_default();
            guard::Premises::of_run(&steps, input.get("target"), acts, kit.agent.parts)
        } else {
            guard::Premises::of_batch(ops, acts)
        }
    };
    let premises = premises_of(&acts);
    let conflicts = if premises.reads_state() && kits.inner.journals.state(key).is_none() {
        vec![guard::Conflict::unknown().because(guard::Unavailable::State)]
    } else {
        let basis = input["basis"].as_str().and_then(|basis| kits.inner.derived.history(kits, key, basis, agent));
        if action == Action::Batch {
            guard::batch_conflicts(kits, reader, (ops, &acts), entries, agent, kits.inner.journals.inputs(key).as_ref(), basis.as_ref()).await
        } else {
            guard::conflicts(kits, reader, &premises, entries, agent, kits.inner.journals.inputs(key).as_ref(), basis.as_ref()).await
        }
    };
    if conflicts.is_empty() {
        return Ok(None);
    }
    let listed: Vec<String> = conflicts
        .iter()
        .map(|conflict| {
            let said = match &conflict.id {
                Some(id) if conflict.place.as_ref().is_some_and(|place| place["content"] == "deleted") => format!("held content of `{id}` deleted"),
                Some(id) => format!("`{id}` {}", conflict.reason),
                None => conflict.reason.to_owned(),
            };
            match &conflict.place {
                Some(place) if place["selector"].is_string() => format!(
                    "entry `{}` in `{}` {}",
                    place["selector"].as_str().unwrap_or_default(),
                    conflict.id.as_deref().unwrap_or("document"),
                    conflict.reason
                ),
                Some(place) => {
                    let mut named = place.clone();
                    let under = named.as_object_mut().and_then(|named| named.remove("under")).unwrap_or(Value::Null);
                    if let Some(named) = named.as_object_mut() {
                        named.remove("unknown");
                    }
                    match under {
                        Value::Null => format!("{said} (a step names what it acts on by its place {named}, and the kit cannot say what is there now)"),
                        under => format!("{said} (a step names what it acts on by its place {named}, where {under} is now)"),
                    }
                }
                None => said,
            }
        })
        .collect();
    let message = if conflicts.iter().any(|conflict| conflict.reason == "unknown") {
        let explanations = conflicts
            .iter()
            .filter(|conflict| conflict.reason == "unknown")
            .map(|conflict| {
                let detail = conflict.explanation();
                conflict.id.as_ref().map_or(detail.clone(), |id| format!("`{id}`: {detail}"))
            })
            .collect::<Vec<_>>()
            .join("; ");
        let retry = if conflicts.iter().any(guard::Conflict::is_renumbered) {
            " The revision in this refusal preserves your basis; inspect to obtain a fresh revision."
        } else {
            ""
        };
        format!(
            "Cannot establish this write's premises in `{path}`: {explanations}. Nothing was run: call {inspect} to see it as it is now, then pass its `revision` as `basis`.{retry}"
        )
    } else {
        format!(
            "Others ({}) changed what this write acts on since your basis: {}. Nothing was run. Look at `others` and `conflicts` (`now` says where an object is now), decide again, and pass the `revision` this answer gives as `basis`.",
            by.join(", "),
            listed.join(", ")
        )
    };
    Ok(Some((message, conflicts)))
}

/// An agent's undo or redo in the agents' undo scope takes back the agents' last step whoever
/// made it (the scope is the agents', not one agent's): refused when that step is another
/// agent's, so an agent never takes back another's edit.
fn undo_refusal(kits: &KitManager, key: &str, input: &Value, agent: &str) -> Option<Refusal> {
    let steps = input.get("steps").and_then(Value::as_array)?;
    let scoped = |step: &Value| step["params"]["scope"].as_str().is_none_or(|scope| scope == "agent");
    if !steps.iter().any(|step| matches!(step["command"].as_str(), Some("edit.undo" | "edit.redo")) && scoped(step)) {
        return None;
    }
    let journals = &kits.inner.journals;
    let mut undo: Vec<String> = journals.undo_authors(key, false, usize::MAX).into_iter().rev().collect();
    let mut undone: Vec<String> = journals.undo_authors(key, true, usize::MAX).into_iter().rev().collect();
    for step in steps {
        let (from, to) = match step["command"].as_str() {
            Some("edit.undo") if scoped(step) => (&mut undo, &mut undone),
            Some("edit.redo") if scoped(step) => (&mut undone, &mut undo),
            _ => {
                undo.push(agent.to_owned());
                undone.clear();
                continue;
            }
        };
        match from.pop() {
            Some(author) if author != agent => {
                let what = if step["command"] == "edit.undo" { "undo" } else { "redo" };
                return Some((
                    format!(
                        "The agents' last step is `{author}`'s, not yours: an {what} now would take back another agent's edit. Nothing was run; undo your own edit with a command that changes it back."
                    ),
                    vec![guard::Conflict::of(None, "changed", None)],
                ));
            }
            Some(author) => to.push(author),
            None => {}
        }
    }
    None
}

/// The open editor of `path`, which a draft needs: drafts live in the person's editor (standard
/// 2.0 A15), so a file no editor has open has none.
pub(crate) async fn draft_editor(kits: &KitManager, kit: &KitDefinition, path: &str) -> Result<LiveDocument, KitToolError> {
    live(kits, kit, path).await.ok_or_else(|| {
        KitToolError::new(ErrorCode::NotOpen, format!(
            "`{path}` is not open in its {} editor, so it has no draft: drafts live in the person's open editor. Ask the person to open it, or edit the file live (`draft: false`).",
            short(kit)
        ))
    })
}

/// Where the agent's draft of `path` is: when the server keeps headless drafts (`kition mcp`,
/// `kition gateway`), always in the headless kit (`drafts.rs`), even when an editor has the file
/// open (decision R9: a draft in an editor's page would die with its tab, and the person's review
/// would never see it); else in the file's open editor. With `create`, a file without a headless
/// draft forks one.
pub(crate) enum DraftAt {
    Editor(LiveDocument),
    Headless(String),
}

pub(crate) async fn draft_at(kits: &KitManager, kit: &'static KitDefinition, path: &str, create: bool) -> Result<DraftAt, KitToolError> {
    if kits.headless_drafts() {
        return drafts::document(kits, kit, path, create).await.map(DraftAt::Headless);
    }
    draft_editor(kits, kit, path).await.map(DraftAt::Editor)
}

/// Whether a read in draft mode goes to a headless draft: the server keeps headless drafts, and
/// the call asks for the draft or one exists (an open editor of the file changes nothing, R9).
async fn reads_headless_draft(kits: &KitManager, _kit: &KitDefinition, path: &str, draft: bool, explicit: bool) -> bool {
    draft && kits.headless_drafts() && (explicit || drafts::exists(kits, path))
}

async fn headless_draft_preview(kits: &KitManager, kit: &KitDefinition, path: &str, id: &str, request: &PreviewRequest) -> Result<Vec<Preview>, KitToolError> {
    match kits.preview_of(kit.id, id, request).await {
        Ok(png) => Ok(vec![Preview { caption: format!("Preview of your draft of `{path}` from {}.", kit.name), png }]),
        Err(error) if asks_more(request) => Err(preview_failed(kit, path, request, error)),
        Err(error) => {
            tracing::warn!(error = %error, kit = kit.id, "draft preview failed");
            Ok(Vec::new())
        }
    }
}

/// The draft document as the tools answer it: the file's `path`, with `draft: true`.
fn draft_json(view: &DocumentView, path: &str) -> Value {
    let mut answer = document_json(view);
    answer["path"] = Value::String(path.to_owned());
    answer["draft"] = Value::Bool(true);
    answer
}

async fn draft_preview(kits: &KitManager, kit: &KitDefinition, document: &LiveDocument, request: &PreviewRequest) -> Result<Vec<Preview>, KitToolError> {
    editor_draws(kit, &document.path, request)?;
    Ok(match kits.bridge().preview_draft(document, request.max_size).await {
        Ok(png) => vec![Preview { caption: format!("Preview of your draft of `{}` from {}.", document.path, kit.name), png }],
        Err(error) => {
            tracing::warn!(error = %error, kit = kit.id, "draft preview failed");
            Vec::new()
        }
    })
}

/// Refuses a step that runs the kit's export command ([`KitExport`]): it answers the whole file
/// as base64, which `_run` would hand the agent (megabytes for a movie). `_export` writes it.
fn refuse_export_command(kit: &KitDefinition, steps: &[Value]) -> Result<(), KitToolError> {
    let Some(export) = kit.agent.export.as_ref() else {
        return Ok(());
    };
    if steps.iter().any(|step| step["command"] == export.command) {
        return Err(KitToolError::invalid(format!(
            "`{}` answers the file's bytes; use {} (path, to) to write a new {} file",
            export.command,
            tool_name(kit, Action::Export),
            export::listed(export)
        )));
    }
    Ok(())
}

/// The agent's steps with every `edit.undo` and `edit.redo` in the agent's undo scope
/// (`{"scope":"agent"}`, engine contract 2 E14a, KitModel 1.1 M12a), so an agent's undo or
/// revert takes back only its own steps and never the person's. A scope the step names stays.
fn in_agent_scope(steps: &[Value]) -> Vec<Value> {
    steps
        .iter()
        .map(|step| {
            let command = step.get("command").and_then(Value::as_str).unwrap_or_default();
            if command != "edit.undo" && command != "edit.redo" {
                return step.clone();
            }
            let mut step = step.clone();
            if let Some(object) = step.as_object_mut() {
                let params = object.entry("params").or_insert_with(|| Value::Object(Map::new()));
                if !params.is_object() {
                    *params = Value::Object(Map::new());
                }
                if let Some(params) = params.as_object_mut() {
                    params.entry("scope").or_insert_with(|| Value::String("agent".to_owned()));
                }
            }
            step
        })
        .collect()
}

async fn run_on_draft(kits: &KitManager, kit: &'static KitDefinition, input: &Value) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let steps = input
        .get("steps")
        .and_then(Value::as_array)
        .filter(|steps| !steps.is_empty())
        .ok_or_else(|| KitToolError::invalid("`steps` must be a non-empty array"))?;
    refuse_export_command(kit, steps)?;
    let steps = &in_agent_scope(steps);
    let target = context::run_part(input, kit.agent.parts)?;
    let wanted = receipts::wanted(input)?;
    if input.get("view").is_some_and(|view| !view.is_null()) {
        return Err(KitToolError::new(
            ErrorCode::Unsupported,
            format!(
                "`view` cannot be drawn for a draft run: its preview is the whole draft. Nothing was run; leave `view` out, or call {} with `draft`, `target` and `preview` after the run.",
                tool_name(kit, Action::Inspect)
            ),
        ));
    }
    let document = match draft_at(kits, kit, &path, true).await? {
        DraftAt::Editor(document) => document,
        DraftAt::Headless(id) => return run_on_headless_draft(kits, kit, &path, &id, steps, target.as_ref(), wanted).await,
    };
    context::refuse_in_editor(input, steps, &path, short(kit))?;
    let mut answer = kits
        .bridge()
        .call(&document, "run", json!({ "steps": steps, "save": false, "draft": true }))
        .await
        .map_err(|error| KitToolError::from(error).context(&format!("on the draft in the open {} editor: ", short(kit))))?;
    if answer["closed"] == true || answer["completed"].as_array().is_some_and(|done| done.last().is_some_and(|step| step["result"]["closed"] == true)) {
        return Ok(closed_editor_run(&path, answer, true));
    }
    let previews = draft_preview(kits, kit, &document, &PreviewRequest::within(PREVIEW_SIZE)).await?;
    lean_completed(&mut answer);
    let ran = answer["completed"].as_array().map_or(0, Vec::len);
    answer["live"] = Value::Bool(true);
    answer["draft"] = Value::Bool(true);
    receipts::in_editor(&mut answer, wanted, short(kit));
    Ok(KitToolOutput {
        previews,
        ..KitToolOutput::new(
            format!(
                "Ran {ran} commands on your draft of `{path}`; the document is unchanged until the person merges the draft. Call {} when it is done.",
                tool_name(kit, Action::DraftReady)
            ),
            answer,
        )
    })
}

/// Runs `steps` on the headless draft `id` of `path` and stores the draft, with the context of a
/// headless run: each step's part (`at.part`, else `target`) and `on`, and the kit's editor state
/// put back afterwards.
async fn run_on_headless_draft(
    kits: &KitManager,
    kit: &'static KitDefinition,
    path: &str,
    id: &str,
    steps: &[Value],
    target: Option<&Value>,
    wanted: receipts::Wanted,
) -> KitToolResult {
    let mut view = kits.document(Caller::Agent, kit.id, id).await?;
    let saved = context::save(kits, kit.id, id).await?;
    let acts = if context::any_on(steps) { context::acts_by_id(&kits.commands(Caller::Agent, kit.id, Some(id), None).await?) } else { Default::default() };
    let planned = context::plan(steps, target, &acts, saved.hooks(), kit.agent.parts)?;
    let receipt = receipts::before(kits, kit.name, receipts::Source::Kit { kit_id: kit.id, document_id: id }, wanted).await;
    let mut done = Vec::new();
    let mut failure = None;
    for (index, step) in planned.iter().enumerate() {
        if let Err(error) = prepare(kits, &view, step, path).await {
            failure = Some(error.at(Some(index)).context(&format!("step {index} (`{}`): ", step.command)));
            break;
        }
        match kits.execute(Caller::Agent, kit.id, id, &step.command, step.params.clone()).await {
            Ok(executed) => {
                done.push(step_entry(&step.command, executed.changed, executed.result));
                let Some(document) = executed.document else { return Ok(closed_run(path, done, planned.len(), true)) };
                view = document;
            }
            Err(error) => {
                let mut error = KitToolError::from(error);
                if !matches!(error.code, ErrorCode::UnknownCommand | ErrorCode::NotAllowed | ErrorCode::Unavailable) {
                    error.code = ErrorCode::COMMAND_FAILED;
                }
                failure = Some(error.context(&format!("step {index} (`{}`) failed: ", step.command)).at(Some(index)));
                break;
            }
        }
    }
    if let Some(mut failure) = failure {
        // A failed run is atomic (KHP A53): the draft goes back to what was stored before the call.
        if done.is_empty() {
            failure.message.push_str(&context::restore_noted(kits, kit.id, id, &saved).await.unwrap_or_default());
            return Err(failure.with_output(json!({ "completed": [], "draft": true, "document": draft_json(&view, path) })));
        }
        return Err(match drafts::reload(kits, kit, path, id).await {
            Ok(reloaded) => {
                let restored = kits.document(Caller::Agent, kit.id, &reloaded).await.unwrap_or(view);
                failure
                    .message
                    .push_str(&format!(" The {} step(s) before it were rolled back: your draft of `{path}` is as it was before the call.", done.len()));
                failure.message.push_str(&context::restore_noted(kits, kit.id, &reloaded, &saved).await.unwrap_or_default());
                failure.with_output(json!({ "completed": [], "rolledBack": done, "draft": true, "document": draft_json(&restored, path) }))
            }
            Err(error) => {
                failure.message.push_str(&format!(
                    " The {} step(s) before it could not be rolled back ({}): they stay in your draft of `{path}`.",
                    done.len(),
                    error.message
                ));
                failure.message.push_str(&context::restore_noted(kits, kit.id, id, &saved).await.unwrap_or_default());
                drafts::persist(kits, kit, path, id).await?;
                failure.with_output(json!({ "completed": done, "draft": true, "document": draft_json(&view, path) }))
            }
        });
    }
    let unrestored = context::restore_noted(kits, kit.id, id, &saved).await.unwrap_or_default();
    if !done.is_empty() {
        drafts::persist(kits, kit, path, id).await?;
    }
    let previews = headless_draft_preview(kits, kit, path, id, &PreviewRequest::within(PREVIEW_SIZE)).await?;
    let mut answer = json!({ "completed": done, "draft": true, "saved": false, "document": draft_json(&view, path) });
    receipts::add(kits, kit.name, receipts::Source::Kit { kit_id: kit.id, document_id: id }, receipt, wanted, &mut answer).await;
    Ok(KitToolOutput {
        previews,
        ..KitToolOutput::new(
            format!(
                "Ran {} commands on your draft of `{path}`; the file is unchanged until the person merges the draft. Call {} when it is done.{unrestored}{}",
                done.len(),
                tool_name(kit, Action::DraftReady),
                receipts::summary(&answer)
            ),
            answer,
        )
    })
}

async fn draft_state(kits: &KitManager, kit: &'static KitDefinition, input: &Value, action: Action) -> KitToolResult {
    let path = kit_path(input, kit)?;
    if kits.headless_drafts() {
        let state = if action == Action::DraftReady { DraftState::Ready } else { DraftState::Open };
        drafts::set_state(kits, &path, state)?;
        let summary = if state == DraftState::Ready {
            format!("Your draft of `{path}` is ready for review; the person will merge or discard it.")
        } else {
            format!("Your draft of `{path}` is back with you to keep editing.")
        };
        return Ok(KitToolOutput::new(summary, json!({ "path": path, "state": if state == DraftState::Ready { "ready" } else { "open" } })));
    }
    let document = draft_editor(kits, kit, &path).await?;
    let answer = kits.bridge().call(&document, action.suffix(), json!({})).await.map_err(|error| {
        let failure = KitToolError::from(error);
        // A draft that does not exist cannot be made ready: edit with `draft: true` first.
        let failure = if failure.message.contains("no draft") { KitToolError { code: ErrorCode::DraftRequired, ..failure } } else { failure };
        failure.context(&format!("in the open {} editor: ", short(kit)))
    })?;
    let summary = if action == Action::DraftReady {
        format!("Your draft of `{path}` is ready for review; the person will merge or discard it.")
    } else {
        format!("Your draft of `{path}` is back with you to keep editing.")
    };
    Ok(KitToolOutput::new(summary, answer))
}

async fn inspect(kits: &KitManager, kit: &'static KitDefinition, input: &Value, draft: bool) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let wants_preview = input.get("preview").and_then(Value::as_bool) == Some(true); // A55: previews on request
    // An explicit `draft: true` needs the editor; the run's default falls back to the file.
    let explicit = input.get("draft").and_then(Value::as_bool) == Some(true);
    if reads_headless_draft(kits, kit, &path, draft, explicit).await {
        // The draft answers as the file does (target, content, the part's objects), on the draft.
        let id = drafts::document(kits, kit, &path, false).await?;
        let view = kits.document(Caller::Agent, kit.id, &id).await?;
        return inspect_view(kits, kit, input, &path, view, true).await;
    }
    let open = live(kits, kit, &path).await;
    let mut inspection = json!({});
    if let Some(target) = input.get("target") {
        inspection["target"] = target.clone();
        let part = kit.agent.parts.and_then(|nouns| declared_part(target, nouns)).unwrap_or_else(|| target.clone());
        inspection["context"] = json!({"part":part});
        if let Some(part) = target_part(kit, input) {
            inspection["part"] = json!(part);
        }
    }
    if draft && !kits.headless_drafts() && (open.is_some() || explicit) {
        let document = draft_editor(kits, kit, &path).await?;
        inspection["draft"] = json!(true);
        if let Ok(mut answer) = kits.bridge().call(&document, "inspect", inspection.clone()).await {
            let previews = if wants_preview { draft_preview(kits, kit, &document, &screenshot_request(input, false)?).await? } else { Vec::new() };
            let summary = answer["document"]["summary"].as_str().unwrap_or_default().to_owned();
            answer["live"] = Value::Bool(true);
            answer["draft"] = Value::Bool(true);
            return Ok(KitToolOutput { previews, ..KitToolOutput::new(format!("Opened your draft of `{path}`: {summary}"), answer) });
        }
        if explicit {
            return Err(KitToolError::new(ErrorCode::DraftRequired, format!("`{path}` has no draft yet: edit it with `draft: true` first.")));
        }
        // No draft yet: the live document is what a draft would start from.
    }
    if let Some(document) = open {
        inspection.as_object_mut().unwrap().remove("draft");
        let mut answer = kits.bridge().call(&document, "inspect", inspection).await?;
        let rendered = if wants_preview { live_rendered_preview(kits, kit, &document, input, target_part(kit, input)).await? } else { None };
        let previews = match rendered {
            Some((previews, shows)) => {
                answer["preview"] = shows;
                previews
            }
            None if wants_preview => live_preview(kits, kit, &document, &screenshot_request(input, false)?).await?,
            None => Vec::new(),
        };
        let summary = answer["document"]["summary"].as_str().unwrap_or_default().to_owned();
        answer["live"] = Value::Bool(true);
        return Ok(KitToolOutput { previews, ..KitToolOutput::new(format!("Opened `{path}` in its open {} editor: {summary}", short(kit)), answer) });
    }
    let view = kits.open(Caller::Agent, &path).await?;
    inspect_view(kits, kit, input, &path, view, false).await
}

/// `<prefix>_inspect` on a document the headless kit holds: the file, or the agent's headless
/// draft of it (`draft`). Both go to the `target` part, render, and answer content the same way,
/// and the kit's editor state (its current part, its selection) is put back afterwards.
async fn inspect_view(kits: &KitManager, kit: &'static KitDefinition, input: &Value, path: &str, mut view: DocumentView, draft: bool) -> KitToolResult {
    // A part one of the kit's declared nouns names (`agent.parts`), by its id: set for the inspect
    // through `context.set`, as a run's `target` is.
    let declared = kit.agent.parts.zip(input.get("target")).and_then(|(nouns, target)| declared_part(target, nouns));
    let goes = target_part(kit, input).is_some() || target_part_id(kit, input).is_some() || declared.is_some();
    let saved = if goes { context::save(kits, view.kit_id, &view.document_id).await? } else { context::Saved::Unsupported };
    let (kit_id, document_id) = (view.kit_id, view.document_id.clone());
    if let Some(part) = declared
        && saved.hooks()
    {
        let mut members = Map::new();
        members.insert("part".into(), part);
        if let Err(error) = kits.context(Caller::Agent, kit_id, &document_id, "context.set", members).await {
            let _ = context::restore(kits, kit_id, &document_id, &saved).await;
            return Err(KitToolError::from(error).context("the kit could not go to the `target` part: "));
        }
        view = kits.document(Caller::Agent, kit_id, &document_id).await?;
    }
    let answer = inspect_part(kits, kit, input, path, view, draft).await;
    let unrestored = context::restore_noted(kits, kit_id, &document_id, &saved).await;
    answer.map(|mut answer| {
        answer.summary.push_str(&unrestored.unwrap_or_default());
        answer
    })
}

async fn inspect_part(kits: &KitManager, kit: &'static KitDefinition, input: &Value, path: &str, mut view: DocumentView, draft: bool) -> KitToolResult {
    let wants_preview = input.get("preview").and_then(Value::as_bool) == Some(true); // A55: previews on request
    // A kit with a render command draws the call's view itself, and lists a numbered part's objects
    // by index: it is not sent to the part. A part by id is gone to (inside the editor-state
    // bracket of `inspect_view`) only to learn its number.
    let part = match target_part(kit, input) {
        Some(part) if kit.agent.render.is_some() => Some(part),
        _ if kit.agent.parts.is_some() => None,
        _ => match resolve_part(kits, &view, input).await? {
            Some((part, moved)) => {
                view = moved;
                Some(part)
            }
            None => None,
        },
    };
    let rendered = if wants_preview { rendered_preview(kits, kit, &view, input, part.or_else(|| target_part(kit, input))).await? } else { None };
    let (previews, shows) = match rendered {
        Some((previews, shows)) => (previews, Some(shows)),
        None if !wants_preview => (Vec::new(), None),
        None => {
            let request = screenshot_request(input, part.is_some())?;
            let previews =
                if draft { headless_draft_preview(kits, kit, path, &view.document_id, &request).await? } else { preview(kits, kit, &view, &request).await? };
            (previews, None)
        }
    };
    let mut answer = if draft { draft_json(&view, path) } else { document_json(&view) };
    if let Some(content) = part_content(kits, &view, input).await {
        answer["content"] = content;
    }
    if let Some(part) = part
        && let Some(objects) = part_objects(kits, &view, part).await?
    {
        // The part, not the whole document's outline again.
        answer = document_summary_json(&view);
        if draft {
            answer["path"] = Value::String(path.to_owned());
            answer["draft"] = Value::Bool(true);
        }
        let back = come_back(input, &objects);
        answer["part"] = objects;
        lean_objects(&mut answer["part"]);
        answer["edit"] = json!(format!(
            "Edit these objects by their `id` with {} and a command (find commands with {}), for example text.set {{\"id\": <id>, \"text\": \"...\"}}; commands keep formatting. \
                 {back} \
                 Commands count slides and pages from 0: this part ({part}, counted from 1) is `index` {}. The query and batch tools take these ids too.",
            tool_name(kit, Action::Run),
            tool_name(kit, Action::Commands),
            part - 1
        ));
    }
    if let Some(shows) = shows {
        answer["preview"] = shows;
    }
    let opened = if draft { format!("Opened your draft of `{path}`: {}", view.summary) } else { format!("Opened `{path}`: {}", view.summary) };
    Ok(KitToolOutput { previews, ..KitToolOutput::new(opened, answer) })
}

/// `<prefix>_check` (standard 2.0 A22): the diagnostics of the agent's draft, of the open editor's
/// document, or of the file through the headless kit, as `<prefix>_inspect` chooses among them.
async fn check(kits: &KitManager, kit: &'static KitDefinition, input: &Value, draft: bool) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let explicit = input.get("draft").and_then(Value::as_bool) == Some(true);
    let headless_draft = reads_headless_draft(kits, kit, &path, draft, explicit).await;
    let open = live(kits, kit, &path).await;
    let (answer, what) = if headless_draft {
        let id = drafts::document(kits, kit, &path, false).await?;
        let answer = kits.check(Caller::Agent, kit.id, &id).await?.ok_or_else(|| {
            KitToolError::new(ErrorCode::Unsupported, format!("this version of {} cannot check documents yet; inspect the preview instead", short(kit)))
        })?;
        (answer, format!("your draft of `{path}`"))
    } else if draft && !kits.headless_drafts() && (open.is_some() || explicit) {
        let document = draft_editor(kits, kit, &path).await?;
        let answer = kits
            .bridge()
            .call(&document, "check", json!({ "draft": true }))
            .await
            .map_err(|error| KitToolError::from(error).context(&format!("on the draft in the open {} editor: ", short(kit))))?;
        (answer, format!("your draft of `{path}`"))
    } else if let Some(document) = open {
        let answer = kits
            .bridge()
            .call(&document, "check", json!({}))
            .await
            .map_err(|error| KitToolError::from(error).context(&format!("in the open {} editor: ", short(kit))))?;
        (answer, format!("`{path}`"))
    } else {
        let view = kits.open(Caller::Agent, &path).await?;
        let answer = kits.check(Caller::Agent, view.kit_id, &view.document_id).await?.ok_or_else(|| {
            KitToolError::new(ErrorCode::Unsupported, format!("this version of {} cannot check documents yet; inspect the preview instead", short(kit)))
        })?;
        (answer, format!("`{path}`"))
    };
    let diagnostics = answer["diagnostics"].as_array().cloned().unwrap_or_default();
    Ok(KitToolOutput::new(diagnostics_summary(&what, &diagnostics), json!({ "diagnostics": diagnostics })))
}

/// `Checked `a.pptx`: 1 error, 2 warnings, no notes.`
fn diagnostics_summary(what: &str, diagnostics: &[Value]) -> String {
    let count = |severity: &str| diagnostics.iter().filter(|diagnostic| diagnostic["severity"] == severity).count();
    let plural = |n: usize, one: &str, many: &str| match n {
        0 => format!("no {many}"),
        1 => format!("1 {one}"),
        n => format!("{n} {many}"),
    };
    if diagnostics.is_empty() {
        return format!("Checked {what}: the kit found nothing wrong.");
    }
    format!(
        "Checked {what}: {}, {}, {}.",
        plural(count("error"), "error", "errors"),
        plural(count("warning"), "warning", "warnings"),
        plural(count("info"), "note", "notes")
    )
}

async fn commands(kits: &KitManager, kit: &KitDefinition, input: &Value) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let query = text_field(input, "query");
    let detail = input.get("detail").and_then(Value::as_bool) == Some(true);
    let page = if query.is_empty() { Some(Page::from_input(input)?) } else { None };
    if let Some(document) = live(kits, kit, &path).await {
        let answer = kits.bridge().call(&document, "commands", json!({ "query": query })).await?;
        let found = answer["commands"]
            .as_array()
            .into_iter()
            .flatten()
            .cloned()
            .map(|mut command| {
                if let Some(object) = command.as_object_mut()
                    && let Some(schema) = object.remove("schema")
                {
                    object.insert("params".into(), schema);
                }
                command
            })
            .collect();
        return Ok(match page {
            Some(page) => paged_commands(found, page, detail),
            None => listed_commands_with(&query, found, detail),
        });
    }
    let view = kits.open(Caller::Agent, &path).await?;
    let found = kits.commands(Caller::Agent, view.kit_id, Some(&view.document_id), Some(&query)).await?;
    let found = found
        .into_iter()
        .map(|command| {
            let mut entry = json!({
                "id": command.id,
                "title": command.title,
                "description": command.description,
                "params": command.params,
                "enabled": command.enabled,
                "mutates": command.mutates,
                "closest": command.closest,
                "allWords": command.all_words,
                "matched": command.matched,
            });
            // What a read command answers (KHP A1), so the agent knows the result's shape before it runs.
            if let Some(output) = command.output {
                entry["output"] = output;
            }
            entry
        })
        .collect();
    if let Some(page) = page {
        return Ok(paged_commands(found, page, detail));
    }
    let mut answer = listed_commands_with(&query, found, detail);
    if let Some(hint) = file_tool_hint(kit, &query) {
        answer.summary = format!("{hint}\n{}", answer.summary);
        answer.output["hint"] = json!(hint);
    }
    Ok(answer)
}

/// Points a search for exporting or creating files at `<prefix>_export` and `<prefix>_create`:
/// those are tools, not commands, and commands that name files are not available to the agent.
fn file_tool_hint(kit: &KitDefinition, query: &str) -> Option<String> {
    let words: Vec<String> = query.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_owned).collect();
    let has = |list: &[&str]| words.iter().any(|w| list.contains(&w.as_str()));
    if let Some(export) = kit.agent.export.as_ref()
        && (has(&["export", "render", "encode", "output", "movie", "video", "write"]) || has(export.formats))
    {
        return Some(format!(
            "To write the document to a new {} file, use {} (path, to) instead of a command.",
            export::listed(export),
            tool_name(kit, Action::Export)
        ));
    }
    if !kit.creates.is_empty() && has(&["new", "create", "blank", "empty"]) && has(&["file", "project", "document", "deck", "presentation"]) {
        return Some(format!("To make a new file, use {} (path).", tool_name(kit, Action::Create)));
    }
    None
}

/// `<prefix>_create`: a new file through the kit (KHP A41); the result lists it (A30).
async fn create(kits: &KitManager, kit: &KitDefinition, input: &Value) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let extension = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    if !kit.creates.iter().any(|(known, _)| *known == extension) {
        return Err(KitToolError::invalid(format!(
            "{} creates {}, not .{extension}",
            kit.name,
            kit.creates.iter().map(|(e, _)| format!(".{e}")).collect::<Vec<_>>().join(", ")
        )));
    }
    let mut options = Map::new();
    if let Some(size) = input.get("size").and_then(Value::as_object) {
        options.extend(size.iter().filter(|(key, _)| *key == "width" || *key == "height").map(|(key, value)| (key.clone(), value.clone())));
    }
    let view = kits.create_at(Caller::Agent, &path, options).await?;
    let written = view.path.clone().unwrap_or(path);
    Ok(KitToolOutput::new(
        format!("Created `{written}`: {}", view.summary),
        json!({ "files": [{ "path": written, "created": true }], "document": document_summary_json(&view) }),
    ))
}

/// A command as the search answers it: its id, title, and parameter schema (KHP A5: a
/// ParameterSchemaSpec in its JSON Schema form, as the kit lists it), and `enabled: false` when it
/// cannot run now.
#[cfg(test)]
fn compact_command(command: Value) -> Value {
    detailed_command(command)
}

/// A command in full: its parameter schema (KHP A5), what it does, and what it answers. What
/// `<prefix>_commands` gives for `detail: true` or a query that is the command's id.
fn detailed_command(command: Value) -> Value {
    let mut out = json!({ "id": command["id"], "title": command["title"], "params": lean_params(&command["params"]) });
    // What a run step's `on` fills, and the editor state the server sets for the command (its
    // schema's `x-khp-role` and `x-khp-reads`), said once beside the schema.
    let acts = context::Acts::of(&command["params"]);
    if let Some((name, many)) = &acts.targets {
        out["targets"] = json!({ "param": name, "takes": if *many { "a list of ids" } else { "one id" } });
    }
    if !acts.reads.is_empty() {
        out["reads"] = json!(acts.reads);
    }
    if let Some(needs) = acts.depends_on() {
        out["dependsOn"] = json!(needs);
    }
    if let Some(params) = out["params"].as_object_mut() {
        params.remove("x-khp-reads");
        if let Some(properties) = params.get_mut("properties").and_then(Value::as_object_mut) {
            for property in properties.values_mut().filter_map(Value::as_object_mut) {
                property.remove("x-khp-role");
            }
        }
    }
    // What it does and when to choose it (KitCommand.description), and what a read command answers.
    if command["description"].as_str().is_some_and(|description| !description.is_empty()) {
        out["description"] = command["description"].clone();
    }
    if command["output"].is_object() {
        out["output"] = command["output"].clone();
    }
    flags(&command, &mut out);
    out
}

/// A command as a search lists it: its id and title, the first sentence of what it does, and its
/// parameters as one line written from its schema (`{blank?: boolean, size?: number[]}`, enums as
/// `a|b`), with what it answers. The schema in full is one call away (`detail: true`, or the id as
/// the query).
fn brief_command(command: Value) -> Value {
    let mut out = json!({ "id": command["id"], "title": command["title"], "params": signature(&command["params"]) });
    if let Some(description) = command["description"].as_str().filter(|text| !text.is_empty()) {
        out["description"] = Value::String(first_sentence(description, 140));
    }
    if let Some(returns) = lean_params(&command["params"]).get("returns").cloned() {
        out["returns"] = returns;
    } else if command["output"].is_object() {
        out["returns"] = Value::String(signature(&command["output"]));
    }
    // Editor state no call context sets, said in the one-line form too: a model that does not ask
    // for the detail must still learn to set it in the run.
    if let Some(needs) = context::Acts::of(&command["params"]).depends_on() {
        out["dependsOn"] = json!(needs);
    }
    flags(&command, &mut out);
    out
}

fn flags(command: &Value, out: &mut Value) {
    if command["matched"].as_array().is_some_and(|matched| !matched.is_empty()) {
        out["matched"] = command["matched"].clone();
    }
    if command["enabled"] == Value::Bool(false) {
        out["enabled"] = Value::Bool(false);
    }
}

/// The first sentence of `text`, at most `max` characters (cut at a word, with `…`).
fn first_sentence(text: &str, max: usize) -> String {
    let sentence = text.split_inclusive(". ").next().unwrap_or(text).trim();
    if sentence.chars().count() <= max {
        return sentence.to_owned();
    }
    let cut: String = sentence.chars().take(max).collect();
    format!("{}…", cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head))
}

/// An object schema as one line: `{name: type, optional?: type (short note)}`.
fn signature(schema: &Value) -> String {
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return "{}".to_owned();
    };
    let required: Vec<&str> = schema.get("required").and_then(Value::as_array).map(|keys| keys.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    // By name, whatever order the map keeps (serde_json's `preserve_order` differs between builds),
    // so the line is the same in every host and a cached prompt prefix stays the same.
    let mut named: Vec<(&String, &Value)> = properties.iter().collect();
    named.sort_by(|a, b| a.0.cmp(b.0));
    let fields: Vec<String> = named
        .into_iter()
        .map(|(name, property)| {
            let mut field = format!("{name}{}: {}", if required.contains(&name.as_str()) { "" } else { "?" }, type_text(property));
            if let Some(note) = property.get("description").and_then(Value::as_str).filter(|note| note.chars().count() <= 48) {
                field.push_str(&format!(" ({note})"));
            }
            field
        })
        .collect();
    format!("{{{}}}", fields.join(", "))
}

fn type_text(property: &Value) -> String {
    if let Some(values) = property.get("enum").and_then(Value::as_array) {
        let names: Vec<String> = values.iter().take(10).map(|value| value.as_str().map_or_else(|| value.to_string(), str::to_owned)).collect();
        return format!("{}{}", names.join("|"), if values.len() > 10 { "|…" } else { "" });
    }
    if let Some(branches) = property.get("oneOf").and_then(Value::as_array) {
        return branches.iter().map(type_text).collect::<Vec<_>>().join("|");
    }
    match property.get("type").and_then(Value::as_str) {
        Some("array") => format!("{}[]", property.get("items").map_or_else(|| "any".to_owned(), type_text)),
        Some("object") if property.get("properties").is_some() => signature(property),
        Some(kind) => kind.to_owned(),
        None => "any".to_owned(),
    }
}

/// An inspect answer's objects without what the agent does not need: object-model `ref`s (the
/// server translates numeric ids itself) and zero rotations.
fn lean_objects(value: &mut Value) {
    if let Some(shapes) = value.get_mut("shapes").and_then(Value::as_array_mut) {
        for shape in shapes {
            lean_shape(shape);
        }
    }
}

fn lean_shape(shape: &mut Value) {
    if let Some(object) = shape.as_object_mut() {
        object.remove("ref");
        if object.get("rotation").and_then(Value::as_f64) == Some(0.0) {
            object.remove("rotation");
        }
        if let Some(children) = object.get_mut("children").and_then(Value::as_array_mut) {
            for child in children {
                lean_shape(child);
            }
        }
    }
}

/// Where a listing of every command starts and how much of it a page holds (KHP A5b): `cursor` is
/// the position after the previous page, as `next` gave it.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Page {
    start: usize,
    limit: usize,
}

impl Page {
    fn from_input(input: &Value) -> Result<Self, KitToolError> {
        let start = match input.get("cursor") {
            None | Some(Value::Null) => 0,
            Some(Value::String(cursor)) if cursor.is_empty() => 0,
            Some(Value::String(cursor)) => cursor.parse().map_err(|_| KitToolError::invalid(format!("`cursor` `{cursor}` is not a `next` this tool gave")))?,
            Some(_) => return Err(KitToolError::invalid("`cursor` must be the string `next` gave")),
        };
        let limit = match input.get("limit") {
            None | Some(Value::Null) => DEFAULT_LISTED,
            Some(value) => value
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .filter(|n| (1..=MAX_LISTED).contains(n))
                .ok_or_else(|| KitToolError::invalid(format!("`limit` must be a whole number from 1 to {MAX_LISTED}")))?,
        };
        Ok(Self { start, limit })
    }
}

/// Every command, by id, one page of them (KHP A5b): brief rows, or in full with `detail`; `next`
/// while more follow, `total` always.
fn paged_commands(mut found: Vec<Value>, page: Page, detail: bool) -> KitToolOutput {
    found.sort_by(|a, b| a["id"].as_str().unwrap_or_default().cmp(b["id"].as_str().unwrap_or_default()));
    let total = found.len();
    let end = page.start.saturating_add(page.limit).min(total);
    let listed: Vec<Value> =
        found.into_iter().skip(page.start).take(page.limit).map(|command| if detail { detailed_command(command) } else { brief_command(command) }).collect();
    let mut output = json!({ "commands": listed, "total": total });
    let summary = if page.start >= total {
        format!("No commands after the first {total}.")
    } else if end < total {
        output["next"] = json!(end.to_string());
        format!("Commands {}–{end} of {total}, by id; pass `cursor: \"{end}\"` for the next page.", page.start + 1)
    } else {
        format!("Commands {}–{end} of {total}, by id.", page.start + 1)
    };
    KitToolOutput::new(summary, output)
}

/// The commands that matched, at most [`MAX_COMMANDS`] of them, as the tool answers them.
#[cfg(test)]
fn listed_commands(query: &str, found: Vec<Value>) -> KitToolOutput {
    listed_commands_with(query, found, false)
}

/// The commands that matched as the tool answers them: brief rows ([`brief_command`]), or in full
/// with `detail`; a command whose id is the query is always in full.
fn listed_commands_with(query: &str, found: Vec<Value>, detail: bool) -> KitToolOutput {
    let wanted = query.trim();
    let shown = |command: Value| if detail || command["id"] == wanted { detailed_command(command) } else { brief_command(command) };
    if found.first().is_some_and(|command| command["closest"] == true) {
        let listed: Vec<Value> = found.into_iter().take(MAX_COMMANDS).map(shown).collect();
        return KitToolOutput::new(
            format!("No command matches `{query}`; these are the closest by spelling. Try other words, for example what the command does."),
            json!({ "commands": listed, "total": 0 }),
        );
    }
    let total = found.len();
    let every = found.iter().filter(|command| command["allWords"] == true || command["all_words"] == true).count();
    let listed: Vec<Value> = found.into_iter().take(MAX_COMMANDS).map(shown).collect();
    let words = query.split_whitespace().count();
    let mut summary = if words <= 1 || every == total {
        format!("{total} commands match `{query}`")
    } else if every > 0 {
        format!("{every} commands have every word of `{query}`, {} more some of them", total - every)
    } else {
        format!("No command has every word of `{query}`; {total} have some of them")
    };
    if total > listed.len() {
        summary.push_str(&format!("; showing the best {}. Use more specific keywords.", listed.len()));
    }
    KitToolOutput::new(summary, json!({ "commands": listed, "total": total, "allWords": every }))
}

async fn run_steps(kits: &KitManager, kit: &KitDefinition, input: &Value) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let steps = input
        .get("steps")
        .and_then(Value::as_array)
        .filter(|steps| !steps.is_empty())
        .ok_or_else(|| KitToolError::invalid("`steps` must be a non-empty array"))?;
    refuse_export_command(kit, steps)?;
    let steps = &in_agent_scope(steps);
    let save = input.get("save").and_then(Value::as_bool) != Some(false);
    let target = context::run_part(input, kit.agent.parts)?;
    let shown = run_view(kit, input)?;
    let wanted = receipts::wanted(input)?;
    if let Some(document) = live(kits, kit, &path).await {
        // An editor that runs each step in an editor state of the agent's own takes the run's
        // call context, planned as headless (C3b); another refuses it, never ignores it.
        let steps = if document.can("context") {
            &live_steps(kits, kit, &document, steps, target.as_ref()).await?
        } else {
            context::refuse_in_editor(input, steps, &path, short(kit))?;
            steps
        };
        if let (Some(command), Some(request)) = (kit.agent.render, &shown) {
            checked_render_params(kit, command, request, target_part(kit, request), live_render_view(kits, &document, command)).await?;
        }
        // An editor that keeps a replica says what the run changed, as headless (C3b).
        let receipt = if document.can("changes") { Some(receipts::before(kits, kit.name, receipts::Source::Editor(&document), wanted).await) } else { None };
        let mut answer = kits
            .bridge()
            .call(&document, "run", json!({ "steps": steps, "save": save }))
            .await
            .map_err(|failure| live_run_failure(kit, steps.len(), failure))?;
        if answer["closed"] == true || answer["completed"].as_array().is_some_and(|done| done.last().is_some_and(|step| step["result"]["closed"] == true)) {
            return Ok(closed_editor_run(&path, answer, false));
        }
        let request = shown.unwrap_or_else(|| json!({}));
        let previews = match live_rendered_preview(kits, kit, &document, &request, target_part(kit, &request)).await {
            Ok(Some((previews, shows))) => {
                answer["preview"] = shows;
                previews
            }
            Ok(None) => live_preview(kits, kit, &document, &PreviewRequest::within(PREVIEW_SIZE)).await?,
            Err(failure) => {
                answer["previewError"] = failure.to_json();
                Vec::new()
            }
        };
        lean_completed(&mut answer);
        let ran = answer["completed"].as_array().map_or(0, Vec::len);
        let saved = if answer["saved"] == true { "saved" } else { "not saved" };
        let summary = answer["document"]["summary"].as_str().unwrap_or_default().to_owned();
        answer["live"] = Value::Bool(true);
        match receipt {
            Some(receipt) => receipts::add(kits, kit.name, receipts::Source::Editor(&document), receipt, wanted, &mut answer).await,
            None => receipts::in_editor(&mut answer, wanted, short(kit)),
        }
        let told = receipts::summary(&answer);
        return Ok(KitToolOutput {
            previews,
            ..KitToolOutput::new(format!("Ran {ran} commands on `{path}` in its open {} editor ({saved}): {summary}{told}", short(kit)), answer)
        });
    }
    let mut view = kits.open(Caller::Agent, &path).await?;
    let wants_preview = input.get("preview").and_then(Value::as_bool) == Some(true);
    // The after-picture's view is checked before anything runs: a member the render command does
    // not take is refused, not found out after the run.
    if wants_preview && let (Some(command), Some(request)) = (kit.agent.render, &shown) {
        checked_render_params(kit, command, request, target_part(kit, request), render_view(kits, &view, command)).await?;
    }
    // Whether the document held unsaved edits before the call: a failed run puts it back as it
    // was (KHP A53), by reopening the file when it had none, else by undoing the run's steps.
    let was_dirty = view.dirty;
    // The kit's selection and current part before the call, put back after it.
    let saved = context::save(kits, view.kit_id, &view.document_id).await?;
    let acts = if context::any_on(steps) {
        context::acts_by_id(&kits.commands(Caller::Agent, view.kit_id, Some(&view.document_id), None).await?)
    } else {
        Default::default()
    };
    let planned = context::plan(steps, target.as_ref(), &acts, saved.hooks(), kit.agent.parts)?;
    // What the receipt compares against: the version and the diagnostics before the first step.
    let receipt = receipts::before(kits, kit.name, receipts::Source::Kit { kit_id: view.kit_id, document_id: &view.document_id }, wanted).await;
    let mut done = Vec::new();
    for (index, step) in planned.iter().enumerate() {
        if let Err(failure) = prepare(kits, &view, step, &path).await {
            let failure = failure.at(Some(index)).context(&format!("step {index} (`{}`): ", step.command));
            return Err(rolled_back(kits, &path, &view, was_dirty, done, &saved, failure).await);
        }
        match kits.execute(Caller::Agent, view.kit_id, &view.document_id, &step.command, step.params.clone()).await {
            Ok(executed) => {
                done.push(step_entry(&step.command, executed.changed, executed.result));
                let Some(document) = executed.document else { return Ok(closed_run(&path, done, planned.len(), false)) };
                view = document;
            }
            Err(error) => {
                let mut failure = KitToolError::from(error);
                if matches!(failure.code, ErrorCode::UnknownCommand) {
                    failure.message.push_str(&nearest_commands(kits, &view, &step.command).await);
                }
                if !matches!(failure.code, ErrorCode::UnknownCommand | ErrorCode::NotAllowed | ErrorCode::Unavailable) {
                    failure.code = ErrorCode::COMMAND_FAILED;
                }
                let failure = failure.context(&format!("step {index} (`{}`) failed: ", step.command)).at(Some(index));
                return Err(rolled_back(kits, &path, &view, was_dirty, done, &saved, failure).await);
            }
        }
    }
    // The editor state goes back before the save: a kit that writes some of it into its file (an
    // open sequence, a viewport) must save the person's, never the run's navigation. A failed save
    // rolls back and restores again.
    let unrestored = context::restore_noted(kits, view.kit_id, &view.document_id, &saved).await.unwrap_or_default();
    if save && view.dirty {
        match kits.save(Caller::Agent, view.kit_id, &view.document_id).await {
            Ok(saved_view) => view = saved_view,
            Err(error) => {
                let failure = KitToolError::from(error).context("saving failed: ");
                return Err(rolled_back(kits, &path, &view, was_dirty, done, &saved, failure).await);
            }
        }
    }
    let saved = if save { "saved" } else { "not saved" };
    let mut answer = json!({ "completed": done, "saved": save, "document": document_summary_json(&view) });
    receipts::add(kits, kit.name, receipts::Source::Kit { kit_id: view.kit_id, document_id: &view.document_id }, receipt, wanted, &mut answer).await;
    let mut summary = format!("Ran {} commands on `{path}` ({saved}): {}{unrestored}{}", done.len(), view.summary, receipts::summary(&answer));
    // The after-picture: the kit's render command draws the run's `view` (the whole document
    // without one); a kit without one previews the whole document with its screenshot. `_run`'s
    // `target` is the part the steps act on, not what to draw. A preview that fails leaves the
    // run as it went, and says why.
    let previews = if !wants_preview {
        Vec::new()
    } else {
        let request = shown.unwrap_or_else(|| json!({}));
        match rendered_preview(kits, kit, &view, &request, target_part(kit, &request)).await {
            Ok(Some((previews, shows))) => {
                answer["preview"] = shows;
                previews
            }
            Ok(None) => preview(kits, kit, &view, &PreviewRequest::within(PREVIEW_SIZE)).await?,
            Err(failure) => {
                summary.push_str(&format!(" The preview could not be drawn: {}", failure.message));
                answer["previewError"] = failure.to_json();
                Vec::new()
            }
        }
    };
    Ok(KitToolOutput { previews, ..KitToolOutput::new(summary, answer) })
}

fn closed_editor_run(path: &str, mut answer: Value, draft: bool) -> KitToolOutput {
    answer["closed"] = json!(true);
    answer["saved"] = json!(false);
    answer["live"] = json!(true);
    if draft {
        answer["draft"] = json!(true);
    }
    answer.as_object_mut().unwrap().remove("document");
    KitToolOutput::new(format!("Closed `{path}`."), answer)
}

fn closed_run(path: &str, completed: Vec<Value>, planned: usize, draft: bool) -> KitToolOutput {
    let remaining = planned - completed.len();
    let mut output = json!({"completed":completed,"closed":true,"saved":false,"changes":null,"changesUnavailable":"the document was closed"});
    if draft {
        output["draft"] = json!(true);
    }
    if remaining > 0 {
        output["notRun"] = json!(remaining);
    }
    KitToolOutput::new(format!("Closed `{path}`; {remaining} remaining commands were not run."), output)
}

/// The steps of a run in an editor that takes a call context (capability `context`, C3b), planned
/// as on the headless path ([`context::plan`]): `on` written into the command's targets or made
/// the selection, the part from `at.part` or the run's `target`, the time from `at.time`. Each goes
/// to the editor as `{command, params, context?}`; the editor sets `context` in the agent's own
/// editor state, so the person's selection, part and time do not move. What the commands act on
/// comes from the editor's command list (their schemas' `x-khp-role` and `x-khp-reads`).
async fn live_steps(
    kits: &KitManager,
    kit: &KitDefinition,
    document: &LiveDocument,
    steps: &[Value],
    target: Option<&Value>,
) -> Result<Vec<Value>, KitToolError> {
    let acts = if context::any_on(steps) { live_acts(kits, document).await? } else { Default::default() };
    let planned = context::plan(steps, target, &acts, true, kit.agent.parts)?;
    Ok(planned
        .into_iter()
        .map(|step| {
            let mut sent = json!({ "command": step.command, "params": step.params });
            if let Some(set) = step.set {
                sent["context"] = Value::Object(set);
            }
            sent
        })
        .collect())
}

/// What each command of the open editor acts on ([`context::Acts`]), from its command list: the
/// Kit UI protocol's `ai/commands` gives each command's parameter schema as `schema`.
async fn live_acts(kits: &KitManager, document: &LiveDocument) -> Result<std::collections::HashMap<String, context::Acts>, KitToolError> {
    let answer = kits.bridge().call(document, "commands", json!({ "query": "" })).await?;
    Ok(answer["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|command| Some((command["id"].as_str()?.to_owned(), context::Acts::of(command.get("schema").unwrap_or(&Value::Null)))))
        .collect())
}

/// A failed run in the file's open editor, answered as a headless one (KHP A53, C3b): the editor
/// undid the steps before the failing one in the agent's undo scope and says so in its error's
/// `data` (`completed`, `rolledBack`, `editedMeanwhile`), which become the error's output with
/// `saved: false`, and the failing step (`step`) its `index`. A step another session's lease
/// refused keeps the steps before it (Kit UI protocol section 7b), and an editor that says nothing
/// of them (one of `steps` steps) is said to have said nothing: the answer never claims a rollback
/// it was not told of.
fn live_run_failure(kit: &KitDefinition, steps: usize, failure: BridgeFailure) -> KitToolError {
    let data = failure.data.clone().unwrap_or(Value::Null);
    let step = data.get("step").and_then(Value::as_u64).and_then(|step| usize::try_from(step).ok());
    let mut error = KitToolError::from(failure).context(&format!("in the open {} editor: ", short(kit)));
    if error.index.is_none() {
        error = error.at(step);
    }
    let told = |key: &str| data.get(key).filter(|value| value.is_array()).cloned();
    match (told("completed"), told("rolledBack")) {
        (None, None) => {
            match step {
                Some(0) => {}
                None if steps < 2 => {}
                None => error.message.push_str(
                    " The editor did not say whether the step(s) before it were rolled back: they may stay in the document; inspect it before going on.",
                ),
                Some(before) if data["reason"] == "held" => error.message.push_str(&format!(
                    " A step refused for another session's lease runs nothing, and the {before} step(s) before it stay in the document (not rolled back): undo them (`edit.undo`) or keep them."
                )),
                Some(before) => error.message.push_str(&format!(
                    " The editor did not say whether the step(s) before it ({before}) were rolled back: they may stay in the document; inspect it before going on."
                )),
            }
            error
        }
        (completed, rolled_back) => {
            let mut output = json!({ "completed": completed.unwrap_or_else(|| json!([])) });
            lean_completed(&mut output);
            if let Some(mut rolled_back) = rolled_back {
                let mut lean = json!({ "completed": rolled_back.take() });
                lean_completed(&mut lean);
                output["rolledBack"] = lean["completed"].take();
            }
            if data["editedMeanwhile"] == true {
                output["editedMeanwhile"] = Value::Bool(true);
            }
            output["saved"] = Value::Bool(false);
            error.with_output(output)
        }
    }
}

/// A run's `view` (what its after-picture shows, as the inspect tool's `target` names it), as the
/// render command's request; `None` without one. Only a kit with a render command draws a view:
/// another kit's after-picture is the whole document, and a `view` for it is `unsupported`, as is
/// one for a draft (its preview is the whole draft).
fn run_view(kit: &KitDefinition, input: &Value) -> Result<Option<Value>, KitToolError> {
    let Some(view) = input.get("view").filter(|view| !view.is_null()) else { return Ok(None) };
    if !view.is_object() {
        return Err(KitToolError::invalid(format!(
            "`view` is {view}: what the preview shows, an object as the inspect tool's `target` (for example {{\"time\": 3}})"
        )));
    }
    let inspect = tool_name(kit, Action::Inspect);
    if kit.agent.render.is_none() {
        return Err(KitToolError::new(
            ErrorCode::Unsupported,
            format!(
                "{} has no render command (`agent.render` in its kit.json), so a run's preview is the whole document: nothing was run. Leave `view` out, or call {inspect} with `target` and `preview` after the run.",
                short(kit)
            ),
        ));
    }
    Ok(Some(json!({ "target": view })))
}

/// Sets what a planned step acts in and on before it runs ([`context::set`]), or goes to its
/// part through the kit's `slide.go` or `page.go` when the kit has no editor-state hooks.
async fn prepare(kits: &KitManager, view: &DocumentView, step: &context::Planned, path: &str) -> Result<(), KitToolError> {
    if let Some(part) = &step.go {
        let input = json!({ "target": part });
        resolve_part(kits, view, &input)
            .await?
            .ok_or_else(|| KitToolError::invalid(format!("cannot go to that part of `{path}` (the kit has no slide.go or page.go)")))?;
    }
    context::set(kits, view.kit_id, &view.document_id, step).await
}

/// A failed `<prefix>_run` is atomic (KHP A53): the session's document is put back as it was before
/// the call and nothing is saved. The error lists the steps that ran before the failure as
/// `rolledBack`, with `completed` empty; when the document cannot be put back it says so, and the
/// steps that stay are `completed`. Either way the kit's editor state is then put back as `saved`
/// (on the reopened document when the document was reopened).
async fn rolled_back(
    kits: &KitManager,
    path: &str,
    view: &DocumentView,
    was_dirty: bool,
    done: Vec<Value>,
    saved: &context::Saved,
    mut failure: KitToolError,
) -> KitToolError {
    match restore(kits, path, view, was_dirty, &done).await {
        Ok(restored) => {
            if !done.is_empty() {
                failure.message.push_str(&format!(
                    " The {} step(s) before it were rolled back: `{path}` is as it was before the call, and nothing was saved.",
                    done.len()
                ));
            }
            failure.message.push_str(&context::restore_noted(kits, restored.kit_id, &restored.document_id, saved).await.unwrap_or_default());
            failure.with_output(json!({ "completed": [], "rolledBack": done, "saved": false, "document": document_summary_json(&restored) }))
        }
        Err(reason) => {
            failure.message.push_str(&format!(
                " The {} step(s) before it could not be rolled back ({reason}): they stay in `{path}`, unsaved; undo them (`edit.undo`) or save to keep them.",
                done.len()
            ));
            failure.message.push_str(&context::restore_noted(kits, view.kit_id, &view.document_id, saved).await.unwrap_or_default());
            failure.with_output(json!({ "completed": done, "saved": false, "document": document_summary_json(view) }))
        }
    }
}

/// Puts the headless document of a failed run back as it was before the call: a document that
/// had no unsaved edits is closed without saving and opened again from its file; one that had is
/// taken back by undoing each step that changed it, in the agent's undo scope. Answers the
/// document as it now is.
async fn restore(kits: &KitManager, path: &str, view: &DocumentView, was_dirty: bool, done: &[Value]) -> Result<DocumentView, String> {
    let now = kits.document(Caller::Agent, view.kit_id, &view.document_id).await.map_err(|error| error.to_string())?;
    let changed = done.iter().filter(|step| step.get("changed") != Some(&Value::Bool(false))).count();
    if !was_dirty {
        if !now.dirty && changed == 0 {
            return Ok(now);
        }
        kits.close(view.kit_id, &view.document_id, true).await.map_err(|error| error.to_string())?;
        return kits.open(Caller::Agent, path).await.map_err(|error| error.to_string());
    }
    if done.iter().any(|step| matches!(step["command"].as_str(), Some("edit.undo" | "edit.redo"))) {
        return Err("the steps undid or redid edits themselves".into());
    }
    let mut now = now;
    for _ in 0..changed {
        let mut params = Map::new();
        params.insert("scope".into(), Value::String("agent".into()));
        let undone = kits.execute(Caller::Agent, view.kit_id, &view.document_id, "edit.undo", params).await.map_err(|error| error.to_string())?;
        if !undone.changed {
            return Err("the kit had nothing more to undo".into());
        }
        now = undone.document.ok_or("the document was closed while undoing")?;
    }
    Ok(now)
}

/// A command's parameter schema as `<prefix>_commands` lists it: the schema itself (KHP A5), without
/// what repeats it. The top-level `description` is the kit's notation of the same parameters, kept
/// only for what the schema cannot say, the result after `→` (`returns`); a property description
/// that names nothing beyond its type (`an id`, `[shape id]`, the key's own name) goes.
fn lean_params(params: &Value) -> Value {
    let mut schema = params.clone();
    let Some(object) = schema.as_object_mut() else {
        return schema;
    };
    let has_properties = object.get("properties").and_then(Value::as_object).is_some_and(|properties| !properties.is_empty());
    if has_properties
        && let Some(Value::String(notation)) = object.remove("description")
        && let Some((_, returns)) = notation.split_once('→')
    {
        object.insert("returns".into(), Value::String(returns.trim().to_owned()));
    }
    if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
        for (key, property) in properties.iter_mut() {
            if let Some(property) = property.as_object_mut() {
                let generic = property.get("description").and_then(Value::as_str).is_some_and(|text| {
                    let text = text.trim().to_ascii_lowercase();
                    text == "an id"
                        || text == "[shape id]"
                        || text == "[..]"
                        || text == key.to_ascii_lowercase()
                        || text == format!("{} (no type given)", key.to_ascii_lowercase())
                });
                if generic {
                    property.remove("description");
                }
            }
        }
    }
    schema
}

/// One step of a `<prefix>_run` answer: its command, `changed: false` only when it changed nothing,
/// and its `result` only when it answered one. A step that changed the document and answered
/// nothing (most formatting) is `{command}`.
fn step_entry(command: &str, changed: bool, result: Option<Value>) -> Value {
    let mut entry = json!({ "command": command });
    if !changed {
        entry["changed"] = Value::Bool(false);
    }
    if let Some(mut result) = result.filter(|result| !result.is_null()) {
        if let Some(cut) = shorten(&mut result, MAX_STEP_RESULT) {
            entry["truncated"] = cut;
        }
        entry["result"] = result;
    }
    entry
}

/// The most characters one step's `result` brings into the agent's context. Listings that
/// exceed this limit are cut to fit and say so; the kit's own API is untouched.
const MAX_STEP_RESULT: usize = 8_000;

/// Cuts the longest array in `value` (the value itself, or one of its fields) to the items that fit
/// in `limit` characters, and answers what was cut: `{field?, shown, total, hint}`. None when the
/// value fits, or holds no array to cut.
fn shorten(value: &mut Value, limit: usize) -> Option<Value> {
    if value.to_string().len() <= limit {
        return None;
    }
    let (field, items) = match value {
        Value::Array(items) => (None, items),
        Value::Object(fields) => {
            let key = fields.iter().filter(|(_, v)| v.is_array()).max_by_key(|(_, v)| v.to_string().len()).map(|(k, _)| k.clone())?;
            (Some(key.clone()), fields.get_mut(&key)?.as_array_mut()?)
        }
        _ => return None,
    };
    let total = items.len();
    let mut kept = 0;
    let mut used = 0;
    for item in items.iter() {
        let size = item.to_string().len() + 1;
        if used + size > limit && kept > 0 {
            break;
        }
        used += size;
        kept += 1;
    }
    if kept >= total {
        return None;
    }
    items.truncate(kept);
    let mut cut =
        json!({ "shown": kept, "total": total, "hint": "the answer was cut to fit; narrow it with the command's own parameters (a query, filter, or range)" });
    if let Some(field) = field {
        cut["field"] = Value::String(field);
    }
    Some(cut)
}

/// [`step_entry`] for the steps an open editor answered.
fn lean_completed(answer: &mut Value) {
    if let Some(steps) = answer.get_mut("completed").and_then(Value::as_array_mut) {
        for step in steps.iter_mut() {
            let command = step["command"].as_str().unwrap_or_default().to_owned();
            let changed = step["changed"].as_bool() != Some(false);
            *step = step_entry(&command, changed, step.get("result").cloned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kit(id: &str) -> &'static KitDefinition {
        crate::definitions::fixture_kit(id)
    }

    #[test]
    fn the_agents_undo_and_redo_steps_run_in_its_undo_scope() {
        crate::definitions::fixture_kits();
        let steps = vec![
            json!({ "command": "text.append", "params": { "text": "a" } }),
            json!({ "command": "edit.undo" }),
            json!({ "command": "edit.redo", "params": { "steps": 2 } }),
            json!({ "command": "edit.undo", "params": { "scope": "person" } }),
        ];
        let scoped = in_agent_scope(&steps);
        assert_eq!(scoped[0], steps[0]);
        assert_eq!(scoped[1], json!({ "command": "edit.undo", "params": { "scope": "agent" } }));
        assert_eq!(scoped[2], json!({ "command": "edit.redo", "params": { "steps": 2, "scope": "agent" } }));
        assert_eq!(scoped[3], steps[3]);
    }

    #[test]
    fn summarizes_diagnostics_by_severity() {
        crate::definitions::fixture_kits();
        let found = |severity: &str| json!({ "code": "slide.x", "severity": severity, "target": {}, "message": "x" });
        assert_eq!(diagnostics_summary("`a.pptx`", &[]), "Checked `a.pptx`: the kit found nothing wrong.");
        assert_eq!(diagnostics_summary("`a.pptx`", &[found("error"), found("warning"), found("warning")]), "Checked `a.pptx`: 1 error, 2 warnings, no notes.");
    }

    #[test]
    fn a_slide_or_page_target_counts_from_1() {
        crate::definitions::fixture_kits();
        for bad in [json!({"slide": 0}), json!({"page": 0}), json!({"slide": "2"}), json!({"slide": 1.5})] {
            let Err(error) = check_target_part(&json!({ "target": bad }), None) else {
                panic!("{bad} is refused");
            };
            assert!(error.message.contains("counted from 1"), "{}", error.message);
        }
        for good in [json!({}), json!({"target": {"slide": 1}}), json!({"target": {"path": "layer:12"}})] {
            assert!(check_target_part(&good, None).is_ok());
        }
    }

    #[test]
    fn a_part_id_is_a_whole_number_and_inspect_says_to_come_back_by_it() {
        crate::definitions::fixture_kits();
        for bad in [json!({"slideId": "260"}), json!({"pageId": -1}), json!({"slideId": 2.5})] {
            let Err(error) = check_target_part(&json!({ "target": bad }), None) else {
                panic!("{bad} is refused");
            };
            assert!(error.message.contains("whole number"), "{}", error.message);
        }
        assert!(check_target_part(&json!({"target": {"slideId": 260}}), None).is_ok());
        assert_eq!(target_part_id(kit("kit.slide"), &json!({"target": {"slideId": 260}})), Some(260));
        assert_eq!(target_part(kit("kit.slide"), &json!({"target": {"slideId": 260}})), None);
        let by_number = json!({"target": {"slide": 3}});
        let back = come_back(&by_number, &json!({"id": 260, "shapes": []}));
        assert!(back.contains(r#"`target: {"slideId": 260}`"#) && back.contains("deleted"), "{back}");
        let back = come_back(&json!({"target": {"page": 2}}), &json!({"id": 7}));
        assert!(back.contains(r#"{"pageId": 7}"#), "{back}");
        assert!(come_back(&by_number, &json!({"shapes": []})).contains("the same `target`"));
    }

    /// An inspect's `target` naming a sheet by its integer id reaches the kit's reader: dropped, it
    /// showed the active sheet instead (regressions/issue-inspect-part-id).
    #[test]
    fn a_sheet_named_by_its_integer_id_is_passed_to_the_reader() {
        let (params, asked) = content_params(Some(&json!({ "sheet": 3 })));
        assert_eq!(params.get("sheet"), Some(&json!(3)));
        assert!(!asked);
        let (params, asked) = content_params(Some(&json!({ "sheet": "Data", "range": "A1:B2" })));
        assert_eq!((params.get("sheet"), params.get("range"), asked), (Some(&json!("Data")), Some(&json!("A1:B2")), true));
    }

    #[test]
    fn run_refuses_the_export_command() {
        crate::definitions::fixture_kits();
        let motion = kit("kit.motion");
        let steps = [json!({ "command": "file.exportMovie", "params": {} })];
        let Err(error) = refuse_export_command(motion, &steps) else {
            panic!("_run refuses the export command");
        };
        assert!(error.message.contains("motion_export"), "{}", error.message);
        assert!(refuse_export_command(motion, &[json!({ "command": "layer.newText" })]).is_ok());
    }

    #[test]
    fn a_search_that_matches_nothing_says_so_and_points_at_export() {
        crate::definitions::fixture_kits();
        let closest = vec![json!({ "id": "renderQueue.add", "title": "Add to Render Queue", "params": {}, "closest": true })];
        let answer = listed_commands("mp4", closest);
        assert!(answer.summary.starts_with("No command matches `mp4`"), "{}", answer.summary);
        assert_eq!(answer.output["total"], 0);
        let motion = kit("kit.motion");
        let sheet = kit("kit.sheet");
        assert!(file_tool_hint(motion, "render mp4").is_some_and(|hint| hint.contains("motion_export")));
        assert!(file_tool_hint(motion, "new project file").is_some_and(|hint| hint.contains("motion_create")));
        assert!(file_tool_hint(motion, "text layer").is_none());
        assert!(file_tool_hint(sheet, "export csv").is_some_and(|hint| hint.contains("sheet_export")), "sheet exports PDF, CSV and HTML for the agent");
    }

    #[test]
    fn kits_that_create_offer_create() {
        crate::definitions::fixture_kits();
        let slide = kit("kit.slide");
        assert!(offers(slide, "slide_create"), "slide creates .kslide");
        assert!(slide.creates.contains(&("kslide", "slide")));
        let motion = kit("kit.motion");
        assert!(offers(motion, "motion_create") && offers(motion, "motion_export"));
        let Some(create) = specs().into_iter().find(|spec| spec.name == "motion_create") else {
            panic!("motion_create is a tool");
        };
        assert!(create.writes && create.description.contains(".kmotion"));
        assert_eq!(parse("motion_create").map(|(kit, action)| (kit.id, action)), Some(("kit.motion", Action::Create)));
    }

    #[test]
    fn only_kits_that_declare_drafts_or_an_object_model_offer_their_tools() {
        crate::definitions::fixture_kits();
        let design = kit("kit.design");
        let film = kit("kit.film");
        let html = kit("kit.html");
        assert!(!design.agent.drafts && design.agent.object_model && film.agent.drafts && !html.agent.object_model);
        for (kit, action, offered) in [
            (design, Action::DraftReady, false),
            (design, Action::DraftReopen, false),
            (design, Action::Query, true),
            (design, Action::Batch, true),
            (film, Action::DraftReady, true),
            (film, Action::DraftReopen, true),
            (html, Action::Query, false),
            (html, Action::Batch, false),
        ] {
            assert_eq!(offers(kit, &tool_name(kit, action)), offered, "{} {action:?} (KHP A35)", kit.id);
        }
    }

    #[test]
    fn a_long_step_result_is_cut_to_fit_and_says_so() {
        let families: Vec<Value> = (0..2000).map(|i| json!({ "family": format!("Font {i}"), "styles": ["Regular", "Bold"] })).collect();
        let entry = step_entry("text.fonts", false, Some(json!({ "count": 2000, "families": families })));
        assert!(entry["result"].to_string().len() <= MAX_STEP_RESULT + 200, "{}", entry["result"].to_string().len());
        assert_eq!(entry["truncated"]["field"], "families");
        assert_eq!(entry["truncated"]["total"], 2000);
        assert_eq!(entry["result"]["count"], 2000, "the kit's own count stays");
        let small = step_entry("shape.insert", true, Some(json!({ "id": 24 })));
        assert!(small.get("truncated").is_none());
    }

    #[test]
    fn a_search_lists_one_line_per_command_and_the_schema_on_request() {
        let command = json!({
            "id": "file.new", "title": "New slide", "enabled": true,
            "description": "Starts a new presentation, from a theme and slide size or blank, replacing the open one in this session. More words.",
            "params": { "type": "object", "required": ["theme"], "properties": {
                "blank": { "type": "boolean" },
                "size": { "type": "array", "items": { "type": "number" }, "description": "[w, h] in points" },
                "theme": { "type": "string" },
                "fit": { "enum": ["fill", "fit"] }
            } }
        });
        let brief = brief_command(command.clone());
        assert_eq!(brief["params"], "{blank?: boolean, fit?: fill|fit, size?: number[] ([w, h] in points), theme: string}");
        assert_eq!(brief["description"], "Starts a new presentation, from a theme and slide size or blank, replacing the open one in this session.");
        let listed = listed_commands_with("new", vec![command.clone()], false);
        assert!(listed.output["commands"][0]["params"].is_string(), "a search lists one line");
        let detailed = listed_commands_with("new", vec![command.clone()], true);
        assert!(detailed.output["commands"][0]["params"]["properties"].is_object(), "detail lists the schema (KHP A5)");
        let by_id = listed_commands_with("file.new", vec![command], false);
        assert!(by_id.output["commands"][0]["params"]["properties"].is_object(), "a command named by its id is listed in full");
    }

    #[test]
    fn a_listed_schema_drops_what_repeats_it() {
        let params = json!({
            "type": "object",
            "description": "{text, id?: shape, slide?: index} → {index, thread}",
            "properties": {
                "text": { "type": "string" },
                "id": { "description": "an id", "oneOf": [{ "type": "integer" }, { "type": "string" }] },
                "slide": { "type": "integer", "description": "a position counted from 0 (the first is 0)" },
                "created": { "description": "created (no type given)" }
            }
        });
        let lean = lean_params(&params);
        assert!(lean.get("description").is_none(), "{lean}");
        assert_eq!(lean["returns"], "{index, thread}");
        assert!(lean["properties"]["id"].get("description").is_none() && lean["properties"]["created"].get("description").is_none());
        assert_eq!(lean["properties"]["slide"]["description"], "a position counted from 0 (the first is 0)", "what the type does not say stays");
        let notes_only = json!({ "type": "object", "description": "{} — delete selected items" });
        assert_eq!(lean_params(&notes_only), notes_only, "a schema without properties keeps its notes");
    }

    #[test]
    fn a_run_step_says_only_what_is_news() {
        assert_eq!(step_entry("format.bold", true, Some(Value::Null)), json!({ "command": "format.bold" }));
        assert_eq!(step_entry("shape.insert", true, Some(json!({ "id": 24 }))), json!({ "command": "shape.insert", "result": { "id": 24 } }));
        assert_eq!(step_entry("time.set", false, None), json!({ "command": "time.set", "changed": false }));
        let mut answer = json!({ "completed": [{ "command": "a", "changed": true, "result": null }, { "command": "b", "changed": false, "result": 3 }] });
        lean_completed(&mut answer);
        assert_eq!(answer["completed"], json!([{ "command": "a" }, { "command": "b", "changed": false, "result": 3 }]));
    }

    #[test]
    fn a_search_counts_the_commands_with_every_word_apart() {
        let command = |id: &str, all: bool| json!({ "id": id, "title": id, "params": {}, "allWords": all, "closest": false });
        let out = listed_commands("layer timing", vec![command("layer.timing", true), command("layer.newText", false), command("time.set", false)]);
        assert_eq!(out.summary, "1 commands have every word of `layer timing`, 2 more some of them");
        let out = listed_commands("layer zebra", vec![command("layer.newText", false)]);
        assert!(out.summary.starts_with("No command has every word of `layer zebra`; 1 have some of them"), "{}", out.summary);
    }

    #[test]
    fn listed_commands_carry_their_parameter_schemas() {
        crate::definitions::fixture_kits();
        let schema = json!({ "type": "object", "properties": { "x": { "type": "integer", "description": "Column, from 0." } }, "required": ["x"] });
        let listed = compact_command(json!({ "id": "cell.set", "title": "Set Cell", "params": schema, "enabled": true }));
        assert_eq!(listed["params"], schema, "a schema, never the notation text (KHP A5)");
        assert!(listed.get("enabled").is_none());
        let disabled = compact_command(json!({ "id": "edit.undo", "title": "Undo", "params": { "type": "object" }, "enabled": false }));
        assert_eq!(disabled["enabled"], false);
        assert!(listed.get("description").is_none() && listed.get("output").is_none(), "nothing the kit did not say");
    }

    #[test]
    fn listed_commands_say_what_they_do_and_what_they_answer() {
        let output = json!({ "type": "object", "properties": { "value": {} } });
        let listed = compact_command(json!({
            "id": "cell.get",
            "title": "Get Cell",
            "description": "Reads one cell's value and formula without changing the sheet; use it before cell.set.",
            "params": { "type": "object" },
            "output": output,
            "enabled": true,
        }));
        assert_eq!(listed["description"], "Reads one cell's value and formula without changing the sheet; use it before cell.set.");
        assert_eq!(listed["output"], output, "a read command's answer shape (KHP A1)");
    }

    #[test]
    fn a_commands_detail_says_what_it_acts_on_and_what_editor_state_it_reads() {
        let command = |params: Value| json!({ "id": "shape.upper", "title": "Upper-case", "params": params, "enabled": true });
        let declared = json!({
            "type": "object",
            "x-khp-reads": ["selection", "part"],
            "properties": { "ids": { "type": "array", "items": { "type": "string" }, "x-khp-role": "targets" } }
        });
        let detail = detailed_command(command(declared.clone()));
        assert_eq!(detail["targets"], json!({ "param": "ids", "takes": "a list of ids" }));
        assert_eq!(detail["reads"], json!(["selection", "part"]));
        assert_eq!(
            detail["params"],
            json!({ "type": "object", "properties": { "ids": { "type": "array", "items": { "type": "string" } } } }),
            "said once, beside the schema"
        );
        let one = detailed_command(command(json!({ "properties": { "id": { "type": "string", "x-khp-role": "targets" } } })));
        assert_eq!(one["targets"]["takes"], "one id");
        let plain = detailed_command(command(json!({ "type": "object" })));
        assert!(plain.get("targets").is_none() && plain.get("reads").is_none(), "{plain}");
        let brief = brief_command(command(declared));
        assert_eq!(brief["params"], "{ids?: string[]}", "the one-line form stays one line");
    }

    /// A command that reads the editor's mode or active object, which no call context
    /// sets, says so in both forms the commands tool answers, so the model sets them in the run.
    #[test]
    fn a_command_that_reads_the_mode_or_the_active_object_says_to_set_it_in_the_run() {
        let command = |reads: Value| json!({ "id": "mesh.extrude", "title": "Extrude", "params": { "type": "object", "x-khp-reads": reads }, "enabled": true });
        for form in [detailed_command(command(json!(["mode", "selection"]))), brief_command(command(json!(["mode", "selection"])))] {
            let needs = form["dependsOn"].as_str().unwrap_or_default();
            assert!(needs.contains("mode") && needs.contains("same run") && !needs.contains("active"), "{form}");
        }
        let active = detailed_command(command(json!(["active"])));
        assert!(active["dependsOn"].as_str().is_some_and(|needs| needs.contains("active")), "{active}");
        assert_eq!(active["reads"], json!(["active"]));
        let set_by_context = brief_command(command(json!(["selection", "part", "time"])));
        assert!(set_by_context.get("dependsOn").is_none(), "the call context sets those: {set_by_context}");
    }

    /// a command that reads the selected area (`area`, a photo kit's marquee),
    /// which no call context sets, says so as it does for the mode and the active object.
    #[test]
    fn a_command_that_reads_the_selected_area_says_to_set_it_in_the_run() {
        let command = json!({ "id": "selection.fill", "title": "Fill", "params": { "type": "object", "x-khp-reads": ["area"] }, "enabled": true });
        let detailed = detailed_command(command.clone());
        assert!(detailed["dependsOn"].as_str().is_some_and(|needs| needs.contains("`area`") && needs.contains("same run")), "{detailed}");
        assert_eq!(detailed["reads"], json!(["area"]));
        assert!(brief_command(command)["dependsOn"].as_str().is_some_and(|needs| needs.contains("`area`")));
    }

    #[test]
    fn the_default_preview_is_the_kit_s_render_framed_to_the_content() {
        crate::definitions::fixture_kits();
        let params = render_params(&json!({ "path": "a.kdesign", "preview": true }), None, &RenderView::Unknown).unwrap_or_default();
        assert_eq!(Value::Object(params), json!({ "scale": 1 }), "the document at scale 1 (KHP A39)");
        let doubled = render_params(&json!({ "path": "a.kdesign", "scale": 2 }), None, &RenderView::Unknown).unwrap_or_default();
        assert_eq!(doubled.get("scale"), Some(&json!(2)));
    }

    #[test]
    fn every_kit_gets_inspect_commands_and_run() {
        crate::definitions::fixture_kits();
        let kits = crate::definitions::fixture_kits();
        let mut prefixes: Vec<&str> = kits.iter().map(|kit| kit.agent.prefix).collect();
        prefixes.sort_unstable();
        prefixes.dedup();
        assert_eq!(prefixes.len(), kits.len(), "prefixes are unique");
        for kit in &kits {
            assert_eq!(specs_of(kit).len(), Action::ALL.len(), "{}", kit.id);
        }
        for kit in kits {
            for action in Action::ALL {
                let name = tool_name(kit, action);
                let spec = specs().into_iter().find(|spec| spec.name == name).unwrap_or_else(|| panic!("{name}"));
                assert_eq!(parse(&name).map(|(found, action)| (found.id, action)), Some((kit.id, action)));
                assert!(spec.description.contains(kit.name), "{}", spec.description);
                assert_eq!(spec.writes, action.writes(), "{name}");
                assert_eq!(spec.input_schema["required"][0], "path");
                assert!(label(&name).is_some_and(|label| label.contains(short(kit))));
            }
        }
        for name in ["photo_inspect", "photo_commands", "photo_run"] {
            assert!(specs().iter().any(|spec| spec.name == name), "{name}");
        }
        assert!(parse("document_read").is_none() && parse("photo_paint").is_none());
        assert_eq!(parse("slide_check").map(|(kit, action)| (kit.id, action)), Some(("kit.slide", Action::Check)));
        assert!(!Action::Check.writes());
        // Draft tools: asking for review and reopening; merging and discarding are never tools.
        let slide = |name: &str| parse(name).map(|(kit, action)| (kit.id, action));
        assert_eq!(slide("slide_draft_ready"), Some(("kit.slide", Action::DraftReady)));
        assert_eq!(slide("slide_draft_reopen"), Some(("kit.slide", Action::DraftReopen)));
        assert!(parse("slide_draft_merge").is_none() && parse("slide_draft_discard").is_none());
        assert!(parse("slide_draft").is_none() && parse("_draft_ready").is_none());
        let run = specs().into_iter().find(|spec| spec.name == "slide_run").unwrap_or_else(|| panic!("slide_run"));
        assert_eq!(run.input_schema["properties"]["draft"]["type"], "boolean");
        assert!(run.description.contains("slide_draft_ready"), "{}", run.description);
    }

    #[test]
    fn a_kit_file_is_edited_through_its_own_kit() {
        crate::definitions::fixture_kits();
        let prompt = |path: &str| linked_file_prompt(path).unwrap_or_else(|| panic!("{path} opens in a kit"));
        let vector = prompt("art/Logo.kvector");
        assert!(vector.contains("vector_inspect") && vector.contains("vector_run") && vector.contains("in Vector"), "{vector}");
        assert!(prompt("motion/Intro.kmotion").contains("motion_commands"));
        assert!(prompt("print/Flyer.klayout").contains("layout_run"));
        assert!(prompt("plans/Floor.dxf").contains("cad_run"));
        assert!(prompt("talks/Launch.pptx").contains("slide_run"));
        assert!(prompt("talks/Launch.pptx").contains("document_read extracts its text"), "PowerPoint text stays readable");
        assert!(prompt("talks/Launch.kslide").contains("it is binary data"));
        assert!(prompt("letters/Hello.docx").contains("doc_run"));
        assert!(prompt("money/Budget.xlsx").contains("sheet_run"));
        assert!(prompt("papers/Report.pdf").contains("pdf_run") && prompt("papers/Report.pdf").contains("document_read extracts its text"));
        let note = prompt("notes/plan.md");
        assert!(
            note.contains("note_inspect")
                && note.contains("note_run")
                && note.contains("in Note")
                && note.contains("document_read reads its text as it is")
                && !note.contains("binary data"),
            "a note is text the agent may read: {note}"
        );
        assert!(linked_file_prompt("notes/plan.txt").is_none());
        let vector_kit = kit("kit.vector");
        let wrong = kit_path(&json!({ "path": "art/Cover.psd" }), vector_kit)
            .err()
            .map(|error| (error.code, error.message))
            .unwrap_or((ErrorCode::Failed, String::new()));
        assert_eq!(wrong.0, ErrorCode::InvalidParams);
        let wrong = wrong.1;
        assert!(wrong.contains("photo_*"), "{wrong}");
        assert_eq!(kit_path(&json!({ "path": "art/Logo.kvector" }), vector_kit).unwrap_or_else(|err| panic!("{}", err.message)), "art/Logo.kvector");
    }

    #[test]
    fn without_a_query_every_command_is_listed_a_page_at_a_time_by_id() {
        let command = |id: &str| json!({ "id": id, "title": id, "description": "Does one thing to the document.", "params": { "type": "object", "properties": { "n": { "type": "integer" } } }, "enabled": true, "mutates": true });
        let found: Vec<Value> = ["c.three", "a.one", "b.two"].into_iter().map(command).collect();
        let first = paged_commands(found.clone(), Page { start: 0, limit: 2 }, false);
        let ids: Vec<&str> = first.output["commands"].as_array().into_iter().flatten().filter_map(|c| c["id"].as_str()).collect();
        assert_eq!(ids, ["a.one", "b.two"]);
        assert_eq!(first.output["total"], 3);
        assert_eq!(first.output["next"], "2");
        assert!(first.output["commands"][0]["params"].is_string(), "a page lists the compact signature");
        let last = paged_commands(found.clone(), Page { start: 2, limit: 2 }, true);
        assert_eq!(last.output["commands"][0]["id"], "c.three");
        assert!(last.output.get("next").is_none());
        assert!(last.output["commands"][0]["params"]["properties"].is_object(), "detail lists the schema");
        assert_eq!(Page::from_input(&json!({})).unwrap(), Page { start: 0, limit: DEFAULT_LISTED });
        assert_eq!(Page::from_input(&json!({ "cursor": "2", "limit": 7 })).unwrap(), Page { start: 2, limit: 7 });
        assert!(Page::from_input(&json!({ "cursor": "x" })).is_err());
        assert!(Page::from_input(&json!({ "limit": 0 })).is_err());
        assert!(Page::from_input(&json!({ "limit": MAX_LISTED + 1 })).is_err());
    }
}
