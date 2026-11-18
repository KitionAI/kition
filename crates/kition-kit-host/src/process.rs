// Copied from kition-sdk crates/kition-kit-host/src/process.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Launching a kit executable (protocol section 3).

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use kition_kit_process_protocol::PROTOCOL_VERSION;
use kition_kit_process_protocol::launch::{
    ENV_ENDPOINT, ENV_PROTOCOL, ENV_SURFACE, ENV_TOKEN, INITIALIZE_TIMEOUT, LAUNCH_ARG, READY_TIMEOUT, ReadyLine, Surface,
};
use kition_kit_process_protocol::transport;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, ChildStdout, Command};

use crate::client::KitClient;
use crate::endpoint::Endpoint;
use crate::kit_home::{KitHome, environment};
use crate::new_token;
use crate::sandbox::Sandbox;

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
    /// Extra environment variables, for example kit-specific diagnostics: set after the
    /// [`crate::kit_home`] environment, so they pass whatever their names.
    pub env: Vec<(OsString, OsString)>,
    pub ready_timeout: Duration,
    /// The folder whose files [`crate::HeadlessKit`] serves the kit (`files.*`); `None` serves
    /// none, so the kit can open no file. A launch refuses a private folder inside it (KHP A58).
    pub workspace: Option<PathBuf>,
    /// How long [`crate::HeadlessKit::launch`] waits for `kit.initialize`.
    pub initialize_timeout: Duration,
    /// Where the private endpoint directory is made, created when missing; the system's
    /// temporary directory by default. Unix socket paths are limited to about 100 bytes, so keep
    /// it short.
    pub socket_dir: Option<PathBuf>,
    /// Linux: a mandatory address-space resource limit before exec, plus resident monitoring.
    /// macOS: resident monitoring every 250 ms. Other platforms refuse this option.
    pub memory_limit_bytes: Option<u64>,
    pub stderr: KitStderr,
    /// Where the kit's private folder is made (its current folder, `HOME`, `TMPDIR`,
    /// [`crate::kit_home`]); [`KitHome::default_base`] by default, which goes with the last
    /// private folder in it.
    pub private_base: Option<PathBuf>,
    /// Run the kit under the platform's sandbox ([`crate::sandbox`]); `None` runs it without. A
    /// platform without one refuses the launch ([`LaunchError::Sandbox`]), never runs the kit
    /// unconfined.
    pub sandbox: Option<Sandbox>,
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
            private_base: None,
            sandbox: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    #[error("could not create the kit endpoint: {0}")]
    Endpoint(std::io::Error),
    #[error("could not create the kit's private folder: {0}")]
    PrivateFolder(std::io::Error),
    /// The kit was to run sandboxed, and the sandbox cannot be set up here.
    #[error("could not start the kit sandboxed: {0}")]
    Sandbox(String),
    #[error("could not enforce the kit memory limit: {0}")]
    MemoryLimit(String),
    #[error("the kit exceeded its memory ceiling before reporting ready")]
    MemoryExceeded,
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
    child: Arc<Mutex<Child>>,
    /// Removed after the process is killed (fields drop in order).
    home: KitHome,
    endpoint: Endpoint,
    token: String,
    stdout_after_ready: Arc<AtomicBool>,
    stdout_watch: Option<tokio::task::JoinHandle<()>>,
    memory_exceeded: Arc<AtomicBool>,
    memory_failed: Arc<AtomicBool>,
    memory_watch: Option<MemoryWatch>,
}

#[derive(Debug)]
struct MemoryWatch {
    task: tokio::task::JoinHandle<()>,
    child: std::sync::Weak<Mutex<Child>>,
}

impl Drop for MemoryWatch {
    fn drop(&mut self) {
        self.task.abort();
        if let Some(child) = self.child.upgrade() {
            let _ = child.lock().unwrap_or_else(PoisonError::into_inner).start_kill();
        }
    }
}

