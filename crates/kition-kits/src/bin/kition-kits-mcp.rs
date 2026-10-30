// Copied from kition-sdk crates/kition-kits/src/bin/kition-kits-mcp.rs by scripts/sync-kit-host.mjs; change it there, not here.
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

use kition_kits::definitions::{self, KitSources};
use kition_kits::{KitManager, drafts, tools};
use serde_json::{Value, json};

const USAGE: &str = "\
usage:
  kition-kits-mcp --workspace <folder> [options]        serve the kit tools over stdio (MCP)
  kition-kits-mcp drafts <command> --workspace <folder> [options]
                                                        review the agent's drafts (the person's side)
  kition-kits-mcp --schemas                             print the tools' argument and result schemas

  kition-kits-mcp --list-kits [kits]                     print the kits found and exit

kits (a kit is its KHP manifest, `kit.json`, and its headless executable):
  --kit <path>           a kit's headless executable; its kit.json is the nearest one above it
                         that names it (`headless.executable`), as in a kit repository; repeatable
  --kits-dir <folder>    a folder with one folder per kit holding its kit.json, and its executable
                         beside it if installed
  KITION_KIT_<KIT>_BINARY  executables named by the environment, as --kit (development builds)
  PATH                   the executable a found kit's kit.json names, on the PATH

server options:
  --unified              one set of tools for every kit (`kit_<action>`), routed by the file's
                         extension, instead of `<prefix>_<action>` for each kit
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

/// The kits the options and the environment declare (`definitions.rs`): `--kit` and the
/// environment's executables with the manifests they were built from, `--kits-dir`'s kit folders,
/// then the PATH for kits found without an executable.
fn found_kits(options: &Options) -> Vec<definitions::Found> {
    let mut executables = options.kits.clone();
    executables.extend(KitSources::executables_from_env());
    if let Some(dir) = &options.kits_dir {
        // An installed kit's executable sits in its folder beside its kit.json.
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let manifest = std::fs::read_to_string(entry.path().join("kit.json")).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
            if let Some(name) = manifest.as_ref().and_then(|manifest| manifest.pointer("/headless/executable")).and_then(Value::as_str) {
                let executable = entry.path().join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
                if executable.is_file() {
                    executables.push(executable);
                }
            }
        }
    }
    let mut found = definitions::discover(&KitSources { manifests: Vec::new(), kits_dir: options.kits_dir.clone(), executables });
    definitions::on_path(&mut found);
    found
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
        })).collect::<Vec<_>>()
    })
}

struct Options {
    workspace: Option<PathBuf>,
    kits: Vec<PathBuf>,
    kits_dir: Option<PathBuf>,
    drafts: bool,
    license: Option<String>,
    app_id: Option<String>,
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
        license: std::env::var("KITION_LICENSE").ok(),
        app_id: std::env::var("KITION_APP_ID").ok(),
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
            "--license" => options.license = Some(value("--license")?),
            "--app-id" => options.app_id = Some(value("--app-id")?),
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
    tools::set_unified(options.unified);
    let found = found_kits(&options);
    if options.list_kits {
        print(&list_kits(&found));
        return ExitCode::SUCCESS;
    }
    let Some(workspace) = options.workspace.clone().filter(|dir| dir.is_dir()) else {
        eprintln!("kition-kits-mcp: --workspace must name a folder\n\n{USAGE}");
        return ExitCode::from(2);
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("kition-kits-mcp: {error}");
            return ExitCode::FAILURE;
        }
    };
    let kits = KitManager::new(Some(workspace), found).with_headless_drafts();
    if !options.command.is_empty() {
        return runtime.block_on(drafts_command(&kits, &options.command, &options));
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or_default();
    match kition_kits::license::startup_notice(options.license.as_deref(), options.app_id.as_deref(), kition_license::PINNED_KEYS, now) {
        Ok(notice) | Err(notice) => eprintln!("{notice}"),
    }
    let call = tools::CallOptions { draft: options.drafts };
    match runtime.block_on(kition_kits::mcp::serve_stdio(kits, call)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("kition-kits-mcp: {error}");
            ExitCode::FAILURE
        }
    }
}
