// Copied from kition-sdk crates/kition-kits/src/bin/kition-kits.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `kition-kits`: the Kits Service API for hosts in any language (`kition_kits::cli::serve`).

fn main() -> std::process::ExitCode {
    kition_kits::cli::serve::main("kition-kits", std::env::args().skip(1), None)
}
