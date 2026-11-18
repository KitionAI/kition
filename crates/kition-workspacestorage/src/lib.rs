//! Portable workspace storage: `/workspace/storage` routes and mirroring of
//! agent state into the workspace folder.

pub mod state;
pub mod storage;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::response::Response;
use axum::routing::{get, post};
use kition_core::{AppError, AppResult, now_millis};
use kition_http::{AuthConfig, CurrentUser, JsonBody, ok};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Notify;

pub use state::{MIRRORED_TABLES, StateMirror};

/// Delay that coalesces bursts of row changes into one export.
const MIRROR_DEBOUNCE: Duration = Duration::from_millis(200);

#[derive(Clone)]
pub struct WorkspaceStorageState {
    pub auth: AuthConfig,
    pub mirror: StateMirror,
    running: Arc<AtomicBool>,
}

impl WorkspaceStorageState {
    pub fn new(auth: AuthConfig, mirror: StateMirror) -> Self {
        Self {
            auth,
            mirror,
            running: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl axum::extract::FromRef<WorkspaceStorageState> for AuthConfig {
    fn from_ref(state: &WorkspaceStorageState) -> Self {
        state.auth.clone()
    }
}

pub fn router(state: WorkspaceStorageState) -> Router {
    Router::new()
        .route("/workspace/storage", get(status))
        .route("/workspace/storage/inventory", get(inventory))
        .route("/workspace/storage/verify", post(verify))
        .route("/workspace/storage/migrate", post(migrate))
        .with_state(state)
}

async fn inspect(
    state: &WorkspaceStorageState,
    include_items: bool,
    failure: &'static str,
) -> AppResult<storage::Inventory> {
    let mirror = state.mirror.clone();
    let running = state.running.load(Ordering::SeqCst);
    tokio::task::spawn_blocking(move || mirror.build_inventory(include_items, running))
        .await
        .map_err(AppError::unhandled)?
        .map_err(|err| {
            tracing::warn!(error = %err, "workspace storage inspection failed");
            AppError::internal(failure)
        })
}

async fn status(
    State(state): State<WorkspaceStorageState>,
    _user: CurrentUser,
) -> AppResult<Response> {
    Ok(ok(inspect(
        &state,
        false,
        "Failed to inspect workspace storage",
    )
    .await?
    .status))
}

async fn inventory(
    State(state): State<WorkspaceStorageState>,
    _user: CurrentUser,
) -> AppResult<Response> {
    Ok(ok(inspect(
        &state,
        true,
        "Failed to inspect workspace storage",
    )
    .await?))
}

async fn verify(
    State(state): State<WorkspaceStorageState>,
    _user: CurrentUser,
) -> AppResult<Response> {
    let status = inspect(&state, false, "Failed to verify workspace storage")
        .await?
        .status;
    Ok(ok(
        json!({ "verified_at": now_millis(), "valid": status.portable, "status": status }),
    ))
}

#[derive(Debug, Default, Deserialize)]
struct MigrationInput {
    #[serde(default)]
    dry_run: bool,
    #[serde(default)]
    include_workspace_state: Option<bool>,
}

/// Clears the running flag when the migration ends, even on panic.
struct RunningGuard(Arc<AtomicBool>);

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

async fn migrate(
    State(state): State<WorkspaceStorageState>,
    _user: CurrentUser,
    JsonBody(input): JsonBody<MigrationInput>,
) -> AppResult<Response> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err(AppError::bad_request(
            "Workspace migration is already running",
        ));
    }
    let guard = RunningGuard(state.running.clone());
    let mirror = state.mirror.clone();
    let include_state = input.include_workspace_state.unwrap_or(true);
    let result = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        mirror.run_migration(input.dry_run, include_state)
    })
    .await
    .map_err(AppError::unhandled)?
    .map_err(|err| {
        tracing::warn!(error = %err, "workspace storage migration failed");
        AppError::internal("Failed to migrate workspace storage")
    })?;
    Ok(ok(result))
}

/// Imports workspace state into the database, exports the merged state, and
/// keeps mirroring changes to mirrored tables. Unreadable state is logged
/// and skipped so a damaged file never blocks startup.
pub fn start_mirroring(mirror: StateMirror) -> AppResult<()> {
    if let Err(err) = mirror.import_agent_state() {
        tracing::warn!(error = %err, "agent state import failed");
    }
    mirror.export()?;
    let notify = Arc::new(Notify::new());
    let signal = notify.clone();
    mirror.db.on_table_change(move |table| {
        if MIRRORED_TABLES.contains(&table) {
            signal.notify_one();
        }
    });
    tokio::spawn(async move {
        loop {
            notify.notified().await;
            tokio::time::sleep(MIRROR_DEBOUNCE).await;
            let mirror = mirror.clone();
            let result = tokio::task::spawn_blocking(move || mirror.export()).await;
            match result {
                Ok(Err(err)) => tracing::warn!(error = %err, "workspace state mirroring failed"),
                Err(err) => tracing::warn!(error = %err, "workspace state mirroring task failed"),
                Ok(Ok(())) => {}
            }
        }
    });
    Ok(())
}
