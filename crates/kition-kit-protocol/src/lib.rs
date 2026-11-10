// Copied from kition-sdk crates/kition-kit-protocol/src/lib.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Kit Host Protocol, version 2.
//!
//! The wire contract between the Kition host and kits, the native executables
//! that open and edit one family of documents, defined once for both sides:
//! hosts use it through `kition-kit-host`, kits through `kition-kit-server`,
//! each of which re-exports it as `protocol`. The Kition platform's
//! `docs/platform/reference/kit-protocol.md` describes the behavior and `contracts/kit/kit-protocol.schema.json` is the schema these types mirror; when
//! they disagree, the schemas win.
//!
//! This crate has no async runtime dependency so that kits built on plain
//! threads can use it. The `tokio` feature adds async framing and the local
//! socket transport.

pub mod base64;
pub mod error;
pub mod framing;
pub mod jsonrpc;
pub mod launch;
pub mod methods;
#[cfg(feature = "tokio")]
pub mod transport;
pub mod types;

pub use error::{ErrorData, ErrorReason, InvalidParam, RpcError};
pub use jsonrpc::{Message, Notification, Request, RequestId, Response};
pub use methods::{HostServiceMethod, NotificationMethod, RequestMethod};
pub use types::*;

/// The protocol version this crate implements.
pub const PROTOCOL_VERSION: u32 = 2;
