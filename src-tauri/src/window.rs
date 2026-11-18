//! The main window: creation, navigation rules, and window actions.

use serde_json::{Value, json};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{AppHandle, Manager, Runtime, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::desktop::{Desktop, MAIN_WINDOW};
use crate::external::{is_trusted_navigation, normalize_external_url};

const SETTINGS_STORAGE_KEY: &str = "kition.desktop.settings.v1";
const LIGHT_BACKGROUND: Color = Color(0xff, 0xff, 0xff, 0xff);
const DARK_BACKGROUND: Color = Color(0x1b, 0x1e, 0x22, 0xff);

/// The saved theme: `light`, `dark`, or `auto`.
fn saved_theme(desktop: &Desktop) -> String {
    desktop
        .secure
        .get(SETTINGS_STORAGE_KEY)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|settings| {
            settings
                .pointer("/general/theme")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|theme| matches!(theme.as_str(), "light" | "dark" | "auto"))
        .unwrap_or_else(|| "light".to_owned())
}

/// What the renderer reads before any module runs. The main frame only (Tauri's
/// `initialization_script`), never a kit's frame. The API token is a separate, hidden property
/// the renderer's `runtimeAuth.ts` takes and deletes as it loads, so it is not left on `window`.
fn bootstrap_script(desktop: &Desktop) -> String {
    let env = desktop.env();
    let globals = json!({
        "shell": "tauri",
        "backendOrigin": env.backend_url,
        "platform": env.platform,
    });
    let token = json!(desktop.supervisor.api_token());
    format!(
        "window.__KITION_DESKTOP__ = Object.freeze({globals});\n\
         Object.defineProperty(window, '__KITION_API_TOKEN__', {{ value: {token}, configurable: true, enumerable: false, writable: false }});"
    )
}

fn open_externally<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    match normalize_external_url(url.as_str()) {
        Ok(url) => {
            let _ = app.opener().open_url(url, None::<&str>);
        }
        Err(error) => eprintln!("blocked navigation to {url}: {error}"),
    }
}

pub fn create_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        return Ok(window);
    }
    let desktop = app.state::<Desktop>();
    let theme = saved_theme(&desktop);
    let navigation_app = app.clone();
    let new_window_app = app.clone();
    let mut builder =
        WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
            .title(desktop.window_title())
            .inner_size(1440.0, 900.0)
            .min_inner_size(1200.0, 760.0)
            .visible(false)
            .background_color(if theme == "dark" {
                DARK_BACKGROUND
            } else {
                LIGHT_BACKGROUND
            })
            .initialization_script(bootstrap_script(&desktop))
            // Files dropped from the OS reach the page as HTML5 drops, so the
            // workspace tree and the agent composer can import them.
            .disable_drag_drop_handler()
            .on_new_window(move |url, _features| {
                open_externally(&new_window_app, &url);
                NewWindowResponse::Deny
            })
            .on_page_load(|window, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = window.show();
                }
            });
    // `tauri dev` serves the renderer from the dev server; packaged builds
    // serve it from the app's own scheme.
    let dev_url = app
        .config()
        .build
        .dev_url
        .clone()
        .filter(|_| tauri::is_dev());
    builder = builder.on_navigation(move |url| {
        let trusted = match &dev_url {
            Some(dev_url) => is_trusted_navigation(url, dev_url),
            None => {
                url.scheme() == "tauri"
                    || url.host_str() == Some("tauri.localhost")
                    || url.as_str() == "about:blank"
            }
        };
        if !trusted {
            open_externally(&navigation_app, url);
        }
        trusted
    });
    if let Some(proxy) = desktop
        .proxy
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .active_url()
        .and_then(|url| Url::parse(&url).ok())
        .filter(|url| matches!(url.scheme(), "http" | "socks5"))
    {
        builder = builder.proxy_url(proxy);
    }
    #[cfg(target_os = "macos")]
    {
        // Inset the traffic lights to line up with the sidebar header controls.
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(14.0, 20.0));
    }
    if desktop.workspace_window_request.is_some() {
        builder = workspace_window_storage(builder, &desktop);
    }
    let window = builder.build()?;
    if theme == "auto" && window.theme().is_ok_and(|current| current == Theme::Dark) {
        let _ = window.set_background_color(Some(DARK_BACKGROUND));
    }
    Ok(window)
}

/// Gives each workspace window its own browser storage, so two windows do
/// not overwrite each other's open tabs.
fn workspace_window_storage<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    desktop: &Desktop,
) -> WebviewWindowBuilder<'a, R, M> {
    let profile = desktop.env().data_dir;
    #[cfg(target_os = "macos")]
    {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(profile.to_string_lossy().as_bytes());
        let mut identifier = [0u8; 16];
        identifier.copy_from_slice(&digest[..16]);
        builder.data_store_identifier(identifier)
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder.data_directory(profile.join("webview"))
    }
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    match create_main(app) {
        Ok(window) => {
            if window.is_minimized().unwrap_or(false) {
                let _ = window.unminimize();
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => eprintln!("failed to show the main window: {error}"),
    }
}

pub fn toggle_devtools<R: Runtime>(window: &WebviewWindow<R>) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

pub fn window_action<R: Runtime>(app: &AppHandle<R>, action: &str) -> Result<(), String> {
    let window = create_main(app).map_err(|error| error.to_string())?;
    let result = match action {
        "minimise" => window.minimize(),
        "toggle-maximise" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "fullscreen" => window.set_fullscreen(!window.is_fullscreen().unwrap_or(false)),
        "reload" => window.reload(),
        "toggle-devtools" => {
            toggle_devtools(&window);
            Ok(())
        }
        "center" => window.center(),
        "quit" => {
            app.exit(0);
            Ok(())
        }
        other => return Err(format!("unsupported window action: {other}")),
    };
    result.map_err(|error| error.to_string())
}
