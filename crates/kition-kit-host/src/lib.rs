//! The host side of the Kit Protocol: launching kit executables, private
//! endpoints, and a request client. Kits run only headless.

pub mod client;
pub mod endpoint;
pub mod process;

pub use client::{ClientError, KitClient};
pub use endpoint::Endpoint;
pub use process::{KitProcess, LaunchError, LaunchOptions};

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
        assert!(
            kition_kit_protocol::launch::is_valid_token(&token),
            "{token}"
        );
        assert_ne!(token, new_token());
    }
}
