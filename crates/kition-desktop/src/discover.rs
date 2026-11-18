//! Lists the models a provider exposes, for the model settings form.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::portal::{PortalAuth, compact_remote_error, read_limited};

pub const CONSOLE_PROVIDER: &str = "kition_console";
/// The hosted LLM proxy below the portal base URL.
pub const CONSOLE_LLM_PATH: &str = "/api/llm/v1";

#[derive(Debug, Clone, Default)]
pub struct DiscoverRequest {
    pub provider_type: String,
    pub base_url: String,
    pub api_key: String,
    pub access_token: String,
    pub models_path: String,
    pub auth_header: String,
    pub auth_scheme: String,
}

fn first_non_empty(values: &[&str]) -> String {
    values
        .iter()
        .map(|v| v.trim())
        .find(|v| !v.is_empty())
        .unwrap_or_default()
        .to_owned()
}

/// Adds `/v1` to bare OpenAI-compatible hosts and drops trailing slashes.
pub(crate) fn normalize_base_url(provider_type: &str, raw: &str) -> String {
    let value = raw.trim();
    let Ok(mut parsed) = url::Url::parse(value) else {
        return value.to_owned();
    };
    if parsed.host_str().is_none_or(str::is_empty) {
        return value.to_owned();
    }
    if matches!(provider_type, "deepseek" | "openai" | "openai-oauth2")
        && (parsed.path().is_empty() || parsed.path() == "/")
    {
        parsed.set_path("/v1");
    }
    parsed.to_string().trim_end_matches('/').to_owned()
}

pub(crate) fn models_endpoint(req: &DiscoverRequest) -> Result<String, String> {
    let default_base = match req.provider_type.as_str() {
        "deepseek" => "https://api.deepseek.com/v1",
        "openai" | "openai-oauth2" => "https://api.openai.com/v1",
        _ => "",
    };
    let base = first_non_empty(&[&req.base_url, default_base]);
    if base.is_empty() {
        return Err("Please fill in the Provider URL first".into());
    }
    let base = normalize_base_url(&req.provider_type, &base);
    let base = base.trim_end_matches('/');
    let mut path = req.models_path.trim().to_owned();
    if path.is_empty() {
        path = "/models".into();
    }
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("Invalid Provider URL format".into());
    }
    if base.ends_with("/models") && (path == "/models" || path == "models") {
        return Ok(base.to_owned());
    }
    if path.starts_with("http://") || path.starts_with("https://") {
        return Ok(path);
    }
    if !path.starts_with('/') {
        path.insert(0, '/');
    }
    let endpoint = format!("{base}{path}");
    url::Url::parse(&endpoint).map_err(|_| "Invalid Provider URL format".to_owned())?;
    Ok(endpoint)
}

/// The header carrying the credential, or a user-facing error.
pub(crate) fn auth_header(req: &DiscoverRequest) -> Result<(String, String), String> {
    match req.provider_type.trim() {
        "deepseek" | "openai" => {
            if req.api_key.trim().is_empty() {
                return Err("Please fill in the API Key first".into());
            }
            Ok((
                "Authorization".into(),
                format!("Bearer {}", req.api_key.trim()),
            ))
        }
        "openai-oauth2" => {
            let token = first_non_empty(&[&req.access_token, &req.api_key]);
            if token.is_empty() {
                return Err("Please fill in the OpenAI OAuth2 Access Token first".into());
            }
            Ok(("Authorization".into(), format!("Bearer {token}")))
        }
        "custom" => {
            let token = first_non_empty(&[&req.api_key, &req.access_token]);
            if token.is_empty() {
                return Err("Please fill in the custom Provider token first".into());
            }
            match req.auth_scheme.trim().to_lowercase().as_str() {
                "" | "bearer" => Ok((
                    first_non_empty(&[&req.auth_header, "Authorization"]),
                    format!("Bearer {token}"),
                )),
                "raw" => Ok((first_non_empty(&[&req.auth_header, "Authorization"]), token)),
                "x-api-key" => Ok((first_non_empty(&[&req.auth_header, "X-API-Key"]), token)),
                _ => Err("This custom authentication mode is not supported yet".into()),
            }
        }
        _ => Err("This Provider type is not supported yet".into()),
    }
}

