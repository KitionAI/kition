//! Image bytes for the renderer: remote images it cannot fetch itself, and
//! workspace images inlined into exported HTML so clipboard and PDF exports
//! carry them.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::StreamExt;
use regex::{Captures, Regex};
use serde_json::{Value, json};
use url::Url;

use crate::workspace::files::{extname, resolve, resolve_safe};
use crate::workspace::safety::{assert_safe, is_within, lexical_resolve};

const MAX_REMOTE_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const REMOTE_IMAGE_TIMEOUT: Duration = Duration::from_secs(15);

static IMAGE_SOURCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<img\b[^>]*?\bsrc=(?:"([^"]*)"|'([^']*)')[^>]*>"#)
        .unwrap_or_else(|error| panic!("invalid image source pattern: {error}"))
});

fn image_mime_from_bytes(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        "image/png"
    } else if bytes.starts_with(&[255, 216, 255]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        ""
    }
}

/// Downloads a pasted image without the renderer's CORS limits.
pub async fn read_remote_image(client: &reqwest::Client, source: &str) -> Result<Value, String> {
    let url = Url::parse(source).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("remote image requires an HTTP(S) URL without credentials".into());
    }
    let response = client
        .get(url)
        .timeout(REMOTE_IMAGE_TIMEOUT)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "image download failed: {}",
            response.status().as_u16()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let mut mime = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let generic_binary = matches!(
        mime.as_str(),
        "" | "application/octet-stream" | "binary/octet-stream"
    );
    if !mime.starts_with("image/") && !generic_binary {
        return Err("remote image response is not an image".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_REMOTE_IMAGE_BYTES)
    {
        return Err("remote image exceeds 50 MB import limit".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        if bytes.len() + chunk.len() > MAX_REMOTE_IMAGE_BYTES {
            return Err("remote image exceeds 50 MB import limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err("remote image response is empty".into());
    }
    if generic_binary {
        mime = image_mime_from_bytes(&bytes).to_owned();
    }
    if mime.is_empty() {
        return Err("remote image response is not an image".into());
    }
    Ok(json!({ "mime_type": mime, "base64_content": BASE64.encode(bytes) }))
}

/// Raw image bytes from a data URL or an HTTP(S) URL.
pub async fn image_bytes(client: &reqwest::Client, source: &str) -> Result<Vec<u8>, String> {
    let source = source.trim();
    if source.is_empty() {
        return Err("image URL is required".into());
    }
    if source.len() > 11 && source[..11].eq_ignore_ascii_case("data:image/") {
        let (_, payload) = source.split_once(',').ok_or("image data is empty")?;
        return BASE64
            .decode(payload.trim())
            .map_err(|_| "image data is empty".to_owned());
    }
    let response = client
        .get(source)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "image download failed: {}",
            response.status().as_u16()
        ));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| error.to_string())
}

pub fn decode_html_attribute(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

pub fn escape_html_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// JavaScript's `decodeURIComponent`, which rejects malformed escapes.
fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let valid = bytes.len() >= index + 3
                && bytes[index + 1].is_ascii_hexdigit()
                && bytes[index + 2].is_ascii_hexdigit();
            if !valid {
                return None;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|decoded| decoded.into_owned())
}

