// Copied from kition-sdk crates/kition-kits/src/cli/mcp.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! `kition-kits-mcp` and `kition mcp`: Kition's kit tools as a stdio MCP server, for harnesses that run without
//! Kition (DeepSeek Harness through `dsh-mcp-client`, and other MCP clients). It edits files in
//! one workspace folder through each installed kit's headless executable; with Kition running,
//! use its `POST /v1/mcp/kits` instead, which also edits files open in kit editors live.
//!
//! The agent's drafts (`draft: true`) live in the workspace's `.kition/drafts/` (`drafts.rs`);
//! the person reviews and merges them with `kition-kits-mcp drafts`, never the agent. See
//! [`USAGE`] for every option.
//!
//! Like every form of the Kition SDK, it is free on any machine, servers included, and needs no
//! licence key: only collaboration is paid.
//!
//! `kition mcp` is the same program with a kit store ([`Store`]): with no `--kit` or `--kits-dir`,
//! its kits are the store's, and kits that are not installed are installed when the agent first
//! names a file of theirs.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use crate::definitions;
use crate::supply::KitSupply;
use crate::{KitManager, drafts, tools};
use serde_json::{Value, json};

/// The kits installed in a store, with their executables, and the supply that installs the
/// others on demand.
pub type StoreKits = (Vec<definitions::Found>, Option<Arc<dyn KitSupply>>);

/// A program's kit store (`kition mcp`): the kits used when no `--kit` or `--kits-dir` is given.
pub struct Store {
    /// What the program's usage says about the store, after the kits section.
    pub usage: &'static str,
    /// The kits installed in the store, with their executables, and the supply that installs
    /// the others on demand (`None` when automatic installs are off).
    pub kits: Box<dyn FnOnce() -> StoreKits>,
}

const USAGE: &str = "\
usage:
  kition-kits-mcp --workspace <folder> [options]        serve the kit tools over stdio (MCP)
  kition-kits-mcp drafts <command> --workspace <folder> [options]
                                                        review the agent's drafts (the person's side)
  kition-kits-mcp --schemas                             print the tools' argument and result schemas

  kition-kits-mcp --list-kits [kits]                     print the kits found and exit

