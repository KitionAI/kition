//! Files the user @-mentions in a message: images go to the model as image
//! parts, PDF/DOCX/PPTX as extracted text.

use std::io::Read;
use std::path::Path;

use base64::Engine as _;

use crate::workspace::{Workspace, clean_path, extension};

const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_SOURCE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_ATTACHMENTS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Image,
    Pdf,
    Pptx,
    Docx,
    Xlsx,
    Unknown,
}

impl Kind {
    pub fn of(path: &str) -> Self {
        match extension(path).as_deref() {
            Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg") => Self::Image,
            Some("pdf") => Self::Pdf,
            Some("pptx") => Self::Pptx,
            Some("docx") => Self::Docx,
            Some("xlsx") => Self::Xlsx,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Pdf => "pdf",
            Self::Pptx => "pptx",
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Attachment {
    pub path: String,
    pub kind: Kind,
    pub image_url: String,
    pub text: String,
    pub warning: String,
}

pub fn image_mime(path: &str) -> &'static str {
    match extension(path).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// A `data:` URL for image bytes, sniffing the type when the extension
/// says nothing.
pub fn image_data_url(path: &str, raw: &[u8]) -> Option<String> {
    let mut mime = image_mime(path).to_owned();
    if mime == "application/octet-stream" {
        mime = kition_ai::engine::sniff_mime(raw).to_owned();
    }
    mime.starts_with("image/").then(|| {
        format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(raw)
        )
    })
}

fn truncate_text(text: String) -> (String, String) {
    if text.len() <= MAX_TEXT_BYTES {
        return (text, String::new());
    }
    let mut end = MAX_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (
        text[..end].to_owned(),
        format!(
            "Content exceeded {} KB and was truncated",
            MAX_TEXT_BYTES / 1024
        ),
    )
}

/// Text of `<w:t>`/`<a:t>` runs with one line per paragraph.
fn ooxml_text(xml: &[u8]) -> Result<String, String> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(xml);
    let mut out = String::new();
    let mut inside_text = 0_usize;
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(start)) if start.local_name().as_ref() == b"t" => inside_text += 1,
            Ok(Event::End(end)) => match end.local_name().as_ref() {
                b"t" => inside_text = inside_text.saturating_sub(1),
                b"p" => out.push('\n'),
                _ => {}
            },
            Ok(Event::Text(text)) if inside_text > 0 => {
                out.push_str(&text.unescape().map_err(|error| error.to_string())?);
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

fn zip_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<Vec<u8>, String> {
    let entry = archive.by_name(name).map_err(|error| error.to_string())?;
    let mut raw = Vec::new();
    entry
        .take(8 * 1024 * 1024)
        .read_to_end(&mut raw)
        .map_err(|error| error.to_string())?;
    Ok(raw)
}

fn open_zip(path: &Path) -> Result<zip::ZipArchive<std::fs::File>, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    zip::ZipArchive::new(file).map_err(|error| error.to_string())
}

fn docx_text(path: &Path) -> Result<(String, String), String> {
    let mut archive = open_zip(path)?;
    let text = ooxml_text(&zip_entry(&mut archive, "word/document.xml")?)?;
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Ok((String::new(), "No text content extracted from DOCX".into()));
    }
    Ok(truncate_text(text))
}

fn pptx_text(path: &Path) -> Result<(String, String), String> {
    let mut archive = open_zip(path)?;
    let mut slides: Vec<(usize, String)> = archive
        .file_names()
        .filter_map(|name| {
            let index = name
                .strip_prefix("ppt/slides/slide")?
                .strip_suffix(".xml")?
                .parse()
                .ok()?;
            Some((index, name.to_owned()))
        })
        .collect();
    if slides.is_empty() {
        return Ok((String::new(), "No slides found in PPTX".into()));
    }
    slides.sort();
    let total = slides.len();
    let mut out = String::new();
    for (index, name) in slides {
        let Ok(text) = zip_entry(&mut archive, &name).and_then(|raw| ooxml_text(&raw)) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("[slide {index}/{total}]\n{text}"));
        if out.len() >= MAX_TEXT_BYTES {
            break;
        }
    }
    if out.trim().is_empty() {
        return Ok((
            String::new(),
            format!("PPTX has {total} slides; no text extracted"),
        ));
    }
    Ok(truncate_text(out))
}

fn pdf_text(path: &Path) -> Result<(String, String), String> {
    let raw = std::fs::read(path).map_err(|error| error.to_string())?;
    let text = pdf_extract::extract_text_from_mem(&raw).map_err(|error| error.to_string())?;
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Ok((
            String::new(),
            "PDF has no extractable text (likely a scanned document)".into(),
        ));
    }
    Ok(truncate_text(text))
}

/// Extracts document text off the async executor. Parser panics on
/// malformed files become warnings.
pub async fn extract_text(kind: Kind, path: &Path) -> (String, String) {
    let path = path.to_path_buf();
    let label = kind.as_str().to_uppercase();
    let result = tokio::task::spawn_blocking(move || match kind {
        Kind::Pdf => pdf_text(&path),
        Kind::Docx => docx_text(&path),
        Kind::Pptx => pptx_text(&path),
        _ => Ok((String::new(), String::new())),
    })
    .await;
    match result {
        Ok(Ok(extracted)) => extracted,
        Ok(Err(error)) => (String::new(), format!("failed to parse {label}: {error}")),
        Err(_) => (String::new(), format!("failed to parse {label}")),
    }
}

