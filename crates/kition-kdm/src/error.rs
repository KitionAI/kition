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
    #[error("type `{ty}` has no field `{field}`")]
    UnknownField { ty: String, field: String },
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
