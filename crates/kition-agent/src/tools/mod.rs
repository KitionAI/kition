//! Running one tool call: the permission check, dispatch to the tool, and
//! the result the model sees next. The driver logs the call and its result.

pub mod apply_patch;
pub mod canvas;
pub mod documents;
pub mod exec;
pub mod files;
pub mod images;
pub mod kits;
pub mod live_documents;
pub mod tables;
pub mod web;

use std::sync::Arc;

use kition_ai::engine::MessagePart;
use kition_harness::events::{PresentedFile, TodoItem};
use serde_json::{Map, Value, json};

use crate::catalog::{self, READ_ONLY, WORKSPACE_WRITE};
use crate::run::{Run, ToolError, ToolResult};
use crate::sources;

/// What the tool loop learns from a call.
#[derive(Debug, Clone, Default)]
pub struct Executed {
    pub name: String,
    pub summary: String,
    pub output: Value,
    pub failed: bool,
    pub error_message: String,
    pub interrupt: Option<&'static str>,
    pub follow_up: Vec<MessagePart>,
    pub deliverables: Vec<PresentedFile>,
    pub todos: Option<Vec<TodoItem>>,
}

fn rank(permission: &str) -> u8 {
    match permission {
        "super-admin" => 4,
        "danger-full-access" => 3,
        WORKSPACE_WRITE => 2,
        READ_ONLY => 1,
        _ => 0,
    }
}

pub fn stage(name: &str) -> &'static str {
    match name {
        "document_read"
        | "document_search"
        | "document_list"
        | "data_table_schema"
        | "data_table_records"
        | "data_table_record_draft"
        | "fs_read"
        | "fs_stat"
        | "fs_list"
        | "file_search"
        | "view_image" => "context",
        _ if matches!(
            kits::parse(name),
            Some((_, kits::Action::Inspect | kits::Action::Commands))
        ) =>
        {
            "context"
        }
        _ if name.starts_with("source_") => "context",
        "web_search" | "web_fetch" => "research",
        "exec_command" => "execute",
        "update_plan" => "plan",
        _ if name.contains("__") => "execute",
        _ => "artifact",
    }
}

/// Runs blocking file or table work off the async executor.
async fn blocking(
    run: &Arc<Run>,
    input: &Value,
    work: fn(&Run, &Value) -> ToolResult,
) -> ToolResult {
    let (run, input) = (run.clone(), input.clone());
    tokio::task::spawn_blocking(move || work(&run, &input))
        .await
        .unwrap_or_else(|_| Err("tool failed unexpectedly".into()))
}

async fn table_tool(
    run: &Arc<Run>,
    input: &Value,
    work: fn(&kition_datadoc::DataDocState, &tables::TableContext, &Value) -> ToolResult,
) -> ToolResult {
    let Some(state) = run.agent.tables().cloned() else {
        return Err("data-table tools are unavailable".into());
    };
    let context = tables::TableContext {
        user_id: run.user_id,
        active_document_path: run.active_document_path.clone(),
        document_id: run.active_data_document_id,
        table_id: run.active_data_table_id,
        origin: tables::run_origin(run.session_id),
    };
    let input = input.clone();
    tokio::task::spawn_blocking(move || work(&state, &context, &input))
        .await
        .unwrap_or_else(|_| Err("tool failed unexpectedly".into()))
}

async fn configure_smtp(run: &Run, input: &Value) -> ToolResult {
    let configure = run
        .agent
        .smtp()
        .cloned()
        .ok_or("connections service is not available")?;
    let (summary, output) = configure(run.user_id, input.clone()).await?;
    Ok(crate::run::ToolOutput::new(summary, output))
}

