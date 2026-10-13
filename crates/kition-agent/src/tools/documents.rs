//! Workspace documents and saved deliverables.

use serde_json::{Value, json};

use super::live_documents::LiveDocuments;
use crate::attachments::Kind;
use crate::run::{Run, ToolOutput, ToolResult, delivered, text_field};
use crate::workspace::{self, parent_folder, sanitize_filename};

const READ_BUDGET: usize = 96 * 1024;

/// Where a new artifact goes when the model gave no folder: next to the
/// active document, else `Agent/<title>`.
pub fn default_folder(active_document: &str, title: &str) -> String {
    let parent = parent_folder(active_document);
    if !parent.is_empty() {
        return parent;
    }
    let stamp = chrono_stamp();
    format!(
        "Agent/{}",
        sanitize_filename(title, &format!("Agent Output {stamp}"))
    )
}

fn chrono_stamp() -> String {
    kition_core::time::to_rfc3339(kition_core::now_millis())
        .chars()
        .filter(char::is_ascii_digit)
        .take(14)
        .collect()
}

pub fn is_editable_document(path: &str) -> bool {
    matches!(
        workspace::extension(path).as_deref(),
        Some("md" | "markdown" | "txt")
    )
}

pub async fn read(run: &Run, input: &Value) -> ToolResult {
    let path = text_field(input, "path");
    if path.is_empty() {
        return Err("missing document path".into());
    }
    let kind = Kind::of(&path);
    if kind != Kind::Unknown {
        return Ok(ToolOutput::new(
            format!(
                "`{path}` is a {} file. Its content is already provided in this turn as an attachment \u{2014} do not call document_read on it.",
                kind.as_str()
            ),
            json!({ "path": path, "kind": kind.as_str(), "binary": true }),
        ));
    }
    let read = run.workspace().read_text(&path, READ_BUDGET)?;
    let chars = read.text.chars().count();
    let complete = !read.truncated;
    let output = json!({
        "path": path,
        "chars": chars,
        "bytes": read.text.len(),
        "total_bytes": read.total_bytes,
        "complete": complete,
    });
    let prefix = if complete {
        "Complete contents"
    } else {
        "Truncated leading contents"
    };
    Ok(ToolOutput {
        summary: format!(
            "{prefix} of `{path}` ({chars} visible characters, {} total bytes, complete={complete}):\n\n{}",
            read.total_bytes, read.text
        ),
        output,
        ..ToolOutput::default()
    })
}

pub async fn write(run: &Run, input: &Value) -> ToolResult {
    let mut path = text_field(input, "path");
    if path.is_empty() {
        path = run.active_document_path.trim().to_owned();
    }
    if path.is_empty() {
        return Err("missing document path".into());
    }
    let content = input
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let workspace = run.workspace();
    let (path, _) = workspace.locate_existing(&path)?;
    let delivery = LiveDocuments::of(run)
        .write(&path, content, "document_write", || {
            workspace.write_existing(&path, content).map(|_| ())
        })
        .await?;
    let mut output = json!({ "path": path, "operation": "updated", "chars": content.chars().count(), "at": true });
    delivery.record(&mut output);
    Ok(ToolOutput {
        deliverables: vec![delivered(&path, &format!("Updated: {path}"))],
        ..ToolOutput::new(
            format!("Updated document: `{path}`{}", delivery.note()),
            output,
        )
    })
}

pub async fn search(run: &Run, input: &Value) -> ToolResult {
    let query = text_field(input, "query");
    if query.is_empty() {
        return Err("missing search query".into());
    }
    let hits = run.workspace().search_text(&query, 8)?;
    let mut rows: Vec<String> = hits
        .iter()
        .map(|hit| format!("- `{}`: {}", hit.path, hit.snippet.replace('\n', " ")))
        .collect();
    if rows.is_empty() {
        rows.push("- No matching documents found".into());
    }
    Ok(ToolOutput::new(
        format!("Document search results:\n{}", rows.join("\n")),
        json!({ "query": query, "results": hits }),
    ))
}

pub async fn list(run: &Run, input: &Value) -> ToolResult {
    let path = text_field(input, "path");
    let entries = run.workspace().list_entries(&path, 100)?;
    let mut rows: Vec<String> = entries
        .iter()
        .map(|entry| {
            if entry.readable {
                format!("- `{}`", entry.path)
            } else {
                format!("- `{}` (binary)", entry.path)
            }
        })
        .collect();
    if rows.is_empty() {
        rows.push("- No files found in this folder".into());
    }
    let label = if path.is_empty() {
        "(workspace root)"
    } else {
        &path
    };
    Ok(ToolOutput::new(
        format!("Files under `{label}`:\n{}", rows.join("\n")),
        json!({ "path": path, "entries": entries }),
    ))
}

