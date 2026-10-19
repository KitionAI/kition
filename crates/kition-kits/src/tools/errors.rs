//! Structured error codes in kit tool results (architecture section 13): every failure carries
//! `{ code, message, index?, retryable? }`, so a model can recover without parsing prose. The
//! object-model codes are `kition_kdm::batch::BatchErrorCode`'s; the others name what the Kit
//! Protocol reasons and the host's own checks say.

use kition_kdm::batch::BatchErrorCode;
use kition_kit_protocol::ErrorReason;
use serde_json::{Map, Value, json};

use crate::bridge::BridgeFailure;
use crate::manager::KitError;

/// Why a kit tool failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    /// An object-model failure: `invalid-op`, `not-found`, `invalid-value`, `read-only`, or
    /// `command-failed`, as `model/batch` answers them.
    Batch(BatchErrorCode),
    /// The arguments are wrong: a missing `path`, a file of another kit, an empty step list.
    InvalidParams,
    /// The call needs the file open in its kit editor (drafts live there), or the document is
    /// not open in the kit.
    NotOpen,
    /// The call needs the agent's draft, and there is none yet: edit with `draft: true` first.
    DraftRequired,
    /// No command has this id: search with `<prefix>_commands`.
    UnknownCommand,
    /// The host's configuration or the agent's role refuses this (a command, a path outside the
    /// workspace).
    NotAllowed,
    /// The kit does not offer this (no object model, no drafts in its editor).
    Unsupported,
    /// The kit is not installed, not running, or did not answer in time.
    Unavailable,
    /// Anything else.
    Failed,
}

impl ErrorCode {
    pub const READ_ONLY: Self = Self::Batch(BatchErrorCode::ReadOnly);
    pub const COMMAND_FAILED: Self = Self::Batch(BatchErrorCode::CommandFailed);
    pub const NOT_FOUND: Self = Self::Batch(BatchErrorCode::NotFound);

    /// Every code, as the tools answer them.
    pub const ALL: [Self; 13] = [
        Self::Batch(BatchErrorCode::InvalidOp),
        Self::Batch(BatchErrorCode::NotFound),
        Self::Batch(BatchErrorCode::InvalidValue),
        Self::Batch(BatchErrorCode::ReadOnly),
        Self::Batch(BatchErrorCode::CommandFailed),
        Self::InvalidParams,
        Self::NotOpen,
        Self::DraftRequired,
        Self::UnknownCommand,
        Self::NotAllowed,
        Self::Unsupported,
        Self::Unavailable,
        Self::Failed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Batch(code) => code.as_str(),
            Self::InvalidParams => "invalid-params",
            Self::NotOpen => "not-open",
            Self::DraftRequired => "draft-required",
            Self::UnknownCommand => "unknown-command",
            Self::NotAllowed => "not-allowed",
            Self::Unsupported => "unsupported",
            Self::Unavailable => "unavailable",
            Self::Failed => "failed",
        }
    }

    /// A code as a kit or an editor spells it: these codes, and the Kit Protocol reasons
    /// (`command_not_found`, `document_not_found`, …).
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim().replace('_', "-");
        if let Some(code) = Self::ALL.into_iter().find(|code| code.as_str() == text) {
            return Some(code);
        }
        Some(match text.as_str() {
            "command-not-found" => Self::UnknownCommand,
            "document-not-found" => Self::NotOpen,
            "command-disabled" => Self::COMMAND_FAILED,
            "uri-not-granted" | "role-forbidden" | "forbidden" => Self::NotAllowed,
            "unsupported-format" | "surface-mechanism-unsupported" => Self::Unsupported,
            "timeout" | "stopped" | "request-cancelled" => Self::Unavailable,
            _ => return None,
        })
    }

    /// Whether the same call may succeed later unchanged: the kit or the editor was only busy
    /// or restarting.
    pub fn retryable(self) -> bool {
        self == Self::Unavailable
    }
}

