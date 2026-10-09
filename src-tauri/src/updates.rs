//! Signed in-app updates from GitHub Releases. The renderer sees the same
//! state machine as before: idle, checking, available, downloading,
//! downloaded, up-to-date, unsupported, or error.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const UPDATES_EVENT: &str = "desktop:updates:state";
const STABLE_ENDPOINT: &str =
    "https://github.com/KitionAI/kition/releases/latest/download/latest.json";
const BETA_ENDPOINT: &str =
    "https://github.com/KitionAI/kition/releases/download/updater-beta/latest.json";
const PROGRESS_THROTTLE: Duration = Duration::from_millis(250);
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Error kinds the settings page explains differently.
pub fn classify_error(message: &str) -> &'static str {
    let patterns: [(&str, &str); 4] = [
        (
            "network",
            r"(?i)ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ERR_(?:CONNECTION_CLOSED|CONNECTION_RESET|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|TIMED_OUT)|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|error sending request|dns error|connection refused|timed out|tcp connect",
        ),
        (
            "verification",
            r"(?i)sha512|code signature|blockmap|signature",
        ),
        ("disk", r"(?i)ENOSPC|disk space|no space left"),
        ("rate-limit", r"(?i)rate limit|\b403\b|forbidden"),
    ];
    patterns
        .iter()
        .find(|(_, pattern)| Regex::new(pattern).is_ok_and(|regex| regex.is_match(message)))
        .map(|(kind, _)| *kind)
        .unwrap_or("other")
}

fn pubkey() -> &'static str {
    option_env!("KITION_UPDATER_PUBKEY")
        .unwrap_or_default()
        .trim()
}

pub struct UpdateManager {
    state: Mutex<Value>,
    update: tokio::sync::Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
    beta: AtomicBool,
    auto_check: AtomicBool,
    last_broadcast: Mutex<Option<Instant>>,
    proxy: Mutex<Option<url::Url>>,
}

impl Default for UpdateManager {
    fn default() -> Self {
        Self {
            state: Mutex::new(json!({ "phase": "idle" })),
            update: tokio::sync::Mutex::new(None),
            bytes: Mutex::new(None),
            beta: AtomicBool::new(false),
            auto_check: AtomicBool::new(true),
            last_broadcast: Mutex::new(None),
            proxy: Mutex::new(None),
        }
    }
}

fn supported() -> Result<(), &'static str> {
    if cfg!(debug_assertions) {
        Err("dev build")
    } else if pubkey().is_empty() {
        Err("unsigned build")
    } else {
        Ok(())
    }
}

impl UpdateManager {
    pub fn state(&self) -> Value {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn phase(&self) -> String {
        self.state()
            .get("phase")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    }

    fn set<R: Runtime>(&self, app: &AppHandle<R>, next: Value) {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner) = next.clone();
        let _ = app.emit(UPDATES_EVENT, next);
    }

