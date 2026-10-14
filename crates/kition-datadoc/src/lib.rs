//! Data documents: the workspace index of `.kitable` files and their HTTP
//! API. The `.kitable` file is the source of truth; `data_documents` rows
//! index it so documents have stable numeric IDs.

mod agent_api;
mod ai_field;
mod csvutil;
mod dashboards;
mod documents;
mod import_parse;
mod import_write;
pub mod index;
mod records;
mod respond;
mod scenario;
mod source;
mod table_documents;
mod tables;
mod transact;
mod view_config;
pub mod workflow_api;

pub use table_documents::{TableDocuments, TableHandle};

pub use import_write::ImportStore;

use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::extract::FromRef;
use kition_core::events::EventBus;
use kition_core::{AppError, AppResult};
use kition_http::AuthConfig;
use kition_store::Db;
use kition_workspace::AssetStore;

/// Detaches workflows from a deleted document so a new file at the same path
/// does not inherit them.
pub trait WorkflowCleaner: Send + Sync {
    fn delete_by_document_id(&self, document_id: &str) -> AppResult<usize>;
}

/// Whether a connected cloud account allows AI features.
pub type AiGate = Arc<dyn Fn() -> bool + Send + Sync>;

#[derive(Clone)]
pub struct DataDocState {
    pub auth: AuthConfig,
    pub db: Db,
    pub workspace_dir: PathBuf,
    pub assets: AssetStore,
    pub events: EventBus,
    pub workflow_cleaner: Option<Arc<dyn WorkflowCleaner>>,
    pub ai_gate: AiGate,
    pub imports: import_write::ImportStore,
    /// Model calls for AI fields.
    pub ai: Option<kition_ai::engine::Engine>,
    /// Every `.kitable` file this workspace has open, shared by every caller (routes, the
    /// Agent, email/form sync, workflows) instead of each opening its own connection.
    pub tables: TableDocuments,
}

impl FromRef<DataDocState> for AuthConfig {
    fn from_ref(state: &DataDocState) -> Self {
        state.auth.clone()
    }
}

impl DataDocState {
    /// Runs synchronous document work (SQLite and `.kitable` access) off the
    /// async executor.
    pub(crate) async fn blocking<T, F>(&self, work: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&DataDocState) -> AppResult<T> + Send + 'static,
    {
        let state = self.clone();
        tokio::task::spawn_blocking(move || work(&state))
            .await
            .map_err(AppError::unhandled)?
    }

    pub(crate) fn require_ai(&self) -> AppResult<()> {
        if (self.ai_gate)() {
            Ok(())
        } else {
            Err(AppError::localized(
                401,
                4015,
                "auth.ai_login_required",
                Vec::new(),
            ))
        }
    }
}

pub fn router(state: DataDocState) -> Router {
    Router::new()
        .merge(documents::routes())
        .merge(tables::routes())
        .merge(records::routes())
        .merge(view_config::routes())
        .merge(import_write::routes())
        .merge(ai_field::routes())
        .merge(scenario::routes())
        .merge(transact::routes())
        .merge(dashboards::routes())
        .layer(axum::extract::DefaultBodyLimit::max(
            import_write::MAX_SOURCE_BYTES + 1024 * 1024,
        ))
        .with_state(state)
}
