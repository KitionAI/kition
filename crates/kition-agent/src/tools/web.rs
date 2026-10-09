//! Reading the public web: `web_fetch`, `web_article_save`, and image
//! downloads. Requests never reach loopback, private, or link-local
//! addresses, so page content cannot steer the agent into the local API or
//! the user's network; redirects are followed by hand to check every hop.

use std::cell::RefCell;
use std::net::IpAddr;
use std::time::Duration;

use serde_json::{Value, json};
use url::Url;

use crate::run::{Run, ToolOutput, ToolResult, int_field, string_list, text_field, truncate_chars};
use crate::workspace::{parent_folder, sanitize_filename};

const MAX_REDIRECTS: usize = 5;
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || a >= 224)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

/// Rejects URLs that are not http(s) or that resolve to a non-public
/// address.
pub async fn check_public_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http/https URLs are supported".into());
    }
    let host = url.host_str().ok_or("invalid URL")?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") || host.to_lowercase().ends_with(".localhost") {
        return Err("local network addresses are not allowed".into());
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let addresses: Vec<IpAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| format!("could not resolve {host}"))?
            .map(|addr| addr.ip())
            .collect(),
    };
    if addresses.is_empty() || addresses.iter().any(|ip| !is_public(*ip)) {
        return Err("local network addresses are not allowed".into());
    }
    Ok(())
}

pub struct Fetched {
    pub url: Url,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// GETs a public URL, following up to five checked redirects.
pub async fn get_public(
    http: &reqwest::Client,
    raw: &str,
    accept: &str,
    user_agent: &str,
    timeout: Duration,
    max_bytes: usize,
) -> Result<Fetched, String> {
    let mut url = Url::parse(raw.trim()).map_err(|_| "invalid URL".to_owned())?;
    for _ in 0..=MAX_REDIRECTS {
        check_public_url(&url).await?;
        let response = http
            .get(url.clone())
            .header(http::header::ACCEPT, accept)
            .header(http::header::USER_AGENT, user_agent)
            .timeout(timeout)
            .send()
            .await
            .map_err(|error| format!("request failed: {}", error.without_url()))?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(http::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("redirect without a location")?;
            url = url
                .join(location)
                .map_err(|_| "invalid redirect".to_owned())?;
            continue;
        }
        if status.as_u16() >= 400 {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        let content_type = response
            .headers()
            .get(http::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let mut body = Vec::new();
        let mut response = response;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "failed to read response".to_owned())?
        {
            let room = max_bytes.saturating_sub(body.len());
            body.extend_from_slice(&chunk[..chunk.len().min(room)]);
            if room <= chunk.len() {
                break;
            }
        }
        return Ok(Fetched {
            url,
            content_type,
            body,
        });
    }
    Err("too many redirects".into())
}

/// The readable text of an HTML or plain-text page.
fn page_text(raw: &str, content_type: &str) -> (String, String) {
    let title = regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>")
        .ok()
        .and_then(|re| re.captures(raw).map(|c| clean_text(&c[1])))
        .unwrap_or_default();
    let is_html = content_type.to_lowercase().contains("html")
        || raw.contains("<html")
        || raw.contains("<body");
    if !is_html {
        return (title, clean_text(raw));
    }
    let text = htmd::HtmlToMarkdown::builder()
        .skip_tags(vec![
            "script", "style", "noscript", "head", "svg", "nav", "footer", "iframe",
        ])
        .build()
        .convert(raw)
        .unwrap_or_default();
    (title, clean_text(&text))
}

fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn clean_text(text: &str) -> String {
    let text = decode_entities(text).replace('\u{a0}', " ");
    let mut out: Vec<String> = Vec::new();
    let mut blank = 0;
    for line in text.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            blank += 1;
            if blank == 1 && !out.is_empty() {
                out.push(String::new());
            }
            continue;
        }
        blank = 0;
        out.push(line);
    }
    out.join("\n").trim().to_owned()
}

