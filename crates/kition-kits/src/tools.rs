//! Kit tools (Kition Kit Standard A3): for every kit, inspect a file, search its commands, and
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

mod errors;
pub mod model;
pub mod schemas;

use std::sync::LazyLock;

use serde_json::{Map, Value, json};

pub use errors::{ErrorCode, KitToolError};

use crate::bridge::LiveDocument;
use crate::drafts::{self, DraftState};
use crate::manager::{Caller, DocumentView, KITS, KitDefinition, KitManager};

const PREVIEW_SIZE: u32 = 1024;
const MAX_COMMANDS: usize = 12;

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
}

impl Action {
    pub const ALL: [Action; 8] = [
        Action::Inspect,
        Action::Commands,
        Action::Run,
        Action::DraftReady,
        Action::DraftReopen,
        Action::Query,
        Action::Batch,
        Action::Check,
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
        }
    }

    /// Whether the tool changes files.
    pub fn writes(self) -> bool {
        matches!(self, Action::Run | Action::Batch)
    }
}

/// How a harness runs kit tools: Kition's agent passes the run's choice of live or draft editing
/// (the agent UI's setting); a tool call's own `draft` argument wins over it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CallOptions {
    /// Edit drafts unless a call says `draft: false`.
    pub draft: bool,
}

/// One kit tool as a harness offers it to a model.
#[derive(Clone, Debug)]
pub struct KitToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema for the arguments.
    pub input_schema: Value,
    /// Whether the tool changes files (`<prefix>_run`, `<prefix>_batch`).
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
        Self {
            summary,
            output,
            previews: Vec::new(),
        }
    }
}

pub type KitToolResult = Result<KitToolOutput, KitToolError>;

pub fn tool_name(kit: &KitDefinition, action: Action) -> String {
    if unified() {
        return format!("kit_{}", action.suffix());
    }
    format!("{}_{}", kit.agent.prefix, action.suffix())
}

/// One entry point for every kit (`KHP_UNIFIED`): tools named `kit_<action>`, routed by the
/// extension of the call's `path`, so the tool list does not grow with the number of kits.
pub fn unified() -> bool {
    std::env::var_os("KHP_UNIFIED").is_some()
}

/// The kit and action of a unified tool call (`kit_run` on `report.xlsx` is Sheet's run).
fn unified_route(name: &str, input: &Value) -> Option<(&'static KitDefinition, Action)> {
    let suffix = name.strip_prefix("kit_")?;
    let action = Action::ALL
        .into_iter()
        .find(|action| action.suffix() == suffix)?;
    let path = input.get("path")?.as_str()?;
    let extension = path.trim().rsplit_once('.')?.1.to_ascii_lowercase();
    let kit = KITS
        .iter()
        .find(|kit| kit.extensions.contains(&extension.as_str()))?;
    Some((kit, action))
}

/// The unified tool set: one kit's tools, worded for all the installed kits.
fn unified_specs(on: &[&'static KitDefinition]) -> Vec<KitToolSpec> {
    let first = on[0];
    let formats = on
        .iter()
        .map(|kit| format!("{}: {}", kit.name, kit.agent.formats))
        .collect::<Vec<_>>()
        .join("; ");
    let words = |text: &str| {
        text.replace(first.agent.formats, &formats)
            .replace(first.agent.reports, "its structure")
            .replace(
                &format!(" in {}", first.name),
                " in the kit for its file type",
            )
            .replace(first.agent.noun, "file")
    };
    specs_of(first)
        .into_iter()
        .map(|spec| KitToolSpec {
            name: spec.name,
            description: words(&spec.description),
            input_schema: serde_json::from_str(&words(&spec.input_schema.to_string()))
                .unwrap_or(spec.input_schema),
            writes: spec.writes,
        })
        .collect()
}

/// The kit and action a tool name names, if it is a kit tool.
pub fn parse(name: &str) -> Option<(&'static KitDefinition, Action)> {
    Action::ALL.into_iter().find_map(|action| {
        let prefix = name.strip_suffix(action.suffix())?.strip_suffix('_')?;
        let kit = KITS.iter().find(|kit| kit.agent.prefix == prefix)?;
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

pub(crate) fn draft_property() -> Value {
    json!({ "type": "boolean", "description": "Work on your draft of the file instead of the live document: the person reviews it and merges or discards it. Defaults to the run's mode." })
}

fn specs_of(kit: &'static KitDefinition) -> [KitToolSpec; 8] {
    specs_described(kit, None)
}

/// The kit's tools, with the object-model tools' arguments generated from `described` (what the
/// kit's `model.describe` answered) when it is known.
fn specs_described(kit: &'static KitDefinition, described: Option<&Value>) -> [KitToolSpec; 8] {
    let agent = &kit.agent;
    let (name, noun) = (kit.name, agent.noun);
    let commands = tool_name(kit, Action::Commands);
    let run = tool_name(kit, Action::Run);
    let ready = tool_name(kit, Action::DraftReady);
    [
        KitToolSpec {
            name: tool_name(kit, Action::Inspect),
            description: format!(
                "Open a {noun} ({}) in {name} and report {}. By default it also attaches a rendered preview to the next turn so you can see it. With `target` (for example {{\"slide\": 3}}) it previews only that part and lists its objects (ids, kinds, names, boxes, text, fills), which is the usual way to find what to edit. Use it before and after editing.",
                agent.formats, agent.reports
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": path_property(kit),
                    "preview": { "type": "boolean", "description": "Attach a rendered preview image. Defaults to true." },
                    "target": { "type": "object", "description": "Look at one part: {\"slide\": 3} or {\"page\": 2} (counted from 1) previews it and lists its objects; {\"range\": \"A1:J20\", \"sheet\": \"name\"} lists those cells of a spreadsheet; {\"paragraphs\": [0, 30]} lists those paragraphs of a document (counted from 0). Kits that cannot render a part fall back to the whole document.", "properties": { "slide": { "type": "integer", "minimum": 1 }, "page": { "type": "integer", "minimum": 1 }, "range": { "type": "string" }, "sheet": { "type": "string" }, "paragraphs": { "type": "array", "items": { "type": "integer" } } } },
                    "draft": draft_property()
                },
                "required": ["path"]
            }),
            writes: false,
        },
        KitToolSpec {
            name: commands.clone(),
            description: format!(
                "Search {name}'s editing commands ({}) by keywords. Returns command ids with their parameter notes; pass an id to {run}.",
                agent.covers
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": path_property(kit),
                    "query": { "type": "string", "description": format!("Keywords to match in the command id, title, or description, for example {}.", agent.queries) }
                },
                "required": ["path", "query"]
            }),
            writes: false,
        },
        KitToolSpec {
            name: run.clone(),
            description: format!(
                "Edit a {noun} in {name} by running commands in order, then save the file. Each step is one undoable command with a JSON object of params, as documented by {commands}. Stops at the first failing step. Answers each step's result and a short document summary. With `draft`, the steps edit your draft of the file instead (never saved); call {ready} when it is done."
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
                                "params": { "type": "object", "description": "Command parameters." }
                            },
                            "required": ["command"]
                        }
                    },
                    "save": { "type": "boolean", "description": "Save the file after the steps. Defaults to true; a draft is never saved." },
                    "target": { "type": "object", "description": "The part the steps act on, as in the inspect tool's target, for example {\"slide\": 3} (counted from 1). The kit goes there first, so the ids the inspect tool listed for that part work.", "properties": { "slide": { "type": "integer", "minimum": 1 }, "page": { "type": "integer", "minimum": 1 } } },
                    "preview": { "type": "boolean", "description": "Attach a rendered preview of the whole document. Defaults to false; use the inspect tool with a target to look at one part." },
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
            description: format!(
                "Take your draft of a {noun} in {name} back from review to keep editing it (after {ready}); edits with `draft` also do."
            ),
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
                    "draft": draft_property()
                },
                "required": ["path"]
            }),
            writes: false,
        },
    ]
}

