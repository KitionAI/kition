// Copied from kition-sdk crates/kition-kit-host/src/sandbox.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! The operating system's sandbox for kit processes (host contract H14; KHP spec/agent.md section
//! 10.6, A37, A58), opt-in through [`crate::LaunchOptions::sandbox`] and meant
//! to become the default.
//!
//! A sandboxed kit reads the platform's own files a process needs to run, its package (the folder
//! of its `kit.json`, its executable's folder, the fonts folder the host passes it), reads and
//! writes its private folder ([`crate::kit_home`]: its current folder, home and private runtime
//! folder) and its endpoint's folder, where it listens; and, only when the host gives it one, a
//! workspace. Every other file is denied, and so is the network: a kit started by `kition-kits`
//! gets its documents as handles over the Kit Process Protocol (section 5.1; `KitFiles 1.1` FA-P2)
//! and needs no workspace at all.
//!
//! - **macOS**: the kit runs under `sandbox-exec` with the profile [`darwin_profile`] makes: it
//!   denies everything by default and allows only what is above, Unix sockets only in the
//!   endpoint's and the private folder.
//! - **Linux**: Landlock confines the file system to [`landlock_rules`], and a seccomp filter
//!   refuses every socket but a Unix one, and `io_uring` ([`network_syscalls`]). Both are applied
//!   to a thread of the host's own made for the launch, which starts the kit and ends, so they
//!   hold for the kit and nothing else of the host. A kernel without Landlock refuses the launch.
//! - **Elsewhere** (Windows included) a sandboxed launch is refused.
//!
//! There is no fallback: a sandbox that cannot be set up is a launch error
//! ([`crate::LaunchError::Sandbox`]), never an unconfined kit. The rule sets are pure functions of
//! [`SandboxPaths`], so they are tested on every platform.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use tokio::process::{Child, Command};

use crate::endpoint::Endpoint;
use crate::kit_home::KitHome;
use crate::process::{LaunchError, LaunchOptions};

/// The shell that sets a memory limit before the kit starts
/// ([`crate::LaunchOptions::memory_limit_bytes`]).
pub const SHELL: &str = "/bin/sh";

/// The shells [`SHELL`] may hand over to (macOS's `/bin/sh` runs the one `/private/var/select/sh`
/// names), started under the sandbox only when a memory limit is set.
pub const SHELL_TARGETS: &[&str] = &["/bin/bash", "/bin/dash", "/bin/zsh"];

/// The variable naming the fonts folder the host passes its kits ([`crate::kit_home::PASSED`]),
/// which a sandboxed kit reads.
const FONTS: &str = "KITION_FONTS_DIR";

/// [`crate::LaunchOptions::sandbox`]: what a sandboxed kit reaches besides its executable's folder
/// and its private folder.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Sandbox {
    /// Folders the kit reads: its package (the folder of its `kit.json`).
    pub reads: Vec<PathBuf>,
    /// A workspace the kit reads and writes by path. `None` for a kit that gets its files as
    /// handles from its host (every kit `kition-kits` starts).
    pub workspace: Option<PathBuf>,
}

/// Everything a sandboxed kit reaches but the platform's own files, as real paths (no symbolic
/// link, macOS's `/private/var` rather than `/var`): the input of [`darwin_profile`] and
/// [`landlock_rules`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxPaths {
    /// Read and written; `None` when the kit gets its files as handles.
    pub workspace: Option<PathBuf>,
    /// Folders (or files) read: the kit's package, its executable's folder, its fonts folder.
    pub package: Vec<PathBuf>,
    /// The kit's private folder ([`crate::kit_home`]), read and written; its `tmp/` is the private
    /// runtime folder (KHP A58).
    pub private: PathBuf,
    /// The socket the kit listens on (Unix; `None` on Windows): it binds it, and its folder is read
    /// and written.
    pub endpoint: Option<PathBuf>,
    /// The programs the kit's command line starts, the kit's executable first; read and executed.
    pub programs: Vec<PathBuf>,
}

/// Files of macOS any process reads to start and run (path lookup reads `/`), and the devices it
/// uses. Nothing here holds a person's files (KHP conformance runtime list).
pub const DARWIN_SYSTEM_FILES: &[&str] = &["/", "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/dtracehelper", "/private/var/select/sh"];

