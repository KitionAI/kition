//! Read-only local folders the user attaches to a turn ("local analysis
//! sources"), addressed as `source://<id>/<path>`. Credentials, symlinks
//! that leave the folder, and Git-ignored files stay hidden.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::fuzzy;
use crate::run::{Run, ToolOutput, ToolResult, int_field, string_list, text_field, truncate_chars};

const MAX_SOURCES: usize = 8;
const MAX_SCANNED: usize = 20_000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SEARCH_BYTES: u64 = 64 * 1024 * 1024;
const MAX_READ_LINES: i64 = 1000;
const DEFAULT_READ_LINES: i64 = 200;
const MAX_INSTRUCTION_BYTES: usize = 32 * 1024;
const MAX_PATH_LIST_BYTES: usize = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES: usize = 96 * 1024;

pub const CORE_TOOLS: &[&str] = &[
    "source_read",
    "source_file_search",
    "source_search",
    "source_list",
];
pub const GIT_TOOLS: &[&str] = &[
    "source_git_status",
    "source_git_log",
    "source_git_show",
    "source_git_blame",
];

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct LocalSourceInput {
    pub id: String,
    pub label: String,
    pub root_path: String,
    pub access: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSource {
    pub id: String,
    pub label: String,
    pub root: PathBuf,
    pub git: bool,
}

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && id.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Validates the folders a request attaches.
pub fn normalize(inputs: &[LocalSourceInput]) -> Result<Vec<LocalSource>, String> {
    if inputs.len() > MAX_SOURCES {
        return Err(format!(
            "at most {MAX_SOURCES} local analysis folders can be attached"
        ));
    }
    let mut out: Vec<LocalSource> = Vec::new();
    for input in inputs {
        let id = input.id.trim().to_lowercase();
        let label = input.label.trim();
        let root = input.root_path.trim();
        if !valid_id(&id) {
            return Err("invalid local analysis source id".into());
        }
        if out.iter().any(|source| source.id == id) {
            return Err("duplicate local analysis source id".into());
        }
        if label.is_empty() || label.chars().count() > 120 {
            return Err("invalid local analysis source label".into());
        }
        if !input.access.trim().eq_ignore_ascii_case("read") {
            return Err("local analysis sources must be read only".into());
        }
        if root.is_empty() || root.contains('\0') || !Path::new(root).is_absolute() {
            return Err("local analysis source path must be absolute".into());
        }
        let real = Path::new(root)
            .canonicalize()
            .map_err(|_| format!("failed to open local analysis source {label:?}"))?;
        if !real.is_dir() {
            return Err(format!(
                "local analysis source {label:?} is not a directory"
            ));
        }
        if out.iter().any(|source| source.root == real) {
            continue;
        }
        out.push(LocalSource {
            git: detect_git(&real),
            id,
            label: label.to_owned(),
            root: real,
        });
    }
    Ok(out)
}

/// Tools to offer for these sources.
pub fn tool_names(sources: &[LocalSource]) -> Vec<&'static str> {
    let mut names = CORE_TOOLS.to_vec();
    if sources.iter().any(|source| source.git) {
        names.extend_from_slice(GIT_TOOLS);
    }
    names
}

pub fn uri(id: &str, relative: &str) -> String {
    format!("source://{id}/{}", relative.trim_start_matches('/'))
}

pub fn prompt_context(sources: &[LocalSource]) -> String {
    if sources.is_empty() {
        return String::new();
    }
    let mut rows = vec![
        "Read-only local analysis folders are attached for this turn.".to_owned(),
        "Use source_list, source_file_search, source_search, and source_read with the source ids below. Do not guess or expose host paths. Write all generated output only to the Kition workspace.".to_owned(),
        "Root AGENTS.override.md or AGENTS.md instructions are included below when present. For files in nested directories, source_read returns the complete applicable instruction chain before the requested lines.".to_owned(),
    ];
    for source in sources {
        let mut capabilities = "read-only source".to_owned();
        if source.git {
            capabilities.push_str("; read-only Git history available");
        }
        rows.push(format!(
            "- `{}` ({}; {}): {}",
            source.id,
            source.label,
            capabilities,
            uri(&source.id, "")
        ));
    }
    let mut remaining = MAX_INSTRUCTION_BYTES;
    let mut entries = Vec::new();
    for source in sources {
        if let Some(entry) = instruction_at(source, "", remaining) {
            remaining = remaining.saturating_sub(entry.1.len());
            entries.push(entry);
        }
    }
    let instructions = format_instructions(
        "Root project instructions for the attached analysis folders",
        &entries,
    );
    if !instructions.is_empty() {
        rows.push(instructions);
    }
    rows.join("\n")
}

pub fn event_data(sources: &[LocalSource]) -> Value {
    let items: Vec<Value> = sources
        .iter()
        .map(|source| json!({ "id": source.id, "label": source.label, "access": "read", "git": source.git }))
        .collect();
    json!({ "count": items.len(), "sources": items })
}