pub async fn artifact_write(run: &Run, input: &Value) -> ToolResult {
    let raw = text_field(input, "path");
    if raw.is_empty() {
        return Err("missing path".into());
    }
    let cleaned = workspace::clean_path(&raw, false)?;
    let (folder, filename) = match cleaned.rsplit_once('/') {
        Some((folder, filename)) => (folder.to_owned(), filename.to_owned()),
        None => (String::new(), cleaned.clone()),
    };
    let Some(ext) = workspace::extension(&filename) else {
        return Err("path must include a file extension (.md/.markdown/.txt/.html/.htm)".into());
    };
    match ext.as_str() {
        "md" | "markdown" | "txt" | "html" | "htm" => {}
        "pptx" => {
            return Err(
                "PPTX creation is only available through the whiteboard slides workflow".into(),
            );
        }
        "docx" | "xlsx" => {
            return Err("DOCX and XLSX generation are not supported by generic Agent tools; use Markdown or a Kition data table".into());
        }
        other => {
            return Err(format!(
                "unsupported file extension \".{other}\" (supported: .md/.markdown/.txt/.html/.htm)"
            )
            .into());
        }
    }
    let title = filename
        .rsplit_once('.')
        .map_or(filename.as_str(), |(stem, _)| stem)
        .to_owned();
    let folder = if folder.is_empty() {
        default_folder(&run.active_document_path, &title)
    } else {
        folder
    };
    let content = input
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let stored = run
        .workspace()
        .write_new(&folder, &filename, content.as_bytes())?;
    Ok(ToolOutput {
        deliverables: vec![delivered(&stored, &filename)],
        ..ToolOutput::new(
            format!("Saved artifact: `{stored}`"),
            json!({ "path": stored, "extension": format!(".{ext}") }),
        )
    })
}

fn blocked_office(path: &str, mime: &str) -> bool {
    matches!(
        workspace::extension(path).as_deref(),
        Some("docx" | "xlsx" | "pptx")
    ) || matches!(
        mime.to_lowercase().as_str(),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    )
}

pub fn kind_for_mime(mime: &str) -> &'static str {
    let lower = mime.trim().to_lowercase();
    if lower.starts_with("image/") {
        "image"
    } else if lower == "text/html" {
        "html"
    } else if lower == "text/markdown" || lower == "text/plain" {
        "markdown"
    } else {
        "file"
    }
}

pub async fn register_artifact(run: &Run, input: &Value) -> ToolResult {
    let raw = text_field(input, "path");
    if raw.is_empty() {
        return Err("missing path".into());
    }
    let mime = text_field(input, "mime");
    if mime.is_empty() {
        return Err("missing mime".into());
    }
    if blocked_office(&raw, &mime) {
        return Err("DOCX, XLSX, and PPTX creation or registration are not supported by generic Agent tools".into());
    }
    let (relative, absolute) = run.workspace().locate(&raw, false)?;
    let meta =
        std::fs::metadata(&absolute).map_err(|_| format!("file does not exist: {relative}"))?;
    if meta.is_dir() {
        return Err(format!("path is a directory, not a file: {relative}").into());
    }
    let kind = kind_for_mime(&mime);
    let mut title = text_field(input, "title");
    if title.is_empty() {
        let filename = relative.rsplit('/').next().unwrap_or(&relative);
        title = filename
            .rsplit_once('.')
            .map_or(filename, |(stem, _)| stem)
            .to_owned();
    }
    Ok(ToolOutput {
        deliverables: vec![delivered(&relative, &title)],
        ..ToolOutput::new(
            format!("Registered artifact: `{relative}`"),
            json!({ "path": relative, "mime": mime, "kind": kind, "title": title, "bytes": meta.len() }),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_artifact_folders_and_kinds() {
        assert_eq!(default_folder("Notes/plan.md", "x"), "Notes");
        assert!(default_folder("", "Report").starts_with("Agent/Report"));
        assert_eq!(kind_for_mime("image/png"), "image");
        assert_eq!(kind_for_mime("application/pdf"), "file");
        assert!(blocked_office("a.docx", ""));
        assert!(is_editable_document("a.MD"));
        assert!(!is_editable_document("a.html"));
    }

    #[tokio::test]
    async fn writes_an_open_document_through_its_window() {
        use std::sync::PoisonError;
        use std::time::Duration;

        use crate::providers::testing::fixture_with_kits;
        use crate::tools::live_documents::testing::window;

        let kits = kition_kits::KitManager::new(None, Vec::new());
        let fixture = fixture_with_kits("document", Some(kits.clone()));
        let root = fixture.run.workspace().root().to_path_buf();
        std::fs::write(root.join("open.md"), "old").unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(root.join("closed.md"), "old").unwrap_or_else(|err| panic!("{err}"));
        let applied = window(
            kits.bridge(),
            "open.md",
            "",
            json!({ "applied": true, "content": "new" }),
            Duration::ZERO,
        );

        let live = write(
            &fixture.run,
            &json!({ "path": "./open.md", "content": "new" }),
        )
        .await
        .unwrap_or_else(|err| panic!("{}", err.message));
        assert_eq!(live.output["live"], true);
        assert_eq!(live.output["path"], "open.md");
        assert_eq!(
            *applied.lock().unwrap_or_else(PoisonError::into_inner),
            [json!({ "path": "open.md", "content": "new", "tool": "document_write" })]
        );
        assert_eq!(
            std::fs::read_to_string(root.join("open.md")).unwrap_or_default(),
            "old",
            "the window's session saves it"
        );

        let file = write(
            &fixture.run,
            &json!({ "path": "closed.md", "content": "new" }),
        )
        .await
        .unwrap_or_else(|err| panic!("{}", err.message));
        assert_eq!(file.output["live"], false);
        assert_eq!(
            std::fs::read_to_string(root.join("closed.md")).unwrap_or_default(),
            "new"
        );
        assert!(
            write(
                &fixture.run,
                &json!({ "path": "missing.md", "content": "x" })
            )
            .await
            .is_err(),
            "document_write only updates existing documents"
        );
    }
}
