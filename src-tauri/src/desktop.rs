//! Desktop state shared by every command, and the workspace switching that
//! touches several services at once.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::bootstrap::CommunityBootstrap;
use crate::env::DesktopEnv;
use crate::proxy::ProxyManager;
use crate::secure_store::SecureStore;
use crate::supervisor::Supervisor;
use crate::workspace::docstore::StoreLocks;
use crate::workspace::files;
use crate::workspace::guarded::GuardedWrites;
use crate::workspace::registry::Registry;
use crate::workspace::watcher::WorkspaceWatcher;

pub const MAIN_WINDOW: &str = "main";
pub const DOCUMENT_EXTERNAL_CHANGE_EVENT: &str = "desktop:document:external-change";
/// Sent when this Kition's access to the workspace's document store changes.
pub const DOCUMENT_STORE_ACCESS_EVENT: &str = "desktop:document-store:access";

pub struct Desktop {
    env: RwLock<DesktopEnv>,
    pub shared_data_dir: PathBuf,
    active_workspace: RwLock<String>,
    pub secure: SecureStore,
    pub bootstrap: CommunityBootstrap,
    pub registry: Mutex<Registry>,
    pub supervisor: Arc<Supervisor>,
    pub proxy: Mutex<ProxyManager>,
    watcher: Mutex<Option<WorkspaceWatcher>>,
    pub guarded: GuardedWrites,
    /// The active workspace's document store lock (one writer per store).
    pub store_locks: Arc<StoreLocks>,
    pub workspace_window_request: Option<String>,
}

pub fn io_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Runs blocking filesystem work off the async executor.
pub async fn blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> std::io::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(io_error)?
        .map_err(io_error)
}

impl Desktop {
    pub fn new(
        env: DesktopEnv,
        shared_data_dir: PathBuf,
        workspace_window_request: Option<String>,
        app_version: &str,
    ) -> Self {
        let secure = SecureStore::new(&shared_data_dir);
        let mut proxy = ProxyManager::new(&shared_data_dir);
        proxy.load(&secure);
        let supervisor = Arc::new(Supervisor::new(env.clone(), app_version));
        supervisor.set_smtp_proxy(proxy.active_url());
        Self {
            bootstrap: CommunityBootstrap::new(&shared_data_dir),
            registry: Mutex::new(Registry::new(&shared_data_dir)),
            secure,
            proxy: Mutex::new(proxy),
            supervisor,
            env: RwLock::new(env),
            shared_data_dir,
            active_workspace: RwLock::default(),
            watcher: Mutex::default(),
            guarded: GuardedWrites::default(),
            store_locks: Arc::default(),
            workspace_window_request,
        }
    }

