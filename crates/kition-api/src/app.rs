//! Dependency setup and route assembly.

use std::path::{Path, PathBuf};

use axum::Router;
use std::sync::Arc;

use kition_core::config::AppConfig;
use kition_core::events::EventBus;
use kition_core::{AppError, AppResult};
use kition_http::AuthConfig;
use kition_store::Db;
use kition_workspace::AssetStore;
use sha2::{Digest, Sha256};
use tower_http::services::ServeDir;

/// Shared dependencies, built once at startup.
#[derive(Clone)]
pub struct Deps {
    pub config: AppConfig,
    pub db: Db,
    pub workspace_id: String,
    pub upload_dir: PathBuf,
    pub workspace_dir: Option<PathBuf>,
    pub events: EventBus,
    pub connections: kition_connections::Store,
    pub cloud_session: kition_core::cloud::CloudSessionProvider,
    /// Kition Cloud sign-in; AI features require an active session.
    pub portal: kition_desktop::PortalAuth,
    /// Model provider calls, shared by every AI feature.
    pub ai: kition_ai::engine::Engine,
    /// Kits for this workspace; they stop when the runtime restarts.
    pub kits: kition_kits::KitManager,
    /// Every `.kitable` file open anywhere in the runtime (HTTP routes, the Agent, email/form
    /// sync, workflows); shared so they reuse one `KitableFile` per path. `server.rs` closes it
    /// on shutdown.
    pub tables: kition_datadoc::TableDocuments,
}

impl Deps {
    pub fn hook_runner(&self) -> kition_desktop::HookRunner {
        kition_desktop::HookRunner {
            db: self.db.clone(),
            logs_dir: Some(self.upload_dir.clone()),
            workspace_dir: self.workspace_dir.clone(),
        }
    }

    /// Whether a signed-in cloud account allows AI features.
    pub fn ai_gate(&self) -> kition_ai::chat::AiGate {
        let portal = self.portal.clone();
        Arc::new(move || portal.signed_in())
    }

    pub fn auth(&self) -> AuthConfig {
        AuthConfig {
            db: self.db.clone(),
            jwt_secret: self.config.jwt_secret.clone(),
            disabled: self.config.disable_auth,
        }
    }
}

pub fn build_deps(config: AppConfig) -> AppResult<Deps> {
    let db = Db::open(&config.sqlite_path)?;
    if config.auto_seed {
        let conn = db.conn()?;
        kition_store::seed::run(&conn)?;
    }

    let db_for_connections = db.clone();
    let sqlite_path = config.sqlite_path.clone();
    let upload_dir_text = config.upload_dir.clone();
    let upload_dir = absolute(&config.upload_dir)?;
    std::fs::create_dir_all(&upload_dir)?;
    let workspace_dir = if config.workspace_dir.trim().is_empty() {
        None
    } else {
        let dir = absolute(&config.workspace_dir)?;
        std::fs::create_dir_all(&dir)?;
        Some(dir)
    };

    let workspace_id = match &workspace_dir {
        Some(dir) => {
            let assets = AssetStore::new(dir, Some(&upload_dir))?;
            assets.ensure_manifest()?.workspace_id
        }
        None => short_hash(""),
    };
    let portal = kition_desktop::PortalAuth::new(&config.portal_base_url);
    let cloud_session = portal.cloud_session_provider();
    let ai = kition_ai::engine::Engine::new(
        upload_dir.clone(),
        Some(kition_ai::engine::cloud_resolver(cloud_session.clone())),
    );
    let kits = kition_kits::KitManager::from_env(workspace_dir.clone());
    Ok(Deps {
        kits,
        cloud_session,
        portal,
        ai,
        config,
        db,
        workspace_id,
        upload_dir,
        workspace_dir,
        events: EventBus::default(),
        tables: kition_datadoc::TableDocuments::default(),
        connections: kition_connections::Store {
            db: db_for_connections,
            secrets: kition_connections::SecretStore::new(&sqlite_path, &upload_dir_text),
        },
    })
}

