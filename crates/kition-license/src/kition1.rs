// Copied from kition-sdk crates/kition-license/src/kition1.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! `KITION1` licences: the one licence format of Kition One and Kition Server
//! (docs/platform/licence-format.md). Nothing else Kition makes is licensed.
//!
//! A token is `KITION1.<base64url(payload)>.<base64url(signature)>`: the payload is the licence as
//! canonical JSON (object keys sorted, no whitespace) and the signature is Ed25519 over the exact
//! payload bytes (the decoded JSON, not the base64 text). Verification is offline, against public
//! keys compiled in by `kid`; the verifier never re-serializes the JSON.
//!
//! A licence carries seats and dates only: no feature list, no machine or version binding.
//! [`verify_pinned`] checks who signed it and gives a [`Verified`] licence; [`status`] turns the
//! verified licences installed (none, one, or a licence and its renewal), the time and the current
//! usage into what the product shows and enforces, including [`Status::collab_limit`].
//!
//! Which licences a build accepts is fixed when it is compiled: production licences only, signed
//! by [`PROD_KEYS`]. The `test-licences` cargo feature (off by default; never in a release) adds
//! [`TEST_KEYS`] and accepts `env: "test"` licences.
//!
//! ```
//! use kition_license::kition1::{Product, status, verify_pinned};
//!
//! assert!(verify_pinned("not-a-licence", Product::One).is_err());
//! // No licence: the free rule, at most 8 concurrent co-editors.
//! assert_eq!(status(Product::Server, &[], 1_800_000_000, 3).collab_limit(), Some(8));
//! ```

use alloc::string::String;
use alloc::vec::Vec;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

/// The token prefix, which also names the format's version.
pub const PREFIX: &str = "KITION1.";
/// The payload version this module reads.
pub const VERSION: u32 = 1;
/// Grace days after `expires_at` when a payload names none.
pub const DEFAULT_GRACE_DAYS: u32 = 14;
/// What runs without a valid licence: 8 users in One, 8 concurrent co-editors in Server.
pub const FREE_LIMIT: u32 = 8;
/// Days before expiry at which One reminds (each a new, separately dismissible stage).
pub const ONE_REMINDERS: &[u32] = &[60, 30, 7];
/// Days before expiry at which Server starts reminding.
pub const SERVER_REMINDERS: &[u32] = &[30];

/// The longest token read; longer input is refused before it is decoded.
pub const MAX_TOKEN_LEN: usize = 8 * 1024;
/// The longest `lid` or `kid`.
pub const MAX_ID_LEN: usize = 64;

const DAY: u64 = 86_400;
/// Whether this build accepts `env: "test"` licences (the `test-licences` feature).
const ACCEPTS_TEST: bool = cfg!(feature = "test-licences");

/// The product a licence is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Product {
    /// Kition One, licensed by users (`seats`).
    One,
    /// Kition Server, licensed by company size (`tier`, `employees`).
    Server,
}

impl Product {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::One => "one",
            Self::Server => "server",
        }
    }

    /// The days before expiry at which the product reminds, largest first.
    pub fn reminders(self) -> &'static [u32] {
        match self {
            Self::One => ONE_REMINDERS,
            Self::Server => SERVER_REMINDERS,
        }
    }
}

/// Which signing environment a licence (and a key) belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Env {
    /// Licences sold and issued to customers; the only ones a production build accepts.
    Prod,
    /// Licences for development, CI and staging, signed with the test key.
    Test,
}

/// Kition Server's plan (the product and business model, section 6.1, in the planning repository).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// Companies of up to 8 employees, open-source projects, development and test (yearly, free).
    Free,
    /// Companies of 9 to 200 employees.
    Business,
    /// Over 200 employees, or SLA and procurement.
    Enterprise,
}

/// Who the licence is for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Customer {
    // Fields in key order, so serializing is canonical.
    pub email: String,
    pub org: String,
}

