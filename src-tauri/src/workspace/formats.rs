//! Which workspace files the desktop lists, opens as text, and saves.
//!
//! Kition knows a few kinds of file itself (Markdown, the office and portable formats, images,
//! media, plain text). Every other kind is a kit's, named by the kit's name (its id without
//! `kit.`), and is read from the kits' manifests (`install_kits`): no kit's extension is written
//! here. The renderer infers the same way (`src/services/workspaceFormats.ts`).

use std::collections::HashMap;
use std::sync::{PoisonError, RwLock};

/// The extensions the kits of this build open, lowercase with the dot, each with its kit's name.
static KIT_FORMATS: RwLock<Option<HashMap<String, String>>> = RwLock::new(None);

/// The extensions a kit manifest (`kit.json`) opens, with the kit's name: those it edits, and
/// those it only views.
fn manifest_formats(manifest: &str) -> Option<(String, Vec<String>, Vec<String>)> {
    let manifest: serde_json::Value = serde_json::from_str(manifest).ok()?;
    let name = manifest
        .get("id")?
        .as_str()?
        .strip_prefix("kit.")?
        .to_owned();
    let (mut edits, mut views) = (Vec::new(), Vec::new());
    for format in manifest.get("formats")?.as_array()? {
        let viewed = format.get("role").and_then(serde_json::Value::as_str) == Some("view");
        let extensions = format
            .get("extensions")
            .and_then(serde_json::Value::as_array);
        for extension in extensions.into_iter().flatten() {
            if let Some(extension) = extension.as_str() {
                let extension = format!(
                    ".{}",
                    extension.trim_start_matches('.').to_ascii_lowercase()
                );
                if viewed {
                    views.push(extension);
                } else {
                    edits.push(extension);
                }
            }
        }
    }
    Some((name, edits, views))
}

/// Makes the kits of `manifests` (each a `kit.json`) the kits whose files the desktop knows. The
/// first kit that edits an extension gets it; a kit that only views one gets it when none edits it.
pub fn install_kits<S: AsRef<str>>(manifests: &[S]) {
    let kits: Vec<_> = manifests
        .iter()
        .filter_map(|manifest| manifest_formats(manifest.as_ref()))
        .collect();
    let mut formats = HashMap::new();
    for (name, edits, _) in &kits {
        for extension in edits {
            formats
                .entry(extension.clone())
                .or_insert_with(|| name.clone());
        }
    }
    for (name, _, views) in &kits {
        for extension in views {
            formats
                .entry(extension.clone())
                .or_insert_with(|| name.clone());
        }
    }
    *KIT_FORMATS.write().unwrap_or_else(PoisonError::into_inner) = Some(formats);
}

/// The manifests in a kits folder (`<dir>/<kit>-ui/kit.json`), in folder order.
pub fn manifests_in(dir: &std::path::Path) -> Vec<String> {
    let mut folders: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .collect();
    folders.sort();
    folders
        .iter()
        .filter_map(|folder| std::fs::read_to_string(folder.join("kit.json")).ok())
        .collect()
}

/// The name of the kit that opens files of `extension` (lowercase, with the dot).
fn kit_format(extension: &str) -> Option<String> {
    #[cfg(test)]
    tests::install_test_kits();
    KIT_FORMATS
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .and_then(|formats| formats.get(extension).cloned())
}