    fn set_progress<R: Runtime>(&self, app: &AppHandle<R>, next: Value) {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner) = next.clone();
        let mut last = self
            .last_broadcast
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if last.is_some_and(|at| at.elapsed() < PROGRESS_THROTTLE) {
            return;
        }
        *last = Some(Instant::now());
        let _ = app.emit(UPDATES_EVENT, next);
    }

    fn set_error<R: Runtime>(&self, app: &AppHandle<R>, message: String) {
        let phase_at_error = self.phase();
        self.set(
            app,
            json!({
                "phase": "error",
                "message": message,
                "errorKind": classify_error(&message),
                "phaseAtError": phase_at_error,
            }),
        );
    }

    pub fn set_proxy(&self, proxy: Option<String>) {
        *self.proxy.lock().unwrap_or_else(PoisonError::into_inner) =
            proxy.and_then(|value| url::Url::parse(&value).ok());
    }

    pub fn set_auto_check(&self, enabled: bool) {
        self.auto_check.store(enabled, Ordering::Relaxed);
    }

    pub async fn set_beta_channel<R: Runtime>(&self, app: &AppHandle<R>, enabled: bool) {
        if self.beta.swap(enabled, Ordering::Relaxed) == enabled {
            return;
        }
        self.check(app).await;
    }

    pub async fn check<R: Runtime>(&self, app: &AppHandle<R>) -> Value {
        if let Err(reason) = supported() {
            self.set(app, json!({ "phase": "unsupported", "reason": reason }));
            return self.state();
        }
        if matches!(
            self.phase().as_str(),
            "checking" | "downloading" | "downloaded"
        ) {
            return self.state();
        }
        self.set(app, json!({ "phase": "checking" }));
        let endpoint = if self.beta.load(Ordering::Relaxed) {
            BETA_ENDPOINT
        } else {
            STABLE_ENDPOINT
        };
        let result = async {
            let endpoint = url::Url::parse(endpoint).map_err(|error| error.to_string())?;
            let mut builder = app
                .updater_builder()
                .pubkey(pubkey())
                .endpoints(vec![endpoint])
                .map_err(|error| error.to_string())?;
            if let Some(proxy) = self
                .proxy
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
            {
                builder = builder.proxy(proxy);
            }
            builder
                .build()
                .map_err(|error| error.to_string())?
                .check()
                .await
                .map_err(|error| error.to_string())
        }
        .await;
        match result {
            Ok(Some(update)) => {
                let next = json!({
                    "phase": "available",
                    "version": update.version,
                    "releaseNotes": update.body,
                    "releaseDate": update.date.map(|date| date.to_string()),
                });
                *self.update.lock().await = Some(update);
                self.set(app, next);
            }
            Ok(None) => self.set(
                app,
                json!({ "phase": "up-to-date", "currentVersion": app.package_info().version.to_string() }),
            ),
            Err(message) => self.set_error(app, message),
        }
        self.state()
    }

    pub async fn download<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        if self.phase() != "available" {
            return Err("no update to download".into());
        }
        let update = self
            .update
            .lock()
            .await
            .clone()
            .ok_or("no update to download")?;
        self.set(
            app,
            json!({ "phase": "downloading", "percent": 0, "transferred": 0, "total": 0, "bytesPerSecond": 0 }),
        );
        let started = Instant::now();
        let mut transferred: u64 = 0;
        let result = update
            .download(
                |chunk, total| {
                    transferred += chunk as u64;
                    let total = total.unwrap_or(0);
                    let elapsed = started.elapsed().as_secs_f64().max(0.001);
                    let percent = if total > 0 {
                        transferred as f64 * 100.0 / total as f64
                    } else {
                        0.0
                    };
                    self.set_progress(
                        app,
                        json!({
                            "phase": "downloading",
                            "percent": percent,
                            "transferred": transferred,
                            "total": total,
                            "bytesPerSecond": (transferred as f64 / elapsed) as u64,
                        }),
                    );
                },
                || {},
            )
            .await;
        match result {
            Ok(bytes) => {
                *self.bytes.lock().unwrap_or_else(PoisonError::into_inner) = Some(bytes);
                self.set(
                    app,
                    json!({ "phase": "downloaded", "version": update.version }),
                );
                Ok(())
            }
            Err(error) => {
                let message = error.to_string();
                self.set_error(app, message.clone());
                Err(message)
            }
        }
    }

    /// Installs the downloaded update. The caller restarts the app.
    pub async fn install(&self) -> Result<(), String> {
        if self.phase() != "downloaded" {
            return Err("no downloaded update".into());
        }
        let update = self
            .update
            .lock()
            .await
            .clone()
            .ok_or("no downloaded update")?;
        let bytes = self
            .bytes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
            .ok_or("no downloaded update")?;
        update.install(bytes).map_err(|error| error.to_string())
    }

    /// Checks shortly after launch and then every six hours.
    pub fn start<R: Runtime>(app: AppHandle<R>) {
        tauri::async_runtime::spawn(async move {
            let manager = app.state::<UpdateManager>();
            if let Err(reason) = supported() {
                manager.set(&app, json!({ "phase": "unsupported", "reason": reason }));
                return;
            }
            if !manager.auto_check.load(Ordering::Relaxed) {
                return;
            }
            tokio::time::sleep(FIRST_CHECK_DELAY).await;
            loop {
                if manager.auto_check.load(Ordering::Relaxed) {
                    manager.check(&app).await;
                }
                tokio::time::sleep(CHECK_INTERVAL).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_errors() {
        assert_eq!(
            classify_error("getaddrinfo ENOTFOUND github.com"),
            "network"
        );
        assert_eq!(classify_error("error sending request for url"), "network");
        assert_eq!(
            classify_error("signature verification failed"),
            "verification"
        );
        assert_eq!(classify_error("No space left on device"), "disk");
        assert_eq!(classify_error("HTTP 403 Forbidden"), "rate-limit");
        assert_eq!(classify_error("boom"), "other");
    }
}
