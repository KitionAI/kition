//! `kition-kits-mcp`: Kition's kit tools as a stdio MCP server, for harnesses that run without
//! Kition (DeepSeek Harness through `dsh-mcp-client`, and other MCP clients). It edits files in
//! one workspace folder through each installed kit's headless executable
//! (`KITION_KIT_<KIT>_BINARY`); with Kition running, use its `POST /v1/mcp/kits` instead, which
//! also edits files open in kit editors live.
//!
//! ```text
//! kition-kits-mcp --workspace <folder> [--license <key>] [--app-id <id>]
//! ```
//!
//! The SDK licence key (`--license`, or `KITION_LICENSE`) is verified offline at start; without a
//! valid one the server still serves and warns on stderr (kition-sdk docs/licence.md). `--app-id`
//! (or `KITION_APP_ID`) names the application when the licence binds application ids.

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut workspace: Option<PathBuf> = None;
    let mut license = std::env::var("KITION_LICENSE").ok();
    let mut app_id = std::env::var("KITION_APP_ID").ok();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--workspace" => workspace = args.next().map(PathBuf::from),
            "--license" => license = args.next(),
            "--app-id" => app_id = args.next(),
            "--help" | "-h" => {
                eprintln!(
                    "usage: kition-kits-mcp --workspace <folder> [--license <key>] [--app-id <id>]"
                );
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("kition-kits-mcp: unknown argument {other}");
                return ExitCode::from(2);
            }
        }
    }
    let Some(workspace) = workspace.filter(|dir| dir.is_dir()) else {
        eprintln!("kition-kits-mcp: --workspace must name a folder");
        return ExitCode::from(2);
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default();
    match kition_kits::license::startup_notice(
        license.as_deref(),
        app_id.as_deref(),
        kition_license::PINNED_KEYS,
        now,
    ) {
        Ok(notice) | Err(notice) => eprintln!("{notice}"),
    }
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
    let kits = kition_kits::KitManager::from_env(Some(workspace));
    match runtime.block_on(kition_kits::mcp::serve_stdio(kits)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("kition-kits-mcp: {error}");
            ExitCode::FAILURE
        }
    }
}
