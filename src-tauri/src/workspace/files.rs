//! Workspace file operations behind the document tree: listing, reading,
//! saving, creating, moving, deleting, and importing files.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Value, json};

use super::formats;
use super::safety::{assert_safe, invalid, join_relative, normalize_relative, write_atomically};
use crate::request::Request;

pub const WORKSPACE_CHANGED: &str = "DESIGN_WORKSPACE_CHANGED";
const MAX_IMPORT_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

/// A path resolved against the workspace root.
#[derive(Clone, Debug)]
pub struct Resolved {
    pub relative: String,
    pub absolute: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
pub struct DocumentResponse {
    pub path: String,
    pub name: String,
    pub content: String,
    pub format: &'static str,
    pub updated_at: String,
    pub size: u64,
    pub mtime_ms: f64,
}

pub fn resolve(root: &Path, raw: &str, allow_root: bool) -> io::Result<Resolved> {
    let relative = normalize_relative(raw, allow_root)?;
    Ok(Resolved {
        absolute: join_relative(root, &relative),
        relative,
    })
}

pub fn resolve_safe(
    root: &Path,
    raw: &str,
    allow_root: bool,
    allow_missing: bool,
) -> io::Result<Resolved> {
    let resolved = resolve(root, raw, allow_root)?;
    assert_safe(root, &resolved.absolute, allow_missing)?;
    Ok(resolved)
}

/// Rejects writes meant for a workspace the user has since switched away from.
pub fn check_expected_root(root: &Path, request: &Request) -> io::Result<()> {
    match request.string("expected_root") {
        Some(expected) if Path::new(&expected) != root => Err(invalid(WORKSPACE_CHANGED)),
        _ => Ok(()),
    }
}

/// Makes the workspace folder if it is missing.
pub fn ensure_initialized(root: &Path) -> io::Result<()> {
    fs::create_dir_all(root)
}

pub fn iso_time(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn mtime_ms(metadata: &fs::Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or_default()
}

fn updated_at(metadata: &fs::Metadata) -> String {
    metadata.modified().map(iso_time).unwrap_or_default()
}

/// Compares names the way the tree has always been ordered: case-insensitive
/// first, then by the exact name.
fn compare_names(left: &str, right: &str) -> std::cmp::Ordering {
    left.to_lowercase()
        .cmp(&right.to_lowercase())
        .then_with(|| right.cmp(left))
}

pub fn read_tree(root: &Path, parent: &str) -> io::Result<Vec<Value>> {
    let resolved = resolve_safe(root, parent, true, false)?;
    let mut folders = Vec::new();
    let mut files = Vec::new();
    for entry in fs::read_dir(&resolved.absolute)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let relative = if resolved.relative.is_empty() {
            name.clone()
        } else {
            format!("{}/{name}", resolved.relative)
        };
        let metadata = fs::metadata(entry.path())?;
        if file_type.is_dir() {
            let children = read_tree(root, &relative)?;
            folders.push((
                name.clone(),
                json!({
                    "type": "folder",
                    "path": relative,
                    "name": name,
                    "updated_at": updated_at(&metadata),
                    "children": children,
                }),
            ));
        } else if file_type.is_file() && formats::is_supported(&name) {
            files.push((
                name.clone(),
                json!({
                    "type": "file",
                    "path": relative,
                    "name": name,
                    "format": formats::infer_format(&relative),
                    "size": metadata.len(),
                    "updated_at": updated_at(&metadata),
                }),
            ));
        }
    }
    folders.sort_by(|left, right| compare_names(&left.0, &right.0));
    files.sort_by(|left, right| compare_names(&left.0, &right.0));
    Ok(folders
        .into_iter()
        .chain(files)
        .map(|item| item.1)
        .collect())
}

pub fn list(root: &Path) -> io::Result<Value> {
    ensure_initialized(root)?;
    Ok(json!({
        "root_path": root.to_string_lossy(),
        "items": read_tree(root, "")?,
    }))
}

pub fn list_with(root: &Path, key: &str, value: &str) -> io::Result<Value> {
    let mut response = list(root)?;
    if let Some(object) = response.as_object_mut() {
        object.insert(key.to_owned(), Value::String(value.to_owned()));
    }
    Ok(response)
}

fn file_name(relative: &str) -> String {
    relative.rsplit('/').next().unwrap_or_default().to_owned()
}

pub fn document_response(relative: &str, absolute: &Path) -> io::Result<DocumentResponse> {
    let metadata = fs::metadata(absolute)?;
    let content = if formats::is_text(relative) {
        fs::read_to_string(absolute)?
    } else {
        String::new()
    };
    Ok(DocumentResponse {
        path: relative.to_owned(),
        name: file_name(relative),
        content,
        format: formats::infer_format(relative),
        updated_at: updated_at(&metadata),
        size: metadata.len(),
        mtime_ms: mtime_ms(&metadata),
    })
}

pub fn read_document(root: &Path, request: &Request) -> io::Result<DocumentResponse> {
    ensure_initialized(root)?;
    check_expected_root(root, request)?;
    let resolved = resolve_safe(root, &request.str("path"), false, false)?;
    if !formats::is_text(&resolved.relative) {
        return Err(invalid("this workspace file is not text-editable"));
    }
    document_response(&resolved.relative, &resolved.absolute)
}

pub fn stat_document(root: &Path, request: &Request) -> io::Result<Value> {
    ensure_initialized(root)?;
    let stat = resolve_safe(root, &request.str("path"), false, false)
        .and_then(|resolved| fs::metadata(resolved.absolute));
    match stat {
        Ok(metadata) => Ok(json!({ "mtime_ms": mtime_ms(&metadata), "size": metadata.len() })),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(error),
    }
}

/// Resolves a document the renderer wants to save.
pub fn writable_document(root: &Path, request: &Request) -> io::Result<Resolved> {
    ensure_initialized(root)?;
    check_expected_root(root, request)?;
    let resolved = resolve_safe(root, &request.str("path"), false, true)?;
    if !formats::is_editable(&resolved.relative) {
        return Err(invalid(
            "only editable workspace documents can be saved as text",
        ));
    }
    Ok(resolved)
}

pub fn write_document(resolved: &Resolved, content: &str) -> io::Result<DocumentResponse> {
    write_atomically(&resolved.absolute, content.as_bytes())?;
    document_response(&resolved.relative, &resolved.absolute)
}

fn sanitize_base(value: &str, fallback: &str) -> String {
    let replaced: String = value
        .trim()
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                || (ch as u32) < 0x20
            {
                '-'
            } else {
                ch
            }
        })
        .collect();
    let collapsed = collapse_whitespace(&replaced);
    let without_dots = collapsed.trim_start_matches('.');
    let limited: String = without_dots.chars().take(80).collect();
    let trimmed = limited.trim();
    if trimmed.is_empty() {
        fallback.to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn collapse_whitespace(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut in_space = false;
    for ch in value.chars() {
        if ch.is_whitespace() {
            if !in_space {
                output.push(' ');
            }
            in_space = true;
        } else {
            output.push(ch);
            in_space = false;
        }
    }
    output
}

/// A Markdown document's file name for `title` (other files are made by their kits).
pub fn sanitize_document_filename(title: &str) -> String {
    let fallback = "Untitled note";
    let title = if title.is_empty() { fallback } else { title };
    let base = sanitize_base(title, fallback);
    if base.to_lowercase().ends_with(".md") {
        return format!("{}.md", &base[..base.len() - 3]);
    }
    format!("{base}.md")
}

/// Node's `path.extname`: the last dot in the final segment, ignoring a
/// leading dot.
pub fn extname(name: &str) -> &str {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    match base.rfind('.') {
        Some(index) if index > 0 => &base[index..],
        _ => "",
    }
}

/// Node's `path.basename(name, ext)`.
pub fn basename_without<'a>(name: &'a str, extension: &str) -> &'a str {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    if !extension.is_empty() && base != extension && base.ends_with(extension) {
        &base[..base.len() - extension.len()]
    } else {
        base
    }
}