/// A licence (the payload). Fields are declared in key order, so [`encode_payload`] writes
/// canonical JSON whatever serde_json's features are.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Licence {
    pub customer: Customer,
    /// Server: the company's self-reported employee band (`"1-8"`, `"9-200"`, `"201+"`),
    /// informational; none in One.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub employees: Option<String>,
    pub env: Env,
    /// Unix seconds; the term ends here and grace begins.
    pub expires_at: u64,
    /// Days after `expires_at` that run as if licensed.
    #[serde(default = "default_grace_days")]
    pub grace_days: u32,
    /// Unix seconds.
    pub issued_at: u64,
    /// The signing key's id.
    pub kid: String,
    /// The licence id, unique per issued licence (a renewal is a new `lid`).
    pub lid: String,
    pub product: Product,
    /// One: licensed users in total, the 8 free included, so more than 8; none in Server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seats: Option<u32>,
    /// Unix seconds; before this the licence does not apply yet.
    pub starts_at: u64,
    /// Server: the plan; none in One.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<Tier>,
    pub v: u32,
}

fn default_grace_days() -> u32 {
    DEFAULT_GRACE_DAYS
}

impl Licence {
    /// Unix seconds at which grace ends and the licence no longer applies.
    pub fn grace_ends_at(&self) -> u64 {
        self.expires_at.saturating_add(u64::from(self.grace_days) * DAY)
    }
}

/// A public key Kition Console signs with.
#[derive(Clone, Copy, Debug)]
pub struct PublicKey {
    pub kid: &'static str,
    /// The environment of the licences this key signs; a key signs only its own.
    pub env: Env,
    /// The raw 32-byte Ed25519 public key.
    pub key: [u8; 32],
}

/// The production signing keys (every one `env: Prod`). A key is added here before Console signs
/// with it and stays until every licence it signed is past grace. Empty until the owner
/// generates the key pair (docs/platform/licence-format.md, section 5); the private half never
/// enters a repository.
pub const PROD_KEYS: &[PublicKey] = &[];

/// The test signing keys (every one `env: Test`), compiled only with the `test-licences` feature:
/// a release binary holds no test key.
#[cfg(feature = "test-licences")]
pub const TEST_KEYS: &[PublicKey] = &[];

/// A licence whose signature this build checked: only [`verify`] and [`verify_pinned`] make one,
/// and only verified licences reach [`status`]. Read it through `Deref` or `as_ref`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified(Licence);

impl core::ops::Deref for Verified {
    type Target = Licence;
    fn deref(&self) -> &Licence {
        &self.0
    }
}

impl AsRef<Licence> for Verified {
    fn as_ref(&self) -> &Licence {
        &self.0
    }
}

/// A licence read without checking its signature ([`decode`]): what a pasted token claims, not
/// what is licensed. It cannot be given to [`status`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unverified(Licence);

impl core::ops::Deref for Unverified {
    type Target = Licence;
    fn deref(&self) -> &Licence {
        &self.0
    }
}

impl AsRef<Licence> for Unverified {
    fn as_ref(&self) -> &Licence {
        &self.0
    }
}

/// Why a token is not a licence this build accepts. `code()` is stable for logs and Console.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// Not `KITION1.<payload>.<signature>`, longer than [`MAX_TOKEN_LEN`], or the payload is not
    /// a valid licence.
    Malformed,
    /// A payload version this build does not read.
    Version,
    /// No compiled-in key has the payload's `kid`.
    UnknownKey,
    /// The signature does not match.
    Signature,
    /// The key's environment is not the payload's (a test key cannot sign a production licence).
    KeyEnv,
    /// A test licence given to a build without the `test-licences` feature.
    TestLicence,
    /// A licence for another product.
    Product,
}

impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::Version => "version",
            Self::UnknownKey => "unknown-key",
            Self::Signature => "signature",
            Self::KeyEnv => "key-env",
            Self::TestLicence => "test-licence",
            Self::Product => "product",
        }
    }
}

