//! The current user.
//!
//! With authentication disabled (the desktop default) every request runs as
//! the local profile. Otherwise a `Bearer` JWT (HS256, numeric `sub`) must
//! name an active user.

use axum::extract::{FromRef, FromRequestParts};
use http::request::Parts;
use kition_core::{AppError, AppResult};
use kition_store::Db;
use kition_store::users::{self, User};
use serde::Deserialize;

#[derive(Clone)]
pub struct AuthConfig {
    pub db: Db,
    pub jwt_secret: String,
    pub disabled: bool,
}

#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub user: User,
    /// Whether authentication is disabled for this runtime.
    pub auth_disabled: bool,
}

impl std::ops::Deref for CurrentUser {
    type Target = User;

    fn deref(&self) -> &User {
        &self.user
    }
}

#[derive(Debug, Deserialize)]
struct Claims {
    sub: String,
}

impl<S> FromRequestParts<S> for CurrentUser
where
    AuthConfig: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let config = AuthConfig::from_ref(state);
        if config.disabled {
            let user = config.db.run(|conn| users::find_local_user(conn)).await?;
            return user
                .map(|user| CurrentUser {
                    user,
                    auth_disabled: true,
                })
                .ok_or_else(|| AppError::localized_unauthorized("auth.local_debug_user_missing"));
        }

        let unauthorized = || AppError::localized_unauthorized("auth.unauthorized");
        let token = parts
            .headers
            .get(http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(unauthorized)?;
        let user_id = parse_token(&config.jwt_secret, token).ok_or_else(unauthorized)?;
        let user = config
            .db
            .run(move |conn| users::find_by_id(conn, user_id))
            .await?
            .ok_or_else(|| AppError::localized_unauthorized("auth.user_not_found"))?;
        if user.status != "active" {
            return Err(AppError::localized_forbidden("auth.user_disabled"));
        }
        Ok(CurrentUser {
            user,
            auth_disabled: false,
        })
    }
}

fn parse_token(secret: &str, token: &str) -> Option<i64> {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.required_spec_claims.clear();
    validation.validate_exp = true;
    let data = jsonwebtoken::decode::<Claims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()?;
    data.claims.sub.parse().ok()
}

/// Admin-only routes; always allowed when authentication is disabled.
pub fn require_admin(user: &CurrentUser) -> AppResult<()> {
    if user.auth_disabled || user.role == "admin" {
        Ok(())
    } else {
        Err(AppError::localized_forbidden("auth.forbidden"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hs256_subject() {
        let secret = "s";
        let claims = serde_json::json!({ "sub": "42", "exp": 4_102_444_800_i64 });
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap_or_default();
        assert_eq!(parse_token(secret, &token), Some(42));
        assert_eq!(parse_token("other", &token), None);
        let expired = serde_json::json!({ "sub": "42", "exp": 1 });
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &expired,
            &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap_or_default();
        assert_eq!(parse_token(secret, &token), None);
    }
}
