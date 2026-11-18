//! Access to the signed-in Kition Cloud account.

use std::sync::Arc;

/// Error text when no cloud account is signed in.
pub const NOT_LOGGED_IN: &str = "kition_console_login_required";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudSession {
    /// Without a trailing slash.
    pub base_url: String,
    pub access_token: String,
}

/// Resolves the current cloud session, or explains why there is none.
pub type CloudSessionProvider = Arc<dyn Fn() -> Result<CloudSession, String> + Send + Sync>;

/// A provider for when no cloud account can be signed in.
pub fn signed_out() -> CloudSessionProvider {
    Arc::new(|| Err(NOT_LOGGED_IN.to_owned()))
}
