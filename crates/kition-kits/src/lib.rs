//! Kits in the runtime: native editors that speak the Kit Protocol. The runtime starts them on
//! demand for the open workspace, serves kit tabs over `/kits`, and gives the agent its own
//! connection to them.

pub mod bridge;
pub mod host;
pub mod manager;
pub mod routes;
pub mod surfaces;

pub use bridge::{Bridge, LiveDocument};
pub use manager::{
    Caller, DocumentView, ExecuteView, KITS, KitAgent, KitDefinition, KitError, KitManager,
};
pub use routes::{KitsState, router};
