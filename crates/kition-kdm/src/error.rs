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
    /// `hint`: the type's fields, and for a dotted path that a field is one name (khp-bench: agents
    /// tried `frame`, `look.line.fill`, `parts.fmt.text.size` and got only "has no field").
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
    /// A shallow replica (standard 2.0 rule M16a) was asked for history before its root: changes
    /// that depend on it, or a version older than it. The server keeps that history; a host
    /// rebases the replica on a newer snapshot ([`crate::Replica::rebase`]) or reads history from
    /// the server.
    #[error("history missing: {0}")]
    HistoryMissing(String),
    #[error("encoding: {0}")]
    Encoding(String),
    #[error("engine: {0}")]
    Engine(String),
}

pub type Result<T> = std::result::Result<T, KdmError>;

/// Engine errors are reported as [`KdmError::Engine`]; the engine's error type stays private.
pub(crate) fn engine(error: loro::LoroError) -> KdmError {
    KdmError::Engine(error.to_string())
}

/// What an import into a shallow replica answers for changes that depend on history before its
/// root; the TypeScript `errors.historyMissing` says the same.
pub(crate) const CHANGES_BEFORE_ROOT: &str = "the changes depend on history before this shallow replica's root; rebase it on a newer snapshot";

/// An engine failure while importing bytes: [`KdmError::HistoryMissing`] for changes that depend
/// on history a shallow replica does not have, [`KdmError::Encoding`] otherwise.
pub(crate) fn importing(error: loro::LoroError) -> KdmError {
    match error {
        loro::LoroError::ImportUpdatesThatDependsOnOutdatedVersion => KdmError::HistoryMissing(CHANGES_BEFORE_ROOT.into()),
        other => KdmError::Encoding(other.to_string()),
    }
}
