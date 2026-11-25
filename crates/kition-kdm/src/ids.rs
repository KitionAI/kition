// Copied from kition-sdk crates/kition-kdm/src/ids.rs by scripts/sync-kit-host.mjs; change it there, not here.
use std::fmt;

use uuid::Uuid;

use crate::{KdmError, Result};

/// Ids in a reproducible build, for tests and sample builds only: with the Cargo feature
/// `reproducible-ids` **and** `KITION_REPRODUCIBLE_IDS` (a number, the seed) set, new document
/// ids, actors and object ids are counted from the seed instead of drawn at random, so the same
/// steps save the same bytes. A kit enables the feature in its `[dev-dependencies]` only (tests,
/// examples that build samples), never in `[dependencies]`: a shipped kit cannot count ids, since
/// two processes counting from one seed would mint the same ids. `SOURCE_DATE_EPOCH`, which
/// hosts pass to kits for timestamps, never changes ids, and no host passes
/// `KITION_REPRODUCIBLE_IDS` (kit process protocol, section 3). Never on the web: the page has no
/// environment.
mod reproducible {
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[cfg(all(feature = "reproducible-ids", not(target_arch = "wasm32")))]
    fn epoch() -> Option<u64> {
        static SEED: std::sync::OnceLock<Option<u64>> = std::sync::OnceLock::new();
        *SEED.get_or_init(|| std::env::var("KITION_REPRODUCIBLE_IDS").ok().and_then(|value| value.trim().parse::<u64>().ok()))
    }

    #[cfg(not(all(feature = "reproducible-ids", not(target_arch = "wasm32"))))]
    fn epoch() -> Option<u64> {
        None
    }

    /// SplitMix64: one well-mixed value from a seed.
    pub(super) fn mix(seed: u64) -> u64 {
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// The next counted value, in a reproducible build.
    pub(super) fn next() -> Option<u64> {
        let epoch = epoch()?;
        Some(mix(epoch ^ mix(NEXT.fetch_add(1, Ordering::Relaxed))))
    }

    /// A version 7 shaped UUID of the next counted values, in a reproducible build.
    pub(super) fn uuid() -> Option<uuid::Uuid> {
        let high = next()?;
        let low = mix(high);
        let high = (high & 0xFFFF_FFFF_FFFF_0FFF) | 0x0000_0000_0000_7000;
        let low = (low & 0x3FFF_FFFF_FFFF_FFFF) | 0x8000_0000_0000_0000;
        Some(uuid::Uuid::from_u64_pair(high, low))
    }
}

/// A new line of changes (plan 2026-11-24, section 1.3): a UUID v7, or counted in a reproducible
/// build ([`reproducible`]).
pub(crate) fn new_lineage() -> [u8; 16] {
    *reproducible::uuid().unwrap_or_else(Uuid::now_v7).as_bytes()
}

/// A document's durable identity. Renaming or moving its file never changes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DocId(Uuid);

impl DocId {
    /// A new id: UUID v7, or counted in a reproducible build ([`reproducible`]).
    pub fn new() -> Self {
        Self(reproducible::uuid().unwrap_or_else(Uuid::now_v7))
    }

    pub fn parse(text: &str) -> Result<Self> {
        Uuid::parse_str(text).map(Self).map_err(|error| KdmError::Encoding(error.to_string()))
    }
}

impl Default for DocId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for DocId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// The identity of one writable replica session: the session that wrote a change, recorded in it.
/// Two sessions never share one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ActorId(u64);

impl ActorId {
    /// A random actor, or a counted one in a reproducible build ([`reproducible`]). The top bit
    /// is cleared, so an actor is never `u64::MAX`.
    pub fn random() -> Self {
        Self(reproducible::next().unwrap_or_else(|| Uuid::new_v4().as_u64_pair().0) >> 1)
    }

    pub fn from_u64(value: u64) -> Result<Self> {
        if value == u64::MAX {
            return Err(KdmError::Encoding("actor id u64::MAX is reserved".into()));
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

/// The stable identity of one object in a document, unique across all replicas.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ObjectId(String);

impl ObjectId {
    /// A new id. UUID v7: unique without coordination and roughly creation-ordered; counted in a
    /// reproducible build ([`reproducible`]).
    pub fn new() -> Self {
        Self(reproducible::uuid().unwrap_or_else(Uuid::now_v7).to_string())
    }

    pub fn from_string(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for ObjectId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for ObjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A node of a tree field: the node of one object in one tree (a tree holds an object at most
/// once). A handle names the object; it is valid in every replica of the document whose tree holds
/// that object, and a transaction's handle is valid as soon as the transaction made it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct NodeRef(pub(crate) ObjectId);

impl NodeRef {
    /// The object the node is.
    pub fn object(&self) -> &ObjectId {
        &self.0
    }
}
