//! Form sync: forms published through Kition Cloud whose submissions are
//! imported into data document tables.

pub mod cloud;
pub mod routes;
pub mod service;
pub mod store;
pub mod types;

pub use routes::{FormSyncState, router, start_scheduler};
pub use service::{Service, TableField, TableRecord, TableWriter};