/// Folders of macOS any process reads: the system's frameworks, libraries and executables, shared
/// data such as locales and time zones, and the dyld cache. Not `/Library/Fonts`, Homebrew
/// (`/opt/homebrew`, `/usr/local`) or any home folder: a kit ships its fonts (KHP A37).
pub const DARWIN_SYSTEM_FOLDERS: &[&str] = &[
    "/System",
    "/usr/lib",
    "/usr/libexec",
    "/usr/share",
    "/usr/bin",
    "/usr/sbin",
    "/bin",
    "/sbin",
    "/Library/Apple",
    "/private/var/db/dyld",
    "/private/var/db/timezone",
    "/dev/fd",
];

/// Devices a process on macOS writes.
pub const DARWIN_WRITABLE_FILES: &[&str] = &["/dev/null", "/dev/dtracehelper"];

/// Services of macOS the C library asks on a process's behalf: user lookups and the system log.
pub const DARWIN_SERVICES: &[&str] = &["com.apple.system.opendirectoryd.libinfo", "com.apple.system.logger", "com.apple.logd"];

/// Where macOS keeps `sandbox-exec`.
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// Files and folders of Linux a process reads to start and run: the system's programs and
/// libraries (the dynamic loader among them), the loader's cache, the time zone, user and group
/// lookups, the fonts configuration, the processor count, and random numbers. Not `/proc` (other
/// processes' environments), `/home`, `/tmp` or the rest of `/etc`.
pub const LINUX_SYSTEM: &[&str] = &[
    "/usr",
    "/lib",
    "/lib64",
    "/lib32",
    "/bin",
    "/sbin",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/localtime",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
    "/etc/fonts",
    "/sys/devices/system/cpu",
    "/dev/zero",
    "/dev/random",
    "/dev/urandom",
];

/// Devices of Linux a process writes (and the host opens for the kit's standard input).
pub const LINUX_WRITABLE: &[&str] = &["/dev/null"];

/// What a Landlock rule allows beneath its path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grant {
    /// Read files and folders, and execute files.
    Read,
    /// Everything: read, execute, write, make and remove files, folders and sockets.
    ReadWrite,
}

/// One Landlock rule of [`landlock_rules`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathRule {
    pub path: PathBuf,
    pub grant: Grant,
    /// A missing required path refuses the launch; a missing other one (a system folder this
    /// distribution does not have) is skipped.
    pub required: bool,
}

/// A system call the seccomp filter of [`network_syscalls`] refuses (`EACCES`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Blocked {
    /// The system call's number on the architecture asked for.
    pub syscall: i64,
    /// Allowed when its first argument is this value; `None` refuses every call.
    pub unless_first_argument: Option<u64>,
}

/// `AF_UNIX`, the one socket family a sandboxed kit makes (its endpoint, KHP A58's sockets).
pub const AF_UNIX: u64 = 1;

/// `io_uring_setup`, the same number on every architecture: io_uring makes and connects sockets
/// without the `socket` system call.
const IO_URING_SETUP: i64 = 425;

/// `EACCES`, what a refused system call answers.
#[cfg(target_os = "linux")]
const EACCES: u32 = 13;

/// The system calls Linux's seccomp filter refuses so that a kit has no network (KHP A37): `socket`
/// for every family but `AF_UNIX`, and `io_uring_setup`. `None` for an architecture this module
/// does not know the numbers of (only `x86_64` and `aarch64`).
#[must_use]
pub fn network_syscalls(arch: &str) -> Option<Vec<Blocked>> {
    let socket = match arch {
        "x86_64" => 41,
        "aarch64" => 198,
        _ => return None,
    };
    Some(vec![Blocked { syscall: socket, unless_first_argument: Some(AF_UNIX) }, Blocked { syscall: IO_URING_SETUP, unless_first_argument: None }])
}

/// The Landlock rules for a kit: the system's files and the package read, the private folder, the
/// endpoint's folder and the workspace (when given) read and written, nothing else. The kit's
/// executable is required, as are the folders it writes; the system's are not.
#[must_use]
pub fn landlock_rules(paths: &SandboxPaths) -> Vec<PathRule> {
    let rule = |path: &Path, grant: Grant, required: bool| PathRule { path: path.to_path_buf(), grant, required };
    let mut rules: Vec<PathRule> = LINUX_SYSTEM.iter().map(|path| rule(Path::new(path), Grant::Read, false)).collect();
    rules.extend(LINUX_WRITABLE.iter().map(|path| rule(Path::new(path), Grant::ReadWrite, true)));
    rules.extend(paths.package.iter().map(|path| rule(path.as_path(), Grant::Read, false)));
    rules.extend(paths.programs.iter().enumerate().map(|(index, path)| rule(path.as_path(), Grant::Read, index == 0)));
    rules.push(rule(paths.private.as_path(), Grant::ReadWrite, true));
    if let Some(folder) = paths.endpoint.as_deref().and_then(Path::parent) {
        rules.push(rule(folder, Grant::ReadWrite, true));
    }
    if let Some(workspace) = &paths.workspace {
        rules.push(rule(workspace.as_path(), Grant::ReadWrite, true));
    }
    rules
}