fn find<'a>(run: &'a Run, id: &str) -> Result<&'a LocalSource, String> {
    let id = id.trim().to_lowercase();
    run.local_sources
        .iter()
        .find(|source| source.id == id)
        .ok_or_else(|| format!("local analysis source is not attached: {id}"))
}

fn select<'a>(run: &'a Run, id: &str) -> Result<Vec<&'a LocalSource>, String> {
    if id.trim().is_empty() {
        Ok(run.local_sources.iter().collect())
    } else {
        Ok(vec![find(run, id)?])
    }
}

fn clean_relative(requested: &str, allow_root: bool) -> Result<String, String> {
    let requested = requested.trim();
    if requested.contains('\0') || Path::new(requested).is_absolute() {
        return Err("local source path must be relative".into());
    }
    let cleaned = crate::workspace::clean_path(requested, true)
        .map_err(|_| "local source path must stay within the selected folder".to_owned())?;
    if cleaned.is_empty() && !allow_root {
        return Err("local source file path is required".into());
    }
    Ok(cleaned)
}

/// The real path and canonical relative path of `requested` inside the
/// source.
fn resolve(
    source: &LocalSource,
    requested: &str,
    allow_root: bool,
) -> Result<(PathBuf, String), String> {
    let relative = clean_relative(requested, allow_root)?;
    let target = if relative.is_empty() {
        source.root.clone()
    } else {
        source.root.join(&relative)
    };
    let real = target
        .canonicalize()
        .map_err(|_| "local source path was not found".to_owned())?;
    let inside = real
        .strip_prefix(&source.root)
        .map_err(|_| "local source path resolves outside the selected folder".to_owned())?;
    let relative = inside
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    Ok((real, relative))
}

pub fn is_sensitive(relative: &str) -> bool {
    let name = relative
        .rsplit('/')
        .next()
        .unwrap_or(relative)
        .to_lowercase();
    if name == ".env" || name.starts_with(".env.") || name == "id_rsa" || name == "id_ed25519" {
        return true;
    }
    matches!(
        crate::workspace::extension(&name).as_deref(),
        Some("pem" | "key" | "p12" | "pfx" | "crt" | "cer")
    )
}

fn skip_dir(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        ".git"
            | ".svn"
            | ".hg"
            | ".kition"
            | ".idea"
            | ".vscode"
            | "node_modules"
            | "vendor"
            | "dist"
            | "build"
            | "out"
            | "coverage"
            | ".cache"
    )
}

fn is_text(data: &[u8]) -> bool {
    !data[..data.len().min(8192)].contains(&0) && std::str::from_utf8(data).is_ok()
}

fn read_text(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|_| "file is unavailable".to_owned())?;
    if !meta.is_file() {
        return Err("path is not a regular file".into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("file is too large".into());
    }
    let data = std::fs::read(path).map_err(|_| "file is unavailable".to_owned())?;
    if data[..data.len().min(8192)].contains(&0) {
        return Err("file is binary".into());
    }
    String::from_utf8(data).map_err(|_| "file is not valid UTF-8 text".to_owned())
}

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    if text.ends_with('\n') {
        lines.pop();
    }
    lines
}

fn modified_at(meta: &std::fs::Metadata) -> String {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| kition_core::time::to_rfc3339(since.as_millis() as i64))
        .unwrap_or_default()
}

fn truncated_suffix(truncated: bool) -> &'static str {
    if truncated { ", truncated" } else { "" }
}

fn instruction_at(
    source: &LocalSource,
    directory: &str,
    max_bytes: usize,
) -> Option<(String, String)> {
    if max_bytes == 0 {
        return None;
    }
    for name in ["AGENTS.override.md", "AGENTS.md"] {
        let relative = if directory.is_empty() {
            name.to_owned()
        } else {
            format!("{directory}/{name}")
        };
        let path = source.root.join(&relative);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let Ok(mut data) = std::fs::read(&path) else {
            continue;
        };
        data.truncate(max_bytes);
        let content = String::from_utf8_lossy(&data).trim().to_owned();
        if content.is_empty() {
            return None;
        }
        return Some((uri(&source.id, &relative), content));
    }
    None
}

fn format_instructions(title: &str, entries: &[(String, String)]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let mut parts = vec![format!("{title}:")];
    for (uri, content) in entries {
        parts.push(format!(
            "<project_instructions source={uri:?}>\n{content}\n</project_instructions>"
        ));
    }
    parts.join("\n\n")
}