    pub fn env(&self) -> DesktopEnv {
        self.env
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn workspace_root(&self) -> PathBuf {
        let env = self.env();
        if env.workspace_dir.as_os_str().is_empty() {
            env.data_dir.join("workspace")
        } else {
            env.workspace_dir
        }
    }

    pub fn active_workspace(&self) -> String {
        self.active_workspace
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn set_workspace(&self, path: &str) {
        *self
            .active_workspace
            .write()
            .unwrap_or_else(PoisonError::into_inner) = path.to_owned();
        if !path.is_empty() {
            self.env
                .write()
                .unwrap_or_else(PoisonError::into_inner)
                .workspace_dir = PathBuf::from(path);
        }
    }

    pub fn window_title(&self) -> String {
        let active = self.active_workspace();
        let name = active
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or_default();
        if name.is_empty() {
            "Kition Desktop".to_owned()
        } else {
            format!("Kition \u{2014} {name}")
        }
    }

    pub fn mark_self_write(&self, path: &Path) {
        if let Some(watcher) = self
            .watcher
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            watcher.mark_self_write(path);
        }
    }

    pub fn registry_snapshot(&self) -> Value {
        let registry = self.registry.lock().unwrap_or_else(PoisonError::into_inner);
        let mut listing = serde_json::to_value(registry.list()).unwrap_or_default();
        if let Some(object) = listing.as_object_mut() {
            object.insert(
                "active_vault_path".into(),
                Value::String(self.active_workspace()),
            );
        }
        listing
    }

    /// The proxy-aware client for requests the desktop makes for the user.
    pub fn http(&self) -> reqwest::Client {
        let proxy = self
            .proxy
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .active_url();
        let mut builder = reqwest::Client::builder();
        if let Some(proxy) = proxy.and_then(|url| reqwest::Proxy::all(url).ok()) {
            builder = builder.proxy(proxy);
        }
        builder.build().unwrap_or_default()
    }

    /// Picks the workspace on startup: the requested window workspace, the
    /// last active one, or the default workspace on a fresh install.
    pub fn restore_workspace(&self) {
        let mut registry = self.registry.lock().unwrap_or_else(PoisonError::into_inner);
        registry.load();
        let default_vault = self.shared_data_dir.join("workspace");
        if let Err(error) = registry.seed_default(&default_vault) {
            eprintln!("failed to seed default workspace: {error}");
        }
        let mut active = self
            .workspace_window_request
            .clone()
            .unwrap_or_else(|| registry.active_vault_path().to_owned());
        if !active.is_empty() {
            if std::fs::metadata(&active).is_ok_and(|metadata| metadata.is_dir()) {
                if self.workspace_window_request.is_some() {
                    let _ = registry.add(&active, "", "");
                    let _ = registry.set_active(&active);
                }
                self.set_workspace(&active);
            } else {
                let _ = registry.clear_active();
                active.clear();
            }
        }
        if active.is_empty() && registry.was_missing {
            let default_path = default_vault.to_string_lossy().into_owned();
            let seeded = std::fs::create_dir_all(&default_vault)
                .and_then(|()| registry.set_active(&default_path).map(|_| ()));
            match seeded {
                Ok(()) => self.set_workspace(&default_path),
                Err(error) => eprintln!("failed to seed default workspace: {error}"),
            }
        }
        self.supervisor.set_workspace_dir(&self.workspace_root());
    }

    fn restart_watcher<R: Runtime>(&self, app: &AppHandle<R>, root: &str) {
        let mut watcher = self.watcher.lock().unwrap_or_else(PoisonError::into_inner);
        *watcher = None;
        if root.is_empty() {
            return;
        }
        let handle = app.clone();
        match WorkspaceWatcher::start(Path::new(root), move |payload| {
            let _ = handle.emit_to(MAIN_WINDOW, DOCUMENT_EXTERNAL_CHANGE_EVENT, payload);
        }) {
            Ok(started) => *watcher = Some(started),
            Err(error) => {
                eprintln!(
                    "workspace-watcher failed to start, falling back to probe-only mode: {error}"
                );
            }
        }
    }

    pub fn start_watcher<R: Runtime>(&self, app: &AppHandle<R>) {
        self.restart_watcher(app, &self.active_workspace());
    }

    pub fn stop_watcher(&self) {
        *self.watcher.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    fn refresh_title<R: Runtime>(&self, app: &AppHandle<R>) {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            let _ = window.set_title(&self.window_title());
        }
    }

    /// Switches the active workspace. The runtime only restarts when the
    /// folder actually changed.
    pub async fn apply_active_vault<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        path: &str,
    ) -> Result<(), String> {
        let trimmed = path.trim().to_owned();
        if trimmed.is_empty() {
            self.stop_watcher();
            self.registry
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clear_active()
                .map_err(io_error)?;
            *self
                .active_workspace
                .write()
                .unwrap_or_else(PoisonError::into_inner) = String::new();
            self.refresh_title(app);
            return Ok(());
        }
        let metadata = std::fs::metadata(&trimmed).map_err(io_error)?;
        if !metadata.is_dir() {
            return Err("workspace path must be a directory".into());
        }
        let previous = self.env().workspace_dir.to_string_lossy().trim().to_owned();
        let changed = previous != trimmed;
        self.set_workspace(&trimmed);
        self.registry
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .set_active(&trimmed)
            .map_err(io_error)?;
        if changed {
            self.supervisor.set_workspace_dir(Path::new(&trimmed));
            if let Err(error) = self.supervisor.retry().await {
                eprintln!("failed to restart backend after workspace change: {error}");
            }
        }
        self.refresh_title(app);
        self.restart_watcher(app, &trimmed);
        Ok(())
    }

    pub async fn document_list(&self) -> Result<Value, String> {
        let root = self.workspace_root();
        blocking(move || files::list(&root)).await
    }
}