fn extension(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or_default();
    match name.rfind('.') {
        Some(index) if index > 0 => name[index..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// Kition's own format for an extension.
fn host_format(extension: &str) -> Option<&'static str> {
    Some(match extension {
        ".md" | ".markdown" => "markdown",
        ".docx" => "docx",
        ".xlsx" | ".xls" => "xlsx",
        ".pptx" | ".ppt" => "pptx",
        ".pdf" => "pdf",
        ".csv" | ".tsv" => "csv",
        ".json" => "json",
        ".txt" => "text",
        ".html" | ".htm" => "html",
        ".png" | ".jpg" | ".jpeg" | ".gif" | ".webp" | ".svg" => "image",
        ".mp4" | ".mov" | ".webm" => "video",
        ".mp3" | ".wav" | ".m4a" => "audio",
        _ => return None,
    })
}

/// Kition's own format for the path, or the name of the kit that opens it, or `binary`.
pub fn infer_format(path: &str) -> String {
    let extension = extension(path);
    match host_format(&extension) {
        Some(format) => format.to_owned(),
        None => kit_format(&extension).unwrap_or_else(|| "binary".to_owned()),
    }
}

fn has_extension(path: &str, allowed: &[&str]) -> bool {
    let ext = extension(path);
    !ext.is_empty() && allowed.contains(&&ext[1..])
}

pub fn is_editable(path: &str) -> bool {
    has_extension(path, &["md", "markdown"])
}

pub fn is_text(path: &str) -> bool {
    has_extension(
        path,
        &["md", "markdown", "txt", "csv", "tsv", "json", "html", "htm"],
    )
}

pub fn is_supported(path: &str) -> bool {
    infer_format(path) != "binary"
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests know every kit: the manifests kept for the kit host's tests.
    pub(super) fn install_test_kits() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let dir = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../crates/kition-kits/tests/fixtures/kits"
            );
            let mut files: Vec<_> = std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| entry.path())
                .collect();
            files.sort();
            let manifests: Vec<String> = files
                .iter()
                .filter_map(|file| std::fs::read_to_string(file).ok())
                .collect();
            install_kits(&manifests);
        });
    }

    #[test]
    fn reads_a_kit_s_files_from_its_manifest() {
        let ink = r#"{"id":"kit.ink","formats":[{"extensions":["kink",".INKX"]},{"extensions":["oink","memo"],"role":"view"}]}"#;
        assert_eq!(
            manifest_formats(ink),
            Some((
                "ink".to_owned(),
                vec![".kink".to_owned(), ".inkx".to_owned()],
                vec![".oink".to_owned(), ".memo".to_owned()]
            ))
        );
        assert_eq!(manifest_formats(r#"{"id":"ink","formats":[]}"#), None);
        assert_eq!(manifest_formats("not json"), None);
    }

    #[test]
    fn classifies_workspace_files() {
        assert_eq!(infer_format("notes/Plan.MD"), "markdown");
        assert_eq!(infer_format("photo.JPEG"), "image");
        assert_eq!(infer_format("archive.zip"), "binary");
        assert_eq!(infer_format("art/Cover.PSD"), "photo");
        assert_eq!(infer_format("films/Trailer.kfilm"), "film");
        assert!(is_supported("films/Trailer.kfilm"));
        assert_eq!(infer_format("art/Logo.kvector"), "vector");
        assert!(is_supported("art/Logo.kvector"));
        assert_eq!(infer_format("motion/Intro.kmotion"), "motion");
        assert!(is_supported("motion/Intro.kmotion"));
        assert_eq!(infer_format("print/Flyer.klayout"), "layout");
        assert!(is_supported("print/Flyer.klayout"));
        assert_eq!(infer_format("plans/Floor.DXF"), "cad");
        assert!(is_supported("plans/Floor.dxf"));
        assert_eq!(infer_format("talks/Launch.kslide"), "slide");
        assert!(is_supported("talks/Launch.kslide"));
        assert_eq!(infer_format("data/Tasks.ktable"), "table");
        assert!(is_supported("data/Tasks.ktable"));
        assert!(!is_text("data/Tasks.ktable"));
        assert_eq!(infer_format("plans/Roadmap.kboard"), "board");
        assert!(is_supported("plans/Roadmap.kboard"));
        assert!(!is_text("plans/Roadmap.kboard"));
        assert!(!is_editable("plans/Roadmap.kboard"));
        assert_eq!(infer_format("models/Room.kscene"), "scene");
        assert!(is_supported("models/Room.KSCENE"));
        assert!(!is_text("models/Room.kscene"));
        assert_eq!(infer_format("ui/Screen.kdesign"), "design");
        assert!(is_supported("ui/Screen.KDESIGN"));
        assert!(!is_text("ui/Screen.kdesign"));
        assert!(is_supported("art/poster.psb"));
        assert!(!is_text("art/poster.kphoto"));
        assert_eq!(infer_format(".md"), "binary");
        assert!(is_editable("a/b.md"));
        assert!(!is_editable("a/b.txt"));
        assert!(is_text("a/b.json"));
        assert!(!is_supported("a/b.kitable"));
        assert!(is_supported("song.m4a"));
        assert!(!is_supported("tool.exe"));
    }
}
