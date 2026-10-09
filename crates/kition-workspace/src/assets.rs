//! Content-addressed workspace assets under `.kition/assets/sha256/` and the
//! workspace manifest at `.kition/workspace.json`.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use kition_core::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::fsutil::{resolve_within, write_json_atomic};

pub const CAPABILITY: &str = "workspace_portable_storage_v1";
pub const STORAGE_VERSION: i64 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asset {
    pub url: String,
    pub name: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    #[serde(rename = "assetId")]
    pub asset_id: String,
    pub sha256: String,
    #[serde(rename = "workspacePath")]
    pub workspace_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: i64,
    pub storage_version: i64,
    pub workspace_id: String,
}

#[derive(Debug, Clone)]
pub struct AssetStore {
    workspace_dir: PathBuf,
    upload_dir: Option<PathBuf>,
}

impl AssetStore {
    /// `workspace_dir` and `upload_dir` must already be absolute.
    pub fn new(workspace_dir: &Path, upload_dir: Option<&Path>) -> AppResult<Self> {
        if workspace_dir.as_os_str().is_empty() {
            return Err(AppError::internal("workspace directory is not configured"));
        }
        Ok(Self {
            workspace_dir: workspace_dir.to_path_buf(),
            upload_dir: upload_dir.map(Path::to_path_buf),
        })
    }

    pub fn workspace_dir(&self) -> &Path {
        &self.workspace_dir
    }

    /// Stores `reader` content once per SHA-256 digest.
    pub fn save(
        &self,
        reader: &mut dyn Read,
        original_name: &str,
        mime_type: &str,
    ) -> AppResult<Asset> {
        let tmp_dir = self.workspace_dir.join(".kition/assets/.tmp");
        std::fs::create_dir_all(&tmp_dir)?;
        let mut temp = tempfile::Builder::new()
            .prefix("asset-")
            .tempfile_in(&tmp_dir)?;
        let mut hasher = Sha256::new();
        let mut size: i64 = 0;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            temp.write_all(&buffer[..read])?;
            size += i64::try_from(read).unwrap_or(i64::MAX);
        }
        temp.as_file().sync_all()?;

        let digest = hex::encode(hasher.finalize());
        let extension = asset_extension(original_name, mime_type);
        let workspace_path = format!(".kition/assets/sha256/{}/{digest}{extension}", &digest[..2]);
        let absolute = self.workspace_dir.join(&workspace_path);
        if let Some(parent) = absolute.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match std::fs::metadata(&absolute) {
            Ok(meta) => {
                if i64::try_from(meta.len()).unwrap_or(-1) != size {
                    return Err(AppError::internal(
                        "existing workspace asset has unexpected size",
                    ));
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                temp.persist(&absolute)
                    .map_err(|err| AppError::from(err.error))?;
            }
            Err(err) => return Err(err.into()),
        }

        let mut mime = mime_type.trim().to_owned();
        if mime.is_empty() {
            mime = mime_for_extension(&extension);
        }
        let base = Path::new(original_name.trim())
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = if base.is_empty() || base == "." {
            format!("{digest}{extension}")
        } else {
            base
        };
        Ok(Asset {
            url: format!("/workspace-files/{workspace_path}"),
            name,
            mime_type: mime,
            size_bytes: size,
            asset_id: digest.clone(),
            sha256: digest,
            workspace_path,
        })
    }

    pub fn save_bytes(
        &self,
        data: &[u8],
        original_name: &str,
        mime_type: &str,
    ) -> AppResult<Asset> {
        self.save(&mut std::io::Cursor::new(data), original_name, mime_type)
    }

    /// Maps `/workspace-files/...` or `/uploads/...` to an absolute path.
    pub fn resolve_url(&self, raw_url: &str) -> AppResult<PathBuf> {
        let raw = raw_url.trim();
        if let Some(relative) = raw.strip_prefix("/workspace-files/") {
            return resolve_within(&self.workspace_dir, relative);
        }
        if let (Some(relative), Some(upload_dir)) =
            (raw.strip_prefix("/uploads/"), &self.upload_dir)
        {
            return resolve_within(upload_dir, relative);
        }
        Err(AppError::bad_request(format!(
            "unsupported attachment URL: {raw}"
        )))
    }

    pub fn resolve_workspace_path(&self, workspace_path: &str) -> AppResult<PathBuf> {
        resolve_within(&self.workspace_dir, workspace_path)
    }

