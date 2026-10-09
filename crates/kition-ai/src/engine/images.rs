//! Image generation and editing through the configured provider, Kition
//! Cloud, or a placeholder when no image model is configured.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use kition_core::coerce::{as_str, first_non_empty};
use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;

use super::error::{AiError, AiResult};
use super::transport::{
    IMAGE_REQUEST_TIMEOUT, MIB, chat_headers, compact_error, credits_exhausted, normalize_base_url,
    read_limited, sniff_mime, validate_endpoint,
};
use super::types::{GeneratedImage, RuntimeModel};

/// The hosted image model, used regardless of the conversation model.
pub const IMAGE_MODEL: &str = "gpt-image-2";
pub(crate) const MAX_CONCURRENT_IMAGE_REQUESTS: usize = 5;

pub(crate) fn normalize_count(count: i64) -> usize {
    if count <= 0 {
        1
    } else {
        (count as usize).min(MAX_CONCURRENT_IMAGE_REQUESTS)
    }
}

/// `low`, `medium`, or `high`; anything else lets the API choose.
pub fn normalize_quality(quality: &str) -> &'static str {
    match quality.trim().to_lowercase().as_str() {
        "low" => "low",
        "medium" => "medium",
        "high" => "high",
        _ => "auto",
    }
}

/// The closest of the three sizes image models accept.
pub fn normalize_size(width: i64, height: i64) -> (i64, i64, &'static str) {
    let width = if width <= 0 { 1024 } else { width };
    let height = if height <= 0 { 1024 } else { height };
    if width == height {
        return (1024, 1024, "1024x1024");
    }
    let ratio = width as f64 / height as f64;
    if ratio >= 1.15 {
        (1536, 1024, "1536x1024")
    } else if ratio <= 0.87 {
        (1024, 1536, "1024x1536")
    } else {
        (1024, 1024, "1024x1024")
    }
}

fn parse_size(value: &str) -> (i64, i64) {
    let value = value.trim();
    if value.is_empty() || value == "auto" {
        return (0, 0);
    }
    let Some((width, height)) = value.split_once('x') else {
        return (0, 0);
    };
    match (width.trim().parse::<i64>(), height.trim().parse::<i64>()) {
        (Ok(width), Ok(height)) if width > 0 && height > 0 => (width, height),
        _ => (0, 0),
    }
}

pub fn extension_for_mime(mime: &str) -> &'static str {
    match mime.trim().to_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => ".jpg",
        "image/png" => ".png",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "image/svg+xml" => ".svg",
        "image/avif" => ".avif",
        _ => "",
    }
}

fn truncate(value: &str, limit: usize) -> String {
    let chars: Vec<char> = value.trim().chars().collect();
    if chars.len() <= limit {
        chars.into_iter().collect()
    } else {
        chars[..limit].iter().collect::<String>() + "..."
    }
}

fn sanitize_filename(value: &str) -> String {
    let replaced: String = value
        .trim()
        .chars()
        .map(|ch| {
            if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                ch
            }
        })
        .collect();
    let trimmed = replaced.trim_matches(|ch| ch == '.' || ch == ' ');
    if trimmed.is_empty() {
        "img".to_owned()
    } else {
        truncate(trimmed, 40)
    }
}

fn unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn accent_color(seed: &str, index: usize) -> &'static str {
    const PALETTE: [&str; 6] = [
        "#f97316", "#0ea5e9", "#22c55e", "#ef4444", "#14b8a6", "#a855f7",
    ];
    let checksum = crc32fast::hash(seed.as_bytes()) as i32 as i64;
    PALETTE[((checksum + index as i64).rem_euclid(PALETTE.len() as i64)) as usize]
}

/// What to generate: a prompt, optional reference images to edit, and the
/// count, size, and quality wanted.
#[derive(Debug, Clone, Default)]
pub struct ImageRequest {
    pub prompt: String,
    pub references: Vec<String>,
    pub count: i64,
    pub width: i64,
    pub height: i64,
    pub quality: String,
}

/// A reference image prepared for an edit request.
pub(crate) struct Reference {
    pub filename: String,
    pub mime_type: String,
    pub data: Vec<u8>,
}

#[derive(Clone)]
pub(crate) struct Images {
    pub http: reqwest::Client,
    pub upload_dir: std::path::PathBuf,
    pub slots: Arc<Semaphore>,
}

