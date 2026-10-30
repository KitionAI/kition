//! Kit tools for Kition's agent: `<prefix>_inspect`, `<prefix>_commands`, and `<prefix>_run` for
//! every kit (KHP A3), its draft tools, and the object-model tools
//! `<prefix>_query` and `<prefix>_batch`. The tools themselves live in `kition_kits::tools`, shared
//! with the MCP server other harnesses use; this adapts them to the agent's catalog and turns.

use base64::Engine as _;
use kition_ai::engine::MessagePart;
use kition_kits::KitDefinition;
use kition_kits::tools::{self as kit_tools, CallOptions, KitToolOutput};
use serde_json::Value;

use crate::catalog::{READ_ONLY, ToolDef, WORKSPACE_WRITE};
use crate::run::{Run, ToolError, ToolOutput, ToolResult};

pub use kit_tools::{Action, label, linked_file_prompt, parse};

/// Every known kit's tools (`kition_kits::definitions::known`).
pub fn tool_defs() -> Vec<ToolDef> {
    kit_tools::specs()
        .into_iter()
        .map(|spec| ToolDef {
            name: spec.name,
            description: spec.description,
            category: if spec.writes { "artifact" } else { "context" }.into(),
            input_schema: Some(spec.input_schema),
            permission: if spec.writes {
                WORKSPACE_WRITE
            } else {
                READ_ONLY
            }
            .into(),
            ..ToolDef::default()
        })
        .collect()
}

/// The kit tools to leave out this turn: those of kits not installed in this runtime.
pub fn unavailable(run: &Run) -> Vec<String> {
    let installed: Vec<String> = run
        .agent
        .kits()
        .map(|kits| {
            kit_tools::installed(kits)
                .into_iter()
                .map(|spec| spec.name)
                .collect()
        })
        .unwrap_or_default();
    tool_defs()
        .into_iter()
        .map(|tool| tool.name)
        .filter(|name| !installed.iter().any(|installed| installed == name))
        .collect()
}

fn follow_up(output: &KitToolOutput) -> Vec<MessagePart> {
    output
        .previews
        .iter()
        .flat_map(|preview| {
            [
                MessagePart {
                    kind: "text".into(),
                    text: preview.caption.clone(),
                    ..MessagePart::default()
                },
                MessagePart {
                    kind: "image_url".into(),
                    image_url: format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(&preview.png)
                    ),
                    ..MessagePart::default()
                },
            ]
        })
        .collect()
}

/// Runs a kit tool for the agent.
pub async fn call(run: &Run, kit: &KitDefinition, name: &str, input: &Value) -> ToolResult {
    let kits = run
        .agent
        .kits()
        .ok_or_else(|| format!("{} is not available in this runtime", kit.name))?;
    let options = CallOptions {
        draft: run.kit_edit_mode == "draft",
    };
    match kit_tools::call_with(kits, name, input, options).await {
        Some(Ok(output)) => Ok(ToolOutput {
            follow_up: follow_up(&output),
            ..ToolOutput::new(output.summary, output.output)
        }),
        // The model sees what was done and the structured error (`error.code`, `error.index`).
        Some(Err(error)) => Err(ToolError {
            summary: error.message.clone(),
            output: Some(error.structured()),
            message: error.message,
        }),
        None => Err(format!("`{name}` is not a kit tool").into()),
    }
}
