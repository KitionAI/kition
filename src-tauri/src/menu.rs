//! The native application menu. Windows has none, matching earlier releases.

use tauri::menu::{AboutMetadataBuilder, Menu, MenuEvent, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

pub const MENU_EVENT: &str = "desktop:menu";
const NAVIGATE_SETTINGS: &str = "navigate-settings";
const WINDOW_ACTION_PREFIX: &str = "window:";
/// Quit and Reload drop the edits that live only in the page (a kit document's unsaved edits),
/// so they go to the renderer, which asks first and then quits or reloads through
/// `window_action` (`src/services/desktopLeave.ts`).
pub const QUIT: &str = "quit";
const RELOAD_WINDOW: &str = "reload-window";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Option<Menu<R>>> {
    if cfg!(windows) {
        return Ok(None);
    }
    let macos = cfg!(target_os = "macos");
    let menu = Menu::new(app)?;
    if macos {
        let about = AboutMetadataBuilder::new()
            .name(Some("Kition Desktop"))
            .version(Some(app.package_info().version.to_string()))
            .copyright(Some(
                "Copyright \u{a9} 2026 Heartie Technology Limited. All rights reserved.",
            ))
            .comments(Some(
                "Documents, data tables, AI agents, and workflows in one workspace.",
            ))
            .build();
        menu.append(
            &SubmenuBuilder::new(app, "Kition")
                .about(Some(about))
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .item(
                    &MenuItemBuilder::with_id(QUIT, "Quit Kition Desktop")
                        .accelerator("CmdOrCtrl+Q")
                        .build(app)?,
                )
                .build()?,
        )?;
    }
    menu.append(
        &SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .separator()
            .select_all()
            .build()?,
    )?;
    menu.append(
        &SubmenuBuilder::new(app, "Go")
            .item(&MenuItemBuilder::with_id(NAVIGATE_SETTINGS, "Settings").build(app)?)
            .build()?,
    )?;
    let devtools = MenuItemBuilder::with_id("window:toggle-devtools", "Toggle Developer Tools")
        .accelerator(if macos { "Alt+CmdOrCtrl+I" } else { "F12" })
        .build(app)?;
    let mut minimize = MenuItemBuilder::with_id("window:minimise", "Minimize");
    if macos {
        minimize = minimize.accelerator("CmdOrCtrl+M");
    }
    menu.append(
        &SubmenuBuilder::new(app, "Window")
            .item(&MenuItemBuilder::with_id("window:center", "Center Window").build(app)?)
            .item(&MenuItemBuilder::with_id("window:fullscreen", "Toggle Full Screen").build(app)?)
            .item(&MenuItemBuilder::with_id(RELOAD_WINDOW, "Reload Current Page").build(app)?)
            .item(&devtools)
            .item(&minimize.build(app)?)
            .build()?,
    )?;
    Ok(Some(menu))
}

/// The menu actions the app handles: a renderer navigation, or a window
/// action such as `center`.
pub enum MenuAction {
    Renderer(&'static str),
    Window(String),
}

pub fn action(event: &MenuEvent) -> Option<MenuAction> {
    let id = event.id().as_ref();
    if id == NAVIGATE_SETTINGS {
        return Some(MenuAction::Renderer(NAVIGATE_SETTINGS));
    }
    if id == QUIT {
        return Some(MenuAction::Renderer(QUIT));
    }
    if id == RELOAD_WINDOW {
        return Some(MenuAction::Renderer(RELOAD_WINDOW));
    }
    id.strip_prefix(WINDOW_ACTION_PREFIX)
        .map(|action| MenuAction::Window(action.to_owned()))
}

pub fn emit_renderer_action<R: Runtime>(app: &AppHandle<R>, action: &str) {
    let _ = app.emit(MENU_EVENT, serde_json::json!({ "action": action }));
}
