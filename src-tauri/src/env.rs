//! Where the desktop keeps its data. The directory layout matches earlier
//! Kition desktop releases so an existing data directory keeps working after
//! reinstalling.

use std::path::{Path, PathBuf};

use serde::Serialize;

const APP_DIR_NAME: &str = "Kition";
const PROD_PORT: u16 = 18101;
const DEV_PORT: u16 = 18102;

/// The command-line flag that points a process at a separate data directory.
pub const USER_DATA_DIR_FLAG: &str = "--user-data-dir=";

#[derive(Clone, Debug, Serialize)]
pub struct DesktopEnv {
    pub platform: String,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub uploads_dir: PathBuf,
    pub exports_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub sqlite_path: PathBuf,
    pub log_file: PathBuf,
    pub backend_url: String,
    pub backend_port: u16,
}

impl DesktopEnv {
    /// Resolves every directory and creates the ones that are missing.
    pub fn resolve(args: &[String]) -> std::io::Result<Self> {
        let explicit_data_dir = args
            .iter()
            .find_map(|arg| arg.strip_prefix(USER_DATA_DIR_FLAG))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        let workspace_window_profile = !env_value("KITION_DESKTOP_SHARED_DATA_DIR").is_empty();
        let data_dir = explicit_data_dir.unwrap_or_else(default_data_dir);
        let cache_dir = default_cache_dir();
        let logs_dir = if workspace_window_profile {
            data_dir.join("logs")
        } else {
            default_logs_dir(&data_dir)
        };
        let backend_port = backend_port();
        let env = Self {
            platform: platform_name().to_owned(),
            uploads_dir: data_dir.join("uploads"),
            exports_dir: data_dir.join("exports"),
            workspace_dir: data_dir.join("workspace"),
            sqlite_path: data_dir.join("data").join("desktop.db"),
            log_file: logs_dir.join("desktop-api.log"),
            backend_url: format!("http://127.0.0.1:{backend_port}"),
            backend_port,
            data_dir,
            cache_dir,
            logs_dir,
        };
        for dir in [
            &env.data_dir,
            &env.cache_dir,
            &env.logs_dir,
            &env.uploads_dir,
            &env.exports_dir,
            &env.workspace_dir,
            &env.data_dir.join("data"),
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(env)
    }

    pub fn backend_base_url(&self) -> String {
        format!("{}/api", self.backend_url)
    }
}

/// The platform names the renderer already understands.
pub fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

pub fn env_value(key: &str) -> String {
    std::env::var(key).unwrap_or_default().trim().to_owned()
}

pub fn home_dir() -> PathBuf {
    let key = if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    };
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn default_data_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir()
            .join("Library")
            .join("Application Support")
            .join(APP_DIR_NAME)
    } else if cfg!(target_os = "windows") {
        env_dir("APPDATA")
            .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
            .join(APP_DIR_NAME)
    } else {
        env_dir("XDG_CONFIG_HOME")
            .unwrap_or_else(|| home_dir().join(".config"))
            .join(APP_DIR_NAME)
    }
}

fn default_cache_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir().join("Library").join("Caches").join(APP_DIR_NAME)
    } else if cfg!(target_os = "windows") {
        env_dir("LOCALAPPDATA")
            .unwrap_or_else(|| home_dir().join("AppData").join("Local"))
            .join(APP_DIR_NAME)
            .join("Cache")
    } else {
        env_dir("XDG_CACHE_HOME")
            .unwrap_or_else(|| home_dir().join(".cache"))
            .join(APP_DIR_NAME)
    }
}

fn default_logs_dir(data_dir: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home_dir().join("Library").join("Logs").join(APP_DIR_NAME)
    } else {
        data_dir.join("logs")
    }
}

fn backend_port() -> u16 {
    match env_value("KITION_DESKTOP_API_PORT").parse::<u16>() {
        Ok(port) if port > 0 => port,
        _ if cfg!(debug_assertions) => DEV_PORT,
        _ => PROD_PORT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_data_dir_wins() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let flag = format!("{USER_DATA_DIR_FLAG}{}", dir.path().display());
        let env = DesktopEnv::resolve(&[flag]).unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(env.data_dir, dir.path());
        assert_eq!(env.workspace_dir, dir.path().join("workspace"));
        assert_eq!(env.sqlite_path, dir.path().join("data").join("desktop.db"));
        assert!(env.uploads_dir.is_dir());
        assert!(env.backend_base_url().ends_with("/api"));
    }
}