pub async fn resolve(workspace: &Workspace, paths: &[String]) -> Vec<Attachment> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in paths {
        if out.len() >= MAX_ATTACHMENTS {
            break;
        }
        let Ok(relative) = clean_path(raw, false) else {
            continue;
        };
        if !seen.insert(relative.clone()) {
            continue;
        }
        let Ok(absolute) = workspace.resolve(&relative) else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(&absolute) else {
            continue;
        };
        if meta.is_dir() {
            continue;
        }
        let kind = Kind::of(&relative);
        let mut attachment = Attachment {
            path: relative.clone(),
            kind,
            image_url: String::new(),
            text: String::new(),
            warning: String::new(),
        };
        if meta.len() > MAX_SOURCE_BYTES {
            attachment.warning = format!(
                "Attachment exceeds {} MB; content extraction skipped",
                MAX_SOURCE_BYTES / (1024 * 1024)
            );
            out.push(attachment);
            continue;
        }
        match kind {
            Kind::Image if meta.len() > MAX_IMAGE_BYTES => {
                attachment.warning = format!(
                    "Image exceeds {} MB; compress and retry",
                    MAX_IMAGE_BYTES / (1024 * 1024)
                );
            }
            Kind::Image => match std::fs::read(&absolute) {
                Ok(raw) => {
                    attachment.image_url = image_data_url(&relative, &raw).unwrap_or_default()
                }
                Err(_) => attachment.warning = "failed to read image".into(),
            },
            Kind::Pdf | Kind::Docx | Kind::Pptx => {
                (attachment.text, attachment.warning) = extract_text(kind, &absolute).await;
            }
            Kind::Xlsx => {
                attachment.warning =
                    "XLSX content extraction is not supported; save as CSV and retry".into();
            }
            Kind::Unknown => {
                attachment.warning =
                    "content extraction is not supported for this binary format".into();
            }
        }
        out.push(attachment);
    }
    out
}

/// The system prompt block listing attachments and their text.
pub fn prompt_block(attachments: &[Attachment]) -> String {
    if attachments.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "Attached files referenced by @mention (already embedded in this turn \u{2014} do NOT call document_read on these paths):\n",
    );
    for attachment in attachments {
        out.push_str(&format!(
            "- {} ({})",
            attachment.path,
            attachment.kind.as_str()
        ));
        if !attachment.warning.is_empty() {
            out.push_str(&format!(" \u{2014} {}", attachment.warning));
        }
        out.push('\n');
    }
    for attachment in attachments.iter().filter(|a| !a.text.is_empty()) {
        out.push_str(&format!(
            "\n<attachment path={:?} type={:?}>\n{}\n</attachment>\n",
            attachment.path,
            attachment.kind.as_str(),
            attachment.text
        ));
    }
    out.trim_end().to_owned()
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn write_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = std::fs::File::create(path).unwrap_or_else(|err| panic!("{err}"));
        let mut writer = zip::ZipWriter::new(file);
        for (name, body) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap_or_else(|err| panic!("{err}"));
            writer
                .write_all(body.as_bytes())
                .unwrap_or_else(|err| panic!("{err}"));
        }
        writer.finish().unwrap_or_else(|err| panic!("{err}"));
    }

    #[tokio::test]
    async fn resolves_images_and_office_text() {
        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let ws = Workspace::new(dir.path());
        std::fs::write(dir.path().join("a.png"), b"\x89PNG\r\n\x1a\nxxxx")
            .unwrap_or_else(|err| panic!("{err}"));
        write_zip(
            &dir.path().join("b.docx"),
            &[(
                "word/document.xml",
                "<w:document><w:body><w:p><w:r><w:t>Hello &amp; bye</w:t></w:r></w:p></w:body></w:document>",
            )],
        );
        write_zip(
            &dir.path().join("c.pptx"),
            &[
                (
                    "ppt/slides/slide2.xml",
                    "<p:sld><a:p><a:t>Second</a:t></a:p></p:sld>",
                ),
                (
                    "ppt/slides/slide1.xml",
                    "<p:sld><a:p><a:t>First</a:t></a:p></p:sld>",
                ),
            ],
        );
        std::fs::write(dir.path().join("d.pdf"), b"not a pdf")
            .unwrap_or_else(|err| panic!("{err}"));
        let paths = ["a.png", "b.docx", "c.pptx", "d.pdf", "../x"].map(String::from);
        let resolved = resolve(&ws, &paths).await;
        assert_eq!(resolved.len(), 4);
        assert!(resolved[0].image_url.starts_with("data:image/png;base64,"));
        assert_eq!(resolved[1].text, "Hello & bye");
        assert_eq!(
            resolved[2].text,
            "[slide 1/2]\nFirst\n\n[slide 2/2]\nSecond"
        );
        assert!(resolved[3].warning.starts_with("failed to parse PDF"));
        let block = prompt_block(&resolved);
        assert!(block.contains("<attachment path=\"b.docx\" type=\"docx\">"));
    }
}
