//! Files inside the document workspace. Every path the model supplies is
//! relative, normalized, and checked to stay inside the workspace, also
//! through symlinks.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

pub type Result<T> = std::result::Result<T, String>;

const SEARCHABLE_EXTENSIONS: &[&str] =
    &["md", "markdown", "txt", "csv", "tsv", "json", "html", "htm"];

#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextRead {
    pub text: String,
    pub total_bytes: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub readable: bool,
}

/// Normalizes a model-supplied relative path (`/` separators, no `..`
/// escapes, no absolute or drive paths). The root is `""`.
pub fn clean_path(raw: &str, allow_root: bool) -> Result<String> {
    let value = raw.trim().replace('\\', "/");
    if value.contains('\0') || value.starts_with('/') {
        return Err("document path is invalid".into());
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err("document path must stay within workspace".into());
                }
            }
            part if part.contains(':') && parts.is_empty() && cfg!(windows) => {
                return Err("document path is invalid".into());
            }
            part => parts.push(part),
        }
    }
    if parts.is_empty() && !allow_root {
        return Err(if value.is_empty() {
            "document path cannot be empty".into()
        } else {
            "document path is invalid".into()
        });
    }
    Ok(parts.join("/"))
}

pub fn is_searchable(path: &str) -> bool {
    extension(path).is_some_and(|ext| SEARCHABLE_EXTENSIONS.contains(&ext.as_str()))
}

/// The lowercase extension without the dot.
pub fn extension(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
}

/// Replaces characters that are unsafe in filenames and caps the length.
pub fn sanitize_filename(title: &str, fallback: &str) -> String {
    let clean = |value: &str| {
        let mut out = String::new();
        let mut last_dash = false;
        for c in value.trim().chars() {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() {
                if !last_dash {
                    out.push('-');
                }
                last_dash = true;
            } else {
                out.push(c);
                last_dash = false;
            }
        }
        out.trim()
            .trim_matches(['.', ' '])
            .chars()
            .take(80)
            .collect::<String>()
    };
    let value = clean(title);
    if value.is_empty() {
        clean(fallback)
    } else {
        value
    }
}

/// The parent folder of a workspace path, or `""`.
pub fn parent_folder(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    match path.rsplit_once('/') {
        Some((parent, _)) => parent.trim_matches('/').to_owned(),
        None => String::new(),
    }
}

/// Up to ~135 characters around the match at byte `index`.
pub fn snippet(text: &str, index: Option<usize>) -> String {
    let text = text.trim();
    let chars: Vec<char> = text.chars().collect();
    let Some(index) = index else {
        return if chars.len() > 120 {
            format!("{}...", chars[..120].iter().collect::<String>())
        } else {
            text.to_owned()
        };
    };
    let at = text.get(..index).map_or(0, |prefix| prefix.chars().count());
    let start = at.saturating_sub(45);
    let end = (at + 90).min(chars.len());
    let mut out = chars[start..end]
        .iter()
        .collect::<String>()
        .trim()
        .to_owned();
    if start > 0 {
        out = format!("...{out}");
    }
    if end < chars.len() {
        out.push_str("...");
    }
    out
}