impl core::fmt::Display for Error {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::Malformed => "the licence is malformed",
            Self::Version => "the licence has a version this build does not read; update Kition",
            Self::UnknownKey => "the licence was signed with a key this build does not know; update Kition or ask for a new licence",
            Self::Signature => "the licence's signature does not match (was it edited?)",
            Self::KeyEnv => "the licence's environment does not match its signing key",
            Self::TestLicence => "this is a test licence (env \"test\"); production builds accept only production licences",
            Self::Product => "the licence is for another Kition product",
        })
    }
}

/// The canonical payload bytes of `licence`: JSON, keys sorted, no whitespace. What Console signs.
pub fn encode_payload(licence: &Licence) -> Vec<u8> {
    // Serializing plain structs of strings and numbers to a Vec cannot fail.
    serde_json::to_vec(licence).unwrap_or_default()
}

/// The token of signed `payload` bytes.
pub fn assemble(payload: &[u8], signature: &[u8; 64]) -> String {
    let mut token = String::from(PREFIX);
    token.push_str(&URL_SAFE_NO_PAD.encode(payload));
    token.push('.');
    token.push_str(&URL_SAFE_NO_PAD.encode(signature));
    token
}

/// The licence in `token` without checking its signature (to show what a pasted token claims
/// before it is installed).
pub fn decode(token: &str) -> Result<Unverified, Error> {
    let (payload, _) = split(token.trim())?;
    parse(&payload).map(Unverified)
}

/// Verifies `token` against the keys compiled in ([`PROD_KEYS`], and [`TEST_KEYS`] with the
/// `test-licences` feature) for `product`. See [`verify`].
pub fn verify_pinned(token: &str, product: Product) -> Result<Verified, Error> {
    #[cfg(feature = "test-licences")]
    let keys: [&[PublicKey]; 2] = [PROD_KEYS, TEST_KEYS];
    #[cfg(not(feature = "test-licences"))]
    let keys: [&[PublicKey]; 1] = [PROD_KEYS];
    verify_with(token, &keys, product, ACCEPTS_TEST)
}

/// Verifies `token` against `keys` for `product`.
///
/// Checks the length, shape, version, signing key and signature, the key's and the licence's
/// environment, and the product; not the dates, which [`status`] judges (an expired licence still
/// verifies, so grace can be computed). Only a build with the `test-licences` feature accepts
/// `env: "test"` licences. One's built-in Server verifies One's licence with `Product::One`.
pub fn verify(token: &str, keys: &[PublicKey], product: Product) -> Result<Verified, Error> {
    verify_with(token, &[keys], product, ACCEPTS_TEST)
}

fn verify_with(token: &str, keys: &[&[PublicKey]], product: Product, accepts_test: bool) -> Result<Verified, Error> {
    let (payload, signature) = split(token.trim())?;
    let licence = parse(&payload)?;
    let key = keys.iter().flat_map(|keys| keys.iter()).find(|key| key.kid == licence.kid).ok_or(Error::UnknownKey)?;
    let verifying = VerifyingKey::from_bytes(&key.key).map_err(|_| Error::UnknownKey)?;
    let signature = Signature::from_slice(&signature).map_err(|_| Error::Malformed)?;
    verifying.verify_strict(&payload, &signature).map_err(|_| Error::Signature)?;
    if key.env != licence.env {
        return Err(Error::KeyEnv);
    }
    if licence.env == Env::Test && !accepts_test {
        return Err(Error::TestLicence);
    }
    if licence.product != product {
        return Err(Error::Product);
    }
    Ok(Verified(licence))
}

fn split(token: &str) -> Result<(Vec<u8>, Vec<u8>), Error> {
    if token.len() > MAX_TOKEN_LEN {
        return Err(Error::Malformed);
    }
    let rest = token.strip_prefix(PREFIX).ok_or(Error::Malformed)?;
    let (payload, signature) = rest.split_once('.').ok_or(Error::Malformed)?;
    if payload.is_empty() || signature.is_empty() || signature.contains('.') {
        return Err(Error::Malformed);
    }
    let payload = URL_SAFE_NO_PAD.decode(payload).map_err(|_| Error::Malformed)?;
    let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| Error::Malformed)?;
    Ok((payload, signature))
}