fn applicable_instructions(source: &LocalSource, relative: &str) -> String {
    let mut directories = vec![String::new()];
    if let Some((directory, _)) = relative.rsplit_once('/') {
        let mut current = String::new();
        for part in directory.split('/') {
            current = if current.is_empty() {
                part.to_owned()
            } else {
                format!("{current}/{part}")
            };
            directories.push(current.clone());
        }
    }
    let mut remaining = MAX_INSTRUCTION_BYTES;
    let mut entries = Vec::new();
    for directory in directories {
        if let Some(entry) = instruction_at(source, &directory, remaining) {
            remaining = remaining.saturating_sub(entry.1.len());
            entries.push(entry);
        }
    }
    format_instructions(
        &format!(
            "Applicable project instructions for `{}` (root first; deeper files take precedence)",
            uri(&source.id, relative)
        ),
        &entries,
    )
}

pub fn read(run: &Run, input: &Value) -> ToolResult {
    let source = find(run, &text_field(input, "source_id"))?;
    let (path, relative) = resolve(source, &text_field(input, "path"), false)?;
    if is_sensitive(&relative) {
        return Err("sensitive credential files are not available to local analysis tools".into());
    }
    let text =
        read_text(&path).map_err(|error| format!("failed to read local source file: {error}"))?;
    let lines = split_lines(&text);
    let total = lines.len() as i64;
    let mut start = int_field(input, "start_line").max(1);
    let count = match int_field(input, "line_count") {
        n if n <= 0 => DEFAULT_READ_LINES,
        n => n.min(MAX_READ_LINES),
    };
    let max_bytes = match int_field(input, "max_bytes") {
        n if n <= 0 => 48 * 1024,
        n => n.min(128 * 1024),
    } as usize;
    let mut body = String::new();
    let mut end = start - 1;
    let mut truncated_by_bytes = false;
    if total == 0 {
        start = 0;
        end = 0;
    } else {
        if start > total {
            return Err(format!(
                "failed to read local source file: start_line exceeds the file's {total} lines"
            )
            .into());
        }
        for number in start..=(start + count - 1).min(total) {
            let row = format!("{number:>6} | {}\n", lines[(number - 1) as usize]);
            if !body.is_empty() && body.len() + row.len() > max_bytes {
                truncated_by_bytes = true;
                break;
            }
            body.push_str(&row);
            end = number;
        }
        end = end.max(start);
    }
    let next = if end < total { end + 1 } else { 0 };
    let truncated = truncated_by_bytes || end < total;
    let meta = std::fs::metadata(&path).ok();
    let uri = uri(&source.id, &relative);
    let output = json!({
        "path": uri, "total_lines": total, "start_line": start, "end_line": end,
        "next_start_line": next, "truncated": truncated,
        "size": meta.as_ref().map_or(0, std::fs::Metadata::len),
        "modified_at": meta.as_ref().map(modified_at).unwrap_or_default(),
    });
    let mut parts = Vec::new();
    let instructions = applicable_instructions(source, &relative);
    if !instructions.is_empty() {
        parts.push(instructions);
    }
    parts.push(format!(
        "Contents of `{uri}` (lines {start}-{end} of {total}{}):\n\n{}",
        truncated_suffix(truncated),
        body.trim_end_matches('\n')
    ));
    Ok(ToolOutput {
        summary: parts.join("\n\n"),
        event_summary: Some(format!(
            "Read `{uri}` lines {start}-{end} of {total}{}",
            truncated_suffix(truncated)
        )),
        event_output: Some(output.clone()),
        output,
        ..ToolOutput::default()
    })
}

pub fn list(run: &Run, input: &Value) -> ToolResult {
    let source = find(run, &text_field(input, "source_id"))?;
    let (path, relative) = resolve(source, &text_field(input, "path"), true)?;
    let limit = match int_field(input, "limit") {
        n if n <= 0 => 100,
        n => n.min(200),
    } as usize;
    let mut entries: Vec<_> = std::fs::read_dir(&path)
        .map_err(|_| "failed to list local source directory".to_owned())?
        .flatten()
        .collect();
    entries.sort_by_key(|entry| entry.file_name());
    let mut items = Vec::new();
    let mut rows = Vec::new();
    for entry in entries {
        if items.len() >= limit {
            break;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if kind.is_symlink() || (kind.is_dir() && skip_dir(&name)) {
            continue;
        }
        let child = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        if is_sensitive(&child) || is_ignored(source, &child) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let kind = if kind.is_dir() { "directory" } else { "file" };
        let uri = uri(&source.id, &child);
        let modified = modified_at(&meta);
        rows.push(format!(
            "- `{uri}` ({kind}, {} bytes, modified {modified})",
            meta.len()
        ));
        items.push(json!({ "path": uri, "name": name, "kind": kind, "size": meta.len(), "modified_at": modified }));
    }
    if rows.is_empty() {
        rows.push("- No readable entries found".into());
    }
    Ok(ToolOutput::new(
        format!("Local source entries:\n{}", rows.join("\n")),
        json!({ "path": uri(&source.id, &relative), "entries": items }),
    ))
}

struct Candidate<'a> {
    source: &'a LocalSource,
    relative: String,
    absolute: PathBuf,
    size: u64,
    modified: String,
}