/// `path` as an absolute path a profile can name, or why not: a profile string cannot hold a
/// double quote, and a path that is not UTF-8 or holds a control character is refused rather
/// than written differently.
fn profile_path(path: &Path) -> Result<&str, String> {
    match path.to_str() {
        Some(text) if path.is_absolute() && !text.contains('"') && !text.chars().any(char::is_control) => Ok(text),
        _ => Err(format!("{} cannot be named in a sandbox profile (it must be an absolute UTF-8 path without a double quote)", path.display())),
    }
}

/// A profile string literal.
fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\"))
}

/// `text` as a regular expression matching itself.
fn regex_escaped(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if "\\.^$|?*+()[]{}".contains(character) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

/// The macOS sandbox profile (`sandbox-exec -p`) for a kit: everything is denied by default; a
/// process may fork, start [`SandboxPaths::programs`] and signal itself, read system settings
/// (`sysctl`), ask [`DARWIN_SERVICES`], and read any file's metadata (resolving a path reads each
/// folder's); it reads the files of [`DARWIN_SYSTEM_FILES`], [`DARWIN_SYSTEM_FOLDERS`], its
/// package and programs; it reads and writes its private folder, its endpoint's folder and the
/// workspace when given; it makes Unix sockets and binds only its endpoint's and those in its
/// private folder (KHP A58), and connects only to the latter. No other network (KHP A37).
pub fn darwin_profile(paths: &SandboxPaths) -> Result<String, String> {
    let program = paths.programs.first().ok_or("a sandbox profile needs the kit's executable")?;
    let subpath = |path: &Path| profile_path(path).map(|text| format!("(subpath {})", quoted(text)));
    let literal = |path: &Path| profile_path(path).map(|text| format!("(literal {})", quoted(text)));
    profile_path(program)?;

    let mut writable_folders: Vec<String> = vec![subpath(paths.private.as_path())?];
    if let Some(folder) = paths.endpoint.as_deref().and_then(Path::parent) {
        writable_folders.push(subpath(folder)?);
    }
    if let Some(workspace) = &paths.workspace {
        writable_folders.push(subpath(workspace.as_path())?);
    }
    let mut readable: Vec<String> = Vec::new();
    for file in DARWIN_SYSTEM_FILES {
        readable.push(literal(Path::new(file))?);
    }
    for folder in DARWIN_SYSTEM_FOLDERS {
        readable.push(subpath(Path::new(folder))?);
    }
    for folder in &paths.package {
        readable.push(subpath(folder.as_path())?);
    }
    let mut programs: Vec<String> = Vec::new();
    for file in &paths.programs {
        programs.push(literal(file.as_path())?);
    }
    readable.extend(programs.iter().cloned());
    readable.extend(writable_folders.iter().cloned());
    let mut writable = writable_folders;
    for file in DARWIN_WRITABLE_FILES {
        writable.push(literal(Path::new(file))?);
    }
    let private = format!("#\"^{}/\"", regex_escaped(profile_path(&paths.private)?));
    let mut bound = vec![format!("(local unix-socket (path-regex {private}))")];
    if let Some(socket) = &paths.endpoint {
        bound.push(format!("(local unix-socket (path-literal {}))", quoted(profile_path(socket)?)));
    }
    let services: Vec<String> = DARWIN_SERVICES.iter().map(|name| format!("(global-name {})", quoted(name))).collect();

    let rules = [
        "(version 1)".to_owned(),
        "(deny default)".to_owned(),
        "(allow process-fork)".to_owned(),
        format!("(allow process-exec {})", programs.join(" ")),
        "(allow signal (target same-sandbox))".to_owned(),
        "(allow process-info* (target same-sandbox))".to_owned(),
        "(allow sysctl-read)".to_owned(),
        format!("(allow mach-lookup {})", services.join(" ")),
        "(allow file-read-metadata)".to_owned(),
        format!("(allow file-read* {})", readable.join(" ")),
        format!("(allow file-write* {})", writable.join(" ")),
        format!("(allow file-ioctl {})", literal(Path::new("/dev/dtracehelper"))?),
        "(allow system-socket (socket-domain AF_UNIX))".to_owned(),
        format!("(allow network-bind network-inbound {})", bound.join(" ")),
        format!("(allow network-outbound (remote unix-socket (path-regex {private})))"),
    ];
    Ok(rules.join("\n"))
}

/// The real path of `path`, or `path` when it cannot be resolved (it does not exist).
fn real(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(unix)]
fn endpoint_socket(endpoint: &Endpoint) -> Option<PathBuf> {
    Some(PathBuf::from(endpoint.address()))
}

#[cfg(not(unix))]
fn endpoint_socket(_endpoint: &Endpoint) -> Option<PathBuf> {
    None
}

/// What the launch `options` give a sandboxed kit to reach: `sandbox`'s folders, the executable's
/// folder, the fonts folder `environment` (the kit's) names, `home`, and `endpoint`'s socket, by
/// their real paths.
pub(crate) fn paths(sandbox: &Sandbox, options: &LaunchOptions, home: &KitHome, endpoint: &Endpoint, environment: &[(OsString, OsString)]) -> SandboxPaths {
    let mut package: Vec<PathBuf> = sandbox.reads.iter().map(PathBuf::as_path).map(real).collect();
    package.extend(options.executable.parent().filter(|folder| !folder.as_os_str().is_empty()).map(real));
    package.extend(environment.iter().filter(|(name, value)| name == FONTS && !value.is_empty()).map(|(_, folder)| real(Path::new(folder))));
    package.sort();
    package.dedup();
    let mut programs = vec![options.executable.clone(), real(&options.executable)];
    if options.memory_limit_bytes.is_some() {
        programs.extend(std::iter::once(SHELL).chain(SHELL_TARGETS.iter().copied()).map(PathBuf::from));
    }
    programs.dedup();
    SandboxPaths {
        workspace: sandbox.workspace.as_deref().map(real),
        package,
        private: home.root().to_path_buf(),
        endpoint: endpoint_socket(endpoint),
        programs,
    }
}

/// How a launch runs the kit sandboxed: a program and arguments before its command line (macOS),
/// and the rules its launch thread applies (Linux).
#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
pub(crate) struct Plan {
    pub(crate) wrapper: Vec<OsString>,
    #[cfg(target_os = "linux")]
    rules: Vec<PathRule>,
    #[cfg(target_os = "linux")]
    blocked: Vec<Blocked>,
}

#[cfg(target_os = "macos")]
pub(crate) fn plan(paths: &SandboxPaths) -> Result<Plan, String> {
    check()?;
    let profile = darwin_profile(paths)?;
    Ok(Plan { wrapper: vec![OsString::from(SANDBOX_EXEC), OsString::from("-p"), OsString::from(profile)] })
}

#[cfg(target_os = "linux")]
pub(crate) fn plan(paths: &SandboxPaths) -> Result<Plan, String> {
    let blocked = network_syscalls(std::env::consts::ARCH).ok_or_else(unsupported_architecture)?;
    Ok(Plan { wrapper: Vec::new(), rules: landlock_rules(paths), blocked })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn plan(_paths: &SandboxPaths) -> Result<Plan, String> {
    Err(unsupported())
}

/// Whether kit processes can run sandboxed on this machine; `Err` says why not. A program that
/// offers a sandbox (`kition-kits-mcp --sandbox`) asks before it starts, and refuses to start
/// without one.
#[cfg(target_os = "macos")]
pub fn check() -> Result<(), String> {
    if Path::new(SANDBOX_EXEC).is_file() { Ok(()) } else { Err(format!("{SANDBOX_EXEC} is missing, so kit processes cannot run sandboxed")) }
}

/// Whether kit processes can run sandboxed on this machine; `Err` says why not: an architecture
/// whose system call numbers this module does not know, or a kernel without Landlock.
#[cfg(target_os = "linux")]
pub fn check() -> Result<(), String> {
    network_syscalls(std::env::consts::ARCH).ok_or_else(unsupported_architecture)?;
    linux::landlock_available()
}

/// Kit processes cannot run sandboxed on this platform.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn check() -> Result<(), String> {
    Err(unsupported())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn unsupported() -> String {
    let os = std::env::consts::OS;
    format!("the sandbox for kit processes is not supported on this platform ({os}); it is on macOS (sandbox-exec) and Linux (Landlock, seccomp)")
}

#[cfg(target_os = "linux")]
fn unsupported_architecture() -> String {
    let arch = std::env::consts::ARCH;
    format!("the sandbox for kit processes is not supported on this architecture ({arch}); on Linux it is on x86_64 and aarch64")
}

/// Starts `command` as `plan` says: on Linux from a thread of its own that Landlock and the
/// seccomp filter confine first, so the kit inherits both and the host's other threads neither.
#[cfg(target_os = "linux")]
pub(crate) async fn spawn(mut command: Command, plan: Plan) -> Result<Child, LaunchError> {
    let runtime = tokio::runtime::Handle::current();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("kition-kit-sandbox".into())
        .spawn(move || {
            // The child is registered with the host's runtime, which reaps it.
            let _entered = runtime.enter();
            let started = match linux::restrict_this_thread(&plan.rules, &plan.blocked) {
                Ok(()) => command.spawn().map_err(LaunchError::Spawn),
                Err(error) => Err(LaunchError::Sandbox(error)),
            };
            let _ = sender.send(started);
        })
        .map_err(LaunchError::Spawn)?;
    receiver.await.unwrap_or_else(|_| Err(LaunchError::Sandbox("the sandboxed launch thread ended without starting the kit".to_owned())))
}

/// Starts `command`, whose wrapper (macOS: `sandbox-exec`) is the sandbox.
#[cfg(not(target_os = "linux"))]
pub(crate) async fn spawn(mut command: Command, _plan: Plan) -> Result<Child, LaunchError> {
    command.spawn().map_err(LaunchError::Spawn)
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::BTreeMap;

    use landlock::{ABI, Access, AccessFs, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetStatus};
    use seccompiler::{BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter, SeccompRule, TargetArch};

    use super::{Blocked, EACCES, Grant, PathRule};

    /// The Landlock version whose file system rights are asked for (Linux 6.2: truncation); an
    /// older kernel enforces the rights it knows.
    const ABI_USED: ABI = ABI::V3;

    const NOT_ENFORCED: &str = "kit processes cannot run sandboxed: this kernel has no Landlock (it needs Linux 5.13 or later with Landlock enabled)";

    /// Whether Landlock enforces a rule set here: tried on a thread of its own, which ends.
    pub(super) fn landlock_available() -> Result<(), String> {
        let probe = std::thread::Builder::new().name("kition-kit-sandbox-probe".into()).spawn(|| -> Result<(), String> {
            let status = Ruleset::default()
                .handle_access(AccessFs::from_all(ABI_USED))
                .map_err(|error| error.to_string())?
                .create()
                .map_err(|error| error.to_string())?
                .restrict_self()
                .map_err(|error| error.to_string())?;
            if matches!(status.ruleset, RulesetStatus::NotEnforced) { Err(NOT_ENFORCED.to_owned()) } else { Ok(()) }
        });
        probe.map_err(|error| error.to_string())?.join().unwrap_or_else(|_| Err("the Landlock probe failed".to_owned()))
    }

    /// Confines the calling thread, and every process it starts from now on: the file system to
    /// `rules` (Landlock), and `blocked` refused (seccomp). Errs, having started nothing, when
    /// either cannot be applied.
    pub(super) fn restrict_this_thread(rules: &[PathRule], blocked: &[Blocked]) -> Result<(), String> {
        let read = AccessFs::from_read(ABI_USED);
        let all = AccessFs::from_all(ABI_USED);
        let file_read = AccessFs::ReadFile | AccessFs::Execute;
        let file_write = AccessFs::ReadFile | AccessFs::WriteFile | AccessFs::Truncate;
        let mut ruleset = Ruleset::default().handle_access(all).map_err(|error| error.to_string())?.create().map_err(|error| error.to_string())?;
        for rule in rules {
            let fd = match PathFd::new(&rule.path) {
                Ok(fd) => fd,
                Err(_) if !rule.required => continue,
                Err(error) => return Err(format!("{}: {error}", rule.path.display())),
            };
            let access = match (rule.grant, rule.path.is_dir()) {
                (Grant::Read, true) => read,
                (Grant::ReadWrite, true) => all,
                (Grant::Read, false) => file_read,
                (Grant::ReadWrite, false) => file_write,
            };
            ruleset = ruleset.add_rule(PathBeneath::new(fd, access)).map_err(|error| format!("{}: {error}", rule.path.display()))?;
        }
        let status = ruleset.restrict_self().map_err(|error| error.to_string())?;
        if matches!(status.ruleset, RulesetStatus::NotEnforced) {
            return Err(NOT_ENFORCED.to_owned());
        }

        let arch = match std::env::consts::ARCH {
            "x86_64" => TargetArch::x86_64,
            "aarch64" => TargetArch::aarch64,
            _ => return Err(super::unsupported_architecture()),
        };
        let mut syscalls: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
        for block in blocked {
            let condition = match block.unless_first_argument {
                Some(value) => SeccompCondition::new(0, SeccompCmpArgLen::Dword, SeccompCmpOp::Ne, value),
                // `(argument & 0) == 0` holds for every call.
                None => SeccompCondition::new(0, SeccompCmpArgLen::Qword, SeccompCmpOp::MaskedEq(0), 0),
            }
            .map_err(|error| error.to_string())?;
            let rule = SeccompRule::new(vec![condition]).map_err(|error| error.to_string())?;
            syscalls.insert(block.syscall, vec![rule]);
        }
        let filter = SeccompFilter::new(syscalls, SeccompAction::Allow, SeccompAction::Errno(EACCES), arch).map_err(|error| error.to_string())?;
        let program: Result<BpfProgram, _> = filter.try_into();
        let program = program.map_err(|error| error.to_string())?;
        seccompiler::apply_filter(&program).map_err(|error| format!("the seccomp filter: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIVATE: &str = "/private/var/folders/xy/T/kition-kits/kition-kit-home-0a.1b";
    const ENDPOINT: &str = "/private/var/folders/xy/T/kition-kit-0123";
    const SOCKET: &str = "/private/var/folders/xy/T/kition-kit-0123/kit.sock";

    fn sample(workspace: Option<&str>) -> SandboxPaths {
        SandboxPaths {
            workspace: workspace.map(PathBuf::from),
            package: vec![PathBuf::from("/kits/photo"), PathBuf::from("/sdk/bin/darwin-arm64")],
            private: PathBuf::from(PRIVATE),
            endpoint: Some(PathBuf::from(SOCKET)),
            programs: vec![PathBuf::from("/sdk/bin/darwin-arm64/kition-photo")],
        }
    }

    /// The profile's line that starts with `start`, which must be there once.
    fn line<'a>(profile: &'a str, start: &str) -> &'a str {
        let lines: Vec<&str> = profile.lines().filter(|line| line.starts_with(start)).collect();
        assert_eq!(lines.len(), 1, "{start} once in:\n{profile}");
        lines[0]
    }

    /// Every line is one balanced form: parentheses outside string literals close in order.
    fn balanced(profile: &str) {
        for line in profile.lines() {
            let (mut depth, mut in_string, mut escaped) = (0i32, false, false);
            for character in line.chars() {
                match (in_string, escaped, character) {
                    (true, true, _) => escaped = false,
                    (true, false, '\\') => escaped = true,
                    (_, false, '"') => in_string = !in_string,
                    (false, _, '(') => depth += 1,
                    (false, _, ')') => depth -= 1,
                    _ => {}
                }
                assert!(depth >= 0, "closes too early: {line}");
            }
            assert!(depth == 0 && !in_string, "unbalanced: {line}");
            assert!(line.starts_with("(version 1)") || line.starts_with("(deny ") || line.starts_with("(allow "), "{line}");
        }
    }

    /// macOS: the profile denies everything by default and allows only the kit's own: the
    /// system's files and its package read, its private folder and endpoint's folder written, Unix
    /// sockets only there, and never the network or a workspace it was not given.
    #[test]
    fn the_darwin_profile_denies_by_default_and_names_only_the_kits_folders() {
        let profile = darwin_profile(&sample(None)).unwrap();
        balanced(&profile);
        let lines: Vec<&str> = profile.lines().collect();
        assert_eq!(&lines[..2], ["(version 1)", "(deny default)"]);
        let never = [
            "(allow default)",
            "(remote ip",
            "(local ip",
            "(allow network*",
            "(allow file-read*)",
            "(allow file-write*)",
            "(allow process-exec)",
            "/Users",
            "/Library/Fonts",
            "/opt/homebrew",
            "/usr/local",
            "/private/tmp",
        ];
        for never in never {
            assert!(!profile.contains(never), "{never} in:\n{profile}");
        }
        let private = format!("(subpath \"{PRIVATE}\")");
        let endpoint = format!("(subpath \"{ENDPOINT}\")");
        let write = line(&profile, "(allow file-write* ");
        assert!(write.contains(&private) && write.contains(&endpoint) && write.contains("(literal \"/dev/null\")"), "{write}");
        for read_only in ["/kits/photo", "/sdk/bin", "/System"] {
            assert!(!write.contains(read_only), "the package and the system are read only: {write}");
        }
        let read = line(&profile, "(allow file-read* ");
        let readable = [
            "(subpath \"/kits/photo\")",
            "(subpath \"/sdk/bin/darwin-arm64\")",
            "(subpath \"/System\")",
            "(subpath \"/usr/lib\")",
            "(literal \"/\")",
            "(literal \"/sdk/bin/darwin-arm64/kition-photo\")",
            private.as_str(),
            endpoint.as_str(),
        ];
        for allowed in readable {
            assert!(read.contains(allowed), "{allowed} not in {read}");
        }
        assert_eq!(line(&profile, "(allow process-exec "), "(allow process-exec (literal \"/sdk/bin/darwin-arm64/kition-photo\"))");
        assert_eq!(line(&profile, "(allow file-read-metadata"), "(allow file-read-metadata)");
        let private_sockets = "(path-regex #\"^/private/var/folders/xy/T/kition-kits/kition-kit-home-0a\\.1b/\")";
        let bind = line(&profile, "(allow network-bind ");
        assert!(bind.contains(&format!("(local unix-socket (path-literal \"{SOCKET}\"))")), "{bind}");
        assert!(bind.contains(&format!("(local unix-socket {private_sockets})")), "{bind}");
        let outbound = line(&profile, "(allow network-outbound ");
        assert_eq!(outbound, format!("(allow network-outbound (remote unix-socket {private_sockets}))"));
        assert_eq!(line(&profile, "(allow system-socket"), "(allow system-socket (socket-domain AF_UNIX))");
        assert!(line(&profile, "(allow mach-lookup ").contains("(global-name \"com.apple.system.opendirectoryd.libinfo\")"));
    }

    /// A workspace the host gives is read and written; one it does not give appears nowhere.
    #[test]
    fn the_darwin_profile_names_a_workspace_only_when_given() {
        let without = darwin_profile(&sample(None)).unwrap();
        let with = darwin_profile(&sample(Some("/work/space"))).unwrap();
        assert!(!without.contains("/work/space"));
        assert!(line(&with, "(allow file-write* ").contains("(subpath \"/work/space\")"));
        assert!(line(&with, "(allow file-read* ").contains("(subpath \"/work/space\")"));
        balanced(&with);
    }

    /// A path a profile cannot hold, a relative one, and a profile without the kit's executable
    /// (which would allow starting any program) are refused, never written loosely.
    #[test]
    fn the_darwin_profile_refuses_what_it_cannot_name() {
        let mut quote = sample(None);
        quote.package.push(PathBuf::from("/kits/a\"b"));
        assert!(darwin_profile(&quote).unwrap_err().contains("double quote"));
        let mut relative = sample(None);
        relative.private = PathBuf::from("kition-kit-home-0");
        assert!(darwin_profile(&relative).is_err());
        let mut newline = sample(None);
        newline.workspace = Some(PathBuf::from("/work/a\nb"));
        assert!(darwin_profile(&newline).is_err());
        let mut none = sample(None);
        none.programs.clear();
        assert!(darwin_profile(&none).is_err());
        let mut backslash = sample(None);
        backslash.package.push(PathBuf::from("/kits/a\\b"));
        assert!(line(&darwin_profile(&backslash).unwrap(), "(allow file-read* ").contains("(subpath \"/kits/a\\\\b\")"));
    }

    #[test]
    fn regular_expressions_match_paths_literally() {
        assert_eq!(regex_escaped("/a.b+c(d)/e[f]$"), "/a\\.b\\+c\\(d\\)/e\\[f\\]\\$");
        assert_eq!(regex_escaped("/plain/kition-kit-home-01"), "/plain/kition-kit-home-01");
    }

    /// Linux: Landlock reads the system's files and the package, reads and writes only the
    /// private folder, the endpoint's folder, `/dev/null` and a given workspace; `/proc`, homes and
    /// the shared temporary folder are not in the rule set at all.
    #[test]
    fn the_landlock_rules_write_only_the_kits_own_folders() {
        let rules = landlock_rules(&sample(None));
        let grant = |path: &str| rules.iter().find(|rule| rule.path == Path::new(path)).map(|rule| (rule.grant, rule.required));
        assert_eq!(grant(PRIVATE), Some((Grant::ReadWrite, true)));
        assert_eq!(grant(ENDPOINT), Some((Grant::ReadWrite, true)));
        assert_eq!(grant("/dev/null"), Some((Grant::ReadWrite, true)));
        assert_eq!(grant("/kits/photo"), Some((Grant::Read, false)));
        assert_eq!(grant("/sdk/bin/darwin-arm64/kition-photo"), Some((Grant::Read, true)));
        assert_eq!(grant("/usr"), Some((Grant::Read, false)));
        assert_eq!(grant("/etc/ld.so.cache"), Some((Grant::Read, false)));
        for never in ["/", "/proc", "/home", "/root", "/tmp", "/etc", "/var", "/run", "/work/space"] {
            assert_eq!(grant(never), None, "{never}");
        }
        let written: Vec<&Path> = rules.iter().filter(|rule| rule.grant == Grant::ReadWrite).map(|rule| rule.path.as_path()).collect();
        assert_eq!(written, [Path::new("/dev/null"), Path::new(PRIVATE), Path::new(ENDPOINT)]);
        let with = landlock_rules(&sample(Some("/work/space")));
        assert!(with.iter().any(|rule| rule.path == Path::new("/work/space") && rule.grant == Grant::ReadWrite && rule.required));
    }

    /// Linux: no network (KHP A37): `socket` is refused for every family but `AF_UNIX`, and
    /// `io_uring_setup` always; an architecture whose numbers are not known gets no filter, so a
    /// sandboxed launch there is refused.
    #[test]
    fn the_network_filter_refuses_every_socket_but_a_unix_one() {
        let x86 = network_syscalls("x86_64").unwrap();
        assert_eq!(x86, [Blocked { syscall: 41, unless_first_argument: Some(AF_UNIX) }, Blocked { syscall: 425, unless_first_argument: None }]);
        let arm = network_syscalls("aarch64").unwrap();
        assert_eq!(arm, [Blocked { syscall: 198, unless_first_argument: Some(1) }, Blocked { syscall: 425, unless_first_argument: None }]);
        for unknown in ["x86", "arm", "riscv64", "powerpc64", ""] {
            assert_eq!(network_syscalls(unknown), None, "{unknown}");
        }
    }

    /// The paths a launch gives the rule sets: the package, the executable's folder and the fonts
    /// folder read, by their real paths; the kit's private folder and endpoint; no workspace unless
    /// asked.
    #[cfg(unix)]
    #[test]
    fn a_launch_gives_the_sandbox_its_package_private_folder_and_endpoint() {
        let root = std::env::temp_dir().join(format!("kit-sandbox-paths-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for folder in ["package", "bin", "fonts"] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
        }
        std::fs::write(root.join("bin/kition-x"), b"").unwrap();
        let real_root = std::fs::canonicalize(&root).unwrap();
        let home = KitHome::create(&root.join("homes")).unwrap();
        let endpoint = Endpoint::create_in(&real_root.join("sockets")).unwrap();
        let options = LaunchOptions::new(root.join("bin/kition-x"));
        let environment = [(OsString::from(FONTS), root.join("fonts").into_os_string()), (OsString::from("TMPDIR"), home.tmp().into_os_string())];
        let sandbox = Sandbox { reads: vec![root.join("package")], workspace: None };
        let paths = paths(&sandbox, &options, &home, &endpoint, &environment);
        assert_eq!(paths.package, [real_root.join("bin"), real_root.join("fonts"), real_root.join("package")]);
        assert_eq!(paths.private, home.root());
        assert_eq!(paths.endpoint.as_deref(), Some(Path::new(endpoint.address())));
        assert_eq!(paths.programs.last(), Some(&real_root.join("bin/kition-x")));
        assert_eq!(paths.workspace, None);
        let shared = Sandbox { reads: Vec::new(), workspace: Some(root.join("package")) };
        assert_eq!(super::paths(&shared, &options, &home, &endpoint, &environment).workspace, Some(real_root.join("package")));
        drop((home, endpoint));
        let _ = std::fs::remove_dir_all(root);
    }

    /// Windows and every other platform: a sandboxed launch is refused, saying so.
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    #[test]
    fn elsewhere_a_sandbox_is_refused() {
        assert!(check().unwrap_err().contains("not supported on this platform"));
        assert!(plan(&sample(None)).is_err());
    }
}
