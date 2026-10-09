//! The `.kitable` table document format.
//!
//! A `.kitable` file is a self-contained SQLite database holding one data
//! document: its tables, fields, views, view configuration, records, record
//! links, history, and attachments. Every timestamp is Unix milliseconds.

mod bulk;
mod computed;
mod file;
mod history;
mod json;
mod links;
mod schema;
mod source;
mod view_config;

pub use bulk::{BulkCopyResult, BulkDeleteResult};
pub use file::{CreateOptions, FORMAT, FORMAT_VERSION, Info, KitableFile, SCHEMA_VERSION};
pub use history::{HistoryAction, HistoryEntry};
pub use links::LinkRef;
pub use source::{
    Attachment, AttachmentSpec, FIELD_TYPES, Field, FieldPatch, FieldSpec, Record, Table,
    TablePatch, TableSpec, VIEW_TYPES, View, ViewPatch, ViewSpec,
};
pub use view_config::{
    FilterRule, FilterTree, FilterTreeChild, ViewField, ViewFieldPatch, ViewGroup, ViewSort,
};

#[derive(Debug, thiserror::Error)]
pub enum KitableError {
    /// Worded like the legacy driver's message, which API responses expose.
    #[error("sql: no rows in result set")]
    NotFound,
    #[error("kitable file already exists")]
    Exists,
    #[error("{0}")]
    Invalid(String),
    #[error("invalid filter tree: {0}")]
    InvalidFilterTree(String),
    #[error("kitable schema version {0} is newer than supported version {SCHEMA_VERSION}")]
    Newer(i64),
    #[error(transparent)]
    Sql(rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl From<rusqlite::Error> for KitableError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::QueryReturnedNoRows => KitableError::NotFound,
            other => KitableError::Sql(other),
        }
    }
}

pub type Result<T> = std::result::Result<T, KitableError>;

impl KitableError {
    pub fn invalid(message: impl Into<String>) -> Self {
        KitableError::Invalid(message.into())
    }
}