struct Walk<'a> {
    files: Vec<Candidate<'a>>,
    directories: Vec<(&'a LocalSource, String)>,
    scanned: usize,
    capped: bool,
}

/// `**` glob patterns as regular expressions.
fn glob_regexes(patterns: &[String]) -> Result<Vec<regex::Regex>, String> {
    patterns
        .iter()
        .map(|pattern| pattern.trim().replace('\\', "/"))
        .filter(|pattern| !pattern.is_empty())
        .map(|pattern| {
            let mut expression = String::from("^");
            let chars: Vec<char> = pattern.chars().collect();
            let mut index = 0;
            while index < chars.len() {
                match chars[index] {
                    '*' if chars.get(index + 1) == Some(&'*') => {
                        index += 1;
                        if chars.get(index + 1) == Some(&'/') {
                            index += 1;
                            expression.push_str("(?:.*/)?");
                        } else {
                            expression.push_str(".*");
                        }
                    }
                    '*' => expression.push_str("[^/]*"),
                    '?' => expression.push_str("[^/]"),
                    other => expression.push_str(&regex::escape(&other.to_string())),
                }
                index += 1;
            }
            expression.push('$');
            regex::Regex::new(&expression).map_err(|_| format!("invalid source glob {pattern:?}"))
        })
        .collect()
}

fn walk<'a>(
    sources: &[&'a LocalSource],
    include: &[String],
    exclude: &[String],
) -> Result<Walk<'a>, String> {
    let include = glob_regexes(include)?;
    let exclude = glob_regexes(exclude)?;
    let matches = |path: &str| {
        (include.is_empty() || include.iter().any(|re| re.is_match(path)))
            && !exclude.iter().any(|re| re.is_match(path))
    };
    let mut result = Walk {
        files: Vec::new(),
        directories: Vec::new(),
        scanned: 0,
        capped: false,
    };
    for source in sources {
        if result.scanned >= MAX_SCANNED {
            result.capped = true;
            break;
        }
        let budget = MAX_SCANNED - result.scanned;
        let (paths, capped) = if source.git {
            git_paths(source, budget)?
        } else {
            (walked_paths(source, budget), false)
        };
        result.capped |= capped;
        let mut seen_dirs = std::collections::BTreeSet::new();
        for relative in paths {
            if result.scanned >= MAX_SCANNED {
                result.capped = true;
                break;
            }
            result.scanned += 1;
            let relative = relative.trim_start_matches("./").replace('\\', "/");
            if relative.is_empty() || is_sensitive(&relative) || !matches(&relative) {
                continue;
            }
            let Ok((absolute, resolved)) = resolve(source, &relative, false) else {
                continue;
            };
            if resolved != relative {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&absolute) else {
                continue;
            };
            if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let mut directory = relative.as_str();
            while let Some((parent, _)) = directory.rsplit_once('/') {
                if !seen_dirs.insert(parent.to_owned()) {
                    break;
                }
                directory = parent;
            }
            result.files.push(Candidate {
                source,
                modified: modified_at(&meta),
                size: meta.len(),
                absolute,
                relative,
            });
        }
        result
            .directories
            .extend(seen_dirs.into_iter().map(|dir| (*source, dir)));
    }
    result
        .files
        .sort_by(|a, b| (&a.source.id, &a.relative).cmp(&(&b.source.id, &b.relative)));
    Ok(result)
}

