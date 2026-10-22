//! Dependency setup and route assembly.

use std::path::{Path, PathBuf};

use axum::Router;
use axum::response::IntoResponse;
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

pub fn build_deps(mut config: AppConfig) -> AppResult<Deps> {
    if config.api_token.is_empty() {
        config.api_token = kition_http::gate::new_token();
    }
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
    write_token_file(&config, &upload_dir, workspace_dir.as_deref())?;
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
        .nest_service(
            "/uploads",
            file_service(Router::new().fallback_service(ServeDir::new(&deps.upload_dir))),
        );
    if let Some(dir) = &deps.workspace_dir {
        app = app
            .nest_service(
                "/workspace-files",
                file_service(Router::new().fallback_service(ServeDir::new(dir))),
            )
            .nest_service("/kit-files", file_service(kit_files(dir)));
    }
    let routes = app
        .fallback(kition_http::not_found)
        .layer(axum::middleware::from_fn(
            kition_http::middleware::request_context,
        ));
    kition_http::guard(
        routes,
        kition_http::gate::ApiGate::new(&deps.config.api_token, &deps.config.api_prefix),
        kition_http::cors::CorsPolicy::new(deps.config.allowed_origins.iter().cloned()),
    )
}

/// A file service's answers never run as a page of the runtime's origin: `nosniff` on every file,
/// and a sandbox for the types a browser would run script in (a workspace HTML or SVG file opened
/// at its URL). PDFs keep their viewer.
fn file_service(files: Router) -> Router {
    files.layer(axum::middleware::map_response(
        |mut response: axum::response::Response| async move {
            let headers = response.headers_mut();
            headers.insert(
                axum::http::header::X_CONTENT_TYPE_OPTIONS,
                axum::http::HeaderValue::from_static("nosniff"),
            );
            let scriptable = headers
                .get(axum::http::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .is_some_and(|mime| {
                    matches!(
                        mime.trim().to_ascii_lowercase().as_str(),
                        "text/html"
                            | "application/xhtml+xml"
                            | "image/svg+xml"
                            | "text/xml"
                            | "application/xml"
                    )
                });
            if scriptable {
                headers.insert(
                    axum::http::header::CONTENT_SECURITY_POLICY,
                    axum::http::HeaderValue::from_static("sandbox"),
                );
            }
            response
        },
    ))
}

/// Writes this launch's API token where trusted local clients read it (`kition-acp`): readable
/// by this account only, and never inside a folder the runtime serves, where a kit could read it.
fn write_token_file(
    config: &AppConfig,
    upload_dir: &Path,
    workspace_dir: Option<&Path>,
) -> AppResult<()> {
    let path = if config.api_token_file.trim().is_empty() {
        absolute(&config.sqlite_path)?.with_file_name("api-token")
    } else {
        absolute(&config.api_token_file)?
    };
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(parent)?;
    let real_parent = std::fs::canonicalize(parent)?;
    let served = [Some(upload_dir), workspace_dir]
        .into_iter()
        .flatten()
        .filter_map(|dir| std::fs::canonicalize(dir).ok());
    for dir in served {
        if real_parent.starts_with(&dir) {
            tracing::warn!(
                path = %path.display(),
                "not writing the API token inside a folder the runtime serves"
            );
            return Ok(());
        }
    }
    write_private(&path, config.api_token.as_bytes())?;
    Ok(())
}

/// Replaces `path` with `bytes`, readable and writable by this account only.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let temporary = path.with_extension("tmp");
    let _ = std::fs::remove_file(&temporary);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temporary, path)
}

/// The workspace as kits read it: `host/read`, `host/stamp`, and lent reads by kit engines (Kit
/// UI protocol). Like `/workspace-files`, but it never serves a hidden file or folder, Kition's
/// own store `.kition/` (other documents' replicas and comment threads) among them, nor a file a
/// link leads to outside the workspace (rule LR2).
fn kit_files(dir: &Path) -> Router {
    let root = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    Router::new()
        .fallback_service(ServeDir::new(dir))
        .layer(axum::middleware::from_fn(
            move |request: axum::extract::Request, next: axum::middleware::Next| {
                let refused = !kit_may_read(&root, request.uri().path());
                async move {
                    if refused {
                        return axum::http::StatusCode::NOT_FOUND.into_response();
                    }
                    next.run(request).await
                }
            },
        ))
}

