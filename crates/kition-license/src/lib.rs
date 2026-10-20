// Copied from kition-sdk crates/kition-license/src/lib.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! # kition-license
//!
//! Offline licence keys for Kition's kits as an SDK (docs/licence.md). A key is
//! `base64url(payload JSON) "." base64url(Ed25519 signature)`, the signature taken over the ASCII
//! bytes of the first segment. Kition Console signs keys; this crate verifies them against public
//! keys pinned in code by key id, with no network, so every delivery form (embed, script,
//! headless, MCP) decides the same way. `@kition/license` is the TypeScript twin, held to the same
//! answers by `tests/vectors.json`.
//!
//! ```
//! use kition_license::{Context, Form, verify, PINNED_KEYS};
//!
//! let context = Context { kit: Some("kit.slide"), form: Form::Mcp, origin: None, app_id: None, now: 1_800_000_000 };
//! assert!(verify("not-a-key", PINNED_KEYS, &context).is_err());
//! ```
#![no_std]
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

/// The payload version this crate reads.
pub const VERSION: u32 = 1;

/// A public key Kition Console signs with, named by the payload's `kid`.
#[derive(Clone, Copy, Debug)]
pub struct PublicKey {
    pub kid: &'static str,
    /// The raw 32-byte Ed25519 public key.
    pub key: [u8; 32],
}

/// The production signing keys, by key id. A new key is added here (and in `@kition/license`)
/// before Console signs with it; a retired key stays until every key it signed has expired.
/// Empty until the owner generates the production key pair (docs/licence.md, section 6).
pub const PINNED_KEYS: &[PublicKey] = &[];

/// How the kits are delivered: the licence names the forms it covers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
    /// `@kition/embed` in a web page.
    Embed,
    /// `@kition/sdk` scripts, in a page or in Node.
    Script,
    /// The kits' headless executables.
    Headless,
    /// `kition-kits-mcp` and other MCP serving of the kits.
    Mcp,
}

impl Form {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Embed => "embed",
            Self::Script => "script",
            Self::Headless => "headless",
            Self::Mcp => "mcp",
        }
    }
}

/// Which kits a licence covers: all (`"*"`) or the listed ids (`kit.slide`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Kits {
    All(String),
    Only(Vec<String>),
}

impl Kits {
    pub fn covers(&self, kit: &str) -> bool {
        match self {
            Self::All(all) => all == "*",
            Self::Only(kits) => kits.iter().any(|k| k == kit),
        }
    }
}

/// A licence's claims (the payload).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct License {
    pub v: u32,
    pub kid: String,
    pub licensee: String,
    pub kits: Kits,
    /// `embed`, `script`, `headless`, `mcp`.
    pub forms: Vec<String>,
    /// Web origins the embed may run on (`https://app.example.com`, `https://*.example.com`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub origins: Vec<String>,
    /// Application ids the integrator states outside the web (script, headless, MCP).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub app_ids: Vec<String>,
    /// Unix seconds.
    pub issued: u64,
    /// Unix seconds; the licence is valid while `now < expires`.
    pub expires: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seats: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Where the kits run, as a licence is checked against it.
#[derive(Clone, Copy, Debug)]
pub struct Context<'a> {
    /// The kit in use; `None` checks the licence without a kit (a server's start).
    pub kit: Option<&'a str>,
    pub form: Form,
    /// The page's origin, for the embed.
    pub origin: Option<&'a str>,
    /// The application id the integrator states, when the licence binds application ids.
    pub app_id: Option<&'a str>,
    /// Unix seconds.
    pub now: u64,
}

/// Why a key does not license a context. `code()` is shared with `@kition/license`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// Not two base64url segments, or the payload is not a licence.
    Malformed,
    /// A payload version this crate does not read.
    Version,
    /// No pinned key has the payload's `kid`.
    UnknownKey,
    /// The signature does not match.
    Signature,
    Expired,
    /// The licence does not cover the kit.
    Kit,
    /// The licence does not cover the delivery form.
    Form,
    /// The embed's origin is not among the licence's origins.
    Origin,
    /// The application id is not among the licence's application ids.
    App,
}

impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::Version => "version",
            Self::UnknownKey => "unknown-key",
            Self::Signature => "signature",
            Self::Expired => "expired",
            Self::Kit => "kit",
            Self::Form => "form",
            Self::Origin => "origin",
            Self::App => "app",
        }
    }
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let text = match self {
            Self::Malformed => "the licence key is malformed",
            Self::Version => "the licence key has a version this SDK does not read",
            Self::UnknownKey => "the licence key was signed with a key this SDK does not know",
            Self::Signature => "the licence key's signature does not match",
            Self::Expired => "the licence has expired",
            Self::Kit => "the licence does not cover this kit",
            Self::Form => "the licence does not cover this delivery form",
            Self::Origin => "the licence does not cover this web origin",
            Self::App => "the licence does not cover this application id",
        };
        f.write_str(text)
    }
}