fn walked_paths(source: &LocalSource, limit: usize) -> Vec<String> {
    fn inner(root: &Path, dir: &Path, limit: usize, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if out.len() >= limit {
                return;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                if !skip_dir(&entry.file_name().to_string_lossy()) {
                    inner(root, &path, limit, out);
                }
            } else if let Ok(relative) = path.strip_prefix(root) {
                out.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = Vec::new();
    inner(&source.root, &source.root, limit, &mut out);
    out
}

pub fn file_search(run: &Run, input: &Value) -> ToolResult {
    let sources = select(run, &text_field(input, "source_id"))?;
    let limit = match int_field(input, "limit") {
        n if n <= 0 => 20,
        n => n.min(100),
    } as usize;
    let kind = match text_field(input, "kind").to_lowercase().as_str() {
        "" | "any" => "any",
        "file" => "file",
        "directory" => "directory",
        _ => return Err("source file search kind must be any, file, or directory".into()),
    };
    let walk = walk(
        &sources,
        &string_list(input, "include"),
        &string_list(input, "exclude"),
    )?;
    let mut candidates: Vec<(String, &str, Value)> = Vec::new();
    if kind != "directory" {
        for file in &walk.files {
            candidates.push((
                format!("{}/{}", file.source.id, file.relative),
                "file",
                json!({ "size": file.size, "modified_at": file.modified }),
            ));
        }
    }
    if kind != "file" {
        for (source, directory) in &walk.directories {
            candidates.push((format!("{}/{directory}", source.id), "directory", json!({})));
        }
    }
    let query = text_field(input, "query");
    let ranked: Vec<(usize, i64)> = if query.is_empty() {
        (0..candidates.len().min(limit))
            .map(|index| (index, 0))
            .collect()
    } else {
        let mut ranked: Vec<(usize, i64)> = candidates
            .iter()
            .enumerate()
            .filter_map(|(index, (label, _, _))| {
                fuzzy::score(&query, label).map(|score| (index, score))
            })
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        ranked.truncate(limit);
        ranked
    };
    let mut matches = Vec::new();
    let mut rows = Vec::new();
    for (index, score) in ranked {
        let (label, kind, extra) = &candidates[index];
        let path = format!("source://{label}");
        rows.push(format!("- `{path}` ({kind}, score {score})"));
        let mut item = json!({ "path": path, "kind": kind, "score": score });
        if let (Some(item), Some(extra)) = (item.as_object_mut(), extra.as_object()) {
            item.extend(extra.clone());
        }
        matches.push(item);
    }
    if rows.is_empty() {
        rows.push("- No matching local source paths found".into());
    }
    Ok(ToolOutput {
        summary: format!("Local source path matches:\n{}", rows.join("\n")),
        event_summary: Some(format!(
            "Found {} path match(es) after scanning {} file candidates",
            matches.len(),
            walk.scanned
        )),
        event_output: Some(json!({
            "query_chars": query.chars().count(), "matches": matches.len(),
            "scanned": walk.scanned, "candidate_cap_reached": walk.capped,
        })),
        output: json!({
            "query": query, "matches": matches, "scanned": walk.scanned,
            "candidate_cap_reached": walk.capped,
        }),
        ..ToolOutput::default()
    })
}

pub fn search(run: &Run, input: &Value) -> ToolResult {
    let query = text_field(input, "query");
    if query.is_empty() {
        return Err("missing source search query".into());
    }
    let sources = select(run, &text_field(input, "source_id"))?;
    let mode = match text_field(input, "mode").to_lowercase().as_str() {
        "" | "literal" => "literal",
        "regex" => "regex",
        _ => return Err("source search mode must be literal or regex".into()),
    };
    let case_sensitive = input
        .get("case_sensitive")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| query.chars().any(char::is_uppercase));
    let pattern = if mode == "literal" {
        regex::escape(&query)
    } else {
        query.clone()
    };
    let compiled = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .size_limit(1 << 20)
        .build()
        .map_err(|_| "invalid source search regular expression".to_owned())?;
    let limit = match int_field(input, "limit") {
        n if n <= 0 => 20,
        n => n.min(100),
    } as usize;
    let context = input
        .get("context_lines")
        .and_then(Value::as_i64)
        .unwrap_or(2)
        .clamp(0, 8) as usize;
    let per_file = match int_field(input, "per_file_limit") {
        n if n <= 0 => 3,
        n => n.min(20),
    } as usize;
    let walk = walk(
        &sources,
        &string_list(input, "include"),
        &string_list(input, "exclude"),
    )?;
    let mut matches: Vec<(i64, String, usize, Value)> = Vec::new();
    let mut bytes_scanned = 0_u64;
    let mut budget_reached = false;
    let query_lower = query.to_lowercase();
    for candidate in &walk.files {
        if bytes_scanned + candidate.size > MAX_SEARCH_BYTES {
            budget_reached = true;
            break;
        }
        let Ok(data) = std::fs::read(&candidate.absolute) else {
            continue;
        };
        if data.is_empty() || !is_text(&data) {
            continue;
        }
        bytes_scanned += data.len() as u64;
        let text = String::from_utf8_lossy(&data);
        let lines = split_lines(&text);
        let path = uri(&candidate.source.id, &candidate.relative);
        let path_bonus = if candidate.relative.to_lowercase().contains(&query_lower) {
            500
        } else {
            0
        };
        let mut found = 0;
        'lines: for (index, line) in lines.iter().enumerate() {
            for location in compiled.find_iter(line) {
                if found >= per_file {
                    break 'lines;
                }
                let column = line[..location.start()].chars().count() + 1;
                let end_column = column + location.as_str().chars().count();
                let before: Vec<String> = lines[index.saturating_sub(context)..index]
                    .iter()
                    .map(|l| truncate_chars(l, 400))
                    .collect();
                let after: Vec<String> = lines[index + 1..(index + context + 1).min(lines.len())]
                    .iter()
                    .map(|l| truncate_chars(l, 400))
                    .collect();
                let score = 1000 - (index as i64).min(500) + path_bonus;
                let mut item = json!({
                    "path": path, "line": index + 1, "column": column, "end_column": end_column,
                    "line_text": truncate_chars(line, 600), "score": score,
                });
                if !before.is_empty() {
                    item["context_before"] = json!(before);
                }
                if !after.is_empty() {
                    item["context_after"] = json!(after);
                }
                matches.push((score, path.clone(), index + 1, item));
                found += 1;
            }
        }
    }
    matches.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let total = matches.len();
    matches.truncate(limit);
    let paths: Vec<&str> = matches.iter().map(|m| m.1.as_str()).collect();
    let mut rows: Vec<String> = matches
        .iter()
        .map(|(_, path, line, item)| {
            format!(
                "- `{path}:{line}:{}`: {}",
                item["column"],
                item["line_text"].as_str().unwrap_or_default().trim()
            )
        })
        .collect();
    if rows.is_empty() {
        rows.push("- No matching local source content found".into());
    }
    let items: Vec<&Value> = matches.iter().map(|m| &m.3).collect();
    Ok(ToolOutput {
        summary: format!("Local source content matches:\n{}", rows.join("\n")),
        event_summary: Some(format!(
            "Found {total} content match(es) across {} candidates",
            walk.scanned
        )),
        event_output: Some(json!({
            "query_chars": query.chars().count(), "mode": mode, "case_sensitive": case_sensitive,
            "paths": paths, "total_matches": total, "scanned": walk.scanned,
            "bytes_scanned": bytes_scanned, "candidate_cap_reached": walk.capped,
            "search_budget_reached": budget_reached,
        })),
        output: json!({
            "query": query, "mode": mode, "case_sensitive": case_sensitive, "paths": paths,
            "matches": items, "total_matches": total, "scanned": walk.scanned,
            "bytes_scanned": bytes_scanned, "candidate_cap_reached": walk.capped,
            "search_budget_reached": budget_reached,
        }),
        ..ToolOutput::default()
    })
}