impl Workspace {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn root_text(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn ensure_root(&self) -> Result<()> {
        if self.root.as_os_str().is_empty() {
            return Err("document workspace directory is not configured".into());
        }
        std::fs::create_dir_all(&self.root)
            .map_err(|_| "document workspace directory is not writable".to_owned())
    }

    /// The absolute path for a cleaned relative path. Existing targets (or
    /// their nearest existing ancestor) must resolve inside the workspace.
    pub fn resolve(&self, relative: &str) -> Result<PathBuf> {
        self.ensure_root()?;
        let mut path = self.root.clone();
        for part in relative.split('/').filter(|part| !part.is_empty()) {
            path.push(part);
        }
        if !path
            .components()
            .skip(self.root.components().count())
            .all(|c| matches!(c, Component::Normal(_)))
        {
            return Err("document path is invalid".into());
        }
        let root = self
            .root
            .canonicalize()
            .map_err(|_| "document workspace directory is not configured".to_owned())?;
        let mut probe = path.as_path();
        loop {
            if let Ok(real) = probe.canonicalize() {
                if !real.starts_with(&root) {
                    return Err("document path must stay within workspace".into());
                }
                break;
            }
            match probe.parent() {
                Some(parent) => probe = parent,
                None => break,
            }
        }
        Ok(path)
    }

    /// Cleans and resolves a model-supplied path.
    pub fn locate(&self, raw: &str, allow_root: bool) -> Result<(String, PathBuf)> {
        let relative = clean_path(raw, allow_root)?;
        let absolute = self.resolve(&relative)?;
        Ok((relative, absolute))
    }

    pub fn read_text(&self, raw: &str, max_bytes: usize) -> Result<TextRead> {
        let (_, path) = self.locate(raw, false)?;
        let meta = std::fs::metadata(&path).map_err(|_| "failed to read document".to_owned())?;
        if meta.is_dir() {
            return Err("cannot read a directory".into());
        }
        let mut raw = std::fs::read(&path).map_err(|_| "failed to read document".to_owned())?;
        let total_bytes = raw.len() as u64;
        let truncated = raw.len() > max_bytes;
        if truncated {
            raw.truncate(max_bytes);
            while !raw.is_empty() && std::str::from_utf8(&raw).is_err() {
                raw.pop();
            }
        }
        Ok(TextRead {
            text: String::from_utf8_lossy(&raw).into_owned(),
            total_bytes,
            truncated,
        })
    }

    /// Overwrites an existing file.
    pub fn write_existing(&self, raw: &str, content: &str) -> Result<String> {
        let (relative, path) = self.locate(raw, false)?;
        let meta = std::fs::metadata(&path).map_err(|_| "failed to read document".to_owned())?;
        if meta.is_dir() {
            return Err("cannot write to a directory".into());
        }
        std::fs::write(&path, content).map_err(|_| "failed to write document".to_owned())?;
        Ok(relative)
    }

    /// Writes a new file into `folder`, adding ` 2`, ` 3`, ... to the name
    /// when it exists. Returns the relative path.
    pub fn write_new(&self, folder: &str, filename: &str, data: &[u8]) -> Result<String> {
        let (folder, dir) = self.locate(folder, true)?;
        std::fs::create_dir_all(&dir)
            .map_err(|_| "failed to create document directory".to_owned())?;
        let filename = sanitize_filename(filename, "Agent output");
        let (stem, ext) = match filename.rfind('.') {
            Some(dot) if dot > 0 => (&filename[..dot], &filename[dot..]),
            _ => (filename.as_str(), ""),
        };
        let mut name = filename.clone();
        let mut counter = 2;
        loop {
            let target = dir.join(&name);
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
            {
                Ok(mut file) => {
                    use std::io::Write;
                    file.write_all(data)
                        .map_err(|_| "failed to write file".to_owned())?;
                    return Ok(if folder.is_empty() {
                        name
                    } else {
                        format!("{folder}/{name}")
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    name = format!("{stem} {counter}{ext}");
                    counter += 1;
                }
                Err(_) => return Err("failed to write file".into()),
            }
        }
    }

    /// Writes a file at an exact relative path, creating folders.
    pub fn write_at(&self, raw: &str, data: &[u8]) -> Result<String> {
        let (relative, path) = self.locate(raw, false)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| "failed to create document directory".to_owned())?;
        }
        std::fs::write(&path, data).map_err(|_| "failed to write file".to_owned())?;
        Ok(relative)
    }

    /// Relative path of an absolute path inside the workspace.
    pub fn relative(&self, path: &Path) -> Option<String> {
        let relative = path.strip_prefix(&self.root).ok()?;
        Some(
            relative
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/"),
        )
    }

    /// Visits files below `base` (skipping dot entries), sorted, stopping
    /// when `visit` returns false.
    pub fn walk(&self, base: &Path, visit: &mut dyn FnMut(&Path, &std::fs::Metadata) -> bool) {
        fn inner(dir: &Path, visit: &mut dyn FnMut(&Path, &std::fs::Metadata) -> bool) -> bool {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return true;
            };
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                let path = entry.path();
                if meta.is_dir() {
                    if !inner(&path, visit) {
                        return false;
                    }
                } else if !visit(&path, &meta) {
                    return false;
                }
            }
            true
        }
        inner(base, visit);
    }

    pub fn search_text(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        self.ensure_root()?;
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Err("search query cannot be empty".into());
        }
        let mut hits = Vec::new();
        let root = self.root.clone();
        self.walk(&root, &mut |path, _| {
            let relative = self.relative(path).unwrap_or_default();
            if !is_searchable(&relative) {
                return true;
            }
            let Ok(text) = std::fs::read_to_string(path) else {
                return true;
            };
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let index = text.to_lowercase().find(&query);
            if index.is_none() && !name.contains(&query) {
                return true;
            }
            let title = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            // Lowercasing can shift byte offsets; only use exact positions.
            let index = index.filter(|&i| text.is_char_boundary(i));
            hits.push(SearchHit {
                path: relative,
                title,
                snippet: snippet(&text, index),
            });
            hits.len() < limit
        });
        Ok(hits)
    }

    pub fn list_entries(&self, raw: &str, limit: usize) -> Result<Vec<Entry>> {
        let (_, base) = self.locate(raw, true)?;
        let meta = std::fs::metadata(&base).map_err(|_| "failed to read directory".to_owned())?;
        if !meta.is_dir() {
            return Err("not a directory".into());
        }
        let mut entries = Vec::new();
        self.walk(&base, &mut |path, meta| {
            let relative = self.relative(path).unwrap_or_default();
            entries.push(Entry {
                readable: is_searchable(&relative),
                path: relative,
                size: meta.len(),
            });
            entries.len() < limit
        });
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_paths() {
        assert_eq!(
            clean_path(" a\\b/./c.md ", false).as_deref(),
            Ok("a/b/c.md")
        );
        assert_eq!(clean_path("a/../b.md", false).as_deref(), Ok("b.md"));
        assert!(clean_path("../x", false).is_err());
        assert!(clean_path("/etc/passwd", false).is_err());
        assert!(clean_path("", false).is_err());
        assert_eq!(clean_path("", true).as_deref(), Ok(""));
    }

    #[test]
    fn writes_reads_and_dedupes() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let ws = Workspace::new(dir.path());
        assert_eq!(
            ws.write_new("Notes", "a.md", b"hello world").as_deref(),
            Ok("Notes/a.md")
        );
        assert_eq!(
            ws.write_new("Notes", "a.md", b"x").as_deref(),
            Ok("Notes/a 2.md")
        );
        assert_eq!(
            ws.write_existing("Notes/a.md", "hello again").as_deref(),
            Ok("Notes/a.md")
        );
        let read = ws
            .read_text("Notes/a.md", 5)
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(
            (read.text.as_str(), read.truncated, read.total_bytes),
            ("hello", true, 11)
        );
        let hits = ws.search_text("AGAIN", 5).unwrap_or_default();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "Notes/a.md");
        let entries = ws.list_entries("", 10).unwrap_or_default();
        assert_eq!(entries.len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_escapes() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let outside = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(outside.path().join("secret.md"), "s").unwrap_or_else(|err| panic!("{err}"));
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link"))
            .unwrap_or_else(|err| panic!("{err}"));
        let ws = Workspace::new(dir.path());
        assert!(ws.read_text("link/secret.md", 100).is_err());
        assert!(ws.write_new("link", "x.md", b"x").is_err());
    }

    #[test]
    fn sanitizes_names_and_snippets() {
        assert_eq!(sanitize_filename(" a/b:c ", "x"), "a-b-c");
        assert_eq!(sanitize_filename("..", "fallback"), "fallback");
        assert_eq!(parent_folder("a/b/c.md"), "a/b");
        assert_eq!(parent_folder("c.md"), "");
        assert_eq!(snippet("short", None), "short");
    }
}