impl Images {
    /// SVG placeholders under `uploads/generated/images`, for when no image
    /// model is configured.
    pub fn placeholders(
        &self,
        prompt: &str,
        count: i64,
        width: i64,
        height: i64,
    ) -> AiResult<Vec<String>> {
        let count = normalize_count(count);
        let dir = self.upload_dir.join("generated").join("images");
        std::fs::create_dir_all(&dir).map_err(|error| AiError::msg(error.to_string()))?;
        let mut urls = Vec::new();
        for index in 0..count {
            let filename = format!("img_{}_{index}.svg", unix_nanos());
            let body = format!(
                r##"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stop-color="{color}"/><stop offset="100%" stop-color="#111827"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="{cx}" cy="{cy}" r="{r}" fill="rgba(255,255,255,0.18)"/><rect x="44" y="{ry}" width="{rw}" height="120" rx="20" fill="rgba(255,255,255,0.14)"/><text x="56" y="{ty}" fill="#ffffff" font-size="30" font-family="Arial, sans-serif">{title}</text><text x="56" y="{sy}" fill="#d1d5db" font-size="18" font-family="Arial, sans-serif">{subtitle}</text></svg>"##,
                w = width,
                h = height,
                color = accent_color(prompt, index),
                cx = width * 3 / 4,
                cy = height / 4,
                r = width.min(height) / 6,
                ry = height / 2 - 70,
                rw = width - 88,
                ty = height / 2 - 10,
                title = xml_escape(&truncate(prompt, 22)),
                sy = height / 2 + 28,
                subtitle = xml_escape(&format!("{width} x {height}  AI image")),
            );
            std::fs::write(dir.join(&filename), body)
                .map_err(|error| AiError::msg(error.to_string()))?;
            urls.push(format!("/uploads/generated/images/{filename}"));
        }
        Ok(urls)
    }

    /// Saves generated bytes and returns their `/uploads` URL, or empty when
    /// there is no upload directory.
    fn write(&self, stem: &str, extension: &str, data: &[u8]) -> AiResult<String> {
        if self.upload_dir.as_os_str().is_empty() {
            return Ok(String::new());
        }
        let dir = self.upload_dir.join("generated").join("images");
        std::fs::create_dir_all(&dir).map_err(|error| AiError::msg(error.to_string()))?;
        let filename = format!("{}_{}{extension}", sanitize_filename(stem), unix_nanos());
        std::fs::write(dir.join(&filename), data)
            .map_err(|error| AiError::msg(error.to_string()))?;
        Ok(format!("/uploads/generated/images/{filename}"))
    }

    pub fn decode_base64(&self, stem: &str, raw: &str) -> AiResult<GeneratedImage> {
        let mut mime = "image/png".to_owned();
        let mut text = raw.trim().to_owned();
        if let Some(rest) = text.strip_prefix("data:") {
            let (header, payload) = rest
                .split_once(',')
                .ok_or_else(|| AiError::msg("invalid image data URL"))?;
            let declared = header.split(';').next().unwrap_or_default();
            if !declared.is_empty() {
                mime = declared.to_owned();
            }
            text = payload.to_owned();
        }
        let data = BASE64
            .decode(text.as_bytes())
            .map_err(|_| AiError::msg("failed to decode image base64"))?;
        if data.is_empty() {
            return Err(AiError::msg("image generation result is empty"));
        }
        if mime.is_empty() || mime == "application/octet-stream" {
            mime = sniff_mime(&data).to_owned();
        }
        let mut extension = extension_for_mime(&mime);
        if extension.is_empty() {
            extension = ".png";
            mime = "image/png".into();
        }
        let url = self.write(stem, extension, &data).unwrap_or_default();
        Ok(GeneratedImage {
            url,
            data,
            mime_type: mime,
            extension: extension.to_owned(),
            ..GeneratedImage::default()
        })
    }

