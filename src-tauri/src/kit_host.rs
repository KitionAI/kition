//! Tells the runtime where the main window is on screen, so embedded kit editors (native overlay
//! windows kept over a kit tab) follow it as it moves, resizes, and gains or loses focus.

use tauri::{Manager, Runtime, WebviewWindow, WindowEvent};

use crate::desktop::MAIN_WINDOW;

pub fn on_window_event<R: Runtime>(app: &tauri::AppHandle<R>, label: &str, event: &WindowEvent) {
    if label != MAIN_WINDOW {
        return;
    }
    let focused = match event {
        WindowEvent::Focused(focused) => Some(*focused),
        WindowEvent::Moved(_)
        | WindowEvent::Resized(_)
        | WindowEvent::ScaleFactorChanged { .. } => None,
        _ => return,
    };
    if let Some(window) = app.get_webview_window(label) {
        sync(&window, focused);
    }
}

/// Records the window's content origin in screen logical points, its scale, and its focus.
pub fn sync<R: Runtime>(window: &WebviewWindow<R>, focused: Option<bool>) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(origin) = window.inner_position() else {
        return;
    };
    let visible = window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false);
    let focused = focused.or_else(|| window.is_focused().ok());
    kition_kits::host::update(|host| {
        host.x = f64::from(origin.x) / scale;
        host.y = f64::from(origin.y) / scale;
        host.scale_factor = scale;
        host.visible = visible;
        if let Some(focused) = focused {
            host.focused = focused;
        }
    });
}
