// Copied from kition-sdk crates/kition-kits/src/lib.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Kition's kits: each found from its KHP manifest (`definitions.rs`) with its headless executable,
//! which speaks the Kit Host Protocol. A manager starts them on demand for one workspace and gives
//! the agent its own connection to them; the KHP agent tools (`tools.rs`) and the kits' MCP server
//! (`mcp.rs`, `kition-kits-mcp`) are built on it. Kition serves it over HTTP in `kition-kits-http`.

pub mod bridge;
pub mod definitions;
pub mod drafts;
pub mod grants;
pub mod license;
pub mod manager;
pub mod mcp;
pub mod resources;
pub mod tools;

pub use bridge::{Bridge, LiveChange, LiveDocument};
pub use manager::{Caller, DocumentView, ExecuteView, FileWrite, KitAgent, KitDefinition, KitError, KitExport, KitManager, KitSources, SavedFile};
