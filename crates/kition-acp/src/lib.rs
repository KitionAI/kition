//! Kition's agent over the Agent Client Protocol (ACP, protocol version 1; Kition platform D3):
//! an editor or any other ACP client launches `kition-acp` and drives the agent of a running
//! Kition, which keeps its tools, its workspace, and its policies (the kit tools included).
//!
//! The server speaks newline-delimited JSON-RPC 2.0 on stdin and stdout, as ACP agents do, and
//! projects Kition's agent turns, which stream DeepSeek Harness SDK notifications
//! (`session.event`, `agent/assistant-stream`; `POST /v1/agent/sessions/{id}/messages/stream`),
//! onto ACP `session/update` notifications (`translate.rs`).
//!
//! What it serves: `initialize`, `authenticate` (no methods are needed: the runtime is loopback
//! only), `session/new`, `session/prompt` (text, resource links, and embedded text resources),
//! `session/cancel`, and `session/request_permission` when a command needs the person's approval.
//! What it does not: `session/load` (`loadSession: false`), session modes, the client's file
//! system and terminal methods (the agent works on Kition's workspace itself), images and audio
//! in prompts, and MCP servers the client offers in `session/new` (Kition's agent has its own MCP
//! configuration).

pub mod runtime;
pub mod server;
pub mod translate;

/// The ACP protocol version this server speaks.
pub const PROTOCOL_VERSION: u64 = 1;

pub use runtime::{HttpRuntime, Runtime, read_token_file};
pub use server::{Options, serve};