impl KitProcess {
    /// Starts the kit and waits for its ready line.
    pub async fn launch(options: LaunchOptions) -> Result<Self, LaunchError> {
        if let Some(bytes) = options.memory_limit_bytes {
            crate::memory::check(bytes).map_err(LaunchError::MemoryLimit)?;
        }
        let socket_dir = options.socket_dir.clone().unwrap_or_else(std::env::temp_dir);
        // A sandbox names folders by their real paths (`/var` is `/private/var` on macOS), and the
        // kit binds its socket at the address it is given: give it the real one.
        let socket_dir = if options.sandbox.is_some() { std::fs::canonicalize(&socket_dir).unwrap_or(socket_dir) } else { socket_dir };
        let endpoint = Endpoint::create_in(&socket_dir).map_err(LaunchError::Endpoint)?;
        let home = match &options.private_base {
            Some(base) => KitHome::create(base),
            None => KitHome::create_default(),
        }
        .map_err(LaunchError::PrivateFolder)?;
        // The private runtime folder lies outside the workspace (KHP A58, A29).
        if let Some(workspace) = &options.workspace {
            let workspace = std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.clone());
            if home.root().starts_with(&workspace) {
                let (private, workspace) = (home.root().display(), workspace.display());
                let detail = format!("{private} is inside the workspace {workspace}: give LaunchOptions::private_base outside it (KHP A58)");
                return Err(LaunchError::PrivateFolder(std::io::Error::other(detail)));
            }
        }
        // Never the host's folders or variables (section 3): a private, empty current folder,
        // home and private runtime folder; the variables kits read; a fixed locale and time zone.
        let environment = environment(std::env::vars_os(), &home);
        let plan = match &options.sandbox {
            None => None,
            Some(sandbox) => {
                let paths = crate::sandbox::paths(sandbox, &options, &home, &endpoint, &environment);
                Some(crate::sandbox::plan(&paths).map_err(LaunchError::Sandbox)?)
            }
        };
        let token = new_token();
        let mut command = command(&options, plan.as_ref().map_or(&[][..], |plan| plan.wrapper.as_slice()));
        command
            .current_dir(home.work())
            .env_clear()
            .envs(environment)
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
        let mut child = match plan {
            Some(plan) => crate::sandbox::spawn(command, plan).await?,
            None => spawn_written(&mut command).await.map_err(LaunchError::Spawn)?,
        };

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
        let child = Arc::new(Mutex::new(child));
        let memory_exceeded = Arc::new(AtomicBool::new(false));
        let memory_failed = Arc::new(AtomicBool::new(false));
        let memory_watch = options.memory_limit_bytes.map(|limit| {
            let weak = Arc::downgrade(&child);
            let watched = weak.clone();
            let exceeded = Arc::clone(&memory_exceeded);
            let failed = Arc::clone(&memory_failed);
            let task = tokio::spawn(async move {
                loop {
                    let Some(child) = watched.upgrade() else { break };
                    let pid = {
                        let mut child = child.lock().unwrap_or_else(PoisonError::into_inner);
                        if !matches!(child.try_wait(), Ok(None)) {
                            break;
                        }
                        child.id()
                    };
                    let Some(pid) = pid else { break };
                    let sample = crate::memory::resident(pid).await;
                    let stop = match sample {
                        Ok(Some(bytes)) if crate::memory::exceeded(bytes, limit) => Some(true),
                        Ok(None) | Err(_) => Some(false),
                        Ok(Some(_)) => None,
                    };
                    if let Some(over) = stop {
                        let mut child = child.lock().unwrap_or_else(PoisonError::into_inner);
                        if matches!(child.try_wait(), Ok(None)) {
                            // A live process whose usage cannot be sampled must not run unlimited.
                            if over {
                                exceeded.store(true, Ordering::SeqCst);
                            } else {
                                failed.store(true, Ordering::SeqCst);
                            }
                            let _ = child.start_kill();
                        }
                        break;
                    }
                    drop(child);
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            });
            MemoryWatch { task, child: weak }
        });
        let mut stdout = BufReader::new(stdout);
        let ready = tokio::time::timeout(options.ready_timeout, read_ready_line(&mut stdout)).await;
        if memory_exceeded.load(Ordering::SeqCst) {
            return Err(LaunchError::MemoryExceeded);
        }
        if memory_failed.load(Ordering::SeqCst) {
            return Err(LaunchError::MemoryLimit("the process could not be monitored before ready".into()));
        }
        let ready = match ready {
            Err(_) => return Err(LaunchError::ReadyTimeout(options.ready_timeout)),
            Ok(Err(LaunchError::ExitedBeforeReady))
                if options.memory_limit_bytes.is_some()
                    && cfg!(target_os = "linux")
                    && child.lock().unwrap_or_else(PoisonError::into_inner).try_wait().ok().flatten().is_some_and(|status| status.code() == Some(125)) =>
            {
                return Err(LaunchError::MemoryLimit("Linux refused to install the address-space limit".into()));
            }
            Ok(ready) => ready?,
        };
        if ready.protocol_version != PROTOCOL_VERSION {
            return Err(LaunchError::UnsupportedProtocol(ready.protocol_version));
        }

        let stdout_after_ready = Arc::new(AtomicBool::new(false));
        let stdout_watch = tokio::spawn(watch_stdout(stdout, Arc::clone(&stdout_after_ready)));

        Ok(Self { child, home, endpoint, token, stdout_after_ready, stdout_watch: Some(stdout_watch), memory_exceeded, memory_failed, memory_watch })
    }

    /// The launch token clients send in `kit.initialize`.
    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn endpoint(&self) -> &str {
        self.endpoint.address()
    }

    /// The kit's private folder: `work/` (its current folder), `home/`, `tmp/`
    /// ([`crate::kit_home`]). Removed when this is dropped.
    pub fn private_dir(&self) -> &std::path::Path {
        self.home.root()
    }

    pub fn id(&self) -> Option<u32> {
        self.child.lock().unwrap_or_else(PoisonError::into_inner).id()
    }

    pub fn memory_exceeded(&self) -> bool {
        self.memory_exceeded.load(Ordering::SeqCst)
    }

