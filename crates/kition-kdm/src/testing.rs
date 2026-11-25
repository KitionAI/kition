// Copied from kition-sdk crates/kition-kdm/src/testing.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Test helpers for this crate's tests and for kits' tests: a seeded random generator, and tool
//! ids numbered as a kit numbers them. Not meant for production use. Bad input is still an error,
//! never a panic.

use crate::{Replica, Result};

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

/// Numbers objects as a kit with tool ids does (rule OM9), for tests and mock kits: every object
/// of a type with a `toolId` whose field holds no value gets one more than the highest value of
/// its type under the same holder (an object of the type's parent holding it in a list or ref
/// field; the whole document when the type names no parent), in type then id order, in one
/// transaction per type. `fixtures/tool-ids.json` is numbered so in both languages.
pub fn number_tool_ids(replica: &mut Replica) -> Result<()> {
    let schema = replica.schema().clone();
    for (ty, def) in &schema.types {
        let Some(tool) = &def.tool_id else { continue };
        let objects = replica.objects_of_type(ty);
        let scope = |id: &crate::ObjectId| tool.parent.as_deref().and_then(|parent| holder(replica, parent, ty, id));
        let mut numbered: Vec<(crate::ObjectId, i64)> = Vec::new();
        for id in &objects {
            if !replica.get(id, &tool.field)?.is_null() {
                continue;
            }
            let mine = scope(id);
            let highest = objects
                .iter()
                .filter(|other| scope(other) == mine)
                .filter_map(|other| {
                    replica
                        .get(other, &tool.field)
                        .ok()
                        .and_then(|value| value.as_i64())
                        .or_else(|| numbered.iter().find(|(done, _)| done == other).map(|(_, n)| *n))
                })
                .max()
                .unwrap_or(0);
            numbered.push((id.clone(), highest + 1));
        }
        if numbered.is_empty() {
            continue;
        }
        replica.transact(&crate::Origin::system("number"), |tx| {
            for (id, n) in &numbered {
                tx.set(id, &tool.field, serde_json::json!(n))?;
            }
            Ok(())
        })?;
    }
    Ok(())
}

/// The first object of `parent` whose list or ref field of `ty` holds `id`.
fn holder(replica: &Replica, parent: &str, ty: &str, id: &crate::ObjectId) -> Option<crate::ObjectId> {
    let def = replica.schema().type_def(parent).ok()?;
    replica.objects_of_type(parent).into_iter().find(|owner| {
        def.fields.iter().filter(|(_, field)| field.of.as_deref() == Some(ty)).any(|(name, field)| match field.kind {
            crate::FieldKind::List => replica.list(owner, name).unwrap_or_default().contains(id),
            crate::FieldKind::Ref => replica.get(owner, name).ok().and_then(|value| value.as_str().map(str::to_owned)).as_deref() == Some(id.as_str()),
            _ => false,
        })
    })
}
