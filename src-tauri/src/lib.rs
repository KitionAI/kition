//! The Kition desktop shell: a Tauri app that hosts the renderer, supervises
//! the local runtime, and exposes `window.kitionDesktop` through commands.

mod bootstrap;
mod commands;
mod desktop;
mod env;
mod external;
mod feedback;
mod images;
mod kit_host;
mod menu;
mod pdf;
mod proxy;
mod request;
mod secure_store;
mod supervisor;
mod updates;
mod window;
mod workspace;
mod workspace_window;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, RunEvent};

use crate::desktop::{Desktop, MAIN_WINDOW};
use crate::env::{DesktopEnv, env_value};
use crate::updates::UpdateManager;

static CLEANED_UP: AtomicBool = AtomicBool::new(false);

fn on_second_instance(app: &AppHandle, argv: Vec<String>) {
    if let Some(path) = workspace_window::read_request(&argv) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let desktop = app.state::<Desktop>();
            if path != desktop.active_workspace() {
                if let Err(error) = desktop.apply_active_vault(&app, &path).await {
                    eprintln!("failed to focus workspace window: {error}");
                    return;
                }
                if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                    let _ = window.reload();
                }
            }
            window::show_main(&app);
        });
        return;
    }
    window::show_main(app);
}

fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match menu::action(&event) {
        Some(menu::MenuAction::Renderer(action)) => menu::emit_renderer_action(app, action),
        Some(menu::MenuAction::Window(action)) => {
            if let Err(error) = window::window_action(app, &action) {
                eprintln!("{error}");
            }
        }
        None => {}
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    if let Some(menu) = menu::build(&handle)? {
        app.set_menu(menu)?;
    }
    app.on_menu_event(on_menu_event);

    let desktop = app.state::<Desktop>();
    desktop.restore_workspace();
    let is_workspace_window = desktop.workspace_window_request.is_some();
    app.state::<UpdateManager>().set_proxy(
        desktop
            .proxy
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active_url(),
    );

    if !is_workspace_window {
        use tauri_plugin_deep_link::DeepLinkExt;
        #[cfg(any(windows, target_os = "linux"))]
        if let Err(error) = app.deep_link().register_all() {
            eprintln!("failed to register the kition:// link handler: {error}");
        }
        let links = handle.clone();
        app.deep_link()
            .on_open_url(move |_event| window::show_main(&links));
    }

    tauri::async_runtime::spawn(async move {
        let desktop = handle.state::<Desktop>();
        if let Err(error) = desktop.supervisor.start().await {
            eprintln!("failed to start the Kition runtime: {error}");
        }
        if let Err(error) = window::create_main(&handle) {
            eprintln!("failed to create the main window: {error}");
        }
        desktop.start_watcher(&handle);
        if !is_workspace_window {
            UpdateManager::start(handle.clone());
        }
    });
    Ok(())
}

fn on_exit_requested(app: &AppHandle, code: Option<i32>, api: &tauri::ExitRequestApi) {
    let is_workspace_window = app.state::<Desktop>().workspace_window_request.is_some();
    // Closing the last window keeps the app running on macOS.
    if code.is_none() && cfg!(target_os = "macos") && !is_workspace_window {
        api.prevent_exit();
        return;
    }
    if CLEANED_UP.load(Ordering::SeqCst) {
        return;
    }
    api.prevent_exit();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let desktop = app.state::<Desktop>();
        desktop.stop_watcher();
        desktop.supervisor.stop().await;
        CLEANED_UP.store(true, Ordering::SeqCst);
        app.exit(code.unwrap_or(0));
    });
}

/// Points every HTTP client in the process at the user's proxy. This runs
/// before any other thread starts, so changing the environment is safe.
fn apply_proxy_environment(desktop: &Desktop) {
    let overrides = desktop
        .proxy
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .env_overrides();
    for (key, value) in overrides {
        // SAFETY: called on the main thread before Tauri or the runtime spawn
        // any threads that could read the environment concurrently.
        unsafe {
            if value.is_empty() {
                std::env::remove_var(key);
            } else {
                std::env::set_var(key, value);
            }
        }
    }
}