// --- Git -----------------------------------------------------------------

/// Runs a command with a deadline, keeping at most `max_bytes` of stdout.
fn run_capped(
    mut command: Command,
    timeout: Duration,
    max_bytes: usize,
) -> Result<(Vec<u8>, bool), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "failed to start git".to_owned())?;
    let mut stdout = child.stdout.take().ok_or("failed to start git")?;
    let reader = std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut capped = false;
        let mut buf = [0_u8; 64 * 1024];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = max_bytes.saturating_sub(kept.len());
                    if n > room {
                        capped = true;
                    }
                    kept.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
        (kept, capped)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => break None,
        }
    };
    let (kept, capped) = reader.join().unwrap_or_default();
    match status {
        Some(status) if status.success() => Ok((kept, capped)),
        _ => Err("read-only Git command failed".into()),
    }
}

/// A `git` invocation that cannot run pagers, external diff drivers,
/// fsmonitor hooks, or user/system config.
fn git(source: &LocalSource, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .args([
            "--no-pager",
            "-c",
            "core.pager=cat",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "diff.external=",
            "-C",
        ])
        .arg(&source.root)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("LC_ALL", "C");
    command
}

fn detect_git(root: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(root.join(".git")) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return false;
    }
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--show-toplevel"]);
    let Ok((out, _)) = run_capped(command, Duration::from_secs(2), 4096) else {
        return false;
    };
    let top = String::from_utf8_lossy(&out).trim().to_owned();
    Path::new(&top).canonicalize().is_ok_and(|top| top == root)
}

fn git_paths(source: &LocalSource, limit: usize) -> Result<(Vec<String>, bool), String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(&source.root).args([
        "ls-files",
        "-co",
        "--exclude-standard",
        "-z",
        "--",
        ".",
    ]);
    let (mut data, capped) = run_capped(command, Duration::from_secs(8), MAX_PATH_LIST_BYTES)
        .map_err(|_| "failed to enumerate local source files".to_owned())?;
    if capped {
        let keep = data.iter().rposition(|b| *b == 0).map_or(0, |i| i + 1);
        data.truncate(keep);
    }
    let paths: Vec<String> = data
        .split(|b| *b == 0)
        .map(|part| String::from_utf8_lossy(part).trim().to_owned())
        .filter(|part| !part.is_empty())
        .take(limit)
        .collect();
    let capped = capped || paths.len() >= limit;
    Ok((paths, capped))
}

fn is_ignored(source: &LocalSource, relative: &str) -> bool {
    if !source.git || relative.trim().is_empty() {
        return false;
    }
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(&source.root)
        .args(["check-ignore", "-q", "--", relative]);
    run_capped(command, Duration::from_secs(2), 0).is_ok()
}

fn git_source<'a>(run: &'a Run, id: &str) -> Result<&'a LocalSource, String> {
    let source = find(run, id)?;
    if !source.git {
        return Err("attached local analysis source is not a supported Git repository".into());
    }
    Ok(source)
}

fn valid_revision(value: &str) -> Result<String, String> {
    let value = value.trim();
    let ok = value.len() <= 160
        && value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/@{}^~+-".contains(c))
        && !value.contains("..");
    if ok {
        Ok(value.to_owned())
    } else {
        Err("invalid Git revision".into())
    }
}

