//! The Kit Protocol conformance suite (protocol section 14).
//!
//! The suite launches a kit executable in `headless` mode and checks it as a
//! black box over the real transport. Every kit release must pass it.
//! Embedding behavior is accepted manually in the desktop client instead.

pub mod schema;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use kition_kit_host::{ClientError, KitClient, KitProcess, LaunchOptions};
use kition_kit_protocol::launch::{SHUTDOWN_TIMEOUT, Surface};
use kition_kit_protocol::manifest::KitManifest;
use kition_kit_protocol::methods::{self, RequestMethod};
use kition_kit_protocol::types::*;
use kition_kit_protocol::{ErrorReason, PROTOCOL_VERSION, RpcError};
use serde_json::{Map, Value, json};

use schema::Schemas;

const NEGATIVE_TIMEOUT: Duration = Duration::from_secs(5);
const SCREENSHOT_MAX_SIZE: u32 = 512;

/// A document the suite opens, edits with one command, saves, and reopens.
#[derive(Clone, Debug)]
pub struct Fixture {
    pub file_name: String,
    pub contents: Vec<u8>,
    pub edit_command: String,
    pub edit_params: Map<String, Value>,
}

#[derive(Clone, Debug)]
pub struct Options {
    pub executable: PathBuf,
    /// The kit's `kit.json`, checked against the schema and the running kit.
    pub manifest: Option<PathBuf>,
    pub fixture: Fixture,
    /// Extra environment for the kit process.
    pub env: Vec<(OsString, OsString)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Passed,
    Failed(String),
    Skipped(String),
}

#[derive(Clone, Debug)]
pub struct CheckResult {
    pub id: &'static str,
    pub title: &'static str,
    pub outcome: Outcome,
}

#[derive(Clone, Debug, Default)]
pub struct Report {
    pub checks: Vec<CheckResult>,
}

impl Report {
    pub fn passed(&self) -> bool {
        !self.checks.is_empty()
            && self
                .checks
                .iter()
                .all(|check| check.outcome == Outcome::Passed)
    }

    pub fn outcome(&self, id: &str) -> Option<&Outcome> {
        self.checks
            .iter()
            .find(|check| check.id == id)
            .map(|check| &check.outcome)
    }

    fn record(
        &mut self,
        id: &'static str,
        title: &'static str,
        result: Result<(), String>,
    ) -> bool {
        let passed = result.is_ok();
        let outcome = match result {
            Ok(()) => Outcome::Passed,
            Err(reason) => Outcome::Failed(reason),
        };
        self.checks.push(CheckResult { id, title, outcome });
        passed
    }

    fn skip(&mut self, id: &'static str, title: &'static str, reason: &str) {
        self.checks.push(CheckResult {
            id,
            title,
            outcome: Outcome::Skipped(reason.to_owned()),
        });
    }

    /// One line per check, for terminals and CI logs.
    pub fn render(&self) -> String {
        let mut out = String::new();
        for check in &self.checks {
            let line = match &check.outcome {
                Outcome::Passed => format!("PASS {} - {}\n", check.id, check.title),
                Outcome::Failed(reason) => {
                    format!("FAIL {} - {}: {reason}\n", check.id, check.title)
                }
                Outcome::Skipped(reason) => {
                    format!("SKIP {} - {}: {reason}\n", check.id, check.title)
                }
            };
            out.push_str(&line);
        }
        let passed = self
            .checks
            .iter()
            .filter(|check| check.outcome == Outcome::Passed)
            .count();
        out.push_str(&format!("{passed}/{} checks passed\n", self.checks.len()));
        out
    }
}

/// Every check id, in the order the suite runs them.
pub const CHECKS: &[(&str, &str)] = &[
    ("manifest", "kit.json matches the manifest schema"),
    ("launch", "starts and reports ready within 10 seconds"),
    ("pre-initialize", "rejects methods before kit.initialize"),
    (
        "protocol-version",
        "rejects an unsupported protocol version",
    ),
    (
        "wrong-token",
        "rejects a wrong token and closes the connection",
    ),
    (
        "agent-before-host",
        "rejects an agent before the host initialized",
    ),
    ("initialize", "initializes the host within 10 seconds"),
    ("commands", "lists commands with valid parameter schemas"),
    ("round-trip", "opens, edits, saves, and reopens the fixture"),
    (
        "agent-limits",
        "limits the agent role to granted methods and URIs",
    ),
    ("screenshot", "renders view.screenshot in headless mode"),
    ("shutdown", "exits within 5 seconds of kit.shutdown"),
    (
        "quiet-stdout",
        "writes nothing to standard output after ready",
    ),
];

