//! Shared runtime foundations: configuration, errors, localization, the HTTP
//! response envelope, millisecond timestamps, and build identity.

pub mod cloud;
pub mod coerce;
pub mod config;
pub mod error;
pub mod events;
pub mod i18n;
pub mod response;
pub mod runtime_info;
pub mod time;

pub use error::{AppError, AppResult};
pub use time::{Millis, now_millis};
