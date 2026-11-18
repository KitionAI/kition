//! Request extractors.

use axum::body::Bytes;
use axum::extract::{FromRequest, FromRequestParts, Request};
use http::request::Parts;
use kition_core::AppError;
use kition_core::i18n::Locale;
use serde::de::DeserializeOwned;

/// Trace ID and locale assigned by the request middleware.
#[derive(Debug, Clone)]
pub struct RequestContext {
    pub trace_id: String,
    pub locale: Locale,
}

impl<S: Send + Sync> FromRequestParts<S> for RequestContext {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(parts
            .extensions
            .get::<RequestContext>()
            .cloned()
            .unwrap_or(RequestContext {
                trace_id: "unknown".to_owned(),
                locale: Locale::DEFAULT,
            }))
    }
}

/// A JSON object request body. Any decoding failure is the localized
/// `common.bad_request` error, regardless of the content type header.
///
/// Matches the legacy decoder for object targets: a top-level array is
/// rejected (serde would otherwise accept it for structs), and `null`
/// decodes as an empty object.
pub struct JsonBody<T>(pub T);

/// Decodes a JSON object body with [`JsonBody`] semantics.
pub fn decode_object<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, AppError> {
    let bad = || AppError::localized_bad_request("common.bad_request");
    let trimmed = bytes.trim_ascii();
    if trimmed.starts_with(b"[") {
        return Err(bad());
    }
    let source: &[u8] = if trimmed == b"null" { b"{}" } else { bytes };
    serde_json::from_slice(source).map_err(|_| bad())
}

impl<T, S> FromRequest<S> for JsonBody<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes = Bytes::from_request(request, state)
            .await
            .map_err(|_| AppError::localized_bad_request("common.bad_request"))?;
        decode_object(&bytes).map(JsonBody)
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Debug, Default, Deserialize, PartialEq)]
    struct Body {
        #[serde(default)]
        name: Option<String>,
    }

    #[test]
    fn decodes_objects_like_the_legacy_decoder() {
        assert_eq!(
            decode_object::<Body>(b"{\"name\":\"a\"}").ok(),
            Some(Body {
                name: Some("a".into())
            })
        );
        assert_eq!(decode_object::<Body>(b" null ").ok(), Some(Body::default()));
        assert!(decode_object::<Body>(b"[]").is_err());
        assert!(decode_object::<Body>(b"").is_err());
        assert!(decode_object::<Body>(b"\"x\"").is_err());
    }
}