fn parse(payload: &[u8]) -> Result<Licence, Error> {
    // The version first, so a newer payload says `version` rather than `malformed`.
    #[derive(Deserialize)]
    struct Versioned {
        v: u32,
    }
    let versioned: Versioned = serde_json::from_slice(payload).map_err(|_| Error::Malformed)?;
    if versioned.v != VERSION {
        return Err(Error::Version);
    }
    let licence: Licence = serde_json::from_slice(payload).map_err(|_| Error::Malformed)?;
    let products_fields = match licence.product {
        Product::One => licence.seats.is_some_and(|seats| seats > FREE_LIMIT) && licence.tier.is_none() && licence.employees.is_none(),
        Product::Server => licence.seats.is_none() && licence.tier.is_some(),
    };
    let named = is_id(&licence.lid) && is_id(&licence.kid) && !licence.customer.org.trim().is_empty() && !licence.customer.email.trim().is_empty();
    let dated = licence.issued_at <= licence.expires_at && licence.starts_at < licence.expires_at;
    if !products_fields || !named || !dated {
        return Err(Error::Malformed);
    }
    Ok(licence)
}

/// Whether `id` is a `lid` or `kid`: 1 to [`MAX_ID_LEN`] of `[A-Za-z0-9_-]`.
fn is_id(id: &str) -> bool {
    (1..=MAX_ID_LEN).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The licence's standing in time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Term {
    /// No licence, or one that has not started: the free rule.
    Free,
    /// Licensed, no reminder due.
    Licensed,
    /// Licensed, `days` (rounded up) until `expires_at`, within the first reminder.
    Expiring { days: u32 },
    /// Past `expires_at`, still running as licensed for `days_left` (rounded up).
    Grace { days_left: u32 },
    /// Past grace: the free rule again.
    Expired,
}

/// The one state a product shows, most urgent first: `Expired`, `Grace`, `OverSeats`,
/// `Expiring`, then `Licensed` or `Free`. [`Status`] keeps the parts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Free,
    Licensed,
    Expiring {
        days: u32,
    },
    Grace {
        days_left: u32,
    },
    Expired,
    /// More in use than the limit (One: active non-guest users; Server: concurrent co-editors).
    /// A reminder only: nothing is blocked for it.
    OverSeats {
        used: u32,
        limit: u32,
    },
}

/// What [`status`] works out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    pub product: Product,
    pub term: Term,
    /// What is in use, as given.
    pub used: u32,
    /// The most that may be in use: One's licensed users, 8 without a licence that applies,
    /// `None` for a licensed Server (unlimited).
    pub limit: Option<u32>,
}

impl Status {
    /// The headline state.
    pub fn state(&self) -> State {
        match self.term {
            Term::Expired => State::Expired,
            Term::Grace { days_left } => State::Grace { days_left },
            _ if self.over_seats() => State::OverSeats { used: self.used, limit: self.limit.unwrap_or(u32::MAX) },
            Term::Expiring { days } => State::Expiring { days },
            Term::Licensed => State::Licensed,
            Term::Free => State::Free,
        }
    }

    /// Whether more is in use than the limit.
    pub fn over_seats(&self) -> bool {
        self.limit.is_some_and(|limit| self.used > limit)
    }

    /// Whether a licence applies now (licensed, expiring, or in grace).
    pub fn is_licensed(&self) -> bool {
        matches!(self.term, Term::Licensed | Term::Expiring { .. } | Term::Grace { .. })
    }

    /// Concurrent co-editors a Server (standalone or built into One) admits: `None` (unlimited)
    /// while a licence applies, `Some(8)` with no licence or past grace. Opening, editing and
    /// saving are never limited, only joining a co-editing room.
    pub fn collab_limit(&self) -> Option<u32> {
        if self.is_licensed() { None } else { Some(FREE_LIMIT) }
    }

