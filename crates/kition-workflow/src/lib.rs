//! Table automations: a trigger (record event, schedule, or record date), an
//! optional filter, and an action (email, notification, or record write).

pub mod cron;
pub mod dispatch;
pub mod engine;
pub mod expr;
pub mod gofmt;
pub mod govec;
pub mod mail;
pub mod routes;
pub mod store;
pub mod template;
pub mod types;
pub mod validate;

pub use engine::{Connections, Engine, LegacySmtp, RecordView, Tables};
pub use routes::{TOOL_NOT_INVOKED, WorkflowAi, WorkflowState, emit_workflow_schema, router};
