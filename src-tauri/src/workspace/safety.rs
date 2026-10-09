//! Keeping workspace paths inside the workspace, and writing files so a crash
//! never leaves a half-written document behind.

use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

pub fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

/// A renderer-supplied workspace path as forward-slash segments without `.`
/// or `..`. The empty string stands for the root when `allow_root` is set.
pub fn normalize_relative(raw: &str, allow_root: bool) -> io::Result<String> {
    let value = raw.replace('\\', "/");
    let value = value.trim();
    if value.is_empty() {
        if allow_root {
            return Ok(String::new());
        }
        return Err(invalid("document path is required"));
    }
    if value.contains('\0') || is_absolute(value) {
        return Err(invalid("invalid document path"));
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => match parts.last() {
                Some(last) if *last != ".." => {
                    parts.pop();
                }
                _ => parts.push(".."),
            },
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        if allow_root {
            return Ok(String::new());
        }
        return Err(invalid("invalid document path"));
    }
    if parts[0] == ".." {
        return Err(invalid("invalid document path"));
    }
    Ok(parts.join("/"))
}

fn is_absolute(value: &str) -> bool {
    if value.starts_with('/') {
        return true;
    }
    let bytes = value.as_bytes();
    cfg!(target_os = "windows")
        && bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
}

/// Joins a normalized relative path onto the workspace root.
pub fn join_relative(root: &Path, relative: &str) -> PathBuf {
    let mut target = root.to_path_buf();
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        target.push(part);
    }
    target
}

/// Removes `.` and `..` lexically, like Node's `path.resolve` without the
/// working directory.
pub fn lexical_resolve(path: &Path) -> PathBuf {
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    resolved
}

pub fn is_within(root: &Path, target: &Path) -> bool {
    target == root || target.starts_with(root)
}

/// Rejects symbolic links, non-directory parents, and anything that resolves
/// outside `root`. With `allow_missing`, the first missing segment ends the
/// walk once its parent is known to be inside the root.
pub fn assert_safe(root: &Path, target: &Path, allow_missing: bool) -> io::Result<PathBuf> {
    let root = lexical_resolve(root);
    let target = lexical_resolve(target);
    if !is_within(&root, &target) {
        return Err(invalid("workspace path escapes the workspace root"));
    }
    let real_root = fs::canonicalize(&root)?;
    let relative = target.strip_prefix(&root).unwrap_or(Path::new(""));
    let segments: Vec<_> = relative.components().collect();
    let mut current = root.clone();
    for (index, segment) in segments.iter().enumerate() {
        current.push(segment.as_os_str());
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound && allow_missing => {
                let parent = current.parent().unwrap_or(&root);
                let real_parent = fs::canonicalize(parent)?;
                if !is_within(&real_root, &real_parent) {
                    return Err(invalid(
                        "workspace path resolves outside the workspace root",
                    ));
                }
                return Ok(target);
            }
            Err(error) => return Err(error),
        };
        if metadata.file_type().is_symlink() {
            return Err(invalid(
                "symbolic links are not supported inside a workspace path",
            ));
        }
        if index < segments.len() - 1 && !metadata.is_dir() {
            return Err(invalid("workspace path contains a non-directory parent"));
        }
    }
    let real_target = fs::canonicalize(&target)?;
    if !is_within(&real_root, &real_target) {
        return Err(invalid(
            "workspace path resolves outside the workspace root",
        ));
    }
    Ok(target)
}

/// Writes through a temporary sibling and renames it into place, keeping the
/// existing file's permissions.
pub fn write_atomically(path: &Path, content: &[u8]) -> io::Result<()> {
    let directory = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(directory)?;
    let filename = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temporary = directory.join(format!(
        ".{filename}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mode = match fs::metadata(path) {
                Ok(metadata) => metadata.permissions().mode() & 0o777,
                Err(error) if error.kind() == io::ErrorKind::NotFound => 0o644,
                Err(error) => return Err(error),
            };
            options.mode(mode);
            mode
        };
        let mut file = options.open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(mode))?;
        }
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        sync_directory(directory);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn sync_directory(directory: &Path) {
    if let Ok(handle) = fs::File::open(directory) {
        let _ = handle.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_relative_paths() {
        assert_eq!(
            normalize_relative("a\\b/./c", false).ok(),
            Some("a/b/c".into())
        );
        assert_eq!(normalize_relative("a/../b", false).ok(), Some("b".into()));
        assert_eq!(normalize_relative("", true).ok(), Some(String::new()));
        assert_eq!(normalize_relative(".", true).ok(), Some(String::new()));
        assert!(normalize_relative("", false).is_err());
        assert!(normalize_relative("../x", false).is_err());
        assert!(normalize_relative("a/../..", false).is_err());
        assert!(normalize_relative("/etc/passwd", false).is_err());
        assert!(normalize_relative("a\0b", false).is_err());
    }

    #[test]
    fn rejects_symlinks_and_escapes() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = dir.path().join("root");
        fs::create_dir_all(root.join("docs")).unwrap_or_else(|err| panic!("{err}"));
        fs::write(root.join("docs/a.md"), "x").unwrap_or_else(|err| panic!("{err}"));
        assert!(assert_safe(&root, &root.join("docs/a.md"), false).is_ok());
        assert!(assert_safe(&root, &root.join("docs/new.md"), true).is_ok());
        assert!(assert_safe(&root, &root.join("docs/new.md"), false).is_err());
        assert!(assert_safe(&root, &dir.path().join("outside"), true).is_err());
        assert!(assert_safe(&root, &root.join("docs/a.md/child"), true).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path(), root.join("link"))
                .unwrap_or_else(|err| panic!("{err}"));
            let error = assert_safe(&root, &root.join("link/file.md"), true)
                .err()
                .map(|err| err.to_string());
            assert_eq!(
                error.as_deref(),
                Some("symbolic links are not supported inside a workspace path")
            );
        }
    }

    #[test]
    fn writes_atomically_and_keeps_mode() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let file = dir.path().join("nested/doc.md");
        write_atomically(&file, b"first").unwrap_or_else(|err| panic!("{err}"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600))
                .unwrap_or_else(|err| panic!("{err}"));
        }
        write_atomically(&file, b"second").unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(fs::read_to_string(&file).ok().as_deref(), Some("second"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&file)
                .map(|m| m.permissions().mode() & 0o777)
                .ok();
            assert_eq!(mode, Some(0o600));
        }
        let leftovers = fs::read_dir(dir.path().join("nested"))
            .map(|entries| entries.count())
            .unwrap_or_default();
        assert_eq!(leftovers, 1);
    }
}