async fn dispatch(run: &Arc<Run>, name: &str, input: &Value) -> ToolResult {
    if let Some((kit, _)) = kits::parse(name) {
        return kits::call(run, kit, name, input).await;
    }
    match name {
        "document_read" => documents::read(run, input).await,
        "document_write" => documents::write(run, input).await,
        "document_search" => documents::search(run, input).await,
        "document_list" => documents::list(run, input).await,
        "artifact_write" => documents::artifact_write(run, input).await,
        "register_artifact" => documents::register_artifact(run, input).await,
        "fs_read" => blocking(run, input, files::read).await,
        "fs_stat" => blocking(run, input, files::stat).await,
        "fs_list" => blocking(run, input, files::list).await,
        "fs_mkdir" => blocking(run, input, files::mkdir).await,
        "fs_remove" => blocking(run, input, files::remove).await,
        "fs_copy" => blocking(run, input, files::copy).await,
        "file_search" => blocking(run, input, files::file_search).await,
        "apply_patch" => apply_patch::apply(run, input).await,
        "view_image" => files::view_image(run, input).await,
        "update_plan" => files::update_plan(input),
        "source_read" => blocking(run, input, sources::read).await,
        "source_list" => blocking(run, input, sources::list).await,
        "source_file_search" => blocking(run, input, sources::file_search).await,
        "source_search" => blocking(run, input, sources::search).await,
        "source_git_status" => blocking(run, input, sources::git_status).await,
        "source_git_log" => blocking(run, input, sources::git_log).await,
        "source_git_show" => blocking(run, input, sources::git_show).await,
        "source_git_blame" => blocking(run, input, sources::git_blame).await,
        "web_fetch" => web::web_fetch(run, input).await,
        "web_article_save" => web::web_article_save(run, input).await,
        "web_search" => Err("web_search is provided as a hosted tool by the model; use its built-in web search instead of a function call".into()),
        "image_generation" => Err("image_generation is hosted by the model runtime and must not be invoked as a function call".into()),
        "image_search" => images::image_search(run, input).await,
        "save_image_asset" => images::save_image_asset(run, input).await,
        "exec_command" => exec::exec_command(run, input).await,
        "data_table_create" => table_tool(run, input, tables::create).await,
        "data_table_schema" => table_tool(run, input, tables::schema).await,
        "data_table_records" => table_tool(run, input, tables::records).await,
        "data_table_record_draft" => table_tool(run, input, tables::record_draft).await,
        "data_table_add_fields" => table_tool(run, input, tables::add_fields).await,
        "data_table_add_records" | "table_upsert_records" => table_tool(run, input, tables::add_records).await,
        "whiteboard_propose_patch" => canvas::propose_whiteboard_patch(run, input).await,
        "design_propose_patch" => canvas::propose_design_patch(run, input).await,
        "configure_smtp_connection" => configure_smtp(run, input).await,
        other => crate::mcp::call(run, other, input).await,
    }
}

/// What a failed call's summary calls the tool: its catalog description,
/// a kit tool's label, or its name.
fn describe(name: &str) -> String {
    catalog::tool(name)
        .map(|tool| tool.description.clone())
        .or_else(|| kits::label(name))
        .unwrap_or_else(|| name.to_owned())
}

/// The permission a tool needs; MCP tools may write.
fn required_permission(name: &str) -> String {
    catalog::tool(name)
        .map(|tool| tool.permission.clone())
        .filter(|permission| !permission.is_empty())
        .unwrap_or_else(|| WORKSPACE_WRITE.to_owned())
}

pub fn writes(name: &str) -> bool {
    required_permission(name) != READ_ONLY
}

/// Runs a model tool call.
pub async fn execute(run: &Arc<Run>, name: &str, raw_input: &str) -> Executed {
    let failed = |message: String| Executed {
        name: name.to_owned(),
        summary: message.clone(),
        failed: true,
        error_message: message,
        output: Value::Object(Map::new()),
        ..Executed::default()
    };
    if catalog::tool(name).is_none() && !crate::mcp::is_mcp_tool(name) {
        return failed(format!("Tool {name} is not registered"));
    }
    let input = match serde_json::from_str::<Value>(if raw_input.trim().is_empty() {
        "{}"
    } else {
        raw_input
    }) {
        Ok(value @ Value::Object(_)) => value,
        _ => json!({ "raw": raw_input }),
    };
    let required = required_permission(name);
    if rank(run.permission()) < rank(&required) {
        return failed(format!(
            "Tool {name} requires {required} permission, current is {}",
            run.permission()
        ));
    }
    match dispatch(run, name, &input).await {
        Err(ToolError {
            message,
            summary,
            output,
        }) => {
            let message = if message.is_empty() {
                "tool failed".to_owned()
            } else {
                message
            };
            Executed {
                name: name.to_owned(),
                summary: if summary.is_empty() {
                    format!(
                        "{} failed: {message}",
                        crate::run::truncate_chars(&describe(name), 120)
                    )
                } else {
                    summary
                },
                output: output.unwrap_or_else(|| Value::Object(Map::new())),
                failed: true,
                error_message: message,
                ..Executed::default()
            }
        }
        Ok(mut result) => {
            if !result.output.is_object() {
                result.output = Value::Object(Map::new());
            }
            Executed {
                name: name.to_owned(),
                summary: result.summary,
                output: result.output,
                interrupt: result.interrupt,
                follow_up: result.follow_up,
                deliverables: result.deliverables,
                todos: result.todos,
                ..Executed::default()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stages_and_ranks() {
        assert_eq!(stage("source_read"), "context");
        assert_eq!(stage("exec_command"), "execute");
        assert!(rank(WORKSPACE_WRITE) > rank(READ_ONLY));
        assert_eq!(describe("not_a_tool"), "not_a_tool");
        assert!(describe("document_read").len() > "document_read".len());
    }
}
