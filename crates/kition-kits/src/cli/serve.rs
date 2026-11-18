// Copied from kition-sdk crates/kition-kits/src/cli/serve.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! `kition-kits` and `kition serve`: Kition's kits for a host written in any language.
//!
//! `kition-kits serve --workspace <folder>` speaks the Kits Service API (newline-delimited
//! JSON-RPC 2.0 on standard input and output, `crate::serve`): the host opens, edits, saves
//! and previews the workspace's files by path, and this process runs the kits and serves their
//! files over the Kit Process Protocol. Like every form of the Kition SDK, it is free and needs no
//! licence key.

use std::path::PathBuf;
use std::process::ExitCode;

use crate::{KitManager, definitions};

const USAGE: &str = "\
usage:
  kition-kits serve --workspace <folder> [--kit <path>]... [--kits-dir <folder>] [--sandbox]
      serve the Kits Service API on stdin and stdout (newline-delimited JSON-RPC 2.0) until
      stdin closes; see docs/sdk/hosts.md and contracts/kit/kits-service.schema.json

  --sandbox              run every kit process under the platform's sandbox: it reads the system's
                         files and its package, keeps its state in its private folder, and reaches
                         no other file and no network (macOS: sandbox-exec; Linux: Landlock and
                         seccomp). Elsewhere, or on a Linux kernel without Landlock, it refuses to
                         start. Off by default for now; meant to become the default
  --call-timeout-secs <n> maximum time per kit request (default 120; shorter protocol limits apply)
  --idle-timeout-secs <n> save and stop a process with no calls for this long (default 600)
  --memory-limit-mib <n>  optional per-process memory ceiling (Linux/macOS); unsupported platforms
                         refuse it. All three values must be positive integers

kits (a kit is its KHP manifest, `kit.json`, and its headless executable):
  --kit <path>           a kit's headless executable; its kit.json is the nearest one above it
                         that names it (`headless.executable`); one that no kit.json names is
                         asked which kit it is (kit.initialize), and one that is no kit known
                         stops kition-kits with an error; repeatable
  --kits-dir <folder>    a folder with one folder per kit holding its kit.json, and its executable
                         beside it if installed (an SDK bundle's `kits/`)
  KITION_KIT_<KIT>_BINARY  executables named by the environment, as --kit
  bin/<platform>/        for kits without one, the executable their kit.json names in the bundle's
                         bin/<platform>/ beside --kits-dir, beside kition-kits, then on the PATH
";

struct Options {
    workspace: Option<PathBuf>,
    kits: Vec<PathBuf>,
    kits_dir: Option<PathBuf>,
    sandbox: bool,
    limits: crate::control::Limits,
}

fn parse(mut args: impl Iterator<Item = String>) -> Result<Options, String> {
    match args.next().as_deref() {
        Some("serve") => {}
        Some("--help" | "-h") | None => return Err(String::new()),
        Some(other) => return Err(format!("unknown command {other}")),
    }
    let mut options = Options { workspace: None, kits: Vec::new(), kits_dir: None, sandbox: false, limits: crate::control::Limits::default() };
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--workspace" => options.workspace = Some(PathBuf::from(value("--workspace")?)),
            "--kit" => options.kits.push(PathBuf::from(value("--kit")?)),
            "--kits-dir" => options.kits_dir = Some(PathBuf::from(value("--kits-dir")?)),
            "--sandbox" => options.sandbox = true,
            "--help" | "-h" => return Err(String::new()),
            "--call-timeout-secs" | "--idle-timeout-secs" | "--memory-limit-mib" => options.limits.set_flag(&arg, &value(&arg)?)?,
            other => return Err(format!("unknown argument {other}")),
        }
    }
    options.limits.validate()?;
    Ok(options)
}

/// The usage of `program`: `kition-kits`, or `kition`, whose `serve` is the same command.
fn usage(program: &str) -> String {
    USAGE.replace("kition-kits", program)
}

/// The kits a program keeps in a store (`kition serve`), used when neither `--kit` nor
/// `--kits-dir` is given; a kit the environment names keeps its executable.
pub type StoreKits = Box<dyn FnOnce() -> Vec<definitions::Found>>;

/// Runs `<program> serve` with `args`: the arguments after the program's name, `serve` first.
pub fn main(program: &str, args: impl Iterator<Item = String>, store: Option<StoreKits>) -> ExitCode {
    let options = match parse(args) {
        Ok(options) => options,
        Err(message) if message.is_empty() => {
            print!("{}", usage(program));
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("{program}: {message}\n\n{}", usage(program));
            return ExitCode::from(2);
        }
    };
    let Some(workspace) = options.workspace.clone().filter(|dir| dir.is_dir()) else {
        eprintln!("{program}: --workspace must name a folder\n\n{}", usage(program));
        return ExitCode::from(2);
    };
    // No fallback: a sandbox that this machine cannot give is a refusal to start, never kits run
    // unconfined.
    if options.sandbox
        && let Err(reason) = kition_kit_host::sandbox::check()
    {
        eprintln!("{program}: --sandbox: {reason}");
        return ExitCode::FAILURE;
    }
    let mut found = match definitions::found(&options.kits, options.kits_dir.as_deref(), options.sandbox, options.limits) {
        Ok(found) => found,
        Err(message) => {
            eprintln!("{program}: {message}");
            return ExitCode::from(2);
        }
    };
    if let Some(store) = store.filter(|_| options.kits.is_empty() && options.kits_dir.is_none()) {
        definitions::merge(&mut found, store());
    }
    for reason in found.iter().filter_map(definitions::missing) {
        eprintln!("{program}: {reason}");
    }
    let runtime = match crate::runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{program}: {error}");
            return ExitCode::FAILURE;
        }
    };
    let kits = match KitManager::new(Some(workspace), found).with_limits(options.limits) {
        Ok(kits) => kits,
        Err(reason) => {
            eprintln!("{program}: {reason}");
            return ExitCode::FAILURE;
        }
    };
    let kits = if options.sandbox { kits.with_sandbox() } else { kits };
    match runtime.block_on(crate::serve::serve(kits, tokio::io::stdin(), tokio::io::stdout())) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{program}: {error}");
            ExitCode::FAILURE
        }
    }
}
