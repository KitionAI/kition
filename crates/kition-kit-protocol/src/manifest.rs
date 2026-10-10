//! The `kit.json` manifest shipped at the root of every kit package
//! (`contracts/kit/kit-manifest.schema.json`).

use serde::{Deserialize, Serialize};

use crate::launch::Surface;
use crate::types::Mechanism;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KitManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub version: String,
    pub publisher: String,
    pub kit_protocol: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_host_version: Option<String>,
    /// SPDX license expression for the kit package.
    pub license: String,
    /// Upstream projects included in the kit. Upstream product names appear only here.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attribution: Vec<Attribution>,
    /// Package-relative path to the kit executable, without the `.exe` suffix.
    pub executable: String,
    pub file_types: Vec<FileType>,
    pub surfaces: Vec<Surface>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Embedding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web: Option<WebEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<Permissions>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentMetadata>,
}

impl KitManifest {
    /// The kit that opens files with this extension (case-insensitive), if any.
    pub fn file_type_for_extension(&self, extension: &str) -> Option<&FileType> {
        let extension = extension.to_ascii_lowercase();
        self.file_types
            .iter()
            .find(|file_type| file_type.extensions.contains(&extension))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attribution {
    pub name: String,
    pub url: String,
    pub license: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileRole {
    Editor,
    Viewer,
    Importer,
    Exporter,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileType {
    /// Kit-local format identifier used in `document.*` methods.
    pub format: String,
    pub extensions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mime_types: Vec<String>,
    pub roles: Vec<FileRole>,
    /// Offer this kit as the default handler for these extensions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Embedding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub macos: Option<Vec<Mechanism>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<Vec<Mechanism>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linux: Option<Vec<Mechanism>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebEntry {
    pub entry: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NetworkPermission {
    /// Only `false` is valid: no network access.
    Denied(bool),
    Hosts(Vec<String>),
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Permissions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<NetworkPermission>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMetadata {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_groups: Vec<ToolGroup>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolGroup {
    pub id: String,
    pub title: String,
    pub description: String,
}
