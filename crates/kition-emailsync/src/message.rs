//! Turning a raw RFC 5322 message into Markdown plus attachments.

use std::path::Path;

use kition_core::{Millis, now_millis};
use mail_parser::{Address, MessageParser, MimeHeaders, PartType};

use crate::imap::MAX_RAW_MESSAGE_BYTES;

const MAX_TEXT_PART_BYTES: usize = 10 << 20;
const MAX_ATTACHMENT_BYTES: usize = 20 << 20;
const MAX_ATTACHMENTS: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAttachment {
    pub filename: String,
    pub content_type: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMessage {
    pub subject: String,
    pub from: String,
    pub to: String,
    pub cc: String,
    pub received_at: Millis,
    pub message_id: String,
    pub markdown: String,
    pub preview: String,
    pub attachments: Vec<ParsedAttachment>,
}

fn format_addresses(address: Option<&Address<'_>>) -> String {
    let Some(address) = address else {
        return String::new();
    };
    address
        .iter()
        .map(|addr| {
            let email = addr.address().unwrap_or_default();
            match addr.name().map(str::trim).filter(|n| !n.is_empty()) {
                Some(name) => format!(
                    "\"{}\" <{email}>",
                    name.replace('\\', "\\\\").replace('"', "\\\"")
                ),
                None => format!("<{email}>"),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn parse_message(raw: &[u8], internal_date: Option<Millis>) -> Result<ParsedMessage, String> {
    if raw.is_empty() {
        return Err("email message body is empty".into());
    }
    if raw.len() > MAX_RAW_MESSAGE_BYTES {
        return Err(format!(
            "email message exceeds the {} MB import limit",
            MAX_RAW_MESSAGE_BYTES >> 20
        ));
    }
    let message = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| "parse email message: malformed message".to_owned())?;
    let mut parsed = ParsedMessage {
        subject: message.subject().unwrap_or_default().trim().to_owned(),
        from: format_addresses(message.from()),
        to: format_addresses(message.to()),
        cc: format_addresses(message.cc()),
        received_at: message
            .date()
            .map(|d| d.to_timestamp() * 1000)
            .filter(|ms| *ms > 0)
            .or(internal_date)
            .unwrap_or_else(now_millis),
        message_id: message
            .message_id()
            .unwrap_or_default()
            .trim()
            .trim_matches(['<', '>'])
            .to_owned(),
        markdown: String::new(),
        preview: String::new(),
        attachments: Vec::new(),
    };
    if parsed.subject.is_empty() {
        parsed.subject = "Untitled email".into();
    }

    let (mut plain, mut html) = (String::new(), String::new());
    for part in message
        .parts
        .iter()
        .skip(1)
        .chain(message.parts.first().filter(|_| message.parts.len() == 1))
    {
        let is_attachment = part
            .content_disposition()
            .is_some_and(|d| d.is_attachment());
        if is_attachment {
            if parsed.attachments.len() >= MAX_ATTACHMENTS {
                return Err(format!(
                    "email contains more than {MAX_ATTACHMENTS} attachments"
                ));
            }
            let filename = part.attachment_name().unwrap_or("attachment").to_owned();
            let data = part.contents();
            if data.len() > MAX_ATTACHMENT_BYTES {
                return Err(format!(
                    "read attachment {filename:?}: MIME part exceeds the {} MB import limit",
                    MAX_ATTACHMENT_BYTES >> 20
                ));
            }
            let content_type = part
                .content_type()
                .map(|ct| match ct.subtype() {
                    Some(sub) => format!("{}/{sub}", ct.ctype()),
                    None => ct.ctype().to_owned(),
                })
                .unwrap_or_default()
                .to_lowercase();
            parsed.attachments.push(ParsedAttachment {
                filename: sanitize_attachment_name(&filename),
                content_type,
                data: data.to_vec(),
            });
            continue;
        }
        match &part.body {
            PartType::Text(text) => {
                if text.len() > MAX_TEXT_PART_BYTES {
                    return Err(format!(
                        "MIME part exceeds the {} MB import limit",
                        MAX_TEXT_PART_BYTES >> 20
                    ));
                }
                if plain.is_empty() {
                    plain = convert_plain_text(text);
                }
            }
            PartType::Html(text) => {
                if text.len() > MAX_TEXT_PART_BYTES {
                    return Err(format!(
                        "MIME part exceeds the {} MB import limit",
                        MAX_TEXT_PART_BYTES >> 20
                    ));
                }
                if html.is_empty() {
                    html = text.to_string();
                }
            }
            _ => {}
        }
    }
    if !html.is_empty() {
        match convert_html(&html) {
            Ok(markdown) => parsed.markdown = markdown,
            Err(err) if plain.is_empty() => {
                return Err(format!("convert email HTML to Markdown: {err}"));
            }
            Err(_) => {}
        }
    }
    if parsed.markdown.is_empty() && !plain.is_empty() {
        parsed.markdown = plain;
    }
    if parsed.markdown.is_empty() {
        parsed.markdown = "_This message has no readable text body._".into();
    }
    parsed.preview = preview_text(&parsed.markdown, 240);
    Ok(parsed)
}

/// Collapses runs of whitespace and limits to `limit` characters.
pub fn preview_text(value: &str, limit: usize) -> String {
    let joined = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() <= limit {
        return joined;
    }
    let cut: String = joined.chars().take(limit.saturating_sub(1)).collect();
    format!("{}...", cut.trim())
}

/// Normalizes line endings, trims trailing whitespace per line and the
/// whole text.
pub fn normalize_text(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

/// A line made of at least three identical `-`, `=`, `_`, or `*`.
fn decorative_line(value: &str) -> Option<char> {
    let mut marker = None;
    let mut count = 0;
    for ch in value.trim().chars().filter(|c| !c.is_whitespace()) {
        if !matches!(ch, '-' | '=' | '_' | '*') {
            return None;
        }
        match marker {
            None => marker = Some(ch),
            Some(m) if m != ch => return None,
            Some(_) => {}
        }
        count += 1;
    }
    if count >= 3 { marker } else { None }
}

fn indent_width(value: &str) -> usize {
    let mut indent = 0;
    for ch in value.chars() {
        match ch {
            ' ' => indent += 1,
            '\t' => indent += 2,
            _ => break,
        }
    }
    indent
}

/// Plain text with setext-style underlines turned into ATX headings and
/// decorative rules removed.
pub fn convert_plain_text(value: &str) -> String {
    let normalized = normalize_text(value);
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        if !line.trim().is_empty()
            && index + 1 < lines.len()
            && matches!(decorative_line(lines[index + 1]), Some('-' | '='))
        {
            let level = 2 + (indent_width(line) / 2).min(4);
            out.push(format!("{} {}", "#".repeat(level), line.trim()));
            index += 2;
            continue;
        }
        if decorative_line(line).is_none() {
            out.push(line.to_owned());
        }
        index += 1;
    }
    normalize_text(&out.join("\n"))
}

const UNSAFE_TAGS: [&str; 12] = [
    "script", "style", "iframe", "object", "embed", "form", "input", "button", "img", "source",
    "video", "audio",
];

/// Removes active content, hidden elements, styles, event handlers, and
/// dangerous links.
pub fn sanitize_html(value: &str) -> String {
    use lol_html::{RewriteStrSettings, element, rewrite_str};
    let unsafe_selector = UNSAFE_TAGS.join(", ");
    let settings = RewriteStrSettings {
        element_content_handlers: vec![
            element!(unsafe_selector.as_str(), |el| {
                el.remove();
                Ok(())
            }),
            element!("*", |el| {
                if is_hidden(el) {
                    el.remove();
                    return Ok(());
                }
                let names: Vec<String> = el.attributes().iter().map(|a| a.name()).collect();
                for name in names {
                    let key = name.to_lowercase();
                    let value = el
                        .get_attribute(&name)
                        .unwrap_or_default()
                        .trim()
                        .to_lowercase();
                    let dangerous_link = (key == "href" || key == "action")
                        && (value.starts_with("javascript:")
                            || value.starts_with("data:")
                            || value.starts_with("file:"));
                    if key == "style" || key.starts_with("on") || key == "srcdoc" || dangerous_link
                    {
                        el.remove_attribute(&name);
                    }
                }
                Ok(())
            }),
        ],
        ..RewriteStrSettings::new()
    };
    rewrite_str(value, settings).unwrap_or_else(|_| value.to_owned())
}

fn is_hidden(el: &lol_html::html_content::Element<'_, '_>) -> bool {
    if el.has_attribute("hidden") {
        return true;
    }
    if el
        .get_attribute("aria-hidden")
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("true"))
    {
        return true;
    }
    el.get_attribute("style").is_some_and(|style| {
        let compact: String = style
            .to_lowercase()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        compact.contains("display:none")
            || compact.contains("visibility:hidden")
            || compact.contains("mso-hide:all")
    })
}

pub fn convert_html(value: &str) -> Result<String, String> {
    let converter = htmd::HtmlToMarkdown::builder()
        .options(htmd::options::Options {
            heading_style: htmd::options::HeadingStyle::Atx,
            hr_style: htmd::options::HrStyle::Dashes,
            ..htmd::options::Options::default()
        })
        .build();
    let markdown = converter
        .convert(&sanitize_html(value))
        .map_err(|e| e.to_string())?;
    Ok(normalize_text(&markdown))
}

/// A safe file name for an attachment.
pub fn sanitize_attachment_name(value: &str) -> String {
    let base = Path::new(value.trim())
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mapped: String = base
        .chars()
        .map(|c| {
            if (c as u32) < 32 || c as u32 == 127 || matches!(c, '/' | '\\' | ':') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = mapped.trim_matches([' ', '.']);
    if trimmed.is_empty() {
        "attachment".into()
    } else {
        trimmed.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multipart_message() {
        let raw = b"From: \"Ada L\" <ada@example.com>\r\nTo: bob@example.com, \"C\" <c@example.com>\r\n\
Subject: =?utf-8?B?R3LDvMOfZQ==?=\r\nMessage-ID: <abc@example.com>\r\nDate: Fri, 09 Oct 2026 03:57:06 +0000\r\n\
MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=XX\r\n\r\n\
--XX\r\nContent-Type: multipart/alternative; boundary=YY\r\n\r\n\
--YY\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello\r\n=====\r\nBody text\r\n\
--YY\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<h1>Hello</h1><p>Body <b>text</b></p><script>x()</script><div style=\"display:none\">secret</div>\r\n\
--YY--\r\n--XX\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"re:port.pdf\"\r\n\r\n%PDF\r\n--XX--\r\n";
        let parsed = parse_message(raw, Some(1)).unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(parsed.subject, "Grüße");
        assert_eq!(parsed.from, "\"Ada L\" <ada@example.com>");
        assert_eq!(parsed.to, "<bob@example.com>, \"C\" <c@example.com>");
        assert_eq!(parsed.message_id, "abc@example.com");
        assert_eq!(parsed.received_at, 1_791_518_226_000);
        assert!(
            parsed.markdown.starts_with("# Hello"),
            "{}",
            parsed.markdown
        );
        assert!(parsed.markdown.contains("Body **text**"));
        assert!(!parsed.markdown.contains("secret"));
        assert_eq!(parsed.attachments.len(), 1);
        assert_eq!(parsed.attachments[0].filename, "re-port.pdf");
        assert_eq!(parsed.attachments[0].content_type, "application/pdf");
    }

    #[test]
    fn plain_text_headings_and_rules() {
        assert_eq!(
            convert_plain_text("Title\n=====\n\n----\nText  \r\n"),
            "## Title\n\nText"
        );
        assert_eq!(convert_plain_text("    Sub\n---"), "## Sub");
        assert_eq!(convert_plain_text("x\n    Sub\n---"), "x\n#### Sub");
    }

    #[test]
    fn previews_and_names() {
        assert_eq!(preview_text("a  b\n c", 240), "a b c");
        assert_eq!(preview_text("abcdef", 4), "abc...");
        assert_eq!(sanitize_attachment_name(" ../x/..evil:name. "), "evil-name");
        assert_eq!(sanitize_attachment_name(" "), "attachment");
    }

    #[test]
    fn empty_bodies() {
        let parsed =
            parse_message(b"Subject: \r\n\r\n", None).unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(parsed.subject, "Untitled email");
        assert_eq!(parsed.markdown, "_This message has no readable text body._");
        assert!(parse_message(b"", None).is_err());
    }
}
