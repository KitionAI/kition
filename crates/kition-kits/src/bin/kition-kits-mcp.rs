//! `kition-kits-mcp`: Kition's kit tools as a stdio MCP server, for harnesses that run without
//! Kition (DeepSeek Harness through `dsh-mcp-client`, and other MCP clients). It edits files in
//! one workspace folder through each installed kit's headless executable
//! (`KITION_KIT_<KIT>_BINARY`); with Kition running, use its `POST /v1/mcp/kits` instead, which
//! also edits files open in kit editors live.
//!
//! ```text
//! kition-kits-mcp --workspace <folder>
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut workspace: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--workspace" => workspace = args.next().map(PathBuf::from),
            "--help" | "-h" => {
                eprintln!("usage: kition-kits-mcp --workspace <folder>");
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
