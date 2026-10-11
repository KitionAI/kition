//! The workspace agent: chat sessions, the streamed tool loop, and the
//! tools it can use on the workspace, data tables, the web, and the
//! user's shell.

mod attachments;
pub mod catalog;
pub mod execpolicy;
mod fuzzy;
mod harness_turn;
pub mod mcp;
mod prompts;
mod routes;
mod run;
mod session;
mod sources;
pub mod store;
mod stream;
mod table_plan;
mod tools;
mod turn;
mod workspace;

pub use routes::{AgentState, router};
pub use run::{Agent, AgentConfig, HookDispatch, SmtpConfigurator, WorkflowPrompt};