fn title(id: &str) -> &'static str {
    CHECKS
        .iter()
        .find(|(known, _)| *known == id)
        .map_or("", |(_, title)| title)
}

struct Context<'a> {
    options: &'a Options,
    schemas: Schemas,
    manifest: Option<KitManifest>,
    process: KitProcess,
    workspace: PathBuf,
    outside: PathBuf,
}

pub async fn run(options: &Options) -> Report {
    let mut report = Report::default();
    let schemas = match Schemas::load() {
        Ok(schemas) => schemas,
        Err(error) => {
            report.record("manifest", title("manifest"), Err(error));
            return report;
        }
    };

    let manifest = match &options.manifest {
        None => {
            report.skip("manifest", title("manifest"), "no kit.json given");
            None
        }
        Some(path) => match check_manifest(&schemas, path) {
            Ok(manifest) => {
                report.record("manifest", title("manifest"), Ok(()));
                Some(manifest)
            }
            Err(error) => {
                report.record("manifest", title("manifest"), Err(error));
                None
            }
        },
    };

    let (Ok(workspace), Ok(outside)) = (tempfile::tempdir(), tempfile::tempdir()) else {
        report.record(
            "launch",
            title("launch"),
            Err("cannot create temporary directories".into()),
        );
        return report;
    };
    let mut launch = LaunchOptions::new(&options.executable, Surface::Headless);
    launch.env.clone_from(&options.env);
    let process = match KitProcess::launch(launch).await {
        Ok(process) => {
            report.record("launch", title("launch"), Ok(()));
            process
        }
        Err(error) => {
            report.record("launch", title("launch"), Err(error.to_string()));
            skip_rest(&mut report, "the kit did not launch");
            return report;
        }
    };
    let mut context = Context {
        options,
        schemas,
        manifest,
        process,
        workspace: canonical(workspace.path()),
        outside: canonical(outside.path()),
    };

    report.record(
        "pre-initialize",
        title("pre-initialize"),
        context.pre_initialize().await,
    );
    report.record(
        "protocol-version",
        title("protocol-version"),
        context.protocol_version().await,
    );
    report.record(
        "wrong-token",
        title("wrong-token"),
        context.wrong_token().await,
    );
    report.record(
        "agent-before-host",
        title("agent-before-host"),
        context.agent_before_host().await,
    );

    let host = match context.initialize_host().await {
        Ok((host, result)) => {
            report.record("initialize", title("initialize"), Ok(()));
            Some((host, result))
        }
        Err(error) => {
            report.record("initialize", title("initialize"), Err(error));
            None
        }
    };

    if let Some((host, initialized)) = host {
        let commands = context.commands(&host).await;
        let commands_ok = report.record(
            "commands",
            title("commands"),
            commands.as_ref().map(|_| ()).map_err(Clone::clone),
        );
        match commands {
            Ok(commands) if commands_ok => {
                report.record(
                    "round-trip",
                    title("round-trip"),
                    context.round_trip(&host, &commands, &initialized).await,
                );
            }
            _ => report.skip("round-trip", title("round-trip"), "commands.list failed"),
        }
        report.record(
            "agent-limits",
            title("agent-limits"),
            context.agent_limits().await,
        );
        report.record(
            "screenshot",
            title("screenshot"),
            context.screenshot(&host).await,
        );
        report.record("shutdown", title("shutdown"), context.shutdown(&host).await);
    } else {
        for id in [
            "commands",
            "round-trip",
            "agent-limits",
            "screenshot",
            "shutdown",
        ] {
            report.skip(id, title(id), "the host could not initialize");
        }
        context.process.kill().await;
    }

    let closed = context
        .process
        .wait_stdout_closed(Duration::from_secs(2))
        .await;
    let quiet = if !closed {
        Err("standard output did not close after exit".to_owned())
    } else if context.process.wrote_stdout_after_ready() {
        Err("the kit wrote to standard output after its ready line".to_owned())
    } else {
        Ok(())
    };
    report.record("quiet-stdout", title("quiet-stdout"), quiet);
    drop((workspace, outside));
    report
}

