//! The SDK licence of `kition-kits-mcp` (kition-sdk docs/licence.md): the integrator's key
//! (`--license` or `KITION_LICENSE`) is verified offline when the server starts. The server always
//! serves; without a key that covers the `mcp` form it tells the operator on stderr that it runs
//! unlicensed, for development and evaluation only.

use kition_license::{Context, Form, PublicKey, verify};

/// What the server reports about its licence at start: `Ok` when licensed, else the warning.
pub fn startup_notice(
    token: Option<&str>,
    app_id: Option<&str>,
    keys: &[PublicKey],
    now: u64,
) -> Result<String, String> {
    let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) else {
        return Err("kition-kits-mcp: running unlicensed (no --license or KITION_LICENSE): development and evaluation only".into());
    };
    let context = Context {
        kit: None,
        form: Form::Mcp,
        origin: None,
        app_id,
        now,
    };
    match verify(token, keys, &context) {
        Ok(license) => Ok(format!(
            "kition-kits-mcp: licensed to {} until {}",
            license.licensee, license.expires
        )),
        Err(error) => Err(format!(
            "kition-kits-mcp: running unlicensed ({}: {error}): development and evaluation only",
            error.code()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const VECTORS: &str = include_str!("../../kition-license/tests/vectors.json");

    fn vectors() -> (Vec<PublicKey>, Value) {
        let vectors: Value = serde_json::from_str(VECTORS).unwrap_or_default();
        let key = vectors["keys"][0]["key"].as_str().unwrap_or_default();
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, key)
            .unwrap_or_default();
        let key: [u8; 32] = bytes.try_into().unwrap_or([0; 32]);
        (vec![PublicKey { kid: "test-1", key }], vectors)
    }

    fn token(vectors: &Value, name: &str) -> String {
        let cases = vectors["cases"].as_array().cloned().unwrap_or_default();
        let case = cases
            .iter()
            .find(|case| case["name"] == name)
            .cloned()
            .unwrap_or_default();
        case["token"].as_str().unwrap_or_default().to_owned()
    }

    #[test]
    fn a_key_for_the_mcp_form_licenses_the_server() {
        let (keys, vectors) = vectors();
        let now = vectors["cases"][0]["context"]["now"]
            .as_u64()
            .unwrap_or_default();
        let notice = startup_notice(
            Some(&token(&vectors, "mcp at a server's start")),
            None,
            &keys,
            now,
        );
        assert_eq!(
            notice,
            Ok(format!(
                "kition-kits-mcp: licensed to Example Corp (test) until {}",
                now + 364 * 86_400 + 86_400
            ))
        );
    }

    #[test]
    fn without_a_valid_key_the_server_warns_and_says_why() {
        let (keys, vectors) = vectors();
        let now = vectors["cases"][0]["context"]["now"]
            .as_u64()
            .unwrap_or_default();
        assert!(
            startup_notice(None, None, &keys, now)
                .is_err_and(|warning| warning.contains("no --license"))
        );
        assert!(
            startup_notice(Some(&token(&vectors, "form not covered")), None, &keys, now)
                .is_err_and(|warning| warning.contains("(form:"))
        );
        assert!(
            startup_notice(Some(&token(&vectors, "expired")), None, &keys, now)
                .is_err_and(|warning| warning.contains("(expired:"))
        );
        assert!(
            startup_notice(
                Some(&token(&vectors, "application id required")),
                None,
                &keys,
                now
            )
            .is_err_and(|warning| warning.contains("(app:"))
        );
        assert!(
            startup_notice(
                Some(&token(&vectors, "application id required")),
                Some("com.example.agent"),
                &keys,
                now
            )
            .is_ok()
        );
    }
}