kits (a kit is its KHP manifest, `kit.json`, and its headless executable):
  --kit <path>           a kit's headless executable; its kit.json is the nearest one above it
                         that names it (`headless.executable`), as in a kit repository, or the
                         SDK bundle's kits/<kit>/kit.json beside its bin/; one that no kit.json
                         names is asked which kit it is (kit.initialize), and one that is no kit
                         known stops kition-kits-mcp with an error; repeatable
  --kits-dir <folder>    a folder with one folder per kit holding its kit.json, and its executable
                         beside it if installed (an SDK bundle's `kits/`)
  KITION_KIT_<KIT>_BINARY  executables named by the environment, as --kit (development builds)
  bin/<platform>/        for kits without one, the executable their kit.json names in the bundle's
                         bin/<platform>/ beside --kits-dir, beside kition-kits-mcp, then on the PATH

  In an SDK bundle:      bin/<platform>/kition-kits-mcp --workspace <folder> --kits-dir kits

server options:
  --unified              one set of tools for every kit (`kit_<action>`), routed by the file's
                         extension, instead of `<prefix>_<action>` for each kit
  --drafts               the agent's edits go to drafts unless a call says `draft: false`
                         (by default edits are live and a call asks for a draft with `draft: true`);
                         a kit that declares no agent.drafts keeps none: its edits are refused
                         unless a call says `draft: false`
  --guard <mode>         how a write that passes `basis` (the `revision` of an earlier answer) is
                         checked against what others changed since: `premise` (the default)
                         refuses it as `conflict` when others deleted, moved or changed what it
                         acts on; `epoch` when anyone else changed the document at all; `off`
                         never refuses. Every mode answers what others changed (`others`)
  --require-basis        refuse `_run` and `_batch` without `basis` (`invalid-params`)
  --sandbox              run every kit process under the platform's sandbox: it reads the system's
                         files and its package, keeps its state in its private folder, and reaches
                         no other file and no network (macOS: sandbox-exec; Linux: Landlock and
                         seccomp). Elsewhere, or on a Linux kernel without Landlock, it refuses to
                         start. Off by default for now; meant to become the default
  --call-timeout-secs <n> maximum time per kit request (default 120; shorter protocol limits apply)
  --idle-timeout-secs <n> save and stop a process with no calls for this long (default 600)
  --memory-limit-mib <n>  optional per-process memory ceiling (Linux/macOS); unsupported platforms
                         refuse it. All three values must be positive integers

drafts commands (print JSON; an error is `{ \"error\": { code, message } }` and exit status 1):
  list                       the drafts in the workspace, with `state` and `stale`
  compare <path> [--previews]  what merging would change, both sides rendered with --previews
  merge <path> [--overwrite]   write the draft as the file; refused as `stale` when the file
                               changed since the draft forked, unless --overwrite
  discard <path>             drop the draft; the file stays as it is
";

/// The kits the options and the environment declare (`definitions::found`); an executable given
/// that is no known kit is an error. With a store and neither `--kit` nor `--kits-dir`, the
/// store's kits join them (a kit the environment names, `KITION_KIT_<KIT>_BINARY`, keeps its
/// executable), with the supply that installs the others.
fn found_kits(options: &Options, store: Option<Store>) -> Result<StoreKits, String> {
    let mut found = definitions::found(&options.kits, options.kits_dir.as_deref(), options.sandbox, options.limits)?;
    let Some(store) = store.filter(|_| options.kits.is_empty() && options.kits_dir.is_none()) else {
        return Ok((found, None));
    };
    let (stored, supply) = (store.kits)();
    definitions::merge(&mut found, stored);
    Ok((found, supply))
}

/// `--list-kits`: each kit found, its version, and whether its executable is there.
fn list_kits(found: &[definitions::Found]) -> Value {
    json!({
        "kits": found.iter().map(|(kit, executable)| json!({
            "id": kit.id,
            "name": kit.name,
            "prefix": kit.agent.prefix,
            "extensions": kit.extensions,
            "executable": executable.as_ref().map(|path| path.display().to_string()),
            "installed": executable.as_deref().is_some_and(Path::is_file),
            "reason": definitions::missing(&(*kit, executable.clone())),
        })).collect::<Vec<_>>()
    })
}

struct Options {
    workspace: Option<PathBuf>,
    kits: Vec<PathBuf>,
    kits_dir: Option<PathBuf>,
    drafts: bool,
    guard: tools::Guard,
    require_basis: bool,
    sandbox: bool,
    limits: crate::control::Limits,
    schemas: bool,
    list_kits: bool,
    unified: bool,
    help: bool,
    /// After `drafts`: the command, its path, and its flags.
    command: Vec<String>,
    previews: bool,
    overwrite: bool,
}

fn parse(args: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut options = Options {
        workspace: None,
        kits: Vec::new(),
        kits_dir: None,
        drafts: false,
        guard: tools::Guard::default(),
        require_basis: false,
        sandbox: false,
        limits: crate::control::Limits::default(),
        schemas: false,
        list_kits: false,
        unified: false,
        help: false,
        command: Vec::new(),
        previews: false,
        overwrite: false,
    };
    let mut args = args.peekable();
    if args.peek().map(String::as_str) == Some("drafts") {
        args.next();
        options.command.push("drafts".into());
    }
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--workspace" => options.workspace = Some(PathBuf::from(value("--workspace")?)),
            "--kit" => options.kits.push(PathBuf::from(value("--kit")?)),
            "--kits-dir" => options.kits_dir = Some(PathBuf::from(value("--kits-dir")?)),
            "--drafts" => options.drafts = true,
            "--guard" => {
                let mode = value("--guard")?;
                options.guard = tools::Guard::parse(&mode).ok_or_else(|| format!("--guard is premise, epoch or off, not {mode}"))?;
            }
            "--require-basis" => options.require_basis = true,
            "--sandbox" => options.sandbox = true,
            "--call-timeout-secs" | "--idle-timeout-secs" | "--memory-limit-mib" => options.limits.set_flag(&arg, &value(&arg)?)?,
            "--schemas" => options.schemas = true,
            "--list-kits" => options.list_kits = true,
            "--unified" => options.unified = true,
            "--previews" => options.previews = true,
            "--overwrite" => options.overwrite = true,
            "--help" | "-h" => options.help = true,
            other if !options.command.is_empty() && !other.starts_with('-') => {
                options.command.push(other.to_owned());
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    options.limits.validate()?;
    Ok(options)
}

fn print(value: &Value) {
    println!("{}", serde_json::to_string_pretty(value).unwrap_or_default());
}

async fn drafts_command(kits: &KitManager, command: &[String], options: &Options) -> ExitCode {
    let path = command.get(2).map(String::as_str);
    let answer = match (command.get(1).map(String::as_str), path) {
        (Some("list"), _) => Ok(json!({
            "drafts": kits.workspace_dir().map(drafts::list).unwrap_or_default()
        })),
        (Some("compare"), Some(path)) => drafts::compare(kits, path, options.previews).await,
        (Some("merge"), Some(path)) => drafts::merge(kits, path, options.overwrite).await,
        (Some("discard"), Some(path)) => drafts::discard(kits, path).await,
        _ => {
            eprintln!("{}", usage("kition-kits-mcp drafts", None));
            return ExitCode::from(2);
        }
    };
    kits.shutdown().await;
    match answer {
        Ok(answer) => {
            print(&answer);
            ExitCode::SUCCESS
        }
        Err(error) => {
            print(&error.to_json());
            ExitCode::FAILURE
        }
    }
}

/// The usage of `program` (`kition-kits-mcp`, `kition mcp`), with the store's section.
fn usage(program: &str, store: Option<&Store>) -> String {
    let text = USAGE.replace("kition-kits-mcp", program);
    match store {
        Some(store) => text.replacen("\nserver options:", &format!("{}\nserver options:", store.usage), 1),
        None => text,
    }
}

/// Runs `program` (`kition-kits-mcp`, or `kition mcp` with its `store`) with `args`, the
/// arguments after the program's name.
pub fn main(program: &str, args: impl Iterator<Item = String>, store: Option<Store>) -> ExitCode {
    let options = match parse(args) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("{program}: {message}\n\n{}", usage(program, store.as_ref()));
            return ExitCode::from(2);
        }
    };
    if options.help {
        print!("{}", usage(program, store.as_ref()));
        return ExitCode::SUCCESS;
    }
    if options.schemas {
        print(&tools::schemas::tool_schemas());
        return ExitCode::SUCCESS;
    }
    tools::set_unified(options.unified);
    // No fallback: a sandbox that this machine cannot give is a refusal to start, never kits run
    // unconfined.
    if options.sandbox
        && let Err(reason) = kition_kit_host::sandbox::check()
    {
        eprintln!("{program}: --sandbox: {reason}");
        return ExitCode::FAILURE;
    }
    let (found, supply) = match found_kits(&options, store) {
        Ok(found) => found,
        Err(message) => {
            eprintln!("{program}: {message}");
            return ExitCode::from(2);
        }
    };
    if !options.list_kits {
        // A kit without its executable has no tools: say so, rather than serve none silently.
        for reason in found.iter().filter_map(definitions::missing) {
            eprintln!("{program}: {reason}");
        }
    }
    if options.list_kits {
        print(&list_kits(&found));
        return ExitCode::SUCCESS;
    }
    let Some(workspace) = options.workspace.clone().filter(|dir| dir.is_dir()) else {
        eprintln!("{program}: --workspace must name a folder\n\n{USAGE}");
        return ExitCode::from(2);
    };
    let runtime = match crate::runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{program}: {error}");
            return ExitCode::FAILURE;
        }
    };
    let kits = match KitManager::new(Some(workspace), found).with_headless_drafts().with_limits(options.limits) {
        Ok(kits) => kits,
        Err(reason) => {
            eprintln!("{program}: {reason}");
            return ExitCode::FAILURE;
        }
    };
    let kits = if options.sandbox { kits.with_sandbox() } else { kits };
    let kits = match supply {
        Some(supply) => kits.with_supply(supply),
        None => kits,
    };
    if !options.command.is_empty() {
        return runtime.block_on(drafts_command(&kits, &options.command, &options));
    }
    let call = tools::CallOptions { draft: options.drafts, guard: options.guard, require_basis: options.require_basis };
    match runtime.block_on(crate::mcp::serve_stdio(kits, call)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{program}: {error}");
            ExitCode::FAILURE
        }
    }
}
