//! Kit tools for Kition's agent: `<prefix>_inspect`, `<prefix>_commands`, and `<prefix>_run` for
//! every kit (Kition Kit Standard A3). The tools themselves live in `kition_kits::tools`, shared
//! with the MCP server other harnesses use; this adapts them to the agent's catalog and turns.

use std::sync::LazyLock;

use base64::Engine as _;
use kition_ai::engine::MessagePart;
use kition_kits::KitDefinition;
use kition_kits::tools::{self as kit_tools, CallOptions, KitToolOutput};
use serde_json::Value;

use crate::catalog::{READ_ONLY, ToolDef, WORKSPACE_WRITE};
use crate::run::{Run, ToolError, ToolOutput, ToolResult};

pub use kit_tools::{Action, label, linked_file_prompt, parse};

static DEFINITIONS: LazyLock<Vec<ToolDef>> = LazyLock::new(|| {
    kit_tools::specs()
        .iter()
        .map(|spec| ToolDef {
            name: spec.name.clone(),
            description: spec.description.clone(),
            category: if spec.writes { "artifact" } else { "context" }.into(),
            input_schema: Some(spec.input_schema.clone()),
            permission: if spec.writes {
                WORKSPACE_WRITE
            } else {
                READ_ONLY
            }
            .into(),
            ..ToolDef::default()
        })
        .collect()
});

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
            kit_tools::installed(kits)
                .into_iter()
                .map(|spec| spec.name.as_str())
                .collect()
        })
        .unwrap_or_default();
    tool_defs()
        .iter()
        .map(|tool| tool.name.as_str())
        .filter(|name| !installed.contains(name))
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
        Some(Err(error)) => Err(ToolError {
            summary: error.message.clone(),
            message: error.message,
            output: error.output,
        }),
        None => Err(format!("`{name}` is not a kit tool").into()),
    }
}
