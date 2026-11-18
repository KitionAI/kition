//! Application errors with stable business codes and localizable messages.

use serde_json::Value;

use crate::i18n::{self, Locale};

pub type AppResult<T> = Result<T, AppError>;

/// An error that renders as `{"code", "message", "data"}` with an HTTP status.
/// The details are boxed so `Result<T, AppError>` stays small.
#[derive(Debug, Clone)]
pub struct AppError(Box<ErrorDetails>);

#[derive(Debug, Clone)]
pub struct ErrorDetails {
    pub status: u16,
    pub code: i64,
    /// Fallback text, used verbatim when `key` is empty.
    pub message: String,
    /// Translation key rendered in the request locale at response time.
    pub key: Option<String>,
    pub args: Vec<(String, String)>,
    pub data: Value,
}

impl std::ops::Deref for AppError {
    type Target = ErrorDetails;

    fn deref(&self) -> &ErrorDetails {
        &self.0
    }
}

impl std::ops::DerefMut for AppError {
    fn deref_mut(&mut self) -> &mut ErrorDetails {
        &mut self.0
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

impl AppError {
    pub fn new(status: u16, code: i64, message: impl Into<String>) -> Self {
        Self(Box::new(ErrorDetails {
            status,
            code,
            message: message.into(),
            key: None,
            args: Vec::new(),
            data: Value::Null,
        }))
    }

    pub fn localized(status: u16, code: i64, key: &str, args: Vec<(String, String)>) -> Self {
        Self(Box::new(ErrorDetails {
            status,
            code,
            message: i18n::t(Locale::DEFAULT, key, &args),
            key: Some(key.to_owned()),
            args,
            data: Value::Null,
        }))
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = data;
        self
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, 400, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(401, 401, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(403, 403, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, 404, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, 409, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, 500, message)
    }

    pub fn localized_bad_request(key: &str) -> Self {
        Self::localized(400, 400, key, Vec::new())
    }

    pub fn localized_unauthorized(key: &str) -> Self {
        Self::localized(401, 401, key, Vec::new())
    }

    pub fn localized_forbidden(key: &str) -> Self {
        Self::localized(403, 403, key, Vec::new())
    }

    /// An unexpected failure. The message shown to the client is the
    /// localized generic internal error; `detail` is only logged.
    pub fn unhandled(detail: impl std::fmt::Display) -> Self {
        let mut error = Self::localized(500, 500, "common.internal_error", Vec::new());
        error.message = detail.to_string();
        error
    }
}

impl ErrorDetails {
    /// The message rendered for `locale`.
    pub fn localize(&self, locale: Locale) -> String {
        match &self.key {
            Some(key) => i18n::t(locale, key, &self.args),
            None => self.message.clone(),
        }
    }
}

impl axum::response::IntoResponse for AppError {
    /// Renders in the default locale and attaches the error, so the request
    /// middleware can re-render the message in the request's locale.
    fn into_response(self) -> axum::response::Response {
        let status = axum::http::StatusCode::from_u16(self.status)
            .unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR);
        let body = crate::response::Envelope::failure(
            self.code,
            self.localize(Locale::DEFAULT),
            self.data.clone(),
        );
        let mut response = (status, axum::Json(body)).into_response();
        response.extensions_mut().insert(self);
        response
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::unhandled(error)
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::unhandled(error)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::unhandled(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn localizes_at_render_time() {
        let error = AppError::localized_unauthorized("auth.unauthorized");
        assert_eq!(error.status, 401);
        assert_eq!(
            error.localize(Locale::En),
            "Unauthorized, please sign in again"
        );
        assert_ne!(error.localize(Locale::Zh), error.localize(Locale::En));
    }

    #[test]
    fn plain_messages_are_not_translated() {
        let error = AppError::bad_request("name is required");
        assert_eq!(error.localize(Locale::Zh), "name is required");
    }

    #[test]
    fn unhandled_hides_detail_from_clients() {
        let error = AppError::unhandled("disk exploded");
        assert_eq!(error.message, "disk exploded");
        assert_eq!(error.localize(Locale::En), "Internal server error");
    }
}