    pub fn memory_monitor_failed(&self) -> bool {
        self.memory_failed.load(Ordering::SeqCst)
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
        tokio::time::timeout(limit, async {
            loop {
                let status = self.child.lock().unwrap_or_else(PoisonError::into_inner).try_wait();
                match status {
                    Ok(Some(status)) => return Some(status),
                    Err(_) => return None,
                    Ok(None) => tokio::time::sleep(Duration::from_millis(10)).await,
                }
            }
        })
        .await
        .ok()
        .flatten()
    }

    pub fn try_exit_status(&mut self) -> Option<ExitStatus> {
        self.child.lock().unwrap_or_else(PoisonError::into_inner).try_wait().ok().flatten()
    }

    /// Whether the process has exited (and is reaped), or can no longer be waited for.
    pub fn has_exited(&mut self) -> bool {
        !matches!(self.child.lock().unwrap_or_else(PoisonError::into_inner).try_wait(), Ok(None))
    }

    /// Terminates the process and reaps it.
    pub async fn kill(&mut self) {
        self.memory_watch.take();
        let _ = self.child.lock().unwrap_or_else(PoisonError::into_inner).start_kill();
        let _ = self.wait_for_exit(Duration::from_secs(5)).await;
    }
}

impl Drop for KitProcess {
    fn drop(&mut self) {
        self.memory_watch.take();
        let _ = self.child.lock().unwrap_or_else(PoisonError::into_inner).start_kill();
        if let Some(watch) = self.stdout_watch.take() {
            watch.abort();
        }
    }
}

/// The kit executable, or with a memory limit the shell that sets it and then runs the kit; after
/// `wrapper`, the program and arguments that run it sandboxed (macOS: `sandbox-exec -p
/// <profile>`, [`crate::sandbox`]), when there are any.
fn command(options: &LaunchOptions, wrapper: &[OsString]) -> Command {
    let mut argv: Vec<OsString> = wrapper.to_vec();
    #[cfg(unix)]
    if let Some(bytes) = options.memory_limit_bytes {
        // Linux fails closed. On macOS resident monitoring enforces the option; its shell may
        // refuse ulimit -v (which is not an effective resident ceiling on that platform).
        argv.push(OsString::from(crate::sandbox::SHELL));
        argv.push(OsString::from("-c"));
        argv.push(OsString::from(memory_script(bytes, cfg!(target_os = "linux"))));
    }
    argv.push(options.executable.clone().into_os_string());
    let mut command = Command::new(&argv[0]);
    command.args(&argv[1..]);
    command
}

#[cfg(any(unix, test))]
fn memory_script(bytes: u64, strict: bool) -> String {
    let failure = if strict { "exit 125" } else { ":" };
    format!("ulimit -v {} 2>/dev/null || {failure}; exec \"$0\" \"$@\"", (bytes / 1024).max(1))
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

/// Starts `command`. On Linux an executable written moments ago can be "busy" while another thread
/// that forked during the write still holds its write handle (until that child execs), so a busy
/// executable is tried again for a moment instead of failing the launch.
async fn spawn_written(command: &mut tokio::process::Command) -> std::io::Result<tokio::process::Child> {
    let mut tries = 0;
    loop {
        match command.spawn() {
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy && tries < 50 => {
                tries += 1;
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            result => return result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn linux_memory_setup_is_fail_closed() {
        assert_eq!(memory_script(1024 * 1024, true), "ulimit -v 1024 2>/dev/null || exit 125; exec \"$0\" \"$@\"");
        assert!(memory_script(1, true).starts_with("ulimit -v 1 "));
    }

    /// a sandbox's wrapper (`sandbox-exec -p <profile>` on macOS) comes first and runs the
    /// kit's own command line, the memory-limit shell included, unchanged.
    #[test]
    fn a_sandbox_wrapper_runs_the_kits_own_command_line() {
        let wrapper = [OsString::from("/usr/bin/sandbox-exec"), OsString::from("-p"), OsString::from("(version 1)")];
        let mut options = LaunchOptions::new("/kits/kition-photo");
        let wrapped = command(&options, &wrapper);
        assert_eq!(wrapped.as_std().get_program(), "/usr/bin/sandbox-exec");
        let args: Vec<&OsStr> = wrapped.as_std().get_args().collect();
        assert_eq!(args, ["-p", "(version 1)", "/kits/kition-photo"]);

        let plain = command(&options, &[]);
        assert_eq!(plain.as_std().get_program(), "/kits/kition-photo");
        assert_eq!(plain.as_std().get_args().count(), 0);

        options.memory_limit_bytes = Some(1 << 30);
        let limited = command(&options, &wrapper);
        let args: Vec<&OsStr> = limited.as_std().get_args().collect();
        if cfg!(unix) {
            assert_eq!(args.len(), 6, "{args:?}");
            assert_eq!((args[2], args[3]), (OsStr::new(crate::sandbox::SHELL), OsStr::new("-c")));
            assert!(args[4].to_string_lossy().starts_with("ulimit -v 1048576 "), "{args:?}");
        }
        assert_eq!(args.last().copied(), Some(OsStr::new("/kits/kition-photo")));
    }
}
