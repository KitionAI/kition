//! Private per-launch endpoints. On Unix the socket lives in a fresh
//! directory with mode `0700`; on Windows it is a random local-only pipe name.

use std::io;

/// An endpoint the host hands to one kit launch.
#[derive(Debug)]
pub struct Endpoint {
    address: String,
    #[cfg(unix)]
    dir: std::path::PathBuf,
}

impl Endpoint {
    /// Creates a new endpoint under the system temporary directory.
    pub fn create() -> io::Result<Self> {
        Self::create_in(&std::env::temp_dir())
    }

    /// Creates a new endpoint under `base`. Unix socket paths are limited to
    /// about 100 bytes, so `base` should be short.
    #[cfg(unix)]
    pub fn create_in(base: &std::path::Path) -> io::Result<Self> {
        use std::os::unix::fs::DirBuilderExt;

        let suffix = hex::encode(rand::random::<[u8; 8]>());
        let dir = base.join(format!("kition-kit-{suffix}"));
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        let address = dir.join("kit.sock").to_string_lossy().into_owned();
        Ok(Self { address, dir })
    }

    #[cfg(windows)]
    pub fn create_in(_base: &std::path::Path) -> io::Result<Self> {
        let suffix = hex::encode(rand::random::<[u8; 16]>());
        Ok(Self {
            address: format!(r"\\.\pipe\kition-kit-{suffix}"),
        })
    }

    /// The value of `KITION_KIT_ENDPOINT`.
    pub fn address(&self) -> &str {
        &self.address
    }
}

#[cfg(unix)]
impl Drop for Endpoint {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn unix_endpoint_directory_is_private_and_removed() {
        let endpoint = Endpoint::create().unwrap_or_else(|err| panic!("{err}"));
        let dir = endpoint.dir.clone();
        let mode = std::fs::metadata(&dir)
            .unwrap_or_else(|err| panic!("{err}"))
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        assert!(endpoint.address().ends_with("kit.sock"));
        drop(endpoint);
        assert!(!dir.exists());
    }
}
