// Copied from kition-sdk crates/kition-kits/tests/support/binary.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::path::PathBuf;

/// Find a built workspace binary from any Cargo test executable layout.
pub fn workspace_binary(name: &str) -> Option<PathBuf> {
    let path = std::env::current_exe().ok().and_then(|exe| {
        let name = format!("{name}{}", std::env::consts::EXE_SUFFIX);
        exe.parent()?.ancestors().map(|dir| dir.join(&name)).find(|path| path.is_file())
    });
    assert!(path.is_some() || std::env::var_os("CI").is_none(), "build {name} first (cargo build -p {name})");
    path
}

pub fn mock_binary() -> Option<PathBuf> {
    workspace_binary("kition-kit-mock")
}
