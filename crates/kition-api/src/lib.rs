//! The Kition runtime: the local HTTP API behind the desktop app.

mod agent;
mod app;
mod kit_images;
mod server;
mod system;

pub use server::{RunningServer, run, start};
