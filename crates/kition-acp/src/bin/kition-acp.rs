//! `kition-acp`: Kition's agent as an Agent Client Protocol server on stdio, for editors and other
//! ACP clients. It drives the agent of a running Kition through its loopback API.
//!
//! ```text
//! kition-acp --url http://127.0.0.1:<port>/api/v1 --model-file <model.json>
//! ```
//!
//! The model file is Kition's `RuntimeModel` JSON (`provider_type`, `model_name`, `base_url`,
//! `api_key`, `wire_api`, …): Kition keeps the person's model settings in its own window, so an
//! ACP client names the model its agent uses. Keep the file outside any repository.

use std::process::ExitCode;
use std::sync::Arc;

use clap::Parser;
use kition_acp::{HttpRuntime, Options};
use serde_json::Value;

#[derive(Parser)]
#[command(
    name = "kition-acp",
    about = "Kition's agent over the Agent Client Protocol (stdio)"
)]
struct Args {
    /// Kition's loopback API, for example http://127.0.0.1:<port>/api/v1.
    #[arg(long, env = "KITION_API_URL")]
    url: String,
    /// A bearer token, when the runtime requires one.
    #[arg(long, env = "KITION_API_TOKEN", hide_env_values = true)]
    token: Option<String>,
    /// The model of every turn: a file with Kition's `RuntimeModel` JSON.
    #[arg(long, env = "KITION_ACP_MODEL_FILE")]
    model_file: Option<std::path::PathBuf>,
    /// How the agent edits kit documents: `live` or `draft`.
    #[arg(long, default_value = "live")]
    kit_edit_mode: String,
}

fn main() -> ExitCode {
    let args = Args::parse();
    let model = match &args.model_file {
        None => None,
        Some(path) => match std::fs::read_to_string(path)
            .map_err(|error| error.to_string())
            .and_then(|text| {
                serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())
            }) {
            Ok(model) => Some(model),
            Err(error) => {
                eprintln!("kition-acp: cannot read the model file: {error}");
                return ExitCode::from(2);
            }
        },
    };
    let runtime = match HttpRuntime::new(&args.url, args.token) {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("kition-acp: {error}");
            return ExitCode::from(2);
        }
    };
    let tokio = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(tokio) => tokio,
        Err(error) => {
            eprintln!("kition-acp: {error}");
            return ExitCode::FAILURE;
        }
    };
    let options = Options {
        model,
        kit_edit_mode: args.kit_edit_mode,
    };
    match tokio.block_on(kition_acp::serve(
        Arc::new(runtime),
        tokio::io::stdin(),
        tokio::io::stdout(),
        options,
    )) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("kition-acp: {error}");
            ExitCode::FAILURE
        }
    }
}