    /// Reads the workspace manifest, creating it with a random 16-hex-digit
    /// workspace ID when absent.
    pub fn ensure_manifest(&self) -> AppResult<Manifest> {
        let path = self.workspace_dir.join(".kition/workspace.json");
        match std::fs::read(&path) {
            Ok(data) => {
                let manifest: Option<Manifest> = serde_json::from_slice(&data).ok();
                match manifest {
                    Some(m)
                        if valid_workspace_id(&m.workspace_id)
                            && m.schema_version == 1
                            && m.storage_version >= 1 =>
                    {
                        Ok(m)
                    }
                    _ => Err(AppError::internal("workspace manifest is invalid")),
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let id: [u8; 8] = rand::random();
                let manifest = Manifest {
                    schema_version: 1,
                    storage_version: STORAGE_VERSION,
                    workspace_id: hex::encode(id),
                };
                write_json_atomic(&path, &manifest)?;
                Ok(manifest)
            }
            Err(err) => Err(err.into()),
        }
    }
}

fn valid_workspace_id(value: &str) -> bool {
    value.len() == 16 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_extension(extension: &str) -> bool {
    let Some(body) = extension.strip_prefix('.') else {
        return false;
    };
    (1..=16).contains(&body.len())
        && body
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Preferred extensions for common types, so the choice does not depend on
/// platform MIME tables.
const PREFERRED_EXTENSIONS: [(&str, &str); 12] = [
    ("image/png", ".png"),
    ("image/jpeg", ".jpg"),
    ("image/gif", ".gif"),
    ("image/webp", ".webp"),
    ("image/svg+xml", ".svg"),
    ("image/avif", ".avif"),
    ("application/pdf", ".pdf"),
    ("text/plain", ".txt"),
    ("text/markdown", ".md"),
    ("application/json", ".json"),
    ("video/mp4", ".mp4"),
    ("audio/mpeg", ".mp3"),
];

fn asset_extension(name: &str, mime_type: &str) -> String {
    let extension = Path::new(name.trim())
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    if valid_extension(&extension) {
        return extension;
    }
    let mime = mime_type
        .trim()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if let Some((_, ext)) = PREFERRED_EXTENSIONS.iter().find(|(m, _)| *m == mime) {
        return (*ext).to_owned();
    }
    if let Some(found) = mime_guess::get_mime_extensions_str(&mime)
        .into_iter()
        .flatten()
        .map(|ext| format!(".{}", ext.to_lowercase()))
        .find(|ext| valid_extension(ext))
    {
        return found;
    }
    ".bin".to_owned()
}

fn mime_for_extension(extension: &str) -> String {
    let body = extension.trim_start_matches('.');
    if let Some((mime, _)) = PREFERRED_EXTENSIONS
        .iter()
        .find(|(_, ext)| ext.trim_start_matches('.') == body)
    {
        return (*mime).to_owned();
    }
    mime_guess::from_ext(body)
        .first_raw()
        .map_or_else(|| "application/octet-stream".to_owned(), str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, AssetStore) {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let store = AssetStore::new(dir.path(), Some(&dir.path().join("uploads")))
            .unwrap_or_else(|err| panic!("{err}"));
        (dir, store)
    }

    #[test]
    fn saves_content_addressed_assets_once() {
        let (dir, store) = store();
        let first = store
            .save_bytes(b"hello", "Greeting.TXT", "")
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(
            first.sha256,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(
            first.workspace_path,
            format!(".kition/assets/sha256/2c/{}.txt", first.sha256)
        );
        assert_eq!(
            first.url,
            format!("/workspace-files/{}", first.workspace_path)
        );
        assert_eq!(first.name, "Greeting.TXT");
        assert_eq!(first.mime_type, "text/plain");
        assert_eq!(first.size_bytes, 5);
        let second = store
            .save_bytes(b"hello", "", "text/plain")
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(second.workspace_path, first.workspace_path);
        assert_eq!(second.name, format!("{}.txt", first.sha256));
        assert!(dir.path().join(&first.workspace_path).is_file());
    }

    #[test]
    fn picks_extension_from_mime_when_name_has_none() {
        assert_eq!(asset_extension("photo", "image/jpeg"), ".jpg");
        assert_eq!(asset_extension("x.Png", "image/jpeg"), ".png");
        assert_eq!(
            asset_extension("x.toolongextension123", "application/x-unknown-thing"),
            ".bin"
        );
    }

    #[test]
    fn resolves_urls() {
        let (dir, store) = store();
        assert_eq!(
            store.resolve_url("/workspace-files/a/b.png").ok(),
            Some(dir.path().join("a/b.png"))
        );
        assert_eq!(
            store.resolve_url("/uploads/x.png").ok(),
            Some(dir.path().join("uploads/x.png"))
        );
        assert!(store.resolve_url("/workspace-files/../x").is_err());
        assert!(store.resolve_url("https://example.com/a.png").is_err());
    }

    #[test]
    fn manifest_is_created_then_reused() {
        let (_dir, store) = store();
        let first = store
            .ensure_manifest()
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(first.workspace_id.len(), 16);
        let second = store
            .ensure_manifest()
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(first, second);
    }
}