/// Whether a kit may read the workspace file at the request path `path` (percent-encoded, as the
/// file service decodes it): no segment hidden, and inside the workspace `root` once links are
/// followed.
fn kit_may_read(root: &Path, path: &str) -> bool {
    let decoded = percent_decoded(path);
    let hidden = |segment: &str| segment.starts_with('.');
    if decoded.split(['/', '\\']).any(hidden) {
        return false;
    }
    let relative = decoded.trim_start_matches(['/', '\\']);
    match std::fs::canonicalize(root.join(relative)) {
        Ok(real) => real.strip_prefix(root).is_ok_and(|inside| {
            !inside
                .components()
                .any(|part| hidden(&part.as_os_str().to_string_lossy()))
        }),
        // Missing: the file service answers 404 itself.
        Err(_) => true,
    }
}

/// `path` with its `%XX` escapes decoded; an invalid escape stays as written.
fn percent_decoded(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escaped = (bytes[index] == b'%')
            .then(|| bytes.get(index + 1..index + 3))
            .flatten()
            .and_then(|hex| u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok());
        match escaped {
            Some(byte) => {
                out.push(byte);
                index += 3;
            }
            None => {
                out.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
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

    #[tokio::test]
    async fn kits_never_read_kitions_store_or_hidden_paths() {
        use axum::body::Body;
        use axum::http::{Request, StatusCode};
        use tower::ServiceExt;

        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        for name in [
            ".kition/docs/index.json",
            ".kition/docs/d1/meta.json",
            ".git/config",
            "art/.hidden/cover.png",
            "art/.env",
            "art/cover.png",
            "clips/intro.mp4",
        ] {
            let path = dir.path().join(name);
            std::fs::create_dir_all(path.parent().unwrap_or(dir.path()))
                .unwrap_or_else(|err| panic!("{err}"));
            std::fs::write(&path, "bytes").unwrap_or_else(|err| panic!("{err}"));
        }
        let files = kit_files(dir.path());
        let status = |method: &'static str, uri: &str| {
            let request = Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .unwrap_or_else(|err| panic!("{err}"));
            let files = files.clone();
            async move {
                files
                    .oneshot(request)
                    .await
                    .unwrap_or_else(|err| panic!("{err}"))
                    .status()
            }
        };
        for uri in [
            "/.kition/docs/index.json",
            "/.kition/docs/d1/meta.json",
            "/%2Ekition/docs/index.json",
            "/%2ekition%2Fdocs%2Findex.json",
            "/art%2F.env",
            "/.git/config",
            "/art/.hidden/cover.png",
            "/art/.env",
            "/art/../.kition/docs/index.json",
            "/.kition/",
        ] {
            assert_eq!(status("GET", uri).await, StatusCode::NOT_FOUND, "GET {uri}");
            assert_eq!(
                status("HEAD", uri).await,
                StatusCode::NOT_FOUND,
                "HEAD {uri}"
            );
        }
        // A link inside the workspace does not reach the store, nor one a file outside it.
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
            std::fs::write(outside.path().join("secret.txt"), "bytes")
                .unwrap_or_else(|err| panic!("{err}"));
            std::os::unix::fs::symlink(dir.path().join(".kition"), dir.path().join("art/store"))
                .unwrap_or_else(|err| panic!("{err}"));
            std::os::unix::fs::symlink(outside.path(), dir.path().join("art/outside"))
                .unwrap_or_else(|err| panic!("{err}"));
            for uri in ["/art/store/docs/index.json", "/art/outside/secret.txt"] {
                assert_eq!(status("GET", uri).await, StatusCode::NOT_FOUND, "GET {uri}");
            }
        }
        // The document's files, beside it and elsewhere in the workspace, stay readable.
        for uri in ["/art/cover.png", "/clips/intro.mp4", "/art%2Fcover.png"] {
            assert_eq!(status("GET", uri).await, StatusCode::OK, "GET {uri}");
            assert_eq!(status("HEAD", uri).await, StatusCode::OK, "HEAD {uri}");
        }
    }

    /// Attack tests for the API token gate (W1-30 phase 1, design tests A10 and A11): whoever
    /// lacks this launch's token, a kit frame, another account, a page in the person's browser,
    /// reaches no route and changes nothing; no answer and no served folder hands the token out.
    #[tokio::test]
    async fn callers_without_the_launch_token_reach_nothing() {
        use axum::body::Body;
        use axum::http::{Request, StatusCode};
        use http_body_util::BodyExt;
        use tower::ServiceExt;

        let dir = tempfile::tempdir().unwrap_or_else(|err| panic!("{err}"));
        let root = dir.path();
        let workspace = root.join("workspace");
        for (name, bytes) in [
            (".kition/docs/index.json", "store"),
            ("art/note.txt", "the note"),
            (
                "art/page.html",
                "<script>parent.postMessage(1, '*')</script>",
            ),
        ] {
            let path = workspace.join(name);
            std::fs::create_dir_all(path.parent().unwrap_or(&workspace))
                .unwrap_or_else(|err| panic!("{err}"));
            std::fs::write(&path, bytes).unwrap_or_else(|err| panic!("{err}"));
        }
        let text = |path: std::path::PathBuf| path.to_string_lossy().into_owned();
        let deps = build_deps(AppConfig {
            name: "test".into(),
            api_prefix: "/api/v1".into(),
            jwt_secret: "test".into(),
            portal_base_url: "https://kition.ai".into(),
            disable_auth: true,
            auto_seed: true,
            sqlite_path: text(root.join("data/test.db")),
            upload_dir: text(root.join("uploads")),
            workspace_dir: text(workspace.clone()),
            ..AppConfig::default()
        })
        .unwrap_or_else(|err| panic!("{err}"));
        let token = deps.config.api_token.clone();
        assert_eq!(token.len(), 64);

        // The token file: beside the database, this account's only, outside every served folder.
        let token_file = root.join("data/api-token");
        assert_eq!(
            std::fs::read_to_string(&token_file).unwrap_or_default(),
            token
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&token_file)
                .map(|meta| meta.permissions().mode() & 0o777)
                .unwrap_or_default();
            assert_eq!(mode, 0o600);
        }

        let app = router(&deps);
        let send = |method: &str, uri: &str, headers: &[(&str, &str)], body: &str| {
            let mut request = Request::builder()
                .method(method)
                .uri(uri)
                .header("host", "127.0.0.1:18101");
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            let request = request
                .body(Body::from(body.to_owned()))
                .unwrap_or_else(|err| panic!("{err}"));
            let app = app.clone();
            async move {
                let response = app
                    .oneshot(request)
                    .await
                    .unwrap_or_else(|err| match err {});
                let status = response.status();
                let headers = response.headers().clone();
                let bytes = response
                    .into_body()
                    .collect()
                    .await
                    .map(|body| body.to_bytes())
                    .unwrap_or_default();
                (
                    status,
                    headers,
                    String::from_utf8_lossy(&bytes).into_owned(),
                )
            }
        };
        let pwned = root.join("pwned");
        let hook = serde_json::json!({
            "name": "x", "event": "session_started", "matcher": "", "workdir": "",
            "command": format!("touch {}", pwned.display()), "timeout_seconds": 5, "enabled": true,
        })
        .to_string();
        let lifecycle = r#"{"event":"session_started"}"#;
        let attacks: [(&str, &str, &str); 9] = [
            ("POST", "/api/v1/desktop/hooks", hook.as_str()),
            ("POST", "/api/v1/desktop/hooks/lifecycle", lifecycle),
            ("GET", "/workspace-files/.kition/docs/index.json", ""),
            ("GET", "/workspace-files/art/note.txt", ""),
            ("GET", "/kit-files/art/note.txt", ""),
            (
                "PUT",
                "/api/v1/kits/files?path=art/note.txt&document=art/note.txt",
                "overwritten",
            ),
            ("PUT", "/api/v1/kits/files?path=art/new.txt", "new"),
            ("GET", "/api/v1/desktop/runtime", ""),
            ("GET", "/no/such/route", ""),
        ];
        // No token; a wrong one; a form post that needs no preflight; a page on another local port.
        let callers: [&[(&str, &str)]; 5] = [
            &[],
            &[("kition-token", "0000")],
            &[("content-type", "text/plain")],
            &[
                ("authorization", "Bearer x"),
                ("content-type", "application/json"),
            ],
            &[
                ("origin", "http://localhost:3001"),
                ("kition-token", "guess"),
            ],
        ];
        for (method, uri, body) in attacks {
            for headers in callers {
                let (status, answer_headers, answer) = send(method, uri, headers, body).await;
                assert!(
                    matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN),
                    "{method} {uri} {headers:?}: {status}"
                );
                assert!(
                    !answer.contains("store") && !answer.contains("the note"),
                    "{answer}"
                );
                assert!(
                    answer_headers.get("access-control-allow-origin").is_none(),
                    "{method} {uri} {headers:?}"
                );
            }
        }

        // Nothing changed.
        let with_token = [("kition-token", token.as_str())];
        let (status, _, hooks) = send("GET", "/api/v1/desktop/hooks", &with_token, "").await;
        assert_eq!(status, StatusCode::OK);
        assert!(hooks.contains(r#""items":[]"#), "{hooks}");
        assert!(!pwned.exists());
        assert_eq!(
            std::fs::read_to_string(workspace.join("art/note.txt")).unwrap_or_default(),
            "the note"
        );
        assert!(!workspace.join("art/new.txt").exists());

        // Kition's renderer, with the token, is served; file answers never run as pages here.
        let (status, headers, body) =
            send("GET", "/workspace-files/art/note.txt", &with_token, "").await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "the note"));
        assert_eq!(
            headers.get("x-content-type-options").map(|v| v.as_bytes()),
            Some(&b"nosniff"[..])
        );
        assert!(headers.get("content-security-policy").is_none());
        for uri in ["/workspace-files/art/page.html", "/kit-files/art/page.html"] {
            let (status, headers, _) = send("GET", uri, &with_token, "").await;
            assert_eq!(status, StatusCode::OK, "{uri}");
            assert_eq!(
                headers.get("content-security-policy").map(|v| v.as_bytes()),
                Some(&b"sandbox"[..]),
                "{uri}"
            );
        }

        // A lent root signed for kits reads the workspace as kits may, and nothing else.
        let gate = kition_http::gate::ApiGate::new(&token, "/api/v1");
        let lent = gate.signed_path("/kit-files/", "/kit-files/".len(), 4_102_444_800);
        let (status, _, body) = send("GET", &format!("{lent}art/note.txt"), &[], "").await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "the note"));
        let (status, _, _) = send("GET", &format!("{lent}.kition/docs/index.json"), &[], "").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let stamp = lent.trim_end_matches("/kit-files/");
        for elsewhere in [
            "/workspace-files/.kition/docs/index.json",
            "/api/v1/desktop/hooks",
        ] {
            let (status, _, _) = send("GET", &format!("{stamp}{elsewhere}"), &[], "").await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{elsewhere}");
        }

        // No answer carries the token, and no served folder reaches its file.
        for uri in [
            "/",
            "/health",
            "/api/v1/desktop/runtime",
            "/api/v1/auth/me",
            "/workspace-files/../data/api-token",
            "/workspace-files/%2e%2e/data/api-token",
            "/uploads/../data/api-token",
            "/uploads/%2e%2e/data/api-token",
        ] {
            let (_, headers, body) = send("GET", uri, &with_token, "").await;
            assert!(!body.contains(&token), "{uri}");
            assert!(
                headers
                    .values()
                    .all(|value| !String::from_utf8_lossy(value.as_bytes()).contains(&token)),
                "{uri}"
            );
        }
    }
}
