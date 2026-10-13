//! The commands behind `window.kitionDesktop`. Each takes the renderer's
//! request object and returns what the bridge contract promises.

use std::path::{Path, PathBuf};
use std::sync::PoisonError;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::desktop::{Desktop, MAIN_WINDOW, blocking, io_error};
use crate::external::normalize_external_url;
use crate::images::{ExportImages, image_bytes, read_remote_image, unresolved_image_sources};
use crate::proxy::ProxyManager;
use crate::request::Request;
use crate::supervisor::portal_base_url;
use crate::updates::UpdateManager;
use crate::workspace::safety::write_atomically;
use crate::workspace::{docstore, files};
use crate::{feedback, pdf, window, workspace_window};

type CommandResult<T = Value> = Result<T, String>;

const MAX_CLIPBOARD_IMAGE_BYTES: usize = 50 * 1024 * 1024;

fn req(request: Option<Value>) -> Request {
    Request::new(request)
}

fn file_path(path: Option<FilePath>) -> Option<PathBuf> {
    path.and_then(|path| path.into_path().ok())
}

async fn receive<T>(receiver: oneshot::Receiver<T>) -> CommandResult<T> {
    receiver.await.map_err(|_| "dialog was closed".to_owned())
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

async fn save_dialog(
    app: &AppHandle,
    title: &str,
    default_path: &Path,
    pdf_filter: bool,
) -> CommandResult<Option<PathBuf>> {
    let (sender, receiver) = oneshot::channel();
    let mut builder = app.dialog().file().set_title(title);
    if let Some(parent) = default_path.parent() {
        builder = builder.set_directory(parent);
    }
    if let Some(name) = default_path.file_name() {
        builder = builder.set_file_name(name.to_string_lossy());
    }
    if pdf_filter {
        builder = builder.add_filter("PDF", &["pdf"]);
    }
    if let Some(window) = main_window(app) {
        builder = builder.set_parent(&window);
    }
    builder.save_file(move |path| {
        let _ = sender.send(file_path(path));
    });
    receive(receiver).await
}

async fn pick_folder(
    app: &AppHandle,
    title: &str,
    directory: Option<&Path>,
) -> CommandResult<Option<PathBuf>> {
    let (sender, receiver) = oneshot::channel();
    let mut builder = app
        .dialog()
        .file()
        .set_title(title)
        .set_can_create_directories(true);
    if let Some(directory) = directory {
        builder = builder.set_directory(directory);
    }
    if let Some(window) = main_window(app) {
        builder = builder.set_parent(&window);
    }
    builder.pick_folder(move |path| {
        let _ = sender.send(file_path(path));
    });
    receive(receiver).await
}

// --- Runtime, app, and window -------------------------------------------

#[tauri::command]
pub fn desktop_info(app: AppHandle, state: State<'_, Desktop>) -> Value {
    let env = state.env();
    json!({
        "is_desktop": true,
        "platform": env.platform,
        "backend_base_url": env.backend_base_url(),
        "data_dir": env.data_dir,
        "cache_dir": env.cache_dir,
        "logs_dir": env.logs_dir,
        "uploads_dir": env.uploads_dir,
        "exports_dir": env.exports_dir,
        "workspace_dir": env.workspace_dir,
        "app_version": app.package_info().version.to_string(),
        "supports_secure_storage": true,
    })
}

#[tauri::command]
pub fn backend_status(state: State<'_, Desktop>) -> Value {
    state.supervisor.status()
}

#[tauri::command]
pub async fn retry_backend_start(state: State<'_, Desktop>) -> CommandResult {
    state.supervisor.retry().await
}

#[tauri::command]
pub fn open_external_url(app: AppHandle, url: String) -> CommandResult<()> {
    let url = normalize_external_url(&url)?;
    app.opener().open_url(url, None::<&str>).map_err(io_error)
}

#[tauri::command]
pub fn show_notification(app: AppHandle, title: String, message: String) -> CommandResult<()> {
    app.notification()
        .builder()
        .title(title)
        .body(message)
        .show()
        .map_err(io_error)
}

#[tauri::command]
pub fn window_action(app: AppHandle, action: String) -> CommandResult<()> {
    window::window_action(&app, &action)
}

#[tauri::command]
pub fn open_runtime_path(
    app: AppHandle,
    state: State<'_, Desktop>,
    kind: String,
) -> CommandResult<()> {
    let env = state.env();
    let target = match kind.as_str() {
        "data" => env.data_dir,
        "cache" => env.cache_dir,
        "logs" => env.logs_dir,
        "exports" => env.exports_dir,
        _ => return Ok(()),
    };
    app.opener()
        .open_path(target.to_string_lossy(), None::<&str>)
        .map_err(io_error)
}

#[tauri::command]
pub async fn bootstrap_initialize(state: State<'_, Desktop>) -> CommandResult {
    state.bootstrap.initialize().map_err(io_error)
}

#[tauri::command]
pub async fn bootstrap_create_attestation(state: State<'_, Desktop>) -> CommandResult {
    state.bootstrap.create_attestation().map_err(io_error)
}

#[tauri::command]
pub async fn bootstrap_status(state: State<'_, Desktop>) -> CommandResult {
    state.bootstrap.status().map_err(io_error)
}

#[tauri::command]
pub async fn submit_feedback(state: State<'_, Desktop>, request: Option<Value>) -> CommandResult {
    feedback::submit(&state.http(), &portal_base_url(), &req(request)).await
}

// --- Files and clipboard ------------------------------------------------

#[tauri::command]
pub async fn save_text_file(
    app: AppHandle,
    state: State<'_, Desktop>,
    dialog_title: String,
    default_filename: String,
    content: String,
) -> CommandResult<String> {
    let default_path = state.env().exports_dir.join(default_filename);
    let Some(path) = save_dialog(&app, &dialog_title, &default_path, false).await? else {
        return Ok(String::new());
    };
    let target = path.clone();
    blocking(move || write_atomically(&target, content.as_bytes())).await?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn save_binary_file(
    app: AppHandle,
    state: State<'_, Desktop>,
    request: Option<Value>,
) -> CommandResult<String> {
    let request = req(request);
    let bytes = BASE64
        .decode(request.str("base64_content").trim())
        .map_err(io_error)?;
    let default_path = state
        .env()
        .exports_dir
        .join(request.str("default_filename"));
    let Some(path) = save_dialog(&app, &request.str("dialog_title"), &default_path, false).await?
    else {
        return Ok(String::new());
    };
    let target = path.clone();
    blocking(move || write_atomically(&target, &bytes)).await?;
    Ok(path.to_string_lossy().into_owned())
}

fn backend_public_base_url(state: &Desktop) -> String {
    let base = state.env().backend_base_url();
    base.strip_suffix("/api").unwrap_or(&base).to_owned()
}

async fn inline_images(state: &Desktop, html: &str, document_path: &str) -> String {
    let client = state.http();
    let root = state.workspace_root();
    let base = backend_public_base_url(state);
    ExportImages {
        backend_public_base_url: &base,
        workspace_root: &root,
        client: &client,
    }
    .inline(html, document_path)
    .await
}

#[tauri::command]
pub async fn save_pdf_file(
    app: AppHandle,
    state: State<'_, Desktop>,
    request: Option<Value>,
) -> CommandResult<String> {
    let request = req(request);
    let filename = pdf::pdf_filename(&request.str("default_filename"));
    let title = match request.str("dialog_title") {
        value if value.is_empty() => "Export PDF".to_owned(),
        value => value,
    };
    let default_path = state.env().exports_dir.join(filename);
    let Some(path) = save_dialog(&app, &title, &default_path, true).await? else {
        return Ok(String::new());
    };
    let html = inline_images(&state, &request.str("html"), &request.str("document_path")).await;
    let temporary = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        uuid::Uuid::new_v4().simple()
    ));
    let rendered = pdf::render(&app, html, pdf::options(&request), &temporary).await;
    let result = rendered.and_then(|()| std::fs::rename(&temporary, &path).map_err(io_error));
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result?;
    let _ = app.opener().open_path(path.to_string_lossy(), None::<&str>);
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn copy_document_html(
    app: AppHandle,
    state: State<'_, Desktop>,
    request: Option<Value>,
) -> CommandResult<bool> {
    let request = req(request);
    let html = inline_images(&state, &request.str("html"), &request.str("document_path")).await;
    let unresolved = unresolved_image_sources(&html);
    if !unresolved.is_empty() {
        return Err(format!(
            "failed to embed {} clipboard image(s)",
            unresolved.len()
        ));
    }
    app.clipboard()
        .write_html(html, Some(request.str("text")))
        .map_err(io_error)?;
    Ok(true)
}

#[tauri::command]
pub async fn copy_image(
    app: AppHandle,
    state: State<'_, Desktop>,
    request: Option<Value>,
) -> CommandResult<bool> {
    let bytes = image_bytes(&state.http(), &req(request).str("url")).await?;
    let decoded = image::load_from_memory(&bytes).map_err(|_| "image data is empty".to_owned())?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    if width == 0 || height == 0 {
        return Err("image data is empty".into());
    }
    let image = tauri::image::Image::new_owned(rgba.into_raw(), width, height);
    app.clipboard().write_image(&image).map_err(io_error)?;
    Ok(true)
}

#[tauri::command]
pub async fn read_clipboard_image(app: AppHandle) -> CommandResult {
    let Ok(image) = app.clipboard().read_image() else {
        return Ok(Value::Null);
    };
    let (width, height) = (image.width(), image.height());
    if width == 0 || height == 0 {
        return Ok(Value::Null);
    }
    let Some(buffer) = image::RgbaImage::from_raw(width, height, image.rgba().to_vec()) else {
        return Ok(Value::Null);
    };
    let mut png = std::io::Cursor::new(Vec::new());
    buffer
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(io_error)?;
    let png = png.into_inner();
    if png.is_empty() {
        return Ok(Value::Null);
    }
    if png.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err("clipboard image exceeds 50 MB import limit".into());
    }
    Ok(json!({ "mime_type": "image/png", "base64_content": BASE64.encode(png) }))
}