fn exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// A filename that collides with neither a file nor the document's
/// same-named child folder.
pub fn unique_document_target(folder: &Path, requested: &str) -> io::Result<String> {
    let extension = match extname(requested) {
        "" => ".md",
        other => other,
    };
    let stem = basename_without(requested, extension).to_owned();
    let mut candidate = requested.to_owned();
    let mut index = 2;
    loop {
        let candidate_stem = basename_without(&candidate, extension).to_owned();
        if exists(&folder.join(&candidate))? || exists(&folder.join(&candidate_stem))? {
            candidate = format!("{stem} {index}{extension}");
            index += 1;
            continue;
        }
        return Ok(candidate);
    }
}

pub fn unique_folder_target(parent: &Path, requested: &str) -> io::Result<String> {
    let base = sanitize_base(requested, "Untitled");
    let mut candidate = base.clone();
    let mut index = 2;
    while exists(&parent.join(&candidate))? {
        candidate = format!("{base} {index}");
        index += 1;
    }
    Ok(candidate)
}

fn unique_imported_target(folder: &Path, requested: &str) -> io::Result<String> {
    let extension = extname(requested).to_owned();
    let stem = basename_without(requested, &extension).to_owned();
    let mut candidate = requested.to_owned();
    let mut index = 2;
    while exists(&folder.join(&candidate))? {
        candidate = format!("{stem} {index}{extension}");
        index += 1;
    }
    Ok(candidate)
}

