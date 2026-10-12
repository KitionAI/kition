//! The workspace agent: chat sessions, the streamed agent turn, and the
//! tools it can use on the workspace, data tables, the web, and the
//! user's shell.

mod attachments;
pub mod catalog;
pub mod execpolicy;
mod fuzzy;
mod log;
pub mod mcp;
mod model;
mod prompts;
mod providers;
mod routes;
mod run;
mod session;
mod sources;
pub mod store;
mod stream;
mod tools;
mod turn;
mod workspace;

pub use routes::{AgentState, router};
pub use run::{Agent, AgentConfig, HookDispatch, SmtpConfigurator, WorkflowPrompt};
