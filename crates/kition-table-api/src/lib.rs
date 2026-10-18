//! The table document request layer.
//!
//! The data-document API's document-scoped requests (tables, fields, views, view configuration,
//! records, links, history, `transact`/`undo`/`redo`/`history-state`, dashboards, and CSV or
//! Markdown transfer) as plain functions over an open [`KitableFile`]: JSON in, JSON out, no
//! server, no async runtime. Kition's runtime routes (`kition-datadoc`) are thin adapters over
//! these functions, and a table kit answers the same requests through [`handle`], so both answer
//! with the same JSON.
//!
//! Each request has a typed function (`records::create`, `tables::update_field`, …) taking
//! already parsed ids, so an adapter keeps its own order of checks; [`handle`] parses a method
//! name and a params object and calls them. Params hold the route's path ids in camelCase
//! (`tableId`, `recordId`, `fieldId`, `viewId`, `dashboardId`) next to the route's query values
//! and body fields.

mod coerce;
pub mod csvutil;
pub mod dashboards;
mod dispatch;
pub mod records;
pub mod respond;
pub mod tables;
pub mod transact;
pub mod view_config;

pub use coerce::{list_window, parse_id};
pub use dispatch::{METHODS, handle};
pub use kition_kitable::KitableFile;

/// The document a request acts on, as the responses name it: the runtime's index row (`id`,
/// `user_id`), or whatever an embedding host chooses (`0` when it has none).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DocRef {
    pub document_id: i64,
    pub user_id: i64,
}

/// Why a request failed, by the HTTP status the runtime answers it with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApiError {
    /// `400` with this message.
    #[error("{0}")]
    BadRequest(String),
    /// `400`: the request body (or params) could not be decoded; the runtime answers its
    /// localized generic "bad request" message.
    #[error("invalid request body")]
    InvalidBody,
    /// `404` with this message.
    #[error("{0}")]
    NotFound(String),
    /// `409` with this message.
    #[error("{0}")]
    Conflict(String),
    /// `500` with this message.
    #[error("{0}")]
    Internal(String),
    /// `500`: an unexpected failure; the runtime logs this detail and answers its localized
    /// generic internal error.
    #[error("{0}")]
    Unhandled(String),
    /// `404`: [`handle`] knows no such method.
    #[error("unknown method: {0}")]
    UnknownMethod(String),
}

impl ApiError {
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest(message.into())
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    /// The HTTP status the runtime answers this error with.
    pub fn status(&self) -> u16 {
        match self {
            Self::BadRequest(_) | Self::InvalidBody => 400,
            Self::NotFound(_) | Self::UnknownMethod(_) => 404,
            Self::Conflict(_) => 409,
            Self::Internal(_) | Self::Unhandled(_) => 500,
        }
    }

    /// `{ "status", "message" }`, for hosts that answer errors as JSON.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "status": self.status(), "message": self.to_string() })
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        Self::Unhandled(error.to_string())
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
