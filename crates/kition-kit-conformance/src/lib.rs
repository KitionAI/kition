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

/// The DeepSeek Harness release a conformance report targets (Kit Standard D4): the one Kition's
/// harness follows (`kition_harness::DSH_TARGET`) and `@kition/dsh-kits` is pinned to.
pub const DSH_TARGET: &str = kition_harness::DSH_TARGET;
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
    /// The conformance levels a Kition Kit Standard manifest supports (`L1` to `L5`; Kit Standard
    /// `spec/kits/levels.md`), with what the others
    /// need. Empty without such a manifest.
    pub levels: Vec<&'static str>,
    pub level_notes: Vec<String>,
}

/// Whether `@kition/dsh-kits` registers the kit's tools in DeepSeek Harness (Kit Standard D1). The
/// package mounts Kition's MCP server (`kition-kits-mcp`, `POST /v1/mcp/kits`), which serves the
/// tools of every kit Kition knows, so a kit is registered when Kition's kit list has its id with
/// the manifest's agent prefix. Answers the tools' name pattern, or why it is not registered.
fn dsh_registration(manifest: &Value) -> Result<String, String> {
    let id = manifest["id"].as_str().unwrap_or_default();
    let prefix = manifest["agent"]["prefix"].as_str().unwrap_or_default();
    let known = kition_kits::KITS
        .iter()
        .find(|kit| kit.id == id)
        .ok_or_else(|| {
            format!(
                "Kition's kit list (kition_kits::KITS), which kition-kits-mcp serves, has no `{id}`"
            )
        })?;
    if known.agent.prefix != prefix {
        return Err(format!(
            "Kition serves `{id}` with the agent prefix `{}`, the manifest says `{prefix}`",
            known.agent.prefix
        ));
    }
    Ok(format!("mcp__kition__{prefix}_*"))
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
        if !self.levels.is_empty() {
            let levels = if self.passed() {
                self.levels.join(" ")
            } else {
                "none (a check failed)".to_owned()
            };
            out.push_str(&format!("Levels: {levels}"));
            if !self.level_notes.is_empty() {
                out.push_str(&format!(" ({})", self.level_notes.join("; ")));
            }
            out.push('\n');
            out.push_str(&format!("DeepSeek Harness target: {DSH_TARGET}\n"));
        }
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
    manifest: Option<ManifestFacts>,
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
                report.levels.clone_from(&manifest.levels.0);
                report.level_notes.clone_from(&manifest.levels.1);
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

/// What the suite checks the running kit against, from either kind of `kit.json`.
struct ManifestFacts {
    id: String,
    version: String,
    /// The tool groups commands must belong to, when the manifest declares them.
    tool_groups: Option<Vec<String>>,
    /// A Kition Kit Standard manifest's levels and notes ([`standard_levels`]).
    levels: (Vec<&'static str>, Vec<String>),
    /// A Kition Kit Standard manifest's `headless.features`, which must be exactly what the
    /// executable's `kit.initialize` answers (Kit Standard K9).
    headless_features: Option<Vec<String>>,
}

/// What differs between a manifest's `headless.features` and the features `kit.initialize`
/// answered (Kit Standard K9), as one message; `None` when they are the same set.
fn feature_mismatch(declared: &[String], answered: &[String]) -> Option<String> {
    let missing: Vec<&str> = answered
        .iter()
        .filter(|feature| !declared.contains(feature))
        .map(String::as_str)
        .collect();
    let extra: Vec<&str> = declared
        .iter()
        .filter(|feature| !answered.contains(feature))
        .map(String::as_str)
        .collect();
    if missing.is_empty() && extra.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    if !missing.is_empty() {
        parts.push(format!("missing from kit.json: {}", missing.join(", ")));
    }
    if !extra.is_empty() {
        parts.push(format!("not answered by the kit: {}", extra.join(", ")));
    }
    Some(format!(
        "kit.json `headless.features` must list exactly what kit.initialize answers ({}); the kit answers [{}]",
        parts.join("; "),
        answered.join(", ")
    ))
}

/// The conformance levels a valid Kition Kit Standard manifest supports, as far as the manifest
/// and this suite show them, and what the others need. L5 needs engine contract 2 under standard
/// 2.x with a KDM schema and an object model namespace; L6 the kit's convergence suite
/// (`kition-convergence`), which `tools/check-manifest.mjs --convergence` reads.
fn standard_levels(manifest: &Value) -> (Vec<&'static str>, Vec<String>) {
    let mut levels = vec!["L1"];
    let mut notes = Vec::new();
    let has = |key: &str| manifest.get(key).is_some_and(|value| !value.is_null());
    let creates = manifest["creates"]
        .as_array()
        .is_some_and(|items| !items.is_empty());
    if has("ui") && creates {
        levels.push("L2");
        if has("agent") {
            levels.push("L3");
            match dsh_registration(manifest) {
                Ok(tools) => {
                    levels.push("L4");
                    notes.push(format!(
                        "L4 through @kition/dsh-kits as {tools}, DeepSeek Harness {DSH_TARGET}"
                    ));
                }
                Err(reason) => notes.push(format!(
                    "L4 needs registration in @kition/dsh-kits: {reason}"
                )),
            }
        } else {
            notes.push("L3 needs agent".to_owned());
        }
    } else {
        notes.push("L2 needs ui and creates".to_owned());
    }
    let major = manifest["standard"]
        .as_str()
        .and_then(|standard| standard.split('.').next())
        .and_then(|major| major.parse::<u32>().ok())
        .unwrap_or(1);
    if major >= 2 && manifest["engine"]["contract"] == 2 && has("model") && has("objectModel") {
        levels.push("L5");
        notes.push("L6 needs the kit's convergence suite (kition-convergence)".to_owned());
    } else {
        notes.push(
            "L5 needs standard 2.x: engine contract 2, a KDM schema, and an object model namespace"
                .to_owned(),
        );
    }
    (levels, notes)
}

/// The protocol a Kition Kit Standard manifest's `headless` section must name.
const STANDARD_HEADLESS_PROTOCOL: &str = "kition-kit/1";

fn check_manifest(schemas: &Schemas, path: &Path) -> Result<ManifestFacts, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let value: Value =
        serde_json::from_str(&text).map_err(|error| format!("kit.json is not JSON: {error}"))?;
    // A Kition Kit Standard manifest (Kit Standard `spec/kits/manifest.md`): its `headless`
    // section names the executable under test and the protocol it speaks.
    if value.get("standard").is_some() {
        schemas.standard(&value)?;
        let protocol = value["headless"]["protocol"].as_str();
        if protocol != Some(STANDARD_HEADLESS_PROTOCOL) {
            return Err(format!(
                "kit.json `headless.protocol` is {}, expected {STANDARD_HEADLESS_PROTOCOL}",
                protocol.unwrap_or("missing")
            ));
        }
        let text = |key: &str| value[key].as_str().unwrap_or_default().to_owned();
        return Ok(ManifestFacts {
            id: text("id"),
            version: text("version"),
            tool_groups: None,
            levels: standard_levels(&value),
            headless_features: Some(
                value["headless"]["features"]
                    .as_array()
                    .map(|features| {
                        features
                            .iter()
                            .filter_map(|feature| feature.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
            ),
        });
    }
    schemas.manifest(&value)?;
    let manifest: KitManifest = serde_json::from_value(value).map_err(|error| error.to_string())?;
    if manifest.kit_protocol != PROTOCOL_VERSION {
        return Err(format!(
            "kitProtocol is {}, expected {PROTOCOL_VERSION}",
            manifest.kit_protocol
        ));
    }
    Ok(ManifestFacts {
        tool_groups: manifest.agent.as_ref().map(|agent| {
            agent
                .tool_groups
                .iter()
                .map(|group| group.id.clone())
                .collect()
        }),
        id: manifest.id,
        version: manifest.version,
        levels: (Vec::new(), Vec::new()),
        headless_features: None,
    })
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
        if let Some(declared) = self
            .manifest
            .as_ref()
            .and_then(|manifest| manifest.headless_features.as_deref())
            && let Some(mismatch) = feature_mismatch(declared, &result.capabilities.features)
        {
            return Err(mismatch);
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
            manifest
                .tool_groups
                .as_ref()
                .map(|groups| groups.iter().map(String::as_str).collect())
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
            return Err(format!(
                "view.describe differs after saving and reopening (state keys: {}); list session-only keys as volatile in the kit's headless executable",
                differing_keys(described.as_ref(), redescribed.as_ref()).join(", ")
            ));
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

/// The top-level keys whose values differ between two `view.describe` states.
fn differing_keys(before: Option<&Value>, after: Option<&Value>) -> Vec<String> {
    let empty = Map::new();
    let before = before.and_then(Value::as_object).unwrap_or(&empty);
    let after = after.and_then(Value::as_object).unwrap_or(&empty);
    let mut keys: Vec<String> = before
        .keys()
        .chain(after.keys())
        .filter(|key| before.get(*key) != after.get(*key))
        .cloned()
        .collect();
    keys.sort_unstable();
    keys.dedup();
    keys
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
    fn requires_the_manifest_to_list_exactly_the_features_the_kit_answers() {
        let owned = |list: &[&str]| {
            list.iter()
                .map(|feature| (*feature).to_owned())
                .collect::<Vec<_>>()
        };
        let answered = owned(&[
            "view.describe",
            "document.check",
            "model.describe",
            "model.batch",
        ]);
        assert_eq!(
            feature_mismatch(
                &owned(&[
                    "model.batch",
                    "document.check",
                    "view.describe",
                    "model.describe"
                ]),
                &answered
            ),
            None,
            "the order does not matter"
        );
        let mismatch = feature_mismatch(
            &owned(&["model.describe", "model.batch", "model.open"]),
            &answered,
        )
        .unwrap_or_else(|| panic!("a mismatch"));
        assert!(
            mismatch.contains("missing from kit.json: view.describe, document.check"),
            "{mismatch}"
        );
        assert!(
            mismatch.contains("not answered by the kit: model.open"),
            "{mismatch}"
        );
        assert!(
            mismatch.contains("K9") || mismatch.contains("kit.initialize"),
            "{mismatch}"
        );
    }

    #[test]
    fn names_the_describe_keys_that_differ() {
        let before = json!({ "slides": 2, "selectedKinds": ["shape"], "title": "a" });
        let after = json!({ "slides": 2, "selectedKinds": [], "zoom": 1 });
        assert_eq!(
            differing_keys(Some(&before), Some(&after)),
            ["selectedKinds", "title", "zoom"]
        );
    }

    #[test]
    fn accepts_a_standard_manifest_with_an_embedded_editor() {
        let schemas = Schemas::load().unwrap_or_else(|err| panic!("{err}"));
        let mut manifest = json!({
            "standard": "1.1",
            "id": "kit.example",
            "name": "Example",
            "version": "0.1.0",
            "license": "Apache-2.0",
            "engine": { "module": "kition_example_sdk", "class": "ExampleDocument", "contract": 1 },
            "formats": [{ "id": "example", "extensions": ["example"], "role": "edit" }],
            "ui": { "mode": "embedded", "entry": "ui/index.html", "layout": "canvas" }
        });
        schemas
            .standard(&manifest)
            .unwrap_or_else(|err| panic!("{err}"));
        manifest["ui"].as_object_mut().map(|ui| ui.remove("entry"));
        assert!(
            schemas.standard(&manifest).is_err(),
            "an embedded editor needs an entry"
        );
    }

    #[test]
    fn reports_the_levels_of_a_standard_manifest() {
        let mut manifest = json!({
            "standard": "2.0",
            "engine": { "contract": 2 },
            "ui": { "mode": "embedded" },
            "creates": [{ "id": "doc" }],
            "agent": { "prefix": "doc", "tools": "document" },
            "model": { "schema": "model/schema.json", "schemaVersion": 1 },
            "objectModel": { "namespace": "Doc" }
        });
        let (levels, notes) = standard_levels(&manifest);
        assert_eq!(levels, ["L1", "L2", "L3", "L5"]);
        assert!(notes.iter().any(|note| note.starts_with("L6")));
        assert!(
            notes
                .iter()
                .any(|note| note.starts_with("L4 needs registration") && note.contains("no ``")),
            "{notes:?}"
        );
        manifest["standard"] = json!("1.1");
        manifest["engine"]["contract"] = json!(1);
        assert_eq!(standard_levels(&manifest).0, ["L1", "L2", "L3"]);
    }

    #[test]
    fn a_kit_kition_serves_over_mcp_reaches_l4_against_the_pinned_harness() {
        let mut manifest = json!({
            "id": "kit.slide",
            "standard": "2.0",
            "engine": { "contract": 2 },
            "ui": { "mode": "embedded" },
            "creates": [{ "id": "deck" }],
            "agent": { "prefix": "slide", "tools": "document" },
            "model": { "schema": "model/schema.json", "schemaVersion": 1 },
            "objectModel": { "namespace": "Slides" }
        });
        let (levels, notes) = standard_levels(&manifest);
        assert_eq!(levels, ["L1", "L2", "L3", "L4", "L5"]);
        assert!(
            notes
                .iter()
                .any(|note| note.contains("mcp__kition__slide_*") && note.contains(DSH_TARGET)),
            "{notes:?}"
        );
        manifest["agent"]["prefix"] = json!("deck");
        let (levels, notes) = standard_levels(&manifest);
        assert!(!levels.contains(&"L4"));
        assert!(
            notes.iter().any(|note| note.contains("`slide`")),
            "{notes:?}"
        );
        let report = Report {
            checks: vec![CheckResult {
                id: "manifest",
                title: "t",
                outcome: Outcome::Passed,
            }],
            levels,
            level_notes: notes,
        };
        assert!(
            report
                .render()
                .contains(&format!("DeepSeek Harness target: {DSH_TARGET}"))
        );
    }

    /// `@kition/dsh-kits` (kition-sdk) pins the same release, when its checkout is beside this one.
    #[test]
    fn dsh_kits_pins_the_same_release() {
        let package = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../kition-sdk/packages/dsh-kits/package.json");
        let Ok(text) = std::fs::read_to_string(&package) else {
            eprintln!("skipped: no kition-sdk checkout beside this repository");
            return;
        };
        let package: Value = serde_json::from_str(&text).unwrap_or_else(|err| panic!("{err}"));
        let pinned = &package["dsh"];
        assert_eq!(
            format!(
                "{} ({})",
                pinned["target"].as_str().unwrap_or_default(),
                pinned["commit"].as_str().unwrap_or_default()
            ),
            DSH_TARGET,
            "@kition/dsh-kits `dsh` pin: {pinned}"
        );
    }

    #[test]
    fn check_ids_are_unique() {
        let mut ids: Vec<_> = CHECKS.iter().map(|(id, _)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), CHECKS.len());
    }
}
