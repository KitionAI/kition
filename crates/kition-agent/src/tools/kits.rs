//! Kit tools: for every kit, inspect a file, search its commands, and edit it by running them
//! (Kition Kit Standard A3): `<prefix>_inspect`, `<prefix>_commands`, and `<prefix>_run`, with
//! the prefix and wording from the kit's definition (its `kit.json`).
//!
//! The agent uses its own `agent` connection to the kit, so the kit enforces the workspace
//! boundary and the agent role. A kit tab showing the same file refreshes on its own.

use std::sync::LazyLock;

use base64::Engine as _;
use kition_ai::engine::MessagePart;
use kition_kits::{Caller, DocumentView, KITS, KitDefinition, KitManager};
use serde_json::{Map, Value, json};

use crate::catalog::{READ_ONLY, ToolDef, WORKSPACE_WRITE};
use crate::run::{Run, ToolOutput, ToolResult, text_field};

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
    const ALL: [Action; 3] = [Action::Inspect, Action::Commands, Action::Run];

    fn suffix(self) -> &'static str {
        match self {
            Action::Inspect => "inspect",
            Action::Commands => "commands",
            Action::Run => "run",
        }
    }
}

fn tool_name(kit: &KitDefinition, action: Action) -> String {
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
fn short(kit: &KitDefinition) -> &'static str {
    kit.name.strip_prefix("Kition ").unwrap_or(kit.name)
}

fn path_property(kit: &KitDefinition) -> Value {
    json!({ "type": "string", "description": format!("Workspace-relative path to a {} file.", kit.agent.formats) })
}

fn definitions(kit: &'static KitDefinition) -> [ToolDef; 3] {
    let agent = &kit.agent;
    let (name, noun) = (kit.name, agent.noun);
    let commands = tool_name(kit, Action::Commands);
    let run = tool_name(kit, Action::Run);
    [
        ToolDef {
            name: tool_name(kit, Action::Inspect),
            description: format!(
                "Open a {noun} ({}) in {name} and report {}. By default it also attaches a rendered preview to the next turn so you can see it. Use it before and after editing.",
                agent.formats, agent.reports
            ),
            category: "context".into(),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "path": path_property(kit),
                    "preview": { "type": "boolean", "description": "Attach a rendered preview image. Defaults to true." }
                },
                "required": ["path"]
            })),
            permission: READ_ONLY.into(),
            ..ToolDef::default()
        },
        ToolDef {
            name: commands.clone(),
            description: format!(
                "Search {name}'s editing commands ({}) by keywords. Returns command ids with their parameter notes; pass an id to {run}.",
                agent.covers
            ),
            category: "context".into(),
            input_schema: Some(json!({
                "type": "object",
                "properties": {
                    "path": path_property(kit),
                    "query": { "type": "string", "description": format!("Keywords to match in the command id, title, or description, for example {}.", agent.queries) }
                },
                "required": ["path", "query"]
            })),
            permission: READ_ONLY.into(),
            ..ToolDef::default()
        },
        ToolDef {
            name: run.clone(),
            description: format!(
                "Edit a {noun} in {name} by running commands in order, then save the file. Each step is one undoable command with a JSON object of params, as documented by {commands}. Stops at the first failing step. Attaches a rendered preview of the result."
            ),
            category: "artifact".into(),
            input_schema: Some(json!({
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
            })),
            permission: WORKSPACE_WRITE.into(),
            ..ToolDef::default()
        },
    ]
}

static DEFINITIONS: LazyLock<Vec<ToolDef>> =
    LazyLock::new(|| KITS.iter().flat_map(definitions).collect());

/// Every kit's tools.
pub fn tool_defs() -> &'static [ToolDef] {
    &DEFINITIONS
}

/// The kit tools to leave out this turn: those of kits not installed in this runtime.
pub fn unavailable(run: &Run) -> Vec<&'static str> {
    let installed: Vec<&str> = run
        .agent
        .kits()
        .map(|kits| {
            kits.statuses()
                .into_iter()
                .filter(|kit| kit.installed)
                .map(|kit| kit.id)
                .collect()
        })
        .unwrap_or_default();
    tool_defs()
        .iter()
        .filter(|tool| parse(&tool.name).is_none_or(|(kit, _)| !installed.contains(&kit.id)))
        .map(|tool| tool.name.as_str())
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
            "Do not use document_read, document_write, fs_read, or apply_patch on this file: it is binary data.".to_owned(),
        ]
        .join("\n"),
    )
}

fn kits<'a>(run: &'a Run, kit: &KitDefinition) -> Result<&'a KitManager, String> {
    run.agent
        .kits()
        .ok_or_else(|| format!("{} is not available in this runtime", kit.name))
}

