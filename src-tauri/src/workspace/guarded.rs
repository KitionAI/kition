//! Compare-and-write for documents the design editor saves: a write only
//! lands when the file still holds what the editor last read.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

pub const SAVE_CONFLICT: &str = "DESIGN_SAVE_CONFLICT";

#[derive(Default)]
pub struct GuardedWrites {
    locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl GuardedWrites {
    /// Runs `write` while no other guarded write touches `path`, after
    /// checking `expected` against the file on disk when given.
    pub fn write<T>(
        &self,
        path: &Path,
        expected: Option<&str>,
        write: impl FnOnce() -> io::Result<T>,
    ) -> io::Result<T> {
        self.exclusive(path, || check(path, expected).and_then(|()| write()))
    }

    /// Runs `work` while no other guarded call touches `path`.
    pub fn exclusive<T>(&self, path: &Path, work: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
        let lock = {
            let mut locks = self.locks.lock().unwrap_or_else(PoisonError::into_inner);
            locks.entry(path.to_path_buf()).or_default().clone()
        };
        let result = {
            let _guard = lock.lock().unwrap_or_else(PoisonError::into_inner);
            work()
        };
        let mut locks = self.locks.lock().unwrap_or_else(PoisonError::into_inner);
        if locks
            .get(path)
            .is_some_and(|current| Arc::ptr_eq(current, &lock) && Arc::strong_count(&lock) <= 2)
        {
            locks.remove(path);
        }
        result
    }
}

fn check(path: &Path, expected: Option<&str>) -> io::Result<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let current = match fs::read_to_string(path) {
        Ok(content) => Some(content),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    if current.as_deref() == Some(expected) {
        Ok(())
    } else {
        Err(io::Error::other(SAVE_CONFLICT))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_stale_writes() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let file = dir.path().join("a.kidesign");
        fs::write(&file, "v1").unwrap_or_else(|err| panic!("{err}"));
        let writes = GuardedWrites::default();
        let ok = writes.write(&file, Some("v1"), || fs::write(&file, "v2"));
        assert!(ok.is_ok());
        let stale = writes
            .write(&file, Some("v1"), || fs::write(&file, "v3"))
            .err()
            .map(|err| err.to_string());
        assert_eq!(stale.as_deref(), Some(SAVE_CONFLICT));
        assert!(writes.write(&file, None, || fs::write(&file, "v4")).is_ok());
        let missing = dir.path().join("missing.kidesign");
        assert!(writes.write(&missing, Some(""), || Ok(())).is_err());
        assert!(
            writes
                .locks
                .lock()
                .map(|locks| locks.is_empty())
                .unwrap_or(false)
        );
    }
}
