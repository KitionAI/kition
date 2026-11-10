// Copied from kition-sdk crates/kition-kit-host/src/process.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Launching a kit executable (protocol section 3).

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use kition_kit_protocol::PROTOCOL_VERSION;
use kition_kit_protocol::launch::{ENV_ENDPOINT, ENV_PROTOCOL, ENV_SURFACE, ENV_TOKEN, INITIALIZE_TIMEOUT, LAUNCH_ARG, READY_TIMEOUT, ReadyLine, Surface};
use kition_kit_protocol::transport;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, ChildStdout, Command};

use crate::client::KitClient;
use crate::endpoint::Endpoint;
use crate::new_token;

/// Where a kit's standard error goes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum KitStderr {
    /// Each line logged with `tracing` at debug level, target `kition_kit`.
    #[default]
    Log,
    /// The host's own standard error.
    Inherit,
}

#[derive(Clone, Debug)]
pub struct LaunchOptions {
    pub executable: PathBuf,
    /// Extra environment variables, for example kit-specific diagnostics.
    pub env: Vec<(OsString, OsString)>,
    pub ready_timeout: Duration,
    /// The folder whose files [`crate::HeadlessKit`] serves the kit (`files.*`); `None` serves
    /// none, so the kit can open no file.
    pub workspace: Option<PathBuf>,
    /// How long [`crate::HeadlessKit::launch`] waits for `kit.initialize`.
    pub initialize_timeout: Duration,
    /// Where the private endpoint directory is made, created when missing; the system's
    /// temporary directory by default. Unix socket paths are limited to about 100 bytes, so keep
    /// it short.
    pub socket_dir: Option<PathBuf>,
    /// Best effort, Unix only: the kit's virtual memory limit, set with the shell's `ulimit -v`
    /// before the kit starts (Linux honours it; a system that refuses it starts the kit without).
    pub memory_limit_bytes: Option<u64>,
    pub stderr: KitStderr,
}

impl LaunchOptions {
    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            env: Vec::new(),
            ready_timeout: READY_TIMEOUT,
            workspace: None,
            initialize_timeout: INITIALIZE_TIMEOUT,
            socket_dir: None,
            memory_limit_bytes: None,
            stderr: KitStderr::Log,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    #[error("could not create the kit endpoint: {0}")]
    Endpoint(std::io::Error),
    #[error("could not start the kit: {0}")]
    Spawn(std::io::Error),
    #[error("the kit did not report ready within {0:?}")]
    ReadyTimeout(Duration),
    #[error("the kit exited before reporting ready")]
    ExitedBeforeReady,
    #[error("the kit's first output line is not a ready line")]
    InvalidReadyLine,
    #[error("the kit speaks protocol version {0}, expected {PROTOCOL_VERSION}")]
    UnsupportedProtocol(u32),
}

/// A running kit process that has reported ready.
#[derive(Debug)]
pub struct KitProcess {
    child: Child,
    endpoint: Endpoint,
    token: String,
    stdout_after_ready: Arc<AtomicBool>,
    stdout_watch: Option<tokio::task::JoinHandle<()>>,
}