/// The path from the input, which must be a file of `kit`.
fn kit_path(input: &Value, kit: &KitDefinition) -> Result<String, String> {
    let path = path_of(input)?;
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

fn path_of(input: &Value) -> Result<String, String> {
    let path = text_field(input, "path");
    if path.is_empty() {
        return Err("missing `path`".into());
    }
    Ok(path)
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

async fn preview_parts(
    kits: &KitManager,
    kit: &KitDefinition,
    view: &DocumentView,
) -> Vec<MessagePart> {
    match kits
        .preview(view.kit_id, &view.document_id, PREVIEW_SIZE)
        .await
    {
        Ok(png) => vec![
            MessagePart {
                kind: "text".into(),
                text: format!(
                    "Preview of `{}` from {}.",
                    view.path.as_deref().unwrap_or(&view.title),
                    kit.name
                ),
                ..MessagePart::default()
            },
            MessagePart {
                kind: "image_url".into(),
                image_url: format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(png)
                ),
                ..MessagePart::default()
            },
        ],
        Err(error) => {
            tracing::warn!(error = %error, kit = kit.id, "kit preview failed");
            Vec::new()
        }
    }
}

pub async fn inspect(run: &Run, kit: &KitDefinition, input: &Value) -> ToolResult {
    let kits = kits(run, kit)?;
    let path = kit_path(input, kit)?;
    let view = kits
        .open(Caller::Agent, &path)
        .await
        .map_err(|error| error.to_string())?;
    let follow_up = if input.get("preview").and_then(Value::as_bool) != Some(false) {
        preview_parts(kits, kit, &view).await
    } else {
        Vec::new()
    };
    Ok(ToolOutput {
        follow_up,
        ..ToolOutput::new(
            format!("Opened `{path}`: {}", view.summary),
            document_json(&view),
        )
    })
}

pub async fn commands(run: &Run, kit: &KitDefinition, input: &Value) -> ToolResult {
    let kits = kits(run, kit)?;
    let path = kit_path(input, kit)?;
    let query = text_field(input, "query");
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
    let total = found.len();
    let listed: Vec<Value> = found
        .into_iter()
        .take(MAX_COMMANDS)
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
    let summary = if total > listed.len() {
        format!(
            "{total} commands match `{query}`; showing {}. Use more specific keywords.",
            listed.len()
        )
    } else {
        format!("{total} commands match `{query}`")
    };
    Ok(ToolOutput::new(
        summary,
        json!({ "commands": listed, "total": total }),
    ))
}

pub async fn run_steps(run: &Run, kit: &KitDefinition, input: &Value) -> ToolResult {
    let kits = kits(run, kit)?;
    let path = kit_path(input, kit)?;
    let steps = input
        .get("steps")
        .and_then(Value::as_array)
        .filter(|steps| !steps.is_empty())
        .ok_or("`steps` must be a non-empty array")?;
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
                let message = format!("step {index} (`{command}`) failed: {error}");
                return Err(crate::run::ToolError {
                    summary: message.clone(),
                    message,
                    output: Some(json!({ "completed": done, "document": document_json(&view) })),
                });
            }
        }
    }
    let save = input.get("save").and_then(Value::as_bool) != Some(false);
    if save && view.dirty {
        view = kits
            .save(Caller::Agent, view.kit_id, &view.document_id)
            .await
            .map_err(|error| format!("the edits were applied but saving failed: {error}"))?;
    }
    let follow_up = preview_parts(kits, kit, &view).await;
    let saved = if save { "saved" } else { "not saved" };
    Ok(ToolOutput {
        follow_up,
        ..ToolOutput::new(
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
        assert_eq!(tool_defs().len(), KITS.len() * 3);
        for kit in KITS {
            for action in Action::ALL {
                let name = tool_name(kit, action);
                let tool = crate::catalog::tool(&name)
                    .unwrap_or_else(|| panic!("{name} is in the catalog"));
                assert_eq!(
                    parse(&name).map(|(found, action)| (found.id, action)),
                    Some((kit.id, action))
                );
                assert!(tool.description.contains(kit.name), "{}", tool.description);
                assert_eq!(tool.writes(), action == Action::Run, "{name}");
                let schema = tool
                    .input_schema
                    .as_ref()
                    .unwrap_or_else(|| panic!("{name} has a schema"));
                assert_eq!(schema["required"][0], "path");
                assert!(label(&name).is_some_and(|label| label.contains(short(kit))));
            }
        }
        // Photo keeps the tool names it always had.
        for name in ["photo_inspect", "photo_commands", "photo_run"] {
            assert!(crate::catalog::tool(name).is_some(), "{name}");
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
