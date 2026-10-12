//! Runs the Kit Protocol conformance suite against a kit executable.
//!
//! ```text
//! kition-kit-conformance --kit <executable> --manifest <kit.json> \
//!   --fixture <document> --edit-command <command id> --edit-params '<json object>'
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use kition_kit_conformance::{Fixture, Options, run};
use serde_json::{Map, Value};

#[derive(Parser)]
#[command(about = "Kit Protocol conformance suite")]
struct Args {
    /// The kit executable.
    #[arg(long)]
    kit: PathBuf,
    /// The kit's kit.json manifest.
    #[arg(long)]
    manifest: Option<PathBuf>,
    /// A document the kit opens; it is copied into a temporary workspace.
    #[arg(long)]
    fixture: PathBuf,
    /// A command that changes the fixture.
    #[arg(long)]
    edit_command: String,
    /// Parameters for the edit command, as a JSON object.
    #[arg(long, default_value = "{}")]
    edit_params: String,
}

fn main() -> ExitCode {
    let args = Args::parse();
    let edit_params: Map<String, Value> = match serde_json::from_str(&args.edit_params) {
        Ok(params) => params,
        Err(error) => {
            eprintln!("--edit-params must be a JSON object: {error}");
            return ExitCode::from(2);
        }
    };
    let contents = match std::fs::read(&args.fixture) {
        Ok(contents) => contents,
        Err(error) => {
            eprintln!("cannot read {}: {error}", args.fixture.display());
            return ExitCode::from(2);
        }
    };
    let Some(file_name) = args
        .fixture
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
    else {
        eprintln!("--fixture must name a file");
        return ExitCode::from(2);
    };
    let options = Options {
        executable: args.kit,
        manifest: args.manifest,
        fixture: Fixture {
            file_name,
            contents,
            edit_command: args.edit_command,
            edit_params,
        },
        env: Vec::new(),
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let report = runtime.block_on(run(&options));
    print!("{}", report.render());
    if report.passed() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