/// Model IDs found under `data`, `models`, or `result`, sorted.
pub(crate) fn extract_model_ids(body: &[u8]) -> Vec<String> {
    fn collect(value: &Value, ids: &mut BTreeSet<String>) {
        match value {
            Value::Object(map) => {
                for key in ["id", "model_name", "model", "name"] {
                    let id = map
                        .get(key)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim();
                    if !id.is_empty() && (!id.contains(' ') || id.contains('-')) {
                        ids.insert(id.to_owned());
                    }
                }
                for key in ["data", "models", "result"] {
                    if let Some(nested) = map.get(key) {
                        collect(nested, ids);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| collect(item, ids)),
            _ => {}
        }
    }
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    let mut ids = BTreeSet::new();
    collect(&value, &mut ids);
    ids.into_iter().collect()
}

const CONSOLE_SIGN_IN: &str = "Sign in to Kition before synchronizing Kition Cloud models";

/// Fetches the model list; returns the IDs and the endpoint that was used.
pub async fn discover(
    portal: &PortalAuth,
    req: DiscoverRequest,
) -> Result<(Vec<String>, String), String> {
    let req = if req.provider_type.trim() == CONSOLE_PROVIDER {
        let session = portal
            .credentials()
            .map_err(|_| CONSOLE_SIGN_IN.to_owned())?;
        DiscoverRequest {
            provider_type: "openai-oauth2".into(),
            base_url: format!("{}{CONSOLE_LLM_PATH}", session.base_url),
            access_token: session.access_token,
            models_path: "/models".into(),
            ..Default::default()
        }
    } else {
        req
    };
    let endpoint = models_endpoint(&req)?;
    let (header, value) = auth_header(&req)?;
    let response = portal
        .client
        .get(&endpoint)
        .header("Accept", "application/json")
        .header(header, value)
        .send()
        .await
        .map_err(|_| {
            "Failed to reach model endpoint; please check the URL and credentials".to_owned()
        })?;
    let status = response.status().as_u16();
    let body = read_limited(response)
        .await
        .map_err(|_| "Failed to read model response".to_owned())?;
    if status >= 400 {
        return Err(format!(
            "Model endpoint returned {status}: {}",
            compact_remote_error(&body)
        ));
    }
    let models = extract_model_ids(&body);
    if models.is_empty() {
        return Err("No usable models parsed from the response".into());
    }
    Ok((models, endpoint))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(provider: &str, base: &str, path: &str) -> DiscoverRequest {
        DiscoverRequest {
            provider_type: provider.into(),
            base_url: base.into(),
            models_path: path.into(),
            ..Default::default()
        }
    }

    #[test]
    fn builds_endpoints() {
        assert_eq!(
            models_endpoint(&req("openai", "", "")),
            Ok("https://api.openai.com/v1/models".into())
        );
        assert_eq!(
            models_endpoint(&req("openai", "https://proxy.test/", "")),
            Ok("https://proxy.test/v1/models".into())
        );
        assert_eq!(
            models_endpoint(&req("custom", "https://x.test/api/models", "models")),
            Ok("https://x.test/api/models".into())
        );
        assert_eq!(
            models_endpoint(&req("custom", "https://x.test", "list")),
            Ok("https://x.test/list".into())
        );
        assert_eq!(
            models_endpoint(&req("custom", "https://x.test", "https://y.test/m")),
            Ok("https://y.test/m".into())
        );
        assert_eq!(
            models_endpoint(&req("custom", "", "")),
            Err("Please fill in the Provider URL first".into())
        );
        assert_eq!(
            models_endpoint(&req("custom", "ftp://x", "")),
            Err("Invalid Provider URL format".into())
        );
    }

    #[test]
    fn chooses_auth_headers() {
        let mut r = req("custom", "", "");
        r.api_key = "k".into();
        r.auth_scheme = "X-API-Key".into();
        assert_eq!(auth_header(&r), Ok(("X-API-Key".into(), "k".into())));
        r.auth_scheme = "raw".into();
        r.auth_header = "Api".into();
        assert_eq!(auth_header(&r), Ok(("Api".into(), "k".into())));
        assert_eq!(
            auth_header(&req("openai", "", "")),
            Err("Please fill in the API Key first".into())
        );
        assert_eq!(
            auth_header(&req("other", "", "")),
            Err("This Provider type is not supported yet".into())
        );
    }

    #[test]
    fn extracts_model_ids() {
        let body = br#"{"data":[{"id":"gpt-b"},{"id":"gpt-a","name":"Display Name"},{"model":"x y-z"}],"models":["skip"]}"#;
        assert_eq!(extract_model_ids(body), vec!["gpt-a", "gpt-b", "x y-z"]);
        assert!(extract_model_ids(b"not json").is_empty());
    }
}