fn join_relative_path(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_owned()
    } else {
        format!("{folder}/{name}")
    }
}

fn parent_relative(relative: &str) -> String {
    match relative.rfind('/') {
        Some(index) => relative[..index].to_owned(),
        None => String::new(),
    }
}

pub fn create_document(root: &Path, request: &Request) -> io::Result<DocumentResponse> {
    ensure_initialized(root)?;
    let folder = normalize_relative(&request.str("folder"), true)?;
    let folder_resolved = resolve_safe(root, &folder, true, true)?;
    fs::create_dir_all(&folder_resolved.absolute)?;
    assert_safe(root, &folder_resolved.absolute, false)?;

    let filename = unique_document_target(
        &folder_resolved.absolute,
        &sanitize_document_filename(&request.str("title")),
    )?;
    let relative = join_relative_path(&folder, &filename);
    let absolute = folder_resolved.absolute.join(&filename);
    assert_safe(root, &absolute, true)?;
    write_atomically(&absolute, b"")?;
    document_response(&relative, &absolute)
}

pub fn create_folder(root: &Path, request: &Request) -> io::Result<Value> {
    ensure_initialized(root)?;
    let parent = normalize_relative(&request.str("parent_folder"), true)?;
    let parent_resolved = resolve_safe(root, &parent, true, false)?;
    fs::create_dir_all(&parent_resolved.absolute)?;
    let requested = request.trimmed("name");
    let requested = if requested.is_empty() {
        "Untitled folder".to_owned()
    } else {
        requested
    };
    let name = unique_folder_target(&parent_resolved.absolute, &requested)?;
    let relative = join_relative_path(&parent, &name);
    let absolute = parent_resolved.absolute.join(&name);
    assert_safe(root, &absolute, true)?;
    fs::create_dir_all(&absolute)?;
    assert_safe(root, &absolute, false)?;
    list_with(root, "created_path", &relative)
}

