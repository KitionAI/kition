//! Photo tools: inspect, search commands, and edit layered images through Kition Photo.
//!
//! The agent uses its own `agent` connection to the kit, so the kit enforces the workspace
//! boundary and the agent role. A kit tab showing the same file refreshes on its own.

use base64::Engine as _;
use kition_ai::engine::MessagePart;
use kition_kits::{Caller, DocumentView, KitManager};
use serde_json::{Map, Value, json};

use crate::run::{Run, ToolOutput, ToolResult, text_field};

/// Agent tool names that need an installed kit.
pub const TOOLS: &[&str] = &["photo_inspect", "photo_commands", "photo_run"];

const PREVIEW_SIZE: u32 = 1024;
const MAX_COMMANDS: usize = 40;

fn kits(run: &Run) -> Result<&KitManager, String> {
    run.agent
        .kits()
        .ok_or_else(|| "Kition Photo is not available in this runtime".to_owned())
}

/// Whether the agent should be offered the photo tools.
pub fn available(run: &Run) -> bool {
    run.agent
        .kits()
        .is_some_and(|kits| kits.statuses().iter().any(|kit| kit.installed))
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

async fn preview_parts(kits: &KitManager, view: &DocumentView) -> Vec<MessagePart> {
    match kits
        .preview(view.kit_id, &view.document_id, PREVIEW_SIZE)
        .await
    {
        Ok(png) => vec![
            MessagePart {
                kind: "text".into(),
                text: format!(
                    "Preview of `{}` from Kition Photo.",
                    view.path.as_deref().unwrap_or(&view.title)
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
            tracing::warn!(error = %error, "photo preview failed");
            Vec::new()
        }
    }
}

pub async fn inspect(run: &Run, input: &Value) -> ToolResult {
    let kits = kits(run)?;
    let path = path_of(input)?;
    let view = kits
        .open(Caller::Agent, &path)
        .await
        .map_err(|error| error.to_string())?;
    let follow_up = if input.get("preview").and_then(Value::as_bool) != Some(false) {
        preview_parts(kits, &view).await
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

pub async fn commands(run: &Run, input: &Value) -> ToolResult {
    let kits = kits(run)?;
    let path = path_of(input)?;
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

pub async fn run_steps(run: &Run, input: &Value) -> ToolResult {
    let kits = kits(run)?;
    let path = path_of(input)?;
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
    let follow_up = preview_parts(kits, &view).await;
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
