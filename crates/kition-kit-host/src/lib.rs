// Copied from kition-sdk crates/kition-kit-host/src/lib.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The host side of the Kit Process Protocol, version 2: launching kit
//! executables, private endpoints, a request client, the host's file services
//! (`files`, [`KitFiles`]), and [`HeadlessKit`], a kit launched and initialized
//! as the host in one call. Kits run only headless.
//!
//! The protocol itself is `kition-kit-process-protocol`, the one definition kits share
//! (through `kition-kit-server`), re-exported here as [`protocol`].

pub mod client;
pub mod endpoint;
pub mod files;
pub mod headless;
pub mod kit_files;
pub mod process;

pub use client::{ClientError, KitClient};
pub use endpoint::Endpoint;
pub use headless::{HOST_PRINCIPAL, HeadlessKit};
pub use kit_files::{HostService, KitFiles, file_error};
pub use kition_kit_process_protocol as protocol;
pub use process::{KitProcess, KitStderr, LaunchError, LaunchOptions};
pub use protocol::PROTOCOL_VERSION;
pub use protocol::launch::LAUNCH_ARG;

/// A fresh launch token: 32 random bytes as 64 lowercase hex characters.
pub fn new_token() -> String {
    hex::encode(rand::random::<[u8; 32]>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_have_the_launch_format() {
        let token = new_token();
        assert!(kition_kit_process_protocol::launch::is_valid_token(&token), "{token}");
        assert_ne!(token, new_token());
    }
}