    /// The reminder stage due (60, 30 or 7 for One; 30 for Server), while `Expiring`: a product
    /// shows one banner per licence id and stage, each dismissible.
    pub fn reminder_stage(&self) -> Option<u32> {
        let Term::Expiring { days } = self.term else { return None };
        self.product.reminders().iter().copied().filter(|stage| days <= *stage).min()
    }
}

/// The status of `product` at `now` (Unix seconds) with the verified `licences` installed and
/// `used` in use (One: active non-guest users; Server: concurrent co-editors). Pure and offline.
///
/// Of the licences for `product` (others are ignored), the one that applies is the one started
/// and not past grace with the latest `expires_at`; its seats are the limit. Its term runs on
/// through renewals: a licence that starts by the end of the current one's grace and expires
/// later continues it, so a renewal installed early (whatever its `starts_at` within that window)
/// stops the reminders and never drops the customer to the free rule. With none applying, the
/// status is `Expired` if one ran out, else `Free`.
pub fn status(product: Product, licences: &[Verified], now: u64, used: u32) -> Status {
    let mine = || licences.iter().map(|licence| &licence.0).filter(|licence| licence.product == product);
    let latest = |a: &&Licence, b: &&Licence| (a.expires_at, a.issued_at).cmp(&(b.expires_at, b.issued_at));
    let current = mine().filter(|licence| licence.starts_at <= now && now < licence.grace_ends_at()).max_by(latest);
    let Some(current) = current else {
        let ran_out = mine().any(|licence| licence.grace_ends_at() <= now);
        return Status { product, term: if ran_out { Term::Expired } else { Term::Free }, used, limit: Some(FREE_LIMIT) };
    };
    // Follow renewals to the end of the chain (expiries strictly increase, so this ends).
    let mut last = current;
    while let Some(next) = mine().filter(|licence| licence.starts_at <= last.grace_ends_at() && licence.expires_at > last.expires_at).max_by(latest) {
        last = next;
    }
    let term = if now < last.expires_at {
        let days = days_until(now, last.expires_at);
        match product.reminders().first() {
            Some(first) if days <= *first => Term::Expiring { days },
            _ => Term::Licensed,
        }
    } else {
        Term::Grace { days_left: days_until(now, last.grace_ends_at()) }
    };
    let limit = match product {
        Product::One => current.seats,
        Product::Server => None,
    };
    Status { product, term, used, limit }
}

/// Whole days from `now` to `end`, rounded up (`now < end`).
fn days_until(now: u64, end: u64) -> u32 {
    u32::try_from(end.saturating_sub(now).div_ceil(DAY)).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// What a build without `test-licences` (a release) does with a test licence; tests run with
    /// the feature, so this calls the check with it off.
    #[test]
    fn a_build_without_test_licences_refuses_them_with_a_clear_error() {
        let seed = [21; 32];
        let keys = [PublicKey { kid: "test-1", env: Env::Test, key: SigningKey::from_bytes(&seed).verifying_key().to_bytes() }];
        let payload = br#"{"customer":{"email":"a@x.io","org":"X"},"env":"test","expires_at":2000000000,"issued_at":1,"kid":"test-1","lid":"l","product":"one","seats":10,"starts_at":1,"v":1}"#;
        let token = assemble(payload, &SigningKey::from_bytes(&seed).sign(payload).to_bytes());
        let error = verify_with(&token, &[&keys], Product::One, false).unwrap_err();
        assert_eq!(error, Error::TestLicence);
        assert_eq!(error.code(), "test-licence");
        assert!(alloc::format!("{error}").contains("test licence"));
        assert!(verify_with(&token, &[&keys], Product::One, true).is_ok());
    }

    #[test]
    fn the_compiled_keys_are_in_their_environment() {
        assert!(PROD_KEYS.iter().all(|key| key.env == Env::Prod && VerifyingKey::from_bytes(&key.key).is_ok()));
        #[cfg(feature = "test-licences")]
        assert!(TEST_KEYS.iter().all(|key| key.env == Env::Test && VerifyingKey::from_bytes(&key.key).is_ok()));
    }
}