fn skip_rest(report: &mut Report, reason: &str) {
    for (id, title) in CHECKS.iter().skip_while(|(id, _)| *id != "pre-initialize") {
        report.skip(id, title, reason);
    }
}

fn check_manifest(schemas: &Schemas, path: &Path) -> Result<KitManifest, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|error| format!("kit.json is not JSON: {error}"))?;
    schemas.manifest(&value)?;
    let manifest: KitManifest = serde_json::from_value(value).map_err(|error| error.to_string())?;
    if manifest.kit_protocol != PROTOCOL_VERSION {
        return Err(format!(
            "kitProtocol is {}, expected {PROTOCOL_VERSION}",
            manifest.kit_protocol
        ));
    }
    Ok(manifest)
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn file_uri(path: &Path) -> Result<String, String> {
    url::Url::from_file_path(path)
        .map(String::from)
        .map_err(|()| format!("cannot express {} as a file URI", path.display()))
}

fn dir_uri(path: &Path) -> Result<String, String> {
    url::Url::from_directory_path(path)
        .map(String::from)
        .map_err(|()| format!("cannot express {} as a file URI", path.display()))
}

fn client_info() -> ClientInfo {
    ClientInfo {
        name: "kition-kit-conformance".into(),
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

/// Expects a JSON-RPC error with `code`.
fn expect_code<T: std::fmt::Debug>(
    result: Result<T, ClientError>,
    code: i64,
) -> Result<(), String> {
    match result {
        Err(ClientError::Rpc(RpcError { code: actual, .. })) if actual == code => Ok(()),
        Err(ClientError::Rpc(error)) => Err(format!(
            "expected error {code}, got {} ({})",
            error.code, error.message
        )),
        Err(error) => Err(format!("expected error {code}, got {error}")),
        Ok(value) => Err(format!("expected error {code}, got success {value:?}")),
    }
}

fn expect_reason<T: std::fmt::Debug>(
    result: Result<T, ClientError>,
    reason: ErrorReason,
) -> Result<(), String> {
    expect_code(result, reason.code())
}

impl Context<'_> {
    fn initialize_params(
        &self,
        role: Role,
        token: &str,
        protocol_version: u32,
    ) -> Result<InitializeParams, String> {
        Ok(InitializeParams {
            protocol_version,
            token: token.to_owned(),
            role,
            client: client_info(),
            locale: (role == Role::Host).then(|| "en-US".to_owned()),
            appearance: (role == Role::Host).then_some(Appearance::Light),
            reserved_shortcuts: Vec::new(),
            workspace_roots: match role {
                Role::Host => vec![dir_uri(&self.workspace)?],
                Role::Agent => Vec::new(),
            },
        })
    }

    async fn connect(&self) -> Result<KitClient, String> {
        self.process
            .connect()
            .await
            .map_err(|error| format!("cannot connect: {error}"))
    }

    async fn pre_initialize(&self) -> Result<(), String> {
        let client = self.connect().await?;
        expect_reason(
            client
                .request(methods::Ping::NAME, json!({}), Some(NEGATIVE_TIMEOUT))
                .await,
            ErrorReason::NotInitialized,
        )
    }

    async fn protocol_version(&self) -> Result<(), String> {
        let client = self.connect().await?;
        let params =
            self.initialize_params(Role::Host, self.process.token(), PROTOCOL_VERSION + 98)?;
        expect_reason(
            client
                .call_with_timeout::<methods::Initialize>(&params, Some(NEGATIVE_TIMEOUT))
                .await,
            ErrorReason::UnsupportedProtocol,
        )
    }

    async fn wrong_token(&self) -> Result<(), String> {
        let client = self.connect().await?;
        let wrong = if self.process.token().starts_with('0') {
            "1".repeat(64)
        } else {
            "0".repeat(64)
        };
        let params = self.initialize_params(Role::Host, &wrong, PROTOCOL_VERSION)?;
        expect_reason(
            client
                .call_with_timeout::<methods::Initialize>(&params, Some(NEGATIVE_TIMEOUT))
                .await,
            ErrorReason::Unauthorized,
        )?;
        if client.wait_closed(NEGATIVE_TIMEOUT).await {
            Ok(())
        } else {
            Err("the connection stayed open after the unauthorized error".into())
        }
    }

    async fn agent_before_host(&self) -> Result<(), String> {
        let client = self.connect().await?;
        let params = self.initialize_params(Role::Agent, self.process.token(), PROTOCOL_VERSION)?;
        match client
            .call_with_timeout::<methods::Initialize>(&params, Some(NEGATIVE_TIMEOUT))
            .await
        {
            Err(ClientError::Rpc(_)) => Ok(()),
            Err(error) => Err(format!("expected an error response, got {error}")),
            Ok(_) => Err("the agent initialized before the host".into()),
        }
    }

    async fn initialize_host(&self) -> Result<(KitClient, InitializeResult), String> {
        let host = self.connect().await?;
        let params = self.initialize_params(Role::Host, self.process.token(), PROTOCOL_VERSION)?;
        let raw = host
            .request(
                methods::Initialize::NAME,
                serde_json::to_value(&params).map_err(|error| error.to_string())?,
                Some(kition_kit_protocol::launch::INITIALIZE_TIMEOUT),
            )
            .await
            .map_err(|error| error.to_string())?;
        self.schemas.protocol_def("initializeResult", &raw)?;
        let result: InitializeResult =
            serde_json::from_value(raw).map_err(|error| error.to_string())?;
        host.notify::<methods::Initialized>(&Empty {})
            .await
            .map_err(|error| error.to_string())?;
        if result.protocol_version != PROTOCOL_VERSION {
            return Err(format!("protocolVersion is {}", result.protocol_version));
        }
        if !result.capabilities.surfaces.contains(&Surface::Headless) {
            return Err("capabilities.surfaces does not include headless".into());
        }
        if let Some(manifest) = &self.manifest
            && (manifest.id != result.kit.id || manifest.version != result.kit.version)
        {
            return Err(format!(
                "the kit reports {} {}, but kit.json says {} {}",
                result.kit.id, result.kit.version, manifest.id, manifest.version
            ));
        }
        Ok((host, result))
    }

    async fn commands(&self, host: &KitClient) -> Result<Vec<CommandInfo>, String> {
        let raw = host
            .request(methods::CommandsList::NAME, json!({}), None)
            .await
            .map_err(|error| error.to_string())?;
        self.schemas.protocol_def("commandsListResult", &raw)?;
        let result: CommandsListResult =
            serde_json::from_value(raw).map_err(|error| error.to_string())?;
        let mut seen = std::collections::HashSet::new();
        let groups: Option<Vec<&str>> = self.manifest.as_ref().and_then(|manifest| {
            manifest.agent.as_ref().map(|agent| {
                agent
                    .tool_groups
                    .iter()
                    .map(|group| group.id.as_str())
                    .collect()
            })
        });
        for command in &result.commands {
            if !seen.insert(command.id.as_str()) {
                return Err(format!("command `{}` is listed twice", command.id));
            }
            schema::is_valid_schema(&command.params).map_err(|error| {
                format!(
                    "command `{}` has an invalid params schema: {error}",
                    command.id
                )
            })?;
            if let Some(groups) = &groups
                && !groups.contains(&command.group.as_str())
            {
                return Err(format!(
                    "command `{}` uses group `{}`, which kit.json does not declare",
                    command.id, command.group
                ));
            }
        }
        let fixture = &self.options.fixture;
        let Some(edit) = result
            .commands
            .iter()
            .find(|command| command.id == fixture.edit_command)
        else {
            return Err(format!(
                "the fixture command `{}` is not listed",
                fixture.edit_command
            ));
        };
        schema::validate(&edit.params, &Value::Object(fixture.edit_params.clone()))
            .map_err(|error| format!("the fixture params do not match `{}`: {error}", edit.id))?;
        Ok(result.commands)
    }

    fn write_fixture(&self, dir: &Path) -> Result<String, String> {
        let path = dir.join(&self.options.fixture.file_name);
        std::fs::write(&path, &self.options.fixture.contents).map_err(|error| error.to_string())?;
        file_uri(&path)
    }

    async fn open(&self, client: &KitClient, uri: &str) -> Result<DocumentState, String> {
        let raw = client
            .request(methods::DocumentOpen::NAME, json!({ "uri": uri }), None)
            .await
            .map_err(|error| format!("document.open: {error}"))?;
        self.schemas.protocol_def("documentState", &raw)?;
        serde_json::from_value(raw).map_err(|error| error.to_string())
    }

    async fn describe(
        &self,
        client: &KitClient,
        document_id: &str,
        supported: bool,
    ) -> Result<Option<Value>, String> {
        if !supported {
            return Ok(None);
        }
        let raw = client
            .request(
                methods::ViewDescribe::NAME,
                json!({ "documentId": document_id }),
                None,
            )
            .await
            .map_err(|error| format!("view.describe: {error}"))?;
        self.schemas.protocol_def("viewDescribeResult", &raw)?;
        Ok(Some(raw["state"].clone()))
    }

    async fn round_trip(
        &self,
        host: &KitClient,
        commands: &[CommandInfo],
        initialized: &InitializeResult,
    ) -> Result<(), String> {
        let fixture = &self.options.fixture;
        let uri = self.write_fixture(&self.workspace)?;
        let path = self.workspace.join(&fixture.file_name);
        let describes = initialized
            .capabilities
            .features
            .iter()
            .any(|feature| feature == "view.describe");

        let opened = self.open(host, &uri).await?;
        if opened.dirty {
            return Err("a freshly opened document is dirty".into());
        }
        let again = self.open(host, &uri).await?;
        if again.document_id != opened.document_id {
            return Err("opening the same URI twice returned a different documentId".into());
        }
        let mutates = commands
            .iter()
            .find(|command| command.id == fixture.edit_command)
            .is_some_and(|command| command.mutates);
        let executed = host
            .call::<methods::CommandsExecute>(&CommandsExecuteParams {
                document_id: opened.document_id.clone(),
                command: fixture.edit_command.clone(),
                params: fixture.edit_params.clone(),
                origin: Origin::Agent,
            })
            .await
            .map_err(|error| format!("commands.execute: {error}"))?;
        if mutates && !executed.changed {
            return Err(format!(
                "`{}` mutates but reported changed: false",
                fixture.edit_command
            ));
        }
        let listed = host
            .call::<methods::DocumentList>(&Empty {})
            .await
            .map_err(|error| format!("document.list: {error}"))?;
        let Some(edited) = listed
            .documents
            .iter()
            .find(|document| document.document_id == opened.document_id)
        else {
            return Err("document.list does not include the open document".into());
        };
        if executed.changed && !edited.dirty {
            return Err("the document is not dirty after a change".into());
        }
        let described = self.describe(host, &opened.document_id, describes).await?;

        let saved = host
            .call::<methods::DocumentSave>(&DocumentRef {
                document_id: opened.document_id.clone(),
            })
            .await
            .map_err(|error| format!("document.save: {error}"))?;
        if !saved.uri.starts_with("file://") {
            return Err(format!("document.save returned `{}`", saved.uri));
        }
        let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
        if executed.changed && bytes == fixture.contents {
            return Err("the saved file is identical to the fixture".into());
        }
        host.call::<methods::DocumentClose>(&DocumentCloseParams {
            document_id: opened.document_id.clone(),
            discard_changes: None,
        })
        .await
        .map_err(|error| format!("document.close after save: {error}"))?;

        let reopened = self.open(host, &uri).await?;
        if reopened.dirty {
            return Err("the reopened document is dirty".into());
        }
        let redescribed = self
            .describe(host, &reopened.document_id, describes)
            .await?;
        if described != redescribed {
            return Err("view.describe differs after saving and reopening".into());
        }
        expect_reason(
            host.call::<methods::DocumentSave>(&DocumentRef {
                document_id: "conformance-missing".into(),
            })
            .await,
            ErrorReason::DocumentNotFound,
        )?;
        host.call::<methods::DocumentClose>(&DocumentCloseParams {
            document_id: reopened.document_id,
            discard_changes: Some(true),
        })
        .await
        .map_err(|error| format!("document.close: {error}"))?;
        Ok(())
    }

    async fn agent_limits(&self) -> Result<(), String> {
        let agent = self.connect().await?;
        let params = self.initialize_params(Role::Agent, self.process.token(), PROTOCOL_VERSION)?;
        agent
            .initialize(&params)
            .await
            .map_err(|error| format!("agent kit.initialize: {error}"))?;
        expect_reason(
            agent
                .call::<methods::SurfaceSetVisible>(&SurfaceSetVisibleParams { visible: false })
                .await,
            ErrorReason::RoleForbidden,
        )
        .map_err(|error| format!("surface.setVisible: {error}"))?;
        expect_reason(
            agent.call::<methods::Shutdown>(&Empty {}).await,
            ErrorReason::RoleForbidden,
        )
        .map_err(|error| format!("kit.shutdown: {error}"))?;

        let outside = self.write_fixture(&self.outside)?;
        expect_reason(
            agent
                .request(methods::DocumentOpen::NAME, json!({ "uri": outside }), None)
                .await,
            ErrorReason::UriNotGranted,
        )
        .map_err(|error| format!("document.open outside the workspace: {error}"))?;

        let inside = self.write_fixture(&self.workspace)?;
        let opened = self.open(&agent, &inside).await?;
        agent
            .call::<methods::DocumentClose>(&DocumentCloseParams {
                document_id: opened.document_id,
                discard_changes: Some(true),
            })
            .await
            .map_err(|error| format!("document.close: {error}"))?;
        Ok(())
    }

    async fn screenshot(&self, host: &KitClient) -> Result<(), String> {
        let uri = self.write_fixture(&self.workspace)?;
        let opened = self.open(host, &uri).await?;
        let raw = host
            .request(
                methods::ViewScreenshot::NAME,
                json!({ "documentId": opened.document_id, "scope": "canvas", "maxSize": SCREENSHOT_MAX_SIZE }),
                None,
            )
            .await
            .map_err(|error| format!("view.screenshot: {error}"))?;
        self.schemas.protocol_def("image", &raw)?;
        let image: Image = serde_json::from_value(raw).map_err(|error| error.to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&image.data)
            .map_err(|error| format!("image data is not base64: {error}"))?;
        let (width, height) = png_size(&bytes).ok_or("image data is not a PNG")?;
        if (width, height) != (image.width, image.height) {
            return Err(format!(
                "the PNG is {width}x{height}, but the result says {}x{}",
                image.width, image.height
            ));
        }
        if width.max(height) > SCREENSHOT_MAX_SIZE {
            return Err(format!(
                "the PNG is {width}x{height}, larger than maxSize {SCREENSHOT_MAX_SIZE}"
            ));
        }
        host.call::<methods::DocumentClose>(&DocumentCloseParams {
            document_id: opened.document_id,
            discard_changes: Some(true),
        })
        .await
        .map_err(|error| format!("document.close: {error}"))?;
        Ok(())
    }

    async fn shutdown(&mut self, host: &KitClient) -> Result<(), String> {
        let replied = host.call::<methods::Shutdown>(&Empty {}).await;
        let exited = self.process.wait_for_exit(SHUTDOWN_TIMEOUT).await;
        if exited.is_none() {
            self.process.kill().await;
            return Err("the kit was still running 5 seconds after kit.shutdown".into());
        }
        match replied {
            Ok(Empty {}) => Ok(()),
            Err(error) => Err(format!("kit.shutdown did not return {{}}: {error}")),
        }
    }
}

/// Reads the width and height from a PNG's IHDR chunk.
fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[..8] != SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_png_dimensions() {
        let pixel = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(png_size(&pixel), Some((1, 1)));
        assert_eq!(png_size(b"GIF89a"), None);
    }

    #[test]
    fn check_ids_are_unique() {
        let mut ids: Vec<_> = CHECKS.iter().map(|(id, _)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), CHECKS.len());
    }
}
