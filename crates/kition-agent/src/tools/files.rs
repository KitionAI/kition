//! Generic workspace file tools, path search, image viewing, and plans.

use std::path::Path;

use kition_ai::engine::MessagePart;
use serde_json::{Value, json};

use crate::attachments::image_data_url;
use crate::fuzzy;
use kition_harness::events::{TodoItem, TodoStatus};

use crate::run::{
    EventInput, Run, ToolOutput, ToolResult, bool_field, delivered, int_field, string_list,
    text_field, truncate_chars,
};
use crate::store;

const MAX_VIEW_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

fn modified(meta: &std::fs::Metadata) -> String {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| kition_core::time::to_rfc3339(since.as_millis() as i64))
        .unwrap_or_default()
}

pub fn read(run: &Run, input: &Value) -> ToolResult {
    let (relative, path) = run.workspace().locate(&text_field(input, "path"), false)?;
    let max = match int_field(input, "max_bytes") {
        n if n <= 0 => 96 * 1024,
        n => n.min(1024 * 1024),
    } as usize;
    let meta = std::fs::metadata(&path).map_err(|error| format!("failed to read file: {error}"))?;
    if meta.is_dir() {
        return Err("cannot read a directory".into());
    }
    let mut data = std::fs::read(&path).map_err(|error| format!("failed to read file: {error}"))?;
    let truncated = data.len() > max;
    data.truncate(max);
    let text = String::from_utf8_lossy(&data).into_owned();
    let suffix = if truncated { ", truncated" } else { "" };
    Ok(ToolOutput::new(
        format!(
            "Contents of `{relative}` ({} bytes{suffix}):\n\n{}",
            meta.len(),
            truncate_chars(&text, 4000)
        ),
        json!({ "path": relative, "absolute": false, "size": meta.len(), "truncated": truncated, "content": text }),
    ))
}

pub fn stat(run: &Run, input: &Value) -> ToolResult {
    let (relative, path) = run.workspace().locate(&text_field(input, "path"), true)?;
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return Ok(ToolOutput::new(
            format!("`{relative}` not found"),
            json!({ "path": relative, "kind": "", "size": 0, "mod_time": "", "exists": false }),
        ));
    };
    let kind = if meta.file_type().is_symlink() {
        "symlink"
    } else if meta.is_dir() {
        "dir"
    } else {
        "file"
    };
    Ok(ToolOutput::new(
        format!("`{relative}` \u{b7} {kind} \u{b7} {} bytes", meta.len()),
        json!({ "path": relative, "kind": kind, "size": meta.len(), "mod_time": modified(&meta), "exists": true }),
    ))
}

pub fn list(run: &Run, input: &Value) -> ToolResult {
    let (relative, path) = run.workspace().locate(&text_field(input, "path"), true)?;
    let limit = match int_field(input, "limit") {
        n if n <= 0 => 100,
        n => n.min(500),
    } as usize;
    let meta =
        std::fs::metadata(&path).map_err(|error| format!("failed to read directory: {error}"))?;
    if !meta.is_dir() {
        return Err("not a directory".into());
    }
    let mut entries: Vec<(bool, String, u64)> = std::fs::read_dir(&path)
        .map_err(|error| format!("failed to read directory: {error}"))?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            let meta = entry.metadata().ok()?;
            Some((
                meta.is_dir(),
                name,
                if meta.is_dir() { 0 } else { meta.len() },
            ))
        })
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    entries.truncate(limit);
    let items: Vec<Value> = entries
        .iter()
        .map(|(is_dir, name, size)| {
            let path = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            json!({ "path": path, "name": name, "is_dir": is_dir, "size": size })
        })
        .collect();
    let display = if relative.is_empty() {
        "/".to_owned()
    } else {
        relative
    };
    Ok(ToolOutput::new(
        format!("`{display}` contains {} entries", items.len()),
        json!({ "path": display, "entries": items, "count": items.len() }),
    ))
}

pub fn mkdir(run: &Run, input: &Value) -> ToolResult {
    let (relative, path) = run.workspace().locate(&text_field(input, "path"), false)?;
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("failed to create directory: {error}"))?;
    Ok(ToolOutput::new(
        format!("Created directory `{relative}`"),
        json!({ "path": relative, "created": true }),
    ))
}

