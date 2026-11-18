//! The community build's bootstrap status. Official builds replace this at
//! packaging time; community builds never auto-configure an AI provider.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rand::RngCore;
use serde_json::{Value, json};

const INSTALLATION_FILE: &str = "installation.json";

pub struct CommunityBootstrap {
    data_dir: PathBuf,
    file: PathBuf,
}

fn status(installation_id: &str) -> Value {
    json!({
        "official_build": false,
        "build_channel": "community",
        "available": false,
        "state": "unavailable",
        "installation_id": installation_id,
        "diagnostics": {
            "code": "BOOTSTRAP_COMMUNITY_BUILD",
            "title": "This build does not include the official bootstrap check",
            "message": "Community builds do not auto-initialize a default AI provider. Open Settings to configure a provider manually.",
            "detail": "Official builds embed the proprietary bootstrap module at packaging time; this repository uses the public community placeholder by default.",
            "support_id": "",
            "retryable": false,
            "next_action": "manual_provider_setup",
        },
    })
}

impl CommunityBootstrap {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
            file: data_dir.join(INSTALLATION_FILE),
        }
    }

    /// The anonymous installation id, created on first use.
    fn installation_id(&self) -> io::Result<String> {
        let existing = fs::read_to_string(&self.file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|parsed| {
                parsed
                    .get("installation_id")
                    .and_then(Value::as_str)
                    .map(|id| id.trim().to_owned())
            })
            .filter(|id| !id.is_empty());
        if let Some(id) = existing {
            return Ok(id);
        }
        let mut bytes = [0u8; 12];
        rand::rng().fill_bytes(&mut bytes);
        let id = format!("ins_{}", hex::encode(bytes));
        fs::create_dir_all(&self.data_dir)?;
        let payload = serde_json::to_string_pretty(&json!({ "installation_id": id }))
            .map_err(io::Error::other)?;
        fs::write(&self.file, payload + "\n")?;
        Ok(id)
    }

    pub fn initialize(&self) -> io::Result<Value> {
        let id = self.installation_id()?;
        Ok(json!({ "installation_id": id, "status": status(&id) }))
    }

    pub fn create_attestation(&self) -> io::Result<Value> {
        let id = self.installation_id()?;
        Ok(json!({ "status": status(&id) }))
    }

    pub fn status(&self) -> io::Result<Value> {
        Ok(status(&self.installation_id()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_one_installation_id() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let bootstrap = CommunityBootstrap::new(dir.path());
        let first = bootstrap.initialize().unwrap_or_else(|err| panic!("{err}"));
        let id = first["installation_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        assert!(id.starts_with("ins_") && id.len() == 28);
        let status = bootstrap.status().unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(status["installation_id"], json!(id));
        assert_eq!(status["build_channel"], json!("community"));
    }
}