fn page_links(raw: &str, base: &Url, limit: usize) -> Vec<Value> {
    let Ok(anchor) = regex::Regex::new(
        r#"(?is)<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^'">\s]+))[^>]*>(.*?)</a>"#,
    ) else {
        return Vec::new();
    };
    let tags = regex::Regex::new(r"(?s)<[^>]+>").ok();
    let mut seen = std::collections::HashSet::new();
    let mut links = Vec::new();
    for capture in anchor.captures_iter(raw) {
        let href = decode_entities(
            capture
                .get(1)
                .or_else(|| capture.get(2))
                .or_else(|| capture.get(3))
                .map_or("", |m| m.as_str())
                .trim(),
        );
        let lower = href.to_lowercase();
        if href.is_empty()
            || lower.starts_with('#')
            || lower.starts_with("javascript:")
            || lower.starts_with("mailto:")
            || lower.starts_with("tel:")
        {
            continue;
        }
        let Ok(resolved) = base.join(&href) else {
            continue;
        };
        if !matches!(resolved.scheme(), "http" | "https") {
            continue;
        }
        let inner = capture.get(4).map_or("", |m| m.as_str());
        let text = clean_text(&tags.as_ref().map_or(inner.to_owned(), |re| {
            re.replace_all(inner, " ").into_owned()
        }));
        if !seen.insert(format!("{resolved}\n{text}")) {
            continue;
        }
        links.push(json!({ "url": resolved.as_str(), "text": truncate_chars(&text, 160) }));
        if links.len() >= limit {
            break;
        }
    }
    links
}

async fn fetch_page(run: &Run, raw: &str) -> Value {
    let result = get_public(
        run.agent.web(),
        raw,
        "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8",
        "KitionAgent/1.0",
        Duration::from_secs(25),
        1 << 20,
    )
    .await;
    match result {
        Err(error) => json!({ "url": raw, "error": format!("failed to fetch web page: {error}") }),
        Ok(page) => {
            let body = String::from_utf8_lossy(&page.body);
            let (title, text) = page_text(&body, &page.content_type);
            let links = if page.content_type.contains("html") || body.contains("<html") {
                page_links(&body, &page.url, 80)
            } else {
                Vec::new()
            };
            json!({
                "url": page.url.as_str(),
                "host": page.url.host_str().unwrap_or_default().to_lowercase(),
                "title": title,
                "content_type": page.content_type,
                "text": truncate_chars(&text, 6000),
                "links": links,
            })
        }
    }
}

pub async fn web_fetch(run: &Run, input: &Value) -> ToolResult {
    let mut urls: Vec<String> = Vec::new();
    for raw in std::iter::once(text_field(input, "url")).chain(string_list(input, "urls")) {
        if !raw.is_empty() && !urls.contains(&raw) && urls.len() < 3 {
            urls.push(raw);
        }
    }
    if urls.is_empty() {
        return Err("missing URL to fetch".into());
    }
    let mut pages = Vec::new();
    for url in &urls {
        pages.push(fetch_page(run, url).await);
    }
    let mut ok = false;
    let rows: Vec<String> = pages
        .iter()
        .map(|page| {
            let url = page["url"].as_str().unwrap_or_default();
            if let Some(error) = page.get("error").and_then(Value::as_str) {
                return format!("- `{url}`: {error}");
            }
            ok = true;
            let title = page["title"]
                .as_str()
                .filter(|t| !t.is_empty())
                .unwrap_or(url);
            format!(
                "- [{title}]({url}): {}",
                truncate_chars(page["text"].as_str().unwrap_or_default(), 900)
            )
        })
        .collect();
    let output = json!({ "pages": pages });
    if !ok {
        return Err(crate::run::ToolError {
            message: "web fetch failed".into(),
            summary: format!("Web fetch failed:\n{}", rows.join("\n")),
            output: Some(output),
        });
    }
    Ok(ToolOutput::new(
        format!("Web fetch results:\n{}", rows.join("\n")),
        output,
    ))
}

pub fn extension_for_image_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => Some(".jpg"),
        "image/png" => Some(".png"),
        "image/webp" => Some(".webp"),
        "image/gif" => Some(".gif"),
        "image/svg+xml" => Some(".svg"),
        "image/avif" => Some(".avif"),
        _ => None,
    }
}