impl KitProcess {
    /// Starts the kit and waits for its ready line.
    pub async fn launch(options: LaunchOptions) -> Result<Self, LaunchError> {
        let endpoint = match &options.socket_dir {
            Some(dir) => Endpoint::create_in(dir),
            None => Endpoint::create(),
        }
        .map_err(LaunchError::Endpoint)?;
        let token = new_token();
        let mut command = command(&options);
        command
            .arg(LAUNCH_ARG)
            .env(ENV_PROTOCOL, PROTOCOL_VERSION.to_string())
            .env(ENV_ENDPOINT, endpoint.address())
            .env(ENV_TOKEN, &token)
            .env(ENV_SURFACE, Surface::Headless.as_env())
            .envs(options.env.iter().map(|(key, value)| (key, value)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(match options.stderr {
                KitStderr::Log => Stdio::piped(),
                KitStderr::Inherit => Stdio::inherit(),
            })
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(LaunchError::Spawn)?;

        if let Some(stderr) = child.stderr.take() {
            let executable = options.executable.display().to_string();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "kition_kit", kit = %executable, "{line}");
                }
            });
        }

        let Some(stdout) = child.stdout.take() else {
            return Err(LaunchError::ExitedBeforeReady);
        };
        let mut stdout = BufReader::new(stdout);
        let ready = tokio::time::timeout(options.ready_timeout, read_ready_line(&mut stdout)).await;
        let ready = match ready {
            Err(_) => return Err(LaunchError::ReadyTimeout(options.ready_timeout)),
            Ok(ready) => ready?,
        };
        if ready.protocol_version != PROTOCOL_VERSION {
            return Err(LaunchError::UnsupportedProtocol(ready.protocol_version));
        }

        let stdout_after_ready = Arc::new(AtomicBool::new(false));
        let stdout_watch = tokio::spawn(watch_stdout(stdout, Arc::clone(&stdout_after_ready)));

        Ok(Self { child, endpoint, token, stdout_after_ready, stdout_watch: Some(stdout_watch) })
    }

    /// The launch token clients send in `kit.initialize`.
    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn endpoint(&self) -> &str {
        self.endpoint.address()
    }

    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    /// Opens a new, uninitialized connection to the kit.
    pub async fn connect(&self) -> std::io::Result<KitClient> {
        self.connect_serving(None).await
    }

    /// [`KitProcess::connect`] for the host connection, which answers the kit's requests with
    /// `service` (its `files.*`, section 5.1).
    pub async fn connect_serving(&self, service: Option<Arc<dyn crate::kit_files::HostService>>) -> std::io::Result<KitClient> {
        let (reader, writer) = transport::connect(self.endpoint.address()).await?;
        Ok(KitClient::serving(reader, writer, service))
    }

    /// Whether the kit wrote to standard output after its ready line, which
    /// the protocol forbids.
    pub fn wrote_stdout_after_ready(&self) -> bool {
        self.stdout_after_ready.load(Ordering::SeqCst)
    }

    /// Waits until the kit's standard output closes, up to `limit`, so that
    /// [`Self::wrote_stdout_after_ready`] is final. Returns whether it closed.
    pub async fn wait_stdout_closed(&mut self, limit: Duration) -> bool {
        match self.stdout_watch.take() {
            None => true,
            Some(handle) => tokio::time::timeout(limit, handle).await.is_ok(),
        }
    }

    /// Waits for the process to exit, up to `limit`.
    pub async fn wait_for_exit(&mut self, limit: Duration) -> Option<ExitStatus> {
        tokio::time::timeout(limit, self.child.wait()).await.ok()?.ok()
    }

    pub fn try_exit_status(&mut self) -> Option<ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// Whether the process has exited (and is reaped), or can no longer be waited for.
    pub fn has_exited(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }

    /// Terminates the process and reaps it.
    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}

/// The kit executable, or with a memory limit the shell that sets it and then runs the kit.
fn command(options: &LaunchOptions) -> Command {
    #[cfg(unix)]
    if let Some(bytes) = options.memory_limit_bytes {
        // `ulimit -v` takes KiB; a system that refuses the limit still runs the kit.
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(format!("ulimit -v {} 2>/dev/null; exec \"$0\" \"$@\"", (bytes / 1024).max(1))).arg(&options.executable);
        return command;
    }
    Command::new(&options.executable)
}

async fn read_ready_line(stdout: &mut BufReader<ChildStdout>) -> Result<ReadyLine, LaunchError> {
    let mut line = String::new();
    match stdout.read_line(&mut line).await {
        Ok(0) | Err(_) => Err(LaunchError::ExitedBeforeReady),
        Ok(_) => ReadyLine::parse(&line).ok_or(LaunchError::InvalidReadyLine),
    }
}

async fn watch_stdout(mut stdout: BufReader<ChildStdout>, flag: Arc<AtomicBool>) {
    let mut buffer = [0u8; 1024];
    while let Ok(read) = stdout.read(&mut buffer).await {
        if read == 0 {
            return;
        }
        if !flag.swap(true, Ordering::SeqCst) {
            tracing::warn!(target: "kition_kit", "kit wrote to standard output after its ready line");
        }
    }
}
