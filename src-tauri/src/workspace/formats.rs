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
        ".kitable" => "data",
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
    has_extension(path, &["md", "markdown", "kitable", "kiboard", "kidesign"])
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
            "md", "markdown", "kitable", "kiboard", "kidesign", "txt", "csv", "tsv", "json",
            "html", "htm", "pdf", "docx", "xlsx", "xls", "pptx", "ppt", "png", "jpg", "jpeg",
            "gif", "webp", "svg", "mp4", "mov", "webm", "mp3", "wav", "m4a",
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_workspace_files() {
        assert_eq!(infer_format("notes/Plan.MD"), "markdown");
        assert_eq!(infer_format("data/table.kitable"), "data");
        assert_eq!(infer_format("deck.kidesign"), "design");
        assert_eq!(infer_format("photo.JPEG"), "image");
        assert_eq!(infer_format("archive.zip"), "binary");
        assert_eq!(infer_format(".md"), "binary");
        assert!(is_editable("a/b.kiboard"));
        assert!(!is_editable("a/b.txt"));
        assert!(is_text("a/b.json"));
        assert!(!is_text("a/b.kitable"));
        assert!(is_supported("song.m4a"));
        assert!(!is_supported("tool.exe"));
    }
}
