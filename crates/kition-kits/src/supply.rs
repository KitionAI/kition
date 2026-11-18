// Copied from kition-sdk crates/kition-kits/src/supply.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Kits installed while serving: a program that keeps a store of kits and knows where to get
//! more (`kition mcp`, with its kit index) hands the manager a [`KitSupply`]
//! ([`crate::KitManager::with_supply`]). When the agent names a file whose kit is not installed,
//! the MCP server (`mcp.rs`) asks the supply to install the kit that opens its extension, adds it
//! to the manager, and tells the client that the tool list changed.

use crate::definitions::{Found, KitDefinition};

/// Why a supply could not install a kit, worded for the agent: what happened and what to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SupplyError {
    /// `unknown-type` (no kit opens the extension), `unavailable` (the index or the download
    /// cannot be reached; trying again later may work), `protocol` (the kit speaks a Kit Process
    /// Protocol this program does not), `off` (automatic installs are turned off), or `failed`.
    pub reason: &'static str,
    pub message: String,
}

impl SupplyError {
    pub fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self { reason, message: message.into() }
    }
}

impl std::fmt::Display for SupplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Where kits that are not installed come from.
pub trait KitSupply: Send + Sync {
    /// The kits that can be installed and are not, each as a definition built from what the
    /// supply knows of it (id, name, extensions; not its `kit.json`, which comes with the kit).
    /// They word the tools that install them; they are never run.
    fn available(&self) -> Vec<&'static KitDefinition>;

    /// Why nothing can be installed, when the supply knows (the index cannot be reached and no
    /// copy of it is kept), for the server's instructions.
    fn unavailable(&self) -> Option<String> {
        None
    }

    /// Whether it installs kits; one that does not (`kition mcp --no-install`) answers how to
    /// install them instead.
    fn installs(&self) -> bool {
        true
    }

    /// Installs the kit that opens `extension` (lowercase, without the dot) and answers it with
    /// its executable. Blocks: the caller runs it off the async runtime.
    fn install(&self, extension: &str) -> Result<Found, SupplyError>;
}