pub fn remove(run: &Run, input: &Value) -> ToolResult {
    let (relative, path) = run.workspace().locate(&text_field(input, "path"), false)?;
    let meta =
        std::fs::symlink_metadata(&path).map_err(|_| format!("path does not exist: {relative}"))?;
    let is_dir = meta.is_dir();
    if is_dir {
        let empty = std::fs::read_dir(&path)
            .map_err(|error| error.to_string())?
            .next()
            .is_none();
        if !empty {
            if !bool_field(input, "recursive") {
                return Err(
                    format!("directory not empty, recursive=true required: {relative}").into(),
                );
            }
            return Err(format!(
                "recursive removal of a non-empty directory requires danger-full-access: {relative}"
            )
            .into());
        }
        std::fs::remove_dir(&path).map_err(|error| format!("remove failed: {error}"))?;
    } else {
        std::fs::remove_file(&path).map_err(|error| format!("remove failed: {error}"))?;
    }
    Ok(ToolOutput::new(
        format!("Removed `{relative}`"),
        json!({ "path": relative, "removed": true, "was_dir": is_dir }),
    ))
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)?.flatten() {
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }
    std::fs::copy(from, to).map(|_| ())
}

pub fn copy(run: &Run, input: &Value) -> ToolResult {
    let (src, src_path) = run.workspace().locate(&text_field(input, "src"), false)?;
    let (dst, dst_path) = run.workspace().locate(&text_field(input, "dst"), false)?;
    let meta = std::fs::metadata(&src_path).map_err(|_| format!("source not found: {src}"))?;
    if dst_path.exists() && !bool_field(input, "overwrite") {
        return Err(format!("destination already exists: {dst} (overwrite=false)").into());
    }
    if dst_path.starts_with(&src_path) && meta.is_dir() {
        return Err("cannot copy a directory into itself".into());
    }
    if let Some(parent) = dst_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create destination directory: {error}"))?;
    }
    copy_tree(&src_path, &dst_path).map_err(|error| format!("failed to copy: {error}"))?;
    Ok(ToolOutput::new(
        format!("Copied `{src}` \u{2192} `{dst}`"),
        json!({ "src": src, "dst": dst, "is_dir": meta.is_dir() }),
    ))
}

pub fn file_search(run: &Run, input: &Value) -> ToolResult {
    let query = text_field(input, "query");
    let limit = match int_field(input, "limit") {
        n if n <= 0 => 20,
        n => n.min(200),
    } as usize;
    let exclude = string_list(input, "exclude");
    let workspace = run.workspace();
    let root = workspace.root().to_path_buf();
    let mut scanned = 0_usize;
    let mut matches: Vec<(i64, String)> = Vec::new();
    workspace.walk(&root, &mut |path, _| {
        scanned += 1;
        let relative = workspace.relative(path).unwrap_or_default();
        if exclude
            .iter()
            .any(|pattern| relative.contains(pattern.trim_matches('*')))
        {
            return scanned < 50_000;
        }
        if let Some(score) = fuzzy::score(&query, &relative) {
            matches.push((score, relative));
        }
        scanned < 50_000
    });
    matches.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let total = matches.len();
    matches.truncate(limit);
    let summary = if matches.is_empty() {
        format!("No files matched `{query}` (scanned {scanned} files)")
    } else {
        let preview: Vec<&str> = matches.iter().take(8).map(|m| m.1.as_str()).collect();
        let more = if total > preview.len() {
            format!(" (+{} more)", total - preview.len())
        } else {
            String::new()
        };
        format!("Matched {total} files{more}:\n{}", preview.join("\n"))
    };
    let items: Vec<Value> = matches
        .iter()
        .map(|(score, path)| json!({ "path": path, "score": score }))
        .collect();
    Ok(ToolOutput::new(
        summary,
        json!({ "query": query, "matches": items, "total_match_count": total, "scanned_file_count": scanned }),
    ))
}

