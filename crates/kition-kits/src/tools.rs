//! Kit tools (Kition Kit Standard A3): for every kit, inspect a file, search its commands, and
//! edit it by running them: `<prefix>_inspect`, `<prefix>_commands`, and `<prefix>_run`, named
//! and worded from the kit's definition (its `kit.json`).
//!
//! One implementation serves every harness: Kition's own agent and any MCP client (DeepSeek
//! Harness through `dsh-mcp-client`, and others) through `mcp.rs`. A file open in a kit editor
//! is edited live through the Kit AI bridge (A7); otherwise through the kit's headless
//! executable on its `agent` connection, so the kit enforces the workspace and the agent role.

use std::sync::LazyLock;

use serde_json::{Map, Value, json};

use crate::bridge::LiveDocument;
use crate::manager::{Caller, DocumentView, KITS, KitDefinition, KitManager};

const PREVIEW_SIZE: u32 = 1024;
const MAX_COMMANDS: usize = 40;

/// What a kit tool does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Inspect,
    Commands,
    Run,
}

impl Action {
    pub const ALL: [Action; 3] = [Action::Inspect, Action::Commands, Action::Run];

    fn suffix(self) -> &'static str {
        match self {
            Action::Inspect => "inspect",
            Action::Commands => "commands",
            Action::Run => "run",
        }
    }
}

/// One kit tool as a harness offers it to a model.
#[derive(Clone, Debug)]
pub struct KitToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema for the arguments.
    pub input_schema: Value,
    /// Whether the tool changes files (`<prefix>_run`).
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
    fn new(summary: String, output: Value) -> Self {
        Self {
            summary,
            output,
            previews: Vec::new(),
        }
    }
}

/// A tool's failure, with what had already happened when it stopped.
#[derive(Clone, Debug, Default)]
pub struct KitToolError {
    pub message: String,
    pub output: Option<Value>,
}

impl<T: Into<String>> From<T> for KitToolError {
    fn from(message: T) -> Self {
        Self {
            message: message.into(),
            output: None,
        }
    }
}

pub type KitToolResult = Result<KitToolOutput, KitToolError>;

pub fn tool_name(kit: &KitDefinition, action: Action) -> String {
    format!("{}_{}", kit.agent.prefix, action.suffix())
}

/// The kit and action a tool name names, if it is a kit tool.
pub fn parse(name: &str) -> Option<(&'static KitDefinition, Action)> {
    let (prefix, suffix) = name.rsplit_once('_')?;
    let kit = KITS.iter().find(|kit| kit.agent.prefix == prefix)?;
    let action = Action::ALL
        .into_iter()
        .find(|action| action.suffix() == suffix)?;
    Some((kit, action))
}

/// The kit's display name without the product prefix: `Photo` for `Kition Photo`.
pub fn short(kit: &KitDefinition) -> &'static str {
    kit.name.strip_prefix("Kition ").unwrap_or(kit.name)
}

fn path_property(kit: &KitDefinition) -> Value {
    json!({ "type": "string", "description": format!("Workspace-relative path to a {} file.", kit.agent.formats) })
}

fn specs_of(kit: &'static KitDefinition) -> [KitToolSpec; 3] {
    let agent = &kit.agent;
    let (name, noun) = (kit.name, agent.noun);
    let commands = tool_name(kit, Action::Commands);
    let run = tool_name(kit, Action::Run);
    [
        KitToolSpec {
            name: tool_name(kit, Action::Inspect),
            description: format!(
                "Open a {noun} ({}) in {name} and report {}. By default it also attaches a rendered preview to the next turn so you can see it. Use it before and after editing.",
                agent.formats, agent.reports
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": path_property(kit),
                    "preview": { "type": "boolean", "description": "Attach a rendered preview image. Defaults to true." }
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
                "Edit a {noun} in {name} by running commands in order, then save the file. Each step is one undoable command with a JSON object of params, as documented by {commands}. Stops at the first failing step. Attaches a rendered preview of the result."
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
                    "save": { "type": "boolean", "description": "Save the file after the steps. Defaults to true." }
                },
                "required": ["path", "steps"]
            }),
            writes: true,
        },
    ]
}

static SPECS: LazyLock<Vec<KitToolSpec>> =
    LazyLock::new(|| KITS.iter().flat_map(specs_of).collect());

/// Every kit's tools.
pub fn specs() -> &'static [KitToolSpec] {
    &SPECS
}