/// A tool's failure, with what had already happened when it stopped.
#[derive(Clone, Debug)]
pub struct KitToolError {
    pub code: ErrorCode,
    /// What happened, for the model and the person.
    pub message: String,
    /// The step or operation that failed, when one did.
    pub index: Option<usize>,
    pub retryable: bool,
    /// What the tool had done before it stopped (completed steps, the document).
    pub output: Option<Value>,
}

impl KitToolError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            index: None,
            retryable: code.retryable(),
            output: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidParams, message)
    }

    #[must_use]
    pub fn at(mut self, index: Option<usize>) -> Self {
        self.index = index;
        self
    }

    #[must_use]
    pub fn with_output(mut self, output: Value) -> Self {
        self.output = Some(output);
        self
    }

    /// The same failure with `context` before its message: `step 2 (`x`) failed: …`.
    #[must_use]
    pub fn context(mut self, context: &str) -> Self {
        self.message = format!("{context}{}", self.message);
        self
    }

    /// `{ code, message, index?, retryable? }`.
    pub fn to_json(&self) -> Value {
        let mut error = json!({ "code": self.code.as_str(), "message": self.message });
        if let Some(index) = self.index {
            error["index"] = json!(index);
        }
        if self.retryable {
            error["retryable"] = Value::Bool(true);
        }
        error
    }

    /// The tool's canonical failure output: what it had done (`output`), with `error`.
    pub fn structured(&self) -> Value {
        let mut out = match &self.output {
            Some(Value::Object(fields)) => fields.clone(),
            Some(other) => Map::from_iter([("output".to_owned(), other.clone())]),
            None => Map::new(),
        };
        out.insert("error".into(), self.to_json());
        Value::Object(out)
    }

    /// An editor's refusal over the Kit AI bridge, with the code its error data names (an
    /// object-model refusal's `code` and `index`, a refusal's `reason`).
    pub fn from_bridge(failure: BridgeFailure) -> Self {
        let data = failure.data.unwrap_or(Value::Null);
        let named = ["code", "reason"]
            .into_iter()
            .find_map(|key| data.get(key).and_then(Value::as_str))
            .and_then(ErrorCode::parse);
        let index = data
            .get("index")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok());
        let code = named.unwrap_or_else(|| guess(&failure.message));
        Self::new(code, failure.message).at(index)
    }
}

/// The code of an editor failure that names none, from its message.
fn guess(message: &str) -> ErrorCode {
    let lower = message.to_lowercase();
    if lower.contains("unknown command") || lower.contains("no such command") {
        ErrorCode::UnknownCommand
    } else if lower.contains("read-only") {
        ErrorCode::READ_ONLY
    } else if lower.contains("not open") || lower.contains("window closed") {
        ErrorCode::NotOpen
    } else if lower.contains("did not answer") {
        ErrorCode::Unavailable
    } else if lower.contains("failed") {
        ErrorCode::COMMAND_FAILED
    } else {
        ErrorCode::Failed
    }
}

