//! Opening another workspace in its own window. Each workspace window is a
//! separate desktop process with its own data profile and runtime port, so
//! two workspaces never share a runtime.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

use crate::env::USER_DATA_DIR_FLAG;
use crate::workspace::safety::lexical_resolve;

pub const WORKSPACE_WINDOW_FLAG: &str = "--kition-workspace-window";
pub const WORKSPACE_WINDOW_PATH_FLAG: &str = "--kition-workspace-path=";
const PROFILES_DIRECTORY: &str = "workspace-window-profiles";

pub fn encode_path(path: &str) -> String {
    URL_SAFE_NO_PAD.encode(path.as_bytes())
}

pub fn decode_path(encoded: &str) -> String {
    let trimmed = encoded.trim().trim_end_matches('=');
    URL_SAFE_NO_PAD
        .decode(trimmed)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map(|path| path.trim().to_owned())
        .unwrap_or_default()
}

/// The workspace a workspace-window process was started for.
pub fn read_request(args: &[String]) -> Option<String> {
    if !args.iter().any(|arg| arg == WORKSPACE_WINDOW_FLAG) {
        return None;
    }
    let encoded = args
        .iter()
        .find_map(|arg| arg.strip_prefix(WORKSPACE_WINDOW_PATH_FLAG))
        .unwrap_or_default();
    let path = decode_path(encoded);
    (!path.is_empty()).then_some(path)
}

fn absolute(path: &str) -> PathBuf {
    let path = Path::new(path);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    lexical_resolve(&joined)
}

pub fn profile_path(shared_data_dir: &Path, workspace_path: &str) -> PathBuf {
    let digest = Sha256::digest(absolute(workspace_path).to_string_lossy().as_bytes());
    shared_data_dir
        .join(PROFILES_DIRECTORY)
        .join(&hex::encode(digest)[..16])
}

fn reserve_loopback_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

pub fn launch_args(profile: &Path, workspace_path: &str) -> Vec<String> {
    vec![
        format!("{USER_DATA_DIR_FLAG}{}", profile.display()),
        WORKSPACE_WINDOW_FLAG.to_owned(),
        format!(
            "{WORKSPACE_WINDOW_PATH_FLAG}{}",
            encode_path(workspace_path)
        ),
    ]
}

/// Starts a detached desktop process for `workspace_path`.
pub fn open(workspace_path: &str, shared_data_dir: &Path) -> std::io::Result<u16> {
    let requested = workspace_path.trim();
    if requested.is_empty() || shared_data_dir.as_os_str().is_empty() {
        return Err(std::io::Error::other(
            "workspace path and shared data directory are required",
        ));
    }
    let normalized = absolute(requested).to_string_lossy().into_owned();
    let profile = profile_path(shared_data_dir, &normalized);
    std::fs::create_dir_all(&profile)?;
    let port = reserve_loopback_port()?;
    if port == 0 {
        return Err(std::io::Error::other(
            "failed to reserve a backend port for the workspace window",
        ));
    }
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command
        .args(launch_args(&profile, &normalized))
        .env("KITION_DESKTOP_API_PORT", port.to_string())
        .env("KITION_DESKTOP_SHARED_DATA_DIR", shared_data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn()?;
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_the_launch_request() {
        let profile = profile_path(Path::new("/data"), "/Users/alice/Notes");
        assert!(profile.starts_with("/data/workspace-window-profiles"));
        let args = launch_args(&profile, "/Users/alice/Notes");
        assert_eq!(read_request(&args).as_deref(), Some("/Users/alice/Notes"));
        assert_eq!(read_request(&args[..1]), None);
        assert_eq!(decode_path(&format!("{}==", encode_path("/a"))), "/a");
    }
}