/// Runtime and shell logs go to `desktop-api.log` and stderr.
fn init_logging(log_file: &std::path::Path) {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    let filter = tracing_subscriber::EnvFilter::try_from_env("KITION_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let file = log_file
        .parent()
        .map(std::fs::create_dir_all)
        .and_then(|_| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_file)
                .ok()
        });
    let registry = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr));
    let initialized = match file {
        Some(file) => registry
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(std::sync::Mutex::new(file)),
            )
            .try_init(),
        None => registry.try_init(),
    };
    if let Err(error) = initialized {
        eprintln!("logging is unavailable: {error}");
    }
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let workspace_request = workspace_window::read_request(&args);
    let env = match DesktopEnv::resolve(&args) {
        Ok(env) => env,
        Err(error) => {
            eprintln!("failed to prepare the Kition data directory: {error}");
            std::process::exit(1);
        }
    };
    let shared_data_dir = match env_value("KITION_DESKTOP_SHARED_DATA_DIR") {
        value if !value.is_empty() => PathBuf::from(value),
        _ => env.data_dir.clone(),
    };
    let is_workspace_window = workspace_request.is_some();
    let context = tauri::generate_context!();
    let app_version = context.package_info().version.to_string();
    let desktop = Desktop::new(env, shared_data_dir, workspace_request, &app_version);
    apply_proxy_environment(&desktop);
    init_logging(&desktop.env().log_file);

    let mut builder = tauri::Builder::default();
    if !is_workspace_window {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                on_second_instance(app, argv)
            }))
            .plugin(tauri_plugin_deep_link::init());
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(desktop)
        .manage(UpdateManager::default())
        .manage(pdf::PrintJobs::default())
        .register_asynchronous_uri_scheme_protocol(
            pdf::PRINT_SCHEME,
            |context, request, responder| {
                responder.respond(pdf::handle_request(context.app_handle(), &request));
            },
        )
        .invoke_handler(tauri::generate_handler![
            commands::desktop_info,
            commands::backend_status,
            commands::retry_backend_start,
            commands::open_external_url,
            commands::show_notification,
            commands::window_action,
            commands::open_runtime_path,
            commands::bootstrap_initialize,
            commands::bootstrap_create_attestation,
            commands::bootstrap_status,
            commands::submit_feedback,
            commands::save_text_file,
            commands::save_binary_file,
            commands::save_pdf_file,
            commands::copy_document_html,
            commands::copy_image,
            commands::read_clipboard_image,
            commands::read_remote_image_command,
            commands::list_workspace_documents,
            commands::read_workspace_image,
            commands::read_workspace_document,
            commands::stat_workspace_document,
            commands::write_workspace_document,
            commands::read_document_store,
            commands::write_document_store,
            commands::delete_document_store,
            commands::read_document_index,
            commands::write_document_index,
            commands::create_workspace_document,
            commands::create_workspace_folder,
            commands::move_workspace_document,
            commands::move_workspace_folder,
            commands::delete_workspace_document,
            commands::delete_workspace_folder,
            commands::open_workspace_file,
            commands::save_workspace_asset,
            commands::import_workspace_file,
            commands::choose_files_to_import,
            commands::reveal_workspace_folder,
            commands::choose_workspace_folder,
            commands::set_workspace_folder,
            commands::list_vaults,
            commands::add_vault,
            commands::remove_vault,
            commands::rename_vault,
            commands::set_active_vault,
            commands::choose_directory,
            commands::open_workspace_window,
            commands::choose_agent_analysis_directory,
            commands::store_secure_value,
            commands::read_secure_value,
            commands::delete_secure_value,
            commands::updates_get_state,
            commands::updates_check,
            commands::updates_download,
            commands::updates_install,
            commands::updates_set_beta_channel,
            commands::updates_set_auto_check,
            commands::proxy_get,
            commands::proxy_save,
            commands::proxy_test,
            commands::proxy_restart_backend,
        ])
        .setup(setup)
        .build(context);
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("failed to start Kition: {error}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| match event {
        RunEvent::ExitRequested { code, api, .. } => on_exit_requested(app, code, &api),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => window::show_main(app),
        RunEvent::WindowEvent { label, event, .. } => {
            kit_host::on_window_event(app, &label, &event)
        }
        _ => {}
    });
}
