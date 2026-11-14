// Copied from kition-sdk crates/kition-kits/src/bin/kition-kits.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! `kition-kits`: Kition's kits for a host written in any language.
//!
//! `kition-kits serve --workspace <folder>` speaks the Kits Service API (newline-delimited
//! JSON-RPC 2.0 on standard input and output, `kition_kits::serve`): the host opens, edits, saves
//! and previews the workspace's files by path, and this process runs the kits and serves their
//! files over the Kit Process Protocol. Like every form of Kition Kits, it is free and needs no
//! licence key.

use std::path::PathBuf;
use std::process::ExitCode;

use kition_kits::{KitManager, definitions};

const USAGE: &str = "\
usage:
  kition-kits serve --workspace <folder> [--kit <path>]... [--kits-dir <folder>]
      serve the Kits Service API on stdin and stdout (newline-delimited JSON-RPC 2.0) until
      stdin closes; see docs/sdk/hosts.md and contracts/kit/kits-service.schema.json

kits (a kit is its KHP manifest, `kit.json`, and its headless executable):
  --kit <path>           a kit's headless executable; its kit.json is the nearest one above it
                         that names it (`headless.executable`); repeatable
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
}

fn parse(mut args: impl Iterator<Item = String>) -> Result<Options, String> {
    match args.next().as_deref() {
        Some("serve") => {}
        Some("--help" | "-h") | None => return Err(String::new()),
        Some(other) => return Err(format!("unknown command {other}")),
    }
    let mut options = Options { workspace: None, kits: Vec::new(), kits_dir: None };
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--workspace" => options.workspace = Some(PathBuf::from(value("--workspace")?)),
            "--kit" => options.kits.push(PathBuf::from(value("--kit")?)),
            "--kits-dir" => options.kits_dir = Some(PathBuf::from(value("--kits-dir")?)),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(options)
}

fn main() -> ExitCode {
    let options = match parse(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) if message.is_empty() => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("kition-kits: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let Some(workspace) = options.workspace.clone().filter(|dir| dir.is_dir()) else {
        eprintln!("kition-kits: --workspace must name a folder\n\n{USAGE}");
        return ExitCode::from(2);
    };
    let found = definitions::found(&options.kits, options.kits_dir.as_deref());
    for reason in found.iter().filter_map(definitions::missing) {
        eprintln!("kition-kits: {reason}");
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("kition-kits: {error}");
            return ExitCode::FAILURE;
        }
    };
    let kits = KitManager::new(Some(workspace), found);
    match runtime.block_on(kition_kits::serve::serve(kits, tokio::io::stdin(), tokio::io::stdout())) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("kition-kits: {error}");
            ExitCode::FAILURE
        }
    }
}