fn git_path(value: &str) -> Result<String, String> {
    let relative = clean_relative(value, false)?;
    if relative.starts_with('-') {
        return Err("invalid local source Git path".into());
    }
    if is_sensitive(&relative) {
        return Err("sensitive credential files are not available to local analysis tools".into());
    }
    Ok(relative)
}

fn run_git_text(source: &LocalSource, args: &[&str]) -> Result<(String, bool), String> {
    let (data, truncated) = run_capped(
        git(source, args),
        Duration::from_secs(12),
        MAX_GIT_OUTPUT_BYTES,
    )?;
    let mut text = String::from_utf8_lossy(&data).trim().to_owned();
    if truncated {
        text.push_str("\n\n[output truncated by Kition]");
    }
    Ok((text, truncated))
}

fn non_empty_lines(text: &str) -> usize {
    text.lines().filter(|line| !line.trim().is_empty()).count()
}

pub fn git_status(run: &Run, input: &Value) -> ToolResult {
    let source = git_source(run, &text_field(input, "source_id"))?;
    let (raw, truncated) = run_capped(
        git(
            source,
            &[
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=normal",
                "--",
                ".",
            ],
        ),
        Duration::from_secs(12),
        MAX_GIT_OUTPUT_BYTES,
    )?;
    let raw = String::from_utf8_lossy(&raw);
    let parts: Vec<&str> = raw.split('\0').collect();
    let mut rows = Vec::new();
    let mut index = 0;
    while index < parts.len() {
        let entry = parts[index];
        index += 1;
        if entry.len() < 4 {
            continue;
        }
        let status = &entry[..2];
        let mut path = entry[3..].trim().to_owned();
        if (status.contains('R') || status.contains('C'))
            && let Some(next) = parts.get(index)
        {
            path = next.trim().to_owned();
            index += 1;
        }
        if !path.is_empty() && !is_sensitive(&path) {
            rows.push(format!("{status} {}", uri(&source.id, &path)));
        }
    }
    let count = rows.len();
    let body = if rows.is_empty() {
        "Working tree is clean.".to_owned()
    } else {
        rows.join("\n")
    };
    let output = json!({ "source_id": source.id, "changed_paths": count, "truncated": truncated });
    Ok(ToolOutput {
        summary: format!(
            "Git status for `{}`{}:\n\n{body}",
            uri(&source.id, ""),
            truncated_suffix(truncated)
        ),
        event_summary: Some(format!(
            "Inspected Git status for {} ({count} changed path(s){})",
            uri(&source.id, ""),
            truncated_suffix(truncated)
        )),
        event_output: Some(output.clone()),
        output,
        ..ToolOutput::default()
    })
}

pub fn git_log(run: &Run, input: &Value) -> ToolResult {
    let source = git_source(run, &text_field(input, "source_id"))?;
    let limit = match int_field(input, "limit") {
        n if n <= 0 => 12,
        n => n.min(50),
    }
    .to_string();
    let mut args = vec![
        "log",
        "--date=iso-strict",
        "--format=%H%x09%ad%x09%an%x09%s",
        "-n",
        &limit,
    ];
    let mut display = uri(&source.id, "");
    let path_text = text_field(input, "path");
    let relative;
    if !path_text.is_empty() {
        relative = git_path(&path_text)?;
        args.extend(["--", relative.as_str()]);
        display = uri(&source.id, &relative);
    }
    let (mut text, truncated) = run_git_text(source, &args)?;
    let commits = non_empty_lines(&text);
    if text.is_empty() {
        text = "No commits found for this scope.".into();
    }
    let output = json!({ "source_id": source.id, "path": display, "commits": commits, "truncated": truncated });
    Ok(ToolOutput {
        summary: format!(
            "Git history for `{display}`{}:\n\n{text}",
            truncated_suffix(truncated)
        ),
        event_summary: Some(format!(
            "Read {commits} Git commit(s) for {display}{}",
            truncated_suffix(truncated)
        )),
        event_output: Some(output.clone()),
        output,
        ..ToolOutput::default()
    })
}