    pub async fn load(&self, raw: &str) -> AiResult<GeneratedImage> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(AiError::msg("image URL is empty"));
        }
        if raw.starts_with("data:") {
            return self.decode_base64("img_data", raw);
        }
        if let Some(relative) = raw.strip_prefix("/uploads/") {
            let path = self.upload_dir.join(relative);
            let data = std::fs::read(&path).map_err(|error| AiError::msg(error.to_string()))?;
            let mut mime = sniff_mime(&data).to_owned();
            if path.to_string_lossy().to_lowercase().ends_with(".svg") {
                mime = "image/svg+xml".into();
            }
            let mut extension = extension_for_mime(&mime).to_owned();
            if extension.is_empty() {
                extension = path
                    .extension()
                    .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
                    .unwrap_or_default();
            }
            return Ok(GeneratedImage {
                url: raw.to_owned(),
                data,
                mime_type: mime,
                extension,
                ..GeneratedImage::default()
            });
        }
        let parsed = url::Url::parse(raw)
            .ok()
            .filter(|url| matches!(url.scheme(), "http" | "https"))
            .ok_or_else(|| AiError::msg(format!("unsupported image URL: {raw}")))?;
        let response = self
            .http
            .get(parsed.as_str())
            .header(
                "Accept",
                "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml;q=0.8,*/*;q=0.5",
            )
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| AiError::msg("image download failed"))?;
        let status = response.status().as_u16();
        if status >= 400 {
            return Err(AiError::msg(format!(
                "image download returned HTTP {status}"
            )));
        }
        let content_type = response
            .headers()
            .get("Content-Type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let data = read_limited(response, 12 * MIB)
            .await
            .map_err(|_| AiError::msg("failed to read image response"))?;
        let mut mime = content_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_owned();
        if mime.is_empty() || mime == "application/octet-stream" {
            mime = sniff_mime(&data).to_owned();
        }
        let extension = extension_for_mime(&mime);
        if extension.is_empty() {
            return Err(AiError::msg(format!(
                "response is not a supported image type: {mime}"
            )));
        }
        let url = match self.write("img_url", extension, &data) {
            Ok(url) if !url.trim().is_empty() => url,
            _ => raw.to_owned(),
        };
        Ok(GeneratedImage {
            url,
            data,
            mime_type: mime,
            extension: extension.to_owned(),
            ..GeneratedImage::default()
        })
    }

    /// Images from an OpenAI-style `data[]` (base64 or URL) or `images[]`.
    async fn collect(&self, response: &Map<String, Value>) -> AiResult<Vec<GeneratedImage>> {
        let mut images = Vec::new();
        if let Some(Value::Array(urls)) = response.get("images") {
            for item in urls {
                let url = as_str(item).trim();
                if !url.is_empty() {
                    images.push(self.load(url).await?);
                }
            }
        }
        if let Some(Value::Array(data)) = response.get("data") {
            for (index, item) in data.iter().enumerate() {
                let Some(entry) = item.as_object().filter(|entry| !entry.is_empty()) else {
                    continue;
                };
                let text = |key: &str| entry.get(key).map(as_str).unwrap_or_default();
                let encoded = first_non_empty(&[text("b64_json"), text("base64")]);
                if !encoded.is_empty() {
                    images.push(self.decode_base64(&format!("img_{index}"), encoded)?);
                    continue;
                }
                let url = first_non_empty(&[text("url"), text("image_url")]);
                if !url.is_empty() {
                    images.push(self.load(url).await?);
                }
            }
        }
        if images.is_empty() {
            return Err(AiError::msg(
                "image generation endpoint returned no usable image",
            ));
        }
        Ok(images)
    }

    /// Runs `count` requests in parallel, at most five at a time across the
    /// engine; the first failure cancels the rest.
    async fn concurrent<F, Fut>(&self, count: i64, request: F) -> AiResult<Vec<GeneratedImage>>
    where
        F: Fn(usize) -> Fut,
        Fut: std::future::Future<Output = AiResult<Vec<GeneratedImage>>>,
    {
        let count = normalize_count(count);
        let tasks = (0..count).map(|index| {
            let slots = self.slots.clone();
            let future = request(index);
            async move {
                let _permit = slots
                    .acquire_owned()
                    .await
                    .map_err(|_| AiError::msg("image requests are shutting down"))?;
                future.await
            }
        });
        let pages = futures::future::try_join_all(tasks).await?;
        Ok(pages.into_iter().flatten().collect())
    }

    async fn post_json(
        &self,
        endpoint: &str,
        headers: &[(String, String)],
        payload: &Value,
    ) -> AiResult<Vec<u8>> {
        let mut request = self
            .http
            .post(endpoint)
            .timeout(IMAGE_REQUEST_TIMEOUT)
            .body(payload.to_string());
        for (key, value) in headers {
            request = request.header(key, value);
        }
        let response = request.send().await.map_err(|error| {
            super::transport::network_error(
                "runtime image generation call failed",
                endpoint,
                &super::transport::SendFailure::Http(error),
            )
        })?;
        let status = response.status().as_u16();
        let body = read_limited(response, 12 * MIB)
            .await
            .map_err(|_| AiError::msg("failed to read runtime image generation response"))?;
        if status == 402 {
            return Err(credits_exhausted(&body));
        }
        if status >= 400 {
            return Err(AiError::msg(format!(
                "runtime image generation failed: {}",
                compact_error(&body)
            )));
        }
        Ok(body)
    }

    pub async fn generate(
        &self,
        request: &ImageRequest,
        model: &RuntimeModel,
    ) -> AiResult<Vec<GeneratedImage>> {
        let ImageRequest {
            prompt,
            count,
            width,
            height,
            quality,
            ..
        } = request;
        let (count, width, height) = (*count, *width, *height);
        let headers = chat_headers(model)?;
        let base_url = normalize_base_url(&model.provider_type, &model.base_url);
        if base_url.is_empty() {
            return Err(AiError::msg("runtime provider is missing base_url"));
        }
        let endpoint = validate_endpoint(&format!("{base_url}/images/generations"))?;
        let size = if width > 0 && height > 0 {
            normalize_size(width, height).2
        } else {
            "auto"
        };
        let payload = json!({
            "prompt": prompt,
            "background": "auto",
            "model": IMAGE_MODEL,
            "quality": normalize_quality(quality),
            "size": size,
        });
        self.concurrent(count, |_| {
            let (endpoint, headers, payload) = (endpoint.clone(), headers.clone(), payload.clone());
            async move {
                let body = self.post_json(&endpoint, &headers, &payload).await?;
                let response: Map<String, Value> = serde_json::from_slice(&body).map_err(|_| {
                    AiError::msg("image generation endpoint returned a non-JSON response")
                })?;
                let mut page = self.collect(&response).await?;
                let (mut out_width, mut out_height) =
                    parse_size(response.get("size").map(as_str).unwrap_or_default());
                if out_width <= 0 || out_height <= 0 {
                    let (w, h, _) = normalize_size(width, height);
                    (out_width, out_height) = (w, h);
                }
                for image in &mut page {
                    image.width = out_width;
                    image.height = out_height;
                }
                Ok(page)
            }
        })
        .await
    }

    pub async fn load_references(&self, values: &[String]) -> AiResult<Vec<Reference>> {
        let mut references = Vec::new();
        for (index, value) in values.iter().enumerate() {
            references.push(self.load_reference(value, index).await?);
        }
        Ok(references)
    }

    async fn load_reference(&self, value: &str, index: usize) -> AiResult<Reference> {
        let number = index + 1;
        let raw = value.trim();
        if raw.is_empty() {
            return Err(AiError::msg(format!("reference image {number} is empty")));
        }
        let (data, mut mime) = if let Some(rest) = raw.strip_prefix("data:") {
            let Some((header, payload)) = rest.split_once(',') else {
                return Err(AiError::msg(format!(
                    "reference image {number} has an invalid data URL"
                )));
            };
            if !header.to_lowercase().contains(";base64") {
                return Err(AiError::msg(format!(
                    "reference image {number} has an invalid data URL"
                )));
            }
            let mime = header
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_owned();
            let data = BASE64.decode(payload.as_bytes()).map_err(|_| {
                AiError::msg(format!("reference image {number} has invalid base64 data"))
            })?;
            (data, mime)
        } else if raw.starts_with("/uploads/") {
            let image = self.load(raw).await.map_err(|error| {
                AiError::msg(format!("failed to read reference image {number}: {error}"))
            })?;
            (image.data, image.mime_type)
        } else {
            let parsed = url::Url::parse(raw)
                .ok()
                .filter(|url| matches!(url.scheme(), "http" | "https"))
                .ok_or_else(|| {
                    AiError::msg(format!("reference image {number} has an unsupported URL"))
                })?;
            let response = self
                .http
                .get(parsed.as_str())
                .header(
                    "Accept",
                    "image/png,image/jpeg,image/webp,image/gif,image/avif,*/*;q=0.5",
                )
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|_| {
                    AiError::msg(format!("failed to download reference image {number}"))
                })?;
            let status = response.status().as_u16();
            if status >= 400 {
                return Err(AiError::msg(format!(
                    "reference image {number} returned HTTP {status}"
                )));
            }
            let content_type = response
                .headers()
                .get("Content-Type")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            let data = read_limited(response, 20 * MIB)
                .await
                .map_err(|_| AiError::msg(format!("failed to read reference image {number}")))?;
            (
                data,
                content_type
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_owned(),
            )
        };
        if data.is_empty() {
            return Err(AiError::msg(format!("reference image {number} is empty")));
        }
        if mime.is_empty() || mime == "application/octet-stream" {
            mime = sniff_mime(&data).to_owned();
        }
        let extension = extension_for_mime(&mime);
        if extension.is_empty() || mime == "image/svg+xml" {
            return Err(AiError::msg(format!(
                "reference image {number} has an unsupported image type"
            )));
        }
        Ok(Reference {
            filename: format!("reference-{number}{extension}"),
            mime_type: mime,
            data,
        })
    }

    pub async fn edit(
        &self,
        request: &ImageRequest,
        model: &RuntimeModel,
    ) -> AiResult<Vec<GeneratedImage>> {
        let ImageRequest {
            prompt,
            references,
            count,
            width,
            height,
            quality,
        } = request;
        let (count, width, height) = (*count, *width, *height);
        let headers = chat_headers(model)?;
        let base_url = normalize_base_url(&model.provider_type, &model.base_url);
        if base_url.is_empty() {
            return Err(AiError::msg("runtime provider is missing base_url"));
        }
        let references = self.load_references(references).await?;
        if references.is_empty() {
            return Err(AiError::msg(
                "image editing requires at least one usable reference image",
            ));
        }
        let endpoint = validate_endpoint(&format!("{base_url}/images/edits"))?;
        let (out_width, out_height, size) = normalize_size(width, height);
        let quality = normalize_quality(quality);
        let references = Arc::new(references);
        self.concurrent(count, |_| {
            let (endpoint, headers, references) =
                (endpoint.clone(), headers.clone(), references.clone());
            async move {
                let mut form = reqwest::multipart::Form::new()
                    .text("model", IMAGE_MODEL)
                    .text("prompt", prompt.to_owned())
                    .text("size", size)
                    .text("quality", quality);
                for reference in references.iter() {
                    let part = reqwest::multipart::Part::bytes(reference.data.clone())
                        .file_name(reference.filename.replace('"', ""))
                        .mime_str(&reference.mime_type)
                        .map_err(|_| AiError::msg("failed to build image editing request"))?;
                    form = form.part("image[]", part);
                }
                let mut request = self
                    .http
                    .post(&endpoint)
                    .timeout(IMAGE_REQUEST_TIMEOUT)
                    .multipart(form);
                for (key, value) in headers
                    .iter()
                    .filter(|(key, _)| !key.eq_ignore_ascii_case("Content-Type"))
                {
                    request = request.header(key, value);
                }
                let response = request.send().await.map_err(|error| {
                    super::transport::network_error(
                        "runtime image editing call failed",
                        &endpoint,
                        &super::transport::SendFailure::Http(error),
                    )
                })?;
                let status = response.status().as_u16();
                let body = read_limited(response, 12 * MIB)
                    .await
                    .map_err(|_| AiError::msg("failed to read runtime image editing response"))?;
                if status == 402 {
                    return Err(credits_exhausted(&body));
                }
                if status >= 400 {
                    return Err(AiError::msg(format!(
                        "runtime image editing failed: {}",
                        compact_error(&body)
                    )));
                }
                let response: Map<String, Value> = serde_json::from_slice(&body).map_err(|_| {
                    AiError::msg("image editing endpoint returned a non-JSON response")
                })?;
                let mut page = self.collect(&response).await?;
                for image in &mut page {
                    image.width = out_width;
                    image.height = out_height;
                }
                Ok(page)
            }
        })
        .await
    }

    /// Kition Cloud's image proxy returns one `{data, mime}` per call.
    pub async fn console(
        &self,
        request: &ImageRequest,
        model: &RuntimeModel,
    ) -> AiResult<Vec<GeneratedImage>> {
        let ImageRequest {
            prompt,
            references,
            count,
            width,
            height,
            quality,
        } = request;
        let (count, width, height) = (*count, *width, *height);
        let headers = chat_headers(model)?;
        let base_url = model.base_url.trim().trim_end_matches('/').to_owned();
        if base_url.is_empty() {
            return Err(AiError::msg("runtime provider is missing base_url"));
        }
        let model_name = first_non_empty(&[model.model_name.trim(), IMAGE_MODEL]).to_owned();
        let (out_width, out_height, size) = normalize_size(width, height);
        let endpoint = validate_endpoint(&format!("{base_url}/image"))?;
        let aspect = if out_height > 0 {
            out_width as f64 / out_height as f64
        } else {
            1.0
        };
        let mut payload = json!({
            "prompt": prompt,
            "model": model_name,
            "size": size,
            "aspect_ratio": aspect,
            "quality": normalize_quality(quality),
        });
        if !references.is_empty() {
            let loaded = self.load_references(references).await?;
            payload["reference_images"] = Value::Array(
                loaded
                    .iter()
                    .map(|reference| {
                        json!({
                            "filename": reference.filename,
                            "mime": reference.mime_type,
                            "data": BASE64.encode(&reference.data),
                        })
                    })
                    .collect(),
            );
            if supports_input_fidelity(&model_name) {
                payload["input_fidelity"] = "high".into();
            }
        }
        self.concurrent(count, |_| {
            let (endpoint, headers, payload) = (endpoint.clone(), headers.clone(), payload.clone());
            async move {
                let body = self.post_json(&endpoint, &headers, &payload).await?;
                let raw: Map<String, Value> = serde_json::from_slice(&body).map_err(|_| {
                    AiError::msg("image generation endpoint returned a non-JSON response")
                })?;
                let encoded = raw.get("data").map(as_str).unwrap_or_default().trim();
                if encoded.is_empty() {
                    return Err(AiError::msg(
                        "image generation endpoint returned no usable image",
                    ));
                }
                let envelope = json!({ "data": [{ "b64_json": encoded }] });
                let envelope = envelope.as_object().cloned().unwrap_or_default();
                let mut page = self.collect(&envelope).await?;
                for image in &mut page {
                    image.width = out_width;
                    image.height = out_height;
                }
                Ok(page)
            }
        })
        .await
    }
}

