//! The `apply_patch` envelope format:
//!
//! ```text
//! *** Begin Patch
//! *** Add File: <path>       (+ lines follow)
//! *** Delete File: <path>
//! *** Update File: <path>    (optional *** Move to: <path>, then @@ hunks)
//! *** End Patch
//! ```

use serde_json::{Value, json};

use super::live_documents::{Delivery, LiveDocuments};
use crate::run::{Run, ToolOutput, ToolResult, bool_field, text_field};

#[derive(Debug, Clone, PartialEq)]
enum Hunk {
    Add {
        path: String,
        contents: String,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        move_to: String,
        chunks: Vec<Chunk>,
    },
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Chunk {
    context: String,
    old: Vec<String>,
    new: Vec<String>,
    end_of_file: bool,
}

fn parse_error(message: impl Into<String>, line: usize) -> String {
    if line > 0 {
        format!("invalid hunk at line {line}: {}", message.into())
    } else {
        format!("invalid patch: {}", message.into())
    }
}

fn body_lines(patch: &str) -> Result<Vec<&str>, String> {
    let lines: Vec<&str> = patch.trim().split('\n').collect();
    let check = |lines: &[&str]| -> Result<(), String> {
        if lines.len() < 2 || lines[0].trim() != "*** Begin Patch" {
            return Err(parse_error(
                "The first line of the patch must be '*** Begin Patch'",
                0,
            ));
        }
        if lines[lines.len() - 1].trim() != "*** End Patch" {
            return Err(parse_error(
                "The last line of the patch must be '*** End Patch'",
                0,
            ));
        }
        Ok(())
    };
    match check(&lines) {
        Ok(()) => Ok(lines[1..lines.len() - 1].to_vec()),
        Err(error) => {
            // Tolerate a heredoc wrapper around the envelope.
            let heredoc = lines.len() >= 4
                && matches!(lines[0], "<<EOF" | "<<'EOF'" | "<<\"EOF\"")
                && lines[lines.len() - 1].ends_with("EOF");
            if heredoc {
                let inner = &lines[1..lines.len() - 1];
                check(inner)?;
                return Ok(inner[1..inner.len() - 1].to_vec());
            }
            Err(error)
        }
    }
}

fn parse(patch: &str) -> Result<Vec<Hunk>, String> {
    let mut lines = body_lines(patch)?;
    let mut line_number = 2;
    if let Some(first) = lines.first()
        && let Some(id) = first.trim_start().strip_prefix("*** Environment ID: ")
    {
        if id.trim().is_empty() {
            return Err(parse_error("apply_patch environment_id cannot be empty", 0));
        }
        lines.remove(0);
        line_number = 3;
    }
    let mut hunks = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let first = lines[index].trim();
        if let Some(path) = first.strip_prefix("*** Add File: ") {
            let mut contents = String::new();
            let mut used = 1;
            for line in &lines[index + 1..] {
                let Some(rest) = line.strip_prefix('+') else {
                    break;
                };
                contents.push_str(rest);
                contents.push('\n');
                used += 1;
            }
            hunks.push(Hunk::Add {
                path: path.to_owned(),
                contents,
            });
            index += used;
            line_number += used;
        } else if let Some(path) = first.strip_prefix("*** Delete File: ") {
            hunks.push(Hunk::Delete {
                path: path.to_owned(),
            });
            index += 1;
            line_number += 1;
        } else if let Some(path) = first.strip_prefix("*** Update File: ") {
            let mut used = 1;
            let mut move_to = String::new();
            if let Some(dest) = lines
                .get(index + 1)
                .and_then(|line| line.strip_prefix("*** Move to: "))
            {
                move_to = dest.to_owned();
                used += 1;
            }
            let mut chunks = Vec::new();
            while index + used < lines.len() {
                let line = lines[index + used];
                if line.trim().is_empty() {
                    used += 1;
                    continue;
                }
                if line.starts_with('*') {
                    break;
                }
                let (chunk, consumed) = parse_chunk(
                    &lines[index + used..],
                    line_number + used,
                    chunks.is_empty(),
                )?;
                chunks.push(chunk);
                used += consumed;
            }
            if chunks.is_empty() {
                return Err(parse_error(
                    format!("Update file hunk for path '{path}' is empty"),
                    line_number,
                ));
            }
            hunks.push(Hunk::Update {
                path: path.to_owned(),
                move_to,
                chunks,
            });
            index += used;
            line_number += used;
        } else {
            return Err(parse_error(
                format!(
                    "'{first}' is not a valid hunk header. Valid hunk headers: '*** Add File: {{path}}', '*** Delete File: {{path}}', '*** Update File: {{path}}'"
                ),
                line_number,
            ));
        }
    }
    Ok(hunks)
}

