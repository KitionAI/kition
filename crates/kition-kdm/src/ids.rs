// Copied from kition-sdk crates/kition-kdm/src/ids.rs by scripts/sync-kit-host.mjs; change it there, not here.
use std::fmt;
use std::sync::{Arc, OnceLock};

use uuid::Uuid;

use crate::{KdmError, Result};

/// Ids in a reproducible build: `SOURCE_DATE_EPOCH` set (a showcase sample, a golden case), new
/// document ids, actors and object ids are counted from the epoch instead of drawn at random, so
/// the same steps save the same bytes. Never on the web: the page has no environment.
mod reproducible {
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[cfg(not(target_arch = "wasm32"))]
    fn epoch() -> Option<u64> {
        static EPOCH: std::sync::OnceLock<Option<u64>> = std::sync::OnceLock::new();
        *EPOCH.get_or_init(|| std::env::var("SOURCE_DATE_EPOCH").ok().and_then(|value| value.trim().parse::<u64>().ok()))
    }

    #[cfg(target_arch = "wasm32")]
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

    pub(crate) fn as_bytes(&self) -> &[u8; 16] {
        self.0.as_bytes()
    }

    pub(crate) fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(Uuid::from_bytes(bytes))
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

/// The identity of one writable replica session. Two sessions never share one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ActorId(u64);

impl ActorId {
    /// A fresh random actor. The top bit is cleared because the engine reserves `u64::MAX`.
    /// A random actor, or a counted one in a reproducible build ([`reproducible`]).
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

/// A node of a tree field. Valid in the replica that returned it and in every replica that has
/// the change that created it.
///
/// A node created inside a transaction has no engine id until the transaction commits; its handle
/// resolves then. Handles compare by resolved node; two unresolved handles are equal only if they
/// are the same handle (or clones of it). A handle from a failed transaction never resolves, and
/// using it is [`KdmError::NotFound`]. `NodeRef` is not `Hash`: an unresolved handle's identity
/// changes when it resolves.
#[derive(Clone, Debug)]
pub struct NodeRef(pub(crate) NodeInner);

#[derive(Clone, Debug)]
pub(crate) enum NodeInner {
    Committed(loro::TreeID),
    Pending(Arc<PendingNode>),
}

/// A node created by a transaction that has not been applied yet.
#[derive(Debug)]
pub(crate) struct PendingNode {
    /// The serial of the transaction that created it.
    pub(crate) tx: u64,
    /// Its index among that transaction's created nodes.
    pub(crate) index: usize,
    /// Set once, when the transaction applies.
    pub(crate) id: OnceLock<loro::TreeID>,
}

impl NodeRef {
    pub(crate) fn committed(id: loro::TreeID) -> Self {
        Self(NodeInner::Committed(id))
    }

    /// The engine id, once the node exists in the document.
    pub(crate) fn resolved(&self) -> Option<loro::TreeID> {
        match &self.0 {
            NodeInner::Committed(id) => Some(*id),
            NodeInner::Pending(pending) => pending.id.get().copied(),
        }
    }
}

impl PartialEq for NodeRef {
    fn eq(&self, other: &Self) -> bool {
        match (self.resolved(), other.resolved()) {
            (Some(a), Some(b)) => a == b,
            (None, None) => matches!((&self.0, &other.0), (NodeInner::Pending(a), NodeInner::Pending(b)) if Arc::ptr_eq(a, b)),
            _ => false,
        }
    }
}

impl Eq for NodeRef {}