#[tauri::command]
pub async fn read_remote_image_command(state: State<'_, Desktop>, url: String) -> CommandResult {
    read_remote_image(&state.http(), &url).await
}

// --- Workspace documents ------------------------------------------------

macro_rules! workspace_command {
    ($name:ident, $op:path) => {
        #[tauri::command]
        pub async fn $name(state: State<'_, Desktop>, request: Option<Value>) -> CommandResult {
            let root = state.workspace_root();
            let request = req(request);
            blocking(move || {
                $op(&root, &request).map(|value| serde_json::to_value(value).unwrap_or_default())
            })
            .await
        }
    };
}

workspace_command!(read_workspace_document, files::read_document);
workspace_command!(stat_workspace_document, files::stat_document);
workspace_command!(create_workspace_document, files::create_document);
workspace_command!(create_workspace_folder, files::create_folder);
workspace_command!(move_workspace_document, files::move_document);
workspace_command!(move_workspace_folder, files::move_folder);
workspace_command!(delete_workspace_document, files::delete_document);
workspace_command!(delete_workspace_folder, files::delete_folder);
workspace_command!(save_workspace_asset, files::save_asset);
workspace_command!(import_workspace_file, files::import_file);

#[tauri::command]
pub async fn list_workspace_documents(state: State<'_, Desktop>) -> CommandResult {
    state.document_list().await
}