pub fn move_document(root: &Path, request: &Request) -> io::Result<DocumentResponse> {
    ensure_initialized(root)?;
    let source = resolve_safe(root, &request.str("path"), false, false)?;
    let metadata = fs::metadata(&source.absolute)?;
    if !metadata.is_file() || !formats::is_editable(&source.relative) {
        return Err(invalid("only editable workspace documents can be moved"));
    }
    let source_parent = parent_relative(&source.relative);
    let target_folder = if request.has("target_folder") {
        normalize_relative(&request.str("target_folder"), true)?
    } else {
        source_parent.clone()
    };
    let requested = request.trimmed("target_name");
    let source_name = file_name(&source.relative);
    if target_folder == source_parent && (requested.is_empty() || requested == source_name) {
        return document_response(&source.relative, &source.absolute);
    }

    let target_folder_resolved = resolve_safe(root, &target_folder, true, false)?;
    fs::create_dir_all(&target_folder_resolved.absolute)?;
    let filename = unique_document_target(
        &target_folder_resolved.absolute,
        if requested.is_empty() {
            &source_name
        } else {
            &requested
        },
    )?;
    let target_relative = join_relative_path(&target_folder, &filename);
    let target_absolute = target_folder_resolved.absolute.join(&filename);

    let source_stem = basename_without(&source.relative, extname(&source.relative)).to_owned();
    let target_stem = basename_without(&filename, extname(&filename)).to_owned();
    let source_child = resolve_safe(
        root,
        &join_relative_path(&source_parent, &source_stem),
        true,
        true,
    )?;
    let target_child = resolve_safe(
        root,
        &join_relative_path(&target_folder, &target_stem),
        true,
        true,
    )?;
    assert_safe(root, &target_absolute, true)?;
    fs::rename(&source.absolute, &target_absolute)?;

    if source_child.absolute != target_child.absolute {
        match fs::metadata(&source_child.absolute) {
            Ok(child) if child.is_dir() => {
                fs::rename(&source_child.absolute, &target_child.absolute)?
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    document_response(&target_relative, &target_absolute)
}

pub fn move_folder(root: &Path, request: &Request) -> io::Result<Value> {
    ensure_initialized(root)?;
    let source = resolve_safe(root, &request.str("path"), true, false)?;
    if source.relative.is_empty() {
        return Err(invalid("root folder cannot be moved"));
    }
    if !fs::metadata(&source.absolute)?.is_dir() {
        return Err(invalid("only workspace folders can be moved"));
    }
    let source_parent = parent_relative(&source.relative);
    let source_name = file_name(&source.relative);
    let target_folder = if request.has("target_folder") {
        normalize_relative(&request.str("target_folder"), true)?
    } else {
        source_parent.clone()
    };
    let requested = match request.trimmed("target_name") {
        name if name.is_empty() => source_name.clone(),
        name => name,
    };
    let target_relative = join_relative_path(&target_folder, &requested);
    if target_relative == source.relative
        || target_relative.starts_with(&format!("{}/", source.relative))
    {
        return Err(invalid("folder cannot be moved into itself"));
    }
    let target_folder_resolved = resolve_safe(root, &target_folder, true, false)?;
    fs::create_dir_all(&target_folder_resolved.absolute)?;
    let final_name = if target_folder == source_parent && requested == source_name {
        source_name
    } else {
        unique_folder_target(&target_folder_resolved.absolute, &requested)?
    };
    let final_relative = join_relative_path(&target_folder, &final_name);
    let final_absolute = target_folder_resolved.absolute.join(&final_name);
    assert_safe(root, &final_absolute, true)?;
    if final_relative == source.relative {
        return list_with(root, "moved_path", &source.relative);
    }
    fs::rename(&source.absolute, &final_absolute)?;
    list_with(root, "moved_path", &final_relative)
}

fn trash(path: &Path) -> io::Result<()> {
    trash::delete(path).map_err(|error| io::Error::other(error.to_string()))
}

pub fn delete_document(root: &Path, request: &Request) -> io::Result<Value> {
    ensure_initialized(root)?;
    let source = resolve_safe(root, &request.str("path"), false, false)?;
    let metadata = fs::metadata(&source.absolute)?;
    if !metadata.is_file() || !formats::is_supported(&source.relative) {
        return Err(invalid("only workspace files can be deleted"));
    }
    let parent = parent_relative(&source.relative);
    let stem = basename_without(&source.relative, extname(&source.relative)).to_owned();
    let child = resolve_safe(root, &join_relative_path(&parent, &stem), true, true)?;
    trash(&source.absolute)?;
    match fs::symlink_metadata(&child.absolute) {
        Ok(metadata) if metadata.is_dir() => trash(&child.absolute)?,
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    list(root)
}

pub fn delete_folder(root: &Path, request: &Request) -> io::Result<Value> {
    ensure_initialized(root)?;
    let source = resolve_safe(root, &request.str("path"), false, false)?;
    if source.relative.is_empty() {
        return Err(invalid("the workspace root cannot be deleted"));
    }
    if !fs::metadata(&source.absolute)?.is_dir() {
        return Err(invalid("only folders can be deleted here"));
    }
    trash(&source.absolute)?;
    list(root)
}

/// JavaScript's `encodeURIComponent`.
pub fn encode_uri_component(value: &str) -> String {
    const SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(value, SET).to_string()
}

fn sanitize_imported_filename(filename: &str) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let fallback = format!("imported-file-{now}");
    let raw = filename.trim();
    if raw.is_empty() {
        return fallback;
    }
    let extension = extname(raw);
    let stem: String = basename_without(raw, extension)
        .chars()
        .map(|ch| {
            if matches!(
                ch,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0'
            ) {
                '-'
            } else {
                ch
            }
        })
        .collect();
    let stem = collapse_whitespace(&stem);
    let stem: String = stem.trim_start_matches('.').chars().take(80).collect();
    let stem = match stem.trim() {
        "" => fallback,
        other => other.to_owned(),
    };
    format!("{stem}{extension}")
}

pub fn import_file(root: &Path, request: &Request) -> io::Result<Value> {
    ensure_initialized(root)?;
    check_expected_root(root, request)?;
    let folder = request.trimmed("folder");
    let requested = sanitize_imported_filename(&request.str("filename"));
    if !formats::is_supported(&requested) {
        return Err(invalid("unsupported workspace file type"));
    }
    let folder_resolved = if folder.is_empty() {
        resolve_safe(root, "", true, false)?
    } else {
        resolve_safe(root, &folder, true, true)?
    };
    fs::create_dir_all(&folder_resolved.absolute)?;
    assert_safe(root, &folder_resolved.absolute, false)?;
    let filename = unique_imported_target(&folder_resolved.absolute, &requested)?;
    let target = folder_resolved.absolute.join(&filename);
    assert_safe(root, &target, true)?;

    if let Some(source) = request.string("source_path") {
        let metadata = fs::metadata(&source)?;
        if !metadata.is_file() {
            return Err(invalid("source is not a file"));
        }
        if metadata.len() > MAX_IMPORT_FILE_BYTES {
            return Err(invalid("file exceeds 50 MB import limit"));
        }
        write_atomically(&target, &fs::read(&source)?)?;
    } else if let Some(content) = request.string("base64_content") {
        let bytes = BASE64
            .decode(content.trim())
            .map_err(|error| invalid(format!("invalid base64 content: {error}")))?;
        if bytes.len() as u64 > MAX_IMPORT_FILE_BYTES {
            return Err(invalid("file exceeds 50 MB import limit"));
        }
        write_atomically(&target, &bytes)?;
    } else {
        return Err(invalid("missing source_path or base64_content"));
    }
    list_with(
        root,
        "imported_path",
        &join_relative_path(&folder, &filename),
    )
}

/// Reads an image for the design canvas, which needs the bytes rather than
/// a URL.
pub fn read_image(root: &Path, relative: &str) -> io::Result<Value> {
    let invalid_path = relative.is_empty()
        || relative.starts_with('/')
        || relative
            .chars()
            .any(|ch| ch == ':' || ch == '\\' || (ch as u32) < 0x20)
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == ".." || part == ".");
    if invalid_path {
        return Err(invalid("Invalid workspace image path"));
    }
    let mime = match extname(relative).to_ascii_lowercase().as_str() {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        _ => return Err(invalid("Unsupported image format")),
    };
    let absolute = assert_safe(root, &join_relative(root, relative), false)?;
    let metadata = fs::metadata(&absolute)?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES {
        return Err(invalid("Image exceeds 32 MB limit"));
    }
    let bytes = fs::read(&absolute)?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(invalid("Image exceeds 32 MB limit"));
    }
    Ok(json!({ "mime_type": mime, "base64_content": BASE64.encode(bytes) }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request(value: Value) -> Request {
        Request::new(Some(value))
    }

    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = fs::canonicalize(dir.path()).unwrap_or_else(|err| panic!("{err}"));
        (dir, root)
    }

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_document_filename(""), "Untitled note.md");
        assert_eq!(sanitize_document_filename("a/b: c"), "a-b- c.md");
        assert_eq!(sanitize_document_filename("Plan.MD"), "Plan.md");
        assert_eq!(sanitize_document_filename("...hidden"), "hidden.md");
        assert_eq!(
            sanitize_imported_filename("re|port  v2.pdf"),
            "re-port v2.pdf"
        );
        assert_eq!(extname("a.b/c"), "");
        assert_eq!(extname(".md"), "");
        assert_eq!(basename_without("dir/a.md", ".md"), "a");
    }

    #[test]
    fn creates_unique_documents_and_lists_the_tree() {
        let (_dir, root) = workspace();
        let first = create_document(&root, &request(json!({ "title": "Plan" })))
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(first.path, "Plan.md");
        fs::create_dir_all(root.join("Plan 2")).unwrap_or_else(|err| panic!("{err}"));
        let second = create_document(&root, &request(json!({ "title": "Plan" })))
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(second.path, "Plan 3.md");
        let nested = create_document(
            &root,
            &request(json!({ "title": "Sales", "folder": "data" })),
        )
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(nested.path, "data/Sales.md");

        let listing = list(&root).unwrap_or_else(|err| panic!("{err}"));
        let items = listing["items"].as_array().cloned().unwrap_or_default();
        let names: Vec<_> = items.iter().map(|item| item["name"].clone()).collect();
        assert_eq!(
            names,
            vec![
                json!("data"),
                json!("Plan 2"),
                json!("Plan 3.md"),
                json!("Plan.md")
            ]
        );
    }

    #[test]
    fn moves_documents_with_their_child_folder() {
        let (_dir, root) = workspace();
        fs::write(root.join("Doc.md"), "body").unwrap_or_else(|err| panic!("{err}"));
        fs::create_dir_all(root.join("Doc")).unwrap_or_else(|err| panic!("{err}"));
        fs::write(root.join("Doc/child.md"), "child").unwrap_or_else(|err| panic!("{err}"));
        fs::create_dir_all(root.join("archive")).unwrap_or_else(|err| panic!("{err}"));
        let moved = move_document(
            &root,
            &request(json!({ "path": "Doc.md", "target_folder": "archive", "target_name": "Renamed.md" })),
        )
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(moved.path, "archive/Renamed.md");
        assert_eq!(moved.content, "body");
        assert!(root.join("archive/Renamed/child.md").is_file());
        assert!(!root.join("Doc").exists());
    }

    #[test]
    fn moves_folders_but_not_into_themselves() {
        let (_dir, root) = workspace();
        fs::create_dir_all(root.join("a/b")).unwrap_or_else(|err| panic!("{err}"));
        let error = move_folder(
            &root,
            &request(json!({ "path": "a", "target_folder": "a/b" })),
        )
        .err()
        .map(|err| err.to_string());
        assert_eq!(error.as_deref(), Some("folder cannot be moved into itself"));
        let moved = move_folder(
            &root,
            &request(json!({ "path": "a/b", "target_folder": "" })),
        )
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(moved["moved_path"], json!("b"));
    }

    #[test]
    fn checks_the_expected_root_and_reads_documents() {
        let (_dir, root) = workspace();
        fs::write(root.join("a.md"), "hello").unwrap_or_else(|err| panic!("{err}"));
        let document = read_document(&root, &request(json!({ "path": "a.md" })))
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(document.content, "hello");
        let error = read_document(
            &root,
            &request(json!({ "path": "a.md", "expected_root": "/elsewhere" })),
        )
        .err()
        .map(|err| err.to_string());
        assert_eq!(error.as_deref(), Some(WORKSPACE_CHANGED));
        assert_eq!(
            stat_document(&root, &request(json!({ "path": "missing.md" }))).ok(),
            Some(Value::Null)
        );
    }

    #[test]
    fn imports_files() {
        let (_dir, root) = workspace();
        let imported = import_file(
            &root,
            &request(json!({ "filename": "notes.txt", "base64_content": "aGk=", "folder": "in" })),
        )
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(imported["imported_path"], json!("in/notes.txt"));
        let again = import_file(
            &root,
            &request(json!({ "filename": "notes.txt", "base64_content": "aGk=", "folder": "in" })),
        )
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(again["imported_path"], json!("in/notes 2.txt"));
        assert!(
            import_file(
                &root,
                &request(json!({ "filename": "x.exe", "base64_content": "aGk=" }))
            )
            .is_err()
        );
    }

    #[test]
    fn reads_images_safely() {
        let (_dir, root) = workspace();
        fs::write(root.join("a.png"), b"png").unwrap_or_else(|err| panic!("{err}"));
        let image = read_image(&root, "a.png").unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(image["mime_type"], json!("image/png"));
        assert!(read_image(&root, "../a.png").is_err());
        assert!(read_image(&root, "a.bmp").is_err());
    }
}
