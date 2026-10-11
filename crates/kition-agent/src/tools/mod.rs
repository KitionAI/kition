//! Running one tool call: permission check, the persisted call record, the
//! timeline events, and the result the model sees next.

pub mod apply_patch;
pub mod canvas;
pub mod documents;
pub mod exec;
pub mod files;
pub mod images;
pub mod kits;
pub mod tables;
pub mod web;

use std::sync::Arc;

use kition_ai::engine::MessagePart;
use kition_core::now_millis;
use serde_json::{Map, Value, json};

use crate::catalog::{self, READ_ONLY, WORKSPACE_WRITE};
use crate::run::{EventInput, Run, ToolError, ToolResult};
use crate::sources;
use crate::store::{self, AgentToolCall};
use crate::stream::{Frame, value};

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

pub fn label(name: &str) -> String {
    match name {
        "document_read" => "Read document",
        "document_write" => "Update document",
        "document_search" => "Search documents",
        "document_list" => "List folder",
        "source_read" => "Read local source",
        "source_file_search" => "Find local source paths",
        "source_search" => "Search local sources",
        "source_list" => "List local source",
        "source_git_status" => "Inspect source Git status",
        "source_git_log" => "Read source Git history",
        "source_git_show" => "Read source Git revision",
        "source_git_blame" => "Trace source Git lines",
        "web_search" => "Web search",
        "web_fetch" => "Fetch web page",
        "data_table_schema" => "Inspect table schema",
        "data_table_records" => "Read table records",
        "data_table_record_draft" => "Draft table records",
        "data_table_add_fields" => "Add table fields",
        "data_table_add_records" => "Write table records",
        "table_upsert_records" => "Upsert table records",
        "data_table_create" => "Create data table",
        "image_search" | "image_generation" => "Generate images",
        "save_image_asset" => "Save image",
        "web_article_save" => "Archive web article",
        "artifact_write" => "Save artifact",
        "register_artifact" => "Register artifact",
        "exec_command" => "Run command",
        "update_plan" => "Update plan",
        "view_image" => "View image",
        "fs_read" => "Read file",
        "fs_stat" => "Stat file",
        "fs_list" => "List directory",
        "fs_mkdir" => "Create directory",
        "fs_remove" => "Remove file",
        "fs_copy" => "Copy file",
        "file_search" => "Search files",
        "apply_patch" => "Apply patch",
        "configure_smtp_connection" => "Configure SMTP connection",
        "whiteboard_propose_patch" => "Propose Whiteboard changes",
        "design_propose_patch" => "Propose design changes",
        other => return kits::label(other).unwrap_or_else(|| other.to_owned()),
    }
    .to_owned()
}

/// The input as stored and shown in the timeline: patches are summarized,
/// local search queries and credentials are left out.
fn persisted_input(name: &str, input: &Value) -> Value {
    match name {
        "whiteboard_propose_patch" | "design_propose_patch" => json!({
            "type": input["type"],
            "schema_version": input["schema_version"],
            "summary_chars": input["summary"].as_str().unwrap_or_default().chars().count(),
            "operation_count": input["operations"].as_array().map_or(0, Vec::len),
        }),
        "source_search" | "source_file_search" | "configure_smtp_connection" => {
            let mut safe = input.as_object().cloned().unwrap_or_default();
            if let Some(query) = safe.remove("query") {
                safe.insert(
                    "query_chars".into(),
                    json!(query.as_str().unwrap_or_default().chars().count()),
                );
            }
            if safe.remove("password").is_some() {
                safe.insert("password".into(), json!("[redacted]"));
            }
            Value::Object(safe)
        }
        _ => input.clone(),
    }
}

