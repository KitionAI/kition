// Copied from kition-sdk crates/kition-kit-host/src/headless.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! A kit launched headless and initialized as the host in one call, for programs that run kits
//! without Kition: a server's kit pool, a script runner, a desktop app's background work. It
//! serves the kit the files of one workspace folder (`files.*`) and opens them by path.

use std::sync::Arc;
use std::time::Duration;

use kition_kit_protocol::methods::{Initialize, Initialized};
use kition_kit_protocol::types::{ClientInfo, Empty, InitializeParams, Role};
use kition_kit_protocol::{PROTOCOL_VERSION, RequestMethod};
use serde_json::{Value, json};

use crate::client::{ClientError, KitClient};
use crate::files::{FilesManifest, GrantStore};
use crate::kit_files::{HostService, KitFiles, file_error};
use crate::process::{KitProcess, LaunchOptions};

/// The person a headless host acts for, in its grant log.
pub const HOST_PRINCIPAL: &str = "person:local";

/// A running kit with one initialized host connection. Dropping it kills the process.
pub struct HeadlessKit {
    process: KitProcess,
    client: Arc<KitClient>,
    /// Reads and drops the kit's notifications: a headless host asks for state instead.
    drain: tokio::task::JoinHandle<()>,
    kit_id: String,
    kit_version: String,
    capabilities: Value,
    files: Option<Arc<KitFiles>>,
}

impl Drop for HeadlessKit {
    fn drop(&mut self) {
        self.drain.abort();
    }
}

impl HeadlessKit {
    /// Starts the kit, waits for its ready line, connects, and initializes as the host
    /// (`kit.initialize`, then `kit.initialized`), serving the files of `options.workspace`.
    pub async fn launch(options: LaunchOptions) -> Result<Self, ClientError> {
        let files = match &options.workspace {
            None => None,
            Some(workspace) => {
                let workspace = std::fs::canonicalize(workspace)?;
                let kit = options.executable.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
                let store = Arc::new(GrantStore::new(Some(workspace)));
                Some(Arc::new(KitFiles::open(store, &kit, HOST_PRINCIPAL, FilesManifest::default()).map_err(|error| ClientError::Rpc(file_error(&error)))?))
            }
        };
        let initialize_timeout = options.initialize_timeout;
        let process = KitProcess::launch(options).await?;
        let service = files.clone().map(|files| files as Arc<dyn HostService>);
        let host_services = service.as_ref().map(|service| service.services()).unwrap_or_default();
        let client = Arc::new(process.connect_serving(service).await?);
        let params = InitializeParams {
            protocol_version: PROTOCOL_VERSION,
            token: process.token().to_owned(),
            role: Role::Host,
            client: ClientInfo { name: env!("CARGO_PKG_NAME").to_owned(), version: env!("CARGO_PKG_VERSION").to_owned() },
            locale: None,
            appearance: None,
            host_services,
        };
        // Kept as JSON, so `capabilities` holds every member the kit sent.
        let initialized = client.request(Initialize::NAME, serde_json::to_value(&params)?, Some(initialize_timeout)).await?;
        client.notify::<Initialized>(&Empty {}).await?;
        let drain = tokio::spawn({
            let client = Arc::clone(&client);
            async move { while client.next_notification().await.is_some() {} }
        });
        Ok(Self {
            kit_id: initialized["kit"]["id"].as_str().unwrap_or_default().to_owned(),
            kit_version: initialized["kit"]["version"].as_str().unwrap_or_default().to_owned(),
            capabilities: initialized.get("capabilities").cloned().unwrap_or(Value::Null),
            process,
            client,
            drain,
            files,
        })
    }

    /// Sends `method` and waits up to `limit`, cancelling it (`$/cancelRequest`) when the limit
    /// passes. After a [`ClientError::is_fatal`] failure the kit may be stuck or gone: kill it.
    pub async fn request(&self, method: &str, params: Value, limit: Duration) -> Result<Value, ClientError> {
        self.client.request(method, params, Some(limit)).await
    }

    /// The files this host serves the kit, when it was launched on a workspace.
    pub fn files(&self) -> Option<&KitFiles> {
        self.files.as_deref()
    }

    fn workspace_files(&self) -> Result<&KitFiles, ClientError> {
        self.files().ok_or_else(|| {
            ClientError::Rpc(kition_kit_protocol::RpcError::kit_detail(
                kition_kit_protocol::ErrorReason::FileNotAllowed,
                "the kit was launched without a workspace",
            ))
        })
    }

    /// `document.open` of the workspace file `path`, with a handle minted for it. Answers the
    /// document's state.
    pub async fn open(&self, path: &str, read_only: bool, limit: Duration) -> Result<Value, ClientError> {
        let files = self.workspace_files()?;
        let handle = files.document(path, read_only, false).map_err(|error| ClientError::Rpc(file_error(&error)))?.handle;
        let mut params = json!({ "file": handle });
        if read_only {
            params["readOnly"] = json!(true);
        }
        let state = self.request("document.open", params, limit).await?;
        if let Some(id) = state["documentId"].as_str() {
            files.opened(id, &handle);
        }
        Ok(state)
    }

    /// `document.open` with `create`: a new document of `format` that its first save writes to
    /// the workspace file `path`, which must not exist.
    pub async fn create(&self, path: &str, format: &str, limit: Duration) -> Result<Value, ClientError> {
        let files = self.workspace_files()?;
        let handle = files.document(path, false, false).map_err(|error| ClientError::Rpc(file_error(&error)))?.handle;
        let state = self.request("document.open", json!({ "file": handle, "create": { "format": format } }), limit).await?;
        if let Some(id) = state["documentId"].as_str() {
            files.opened(id, &handle);
        }
        Ok(state)
    }

    /// `kit.<name>`, as `kit.initialize` answered.
    pub fn kit_id(&self) -> &str {
        &self.kit_id
    }

    pub fn kit_version(&self) -> &str {
        &self.kit_version
    }

    /// `kit.initialize`'s `capabilities`.
    pub fn capabilities(&self) -> &Value {
        &self.capabilities
    }

    /// Whether `capabilities.features` lists `feature`.
    pub fn serves(&self, feature: &str) -> bool {
        self.capabilities["features"].as_array().is_some_and(|features| features.iter().any(|known| known == feature))
    }

    /// The process id, while it runs.
    pub fn pid(&self) -> Option<u32> {
        self.process.id()
    }

    /// Whether the process has exited (and is reaped).
    pub fn has_exited(&mut self) -> bool {
        self.process.has_exited()
    }

    /// Asks the kit to shut down (`kit.shutdown`), waits up to `grace` for it to exit, and kills
    /// it if it has not.
    pub async fn shutdown(mut self, grace: Duration) {
        let _ = self.client.request("kit.shutdown", json!({}), Some(grace)).await;
        if self.process.wait_for_exit(grace).await.is_none() {
            self.process.kill().await;
        }
    }

    /// Kills the process and reaps it.
    pub async fn kill(&mut self) {
        self.process.kill().await;
    }
}
