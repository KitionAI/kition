//! PDF export with each platform's own web view: the HTML loads in a hidden
//! window through the private `kition-print` scheme, signals when fonts and
//! images are ready, and is then printed to a file natively.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tauri::http::{Request as HttpRequest, Response as HttpResponse, StatusCode};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

use crate::request::Request;

#[cfg(target_os = "linux")]
mod dialog_linux;
#[cfg(target_os = "macos")]
mod dialog_macos;
#[cfg(windows)]
mod dialog_windows;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

pub const PRINT_SCHEME: &str = "kition-print";
const CSS_PIXELS_PER_INCH: f64 = 96.0;
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const PRINT_TIMEOUT: Duration = Duration::from_secs(120);

/// Page geometry in inches.
#[derive(Clone, Debug, PartialEq)]
pub struct PdfOptions {
    pub width: f64,
    pub height: f64,
    pub margin: f64,
    pub landscape: bool,
    pub scale: f64,
}

fn named_page_size(name: &str) -> (f64, f64) {
    match name.to_ascii_lowercase().as_str() {
        "a0" => (33.11, 46.81),
        "a1" => (23.39, 33.11),
        "a2" => (16.54, 23.39),
        "a3" => (11.69, 16.54),
        "a5" => (5.83, 8.27),
        "a6" => (4.13, 5.83),
        "letter" => (8.5, 11.0),
        "legal" => (8.5, 14.0),
        "tabloid" => (11.0, 17.0),
        "ledger" => (17.0, 11.0),
        _ => (8.27, 11.69),
    }
}

/// Reads the renderer's export settings: a design artboard size in CSS
/// pixels wins over a named paper size, and the legacy margin codes are
/// 0 = default, 1 = none, 2 = minimal.
pub fn options(request: &Request) -> PdfOptions {
    let width_px = request.number("page_width_px").unwrap_or(0.0);
    let height_px = request.number("page_height_px").unwrap_or(0.0);
    let (width, height) = if width_px > 0.0 && height_px > 0.0 {
        (
            width_px / CSS_PIXELS_PER_INCH,
            height_px / CSS_PIXELS_PER_INCH,
        )
    } else {
        let format = match request.str("page_format") {
            value if value.is_empty() => "a4".to_owned(),
            value => value,
        };
        named_page_size(&format)
    };
    let margin = match request.number("margins_type").map(|value| value as i64) {
        Some(1) => 0.0,
        Some(2) => 0.25,
        _ => 0.4,
    };
    let scale = request
        .number("scale_factor")
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| (value / 100.0).clamp(0.1, 2.0))
        .unwrap_or(1.0);
    PdfOptions {
        width,
        height,
        margin,
        landscape: request.bool("landscape"),
        scale,
    }
}

pub fn pdf_filename(default_filename: &str) -> String {
    let name = if default_filename.is_empty() {
        "document.pdf"
    } else {
        default_filename
    };
    if name.to_lowercase().ends_with(".pdf") {
        name.to_owned()
    } else {
        format!("{name}.pdf")
    }
}

struct Job {
    html: String,
    ready: Option<oneshot::Sender<()>>,
}

/// HTML waiting to be printed, keyed by job id.
#[derive(Default)]
pub struct PrintJobs(Mutex<HashMap<String, Job>>);

// Hidden windows may never paint, so every wait is bounded by a timer rather
// than relying on animation frames alone.
const READY_SCRIPT: &str = r#"<script>
(async () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, delay(5000)]);
  } catch (_) {}
  const images = Array.from(document.images || []);
  await Promise.race([
    Promise.all(images.map((image) => {
      image.loading = 'eager';
      if (image.complete) return true;
      return new Promise((resolve) => {
        image.addEventListener('load', () => resolve(true), { once: true });
        image.addEventListener('error', () => resolve(false), { once: true });
      });
    })),
    delay(20000),
  ]);
  await Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), delay(200)]);
  fetch(location.pathname.replace(/\/$/, '') + '/ready').catch(() => {});
})();
</script>"#;

