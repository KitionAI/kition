//! Connection secrets, sealed with AES-256-GCM under a per-installation key
//! stored next to the database (`connection-secret.key`, base64).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

pub const KEY_FILE: &str = "connection-secret.key";
const NONCE_LEN: usize = 12;

pub type SecretBag = BTreeMap<String, String>;

#[derive(Debug, Clone)]
pub struct SecretStore {
    key_path: PathBuf,
}

impl SecretStore {
    /// The key lives beside the SQLite file, else beside the upload folder,
    /// else in `./data`.
    pub fn new(sqlite_path: &str, upload_dir: &str) -> Self {
        let beside = |value: &str| {
            Path::new(value.trim())
                .parent()
                .map(|dir| dir.join(KEY_FILE))
                .unwrap_or_else(|| PathBuf::from(KEY_FILE))
        };
        let key_path = if !sqlite_path.trim().is_empty() {
            beside(sqlite_path)
        } else if !upload_dir.trim().is_empty() {
            beside(upload_dir)
        } else {
            Path::new(".").join("data").join(KEY_FILE)
        };
        Self { key_path }
    }

    pub fn with_key_path(key_path: PathBuf) -> Self {
        Self { key_path }
    }

    /// `{"version":1,"fields_encrypted":"<base64(nonce||ciphertext)>"}`.
    pub fn seal(&self, fields: &SecretBag) -> Result<String, String> {
        let plain = serde_json::to_vec(fields).map_err(|e| e.to_string())?;
        let cipher = self.cipher()?;
        let nonce_bytes: [u8; NONCE_LEN] = rand::random();
        let sealed = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plain.as_ref())
            .map_err(|_| "encrypt connection secret failed".to_owned())?;
        let mut payload = nonce_bytes.to_vec();
        payload.extend(sealed);
        Ok(json!({ "fields_encrypted": STANDARD.encode(payload), "version": 1 }).to_string())
    }

    pub fn open(&self, raw: &str) -> Result<SecretBag, String> {
        let payload: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let encrypted = payload
            .get("fields_encrypted")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if encrypted.trim().is_empty() {
            return Err("connection secret payload is missing".to_owned());
        }
        let data = STANDARD
            .decode(encrypted.trim())
            .map_err(|e| e.to_string())?;
        if data.len() < NONCE_LEN {
            return Err("encrypted connection secret is invalid".to_owned());
        }
        let (nonce, sealed) = data.split_at(NONCE_LEN);
        let plain = self
            .cipher()?
            .decrypt(Nonce::from_slice(nonce), sealed)
            .map_err(|_| "cipher: message authentication failed".to_owned())?;
        serde_json::from_slice(&plain).map_err(|e| e.to_string())
    }

    fn cipher(&self) -> Result<Aes256Gcm, String> {
        let key = self.load_key()?;
        Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())
    }

    /// Reads the key, creating a random one (mode 0600) when absent or
    /// unreadable as 32 base64 bytes.
    fn load_key(&self) -> Result<Vec<u8>, String> {
        match std::fs::read_to_string(&self.key_path) {
            Ok(text) => {
                if let Ok(key) = STANDARD.decode(text.trim())
                    && key.len() == 32
                {
                    return Ok(key);
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.to_string()),
        }
        let key: [u8; 32] = rand::random();
        if let Some(dir) = self.key_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.key_path, STANDARD.encode(key)).map_err(|e| e.to_string())?;
        restrict(&self.key_path);
        Ok(key.to_vec())
    }
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_and_opens_with_persisted_key() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let store = SecretStore::new(&dir.path().join("data/kition.db").to_string_lossy(), "");
        let mut bag = SecretBag::new();
        bag.insert("password".into(), "s3cret".into());
        let sealed = store.seal(&bag).unwrap_or_default();
        assert!(sealed.contains("\"version\":1"));
        let reopened = SecretStore::new(&dir.path().join("data/kition.db").to_string_lossy(), "");
        assert_eq!(reopened.open(&sealed).ok(), Some(bag));
        assert!(dir.path().join("data").join(KEY_FILE).is_file());
        assert!(store.open("{}").is_err());
    }

    #[test]
    fn opens_secrets_sealed_by_the_legacy_runtime() {
        // Key and payload produced by the legacy implementation's format:
        // base64(32-byte key) and base64(12-byte nonce || AES-GCM output).
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let key = [7_u8; 32];
        std::fs::write(dir.path().join(KEY_FILE), STANDARD.encode(key))
            .unwrap_or_else(|err| panic!("{err}"));
        let store = SecretStore::with_key_path(dir.path().join(KEY_FILE));
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap_or_else(|err| panic!("{err}"));
        let nonce = [1_u8; 12];
        let sealed = cipher
            .encrypt(Nonce::from_slice(&nonce), br#"{"password":"x"}"#.as_ref())
            .unwrap_or_default();
        let mut payload = nonce.to_vec();
        payload.extend(sealed);
        let raw = json!({ "version": 1, "fields_encrypted": STANDARD.encode(payload) }).to_string();
        assert_eq!(
            store
                .open(&raw)
                .ok()
                .and_then(|b| b.get("password").cloned()),
            Some("x".into())
        );
    }
}
