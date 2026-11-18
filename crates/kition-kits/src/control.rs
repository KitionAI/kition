// Copied from kition-sdk crates/kition-kits/src/control.rs by scripts/sync-kit-host.mjs; change it there, not here.
//! Host policy, independent of the kit's wire-level timeout defaults.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

#[derive(Debug)]
pub(crate) struct Activity {
    pub(crate) active: usize,
    pub(crate) last: std::time::Instant,
    pub(crate) stopped: bool,
}

impl Default for Activity {
    fn default() -> Self {
        Self { active: 0, last: std::time::Instant::now(), stopped: false }
    }
}

pub(crate) fn idle_due(active: usize, elapsed: Duration, limit: Duration) -> bool {
    active == 0 && elapsed >= limit
}

pub(crate) struct Lease<'a>(pub(crate) &'a Mutex<Activity>);

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let mut activity = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        activity.active -= 1;
        activity.last = std::time::Instant::now();
    }
}

tokio::task_local! {
    /// The logical workspace document of the complete host call, including its draft.
    pub(crate) static DOCUMENT: String;
}

/// FIFO admission for complete host operations, across both kit connections and all clients.
/// The kit server's existing worker still orders individual wire messages; this gate covers
/// the open/guard/edit/save/journal transaction that spans several such messages.
#[derive(Default)]
pub(crate) struct Documents {
    tails: Mutex<HashMap<String, tokio::sync::watch::Receiver<bool>>>,
}

pub(crate) struct Ticket {
    previous: tokio::sync::watch::Receiver<bool>,
    done: Option<tokio::sync::watch::Sender<bool>>,
}

impl Documents {
    pub(crate) fn reserve(&self, key: &str) -> Ticket {
        let mut tails = self.tails.lock().unwrap_or_else(PoisonError::into_inner);
        let (done, next) = tokio::sync::watch::channel(false);
        let previous = tails.insert(key.to_owned(), next).unwrap_or_else(|| tokio::sync::watch::channel(true).1);
        Ticket { previous, done: Some(done) }
    }
}

impl Ticket {
    pub(crate) async fn enter(&mut self) {
        let _ = self.previous.wait_for(|done| *done).await;
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let Some(done) = self.done.take() else { return };
        if *self.previous.borrow() {
            let _ = done.send(true);
        } else {
            // A cancelled waiter must not let the next arrival overtake its predecessor.
            let mut previous = self.previous.clone();
            tokio::spawn(async move {
                let _ = previous.wait_for(|done| *done).await;
                let _ = done.send(true);
            });
        }
    }
}

/// Resource policy for processes started by a manager.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub call_timeout: Duration,
    pub idle_timeout: Duration,
    pub memory_limit_bytes: Option<u64>,
}

impl Default for Limits {
    fn default() -> Self {
        Self { call_timeout: Duration::from_secs(120), idle_timeout: Duration::from_secs(600), memory_limit_bytes: None }
    }
}

impl Limits {
    pub fn set_flag(&mut self, flag: &str, value: &str) -> Result<(), String> {
        let number = value.parse::<u64>().ok().filter(|number| *number > 0).ok_or_else(|| format!("{flag} needs a positive integer"))?;
        match flag {
            "--call-timeout-secs" => self.call_timeout = Duration::from_secs(number),
            "--idle-timeout-secs" => self.idle_timeout = Duration::from_secs(number),
            "--memory-limit-mib" => self.memory_limit_bytes = Some(number.checked_mul(1024 * 1024).ok_or("memory limit is too large")?),
            _ => return Err(format!("unknown resource setting {flag}")),
        }
        if std::time::Instant::now().checked_add(self.call_timeout.max(self.idle_timeout)).is_none() {
            return Err(format!("{flag} is too large"));
        }
        Ok(())
    }

    pub fn validate(self) -> Result<Self, String> {
        if self.call_timeout.is_zero() || self.idle_timeout.is_zero() || self.memory_limit_bytes == Some(0) {
            return Err("call timeout, idle timeout and memory limit must be positive".into());
        }
        if std::time::Instant::now().checked_add(self.call_timeout.max(self.idle_timeout)).is_none() {
            return Err("call timeout or idle timeout is too large".into());
        }
        if let Some(bytes) = self.memory_limit_bytes {
            kition_kit_host::memory::check(bytes)?;
        }
        Ok(self)
    }

    /// Preserve the protocol's shorter handshake/control deadlines, while bounding document
    /// operations too. Progress never extends the operator's deadline.
    pub fn deadline(self, method: &str) -> Duration {
        if method == "kit.shutdown" {
            return kition_kit_process_protocol::launch::SHUTDOWN_TIMEOUT.min(self.call_timeout);
        }
        kition_kit_process_protocol::launch::request_timeout(method).map_or(self.call_timeout, |limit| limit.min(self.call_timeout))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_method_has_a_deadline() {
        let limits = Limits::default();
        for method in ["document.open", "document.save", "commands.execute", "model.batch"] {
            assert!(!limits.deadline(method).is_zero());
            assert!(limits.deadline(method) <= limits.call_timeout);
        }
        assert_eq!(limits.deadline("kit.initialize"), Duration::from_secs(10));
        assert_eq!(limits.deadline("kit.shutdown"), Duration::from_secs(5));
        let short = Limits { call_timeout: Duration::from_secs(2), ..limits };
        assert_eq!(short.deadline("kit.initialize"), Duration::from_secs(2));
        assert!(Limits { call_timeout: Duration::ZERO, ..limits }.validate().is_err());
        assert!(Limits { call_timeout: Duration::MAX, ..limits }.validate().is_err());
    }

    #[tokio::test]
    async fn documents_are_fifo_independent_and_cancelled_waiters_do_not_overtake() {
        let queues = Documents::default();
        let mut first = queues.reserve("a");
        first.enter().await;
        let second = queues.reserve("a");
        let mut third = queues.reserve("a");
        let mut other = queues.reserve("b");
        other.enter().await;
        drop(second);
        assert!(!*third.previous.borrow());
        drop(first);
        third.enter().await;
        assert!(*third.previous.borrow());
    }

    #[test]
    fn idle_reclaim_never_interrupts_a_call() {
        let limit = Duration::from_secs(10);
        assert!(!idle_due(1, limit * 2, limit));
        assert!(!idle_due(0, limit - Duration::from_nanos(1), limit));
        assert!(idle_due(0, limit, limit));
        let activity = Mutex::new(Activity { active: 1, last: std::time::Instant::now(), stopped: false });
        drop(Lease(&activity));
        assert_eq!(activity.lock().unwrap().active, 0);
    }

    #[test]
    fn resource_flags_reject_zero_negative_and_overflow() {
        let mut limits = Limits::default();
        limits.set_flag("--call-timeout-secs", "7").unwrap();
        limits.set_flag("--idle-timeout-secs", "11").unwrap();
        limits.set_flag("--memory-limit-mib", "64").unwrap();
        assert_eq!(limits.call_timeout, Duration::from_secs(7));
        assert_eq!(limits.idle_timeout, Duration::from_secs(11));
        assert_eq!(limits.memory_limit_bytes, Some(64 * 1024 * 1024));
        for value in ["0", "-1", "x", "1.5"] {
            assert!(limits.set_flag("--call-timeout-secs", value).is_err());
        }
        assert!(limits.set_flag("--memory-limit-mib", "18446744073709551615").is_err());
    }
}