pub struct ImageAsset {
    pub data: Vec<u8>,
    pub mime: String,
    pub extension: &'static str,
}

/// Downloads a public image (at most 12 MB).
pub async fn fetch_image(http: &reqwest::Client, raw: &str) -> Result<ImageAsset, String> {
    let fetched = get_public(
        http,
        raw,
        "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml;q=0.8,*/*;q=0.5",
        "KitionAgent/1.0",
        Duration::from_secs(30),
        12 << 20,
    )
    .await
    .map_err(|error| format!("failed to download image: {error}"))?;
    if fetched.body.is_empty() {
        return Err("image response was empty".into());
    }
    let mut mime = fetched
        .content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned();
    if mime.is_empty() || mime == "application/octet-stream" {
        mime = kition_ai::engine::sniff_mime(&fetched.body).to_owned();
    }
    let extension = extension_for_image_mime(&mime)
        .ok_or_else(|| format!("response is not a supported image type: {mime}"))?;
    Ok(ImageAsset {
        data: fetched.body,
        mime,
        extension,
    })
}

const ANTI_BOT_MARKERS: &[&str] = &["verify you are a human", "are you a robot", "cf-challenge"];

/// Makes lazy-loaded images real and un-hides content hidden by inline
/// styles, before readability decides what the article is.
fn prepare_article_html(html: &str) -> String {
    use lol_html::{RewriteStrSettings, element, rewrite_str};
    let lazy = [
        "data-src",
        "data-original",
        "data-original-src",
        "data-lazy-src",
        "data-actualsrc",
    ];
    rewrite_str(
        html,
        RewriteStrSettings {
            element_content_handlers: vec![
                element!("img", |el| {
                    let src = el.get_attribute("src").unwrap_or_default();
                    let src = src.trim();
                    let real = !src.is_empty()
                        && !src.starts_with("data:image/svg")
                        && !src.contains("concat(");
                    if !real
                        && let Some(value) = lazy
                            .iter()
                            .find_map(|key| el.get_attribute(key).filter(|v| !v.trim().is_empty()))
                    {
                        el.set_attribute("src", value.trim())?;
                    }
                    Ok(())
                }),
                element!("*[hidden]", |el| {
                    el.remove_attribute("hidden");
                    Ok(())
                }),
                element!("*[style]", |el| {
                    let style = el.get_attribute("style").unwrap_or_default();
                    let kept: Vec<&str> = style
                        .split(';')
                        .map(str::trim)
                        .filter(|part| {
                            let lower = part.to_lowercase().replace(' ', "");
                            !part.is_empty()
                                && !lower.starts_with("visibility:hidden")
                                && !lower.starts_with("visibility:collapse")
                                && !lower.starts_with("display:none")
                                && !lower.starts_with("opacity:0")
                        })
                        .collect();
                    el.set_attribute("style", &kept.join("; "))?;
                    Ok(())
                }),
            ],
            ..RewriteStrSettings::new()
        },
    )
    .unwrap_or_else(|_| html.to_owned())
}

fn absolutize(raw: &str, base: &Url) -> Option<Url> {
    let raw = raw.trim();
    if raw.is_empty() || raw.starts_with("data:") {
        return None;
    }
    base.join(raw)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
}

fn image_sources(html: &str) -> Vec<String> {
    use lol_html::{RewriteStrSettings, element, rewrite_str};
    let found = RefCell::new(Vec::new());
    let _ = rewrite_str(
        html,
        RewriteStrSettings {
            element_content_handlers: vec![element!("img", |el| {
                if let Some(src) = ["src", "data-src", "data-original", "data-original-src"]
                    .iter()
                    .find_map(|key| el.get_attribute(key).filter(|v| !v.trim().is_empty()))
                {
                    found.borrow_mut().push(src.trim().to_owned());
                }
                Ok(())
            })],
            ..RewriteStrSettings::new()
        },
    );
    found.into_inner()
}