fn supports_input_fidelity(model: &str) -> bool {
    !model.trim().to_lowercase().starts_with("gpt-image-2")
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn images(dir: &Path) -> Images {
        Images {
            http: reqwest::Client::new(),
            upload_dir: dir.to_path_buf(),
            slots: Arc::new(Semaphore::new(MAX_CONCURRENT_IMAGE_REQUESTS)),
        }
    }

    #[test]
    fn normalizes_sizes_and_quality() {
        assert_eq!(normalize_size(0, 0), (1024, 1024, "1024x1024"));
        assert_eq!(normalize_size(1920, 1080), (1536, 1024, "1536x1024"));
        assert_eq!(normalize_size(1080, 1920), (1024, 1536, "1024x1536"));
        assert_eq!(normalize_size(1000, 1050), (1024, 1024, "1024x1024"));
        assert_eq!(normalize_quality(" High "), "high");
        assert_eq!(normalize_quality("ultra"), "auto");
        assert_eq!(parse_size("1536x1024"), (1536, 1024));
        assert_eq!(parse_size("auto"), (0, 0));
        assert_eq!(normalize_count(0), 1);
        assert_eq!(normalize_count(9), 5);
        assert_eq!(sanitize_filename(" a/b:c. "), "a-b-c");
        assert!(!supports_input_fidelity("gpt-image-2-mini"));
    }

    #[test]
    fn decodes_and_saves_base64_images() {
        let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let png = BASE64.encode(b"\x89PNG\r\n\x1a\nrest");
        let image = images(dir.path())
            .decode_base64(
                "img_0",
                &format!("data:application/octet-stream;base64,{png}"),
            )
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(image.mime_type, "image/png");
        assert!(image.url.starts_with("/uploads/generated/images/img_0_"));
        assert!(images(dir.path()).decode_base64("x", "%%%").is_err());
    }

    #[test]
    fn writes_placeholders() {
        let dir = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let urls = images(dir.path())
            .placeholders("A <cat>", 2, 800, 600)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(urls.len(), 2);
        let svg = std::fs::read_to_string(dir.path().join(urls[0].trim_start_matches("/uploads/")))
            .unwrap_or_default();
        assert!(svg.contains("A &lt;cat&gt;"));
        assert!(svg.contains("800 x 600  AI image"));
    }
}
