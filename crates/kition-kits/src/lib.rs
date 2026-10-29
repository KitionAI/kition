//! Kits in the runtime: headless kit executables that speak the Kit Protocol. The runtime starts
//! them on demand for the open workspace, serves `/kits` (previews, files, drafts, the Kit AI
//! bridge to the editors in the page), and gives the agent its own connection to them.

pub mod bridge;
pub mod drafts;
pub mod grants;
pub mod license;
pub mod manager;
pub mod mcp;
pub mod resources;
pub mod routes;
pub mod tools;

pub use bridge::{Bridge, LiveChange, LiveDocument};
pub use manager::{
    Caller, DocumentView, ExecuteView, FileWrite, KITS, KitAgent, KitDefinition, KitError,
    KitExport, KitManager, SavedFile,
};
pub use routes::{KitsState, router};