/// The tools of the kits installed in this runtime.
pub fn installed(kits: &KitManager) -> Vec<&'static KitToolSpec> {
    let installed: Vec<&str> = kits
        .statuses()
        .into_iter()
        .filter(|kit| kit.installed)
        .map(|kit| kit.id)
        .collect();
    specs()
        .iter()
        .filter(|spec| parse(&spec.name).is_some_and(|(kit, _)| installed.contains(&kit.id)))
        .collect()
}

/// The activity label of a kit tool, for example `Edit layered image in Photo`.
pub fn label(name: &str) -> Option<String> {
    let (kit, action) = parse(name)?;
    let (noun, kit_name) = (kit.agent.noun, short(kit));
    Some(match action {
        Action::Inspect => format!("Inspect {noun} in {kit_name}"),
        Action::Commands => format!("Find {kit_name} commands"),
        Action::Run => format!("Edit {noun} in {kit_name}"),
    })
}

/// The instructions for a file of a kit: inspect and edit it through the kit's tools, never as
/// text. `None` when no kit opens the file.
/// Formats whose text `document_read` extracts (PDF and Office), which a kit also edits.
const TEXT_EXTRACTED: &[&str] = &["pdf", "docx", "xlsx", "pptx"];

pub fn linked_file_prompt(path: &str) -> Option<String> {
    let extension = path.trim().rsplit_once('.')?.1.to_ascii_lowercase();
    let kit = KITS
        .iter()
        .find(|kit| kit.extensions.contains(&extension.as_str()))?;
    let (inspect, commands, run) = (
        tool_name(kit, Action::Inspect),
        tool_name(kit, Action::Commands),
        tool_name(kit, Action::Run),
    );
    Some(
        [
            format!("Current linked {}: `{}`, open in {}.", kit.agent.noun, path.trim(), kit.name),
            format!("Call {inspect} on this path to see {} and a rendered preview before describing or changing it.", kit.agent.reports),
            format!(
                "To edit it, find command ids with {commands} (search by keywords such as {}), then call {run} with the steps. {run} saves the file and returns a new preview; check it, and fix or undo (`edit.undo`) when the result is wrong.",
                kit.agent.queries
            ),
            if TEXT_EXTRACTED.contains(&extension.as_str()) {
                "document_read extracts its text for reading; edit it only through the kit tools, never with document_write, fs_read, or apply_patch.".to_owned()
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
pub fn kit_path(input: &Value, kit: &KitDefinition) -> Result<String, String> {
    let path = text_field(input, "path");
    if path.is_empty() {
        return Err("missing `path`".into());
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
    Err(format!(
        "`{path}` is not a {} ({}){hint}",
        kit.agent.noun, kit.agent.formats
    ))
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
async fn live(kits: &KitManager, kit: &KitDefinition, path: &str) -> Option<LiveDocument> {
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

/// Runs the kit tool `name` with `input`. `None` when `name` is not a kit tool.
pub async fn call(kits: &KitManager, name: &str, input: &Value) -> Option<KitToolResult> {
    let (kit, action) = parse(name)?;
    Some(match action {
        Action::Inspect => inspect(kits, kit, input).await,
        Action::Commands => commands(kits, kit, input).await,
        Action::Run => run_steps(kits, kit, input).await,
    })
}

async fn inspect(kits: &KitManager, kit: &KitDefinition, input: &Value) -> KitToolResult {
    let path = kit_path(input, kit)?;
    let wants_preview = input.get("preview").and_then(Value::as_bool) != Some(false);
    if let Some(document) = live(kits, kit, &path).await {
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
    let view = kits
        .open(Caller::Agent, &path)
        .await
        .map_err(|error| error.to_string())?;
    let previews = if wants_preview {
        preview(kits, kit, &view).await
    } else {
        Vec::new()
    };
    Ok(KitToolOutput {
        previews,
        ..KitToolOutput::new(
            format!("Opened `{path}`: {}", view.summary),
            document_json(&view),
        )
    })
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
    let view = kits
        .open(Caller::Agent, &path)
        .await
        .map_err(|error| error.to_string())?;
    let found = kits
        .commands(
            Caller::Agent,
            view.kit_id,
            Some(&view.document_id),
            Some(&query),
        )
        .await
        .map_err(|error| error.to_string())?;
    let found = found
        .into_iter()
        .map(|command| {
            json!({
                "id": command.id,
                "title": command.title,
                "description": command.description,
                "enabled": command.enabled,
                "mutates": command.mutates,
            })
        })
        .collect();
    Ok(listed_commands(&query, found))
}

/// The commands that matched, at most [`MAX_COMMANDS`] of them, as the tool answers them.
fn listed_commands(query: &str, found: Vec<Value>) -> KitToolOutput {
    let total = found.len();
    let listed: Vec<Value> = found.into_iter().take(MAX_COMMANDS).collect();
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
        .ok_or("`steps` must be a non-empty array")?;
    let save = input.get("save").and_then(Value::as_bool) != Some(false);
    if let Some(document) = live(kits, kit, &path).await {
        let mut answer = kits
            .bridge()
            .call(&document, "run", json!({ "steps": steps, "save": save }))
            .await
            .map_err(|error| format!("in the open {} editor: {error}", short(kit)))?;
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
    let mut view = kits
        .open(Caller::Agent, &path)
        .await
        .map_err(|error| error.to_string())?;
    let mut done = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let command = text_field(step, "command");
        if command.is_empty() {
            return Err(format!("step {index} has no `command`").into());
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
                return Err(KitToolError {
                    message: format!("step {index} (`{command}`) failed: {error}"),
                    output: Some(json!({ "completed": done, "document": document_json(&view) })),
                });
            }
        }
    }
    if save && view.dirty {
        view = kits
            .save(Caller::Agent, view.kit_id, &view.document_id)
            .await
            .map_err(|error| format!("the edits were applied but saving failed: {error}"))?;
    }
    let previews = preview(kits, kit, &view).await;
    let saved = if save { "saved" } else { "not saved" };
    Ok(KitToolOutput {
        previews,
        ..KitToolOutput::new(
            format!(
                "Ran {} commands on `{path}` ({saved}): {}",
                done.len(),
                view.summary
            ),
            json!({ "completed": done, "saved": save, "document": document_json(&view) }),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kit_gets_inspect_commands_and_run() {
        let mut prefixes: Vec<&str> = KITS.iter().map(|kit| kit.agent.prefix).collect();
        prefixes.sort_unstable();
        prefixes.dedup();
        assert_eq!(prefixes.len(), KITS.len(), "prefixes are unique");
        assert_eq!(specs().len(), KITS.len() * 3);
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
                assert_eq!(spec.writes, action == Action::Run, "{name}");
                assert_eq!(spec.input_schema["required"][0], "path");
                assert!(label(&name).is_some_and(|label| label.contains(short(kit))));
            }
        }
        for name in ["photo_inspect", "photo_commands", "photo_run"] {
            assert!(specs().iter().any(|spec| spec.name == name), "{name}");
        }
        assert!(parse("document_read").is_none() && parse("photo_paint").is_none());
    }

    #[test]
    fn a_kit_file_is_edited_through_its_own_kit() {
        let prompt = |path: &str| {
            linked_file_prompt(path).unwrap_or_else(|| panic!("{path} opens in a kit"))
        };
        let vector = prompt("art/Logo.vectorcraft");
        assert!(
            vector.contains("vector_inspect")
                && vector.contains("vector_run")
                && vector.contains("Kition Vector"),
            "{vector}"
        );
        assert!(prompt("motion/Intro.ECPROJ").contains("effect_commands"));
        assert!(prompt("print/Flyer.designcraft").contains("design_run"));
        assert!(prompt("plans/Floor.dxf").contains("cad_run"));
        assert!(prompt("talks/Launch.pptx").contains("presentation_run"));
        assert!(prompt("talks/Launch.pptx").contains("document_read extracts its text"), "PowerPoint text stays readable");
        assert!(prompt("talks/Launch.deckcraft").contains("it is binary data"));
        assert!(prompt("letters/Hello.docx").contains("word_run"));
        assert!(prompt("money/Budget.xlsx").contains("sheet_run"));
        assert!(linked_file_prompt("notes/plan.md").is_none());
        let vector_kit = KITS
            .iter()
            .find(|kit| kit.id == "kit.vector")
            .unwrap_or_else(|| panic!("kit.vector is a kit"));
        let wrong = kit_path(&json!({ "path": "art/Cover.psd" }), vector_kit)
            .err()
            .unwrap_or_default();
        assert!(wrong.contains("photo_*"), "{wrong}");
        assert_eq!(
            kit_path(&json!({ "path": "art/Logo.vectorcraft" }), vector_kit)
                .unwrap_or_else(|err| panic!("{err}")),
            "art/Logo.vectorcraft"
        );
    }
}
