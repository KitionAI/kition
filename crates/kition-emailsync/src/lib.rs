//! Email sync: imports messages from an IMAP mailbox as Markdown documents
//! indexed by a `.kitable` table.

pub mod imap;
pub mod message;
pub mod routes;
pub mod service;
pub mod store;
pub mod types;
pub mod workspace;

pub use routes::{EmailSyncState, router, start_scheduler};
pub use service::Service;