impl From<KitError> for KitToolError {
    fn from(error: KitError) -> Self {
        let message = error.to_string();
        let (code, index) = match &error {
            KitError::UnknownKit(_) | KitError::InvalidPath(_) => (ErrorCode::InvalidParams, None),
            KitError::NotInstalled { .. }
            | KitError::NoWorkspace
            | KitError::Launch { .. }
            | KitError::Stopped { .. }
            | KitError::Unavailable(_) => (ErrorCode::Unavailable, None),
            KitError::Model { code, index, .. } => (
                ErrorCode::parse(code).unwrap_or(ErrorCode::Batch(BatchErrorCode::InvalidOp)),
                *index,
            ),
            KitError::Kit { reason, .. } => (
                match reason {
                    Some(ErrorReason::CommandNotFound) => ErrorCode::UnknownCommand,
                    Some(ErrorReason::CommandDisabled) => ErrorCode::COMMAND_FAILED,
                    Some(ErrorReason::DocumentNotFound) => ErrorCode::NotOpen,
                    Some(ErrorReason::InvalidParams) => ErrorCode::InvalidParams,
                    Some(ErrorReason::UriNotGranted | ErrorReason::RoleForbidden) => {
                        ErrorCode::NotAllowed
                    }
                    Some(
                        ErrorReason::UnsupportedFormat | ErrorReason::SurfaceMechanismUnsupported,
                    ) => ErrorCode::Unsupported,
                    Some(ErrorReason::RequestCancelled | ErrorReason::SurfaceNotAttached) => {
                        ErrorCode::Unavailable
                    }
                    Some(_) | None => ErrorCode::Failed,
                },
                None,
            ),
        };
        let mut failure = Self::new(code, message).at(index);
        // A stopped kit restarts on the next call.
        failure.retryable |= matches!(error, KitError::Stopped { .. });
        failure
    }
}

impl From<BridgeFailure> for KitToolError {
    fn from(failure: BridgeFailure) -> Self {
        Self::from_bridge(failure)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_spells_and_parses_back() {
        for code in ErrorCode::ALL {
            assert_eq!(
                ErrorCode::parse(code.as_str()),
                Some(code),
                "{}",
                code.as_str()
            );
        }
        assert_eq!(ErrorCode::READ_ONLY.as_str(), "read-only");
        assert_eq!(
            ErrorCode::parse("command_not_found"),
            Some(ErrorCode::UnknownCommand)
        );
        assert_eq!(
            ErrorCode::parse("document_not_found"),
            Some(ErrorCode::NotOpen)
        );
        assert_eq!(ErrorCode::parse("no-such-code"), None);
    }

    #[test]
    fn failures_answer_a_code_a_message_and_what_was_done() {
        let failed = KitToolError::new(ErrorCode::COMMAND_FAILED, "step 1 failed")
            .at(Some(1))
            .with_output(json!({ "completed": [{ "command": "a" }] }));
        assert_eq!(
            failed.structured(),
            json!({
                "completed": [{ "command": "a" }],
                "error": { "code": "command-failed", "message": "step 1 failed", "index": 1 },
            })
        );
        let busy = KitToolError::from(KitError::Stopped {
            name: "Kition Vector",
        });
        assert_eq!(busy.code, ErrorCode::Unavailable);
        assert_eq!(busy.to_json()["retryable"], true);
        let unknown = KitToolError::from(KitError::Kit {
            reason: Some(ErrorReason::CommandNotFound),
            message: "no command `x`".into(),
        });
        assert_eq!(unknown.to_json()["code"], "unknown-command");
        let model = KitToolError::from(KitError::Model {
            code: "read-only".into(),
            index: None,
            message: "the document is read-only".into(),
        });
        assert_eq!(model.code, ErrorCode::READ_ONLY);
    }

    #[test]
    fn editor_refusals_keep_their_codes() {
        let refused = KitToolError::from_bridge(BridgeFailure {
            message: "op 2 failed".into(),
            data: Some(json!({ "code": "not-found", "index": 2, "message": "op 2 failed" })),
        });
        assert_eq!(
            (refused.code, refused.index),
            (ErrorCode::NOT_FOUND, Some(2))
        );
        let denied = KitToolError::from_bridge(BridgeFailure {
            message: "`file.export` is not allowed here".into(),
            data: Some(json!({ "reason": "not-allowed" })),
        });
        assert_eq!(denied.code, ErrorCode::NotAllowed);
        let plain = KitToolError::from_bridge("step 0 (`no.such`) failed: unknown command".into());
        assert_eq!(plain.code, ErrorCode::UnknownCommand);
        let late = KitToolError::from_bridge(BridgeFailure {
            message: "the editor did not answer `kit/call` in time".into(),
            data: Some(json!({ "reason": "timeout" })),
        });
        assert!(late.retryable);
    }
}
