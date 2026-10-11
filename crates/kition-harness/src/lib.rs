//! The agent harness: an append-only session log, a turn and step driver that
//! derives every model request from that log, tools in the DeepSeek Harness
//! `defineTool` shape with a policy pipeline, and the provider seam through
//! which panes and kits contribute to a turn.

pub mod cancel;
pub mod events;
pub mod schema;

/// The DeepSeek Harness release whose contracts this crate follows (Kit
/// Standard D4). Change it only together with a conformance re-run.
pub const DSH_TARGET: &str = "0.2.1-alpha.2 (d7432673)";
