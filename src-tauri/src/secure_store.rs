//! Desktop secrets as files under `<data>/secrets`. The OS keychain is not
//! used: re-signed builds would prompt for keychain access on every update,
//! and these files already sit under the user's own account permissions.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const PLAINTEXT_PREFIX: &str = "plain-v1:";
const ENCRYPTED_PREFIX: &str = "enc-v1:";

pub struct SecureStore {
    directory: PathBuf,
}

fn sanitize_key(key: &str) -> String {
    key.replace(['/', '\\'], "_").replace("..", "_")
}

impl SecureStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            directory: data_dir.join("secrets"),
        }
    }

    fn path(&self, key: &str) -> PathBuf {
        self.directory.join(format!("{}.secret", sanitize_key(key)))
    }

    pub fn set(&self, key: &str, value: &str) -> io::Result<()> {
        fs::create_dir_all(&self.directory)?;
        fs::write(self.path(key), format!("{PLAINTEXT_PREFIX}{value}"))
    }

    /// The stored value, or empty when missing. Values written by the old
    /// keychain-backed store cannot be decrypted and read as missing.
    pub fn get(&self, key: &str) -> io::Result<String> {
        match fs::read_to_string(self.path(key)) {
            Ok(data) => {
                if let Some(value) = data.strip_prefix(PLAINTEXT_PREFIX) {
                    Ok(value.to_owned())
                } else if data.starts_with(ENCRYPTED_PREFIX) {
                    Ok(String::new())
                } else {
                    Ok(data)
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(error),
        }
    }

    pub fn delete(&self, key: &str) -> io::Result<()> {
        match fs::remove_file(self.path(key)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_values() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let store = SecureStore::new(dir.path());
        assert_eq!(store.get("a/b").ok().as_deref(), Some(""));
        store
            .set("a/b", "secret")
            .unwrap_or_else(|err| panic!("{err}"));
        assert!(dir.path().join("secrets/a_b.secret").is_file());
        assert_eq!(store.get("a/b").ok().as_deref(), Some("secret"));
        fs::write(dir.path().join("secrets/old.secret"), "enc-v1:xyz")
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(store.get("old").ok().as_deref(), Some(""));
        fs::write(dir.path().join("secrets/legacy.secret"), "{\"a\":1}")
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(store.get("legacy").ok().as_deref(), Some("{\"a\":1}"));
        store.delete("a/b").unwrap_or_else(|err| panic!("{err}"));
        store.delete("a/b").unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(store.get("a/b").ok().as_deref(), Some(""));
    }
}