#[tauri::command]
pub async fn read_workspace_image(
    state: State<'_, Desktop>,
    request: Option<Value>,
) -> CommandResult {
    let root = state.workspace_root();
    let request = req(request);
    blocking(move || {
        files::ensure_initialized(&root)?;
        if request.exact_string("expected_root").as_deref() != Some(&*root.to_string_lossy()) {
            return Err(std::io::Error::other(files::WORKSPACE_CHANGED));
        }
        files::read_image(&root, &request.str("path"))
    })
    .await
}

#[tauri::command]
pub async fn write_workspace_document(app: AppHandle, request: Option<Value>) -> CommandResult {
    blocking(move || {
        let state = app.state::<Desktop>();
        let root = state.workspace_root();
        let request = req(request);
        let resolved = files::writable_document(&root, &request)?;
        state.mark_self_write(&resolved.absolute);
        let expected = request.exact_string("expected_content");
        let content = request.str("content");
        let response = state
            .guarded
            .write(&resolved.absolute, expected.as_deref(), || {
                files::write_document(&resolved, &content)
            })?;
        Ok(serde_json::to_value(response).unwrap_or_default())
    })
    .await
}

// --- Document replica store (`.kition/docs`) -----------------------------

macro_rules! document_store_command {
    ($name:ident, $op:path) => {
        #[tauri::command]
        pub async fn $name(app: AppHandle, request: Option<Value>) -> CommandResult {
            blocking(move || {
                let state = app.state::<Desktop>();
                $op(&state.workspace_root(), &state.guarded, &req(request))
            })
            .await
        }
    };
}

