//! `kition-kits-mcp`: Kition's kit tools as a stdio MCP server, for harnesses that run without
//! Kition (DeepSeek Harness through `dsh-mcp-client`, and other MCP clients). It edits files in
//! one workspace folder through each installed kit's headless executable; with Kition running,
//! use its `POST /v1/mcp/kits` instead, which also edits files open in kit editors live.
//!
//! The agent's drafts (`draft: true`) live in the workspace's `.kition/drafts/` (`drafts.rs`);
//! the person reviews and merges them with `kition-kits-mcp drafts`, never the agent. See
//! [`USAGE`] for every option.
//!
//! The SDK licence key (`--license`, or `KITION_LICENSE`) is verified offline at start; without a
//! valid one the server still serves and warns on stderr (kition-sdk docs/platform/licence.md). `--app-id`
//! (or `KITION_APP_ID`) names the application when the licence binds application ids.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use kition_kits::{KITS, KitDefinition, KitManager, drafts, tools};
use serde_json::{Value, json};

const USAGE: &str = "\
usage:
  kition-kits-mcp --workspace <folder> [options]        serve the kit tools over stdio (MCP)
  kition-kits-mcp drafts <command> --workspace <folder> [options]
                                                        review the agent's drafts (the person's side)
  kition-kits-mcp --schemas                             print the tools' argument and result schemas

kits (each kit's headless executable, `kit-<kit>`; the first found wins):
  --kit <kit>=<path>     the executable of <kit> (`slide` or `kit.slide`); repeatable
  KITION_KIT_<KIT>_BINARY  the same, from the environment (KITION_KIT_SLIDE_BINARY)
  --kits-dir <folder>    a folder holding `kit-<kit>` executables
  PATH                   `kit-<kit>` on the PATH

server options:
  --drafts               the agent's edits go to drafts unless a call says `draft: false`
                         (by default edits are live and a call asks for a draft with `draft: true`)
  --license <key>        the SDK licence key (or KITION_LICENSE); without a valid one the server warns
  --app-id <id>          the application the licence names (or KITION_APP_ID)

drafts commands (print JSON; an error is `{ \"error\": { code, message } }` and exit status 1):
  list                       the drafts in the workspace, with `state` and `stale`
  compare <path> [--previews]  what merging would change, both sides rendered with --previews
  merge <path> [--overwrite]   write the draft as the file; refused as `stale` when the file
                               changed since the draft forked, unless --overwrite
  discard <path>             drop the draft; the file stays as it is
";

/// The executable of each kit, from `--kit`, the environment, `--kits-dir`, or the PATH.
fn kit_binaries(
    flags: &[(String, PathBuf)],
    kits_dir: Option<&Path>,
) -> Vec<(&'static KitDefinition, Option<PathBuf>)> {
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    KITS.iter()
        .map(|kit| {
            let short = kit.id.strip_prefix("kit.").unwrap_or(kit.id);
            let file = format!("kit-{short}{}", std::env::consts::EXE_SUFFIX);
            let flagged = flags
                .iter()
                .find(|(name, _)| name == short || name == kit.id)
                .map(|(_, path)| path.clone());
            let from_env = std::env::var_os(kit.binary_env)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from);
            let found = flagged.or(from_env).or_else(|| {
                kits_dir
                    .into_iter()
                    .chain(path_dirs.iter().map(PathBuf::as_path))
                    .map(|dir| dir.join(&file))
                    .find(|candidate| candidate.is_file())
            });
            (kit, found)
        })
        .collect()
}

struct Options {
    workspace: Option<PathBuf>,
    kits: Vec<(String, PathBuf)>,
    kits_dir: Option<PathBuf>,
    drafts: bool,
    license: Option<String>,
    app_id: Option<String>,
    schemas: bool,
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
        license: std::env::var("KITION_LICENSE").ok(),
        app_id: std::env::var("KITION_APP_ID").ok(),
        schemas: false,
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
            "--kit" => {
                let given = value("--kit")?;
                let (kit, path) = given
                    .split_once('=')
                    .ok_or_else(|| format!("--kit takes <kit>=<path>, not `{given}`"))?;
                options.kits.push((kit.to_owned(), PathBuf::from(path)));
            }
            "--kits-dir" => options.kits_dir = Some(PathBuf::from(value("--kits-dir")?)),
            "--drafts" => options.drafts = true,
            "--license" => options.license = Some(value("--license")?),
            "--app-id" => options.app_id = Some(value("--app-id")?),
            "--schemas" => options.schemas = true,
            "--previews" => options.previews = true,
            "--overwrite" => options.overwrite = true,
            "--help" | "-h" => options.help = true,
            other if !options.command.is_empty() && !other.starts_with('-') => {
                options.command.push(other.to_owned());
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(options)
}

fn print(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_default()
    );
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
            eprintln!("{USAGE}");
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

fn main() -> ExitCode {
    let options = match parse(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("kition-kits-mcp: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    if options.help {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if options.schemas {
        print(&tools::schemas::tool_schemas());
        return ExitCode::SUCCESS;
    }
    let Some(workspace) = options.workspace.clone().filter(|dir| dir.is_dir()) else {
        eprintln!("kition-kits-mcp: --workspace must name a folder\n\n{USAGE}");
        return ExitCode::from(2);
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("kition-kits-mcp: {error}");
            return ExitCode::FAILURE;
        }
    };
    let binaries = kit_binaries(&options.kits, options.kits_dir.as_deref());
    let kits = KitManager::new(Some(workspace), binaries).with_headless_drafts();
    if !options.command.is_empty() {
        return runtime.block_on(drafts_command(&kits, &options.command, &options));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    match kition_kits::license::startup_notice(
        options.license.as_deref(),
        options.app_id.as_deref(),
        kition_license::PINNED_KEYS,
        now,
    ) {
        Ok(notice) | Err(notice) => eprintln!("{notice}"),
    }
    let call = tools::CallOptions {
        draft: options.drafts,
    };
    match runtime.block_on(kition_kits::mcp::serve_stdio(kits, call)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("kition-kits-mcp: {error}");
            ExitCode::FAILURE
        }
    }
}