static SPECS: LazyLock<Vec<KitToolSpec>> =
    LazyLock::new(|| KITS.iter().flat_map(specs_of).collect());

/// Every kit's tools.
pub fn specs() -> &'static [KitToolSpec] {
    &SPECS
}

/// The tools of the kits installed in this runtime. A kit whose object model Kition has seen
/// (`model.describe`) gets `<prefix>_query` and `<prefix>_batch` arguments generated from it.
pub fn installed(kits: &KitManager) -> Vec<KitToolSpec> {
    let installed: Vec<&str> = kits
        .statuses()
        .into_iter()
        .filter(|kit| kit.installed)
        .map(|kit| kit.id)
        .collect();
    if unified() {
        let on: Vec<&'static KitDefinition> = KITS
            .iter()
            .filter(|kit| installed.contains(&kit.id))
            .collect();
        if !on.is_empty() {
            return unified_specs(&on);
        }
    }
    KITS.iter()
        .filter(|kit| installed.contains(&kit.id))
        .flat_map(|kit| specs_described(kit, kits.described(kit.id).as_ref()))
        .collect()
}

/// The activity label of a kit tool, for example `Edit layered image in Photo`.
pub fn label(name: &str) -> Option<String> {
    let Some((kit, action)) = parse(name) else {
        // A unified tool (`kit_<action>`): one for every kit.
        let suffix = name.strip_prefix("kit_")?;
        let action = Action::ALL
            .into_iter()
            .find(|action| action.suffix() == suffix)?;
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
    let kit = KITS
        .iter()
        .find(|kit| kit.extensions.contains(&extension.as_str()))?;
    let (inspect, commands, run, check) = (
        tool_name(kit, Action::Inspect),
        tool_name(kit, Action::Commands),
        tool_name(kit, Action::Run),
        tool_name(kit, Action::Check),
    );
    Some(
        [
            format!("Current linked {}: `{}`, open in {}.", kit.agent.noun, path.trim(), kit.name),
            format!("Call {inspect} on this path to see {} and a rendered preview before describing or changing it.", kit.agent.reports),
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
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned()
}

/// The path from the input, which must be a file of `kit`.
pub fn kit_path(input: &Value, kit: &KitDefinition) -> Result<String, KitToolError> {
    let path = text_field(input, "path");
    if path.is_empty() {
        return Err(KitToolError::invalid("missing `path`"));
    }
    let extension = path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    if kit.extensions.contains(&extension.as_str()) {
        return Ok(path);
    }
    let hint = KITS
        .iter()
        .find(|other| other.extensions.contains(&extension.as_str()))
        .map(|other| format!("; use the {}_* tools for it", other.agent.prefix))
        .unwrap_or_default();
    Err(KitToolError::invalid(format!(
        "`{path}` is not a {} ({}){hint}",
        kit.agent.noun, kit.agent.formats
    )))
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

/// `target.slide` or `target.page` of a `<prefix>_inspect` call, counted from 1.
fn target_part(input: &Value) -> Option<u64> {
    let target = input.get("target")?;
    target
        .get("slide")
        .or_else(|| target.get("page"))
        .and_then(Value::as_u64)
        .filter(|n| *n >= 1)
}

/// A preview of one slide or page, through the kit's `file.render` query when it has one
/// (`{slide, scale}` → `{png}`). None when the kit has no such command or it fails, so the caller
/// falls back to the whole document. A region parameter on `view.screenshot` would make this
/// work for every kit; until the Kit Host Protocol has one, this covers kits that can render a part.
async fn part_preview(
    kits: &KitManager,
    kit: &KitDefinition,
    view: &DocumentView,
    part: u64,
) -> Option<Vec<Preview>> {
    use base64::Engine as _;
    let mut params = Map::new();
    params.insert("slide".into(), json!(part - 1));
    params.insert("scale".into(), json!(1));
    let executed = kits
        .execute(
            Caller::Agent,
            view.kit_id,
            &view.document_id,
            "file.render",
            params,
        )
        .await
        .ok()?;
    let data = executed.result?.get("png")?.as_str()?.to_owned();
    let png = base64::engine::general_purpose::STANDARD
        .decode(data)
        .ok()?;
    Some(vec![Preview {
        caption: format!(
            "Preview of part {part} of `{}` from {}.",
            view.path.as_deref().unwrap_or(&view.title),
            kit.name
        ),
        png,
    }])
}

/// The objects of one slide or page, through the kit's `slide.inspect` or `page.inspect` query
/// (`{index}` counted from 0) when it has one: what an agent needs to find the object to edit.
/// What a spreadsheet or document holds, through the kit's own readers (`sheet.read`,
/// `document.inspect {text}`), cut to a size an agent can read: the content an inspect answer
/// lists, so cells and paragraphs need not be read through the object model. None for kits
/// without them, and for a slide or page target (listed as objects).
async fn part_content(kits: &KitManager, view: &DocumentView, input: &Value) -> Option<Value> {
    let target = input.get("target");
    if target
        .and_then(|t| t.get("slide").or_else(|| t.get("page")))
        .is_some()
    {
        return None;
    }
    let text = |t: Option<&Value>, key: &str| {
        t.and_then(|t| t.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let mut params = Map::new();
    let asked = text(target, "range");
    if let Some(range) = &asked {
        params.insert("range".into(), json!(range));
    }
    if let Some(sheet) = text(target, "sheet") {
        params.insert("sheet".into(), json!(sheet));
    }
    if let Ok(executed) = kits
        .execute(
            Caller::Agent,
            view.kit_id,
            &view.document_id,
            "sheet.read",
            params,
        )
        .await
        && let Some(result) = executed.result
    {
        return Some(sheet_content(&result, asked.is_some()));
    }
    let mut params = Map::new();
    params.insert("text".into(), json!(true));
    if let Ok(executed) = kits
        .execute(
            Caller::Agent,
            view.kit_id,
            &view.document_id,
            "document.inspect",
            params,
        )
        .await
        && let Some(blocks) = executed
            .result
            .as_ref()
            .and_then(|r| r.get("blocks"))
            .and_then(Value::as_array)
    {
        let span = target
            .and_then(|t| t.get("paragraphs"))
            .and_then(Value::as_array)
            .map(|a| {
                (
                    a.first().and_then(Value::as_u64).unwrap_or(0) as usize,
                    a.get(1).and_then(Value::as_u64).map(|n| n as usize),
                )
            });
        return Some(document_content(blocks, span));
    }
    None
}

const CONTENT_ROWS: usize = 40;
const CONTENT_BLOCKS: usize = 80;

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_owned()
    } else {
        format!("{}…", text.chars().take(max).collect::<String>())
    }
}

/// `sheet.read`'s rows as `[row number, values…]` under their column letters.
fn sheet_content(read: &Value, asked: bool) -> Value {
    let range = read["range"].as_str().unwrap_or("A1");
    let start = range.split(':').next().unwrap_or("A1");
    let letters: String = start
        .chars()
        .take_while(char::is_ascii_alphabetic)
        .collect();
    let first_row: usize = start[letters.len()..].parse().unwrap_or(1);
    let first_col = letters.chars().fold(0usize, |n, c| {
        n * 26 + (c.to_ascii_uppercase() as usize - 'A' as usize + 1)
    });
    let column = |mut n: usize| {
        let mut out = String::new();
        while n > 0 {
            out.insert(0, (b'A' + ((n - 1) % 26) as u8) as char);
            n = (n - 1) / 26;
        }
        out
    };
    let values = read["values"].as_array().cloned().unwrap_or_default();
    let width = values
        .iter()
        .filter_map(Value::as_array)
        .map(Vec::len)
        .max()
        .unwrap_or(0);
    let shown = if asked {
        values.len()
    } else {
        values.len().min(CONTENT_ROWS)
    };
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
    let to = to.map_or_else(
        || blocks.len().min(from + CONTENT_BLOCKS),
        |t| (t + 1).min(blocks.len()),
    );
    let paragraphs: Vec<Value> = blocks
        .iter()
        .skip(from)
        .take(to.saturating_sub(from))
        .map(|b| json!({ "index": b["index"], "type": b["type"], "style": b["style"], "text": cut(b["text"].as_str().unwrap_or_default(), 200) }))
        .collect();
    let mut content = json!({ "paragraphs": paragraphs, "total": blocks.len() });
    if to < blocks.len() {
        content["more"] = json!(format!(
            "paragraphs {from}–{} of {} shown; pass target {{\"paragraphs\": [{to}, {}]}} for the rest",
            to - 1,
            blocks.len(),
            blocks.len() - 1
        ));
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
    match kits
        .commands(
            Caller::Agent,
            view.kit_id,
            Some(&view.document_id),
            Some(&words),
        )
        .await
    {
        Ok(found) if !found.is_empty() => {
            let near: Vec<String> = found
                .iter()
                .take(5)
                .map(|c| {
                    format!(
                        "{} {}",
                        c.id,
                        c.description
                            .as_deref()
                            .unwrap_or_default()
                            .trim_start_matches("Params: ")
                    )
                })
                .collect();
            format!(" — nearest commands: {}", near.join("; "))
        }
        _ => String::new(),
    }
}

/// Goes to one slide or page (`{index}` counted from 0) through the kit's `slide.go` or
/// `page.go`, so that its commands, which address the part being edited, address this one.
async fn go_to_part(kits: &KitManager, view: &DocumentView, part: u64) -> Option<DocumentView> {
    for command in ["slide.go", "page.go"] {
        let mut params = Map::new();
        params.insert("index".into(), json!(part - 1));
        if let Ok(executed) = kits
            .execute(
                Caller::Agent,
                view.kit_id,
                &view.document_id,
                command,
                params,
            )
            .await
        {
            return Some(executed.document);
        }
    }
    None
}

async fn part_objects(kits: &KitManager, view: &DocumentView, part: u64) -> Option<Value> {
    model::warm(kits, view).await;
    for command in ["slide.inspect", "page.inspect"] {
        let mut params = Map::new();
        params.insert("index".into(), json!(part - 1));
        if let Ok(executed) = kits
            .execute(
                Caller::Agent,
                view.kit_id,
                &view.document_id,
                command,
                params,
            )
            .await
            && let Some(result) = executed.result
        {
            return Some(result);
        }
    }
    None
}

async fn preview(kits: &KitManager, kit: &KitDefinition, view: &DocumentView) -> Vec<Preview> {
    match kits
        .preview(view.kit_id, &view.document_id, PREVIEW_SIZE)
        .await
    {
        Ok(png) => vec![Preview {
            caption: format!(
                "Preview of `{}` from {}.",
                view.path.as_deref().unwrap_or(&view.title),
                kit.name
            ),
            png,
        }],
        Err(error) => {
            tracing::warn!(error = %error, kit = kit.id, "kit preview failed");
            Vec::new()
        }
    }
}

/// The editor in the renderer that has `path` open, if one does (the Kit AI bridge, A7): the
/// agent's edits then go to it, so the person sees them and they join its undo history.
pub(crate) async fn live(
    kits: &KitManager,
    kit: &KitDefinition,
    path: &str,
) -> Option<LiveDocument> {
    kits.bridge()
        .find(path)
        .await
        .filter(|document| document.kit == kit.id)
}

async fn live_preview(
    kits: &KitManager,
    kit: &KitDefinition,
    document: &LiveDocument,
) -> Vec<Preview> {
    match kits.bridge().preview(document, PREVIEW_SIZE).await {
        Ok(png) => vec![Preview {
            caption: format!("Preview of `{}` from {}.", document.path, kit.name),
            png,
        }],
        Err(error) => {
            tracing::warn!(error = %error, kit = kit.id, "live kit preview failed");
            Vec::new()
        }
    }
}

/// Runs the kit tool `name` with `input`, editing live documents. `None` when `name` is not a
/// kit tool.
pub async fn call(kits: &KitManager, name: &str, input: &Value) -> Option<KitToolResult> {
    call_with(kits, name, input, CallOptions::default()).await
}

/// Runs the kit tool `name` with `input` and the harness's `options`.
pub async fn call_with(
    kits: &KitManager,
    name: &str,
    input: &Value,
    options: CallOptions,
) -> Option<KitToolResult> {
    let (kit, action) = parse(name).or_else(|| unified_route(name, input))?;
    let draft = input
        .get("draft")
        .and_then(Value::as_bool)
        .unwrap_or(options.draft);
    Some(match action {
        Action::Inspect => inspect(kits, kit, input, draft).await,
        Action::Commands => commands(kits, kit, input).await,
        Action::Run if draft => run_on_draft(kits, kit, input).await,
        Action::Run => run_steps(kits, kit, input).await,
        Action::DraftReady | Action::DraftReopen => draft_state(kits, kit, input, action).await,
        Action::Query => model::query(kits, kit, input, draft).await,
        Action::Batch => model::batch(kits, kit, input, draft).await,
        Action::Check => check(kits, kit, input, draft).await,
    })
}

/// The open editor of `path`, which a draft needs: drafts live in the person's editor (standard
/// 2.0 A15), so a file no editor has open has none.
pub(crate) async fn draft_editor(
    kits: &KitManager,
    kit: &KitDefinition,
    path: &str,
) -> Result<LiveDocument, KitToolError> {
    live(kits, kit, path).await.ok_or_else(|| {
        KitToolError::new(ErrorCode::NotOpen, format!(
            "`{path}` is not open in its {} editor, so it has no draft: drafts live in the person's open editor. Ask the person to open it, or edit the file live (`draft: false`).",
            short(kit)
        ))
    })
}

/// Where the agent's draft of `path` is: in the file's open editor, or, when the server keeps
/// headless drafts (`kition-kits-mcp`) and no editor has the file open, in the headless kit
/// (`drafts.rs`). With `create`, a file without a headless draft forks one.
pub(crate) enum DraftAt {
    Editor(LiveDocument),
    Headless(String),
}

pub(crate) async fn draft_at(
    kits: &KitManager,
    kit: &'static KitDefinition,
    path: &str,
    create: bool,
) -> Result<DraftAt, KitToolError> {
    if let Some(document) = live(kits, kit, path).await {
        return Ok(DraftAt::Editor(document));
    }
    if kits.headless_drafts() {
        return drafts::document(kits, kit, path, create)
            .await
            .map(DraftAt::Headless);
    }
    draft_editor(kits, kit, path).await.map(DraftAt::Editor)
}

/// Whether a read in draft mode goes to a headless draft: no editor has the file open, the
/// server keeps headless drafts, and the call asks for the draft or one exists.
async fn reads_headless_draft(
    kits: &KitManager,
    kit: &KitDefinition,
    path: &str,
    draft: bool,
    explicit: bool,
) -> bool {
    draft
        && kits.headless_drafts()
        && (explicit || drafts::exists(kits, path))
        && live(kits, kit, path).await.is_none()
}

async fn headless_draft_preview(
    kits: &KitManager,
    kit: &KitDefinition,
    path: &str,
    id: &str,
) -> Vec<Preview> {
    match kits.preview(kit.id, id, PREVIEW_SIZE).await {
        Ok(png) => vec![Preview {
            caption: format!("Preview of your draft of `{path}` from {}.", kit.name),
            png,
        }],
        Err(error) => {
            tracing::warn!(error = %error, kit = kit.id, "draft preview failed");
            Vec::new()
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

async fn draft_preview(
    kits: &KitManager,
    kit: &KitDefinition,
    document: &LiveDocument,
) -> Vec<Preview> {
    match kits.bridge().preview_draft(document, PREVIEW_SIZE).await {
        Ok(png) => vec![Preview {
            caption: format!(
                "Preview of your draft of `{}` from {}.",
                document.path, kit.name
            ),
            png,
        }],
        Err(error) => {
            tracing::warn!(error = %error, kit = kit.id, "draft preview failed");
            Vec::new()
        }
    }
}

/// The agent's steps with every `edit.undo` and `edit.redo` in the agent's undo scope
/// (`{"scope":"agent"}`, engine contract 2 E14a, KitModel 1.1 M12a), so an agent's undo or
/// revert takes back only its own steps and never the person's. A scope the step names stays.
fn in_agent_scope(steps: &[Value]) -> Vec<Value> {
    steps
        .iter()
        .map(|step| {
            let command = step
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if command != "edit.undo" && command != "edit.redo" {
                return step.clone();
            }
            let mut step = step.clone();
            if let Some(object) = step.as_object_mut() {
                let params = object
                    .entry("params")
                    .or_insert_with(|| Value::Object(Map::new()));
                if !params.is_object() {
                    *params = Value::Object(Map::new());
                }
                if let Some(params) = params.as_object_mut() {
                    params
                        .entry("scope")
                        .or_insert_with(|| Value::String("agent".to_owned()));
                }
            }
            step
        })
        .collect()
}

async fn run_on_draft(
    kits: &KitManager,
    kit: &'static KitDefinition,
    input: &Value,
) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let steps = input
        .get("steps")
        .and_then(Value::as_array)
        .filter(|steps| !steps.is_empty())
        .ok_or_else(|| KitToolError::invalid("`steps` must be a non-empty array"))?;
    let steps = &in_agent_scope(steps);
    let document = match draft_at(kits, kit, &path, true).await? {
        DraftAt::Editor(document) => document,
        DraftAt::Headless(id) => return run_on_headless_draft(kits, kit, &path, &id, steps).await,
    };
    let mut answer = kits
        .bridge()
        .call(
            &document,
            "run",
            json!({ "steps": steps, "save": false, "draft": true }),
        )
        .await
        .map_err(|error| {
            KitToolError::from(error)
                .context(&format!("on the draft in the open {} editor: ", short(kit)))
        })?;
    let previews = draft_preview(kits, kit, &document).await;
    let ran = answer["completed"].as_array().map_or(0, Vec::len);
    answer["live"] = Value::Bool(true);
    answer["draft"] = Value::Bool(true);
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

/// Runs `steps` on the headless draft `id` of `path` and stores the draft.
async fn run_on_headless_draft(
    kits: &KitManager,
    kit: &'static KitDefinition,
    path: &str,
    id: &str,
    steps: &[Value],
) -> KitToolResult {
    let mut view = kits.document(Caller::Agent, kit.id, id).await?;
    let mut done = Vec::new();
    let mut failure = None;
    for (index, step) in steps.iter().enumerate() {
        let command = text_field(step, "command");
        if command.is_empty() {
            failure = Some(
                KitToolError::invalid(format!("step {index} has no `command`")).at(Some(index)),
            );
            break;
        }
        let params = step
            .get("params")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_else(Map::new);
        match kits
            .execute(Caller::Agent, kit.id, id, &command, params)
            .await
        {
            Ok(executed) => {
                done.push(json!({ "command": command, "changed": executed.changed, "result": executed.result }));
                view = executed.document;
            }
            Err(error) => {
                let mut error = KitToolError::from(error);
                if !matches!(
                    error.code,
                    ErrorCode::UnknownCommand | ErrorCode::NotAllowed | ErrorCode::Unavailable
                ) {
                    error.code = ErrorCode::COMMAND_FAILED;
                }
                failure = Some(
                    error
                        .context(&format!("step {index} (`{command}`) failed: "))
                        .at(Some(index)),
                );
                break;
            }
        }
    }
    // The steps that ran stay in the draft, as in an editor's draft.
    if !done.is_empty() {
        drafts::persist(kits, kit, path, id).await?;
    }
    if let Some(failure) = failure {
        return Err(failure.with_output(
            json!({ "completed": done, "draft": true, "document": draft_json(&view, path) }),
        ));
    }
    let previews = headless_draft_preview(kits, kit, path, id).await;
    Ok(KitToolOutput {
        previews,
        ..KitToolOutput::new(
            format!(
                "Ran {} commands on your draft of `{path}`; the file is unchanged until the person merges the draft. Call {} when it is done.",
                done.len(),
                tool_name(kit, Action::DraftReady)
            ),
            json!({ "completed": done, "draft": true, "saved": false, "document": draft_json(&view, path) }),
        )
    })
}

async fn draft_state(
    kits: &KitManager,
    kit: &'static KitDefinition,
    input: &Value,
    action: Action,
) -> KitToolResult {
    let path = kit_path(input, kit)?;
    if kits.headless_drafts() && live(kits, kit, &path).await.is_none() {
        let state = if action == Action::DraftReady {
            DraftState::Ready
        } else {
            DraftState::Open
        };
        drafts::set_state(kits, &path, state)?;
        let summary = if state == DraftState::Ready {
            format!(
                "Your draft of `{path}` is ready for review; the person will merge or discard it."
            )
        } else {
            format!("Your draft of `{path}` is back with you to keep editing.")
        };
        return Ok(KitToolOutput::new(
            summary,
            json!({ "path": path, "state": if state == DraftState::Ready { "ready" } else { "open" } }),
        ));
    }
    let document = draft_editor(kits, kit, &path).await?;
    let answer = kits
        .bridge()
        .call(&document, action.suffix(), json!({}))
        .await
        .map_err(|error| {
            let failure = KitToolError::from(error);
            // A draft that does not exist cannot be made ready: edit with `draft: true` first.
            let failure = if failure.message.contains("no draft") {
                KitToolError {
                    code: ErrorCode::DraftRequired,
                    ..failure
                }
            } else {
                failure
            };
            failure.context(&format!("in the open {} editor: ", short(kit)))
        })?;
    let summary = if action == Action::DraftReady {
        format!("Your draft of `{path}` is ready for review; the person will merge or discard it.")
    } else {
        format!("Your draft of `{path}` is back with you to keep editing.")
    };
    Ok(KitToolOutput::new(summary, answer))
}

async fn inspect(
    kits: &KitManager,
    kit: &'static KitDefinition,
    input: &Value,
    draft: bool,
) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let wants_preview = input.get("preview").and_then(Value::as_bool) != Some(false);
    // An explicit `draft: true` needs the editor; the run's default falls back to the file.
    let explicit = input.get("draft").and_then(Value::as_bool) == Some(true);
    if reads_headless_draft(kits, kit, &path, draft, explicit).await {
        let id = drafts::document(kits, kit, &path, false).await?;
        let view = kits.document(Caller::Agent, kit.id, &id).await?;
        let previews = if wants_preview {
            headless_draft_preview(kits, kit, &path, &id).await
        } else {
            Vec::new()
        };
        return Ok(KitToolOutput {
            previews,
            ..KitToolOutput::new(
                format!("Opened your draft of `{path}`: {}", view.summary),
                draft_json(&view, &path),
            )
        });
    }
    let open = live(kits, kit, &path).await;
    if draft && (open.is_some() || explicit) {
        let document = draft_editor(kits, kit, &path).await?;
        if let Ok(mut answer) = kits
            .bridge()
            .call(&document, "inspect", json!({ "draft": true }))
            .await
        {
            let previews = if wants_preview {
                draft_preview(kits, kit, &document).await
            } else {
                Vec::new()
            };
            let summary = answer["document"]["summary"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            answer["live"] = Value::Bool(true);
            answer["draft"] = Value::Bool(true);
            return Ok(KitToolOutput {
                previews,
                ..KitToolOutput::new(format!("Opened your draft of `{path}`: {summary}"), answer)
            });
        }
        if explicit {
            return Err(KitToolError::new(
                ErrorCode::DraftRequired,
                format!("`{path}` has no draft yet: edit it with `draft: true` first."),
            ));
        }
        // No draft yet: the live document is what a draft would start from.
    }
    if let Some(document) = open {
        let mut answer = kits.bridge().call(&document, "inspect", json!({})).await?;
        let previews = if wants_preview {
            live_preview(kits, kit, &document).await
        } else {
            Vec::new()
        };
        let summary = answer["document"]["summary"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        answer["live"] = Value::Bool(true);
        return Ok(KitToolOutput {
            previews,
            ..KitToolOutput::new(
                format!(
                    "Opened `{path}` in its open {} editor: {summary}",
                    short(kit)
                ),
                answer,
            )
        });
    }
    let mut view = kits.open(Caller::Agent, &path).await?;
    if let Some(part) = target_part(input)
        && let Some(moved) = go_to_part(kits, &view, part).await
    {
        view = moved;
    }
    let previews = if !wants_preview {
        Vec::new()
    } else if let Some(part) = target_part(input) {
        match part_preview(kits, kit, &view, part).await {
            Some(previews) => previews,
            None => preview(kits, kit, &view).await,
        }
    } else {
        preview(kits, kit, &view).await
    };
    let mut answer = document_json(&view);
    if let Some(content) = part_content(kits, &view, input).await {
        answer["content"] = content;
    }
    if let Some(part) = target_part(input)
        && let Some(objects) = part_objects(kits, &view, part).await
    {
        // The part, not the whole document's outline again.
        answer = document_summary_json(&view);
        answer["part"] = objects;
        lean_objects(&mut answer["part"]);
        answer["edit"] = json!(format!(
            "Edit these objects by their `id` with {} and a command (find commands with {}), for example text.set {{\"id\": <id>, \"text\": \"...\"}}; commands keep formatting. \
                 The kit is now on this part; to come back to it later, pass the same `target` to the run tool. \
                 Commands count slides and pages from 0: this part ({part}, counted from 1) is `index` {}. The query and batch tools take these ids too.",
            tool_name(kit, Action::Run),
            tool_name(kit, Action::Commands),
            part - 1
        ));
    }
    Ok(KitToolOutput {
        previews,
        ..KitToolOutput::new(format!("Opened `{path}`: {}", view.summary), answer)
    })
}

/// `<prefix>_check` (standard 2.0 A22): the diagnostics of the agent's draft, of the open editor's
/// document, or of the file through the headless kit, as `<prefix>_inspect` chooses among them.
async fn check(
    kits: &KitManager,
    kit: &'static KitDefinition,
    input: &Value,
    draft: bool,
) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let explicit = input.get("draft").and_then(Value::as_bool) == Some(true);
    let headless_draft = reads_headless_draft(kits, kit, &path, draft, explicit).await;
    let open = live(kits, kit, &path).await;
    let (answer, what) = if headless_draft {
        let id = drafts::document(kits, kit, &path, false).await?;
        let answer = kits.check(Caller::Agent, kit.id, &id).await?.ok_or_else(|| {
            KitToolError::new(
                ErrorCode::Unsupported,
                format!("this version of {} cannot check documents yet; inspect the preview instead", short(kit)),
            )
        })?;
        (answer, format!("your draft of `{path}`"))
    } else if draft && (open.is_some() || explicit) {
        let document = draft_editor(kits, kit, &path).await?;
        let answer = kits
            .bridge()
            .call(&document, "check", json!({ "draft": true }))
            .await
            .map_err(|error| {
                KitToolError::from(error)
                    .context(&format!("on the draft in the open {} editor: ", short(kit)))
            })?;
        (answer, format!("your draft of `{path}`"))
    } else if let Some(document) = open {
        let answer = kits
            .bridge()
            .call(&document, "check", json!({}))
            .await
            .map_err(|error| {
                KitToolError::from(error).context(&format!("in the open {} editor: ", short(kit)))
            })?;
        (answer, format!("`{path}`"))
    } else {
        let view = kits.open(Caller::Agent, &path).await?;
        let answer = kits
            .check(Caller::Agent, view.kit_id, &view.document_id)
            .await?
            .ok_or_else(|| {
                KitToolError::new(
                    ErrorCode::Unsupported,
                    format!("this version of {} cannot check documents yet; inspect the preview instead", short(kit)),
                )
            })?;
        (answer, format!("`{path}`"))
    };
    let diagnostics = answer["diagnostics"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(KitToolOutput::new(
        diagnostics_summary(&what, &diagnostics),
        json!({ "diagnostics": diagnostics }),
    ))
}

/// `Checked `a.pptx`: 1 error, 2 warnings, no notes.`
fn diagnostics_summary(what: &str, diagnostics: &[Value]) -> String {
    let count = |severity: &str| {
        diagnostics
            .iter()
            .filter(|diagnostic| diagnostic["severity"] == severity)
            .count()
    };
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
    if let Some(document) = live(kits, kit, &path).await {
        let answer = kits
            .bridge()
            .call(&document, "commands", json!({ "query": query }))
            .await?;
        let found = answer["commands"].as_array().cloned().unwrap_or_default();
        return Ok(listed_commands(&query, found));
    }
    let view = kits.open(Caller::Agent, &path).await?;
    let found = kits
        .commands(
            Caller::Agent,
            view.kit_id,
            Some(&view.document_id),
            Some(&query),
        )
        .await?;
    let found = found
        .into_iter()
        .map(|command| {
            json!({
                "id": command.id,
                "title": command.title,
                "description": command.description,
                "params": command.params,
                "enabled": command.enabled,
                "mutates": command.mutates,
            })
        })
        .collect();
    Ok(listed_commands(&query, found))
}

/// A command as the search answers it: id, title, and its params in kit command notation, with
/// the schema's short notes the notation does not carry (`index: a position counted from 0`).
fn compact_command(command: Value) -> Value {
    let schema = &command["params"];
    let notation = schema["description"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            command["description"]
                .as_str()
                .map(|d| d.trim_start_matches("Params: ").to_owned())
        })
        .unwrap_or_default();
    let mut notes = Vec::new();
    if let Some(properties) = schema["properties"].as_object() {
        for (name, property) in properties {
            if let Some(note) = property["description"].as_str()
                && note.len() <= 60
                && !notation.contains(note)
            {
                notes.push(format!("{name}: {note}"));
            }
        }
    }
    let params = if notes.is_empty() {
        notation
    } else {
        format!("{notation} [{}]", notes.join("; "))
    };
    let mut out = json!({ "id": command["id"], "title": command["title"], "params": params });
    if command["enabled"] == Value::Bool(false) {
        out["enabled"] = Value::Bool(false);
    }
    out
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

/// The commands that matched, at most [`MAX_COMMANDS`] of them, as the tool answers them.
fn listed_commands(query: &str, found: Vec<Value>) -> KitToolOutput {
    let total = found.len();
    let listed: Vec<Value> = found
        .into_iter()
        .take(MAX_COMMANDS)
        .map(compact_command)
        .collect();
    let summary = if total > listed.len() {
        format!(
            "{total} commands match `{query}`; showing {}. Use more specific keywords.",
            listed.len()
        )
    } else {
        format!("{total} commands match `{query}`")
    };
    KitToolOutput::new(summary, json!({ "commands": listed, "total": total }))
}

async fn run_steps(kits: &KitManager, kit: &KitDefinition, input: &Value) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let steps = input
        .get("steps")
        .and_then(Value::as_array)
        .filter(|steps| !steps.is_empty())
        .ok_or_else(|| KitToolError::invalid("`steps` must be a non-empty array"))?;
    let steps = &in_agent_scope(steps);
    let save = input.get("save").and_then(Value::as_bool) != Some(false);
    if let Some(document) = live(kits, kit, &path).await {
        let mut answer = kits
            .bridge()
            .call(&document, "run", json!({ "steps": steps, "save": save }))
            .await
            .map_err(|error| {
                KitToolError::from(error).context(&format!("in the open {} editor: ", short(kit)))
            })?;
        let previews = live_preview(kits, kit, &document).await;
        let ran = answer["completed"].as_array().map_or(0, Vec::len);
        let saved = if answer["saved"] == true {
            "saved"
        } else {
            "not saved"
        };
        let summary = answer["document"]["summary"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        answer["live"] = Value::Bool(true);
        return Ok(KitToolOutput {
            previews,
            ..KitToolOutput::new(
                format!(
                    "Ran {ran} commands on `{path}` in its open {} editor ({saved}): {summary}",
                    short(kit)
                ),
                answer,
            )
        });
    }
    let mut view = kits.open(Caller::Agent, &path).await?;
    if let Some(part) = target_part(input) {
        view = go_to_part(kits, &view, part).await.ok_or_else(|| {
            KitToolError::invalid(format!(
                "cannot go to part {part} of `{path}` (the kit has no slide.go or page.go)"
            ))
        })?;
    }
    let mut done = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let command = text_field(step, "command");
        if command.is_empty() {
            return Err(
                KitToolError::invalid(format!("step {index} has no `command`")).at(Some(index)),
            );
        }
        let params = step
            .get("params")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_else(Map::new);
        match kits
            .execute(
                Caller::Agent,
                view.kit_id,
                &view.document_id,
                &command,
                params,
            )
            .await
        {
            Ok(executed) => {
                done.push(json!({ "command": command, "changed": executed.changed, "result": executed.result }));
                view = executed.document;
            }
            Err(error) => {
                let mut failure = KitToolError::from(error);
                if matches!(failure.code, ErrorCode::UnknownCommand) {
                    failure
                        .message
                        .push_str(&nearest_commands(kits, &view, &command).await);
                }
                if !matches!(
                    failure.code,
                    ErrorCode::UnknownCommand | ErrorCode::NotAllowed | ErrorCode::Unavailable
                ) {
                    failure.code = ErrorCode::COMMAND_FAILED;
                }
                return Err(failure
                    .context(&format!("step {index} (`{command}`) failed: "))
                    .at(Some(index))
                    .with_output(
                        json!({ "completed": done, "document": document_summary_json(&view) }),
                    ));
            }
        }
    }
    if save && view.dirty {
        view = kits
            .save(Caller::Agent, view.kit_id, &view.document_id)
            .await
            .map_err(|error| {
                KitToolError::from(error).context("the edits were applied but saving failed: ")
            })?;
    }
    let previews = if input.get("preview").and_then(Value::as_bool) == Some(true) {
        preview(kits, kit, &view).await
    } else {
        Vec::new()
    };
    let saved = if save { "saved" } else { "not saved" };
    Ok(KitToolOutput {
        previews,
        ..KitToolOutput::new(
            format!(
                "Ran {} commands on `{path}` ({saved}): {}",
                done.len(),
                view.summary
            ),
            json!({ "completed": done, "saved": save, "document": document_summary_json(&view) }),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agents_undo_and_redo_steps_run_in_its_undo_scope() {
        let steps = vec![
            json!({ "command": "text.append", "params": { "text": "a" } }),
            json!({ "command": "edit.undo" }),
            json!({ "command": "edit.redo", "params": { "steps": 2 } }),
            json!({ "command": "edit.undo", "params": { "scope": "person" } }),
        ];
        let scoped = in_agent_scope(&steps);
        assert_eq!(scoped[0], steps[0]);
        assert_eq!(
            scoped[1],
            json!({ "command": "edit.undo", "params": { "scope": "agent" } })
        );
        assert_eq!(
            scoped[2],
            json!({ "command": "edit.redo", "params": { "steps": 2, "scope": "agent" } })
        );
        assert_eq!(scoped[3], steps[3]);
    }

    #[test]
    fn summarizes_diagnostics_by_severity() {
        let found = |severity: &str| json!({ "code": "slide.x", "severity": severity, "target": {}, "message": "x" });
        assert_eq!(
            diagnostics_summary("`a.pptx`", &[]),
            "Checked `a.pptx`: the kit found nothing wrong."
        );
        assert_eq!(
            diagnostics_summary(
                "`a.pptx`",
                &[found("error"), found("warning"), found("warning")]
            ),
            "Checked `a.pptx`: 1 error, 2 warnings, no notes."
        );
    }

    #[test]
    fn every_kit_gets_inspect_commands_and_run() {
        let mut prefixes: Vec<&str> = KITS.iter().map(|kit| kit.agent.prefix).collect();
        prefixes.sort_unstable();
        prefixes.dedup();
        assert_eq!(prefixes.len(), KITS.len(), "prefixes are unique");
        assert_eq!(specs().len(), KITS.len() * Action::ALL.len());
        for kit in KITS {
            for action in Action::ALL {
                let name = tool_name(kit, action);
                let spec = specs()
                    .iter()
                    .find(|spec| spec.name == name)
                    .unwrap_or_else(|| panic!("{name}"));
                assert_eq!(
                    parse(&name).map(|(found, action)| (found.id, action)),
                    Some((kit.id, action))
                );
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
        assert_eq!(
            parse("slide_check").map(|(kit, action)| (kit.id, action)),
            Some(("kit.slide", Action::Check))
        );
        assert!(!Action::Check.writes());
        // Draft tools: asking for review and reopening; merging and discarding are never tools.
        let slide = |name: &str| parse(name).map(|(kit, action)| (kit.id, action));
        assert_eq!(
            slide("slide_draft_ready"),
            Some(("kit.slide", Action::DraftReady))
        );
        assert_eq!(
            slide("slide_draft_reopen"),
            Some(("kit.slide", Action::DraftReopen))
        );
        assert!(parse("slide_draft_merge").is_none() && parse("slide_draft_discard").is_none());
        assert!(parse("slide_draft").is_none() && parse("_draft_ready").is_none());
        let run = specs()
            .iter()
            .find(|spec| spec.name == "slide_run")
            .unwrap_or_else(|| panic!("slide_run"));
        assert_eq!(run.input_schema["properties"]["draft"]["type"], "boolean");
        assert!(
            run.description.contains("slide_draft_ready"),
            "{}",
            run.description
        );
    }

    #[test]
    fn a_kit_file_is_edited_through_its_own_kit() {
        let prompt = |path: &str| {
            linked_file_prompt(path).unwrap_or_else(|| panic!("{path} opens in a kit"))
        };
        let vector = prompt("art/Logo.kvector");
        assert!(
            vector.contains("vector_inspect")
                && vector.contains("vector_run")
                && vector.contains("in Vector"),
            "{vector}"
        );
        assert!(prompt("motion/Intro.keffect").contains("effect_commands"));
        assert!(prompt("print/Flyer.kdesign").contains("design_run"));
        assert!(prompt("plans/Floor.dxf").contains("cad_run"));
        assert!(prompt("talks/Launch.pptx").contains("slide_run"));
        assert!(
            prompt("talks/Launch.pptx").contains("document_read extracts its text"),
            "PowerPoint text stays readable"
        );
        assert!(prompt("talks/Launch.kslide").contains("it is binary data"));
        assert!(prompt("letters/Hello.docx").contains("doc_run"));
        assert!(prompt("money/Budget.xlsx").contains("sheet_run"));
        assert!(
            prompt("papers/Report.pdf").contains("pdf_run")
                && prompt("papers/Report.pdf").contains("document_read extracts its text")
        );
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
        let vector_kit = KITS
            .iter()
            .find(|kit| kit.id == "kit.vector")
            .unwrap_or_else(|| panic!("kit.vector is a kit"));
        let wrong = kit_path(&json!({ "path": "art/Cover.psd" }), vector_kit)
            .err()
            .map(|error| (error.code, error.message))
            .unwrap_or((ErrorCode::Failed, String::new()));
        assert_eq!(wrong.0, ErrorCode::InvalidParams);
        let wrong = wrong.1;
        assert!(wrong.contains("photo_*"), "{wrong}");
        assert_eq!(
            kit_path(&json!({ "path": "art/Logo.kvector" }), vector_kit)
                .unwrap_or_else(|err| panic!("{}", err.message)),
            "art/Logo.kvector"
        );
    }
}
