//! Build identity reported by `/desktop/runtime`.
//!
//! Values are injected at compile time through `KITION_RUNTIME_VERSION`,
//! `KITION_PROTOCOL_VERSION`, and `KITION_BUILD_COMMIT`.

use serde::Serialize;

/// Version 2: every timestamp is Unix milliseconds.
pub const DEFAULT_PROTOCOL_VERSION: i64 = 2;

/// Capability flags advertised by `/desktop/runtime`.
pub const CAPABILITIES: [&str; 12] = [
    "agent",
    "agent_design_v1",
    "agent_image_generation_v1",
    "agent_image_generation_chat_v1",
    "agent_whiteboard_v1",
    "documents",
    "email_sync",
    "email_sync_runs",
    "form_sync",
    "tables",
    "workflow",
    "workspace_portable_storage_v1",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BuildInfo {
    pub runtime_version: String,
    pub protocol_version: i64,
    pub build_commit: String,
}

/// Build identity of this binary. `config_version` is used when no version
/// was injected at build time.
pub fn current(config_version: &str) -> BuildInfo {
    resolve(
        option_env!("KITION_RUNTIME_VERSION"),
        option_env!("KITION_PROTOCOL_VERSION"),
        option_env!("KITION_BUILD_COMMIT"),
        config_version,
    )
}

fn resolve(
    version: Option<&str>,
    protocol: Option<&str>,
    commit: Option<&str>,
    config_version: &str,
) -> BuildInfo {
    let non_empty = |value: Option<&str>| {
        value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let runtime_version = non_empty(version)
        .or_else(|| non_empty(Some(config_version)))
        .unwrap_or_else(|| "dev".to_owned());
    let protocol_version = protocol
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_PROTOCOL_VERSION);
    let build_commit = non_empty(commit).unwrap_or_else(|| "dev".to_owned());
    BuildInfo {
        runtime_version,
        protocol_version,
        build_commit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_build_values() {
        let info = resolve(Some("1.2.3"), Some("4"), Some("abc123"), "config");
        assert_eq!(info.runtime_version, "1.2.3");
        assert_eq!(info.protocol_version, 4);
        assert_eq!(info.build_commit, "abc123");
    }

    #[test]
    fn falls_back_like_legacy_runtime() {
        let info = resolve(None, Some("0"), Some(" "), " 2.0.0 ");
        assert_eq!(info.runtime_version, "2.0.0");
        assert_eq!(info.protocol_version, DEFAULT_PROTOCOL_VERSION);
        assert_eq!(info.build_commit, "dev");
        assert_eq!(resolve(None, None, None, "").runtime_version, "dev");
    }
}