pub fn router(deps: &Deps) -> Router {
    deps.kits.forward_table_changes(deps.events.clone());
    let api = Router::new()
        .merge(crate::system::api_router(deps))
        .merge(kition_ai::models::router(deps.auth()))
        .merge(kition_ai::chat::router(kition_ai::chat::ChatState {
            auth: deps.auth(),
            engine: deps.ai.clone(),
            ai_gate: deps.ai_gate(),
        }))
        .merge(kition_ai::usage::router(deps.auth()))
        .merge(kition_kits::router(kition_kits::KitsState {
            auth: deps.auth(),
            kits: deps.kits.clone(),
        }));
    let api = api.merge(kition_desktop::router(kition_desktop::DesktopState {
        auth: deps.auth(),
        portal: deps.portal.clone(),
        hooks: deps.hook_runner(),
        workspace_dir: deps.workspace_dir.clone(),
        callback_url: format!(
            "http://127.0.0.1:{}{}/desktop/portal/callback",
            deps.config.http_port, deps.config.api_prefix
        ),
    }));
    let workflows = crate::workflows::start(deps);
    let api = api.merge(kition_workflow::router(workflows.state.clone()));
    let used_by = {
        let store = workflows.state.engine.store.clone();
        Arc::new(move |id: &str| store.count_by_connection(id)) as kition_connections::UsedByCounter
    };
    let api = api.merge(kition_connections::router(
        kition_connections::ConnectionsState {
            auth: deps.auth(),
            store: deps.connections.clone(),
            used_by: Some(used_by),
        },
    ));
    let agent = crate::agent::build(
        deps,
        workflows.datadoc.clone(),
        workflows.state.engine.store.clone(),
    );
    let api = api.merge(kition_agent::router(kition_agent::AgentState {
        auth: deps.auth(),
        agent,
        ai_gate: deps.ai_gate(),
    }));
    let api = match workflows.datadoc {
        Some(state) => {
            let forms = kition_formsync::Service::new(
                deps.db.clone(),
                deps.cloud_session.clone(),
                Arc::new(crate::adapters::DataDocTableWriter(state.clone())),
            );
            kition_formsync::start_scheduler(forms.clone());
            let mail = kition_emailsync::Service::new(
                kition_emailsync::store::Store {
                    db: deps.db.clone(),
                    secrets: deps.connections.secrets.clone(),
                },
                Arc::new(kition_emailsync::imap::ImapFetcher),
                kition_emailsync::workspace::WorkspaceWriter {
                    root: state.workspace_dir.clone(),
                    db: deps.db.clone(),
                    tables: state.tables.clone(),
                },
            );
            kition_emailsync::start_scheduler(mail.clone());
            let mirror = kition_workspacestorage::StateMirror {
                db: deps.db.clone(),
                assets: state.assets.clone(),
            };
            if let Err(err) = kition_workspacestorage::start_mirroring(mirror.clone()) {
                tracing::warn!(error = %err, "workspace state mirroring is unavailable");
            }
            api.merge(kition_datadoc::router(state))
                .merge(kition_workspacestorage::router(
                    kition_workspacestorage::WorkspaceStorageState::new(deps.auth(), mirror),
                ))
                .merge(kition_emailsync::router(kition_emailsync::EmailSyncState {
                    auth: deps.auth(),
                    service: mail,
                }))
                .merge(kition_formsync::router(kition_formsync::FormSyncState {
                    auth: deps.auth(),
                    service: forms,
                }))
        }
        None => api,
    };

    let mut app = Router::new()
        .merge(crate::system::root_router(deps))
        .nest(&deps.config.api_prefix, api)
        .nest_service("/uploads", ServeDir::new(&deps.upload_dir));
    if let Some(dir) = &deps.workspace_dir {
        app = app.nest_service("/workspace-files", ServeDir::new(dir));
    }
    app.fallback(kition_http::not_found)
        .layer(axum::middleware::from_fn(
            kition_http::middleware::request_context,
        ))
        .layer(axum::middleware::from_fn(kition_http::cors::cors))
}

/// Data documents need a workspace directory; without one the routes are
/// not mounted.
pub(crate) fn datadoc_state(
    deps: &Deps,
    workflow_cleaner: Option<Arc<dyn kition_datadoc::WorkflowCleaner>>,
) -> Option<kition_datadoc::DataDocState> {
    let workspace_dir = deps.workspace_dir.clone()?;
    let assets = AssetStore::new(&workspace_dir, Some(&deps.upload_dir)).ok()?;
    let state = kition_datadoc::DataDocState {
        auth: deps.auth(),
        db: deps.db.clone(),
        workspace_dir,
        assets,
        events: deps.events.clone(),
        workflow_cleaner,
        ai_gate: deps.ai_gate(),
        imports: kition_datadoc::ImportStore::default(),
        ai: Some(deps.ai.clone()),
        tables: deps.tables.clone(),
    };
    // Co-editing relays learn of every local table transaction from `table/replica-changed`.
    state.publish_replica_changes();
    Some(state)
}

fn absolute(path: &str) -> AppResult<PathBuf> {
    let path = Path::new(path);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    let cwd = std::env::current_dir().map_err(AppError::from)?;
    Ok(normalize(&cwd.join(path)))
}

/// Lexically removes `.` and `..` components, like the legacy runtime.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn short_hash(value: &str) -> String {
    hex::encode(&Sha256::digest(value.as_bytes())[..8])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_relative_segments() {
        assert_eq!(
            normalize(Path::new("/a/b/../c/./d")),
            PathBuf::from("/a/c/d")
        );
    }

    #[test]
    fn short_hash_is_sixteen_hex_digits() {
        assert_eq!(short_hash("").len(), 16);
    }
}
