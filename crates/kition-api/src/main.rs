//! Kition runtime entry point.

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "kition-api", about = "Kition runtime", version)]
struct Cli {
    /// Configuration file. Defaults to KITION_API_CONFIG, then ../config/local.toml.
    #[arg(short = 'c', long = "config", global = true)]
    config: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Start the Kition API runtime.
    All,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let env = |key: &str| std::env::var(key).ok();
    let config_path: PathBuf =
        kition_core::config::resolve_config_path(cli.config.as_deref(), &env);
    let config = kition_core::config::load(&config_path, &env)?;
    init_logging(&config.log_level);

    match cli.command {
        Command::All => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            runtime.block_on(kition_api::run(config))
        }
    }
}

fn init_logging(level: &str) {
    let filter = tracing_subscriber::EnvFilter::try_new(level)
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}
