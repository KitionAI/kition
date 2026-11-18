//! `save_image_asset`: saving an image from the web into the workspace.

use serde_json::{Value, json};

use crate::run::{Run, ToolOutput, ToolResult, delivered, text_field};
use crate::tools::documents::default_folder;
use crate::tools::web;
use crate::workspace::sanitize_filename;

fn artifact_folder(run: &Run, title: &str, requested: &str) -> String {
    if requested.is_empty() {
        default_folder(&run.active_document_path, title)
    } else {
        requested.to_owned()
    }
}

pub async fn save_image_asset(run: &Run, input: &Value) -> ToolResult {
    let url = text_field(input, "url");
    if url.is_empty() {
        return Err("missing image URL".into());
    }
    if let Some(waiting) =
        web::needs_approval(run, "save_image_asset", std::slice::from_ref(&url)).await
    {
        return Ok(waiting);
    }
    let mut title = text_field(input, "title");
    if title.is_empty() {
        title = text_field(input, "filename");
    }
    let mut title = sanitize_filename(&title, "Image Asset");
    if let Some((stem, ext)) = title.rsplit_once('.')
        && web::extension_for_image_mime(crate::attachments::image_mime(&format!("x.{ext}")))
            .is_some()
    {
        title = stem.to_owned();
    }
    let asset = web::fetch_image(run.agent.web(), &url).await?;
    let folder = artifact_folder(run, &title, &text_field(input, "folder"));
    let mut filename = text_field(input, "filename");
    if filename.is_empty() {
        filename = format!("{title}{}", asset.extension);
    } else if !filename.contains('.') {
        filename.push_str(asset.extension);
    }
    let path = run.workspace().write_new(&folder, &filename, &asset.data)?;
    Ok(ToolOutput {
        deliverables: vec![delivered(&path, &title)],
        ..ToolOutput::new(
            format!("Saved image asset: `{path}`"),
            json!({ "path": path, "source_url": url, "mime_type": asset.mime, "bytes": asset.data.len() }),
        )
    })
}
