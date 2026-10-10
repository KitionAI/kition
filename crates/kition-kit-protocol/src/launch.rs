//! Process launch contract and timeouts (protocol sections 3 and 11).

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::PROTOCOL_VERSION;

/// The single argument the host passes to a kit executable.
pub const LAUNCH_ARG: &str = "--kition-kit";

pub const ENV_PROTOCOL: &str = "KITION_KIT_PROTOCOL";
pub const ENV_ENDPOINT: &str = "KITION_KIT_ENDPOINT";
pub const ENV_TOKEN: &str = "KITION_KIT_TOKEN";
pub const ENV_SURFACE: &str = "KITION_KIT_SURFACE";

pub const READY_TIMEOUT: Duration = Duration::from_secs(10);
pub const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(10);
pub const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const PING_INTERVAL: Duration = Duration::from_secs(15);
/// Consecutive failed pings after which the host treats the kit as hung.
pub const PING_FAILURE_LIMIT: u32 = 3;

/// The default response deadline for a request. `document.*` and
/// `commands.execute` report progress instead and have no fixed limit.
pub fn request_timeout(method: &str) -> Option<Duration> {
    if method.starts_with("document.") || method == "commands.execute" {
        None
    } else if method == "kit.initialize" {
        Some(INITIALIZE_TIMEOUT)
    } else {
        Some(REQUEST_TIMEOUT)
    }
}

/// Where a kit renders.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Surface {
    Embedded,
    Window,
    Web,
    Headless,
}

impl Surface {
    /// The `KITION_KIT_SURFACE` value. `web` never launches a process.
    pub fn as_env(self) -> &'static str {
        match self {
            Self::Embedded => "embedded",
            Self::Window => "window",
            Self::Web => "web",
            Self::Headless => "headless",
        }
    }

    /// Parses a `KITION_KIT_SURFACE` value.
    pub fn from_env(value: &str) -> Option<Self> {
        match value {
            "embedded" => Some(Self::Embedded),
            "window" => Some(Self::Window),
            "headless" => Some(Self::Headless),
            _ => None,
        }
    }
}

/// The one line a kit writes to standard output once its endpoint listens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadyLine {
    pub protocol_version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReadyLine {
    #[serde(rename = "type")]
    kind: String,
    protocol_version: u32,
}

impl Default for ReadyLine {
    fn default() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
        }
    }
}

impl ReadyLine {
    /// Parses a line read from a kit's standard output.
    pub fn parse(line: &str) -> Option<Self> {
        let raw: RawReadyLine = serde_json::from_str(line.trim_end()).ok()?;
        (raw.kind == "ready").then_some(Self {
            protocol_version: raw.protocol_version,
        })
    }

    /// The exact line, newline included, a kit prints.
    pub fn to_line(&self) -> String {
        format!(
            "{{\"type\":\"ready\",\"protocolVersion\":{}}}\n",
            self.protocol_version
        )
    }
}

/// Whether a token has the launch format: 64 lowercase hexadecimal characters.
pub fn is_valid_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_line_matches_the_documented_bytes() {
        let line = ReadyLine::default().to_line();
        assert_eq!(line, "{\"type\":\"ready\",\"protocolVersion\":1}\n");
        assert_eq!(ReadyLine::parse(&line), Some(ReadyLine::default()));
        assert_eq!(
            ReadyLine::parse(r#"{"type":"other","protocolVersion":1}"#),
            None
        );
        assert_eq!(ReadyLine::parse("ready"), None);
    }

    #[test]
    fn timeouts_follow_section_eleven() {
        assert_eq!(request_timeout("document.open"), None);
        assert_eq!(request_timeout("commands.execute"), None);
        assert_eq!(request_timeout("kit.initialize"), Some(INITIALIZE_TIMEOUT));
        assert_eq!(request_timeout("view.screenshot"), Some(REQUEST_TIMEOUT));
    }

    #[test]
    fn validates_tokens() {
        assert!(is_valid_token(&"a1".repeat(32)));
        assert!(!is_valid_token(&"A1".repeat(32)));
        assert!(!is_valid_token("abc"));
    }

    #[test]
    fn surface_env_round_trip() {
        for surface in [Surface::Embedded, Surface::Window, Surface::Headless] {
            assert_eq!(Surface::from_env(surface.as_env()), Some(surface));
        }
        assert_eq!(Surface::from_env("web"), None);
    }
}
