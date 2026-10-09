//! The Kition runtime: the local HTTP API behind the desktop app.

mod adapters;
mod agent;
mod app;
mod server;
mod system;
mod workflows;

pub use server::{RunningServer, run, start};