fn rewrite_images(html: &str, map: &std::collections::HashMap<String, String>) -> String {
    use lol_html::{RewriteStrSettings, element, rewrite_str};
    rewrite_str(
        html,
        RewriteStrSettings {
            element_content_handlers: vec![element!("img", |el| {
                for key in ["src", "data-src", "data-original", "data-original-src"] {
                    if let Some(local) = el
                        .get_attribute(key)
                        .and_then(|value| map.get(value.trim()).cloned())
                    {
                        el.set_attribute("src", &local)?;
                        break;
                    }
                }
                Ok(())
            })],
            ..RewriteStrSettings::new()
        },
    )
    .unwrap_or_else(|_| html.to_owned())
}

/// The parts of a readability result kept after parsing.
struct Article {
    title: String,
    byline: Option<String>,
    content: String,
    site_name: Option<String>,
    published_time: Option<String>,
}

fn yaml_string(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', " ")
    )
}

pub async fn web_article_save(run: &Run, tool_call_id: i64, input: &Value) -> ToolResult {
    let raw = text_field(input, "url");
    if raw.is_empty() {
        return Err("missing article URL".into());
    }
    let max_images = match int_field(input, "max_images") {
        n if n <= 0 => 50,
        n => n.min(200),
    } as usize;
    let http = run.agent.web().clone();
    let page = get_public(
        &http,
        &raw,
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        BROWSER_USER_AGENT,
        Duration::from_secs(25),
        8 << 20,
    )
    .await
    .map_err(|error| format!("failed to fetch article page: {error}"))?;
    let html = String::from_utf8_lossy(&page.body).into_owned();
    let head: String = html.chars().take(4096).collect::<String>().to_lowercase();
    if ANTI_BOT_MARKERS.iter().any(|marker| head.contains(marker)) {
        return Err("the page is showing an anti-bot verification screen, so it cannot be archived automatically".into());
    }
    let prepared = prepare_article_html(&html);
    let base = page.url.clone();
    let article = tokio::task::spawn_blocking(move || {
        dom_smoothie::Readability::new(prepared, Some(base.as_str()), None)
            .and_then(|mut readability| readability.parse())
            .map(|article| Article {
                title: article.title,
                byline: article.byline,
                content: article.content.to_string(),
                site_name: article.site_name,
                published_time: article.published_time,
            })
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "failed to extract article".to_owned())?
    .map_err(|error| format!("no readable article content extracted: {error}"))?;
    let content = article.content;
    if content.trim().is_empty() {
        return Err("no readable article content extracted".into());
    }
    let mut title = text_field(input, "title");
    if title.is_empty() {
        title = article.title.trim().to_owned();
    }
    let title = sanitize_filename(&title, "Web Article");
    let folder = text_field(input, "folder");
    let parent = if !folder.is_empty() {
        folder.trim_end_matches('/').to_owned()
    } else if !parent_folder(&run.active_document_path).is_empty() {
        parent_folder(&run.active_document_path)
    } else {
        "Agent".to_owned()
    };
    let article_folder = format!("{parent}/{title}");
    let images_folder = format!("{article_folder}/images");
    let mut map = std::collections::HashMap::new();
    let mut warnings = Vec::new();
    let mut saved = 0;
    let mut seen = std::collections::HashSet::new();
    for src in image_sources(&content) {
        let Some(absolute) = absolutize(&src, &page.url) else {
            continue;
        };
        if !seen.insert(absolute.to_string()) {
            continue;
        }
        if saved >= max_images {
            warnings
                .push(json!({ "url": absolute.as_str(), "reason": "max_images limit reached" }));
            continue;
        }
        match fetch_image(&http, absolute.as_str()).await {
            Ok(asset) => {
                let filename = format!("img-{:03}{}", saved + 1, asset.extension);
                match run
                    .workspace()
                    .write_new(&images_folder, &filename, &asset.data)
                {
                    Ok(path) => {
                        let local =
                            format!("images/{}", path.rsplit('/').next().unwrap_or(&filename));
                        map.insert(src.clone(), local.clone());
                        map.insert(absolute.to_string(), local);
                        saved += 1;
                    }
                    Err(error) => {
                        warnings.push(json!({ "url": absolute.as_str(), "reason": error }))
                    }
                }
            }
            Err(error) => warnings.push(json!({ "url": absolute.as_str(), "reason": error })),
        }
    }
    let rendered = rewrite_images(&content, &map);
    let markdown = htmd::convert(&rendered)
        .map_err(|error| format!("failed to convert HTML to Markdown: {error}"))?;
    let mut front = format!(
        "---\ntitle: {}\nsource_url: {}\ncaptured_at: {}\n",
        yaml_string(&title),
        yaml_string(page.url.as_str()),
        kition_core::time::to_rfc3339(kition_core::now_millis())
    );
    if let Some(byline) = article
        .byline
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        front.push_str(&format!("author: {}\n", yaml_string(byline)));
    }
    if let Some(site) = article
        .site_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        front.push_str(&format!("site_name: {}\n", yaml_string(site)));
    }
    if let Some(published) = article
        .published_time
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        front.push_str(&format!("published_at: {}\n", yaml_string(published)));
    }
    front.push_str("---\n");
    let document = format!("{front}\n# {title}\n\n{}\n", markdown.trim());
    let path = run
        .workspace()
        .write_new(&article_folder, "index.md", document.as_bytes())?;
    let artifact = run
        .record_artifact(
            Some(tool_call_id),
            "markdown",
            &path,
            "text/markdown",
            &title,
        )
        .await;
    let mut summary = format!("Saved article: `{path}` ({saved} images)");
    if !warnings.is_empty() {
        summary.push_str(&format!("; {} image(s) skipped", warnings.len()));
    }
    Ok(ToolOutput {
        artifact,
        ..ToolOutput::new(
            summary,
            json!({
                "path": path, "title": title, "folder": article_folder,
                "source_url": page.url.as_str(), "source": "direct_fetch",
                "image_count": saved, "warnings": warnings,
            }),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refuses_local_addresses() {
        for raw in [
            "http://127.0.0.1:18101/api/v1/users",
            "http://localhost/",
            "http://[::1]/",
            "http://10.0.0.1/",
            "http://169.254.169.254/latest/meta-data",
            "http://192.168.1.10/",
            "file:///etc/passwd",
        ] {
            let url = Url::parse(raw).unwrap_or_else(|err| panic!("{err}"));
            assert!(check_public_url(&url).await.is_err(), "{raw}");
        }
        let public = Url::parse("https://93.184.216.34/").unwrap_or_else(|err| panic!("{err}"));
        assert!(check_public_url(&public).await.is_ok());
    }

    #[test]
    fn extracts_text_and_links() {
        let html = r#"<html><head><title>T &amp; U</title><script>x()</script></head>
            <body><p>Hello <b>world</b></p><a href="/a">First</a><a href="mailto:x">M</a></body></html>"#;
        let (title, text) = page_text(html, "text/html");
        assert_eq!(title, "T & U");
        assert!(text.contains("Hello **world**"));
        assert!(!text.contains("x()"));
        let base = Url::parse("https://example.com/post").unwrap_or_else(|err| panic!("{err}"));
        let links = page_links(html, &base, 10);
        assert_eq!(
            links,
            vec![json!({ "url": "https://example.com/a", "text": "First" })]
        );
    }

    #[test]
    fn prepares_and_rewrites_article_images() {
        let prepared = prepare_article_html(
            r#"<img data-src="a.png"><p hidden style="display:none; color: red">x</p>"#,
        );
        assert!(prepared.contains(r#"src="a.png""#));
        assert!(!prepared.contains("hidden"));
        assert!(prepared.contains(r#"style="color: red""#));
        assert_eq!(image_sources(&prepared), ["a.png"]);
        let map = std::collections::HashMap::from([(
            "a.png".to_owned(),
            "images/img-001.png".to_owned(),
        )]);
        assert!(rewrite_images(&prepared, &map).contains(r#"src="images/img-001.png""#));
    }
}