/// The payload of `token` without checking its signature (to show who a key names).
pub fn decode(token: &str) -> Result<License, Error> {
    let (payload, _) = split(token)?;
    parse(payload)
}

/// Verifies `token` against `keys` and checks it covers `context`; the licence when it does.
pub fn verify(token: &str, keys: &[PublicKey], context: &Context<'_>) -> Result<License, Error> {
    let (payload, signature) = split(token.trim())?;
    let license = parse(payload)?;
    if license.v != VERSION {
        return Err(Error::Version);
    }
    let key = keys.iter().find(|key| key.kid == license.kid).ok_or(Error::UnknownKey)?;
    let key = VerifyingKey::from_bytes(&key.key).map_err(|_| Error::UnknownKey)?;
    let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| Error::Malformed)?;
    let signature = Signature::from_slice(&signature).map_err(|_| Error::Malformed)?;
    key.verify_strict(payload.as_bytes(), &signature).map_err(|_| Error::Signature)?;
    if context.now >= license.expires {
        return Err(Error::Expired);
    }
    if context.kit.is_some_and(|kit| !license.kits.covers(kit)) {
        return Err(Error::Kit);
    }
    if !license.forms.iter().any(|form| form == context.form.as_str()) {
        return Err(Error::Form);
    }
    if context.form == Form::Embed {
        // An embed licence always names its origins: a key is not usable on any site.
        let origin = context.origin.ok_or(Error::Origin)?;
        if !license.origins.iter().any(|pattern| origin_matches(pattern, origin)) {
            return Err(Error::Origin);
        }
    } else if !license.app_ids.is_empty() && !context.app_id.is_some_and(|app| license.app_ids.iter().any(|id| id == app)) {
        return Err(Error::App);
    }
    Ok(license)
}

/// Whether `origin` (`scheme://host[:port]`, as `location.origin` gives it) is `pattern`: the same
/// origin, or for `scheme://*.domain[:port]` any subdomain of `domain` (not `domain` itself).
pub fn origin_matches(pattern: &str, origin: &str) -> bool {
    let pattern = pattern.trim().trim_end_matches('/').to_ascii_lowercase();
    let origin = origin.trim().trim_end_matches('/').to_ascii_lowercase();
    let (Some((p_scheme, p_rest)), Some((o_scheme, o_rest))) = (pattern.split_once("://"), origin.split_once("://")) else {
        return false;
    };
    if p_scheme != o_scheme {
        return false;
    }
    match p_rest.strip_prefix("*.") {
        None => p_rest == o_rest,
        Some(domain) => {
            let (p_host, p_port) = host_port(domain);
            let (o_host, o_port) = host_port(o_rest);
            p_port == o_port && o_host.len() > p_host.len() + 1 && o_host.ends_with(p_host) && o_host.as_bytes()[o_host.len() - p_host.len() - 1] == b'.'
        }
    }
}

/// Whether `origin` is a development one, where the kits run without a licence: `localhost` and
/// its subdomains, the loopback addresses, and files (`null` or `file://`).
pub fn is_development_origin(origin: &str) -> bool {
    let origin = origin.trim().to_ascii_lowercase();
    if origin == "null" || origin.starts_with("file://") {
        return true;
    }
    let Some(rest) = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")) else {
        return false;
    };
    let (host, _) = host_port(rest.trim_end_matches('/'));
    host == "localhost" || host.ends_with(".localhost") || host == "[::1]" || is_loopback_v4(host)
}

fn is_loopback_v4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4 && parts[0] == "127" && parts.iter().all(|part| !part.is_empty() && part.len() <= 3 && part.bytes().all(|b| b.is_ascii_digit()))
}

fn host_port(rest: &str) -> (&str, &str) {
    if rest.starts_with('[') {
        return match rest.find("]:") {
            Some(end) => (&rest[..=end], &rest[end + 2..]),
            None => (rest, ""),
        };
    }
    rest.split_once(':').unwrap_or((rest, ""))
}

fn split(token: &str) -> Result<(&str, &str), Error> {
    let (payload, signature) = token.split_once('.').ok_or(Error::Malformed)?;
    if payload.is_empty() || signature.is_empty() || signature.contains('.') {
        return Err(Error::Malformed);
    }
    Ok((payload, signature))
}

fn parse(payload: &str) -> Result<License, Error> {
    let json = URL_SAFE_NO_PAD.decode(payload).map_err(|_| Error::Malformed)?;
    let license: License = serde_json::from_slice(&json).map_err(|_| Error::Malformed)?;
    if matches!(&license.kits, Kits::All(all) if all != "*") || license.issued > license.expires {
        return Err(Error::Malformed);
    }
    Ok(license)
}
