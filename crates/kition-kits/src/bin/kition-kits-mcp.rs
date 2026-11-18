// Copied from kition-sdk crates/kition-kits/src/bin/kition-kits-mcp.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `kition-kits-mcp`: the kits' stdio MCP server (`kition_kits::cli::mcp`).

fn main() -> std::process::ExitCode {
    kition_kits::cli::mcp::main("kition-kits-mcp", std::env::args().skip(1), None)
}