/// Serves job HTML and receives the ready signal.
pub fn handle_request<R: Runtime>(
    app: &AppHandle<R>,
    request: &HttpRequest<Vec<u8>>,
) -> HttpResponse<Vec<u8>> {
    let jobs = app.state::<PrintJobs>();
    let path = request.uri().path().trim_matches('/').to_owned();
    let mut jobs = jobs.0.lock().unwrap_or_else(PoisonError::into_inner);
    let response = |status: StatusCode, content_type: &str, body: Vec<u8>| {
        HttpResponse::builder()
            .status(status)
            .header("content-type", content_type)
            .header("cache-control", "no-store")
            .body(body)
            .unwrap_or_default()
    };
    if let Some(id) = path.strip_suffix("/ready") {
        if let Some(sender) = jobs.get_mut(id).and_then(|job| job.ready.take()) {
            let _ = sender.send(());
        }
        return response(StatusCode::NO_CONTENT, "text/plain", Vec::new());
    }
    match jobs.get(&path) {
        Some(job) => {
            let html = if let Some(index) = job.html.rfind("</body>") {
                format!("{}{READY_SCRIPT}{}", &job.html[..index], &job.html[index..])
            } else {
                format!("{}{READY_SCRIPT}", job.html)
            };
            response(
                StatusCode::OK,
                "text/html; charset=utf-8",
                html.into_bytes(),
            )
        }
        None => response(StatusCode::NOT_FOUND, "text/plain", b"Not found".to_vec()),
    }
}

fn job_url(id: &str) -> Result<url::Url, String> {
    let raw = if cfg!(windows) {
        format!("http://{PRINT_SCHEME}.localhost/{id}")
    } else {
        format!("{PRINT_SCHEME}://localhost/{id}")
    };
    url::Url::parse(&raw).map_err(|error| error.to_string())
}

/// Renders `html` to a PDF at `output`.
pub async fn render<R: Runtime>(
    app: &AppHandle<R>,
    html: String,
    options: PdfOptions,
    output: &Path,
) -> Result<(), String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (ready_sender, ready) = oneshot::channel();
    app.state::<PrintJobs>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(
            id.clone(),
            Job {
                html,
                ready: Some(ready_sender),
            },
        );
    let result = render_job(app, &id, ready, options, output).await;
    app.state::<PrintJobs>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&id);
    if let Some(window) = app.get_webview_window(&format!("print-{id}")) {
        let _ = window.destroy();
    }
    result
}

async fn render_job<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    ready: oneshot::Receiver<()>,
    options: PdfOptions,
    output: &Path,
) -> Result<(), String> {
    let (page_width, page_height) = if options.landscape {
        (options.height, options.width)
    } else {
        (options.width, options.height)
    };
    let window = WebviewWindowBuilder::new(
        app,
        format!("print-{id}"),
        WebviewUrl::CustomProtocol(job_url(id)?),
    )
    .title("Kition PDF export")
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .inner_size(
        (page_width * CSS_PIXELS_PER_INCH).max(320.0),
        (page_height * CSS_PIXELS_PER_INCH).max(320.0),
    )
    .build()
    .map_err(|error| error.to_string())?;

    tokio::time::timeout(READY_TIMEOUT, ready)
        .await
        .map_err(|_| "PDF export timed out while loading the document".to_owned())?
        .map_err(|_| "PDF export was cancelled".to_owned())?;

    let (done_sender, done) = oneshot::channel::<Result<(), String>>();
    let target = output.to_path_buf();
    window
        .with_webview(move |webview| print_to_file(webview, &options, &target, done_sender))
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(PRINT_TIMEOUT, done)
        .await
        .map_err(|_| "PDF export timed out".to_owned())?
        .map_err(|_| "PDF export was cancelled".to_owned())??;
    match std::fs::metadata(output) {
        Ok(metadata) if metadata.len() > 0 => Ok(()),
        _ => Err("PDF export produced no file".into()),
    }
}

type Done = oneshot::Sender<Result<(), String>>;

