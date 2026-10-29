//! JSON-RPC errors and the kit-specific `data.reason` codes (protocol section 10).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Stable machine-readable reason carried in `error.data.reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorReason {
    Unauthorized,
    NotInitialized,
    RoleForbidden,
    UnsupportedProtocol,
    DocumentNotFound,
    DocumentDirty,
    UnsupportedFormat,
    IoError,
    UriNotGranted,
    CommandNotFound,
    CommandDisabled,
    InvalidParams,
    RequestCancelled,
}

impl ErrorReason {
    pub const ALL: [Self; 13] = [
        Self::Unauthorized,
        Self::NotInitialized,
        Self::RoleForbidden,
        Self::UnsupportedProtocol,
        Self::DocumentNotFound,
        Self::DocumentDirty,
        Self::UnsupportedFormat,
        Self::IoError,
        Self::UriNotGranted,
        Self::CommandNotFound,
        Self::CommandDisabled,
        Self::InvalidParams,
        Self::RequestCancelled,
    ];

    /// The JSON-RPC error code paired with this reason.
    pub const fn code(self) -> i64 {
        match self {
            Self::Unauthorized => -32001,
            Self::NotInitialized => -32002,
            Self::RoleForbidden => -32003,
            Self::UnsupportedProtocol => -32004,
            Self::DocumentNotFound => -32010,
            Self::DocumentDirty => -32011,
            Self::UnsupportedFormat => -32012,
            Self::IoError => -32013,
            Self::UriNotGranted => -32014,
            Self::CommandNotFound => -32020,
            Self::CommandDisabled => -32021,
            Self::InvalidParams => -32022,
            Self::RequestCancelled => -32800,
        }
    }

    pub fn from_code(code: i64) -> Option<Self> {
        Self::ALL.into_iter().find(|reason| reason.code() == code)
    }

    const fn message(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::NotInitialized => "not initialized",
            Self::RoleForbidden => "method not allowed for this role",
            Self::UnsupportedProtocol => "unsupported protocol version",
            Self::DocumentNotFound => "document not found",
            Self::DocumentDirty => "document has unsaved changes",
            Self::UnsupportedFormat => "unsupported format",
            Self::IoError => "read or write failed",
            Self::UriNotGranted => "uri not granted",
            Self::CommandNotFound => "command not found",
            Self::CommandDisabled => "command disabled",
            Self::InvalidParams => "invalid command parameters",
            Self::RequestCancelled => "request cancelled",
        }
    }
}

/// The `error.data` object of a kit error.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ErrorData {
    pub reason: ErrorReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<Value>>,
}

/// A JSON-RPC 2.0 error object.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("{message} ({code})")]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;

    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn parse_error() -> Self {
        Self::new(Self::PARSE_ERROR, "parse error")
    }

    pub fn invalid_request(detail: impl Into<String>) -> Self {
        Self::new(Self::INVALID_REQUEST, detail)
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(
            Self::METHOD_NOT_FOUND,
            format!("method not found: {method}"),
        )
    }

    pub fn invalid_params(detail: impl Into<String>) -> Self {
        Self::new(Self::INVALID_PARAMS, detail)
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(Self::INTERNAL_ERROR, detail)
    }

    /// A kit error with its paired code and `data.reason`.
    pub fn kit(reason: ErrorReason) -> Self {
        Self::kit_data(ErrorData {
            reason,
            detail: None,
            errors: None,
        })
    }

    /// A kit error with a sanitized `data.detail`.
    pub fn kit_detail(reason: ErrorReason, detail: impl Into<String>) -> Self {
        Self::kit_data(ErrorData {
            reason,
            detail: Some(detail.into()),
            errors: None,
        })
    }

    pub fn kit_data(data: ErrorData) -> Self {
        let reason = data.reason;
        Self {
            code: reason.code(),
            message: reason.message().to_owned(),
            data: serde_json::to_value(data).ok(),
        }
    }

    /// The kit reason, when `data.reason` is present and recognized.
    pub fn reason(&self) -> Option<ErrorReason> {
        let reason = self.data.as_ref()?.get("reason")?;
        serde_json::from_value(reason.clone()).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_round_trip() {
        for reason in ErrorReason::ALL {
            assert_eq!(ErrorReason::from_code(reason.code()), Some(reason));
            let error = RpcError::kit(reason);
            assert_eq!(error.code, reason.code());
            assert_eq!(error.reason(), Some(reason));
        }
        assert_eq!(ErrorReason::from_code(-32603), None);
    }

    #[test]
    fn detail_is_serialized_under_data() {
        let error = RpcError::kit_detail(ErrorReason::IoError, "disk full");
        let value = serde_json::to_value(&error).unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(value["data"]["reason"], "io_error");
        assert_eq!(value["data"]["detail"], "disk full");
        assert_eq!(value["code"], -32013);
    }
}
