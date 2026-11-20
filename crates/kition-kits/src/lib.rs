// Copied from kition-sdk crates/kition-kits/src/lib.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Kition's kits: each found from its KHP manifest (`definitions.rs`) with its headless executable,
//! which speaks the Kit Process Protocol. A manager starts them on demand for one workspace and gives
//! the agent its own connection to them; the KHP agent tools (`tools.rs`) and the kits' MCP server
//! (`mcp.rs`, `kition-kits-mcp`) are built on it. Kition and `kition gateway` serve it over HTTP in `kition-kits-http`;
//! a host in another language runs it as `kition-kits serve` (`serve.rs`, the Kits Service API).

pub mod bridge;
pub mod cli;
pub mod control;
pub mod definitions;
pub mod drafts;
pub mod manager;
pub mod mcp;
pub mod resources;
pub mod serve;
pub mod supply;
pub mod tools;

pub use bridge::{Bridge, LiveChange, LiveDocument};

/// A worker thread's stack in the runtimes the kits' executables start: a tool call goes through
/// many nested async calls whose frames, in an unoptimized build, outgrow Tokio's default.
pub const WORKER_STACK: usize = 8 * 1024 * 1024;

/// The multi-threaded runtime `kition-kits` and `kition-kits-mcp` run on, with `WORKER_STACK`.
pub fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread().thread_stack_size(WORKER_STACK).enable_all().build()
}
pub use manager::{
    Caller, DocumentView, ExecuteView, FileWrite, KitAgent, KitDefinition, KitError, KitExport, KitManager, KitSources, PreviewRequest, SavedFile,
};