document_store_command!(read_document_store, docstore::read_entry_request);
document_store_command!(write_document_store, docstore::write_entry_request);
document_store_command!(delete_document_store, docstore::delete_entry_request);
document_store_command!(read_document_index, docstore::read_index_request);
document_store_command!(write_document_index, docstore::write_index_request);

#[tauri::command]
pub async fn open_workspace_file(
    app: AppHandle,
    state: State<'_, Desktop>,
    request: Option<Value>,
) -> CommandResult<String> {
    let root = state.workspace_root();
    let request = req(request);
    let resolved = blocking(move || {
        files::ensure_initialized(&root)?;
        files::resolve_safe(&root, &request.str("path"), false, false)
    })
    .await?;
    if !crate::workspace::formats::is_supported(&resolved.relative) {
        return Err("unsupported workspace file".into());
    }
    app.opener()
        .open_path(resolved.absolute.to_string_lossy(), None::<&str>)
        .map(|()| String::new())
        .map_err(io_error)
}

#[tauri::command]
pub async fn reveal_workspace_folder(
    app: AppHandle,
    state: State<'_, Desktop>,
    request: Option<Value>,
) -> CommandResult<String> {
    let root = state.workspace_root();
    let request = req(request);
    let target = blocking(move || {
        files::ensure_initialized(&root)?;
        let path = request.str("path");
        if path.is_empty() {
            return Ok((root, true));
        }
        let resolved = files::resolve_safe(&root, &path, true, false)?;
        let is_dir = std::fs::metadata(&resolved.absolute)?.is_dir();
        Ok((resolved.absolute, is_dir))
    })
    .await?;
    let opener = app.opener();
    match target {
        (path, true) => opener.open_path(path.to_string_lossy(), None::<&str>),
        (path, false) => opener.reveal_item_in_dir(path),
    }
    .map(|()| String::new())
    .map_err(io_error)
}

#[tauri::command]
pub async fn choose_files_to_import(app: AppHandle) -> CommandResult {
    let (sender, receiver) = oneshot::channel();
    let mut builder = app.dialog().file().set_title("Select files to import");
    if let Some(window) = main_window(&app) {
        builder = builder.set_parent(&window);
    }
    builder.pick_files(move |paths| {
        let _ = sender.send(paths);
    });
    let paths: Option<Vec<FilePath>> = receive(receiver).await?;
    Ok(match paths {
        None => json!({ "canceled": true, "paths": [] }),
        Some(paths) => json!({
            "canceled": false,
            "paths": paths
                .into_iter()
                .filter_map(|path| path.into_path().ok())
                .collect::<Vec<_>>(),
        }),
    })
}

// --- Workspaces ---------------------------------------------------------

#[tauri::command]
pub async fn choose_workspace_folder(app: AppHandle, state: State<'_, Desktop>) -> CommandResult {
    let Some(path) = pick_folder(&app, "Open documents folder", None).await? else {
        return Ok(Value::Null);
    };
    state
        .apply_active_vault(&app, &path.to_string_lossy())
        .await?;
    state.document_list().await
}

#[tauri::command]
pub async fn set_workspace_folder(
    app: AppHandle,
    state: State<'_, Desktop>,
    request: Option<Value>,
) -> CommandResult {
    let path = req(request).trimmed("path");
    if path.is_empty() || path.contains('\0') {
        return Err("workspace path is required".into());
    }
    state.apply_active_vault(&app, &path).await?;
    state.document_list().await
}

