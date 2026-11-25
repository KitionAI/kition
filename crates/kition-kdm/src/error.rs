// Copied from kition-sdk crates/kition-kdm/src/error.rs by scripts/sync-kit-host.mjs; change it there, not here.
use thiserror::Error;

/// Every failure of the KDM. Bad input is an error, never a panic.
#[derive(Debug, Error, Clone, PartialEq)]
#[non_exhaustive]
pub enum KdmError {
    #[error("schema: {0}")]
    Schema(String),
    #[error("unknown type `{0}`")]
    UnknownType(String),
    /// `hint`: the type's fields, and for a dotted path that a field is one name.
    #[error("type `{ty}` has no field `{field}`{hint}")]
    UnknownField { ty: String, field: String, hint: String },
    #[error("field `{field}` of `{ty}` {reason}")]
    InvalidValue { ty: String, field: String, reason: String },
    #[error("object `{0}` not found")]
    NotFound(String),
    #[error("moving that node would create a cycle")]
    Cycle,
    #[error("index {index} is out of range (length {len})")]
    OutOfRange { index: usize, len: usize },
    /// Changes exported by another document: documents never merge.
    #[error("the changes belong to document {found}, not {expected}")]
    WrongDocument { expected: String, found: String },
    /// The document's minimum schema version (rule M20) is newer than the reader's schema: a
    /// document migrated by a newer build, which this build would misread.
    #[error("the document needs schema version {found}; this kit reads schema versions up to {reads}")]
    NewerSchema { found: u64, reads: u32 },
    /// A version this replica's change log no longer (or never) held: before the log's start, or
    /// of another line of changes ([`crate::Replica::fork_at`], [`crate::Replica::changes_since`]).
    #[error("history missing: {0}")]
    HistoryMissing(String),
    /// Changes that do not follow this replica's state: they continue another version, or an
    /// operation's precondition (its object, its position, the list item at it) does not hold.
    /// Nothing was applied.
    #[error("stale: {0}")]
    Stale(String),
    #[error("encoding: {0}")]
    Encoding(String),
    #[error("engine: {0}")]
    Engine(String),
}

pub type Result<T> = std::result::Result<T, KdmError>;
