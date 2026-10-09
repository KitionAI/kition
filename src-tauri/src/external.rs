//! Links that leave the app: external URLs and the navigation the main
//! window may perform itself.

use url::Url;

const ALLOWED_EXTERNAL_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

/// An absolute http(s) or mailto URL, ready for the system browser.
pub fn normalize_external_url(value: &str) -> Result<String, String> {
    let raw = value.trim();
    if raw.is_empty() {
        return Err("url is required".into());
    }
    let parsed = Url::parse(raw).map_err(|_| "url must be absolute".to_owned())?;
    if !ALLOWED_EXTERNAL_SCHEMES.contains(&parsed.scheme()) {
        return Err(format!("url protocol is not allowed: {}:", parsed.scheme()));
    }
    Ok(parsed.to_string())
}

/// Whether the main window may follow a navigation to `target` instead of
/// handing it to the system browser.
pub fn is_trusted_navigation(target: &Url, initial: &Url) -> bool {
    if target.scheme() != initial.scheme() {
        return false;
    }
    match initial.scheme() {
        "file" => target.host() == initial.host() && target.path() == initial.path(),
        "about" => target == initial,
        _ => target.origin() == initial.origin(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_external_urls() {
        assert_eq!(
            normalize_external_url(" https://kition.ai ")
                .ok()
                .as_deref(),
            Some("https://kition.ai/")
        );
        assert!(normalize_external_url("mailto:support@kition.ai").is_ok());
        assert_eq!(
            normalize_external_url("file:///etc/passwd")
                .err()
                .as_deref(),
            Some("url protocol is not allowed: file:")
        );
        assert_eq!(
            normalize_external_url("relative").err().as_deref(),
            Some("url must be absolute")
        );
        assert_eq!(
            normalize_external_url("").err().as_deref(),
            Some("url is required")
        );
    }

    #[test]
    fn trusts_same_origin_navigation() {
        let initial = Url::parse("http://127.0.0.1:3000/").unwrap_or_else(|err| panic!("{err}"));
        let same =
            Url::parse("http://127.0.0.1:3000/settings").unwrap_or_else(|err| panic!("{err}"));
        let other = Url::parse("https://example.com/").unwrap_or_else(|err| panic!("{err}"));
        assert!(is_trusted_navigation(&same, &initial));
        assert!(!is_trusted_navigation(&other, &initial));
    }
}
