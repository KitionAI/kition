// Copied from kition-sdk crates/kition-kits/src/license.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The SDK licence of `kition-kits-mcp` (kition-sdk docs/platform/licence.md). A local MCP server
//! on the user's machine is client-side use: free, no key needed, and no warning without one. A key
//! given with `--license` (or `KITION_LICENSE`) is verified offline when the server starts and its
//! status reported. Server-side use (headless kits on a server, `collab`, `selfhost`) stays
//! licensed; the host that runs it checks the key.

use kition_license::{Context, Form, PublicKey, verify};

/// What the server reports about its licence at start: nothing without a key (local use is free),
/// the licensee when the key covers the `mcp` form, else why the key was not accepted.
pub fn startup_notice(token: Option<&str>, app_id: Option<&str>, keys: &[PublicKey], now: u64) -> Option<String> {
    let token = token.map(str::trim).filter(|token| !token.is_empty())?;
    let context = Context { kit: None, form: Form::Mcp, origin: None, app_id, now };
    Some(match verify(token, keys, &context) {
        Ok(license) => format!("kition-kits-mcp: licensed to {} until {}", license.licensee, license.expires),
        Err(error) => format!("kition-kits-mcp: the licence key was not accepted ({}: {error}); a local server needs none and serves as usual", error.code()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const VECTORS: &str = include_str!("../../kition-license/tests/vectors.json");

    fn vectors() -> (Vec<PublicKey>, Value) {
        let vectors: Value = serde_json::from_str(VECTORS).unwrap_or_default();
        let key = vectors["keys"][0]["key"].as_str().unwrap_or_default();
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, key).unwrap_or_default();
        let key: [u8; 32] = bytes.try_into().unwrap_or([0; 32]);
        (vec![PublicKey { kid: "test-1", key }], vectors)
    }

    fn token(vectors: &Value, name: &str) -> String {
        let cases = vectors["cases"].as_array().cloned().unwrap_or_default();
        let case = cases.iter().find(|case| case["name"] == name).cloned().unwrap_or_default();
        case["token"].as_str().unwrap_or_default().to_owned()
    }

    #[test]
    fn a_key_for_the_mcp_form_licenses_the_server() {
        let (keys, vectors) = vectors();
        let now = vectors["cases"][0]["context"]["now"].as_u64().unwrap_or_default();
        let notice = startup_notice(Some(&token(&vectors, "mcp at a server's start")), None, &keys, now);
        assert_eq!(notice, Some(format!("kition-kits-mcp: licensed to Example Corp (test) until {}", now + 364 * 86_400 + 86_400)));
    }

    #[test]
    fn without_a_key_the_local_server_says_nothing() {
        let (keys, vectors) = vectors();
        let now = vectors["cases"][0]["context"]["now"].as_u64().unwrap_or_default();
        assert_eq!(startup_notice(None, None, &keys, now), None);
        assert_eq!(startup_notice(Some("  "), None, &keys, now), None);
    }

    #[test]
    fn a_key_that_is_not_accepted_says_why_without_calling_the_server_unlicensed() {
        let (keys, vectors) = vectors();
        let now = vectors["cases"][0]["context"]["now"].as_u64().unwrap_or_default();
        let refused = |name: &str, app_id: Option<&str>| startup_notice(Some(&token(&vectors, name)), app_id, &keys, now).unwrap_or_default();
        assert!(refused("form not covered", None).contains("(form:"));
        assert!(refused("expired", None).contains("(expired:"));
        assert!(refused("application id required", None).contains("(app:"));
        assert!(refused("application id required", Some("com.example.agent")).contains("licensed to"));
        for name in ["form not covered", "expired"] {
            let notice = refused(name, None);
            assert!(!notice.contains("unlicensed") && !notice.contains("evaluation"), "{notice}");
        }
    }
}