#[tauri::command]
pub async fn choose_directory(app: AppHandle, request: Option<Value>) -> CommandResult {
    let title = match req(request).str("title") {
        value if value.is_empty() => "Choose folder".to_owned(),
        value => value,
    };
    Ok(match pick_folder(&app, &title, None).await? {
        Some(path) => json!({ "canceled": false, "path": path }),
        None => json!({ "canceled": true, "path": "" }),
    })
}

#[tauri::command]
pub async fn open_workspace_window(
    state: State<'_, Desktop>,
    request: Option<Value>,
) -> CommandResult {
    let path = req(request).trimmed("path");
    if path.is_empty() || path.contains('\0') {
        return Err("workspace path is required".into());
    }
    if !std::fs::metadata(&path).map_err(io_error)?.is_dir() {
        return Err("workspace path must be a directory".into());
    }
    state
        .registry
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .add(&path, "", "")
        .map_err(io_error)?;
    workspace_window::open(&path, &state.shared_data_dir).map_err(io_error)?;
    Ok(json!({ "opened": true }))
}

#[tauri::command]
pub async fn choose_agent_analysis_directory(
    app: AppHandle,
    state: State<'_, Desktop>,
    request: Option<Value>,
) -> CommandResult {
    let suggested = req(request).trimmed("suggested_path");
    let default_path = (!suggested.is_empty() && !suggested.contains('\0'))
        .then(|| {
            let candidate = Path::new(&suggested);
            let candidate = if candidate.is_absolute() {
                candidate.to_path_buf()
            } else {
                state.workspace_root().join(candidate)
            };
            crate::workspace::safety::lexical_resolve(&candidate)
        })
        .filter(|candidate| candidate.is_dir());
    let (sender, receiver) = oneshot::channel();
    let mut builder = app
        .dialog()
        .file()
        .set_title("Choose a read-only analysis folder");
    if let Some(directory) = &default_path {
        builder = builder.set_directory(directory);
    }
    if let Some(window) = main_window(&app) {
        builder = builder.set_parent(&window);
    }
    builder.pick_folder(move |path| {
        let _ = sender.send(file_path(path));
    });
    let Some(selected) = receive(receiver).await? else {
        return Ok(Value::Null);
    };
    let root = std::fs::canonicalize(&selected).map_err(io_error)?;
    if !root.is_dir() {
        return Err("the selected analysis source must be a directory".into());
    }
    let label = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Local folder".to_owned());
    Ok(json!({
        "id": format!("source-{}", uuid::Uuid::new_v4().simple()),
        "label": label,
        "root_path": root,
        "access": "read",
    }))
}

#[tauri::command]
pub async fn list_vaults(state: State<'_, Desktop>) -> CommandResult {
    state
        .registry
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .reload();
    Ok(state.registry_snapshot())
}

#[tauri::command]
pub async fn add_vault(state: State<'_, Desktop>, request: Option<Value>) -> CommandResult {
    let request = req(request);
    let vault = state
        .registry
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .add(
            &request.str("path"),
            &request.str("parent_path"),
            &request.str("name"),
        )
        .map_err(io_error)?;
    Ok(json!({ "vault": vault, "registry": state.registry_snapshot() }))
}

#[tauri::command]
pub async fn remove_vault(state: State<'_, Desktop>, request: Option<Value>) -> CommandResult {
    state
        .registry
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&req(request).trimmed("path"))
        .map_err(io_error)?;
    Ok(state.registry_snapshot())
}

#[tauri::command]
pub async fn rename_vault(state: State<'_, Desktop>, request: Option<Value>) -> CommandResult {
    let request = req(request);
    let path = request.trimmed("path");
    if path.is_empty() {
        return Err("vault path is required".into());
    }
    let vault = state
        .registry
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .rename(&path, &request.trimmed("name"))
        .map_err(io_error)?;
    Ok(json!({ "vault": vault, "registry": state.registry_snapshot() }))
}

