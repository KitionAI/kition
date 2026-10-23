//! Kits in the runtime: native editors that speak the Kit Protocol. The runtime starts them on
//! demand for the open workspace, serves kit tabs over `/kits`, and gives the agent its own
//! connection to them.

pub mod bridge;
pub mod document_bridge;
pub mod drafts;
pub mod grants;
pub mod host;
pub mod license;
pub mod manager;
pub mod mcp;
pub mod resources;
pub mod routes;
pub mod surfaces;
pub mod tools;

pub use bridge::{Bridge, LiveChange, LiveDocument};
pub use document_bridge::{DocumentApplied, DocumentApply};
pub use manager::{
    Caller, DocumentView, ExecuteView, FileWrite, KITS, KitAgent, KitDefinition, KitError,
    KitManager, SavedFile,
};
pub use routes::{KitsState, router};