/// Prints the PDF `bytes` a kit hands over (KitFiles `files/print`) with the
/// system's print dialog over `window`; answers whether the person printed.
/// Each platform prints the PDF its own way: macOS with PDFKit, Linux by
/// sending the file through GTK's print dialog, Windows by rendering its pages
/// with Windows.Data.Pdf into the printer `PrintDlgEx` chose. The dialog stays
/// open as long as the person wants it: no timeout.
#[cfg(target_os = "macos")]
pub async fn print_with_dialog<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    bytes: Vec<u8>,
    title: String,
) -> Result<bool, String> {
    let (done_sender, done) = oneshot::channel();
    window
        .with_webview(move |webview| dialog_macos::print(&webview, &bytes, &title, done_sender))
        .map_err(|error| error.to_string())?;
    done.await
        .map_err(|_| "printing was cancelled".to_owned())?
}

#[cfg(target_os = "linux")]
pub async fn print_with_dialog<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    bytes: Vec<u8>,
    title: String,
) -> Result<bool, String> {
    use gtk::prelude::*;

    let (done_sender, done) = oneshot::channel();
    window
        .with_webview(move |webview| {
            let parent = webview
                .inner()
                .toplevel()
                .and_then(|widget| widget.downcast::<gtk::Window>().ok());
            dialog_linux::print(parent, &bytes, &title, done_sender);
        })
        .map_err(|error| error.to_string())?;
    done.await
        .map_err(|_| "printing was cancelled".to_owned())?
}

#[cfg(windows)]
pub async fn print_with_dialog<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    bytes: Vec<u8>,
    title: String,
) -> Result<bool, String> {
    let bytes = std::sync::Arc::new(bytes);
    let counted = bytes.clone();
    let pages = tokio::task::spawn_blocking(move || dialog_windows::page_count(&counted))
        .await
        .map_err(|error| error.to_string())??;
    let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    let (chosen_sender, chosen) = oneshot::channel();
    window
        .app_handle()
        .run_on_main_thread(move || {
            let _ = chosen_sender.send(dialog_windows::ask(owner, pages));
        })
        .map_err(|error| error.to_string())?;
    let Some(choice) = chosen
        .await
        .map_err(|_| "printing was cancelled".to_owned())??
    else {
        return Ok(false);
    };
    tokio::task::spawn_blocking(move || dialog_windows::print(choice, &bytes, &title))
        .await
        .map_err(|error| error.to_string())??;
    Ok(true)
}

#[cfg(target_os = "macos")]
fn print_to_file(
    webview: tauri::webview::PlatformWebview,
    options: &PdfOptions,
    output: &Path,
    done: Done,
) {
    macos::print(&webview, options, output, done);
}

#[cfg(windows)]
fn print_to_file(
    webview: tauri::webview::PlatformWebview,
    options: &PdfOptions,
    output: &Path,
    done: Done,
) {
    windows::print(&webview, options, output, done);
}

#[cfg(target_os = "linux")]
fn print_to_file(
    webview: tauri::webview::PlatformWebview,
    options: &PdfOptions,
    output: &Path,
    done: Done,
) {
    linux::print(&webview, options, output, done);
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn maps_export_settings() {
        let defaults = options(&Request::new(Some(json!({}))));
        assert_eq!(defaults.width, 8.27);
        assert_eq!(defaults.margin, 0.4);
        assert_eq!(defaults.scale, 1.0);
        let custom = options(&Request::new(Some(json!({
            "page_width_px": 960,
            "page_height_px": 540,
            "margins_type": 1,
            "scale_factor": 500,
            "landscape": true,
        }))));
        assert_eq!((custom.width, custom.height), (10.0, 5.625));
        assert_eq!(custom.margin, 0.0);
        assert_eq!(custom.scale, 2.0);
        assert!(custom.landscape);
        let letter = options(&Request::new(Some(
            json!({ "page_format": "Letter", "margins_type": 2 }),
        )));
        assert_eq!(
            (letter.width, letter.height, letter.margin),
            (8.5, 11.0, 0.25)
        );
        assert_eq!(pdf_filename("Report"), "Report.pdf");
        assert_eq!(pdf_filename("a.PDF"), "a.PDF");
        assert_eq!(pdf_filename(""), "document.pdf");
    }
}
