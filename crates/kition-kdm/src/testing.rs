// Copied from kition-sdk crates/kition-kdm/src/testing.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Multi-replica testing: a network of replicas of one document with seeded delivery order.
//!
//! A test helper for this crate's tests and for kits' own convergence tests; it is not meant for
//! production use. Bad input is still an error, never a panic.

use std::sync::Arc;

use crate::{ActorId, DocId, KdmError, Replica, Result, Schema, Version};

/// A small deterministic random generator (xorshift64*), so failing seeds reproduce.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// A value in `0..bound`, or 0 when `bound` is 0.
    pub fn below(&mut self, bound: usize) -> usize {
        match bound {
            0 => 0,
            _ => (self.next_u64() % bound as u64) as usize,
        }
    }

    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for index in (1..items.len()).rev() {
            let other = self.below(index + 1);
            items.swap(index, other);
        }
    }
}

/// `count` replicas of one new document, each with its own actor (1, 2, 3, ...).
pub struct Network {
    pub replicas: Vec<Replica>,
    pub rng: Rng,
}

impl Network {
    /// Fails with [`KdmError::OutOfRange`] when `count` is 0: a network has at least one replica.
    pub fn new(schema: Arc<Schema>, count: usize, seed: u64) -> Result<Self> {
        if count == 0 {
            return Err(KdmError::OutOfRange { index: 0, len: 0 });
        }
        let first = Replica::create(Arc::clone(&schema), DocId::new(), ActorId::from_u64(1)?)?;
        let snapshot = first.snapshot()?;
        let mut replicas = vec![first];
        for actor in 2..=count as u64 {
            replicas.push(Replica::load(Arc::clone(&schema), &snapshot, ActorId::from_u64(actor)?)?);
        }
        Ok(Self { replicas, rng: Rng::new(seed) })
    }

    /// Sends what `to` lacks from `from`.
    pub fn deliver(&mut self, from: usize, to: usize) -> Result<()> {
        let since = self.replica(to)?.version();
        let bytes = self.replica(from)?.export_changes(&since)?;
        self.replica_mut(to)?.import_changes(&bytes)?;
        Ok(())
    }

    /// Delivers every replica's changes to every other replica in a seeded order, then sends
    /// everything again from scratch to prove that duplicates are harmless.
    pub fn sync_all(&mut self) -> Result<()> {
        let count = self.replicas.len();
        let mut pairs: Vec<(usize, usize)> = (0..count).flat_map(|from| (0..count).filter(move |to| *to != from).map(move |to| (from, to))).collect();
        self.rng.shuffle(&mut pairs);
        for &(from, to) in &pairs {
            self.deliver(from, to)?;
        }
        for &(from, to) in &pairs {
            let bytes = self.replica(from)?.export_changes(&Version::empty())?;
            self.replica_mut(to)?.import_changes(&bytes)?;
        }
        Ok(())
    }

    /// The common state hash, or a description of the first difference.
    pub fn converged(&self) -> std::result::Result<String, String> {
        let Some(reference) = self.replicas.first() else { return Err("the network has no replicas".into()) };
        let first = reference.state_hash().map_err(|error| error.to_string())?;
        for (index, replica) in self.replicas.iter().enumerate().skip(1) {
            let hash = replica.state_hash().map_err(|error| error.to_string())?;
            if hash != first {
                let a = reference.state_json().map_err(|error| error.to_string())?;
                let b = replica.state_json().map_err(|error| error.to_string())?;
                return Err(format!("replica 0 and {index} differ:\n{a:#}\n---\n{b:#}"));
            }
        }
        Ok(first)
    }

    fn replica(&self, index: usize) -> Result<&Replica> {
        self.replicas.get(index).ok_or(KdmError::OutOfRange { index, len: self.replicas.len() })
    }

    fn replica_mut(&mut self, index: usize) -> Result<&mut Replica> {
        let len = self.replicas.len();
        self.replicas.get_mut(index).ok_or(KdmError::OutOfRange { index, len })
    }
}