pub async fn view_image(run: &Run, tool_call_id: i64, input: &Value) -> ToolResult {
    let path = text_field(input, "path");
    if path.is_empty() {
        return Err("missing image path".into());
    }
    let (relative, absolute) = run.workspace().locate(&path, false)?;
    let meta =
        std::fs::metadata(&absolute).map_err(|_| format!("image does not exist: {relative}"))?;
    if meta.is_dir() {
        return Err(format!("path is a directory, not a file: {relative}").into());
    }
    if meta.len() > MAX_VIEW_IMAGE_BYTES {
        return Err("image exceeds 5 MB; compress and retry".into());
    }
    let raw = std::fs::read(&absolute).map_err(|_| format!("failed to read image: {relative}"))?;
    let data_url = image_data_url(&relative, &raw)
        .ok_or_else(|| format!("path is not a recognised image format: {relative}"))?;
    let mime = data_url
        .strip_prefix("data:")
        .and_then(|rest| rest.split(';').next())
        .unwrap_or_default()
        .to_owned();
    let name = relative.rsplit('/').next().unwrap_or(&relative).to_owned();
    let artifact = run
        .record_artifact(Some(tool_call_id), "image", &relative, &mime, &name)
        .await;
    Ok(ToolOutput {
        artifact,
        deliverables: vec![delivered(&relative, &name)],
        follow_up: vec![
            MessagePart {
                kind: "text".into(),
                text: format!("Image attached via view_image: {relative}"),
                ..MessagePart::default()
            },
            MessagePart {
                kind: "image_url".into(),
                image_url: data_url,
                ..MessagePart::default()
            },
        ],
        ..ToolOutput::new(
            format!("Attached `{relative}` to the next turn for visual inspection."),
            json!({ "path": relative, "mime": mime, "bytes": meta.len() }),
        )
    })
}

pub async fn update_plan(run: &Run, input: &Value) -> ToolResult {
    let steps = input
        .get("plan")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if steps.is_empty() {
        return Err("plan must contain at least one step".into());
    }
    let mut normalized = Vec::new();
    let mut in_progress = 0;
    for (index, step) in steps.iter().enumerate() {
        let text = text_field(step, "step");
        if text.is_empty() {
            return Err(format!("plan[{index}].step is required").into());
        }
        let status = text_field(step, "status");
        match status.as_str() {
            "pending" | "completed" => {}
            "in_progress" => in_progress += 1,
            other => {
                return Err(format!(
                    "plan[{index}].status must be pending|in_progress|completed (got {other:?})"
                )
                .into());
            }
        }
        normalized.push((text, status));
    }
    if in_progress > 1 {
        return Err("at most one plan step may be in_progress at a time".into());
    }
    let explanation = text_field(input, "explanation");
    let (session, user, message) = (
        run.session_id,
        run.user_id,
        (run.trigger_message_id > 0).then_some(run.trigger_message_id),
    );
    let rows = normalized.clone();
    run.agent
        .with_db(move |conn| store::replace_plan(conn, session, user, message, &rows))
        .await
        .map_err(|error| format!("persist plan: {error}"))?;
    let plan: Vec<Value> = normalized
        .iter()
        .map(|(step, status)| json!({ "step": step, "status": status }))
        .collect();
    let count = |wanted: &str| normalized.iter().filter(|(_, s)| s == wanted).count();
    let message = if explanation.is_empty() {
        format!(
            "Plan updated: {} total ({} done, {} in progress, {} pending)",
            normalized.len(),
            count("completed"),
            count("in_progress"),
            count("pending")
        )
    } else {
        explanation.clone()
    };
    let output =
        json!({ "plan": plan, "explanation": explanation, "step_count": normalized.len() });
    run.event(
        EventInput::new("plan.updated", "plan", "completed", "Update plan", message)
            .data(output.clone()),
    )
    .await;
    let mut rendered = String::new();
    if !explanation.is_empty() {
        rendered.push_str(&explanation);
        rendered.push_str("\n\n");
    }
    for (index, (step, status)) in normalized.iter().enumerate() {
        let marker = match status.as_str() {
            "in_progress" => "[~]",
            "completed" => "[x]",
            _ => "[ ]",
        };
        rendered.push_str(&format!("{}. {marker} {step}\n", index + 1));
    }
    let todos = normalized
        .into_iter()
        .map(|(content, status)| TodoItem {
            content,
            status: match status.as_str() {
                "in_progress" => TodoStatus::InProgress,
                "completed" => TodoStatus::Completed,
                _ => TodoStatus::Pending,
            },
        })
        .collect();
    Ok(ToolOutput {
        todos: Some(todos),
        ..ToolOutput::new(rendered.trim_end().to_owned(), output)
    })
}
