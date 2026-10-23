//! Which workspace files the desktop lists, opens as text, and saves.

fn extension(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or_default();
    match name.rfind('.') {
        Some(index) if index > 0 => name[index..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

pub fn infer_format(path: &str) -> &'static str {
    match extension(path).as_str() {
        ".kidesign" => "design",
        ".kiboard" => "board",
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
        // Layered images, edited in the Photo kit.
        ".psd" | ".psb" | ".kphoto" => "photo",
        // Video projects, edited in the Film kit.
        ".kitionfilm" => "film",
        // Vector drawings, edited in the Vector kit.
        ".kvector" => "vector",
        // Motion-graphics projects, edited in the Effect kit.
        ".keffect" => "effect",
        // Page layouts, edited in the Design kit.
        ".kdesign" => "layout",
        // CAD drawings, edited in the CAD kit.
        ".dxf" => "cad",
        // Slide files, edited in the Slide kit (PowerPoint files too, as `pptx`).
        ".kitionslide" => "slide",
        // Tables, edited in the Table kit.
        ".ktable" => "table",
        ".mp4" | ".mov" | ".webm" => "video",
        ".mp3" | ".wav" | ".m4a" => "audio",
        _ => "binary",
    }
}

fn has_extension(path: &str, allowed: &[&str]) -> bool {
    let ext = extension(path);
    !ext.is_empty() && allowed.contains(&&ext[1..])
}

pub fn is_editable(path: &str) -> bool {
    has_extension(path, &["md", "markdown", "kiboard", "kidesign"])
}

pub fn is_text(path: &str) -> bool {
    has_extension(
        path,
        &[
            "md", "markdown", "kiboard", "kidesign", "txt", "csv", "tsv", "json", "html", "htm",
        ],
    )
}

pub fn is_supported(path: &str) -> bool {
    has_extension(
        path,
        &[
            "md",
            "markdown",
            "kiboard",
            "kidesign",
            "txt",
            "csv",
            "tsv",
            "json",
            "html",
            "htm",
            "pdf",
            "docx",
            "xlsx",
            "xls",
            "pptx",
            "ppt",
            "png",
            "jpg",
            "jpeg",
            "gif",
            "webp",
            "svg",
            "psd",
            "psb",
            "kphoto",
            "kitionfilm",
            "kvector",
            "keffect",
            "kdesign",
            "dxf",
            "kitionslide",
            "ktable",
            "mp4",
            "mov",
            "webm",
            "mp3",
            "wav",
            "m4a",
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_workspace_files() {
        assert_eq!(infer_format("notes/Plan.MD"), "markdown");
        assert_eq!(infer_format("poster.kidesign"), "design");
        assert_eq!(infer_format("photo.JPEG"), "image");
        assert_eq!(infer_format("archive.zip"), "binary");
        assert_eq!(infer_format("art/Cover.PSD"), "photo");
        assert_eq!(infer_format("films/Trailer.kitionfilm"), "film");
        assert!(is_supported("films/Trailer.kitionfilm"));
        assert_eq!(infer_format("art/Logo.kvector"), "vector");
        assert!(is_supported("art/Logo.kvector"));
        assert_eq!(infer_format("motion/Intro.keffect"), "effect");
        assert!(is_supported("motion/Intro.keffect"));
        assert_eq!(infer_format("print/Flyer.kdesign"), "layout");
        assert!(is_supported("print/Flyer.kdesign"));
        assert_eq!(infer_format("plans/Floor.DXF"), "cad");
        assert!(is_supported("plans/Floor.dxf"));
        assert_eq!(infer_format("talks/Launch.kitionslide"), "slide");
        assert!(is_supported("talks/Launch.kitionslide"));
        assert_eq!(infer_format("data/Tasks.ktable"), "table");
        assert!(is_supported("data/Tasks.ktable"));
        assert!(!is_text("data/Tasks.ktable"));
        assert!(is_supported("art/poster.psb"));
        assert!(!is_text("art/poster.kphoto"));
        assert_eq!(infer_format(".md"), "binary");
        assert!(is_editable("a/b.kiboard"));
        assert!(!is_editable("a/b.txt"));
        assert!(is_text("a/b.json"));
        assert!(!is_supported("a/b.kitable"));
        assert!(is_supported("song.m4a"));
        assert!(!is_supported("tool.exe"));
    }
}
