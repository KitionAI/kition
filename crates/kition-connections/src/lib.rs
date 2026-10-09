//! Outbound service connections. The only channel today is `email_smtp`;
//! secrets are sealed with a per-installation key.

pub mod channel;
pub mod proxy;
pub mod routes;
pub mod secret;
pub mod smtp;
pub mod store;

pub use routes::{ConnectionsState, UsedByCounter, router};
pub use secret::{SecretBag, SecretStore};
pub use store::{Connection, Store, TestResult};