fn parse_chunk(lines: &[&str], line_number: usize, first: bool) -> Result<(Chunk, usize), String> {
    let mut chunk = Chunk::default();
    let start = if lines[0] == "@@" {
        1
    } else if let Some(context) = lines[0].strip_prefix("@@ ") {
        chunk.context = context.to_owned();
        1
    } else if first {
        0
    } else {
        return Err(parse_error(
            format!(
                "Expected update hunk to start with a @@ context marker, got: '{}'",
                lines[0]
            ),
            line_number,
        ));
    };
    if start >= lines.len() {
        return Err(parse_error(
            "Update hunk does not contain any lines",
            line_number + 1,
        ));
    }
    let mut parsed = 0;
    for line in &lines[start..] {
        if *line == "*** End of File" {
            if parsed == 0 {
                return Err(parse_error(
                    "Update hunk does not contain any lines",
                    line_number + 1,
                ));
            }
            chunk.end_of_file = true;
            parsed += 1;
            break;
        }
        if line.is_empty() {
            chunk.old.push(String::new());
            chunk.new.push(String::new());
        } else if let Some(rest) = line.strip_prefix(' ') {
            chunk.old.push(rest.to_owned());
            chunk.new.push(rest.to_owned());
        } else if let Some(rest) = line.strip_prefix('+') {
            chunk.new.push(rest.to_owned());
        } else if let Some(rest) = line.strip_prefix('-') {
            chunk.old.push(rest.to_owned());
        } else {
            if parsed == 0 {
                return Err(parse_error(
                    format!(
                        "Unexpected line found in update hunk: '{line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)"
                    ),
                    line_number + 1,
                ));
            }
            break;
        }
        parsed += 1;
    }
    Ok((chunk, parsed + start))
}