pub async fn start_tool_call(run: &Run, name: &str, input: Value) -> Option<AgentToolCall> {
    let now = now_millis();
    let call = AgentToolCall {
        session_id: run.session_id,
        message_id: (run.trigger_message_id > 0).then_some(run.trigger_message_id),
        user_id: run.user_id,
        tool_name: name.to_owned(),
        input_data: input,
        status: "running".into(),
        created_at: now,
        updated_at: now,
        ..AgentToolCall::default()
    };
    run.agent
        .with_db(move |conn| store::insert_tool_call(conn, call))
        .await
        .ok()
}

pub async fn complete_tool_call(run: &Run, call: &mut AgentToolCall, output: Value) {
    call.status = "completed".into();
    call.output_data = output;
    let mut saved = call.clone();
    let _ = run
        .agent
        .with_db(move |conn| store::finish_tool_call(conn, &mut saved))
        .await;
}

async fn fail_tool_call(run: &Run, call: &mut AgentToolCall, message: &str, output: Option<Value>) {
    call.status = "failed".into();
    call.error_message = message.to_owned();
    if let Some(output) = output {
        call.output_data = output;
    }
    let mut saved = call.clone();
    let _ = run
        .agent
        .with_db(move |conn| store::finish_tool_call(conn, &mut saved))
        .await;
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

async fn dispatch(run: &Arc<Run>, call_id: i64, name: &str, input: &Value) -> ToolResult {
    if let Some((kit, action)) = kits::parse(name) {
        return match action {
            kits::Action::Inspect => kits::inspect(run, kit, input).await,
            kits::Action::Commands => kits::commands(run, kit, input).await,
            kits::Action::Run => kits::run_steps(run, kit, input).await,
        };
    }
    match name {
        "document_read" => documents::read(run, input).await,
        "document_write" => documents::write(run, call_id, input).await,
        "document_search" => documents::search(run, input).await,
        "document_list" => documents::list(run, input).await,
        "artifact_write" => documents::artifact_write(run, call_id, input).await,
        "register_artifact" => documents::register_artifact(run, call_id, input).await,
        "fs_read" => blocking(run, input, files::read).await,
        "fs_stat" => blocking(run, input, files::stat).await,
        "fs_list" => blocking(run, input, files::list).await,
        "fs_mkdir" => blocking(run, input, files::mkdir).await,
        "fs_remove" => blocking(run, input, files::remove).await,
        "fs_copy" => blocking(run, input, files::copy).await,
        "file_search" => blocking(run, input, files::file_search).await,
        "apply_patch" => blocking(run, input, apply_patch::apply).await,
        "view_image" => files::view_image(run, call_id, input).await,
        "update_plan" => files::update_plan(run, input).await,
        "source_read" => blocking(run, input, sources::read).await,
        "source_list" => blocking(run, input, sources::list).await,
        "source_file_search" => blocking(run, input, sources::file_search).await,
        "source_search" => blocking(run, input, sources::search).await,
        "source_git_status" => blocking(run, input, sources::git_status).await,
        "source_git_log" => blocking(run, input, sources::git_log).await,
        "source_git_show" => blocking(run, input, sources::git_show).await,
        "source_git_blame" => blocking(run, input, sources::git_blame).await,
        "web_fetch" => web::web_fetch(run, input).await,
        "web_article_save" => web::web_article_save(run, call_id, input).await,
        "web_search" => Err("web_search is provided as a hosted tool by the model; use its built-in web search instead of a function call".into()),
        "image_generation" => Err("image_generation is hosted by the model runtime and must not be invoked as a function call".into()),
        "image_search" => images::image_search(run, call_id, input).await,
        "save_image_asset" => images::save_image_asset(run, call_id, input).await,
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

/// Runs a model tool call and records it on the timeline.
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
    let stored_input = persisted_input(name, &input);
    let stage = stage(name);
    let label = label(name);
    let required = required_permission(name);
    if rank(run.permission()) < rank(&required) {
        let message = format!(
            "Tool {name} requires {required} permission, current is {}",
            run.permission()
        );
        if let Some(mut call) = start_tool_call(run, name, stored_input.clone()).await {
            fail_tool_call(run, &mut call, &message, None).await;
            run.event(
                EventInput::new("tool.denied", stage, "failed", &label, message.clone())
                    .tool_call(Some(call.id))
                    .data(json!({ "tool_name": name, "input": stored_input })),
            )
            .await;
            run.send(&Frame {
                message: message.clone(),
                tool_call: value(&call),
                ..Frame::new("tool_error")
            });
        }
        return failed(format!("Tool {name} was blocked by permission policy"));
    }
    let Some(mut call) = start_tool_call(run, name, stored_input.clone()).await else {
        return failed(format!("Failed to record tool {name}"));
    };
    run.send(&Frame {
        tool_call: value(&call),
        ..Frame::new("tool_call")
    });
    run.event(
        EventInput::new(
            "tool.requested",
            stage,
            "running",
            &label,
            format!("Starting tool {name}"),
        )
        .tool_call(Some(call.id))
        .data(json!({ "tool_name": name, "input": stored_input })),
    )
    .await;
    match dispatch(run, call.id, name, &input).await {
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
            fail_tool_call(run, &mut call, &message, output.clone()).await;
            run.event(
                EventInput::new("tool.failed", stage, "failed", &label, message.clone())
                    .tool_call(Some(call.id))
                    .data(json!({ "tool_name": name })),
            )
            .await;
            run.send(&Frame {
                message: message.clone(),
                tool_call: value(&call),
                ..Frame::new("tool_error")
            });
            let description = catalog::tool(name).map_or(name, |tool| tool.description.as_str());
            Executed {
                name: name.to_owned(),
                summary: if summary.is_empty() {
                    format!(
                        "{} failed: {message}",
                        crate::run::truncate_chars(description, 120)
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
            if result.interrupt == Some("await_shell_approval") {
                result.output["tool_call_id"] = json!(call.id);
            }
            let stored_output = result
                .event_output
                .clone()
                .unwrap_or_else(|| result.output.clone());
            let stored_output = if result.interrupt.is_some() {
                let mut output = stored_output;
                output["tool_call_id"] = json!(call.id);
                output
            } else {
                stored_output
            };
            complete_tool_call(run, &mut call, stored_output.clone()).await;
            if let Some(artifact) = &result.artifact {
                run.send(&Frame {
                    artifact: value(artifact),
                    tool_call: value(&call),
                    ..Frame::new("artifact")
                });
            }
            let event_summary = result
                .event_summary
                .clone()
                .unwrap_or_else(|| result.summary.clone());
            run.event(
                EventInput::new("tool.completed", stage, "completed", &label, event_summary)
                    .tool_call(Some(call.id))
                    .data(json!({ "tool_name": name, "output": stored_output })),
            )
            .await;
            run.send(&Frame {
                tool_call: value(&call),
                ..Frame::new("tool_call")
            });
            Executed {
                name: name.to_owned(),
                summary: result.summary,
                output: result.output,
                interrupt: result.interrupt,
                follow_up: result.follow_up,
                ..Executed::default()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_and_summarizes_inputs() {
        let smtp = persisted_input(
            "configure_smtp_connection",
            &json!({ "host": "h", "password": "secret" }),
        );
        assert_eq!(smtp, json!({ "host": "h", "password": "[redacted]" }));
        let search = persisted_input(
            "source_search",
            &json!({ "query": "token", "source_id": "a" }),
        );
        assert_eq!(search, json!({ "query_chars": 5, "source_id": "a" }));
        let patch = persisted_input(
            "design_propose_patch",
            &json!({ "type": "design.patch", "operations": [1, 2] }),
        );
        assert_eq!(patch["operation_count"], 2);
        assert_eq!(stage("source_read"), "context");
        assert_eq!(label("fs_copy"), "Copy file");
        assert!(rank(WORKSPACE_WRITE) > rank(READ_ONLY));
    }
}
