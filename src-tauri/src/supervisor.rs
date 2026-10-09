//! Runs the Kition runtime inside the app process. The runtime serves its
//! HTTP API on loopback from a dedicated thread, and restarts when the
//! workspace changes.

use std::path::Path;
use std::sync::{Mutex, PoisonError, RwLock};

use kition_api::RunningServer;
use kition_core::config::AppConfig;
use serde_json::{Value, json};

use crate::env::{DesktopEnv, env_value};

const PUBLIC_PORTAL_BASE_URL: &str = "https://kition.ai";

/// The portal the runtime and feedback form talk to.
pub fn portal_base_url() -> String {
    let explicit = env_value("KITION_PORTAL_BASE_URL");
    if !explicit.is_empty() {
        return explicit;
    }
    match option_env!("KITION_BUILD_PORTAL_BASE_URL") {
        Some(value) if !value.trim().is_empty() => value.trim().to_owned(),
        _ => PUBLIC_PORTAL_BASE_URL.to_owned(),
    }
}

pub struct Supervisor {
    env: RwLock<DesktopEnv>,
    app_version: String,
    smtp_proxy: Mutex<String>,
    server: tokio::sync::Mutex<Option<RunningServer>>,
    last_error: Mutex<String>,
}

impl Supervisor {
    pub fn new(env: DesktopEnv, app_version: &str) -> Self {
        Self {
            env: RwLock::new(env),
            app_version: app_version.to_owned(),
            smtp_proxy: Mutex::default(),
            server: tokio::sync::Mutex::new(None),
            last_error: Mutex::default(),
        }
    }

    fn env(&self) -> DesktopEnv {
        self.env
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub fn set_workspace_dir(&self, workspace_dir: &Path) {
        self.env
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .workspace_dir = workspace_dir.to_path_buf();
    }

    /// The proxy SMTP connections tunnel through; `None` connects directly.
    pub fn set_smtp_proxy(&self, proxy: Option<String>) {
        *self
            .smtp_proxy
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = proxy.unwrap_or_default();
    }

    fn config(&self) -> AppConfig {
        let env = self.env();
        let text = |path: &Path| path.to_string_lossy().into_owned();
        AppConfig {
            name: "Kition Desktop API".into(),
            version: self.app_version.clone(),
            api_prefix: "/api/v1".into(),
            // The desktop API is loopback-only and unauthenticated; the
            // secret only signs tokens nothing uses.
            jwt_secret: uuid::Uuid::new_v4().to_string(),
            portal_base_url: portal_base_url(),
            disable_auth: true,
            auto_migrate: true,
            auto_seed: true,
            access_token_expire_minutes: 120,
            refresh_token_expire_days: 7,
            http_port: i64::from(env.backend_port),
            log_level: "info".into(),
            upload_dir: text(&env.uploads_dir),
            workspace_dir: text(&env.workspace_dir),
            sqlite_path: text(&env.sqlite_path),
            smtp_proxy: self
                .smtp_proxy
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone(),
            ..AppConfig::default()
        }
    }

    fn is_running(&self) -> bool {
        self.server
            .try_lock()
            .map(|server| server.is_some())
            .unwrap_or(true)
    }

    fn set_last_error(&self, message: &str) {
        *self
            .last_error
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = message.to_owned();
    }

    pub fn status(&self) -> Value {
        let env = self.env();
        let build = kition_core::runtime_info::current(&self.app_version);
        let last_error = self
            .last_error
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        json!({
            "base_url": env.backend_url,
            "health_url": format!("{}/health", env.backend_url),
            "running": self.is_running(),
            "last_error": last_error,
            "logs": "",
            "log_file": env.log_file,
            "launch_mode": "in_process",
            "runtime_version": build.runtime_version,
            "protocol_version": build.protocol_version,
            "capabilities": kition_core::runtime_info::CAPABILITIES,
        })
    }

    pub async fn start(&self) -> Result<Value, String> {
        let mut server = self.server.lock().await;
        if server.is_none() {
            let config = self.config();
            let started = tokio::task::spawn_blocking(move || kition_api::start(config))
                .await
                .map_err(|error| error.to_string())
                .and_then(|result| result.map_err(|error| format!("{error:#}")));
            match started {
                Ok(running) => {
                    tracing::info!(addr = %running.addr, "runtime listening");
                    *server = Some(running);
                    self.set_last_error("");
                }
                Err(message) => {
                    tracing::error!(error = %message, "runtime failed to start");
                    self.set_last_error(&message);
                    return Err(message);
                }
            }
        }
        drop(server);
        Ok(self.status())
    }

    pub async fn stop(&self) {
        if let Some(running) = self.server.lock().await.take() {
            let _ = tokio::task::spawn_blocking(move || running.stop()).await;
        }
    }

    /// Restarts the runtime, picking up a changed workspace folder.
    pub async fn retry(&self) -> Result<Value, String> {
        self.stop().await;
        self.start().await
    }
}
