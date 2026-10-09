//! File system helpers shared by workspace features.

use std::io::Write;
use std::path::{Component, Path, PathBuf};

use kition_core::{AppError, AppResult};
use serde::Serialize;

/// Writes `value` as two-space indented JSON plus a newline, atomically
/// (temporary file in the same directory, fsync, rename).
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    let mut data = serde_json::to_vec_pretty(value)?;
    data.push(b'\n');
    write_atomic(path, &data)
}

/// Writes bytes atomically (temporary file in the same directory, fsync, rename).
pub fn write_atomic(path: &Path, data: &[u8]) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::internal("path has no parent directory"))?;
    std::fs::create_dir_all(dir)?;
    let mut temp = tempfile::Builder::new()
        .prefix(".kition-")
        .suffix(".tmp")
        .tempfile_in(dir)?;
    temp.write_all(data)?;
    temp.as_file().sync_all()?;
    temp.persist(path)
        .map_err(|err| AppError::from(err.error))?;
    Ok(())
}

/// Joins `relative` under `root`, rejecting absolute paths and anything that
/// climbs out of `root`.
pub fn resolve_within(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let escape = || AppError::bad_request("asset path escapes storage root");
    let relative = relative.trim();
    let candidate = Path::new(relative);
    if relative.is_empty()
        || candidate.is_absolute()
        || relative.starts_with('/')
        || relative.starts_with('\\')
    {
        return Err(escape());
    }
    let mut cleaned = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => cleaned.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !cleaned.pop() {
                    return Err(escape());
                }
            }
            Component::RootDir | Component::Prefix(_) => return Err(escape()),
        }
    }
    if cleaned.as_os_str().is_empty() {
        return Err(escape());
    }
    Ok(root.join(cleaned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_inside_root_only() {
        let root = Path::new("/srv/ws");
        assert_eq!(
            resolve_within(root, "a/b.png").ok(),
            Some(PathBuf::from("/srv/ws/a/b.png"))
        );
        assert_eq!(
            resolve_within(root, "a/../b.png").ok(),
            Some(PathBuf::from("/srv/ws/b.png"))
        );
        for bad in ["", ".", "..", "../x", "a/../../x", "/etc/passwd"] {
            assert!(resolve_within(root, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn writes_json_atomically() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let path = dir.path().join("nested/state.json");
        write_json_atomic(&path, &serde_json::json!({"a": 1}))
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap_or_default(),
            "{\n  \"a\": 1\n}\n"
        );
        let leftovers = std::fs::read_dir(path.parent().unwrap_or(dir.path()))
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(leftovers, 1);
    }
}