#[tauri::command]
pub async fn set_active_vault(
    app: AppHandle,
    state: State<'_, Desktop>,
    request: Option<Value>,
) -> CommandResult {
    let path = req(request).trimmed("path");
    if path.is_empty() {
        return Err("vault path is required".into());
    }
    state.apply_active_vault(&app, &path).await?;
    Ok(json!({ "list": state.document_list().await?, "registry": state.registry_snapshot() }))
}

// --- Secure store -------------------------------------------------------

#[tauri::command]
pub async fn store_secure_value(
    state: State<'_, Desktop>,
    key: String,
    value: String,
) -> CommandResult<()> {
    state.secure.set(&key, &value).map_err(io_error)
}

#[tauri::command]
pub async fn read_secure_value(state: State<'_, Desktop>, key: String) -> CommandResult<String> {
    state.secure.get(&key).map_err(io_error)
}

#[tauri::command]
pub async fn delete_secure_value(state: State<'_, Desktop>, key: String) -> CommandResult<()> {
    state.secure.delete(&key).map_err(io_error)
}

// --- Updates ------------------------------------------------------------

#[tauri::command]
pub fn updates_get_state(updates: State<'_, UpdateManager>) -> Value {
    updates.state()
}

#[tauri::command]
pub async fn updates_check(app: AppHandle, updates: State<'_, UpdateManager>) -> CommandResult {
    Ok(updates.check(&app).await)
}

#[tauri::command]
pub async fn updates_download(
    app: AppHandle,
    updates: State<'_, UpdateManager>,
) -> CommandResult<()> {
    updates.download(&app).await
}

#[tauri::command]
pub async fn updates_install(
    app: AppHandle,
    state: State<'_, Desktop>,
    updates: State<'_, UpdateManager>,
) -> CommandResult<()> {
    state.supervisor.stop().await;
    updates.install().await?;
    app.restart();
}

#[tauri::command]
pub async fn updates_set_beta_channel(
    app: AppHandle,
    updates: State<'_, UpdateManager>,
    enabled: bool,
) -> CommandResult<()> {
    updates.set_beta_channel(&app, enabled).await;
    Ok(())
}

#[tauri::command]
pub fn updates_set_auto_check(updates: State<'_, UpdateManager>, enabled: bool) {
    updates.set_auto_check(enabled);
}

// --- Proxy --------------------------------------------------------------

#[tauri::command]
pub async fn proxy_get(state: State<'_, Desktop>) -> CommandResult {
    let mut proxy = state.proxy.lock().unwrap_or_else(PoisonError::into_inner);
    proxy.load(&state.secure);
    Ok(proxy.state())
}

#[tauri::command]
pub async fn proxy_save(
    state: State<'_, Desktop>,
    updates: State<'_, UpdateManager>,
    payload: Option<Value>,
) -> CommandResult {
    let payload = payload.unwrap_or(Value::Null);
    let (next, requires_restart, active) = {
        let mut proxy = state.proxy.lock().unwrap_or_else(PoisonError::into_inner);
        proxy.load(&state.secure);
        let previous = proxy.state();
        let next = proxy.save(&payload, &state.secure).map_err(io_error)?;
        let password_changed = payload.get("password").is_some();
        let requires_restart = ProxyManager::requires_restart(&previous, &next, password_changed);
        (next, requires_restart, proxy.active_url())
    };
    state.supervisor.set_smtp_proxy(active.clone());
    updates.set_proxy(active);
    Ok(json!({ "state": next, "requiresRestart": requires_restart }))
}

#[tauri::command]
pub async fn proxy_test(state: State<'_, Desktop>, payload: Option<Value>) -> CommandResult {
    let config = {
        let mut proxy = state.proxy.lock().unwrap_or_else(PoisonError::into_inner);
        proxy.load(&state.secure);
        proxy.config().clone()
    };
    let target = match payload {
        Some(value) if value.is_object() => crate::proxy::sanitize(&value),
        _ => config,
    };
    Ok(crate::proxy::test_connection(&target).await)
}

#[tauri::command]
pub async fn proxy_restart_backend(app: AppHandle) -> CommandResult {
    // Proxy variables are read once at launch, so the whole app restarts.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        app.state::<Desktop>().supervisor.stop().await;
        app.restart();
    });
    Ok(json!({ "ok": true }))
}