/// Typographic punctuation folded to ASCII for the loosest match pass.
fn normalise(text: &str) -> String {
    text.trim()
        .chars()
        .map(|c| match c {
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            '\u{2018}'..='\u{201B}' => '\'',
            '\u{201C}'..='\u{201F}' => '"',
            '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

/// Finds `pattern` in `lines` at or after `start`, exactly first, then with
/// progressively looser whitespace and punctuation matching.
fn seek(lines: &[String], pattern: &[String], start: usize, eof: bool) -> Option<usize> {
    if pattern.is_empty() {
        return Some(start);
    }
    if pattern.len() > lines.len() {
        return None;
    }
    let from = if eof {
        lines.len() - pattern.len()
    } else {
        start
    };
    let last = lines.len() - pattern.len();
    type Equal<'a> = &'a dyn Fn(&str, &str) -> bool;
    let passes: [Equal<'_>; 4] = [
        &|a, b| a == b,
        &|a, b| a.trim_end() == b.trim_end(),
        &|a, b| a.trim() == b.trim(),
        &|a, b| normalise(a) == normalise(b),
    ];
    for equal in passes {
        for index in from..=last {
            if pattern
                .iter()
                .enumerate()
                .all(|(offset, wanted)| equal(&lines[index + offset], wanted))
            {
                return Some(index);
            }
        }
    }
    None
}

fn derive(original: &str, path: &str, chunks: &[Chunk]) -> Result<String, String> {
    let mut lines: Vec<String> = original.split('\n').map(str::to_owned).collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let mut replacements: Vec<(usize, usize, Vec<String>)> = Vec::new();
    let mut cursor = 0;
    for chunk in chunks {
        if !chunk.context.is_empty() {
            let found = seek(&lines, std::slice::from_ref(&chunk.context), cursor, false)
                .ok_or_else(|| format!("Failed to find context '{}' in {path}", chunk.context))?;
            cursor = found + 1;
        }
        if chunk.old.is_empty() {
            replacements.push((lines.len(), 0, chunk.new.clone()));
            continue;
        }
        let mut pattern = chunk.old.as_slice();
        let mut new = chunk.new.as_slice();
        let mut found = seek(&lines, pattern, cursor, chunk.end_of_file);
        if found.is_none() && pattern.last().is_some_and(String::is_empty) {
            pattern = &pattern[..pattern.len() - 1];
            if new.last().is_some_and(String::is_empty) {
                new = &new[..new.len() - 1];
            }
            found = seek(&lines, pattern, cursor, chunk.end_of_file);
        }
        let found = found.ok_or_else(|| {
            format!(
                "Failed to find expected lines in {path}:\n{}",
                chunk.old.join("\n")
            )
        })?;
        replacements.push((found, pattern.len(), new.to_vec()));
        cursor = found + pattern.len();
    }
    replacements.sort_by_key(|replacement| replacement.0);
    for (start, length, new) in replacements.into_iter().rev() {
        let end = (start + length).min(lines.len());
        lines.splice(start..end, new);
    }
    if lines.last().is_none_or(|last| !last.is_empty()) {
        lines.push(String::new());
    }
    Ok(lines.join("\n"))
}

fn count_lines(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.matches('\n').count() + usize::from(!text.ends_with('\n'))
    }
}

/// Lines added and removed between two texts (LCS on the changed middle).
fn count_diff(old: &str, new: &str) -> (usize, usize) {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..]
        .iter()
        .rev()
        .zip(b[prefix..].iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let a = &a[prefix..a.len() - suffix];
    let b = &b[prefix..b.len() - suffix];
    if a.len().saturating_mul(b.len()) > 4_000_000 {
        return (b.len(), a.len());
    }
    let mut row = vec![0_usize; b.len() + 1];
    for x in a {
        let mut diagonal = 0;
        for (j, y) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if x == y {
                diagonal + 1
            } else {
                above.max(row[j])
            };
            diagonal = above;
        }
    }
    let common = row[b.len()];
    (b.len() - common, a.len() - common)
}

/// Applies a patch. A Markdown document a renderer window has open is patched against its live
/// text (unsaved edits included) and the result applied in that window
/// (`live_documents.rs`); when the window does not apply it, the patch is applied to the file
/// instead.
pub async fn apply(run: &Run, input: &Value) -> ToolResult {
    let patch = text_field(input, "patch");
    if patch.is_empty() {
        return Err("missing patch body".into());
    }
    let dry_run = bool_field(input, "dry_run") || run.execution_mode == "preview";
    let hunks = parse(&patch)?;
    let workspace = run.workspace();
    let live = LiveDocuments::of(run);
    let read = |path: &str| -> Result<String, String> {
        let (_, absolute) = workspace.locate(path, false)?;
        std::fs::read_to_string(absolute).map_err(|error| format!("read {path}: {error}"))
    };
    let write = |path: &str, contents: &str| -> Result<(), String> {
        workspace
            .write_at(path, contents.as_bytes())
            .map(|_| ())
            .map_err(|error| format!("write {path}: {error}"))
    };
    let remove = |path: &str| -> Result<(), String> {
        let (_, absolute) = workspace.locate(path, false)?;
        std::fs::remove_file(absolute).map_err(|error| format!("remove {path}: {error}"))
    };
    let mut ops = Vec::new();
    let mut parts = Vec::new();
    let (mut total_added, mut total_removed) = (0, 0);
    for hunk in hunks {
        let mut delivery = Delivery::default();
        let (path, kind, move_to, added, removed) = match hunk {
            Hunk::Add { path, contents } => {
                let (path, absolute) = workspace.locate(&path, false)?;
                if absolute.is_dir() {
                    return Err(format!("cannot add file '{path}': path is a directory").into());
                }
                let existing = std::fs::read_to_string(&absolute).unwrap_or_default();
                if !dry_run {
                    delivery = live
                        .write(&path, &contents, "apply_patch", || write(&path, &contents))
                        .await?;
                }
                (
                    path,
                    "add",
                    String::new(),
                    count_lines(&contents),
                    count_lines(&existing),
                )
            }
            Hunk::Delete { path } => {
                let existing =
                    read(&path).map_err(|_| format!("cannot delete '{path}': file not found"))?;
                if !dry_run {
                    remove(&path)?;
                }
                (path, "delete", String::new(), 0, count_lines(&existing))
            }
            Hunk::Update {
                path,
                move_to,
                chunks,
            } => {
                let (path, _) = workspace.locate(&path, false)?;
                let destination = if move_to.is_empty() {
                    path.clone()
                } else {
                    workspace.locate(&move_to, false)?.0
                };
                // An open document in place is patched against its live text; a move patches
                // the file.
                let window = live.window(&path).filter(|_| destination == path);
                let live_text = match window {
                    Some(window) => live.read(window, &path).await,
                    None => None,
                };
                let (mut original, mut updated) = match &live_text {
                    Some(text) => (text.clone(), derive(text, &path, &chunks)?),
                    None => {
                        let original = read(&path)?;
                        let updated = derive(&original, &path, &chunks)?;
                        (original, updated)
                    }
                };
                if !dry_run {
                    let applied = match (window, &live_text) {
                        (Some(window), Some(_)) => {
                            Some(live.apply(window, &path, &updated, "apply_patch").await)
                        }
                        _ => None,
                    };
                    match applied {
                        Some(Ok(_)) => {
                            delivery = Delivery {
                                live: true,
                                fallback: None,
                            };
                        }
                        fallback => {
                            if let Some(Err(reason)) = fallback {
                                // The live text held edits the file does not have yet: patch
                                // the file itself, so they are not written twice.
                                original = read(&path)?;
                                updated = derive(&original, &path, &chunks)?;
                                delivery = Delivery::file(Some(reason));
                            }
                            write(&destination, &updated)?;
                            if destination != path {
                                remove(&path)?;
                            }
                        }
                    }
                }
                let (added, removed) = count_diff(&original, &updated);
                (path, "update", move_to, added, removed)
            }
        };
        total_added += added;
        total_removed += removed;
        let verb = match kind {
            "add" => "added".to_owned(),
            "delete" => "deleted".to_owned(),
            _ if !move_to.is_empty() && move_to != path => {
                format!("updated and moved to {move_to}")
            }
            _ => "updated".to_owned(),
        };
        parts.push(format!("{verb} `{path}`{}", delivery.note()));
        let mut op =
            json!({ "path": path, "kind": kind, "lines_added": added, "lines_removed": removed });
        if !move_to.is_empty() {
            op["move_path"] = json!(move_to);
        }
        delivery.record(&mut op);
        ops.push(op);
    }
    let summary = if ops.is_empty() {
        "apply_patch: no changes".to_owned()
    } else {
        let prefix = if dry_run {
            "apply_patch preview"
        } else {
            "apply_patch applied"
        };
        format!(
            "{prefix}: {} \u{b7} +{total_added} \u{2212}{total_removed}",
            parts.join(", ")
        )
    };
    Ok(ToolOutput::new(
        summary,
        json!({ "dry_run": dry_run, "file_ops": ops }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        text.split('\n').map(str::to_owned).collect()
    }

    #[test]
    fn parses_all_hunk_kinds() {
        let hunks = parse(
            "*** Begin Patch\n*** Add File: a.md\n+hello\n*** Delete File: b.md\n*** Update File: c.md\n*** Move to: d.md\n@@ intro\n-old\n+new\n*** End Patch",
        )
        .unwrap_or_default();
        assert_eq!(hunks.len(), 3);
        assert_eq!(
            hunks[0],
            Hunk::Add {
                path: "a.md".into(),
                contents: "hello\n".into()
            }
        );
        let Hunk::Update {
            move_to, chunks, ..
        } = &hunks[2]
        else {
            panic!("expected update");
        };
        assert_eq!(move_to, "d.md");
        assert_eq!(chunks[0].context, "intro");
        assert!(parse("no envelope").is_err());
        assert!(parse("<<EOF\n*** Begin Patch\n*** Delete File: x\n*** End Patch\nEOF").is_ok());
    }

    #[test]
    fn derives_updates_with_loose_matching() {
        let chunks = vec![Chunk {
            old: lines("b \u{2014} c"),
            new: lines("B"),
            ..Chunk::default()
        }];
        assert_eq!(
            derive("a\nb - c\nd\n", "x", &chunks).as_deref(),
            Ok("a\nB\nd\n")
        );
        let append = vec![Chunk {
            new: lines("z"),
            ..Chunk::default()
        }];
        assert_eq!(derive("a", "x", &append).as_deref(), Ok("a\nz\n"));
        let missing = vec![Chunk {
            old: lines("nope"),
            ..Chunk::default()
        }];
        assert!(derive("a\n", "x", &missing).is_err());
    }

    #[test]
    fn counts_changed_lines() {
        assert_eq!(count_diff("a\nb\nc\n", "a\nx\nc\nd\n"), (2, 1));
        assert_eq!(count_lines("a\nb"), 2);
    }

    mod live {
        use std::sync::PoisonError;
        use std::time::Duration;

        use serde_json::json;

        use super::super::apply;
        use crate::providers::testing::fixture_with_kits;
        use crate::tools::live_documents::testing::window;

        const PATCH: &str =
            "*** Begin Patch\n*** Update File: Notes/a.md\n@@\n a\n-c\n+C\n*** End Patch";

        fn setup() -> (crate::providers::testing::Fixture, kition_kits::KitManager) {
            let kits = kition_kits::KitManager::new(None, Vec::new());
            let fixture = fixture_with_kits("document", Some(kits.clone()));
            let notes = fixture.run.workspace().root().join("Notes");
            std::fs::create_dir_all(&notes).unwrap_or_else(|err| panic!("{err}"));
            std::fs::write(notes.join("a.md"), "a\nc\n").unwrap_or_else(|err| panic!("{err}"));
            (fixture, kits)
        }

        fn file(fixture: &crate::providers::testing::Fixture) -> String {
            std::fs::read_to_string(fixture.run.workspace().root().join("Notes/a.md"))
                .unwrap_or_default()
        }

        #[tokio::test]
        async fn patches_the_live_text_of_an_open_document() {
            let (fixture, kits) = setup();
            let applied = window(
                kits.bridge(),
                "Notes/a.md",
                "a\nc\nunsaved\n",
                json!({ "applied": true, "content": "a\nC\nunsaved\n" }),
                Duration::ZERO,
            );
            let result = apply(&fixture.run, &json!({ "patch": PATCH }))
                .await
                .unwrap_or_else(|err| panic!("{}", err.message));
            assert_eq!(
                *applied.lock().unwrap_or_else(PoisonError::into_inner),
                [
                    json!({ "path": "Notes/a.md", "content": "a\nC\nunsaved\n", "tool": "apply_patch" })
                ]
            );
            assert_eq!(
                file(&fixture),
                "a\nc\n",
                "the window's session saves it, not the tool"
            );
            assert_eq!(result.output["file_ops"][0]["live"], true);
            assert!(
                result.summary.contains("applied live"),
                "{}",
                result.summary
            );

            // A dry run reads the live text but applies nothing.
            let preview = apply(&fixture.run, &json!({ "patch": PATCH, "dry_run": true }))
                .await
                .unwrap_or_else(|err| panic!("{}", err.message));
            assert_eq!(preview.output["file_ops"][0]["live"], false);
            assert_eq!(
                applied.lock().unwrap_or_else(PoisonError::into_inner).len(),
                1
            );
        }

        #[tokio::test]
        async fn a_refused_edit_patches_the_file_instead() {
            let (fixture, kits) = setup();
            window(
                kits.bridge(),
                "Notes/a.md",
                "a\nc\nunsaved\n",
                json!({ "applied": false, "reason": "conflict" }),
                Duration::ZERO,
            );
            let result = apply(&fixture.run, &json!({ "patch": PATCH }))
                .await
                .unwrap_or_else(|err| panic!("{}", err.message));
            assert_eq!(
                file(&fixture),
                "a\nC\n",
                "the unsaved line stays in the editor only"
            );
            assert_eq!(result.output["file_ops"][0]["live"], false);
            assert_eq!(result.output["file_ops"][0]["fallback"], "conflict");
        }

        #[tokio::test]
        async fn a_document_no_window_has_open_is_patched_as_a_file() {
            let (fixture, kits) = setup();
            window(kits.bridge(), "Other.md", "", json!({}), Duration::ZERO);
            let result = apply(&fixture.run, &json!({ "patch": PATCH }))
                .await
                .unwrap_or_else(|err| panic!("{}", err.message));
            assert_eq!(file(&fixture), "a\nC\n");
            assert_eq!(result.output["file_ops"][0]["live"], false);
            assert!(result.output["file_ops"][0].get("fallback").is_none());
        }
    }
}