pub fn git_show(run: &Run, input: &Value) -> ToolResult {
    let source = git_source(run, &text_field(input, "source_id"))?;
    let revision = valid_revision(&text_field(input, "revision"))?;
    let mode = match text_field(input, "mode").to_lowercase().as_str() {
        "" | "commit" => "commit",
        "file" => "file",
        _ => return Err("source_git_show mode must be commit or file".into()),
    };
    let path_text = text_field(input, "path");
    let mut display = revision.clone();
    let args: Vec<String> = if mode == "file" {
        let relative = git_path(&path_text)?;
        display = format!("{revision} at {}", uri(&source.id, &relative));
        vec![
            "show".into(),
            "--no-textconv".into(),
            format!("{revision}:{relative}"),
        ]
    } else if path_text.is_empty() {
        vec![
            "show".into(),
            "--no-patch".into(),
            "--format=fuller".into(),
            revision.clone(),
        ]
    } else {
        let relative = git_path(&path_text)?;
        display = format!("{display} for {}", uri(&source.id, &relative));
        [
            "show",
            "--no-ext-diff",
            "--no-textconv",
            "--format=fuller",
            "--stat",
            "--unified=3",
            &revision,
            "--",
            &relative,
        ]
        .map(String::from)
        .to_vec()
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let (text, truncated) = run_git_text(source, &args)?;
    let output = json!({ "source_id": source.id, "revision": revision, "mode": mode, "truncated": truncated });
    Ok(ToolOutput {
        summary: format!(
            "Git {mode} output for `{display}`{}:\n\n{text}",
            truncated_suffix(truncated)
        ),
        event_summary: Some(format!(
            "Read Git {mode} output for revision {revision}{}",
            truncated_suffix(truncated)
        )),
        event_output: Some(output.clone()),
        output,
        ..ToolOutput::default()
    })
}

pub fn git_blame(run: &Run, input: &Value) -> ToolResult {
    let source = git_source(run, &text_field(input, "source_id"))?;
    let relative = git_path(&text_field(input, "path"))?;
    resolve(source, &relative, false)
        .map_err(|_| "local source Git file is unavailable".to_owned())?;
    let start = int_field(input, "start_line").max(1);
    let end = match int_field(input, "end_line") {
        n if n <= 0 => start + 199,
        n => n,
    };
    if end < start || end - start + 1 > 500 {
        return Err("source_git_blame must request between 1 and 500 ordered lines".into());
    }
    let revision_text = text_field(input, "revision");
    let revision = if revision_text.is_empty() {
        "HEAD".to_owned()
    } else {
        valid_revision(&revision_text)?
    };
    let range = format!("{start},{end}");
    let (text, truncated) = run_git_text(
        source,
        &[
            "blame",
            "--date=iso-strict",
            "-L",
            &range,
            &revision,
            "--",
            &relative,
        ],
    )?;
    let uri = uri(&source.id, &relative);
    let output = json!({
        "source_id": source.id, "path": uri, "revision": revision,
        "start_line": start, "end_line": end, "truncated": truncated,
    });
    Ok(ToolOutput {
        summary: format!(
            "Git blame for `{uri}` lines {start}-{end} at {revision}{}:\n\n{text}",
            truncated_suffix(truncated)
        ),
        event_summary: Some(format!(
            "Read Git blame for {uri} lines {start}-{end}{}",
            truncated_suffix(truncated)
        )),
        event_output: Some(output.clone()),
        output,
        ..ToolOutput::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(dir: &Path) -> LocalSource {
        LocalSource {
            id: "repo".into(),
            label: "Repo".into(),
            root: dir.canonicalize().unwrap_or_else(|err| panic!("{err}")),
            git: false,
        }
    }

    #[test]
    fn validates_inputs() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let input = |id: &str, access: &str| LocalSourceInput {
            id: id.into(),
            label: "L".into(),
            root_path: dir.path().to_string_lossy().into_owned(),
            access: access.into(),
        };
        assert_eq!(normalize(&[input("ok", "read")]).map(|s| s.len()), Ok(1));
        assert!(normalize(&[input("Bad id", "read")]).is_err());
        assert!(normalize(&[input("ok", "write")]).is_err());
        assert_eq!(
            normalize(&[input("a", "read"), input("b", "read")]).map(|s| s.len()),
            Ok(1)
        );
    }

    #[test]
    fn resolves_inside_the_folder_only() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        std::fs::create_dir(dir.path().join("src")).unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(dir.path().join("src/a.rs"), "fn a() {}\n")
            .unwrap_or_else(|err| panic!("{err}"));
        let source = source(dir.path());
        assert_eq!(
            resolve(&source, "src/./a.rs", false).map(|r| r.1),
            Ok("src/a.rs".into())
        );
        assert!(resolve(&source, "../x", false).is_err());
        assert!(resolve(&source, "", false).is_err());
        assert!(is_sensitive("config/.env.local"));
        assert!(is_sensitive("certs/server.pem"));
        assert!(!is_sensitive("src/env.rs"));
    }

    #[test]
    fn walks_with_globs() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        for path in ["src/a.rs", "src/b.ts", "node_modules/x.rs", ".env"] {
            let full = dir.path().join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).unwrap_or_else(|err| panic!("{err}"));
            }
            std::fs::write(full, "x").unwrap_or_else(|err| panic!("{err}"));
        }
        let source = source(dir.path());
        let result =
            walk(&[&source], &["**/*.rs".into()], &[]).unwrap_or_else(|err| panic!("{err}"));
        let files: Vec<&str> = result.files.iter().map(|f| f.relative.as_str()).collect();
        assert_eq!(files, ["src/a.rs"]);
        assert_eq!(result.directories.len(), 1);
    }

    #[test]
    fn validates_revisions() {
        assert!(valid_revision("HEAD~2").is_ok());
        assert!(valid_revision("--output=x").is_err());
        assert!(valid_revision("a..b").is_err());
    }
}
