//! The signed kit index (`contracts/kit/kit-index.schema.json`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KitIndex {
    pub schema_version: u32,
    /// RFC 3339 timestamp; the host rejects an index older than its cached one.
    pub generated_at: String,
    pub kits: Vec<KitEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KitEntry {
    pub id: String,
    pub name: String,
    /// Shipped inside the Kition installer; never downloaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_in: Option<bool>,
    pub versions: Vec<KitVersion>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KitVersion {
    pub version: String,
    pub kit_protocol: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_host_version: Option<String>,
    pub release_tag: String,
    /// Keyed by target, for example `darwin-arm64` or `win32-x64`.
    pub assets: BTreeMap<String, Asset>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asset {
    pub name: String,
    pub sha256: String,
    pub size: u64,
}

/// The index target key for the platform this crate is compiled for, if it
/// is one kits are published for.
pub fn current_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("windows", "x86_64") => Some("win32-x64"),
        ("windows", "aarch64") => Some("win32-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}