/// Decodes each path segment up to three times, for links that were encoded
/// more than once.
pub fn decode_uri_path(path: &str) -> String {
    path.split('/')
        .map(|part| {
            let mut decoded = part.to_owned();
            for _ in 0..3 {
                match decode_uri_component(&decoded) {
                    Some(next) if next != decoded => decoded = next,
                    _ => break,
                }
            }
            decoded
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn strip_url_suffix(value: &str) -> &str {
    value.split(['?', '#']).next().unwrap_or_default()
}

fn unwrap_markdown_destination(value: &str) -> &str {
    let raw = value.trim();
    if raw.len() >= 2 && raw.starts_with('<') && raw.ends_with('>') {
        raw[1..raw.len() - 1].trim()
    } else {
        raw
    }
}

fn parent_workspace_path(document_path: &str) -> String {
    let normalized = document_path.replace('\\', "/");
    match normalized.rfind('/') {
        Some(index) if index > 0 => normalized[..index].to_owned(),
        _ => String::new(),
    }
}

fn is_image_path(value: &str) -> bool {
    matches!(
        extname(strip_url_suffix(value))
            .to_ascii_lowercase()
            .as_str(),
        ".png" | ".jpg" | ".jpeg" | ".gif" | ".webp" | ".svg" | ".avif"
    )
}

fn is_workspace_root_image_path(value: &str) -> bool {
    let normalized = value.replace('\\', "/");
    let root = normalized
        .trim_start_matches('/')
        .split('/')
        .next()
        .unwrap_or_default()
        .to_lowercase();
    matches!(root.as_str(), "agent" | "attachments" | ".kition")
}

pub fn image_mime_from_path(path: &str) -> &'static str {
    match extname(strip_url_suffix(path))
        .to_ascii_lowercase()
        .as_str()
    {
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".avif" => "image/avif",
        _ => "image/png",
    }
}

fn starts_with_ignore_case(value: &str, prefix: &str) -> bool {
    value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// The `src` values that are still not data URLs.
pub fn unresolved_image_sources(html: &str) -> Vec<String> {
    IMAGE_SOURCE
        .captures_iter(html)
        .filter_map(|captures| {
            let raw = captures.get(1).or_else(|| captures.get(2))?.as_str();
            let source = decode_html_attribute(raw);
            (!source.is_empty() && !starts_with_ignore_case(&source, "data:image/"))
                .then_some(source)
        })
        .collect()
}

/// Inlines workspace and runtime images as data URLs.
pub struct ExportImages<'a> {
    pub backend_public_base_url: &'a str,
    pub workspace_root: &'a Path,
    pub client: &'a reqwest::Client,
}

impl ExportImages<'_> {
    fn backend_base(&self) -> Option<Url> {
        Url::parse(self.backend_public_base_url).ok()
    }

    fn resolve_url(&self, source: &str) -> String {
        let raw = source.trim();
        if raw.is_empty()
            || starts_with_ignore_case(raw, "data:")
            || starts_with_ignore_case(raw, "blob:")
        {
            return String::new();
        }
        if starts_with_ignore_case(raw, "kition-workspace:")
            || starts_with_ignore_case(raw, "http://")
            || starts_with_ignore_case(raw, "https://")
        {
            return raw.to_owned();
        }
        if raw.starts_with('/') {
            return self
                .backend_base()
                .and_then(|base| base.join(raw).ok())
                .map(|url| url.to_string())
                .unwrap_or_default();
        }
        String::new()
    }

    fn workspace_path_from_public_url(&self, raw: &str) -> String {
        let value = raw.trim();
        if value.is_empty() {
            return String::new();
        }
        let Some(base) = self.backend_base() else {
            return String::new();
        };
        let Ok(parsed) = base.join(value) else {
            return String::new();
        };
        let is_backend = parsed.origin() == base.origin();
        if (is_backend || value.starts_with('/')) && parsed.path().starts_with("/workspace-files/")
        {
            return decode_uri_path(&parsed.path()["/workspace-files/".len()..]);
        }
        String::new()
    }

    fn protocol_path(&self, raw: &str) -> Result<std::path::PathBuf, String> {
        let parsed = Url::parse(raw).map_err(|error| error.to_string())?;
        let host = decode_uri_component(parsed.host_str().unwrap_or_default()).unwrap_or_default();
        let path = decode_uri_component(parsed.path())
            .unwrap_or_default()
            .trim_start_matches('/')
            .to_owned();
        let relative = [host, path]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("/");
        let resolved = resolve(self.workspace_root, &relative, false).map_err(|e| e.to_string())?;
        assert_safe(self.workspace_root, &resolved.absolute, false).map_err(|e| e.to_string())
    }

    fn file_path(&self, source: &str, document_path: &str) -> Option<std::path::PathBuf> {
        let raw = unwrap_markdown_destination(source);
        let public_path = self.workspace_path_from_public_url(raw);
        let remote = starts_with_ignore_case(raw, "data:")
            || starts_with_ignore_case(raw, "blob:")
            || starts_with_ignore_case(raw, "http://")
            || starts_with_ignore_case(raw, "https://");
        if raw.is_empty() || (remote && public_path.is_empty()) {
            return None;
        }
        let root = self.workspace_root;
        let result = if starts_with_ignore_case(raw, "kition-workspace:") {
            self.protocol_path(raw)
        } else if starts_with_ignore_case(raw, "file:") {
            let target = Url::parse(strip_url_suffix(raw))
                .ok()
                .and_then(|url| url.to_file_path().ok())
                .map(|path| lexical_resolve(&path))?;
            let root = lexical_resolve(root);
            if !is_within(&root, &target) {
                return None;
            }
            assert_safe(&root, &target, false).map_err(|e| e.to_string())
        } else if !public_path.is_empty() {
            resolve_safe(root, &public_path, false, false)
                .map(|resolved| resolved.absolute)
                .map_err(|e| e.to_string())
        } else if is_image_path(raw) {
            let relative = strip_url_suffix(raw).trim_start_matches('/');
            let base = if is_workspace_root_image_path(relative) {
                String::new()
            } else {
                parent_workspace_path(document_path)
            };
            let joined = if base.is_empty() {
                relative.to_owned()
            } else {
                format!("{base}/{relative}")
            };
            resolve_safe(root, &joined, false, false)
                .map(|resolved| resolved.absolute)
                .map_err(|e| e.to_string())
        } else {
            return None;
        };
        match result {
            Ok(path) => Some(path),
            Err(error) => {
                eprintln!("failed to resolve export image file: {raw} {error}");
                None
            }
        }
    }

    async fn data_url(&self, source: &str, document_path: &str) -> String {
        if let Some(path) = self.file_path(source, document_path) {
            match std::fs::read(&path) {
                Ok(bytes) => {
                    return format!(
                        "data:{};base64,{}",
                        image_mime_from_path(&path.to_string_lossy()),
                        BASE64.encode(bytes)
                    );
                }
                Err(error) => eprintln!(
                    "failed to inline export image file: {} {error}",
                    path.display()
                ),
            }
        }
        let url = self.resolve_url(source);
        if url.is_empty() || starts_with_ignore_case(&url, "kition-workspace:") {
            return String::new();
        }
        let response = match self.client.get(&url).send().await {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                eprintln!("failed to inline export image: {url} {}", response.status());
                return String::new();
            }
            Err(error) => {
                eprintln!("failed to inline export image: {url} {error}");
                return String::new();
            }
        };
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("image/png")
            .to_owned();
        if !starts_with_ignore_case(&content_type, "image/") {
            return String::new();
        }
        match response.bytes().await {
            Ok(bytes) => format!("data:{content_type};base64,{}", BASE64.encode(bytes)),
            Err(_) => String::new(),
        }
    }

    pub async fn inline(&self, html: &str, document_path: &str) -> String {
        let mut sources: Vec<String> = Vec::new();
        for captures in IMAGE_SOURCE.captures_iter(html) {
            if let Some(raw) = captures.get(1).or_else(|| captures.get(2))
                && !sources.iter().any(|known| known == raw.as_str())
            {
                sources.push(raw.as_str().to_owned());
            }
        }
        if sources.is_empty() {
            return html.to_owned();
        }
        let mut replacements = std::collections::HashMap::new();
        for raw in sources {
            let data_url = self
                .data_url(&decode_html_attribute(&raw), document_path)
                .await;
            replacements.insert(raw, data_url);
        }
        IMAGE_SOURCE
            .replace_all(html, |captures: &Captures| {
                let tag = captures.get(0).map(|m| m.as_str()).unwrap_or_default();
                let (quote, raw) = match (captures.get(1), captures.get(2)) {
                    (Some(raw), _) => ('"', raw.as_str()),
                    (None, Some(raw)) => ('\'', raw.as_str()),
                    _ => return tag.to_owned(),
                };
                match replacements.get(raw) {
                    Some(data_url) if !data_url.is_empty() => tag.replacen(
                        &format!("{quote}{raw}{quote}"),
                        &format!("{quote}{}{quote}", escape_html_attribute(data_url)),
                        1,
                    ),
                    _ => tag.to_owned(),
                }
            })
            .into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_paths_and_attributes() {
        assert_eq!(decode_uri_path("a%2520b/c%20d"), "a b/c d");
        assert_eq!(decode_uri_path("100%"), "100%");
        assert_eq!(decode_html_attribute("a&amp;b&quot;"), "a&b\"");
        assert_eq!(escape_html_attribute("<a&\">"), "&lt;a&amp;&quot;&gt;");
        assert_eq!(image_mime_from_path("a.JPG?x=1"), "image/jpeg");
        assert_eq!(image_mime_from_bytes(b"GIF89a...."), "image/gif");
    }

    #[test]
    fn lists_unresolved_sources() {
        let html = r#"<p><img src="data:image/png;base64,AA"><img alt='x' src='a.png'></p>"#;
        assert_eq!(unresolved_image_sources(html), vec!["a.png".to_owned()]);
    }

    #[tokio::test]
    async fn inlines_workspace_images() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = std::fs::canonicalize(dir.path()).unwrap_or_else(|err| panic!("{err}"));
        std::fs::create_dir_all(root.join("notes/img")).unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(root.join("notes/img/a b.png"), b"png")
            .unwrap_or_else(|err| panic!("{err}"));
        std::fs::create_dir_all(root.join("assets")).unwrap_or_else(|err| panic!("{err}"));
        std::fs::write(root.join("assets/c.png"), b"c").unwrap_or_else(|err| panic!("{err}"));
        let client = reqwest::Client::new();
        let inliner = ExportImages {
            backend_public_base_url: "http://127.0.0.1:1",
            workspace_root: &root,
            client: &client,
        };
        let html = concat!(
            r#"<img src="img/a b.png">"#,
            r#"<img src="/workspace-files/assets/c.png">"#,
            r#"<img src="kition-workspace://assets/c.png">"#,
            r#"<img src="missing.png">"#,
        );
        let output = inliner.inline(html, "notes/doc.md").await;
        assert_eq!(
            output.matches("data:image/png;base64,").count(),
            3,
            "{output}"
        );
        assert!(output.contains(r#"src="missing.png""#));
    }
}
