// Copied from kition-sdk crates/kition-kdm/src/lib.rs by scripts/sync-kit-host.mjs; change it there, not here.
#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Kit Data Model (KDM): the typed document model of the Kition kit platform (`KitModel 1.1`).
//!
//! A kit declares its document as a [`Schema`]. A [`Replica`] holds one copy of a document in a
//! plain object store, changes it only through transactions ([`Replica::transact`]), each one
//! change on the document's line of changes, and passes its changes to other replicas of the
//! same session ([`Replica::export_changes`], [`Replica::import_changes`]) in order. What a kit
//! writes into a person's file is its content ([`Replica::content_snapshot`], read back by
//! [`Replica::load`]; data model 7.4).

#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]

pub mod batch;
mod changes;
pub mod comment;
mod content;
pub mod diff;
mod error;
pub mod footprint;
mod ids;
mod marks;
mod merge;
mod origin;
mod overlay;
pub mod projection;
mod read;
mod replica;
pub mod reread;
mod schema;
mod store;
pub mod testing;
pub mod tool_ids;
mod tx;
mod value;

pub use changes::{Changes, MapWrites};
pub use error::{KdmError, Result};
pub use ids::{ActorId, DocId, NodeRef, ObjectId};
pub use marks::TextRun;
pub use merge::{MergeAt, MergeConflict};
pub use origin::{Origin, OriginKind, UndoScope};
pub use replica::{DraftMerge, Replica, TreeEntry, UndoOutcome, UndoTouch, Version};
pub use schema::{
    Expand, FieldDef, FieldKind, KDM_VERSION, MarkDef, NumberLimits, ProjectedCommand, ReadOnlyWhen, Schema, StructuralConsequence, ToolIdDef, TypeDef,
};
pub use tx::Tx;
