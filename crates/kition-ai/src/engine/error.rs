//! Errors from model calls. Provider errors carry the retry decision, and
//! a credits-exhausted error stays detectable through any wrapping.

use std::fmt;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum AiError {
    /// The request needs a signed-in Kition Cloud account.
    NotLoggedIn,
    /// Kition Cloud does not generate video.
    VideoNotSupported,
    /// Kition Cloud reported HTTP 402.
    CreditsExhausted {
        message: String,
        code: String,
        topup_url: String,
    },
    /// An upstream failure, with whether retrying may help.
    Provider {
        message: String,
        retryable: bool,
        reason: String,
        retry_after: Duration,
    },
    /// Context added around another error.
    Wrapped {
        message: String,
        source: Box<AiError>,
    },
    Message(String),
}

pub type AiResult<T> = Result<T, AiError>;

impl AiError {
    pub fn msg(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }

    /// `prefix: <self>`, keeping `self` reachable for inspection.
    pub fn wrap(self, prefix: &str) -> Self {
        Self::Wrapped {
            message: format!("{prefix}: {self}"),
            source: Box::new(self),
        }
    }

    /// The credits-exhausted details anywhere in the chain.
    pub fn credits_exhausted(&self) -> Option<(&str, &str, &str)> {
        match self {
            Self::CreditsExhausted {
                message,
                code,
                topup_url,
            } => Some((message, code, topup_url)),
            Self::Wrapped { source, .. } => source.credits_exhausted(),
            _ => None,
        }
    }

    /// Whether a retry may succeed, why, and how long the provider asked to
    /// wait.
    pub fn retry_info(&self) -> (bool, &str, Duration) {
        match self {
            Self::Provider {
                retryable,
                reason,
                retry_after,
                ..
            } => (*retryable, reason, *retry_after),
            _ => (false, "", Duration::ZERO),
        }
    }

    pub fn is_not_logged_in(&self) -> bool {
        match self {
            Self::NotLoggedIn => true,
            Self::Wrapped { source, .. } => source.is_not_logged_in(),
            _ => false,
        }
    }
}

impl fmt::Display for AiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotLoggedIn => f.write_str("kition_console_login_required"),
            Self::VideoNotSupported => f.write_str("video_not_supported_in_cloud"),
            Self::CreditsExhausted { message, .. }
            | Self::Provider { message, .. }
            | Self::Wrapped { message, .. }
            | Self::Message(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for AiError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credits_survive_wrapping() {
        let error = AiError::CreditsExhausted {
            message: "out".into(),
            code: "credits_exhausted".into(),
            topup_url: "https://x".into(),
        }
        .wrap("image generation is unavailable for this model");
        assert_eq!(
            error.to_string(),
            "image generation is unavailable for this model: out"
        );
        assert_eq!(
            error.credits_exhausted(),
            Some(("out", "credits_exhausted", "https://x"))
        );
        assert!(AiError::NotLoggedIn.wrap("x").is_not_logged_in());
    }
}
