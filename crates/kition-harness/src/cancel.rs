//! Cooperative cancellation shared by the driver, the model call, and tools.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

/// A cancellation flag that can be awaited. Cheap to clone.
#[derive(Clone, Default)]
pub struct Cancel {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl std::fmt::Debug for Cancel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Cancel")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl Cancel {
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once [`Self::cancel`] has been called.
    pub async fn cancelled(&self) {
        loop {
            // Created before the check: `notify_waiters` wakes futures that
            // exist at the time of the call, even if not yet polled.
            let notified = self.inner.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancel_wakes_waiters_and_sticks() {
        let cancel = Cancel::default();
        let waiter = cancel.clone();
        let task = tokio::spawn(async move { waiter.cancelled().await });
        tokio::task::yield_now().await;
        cancel.cancel();
        task.await.unwrap_or_else(|error| panic!("{error}"));
        assert!(cancel.is_cancelled());
        cancel.cancelled().await;
    }

    #[test]
    fn debug_prints_the_cancelled_flag() {
        let cancel = Cancel::default();
        assert_eq!(format!("{cancel:?}"), "Cancel { cancelled: false }");
        cancel.cancel();
        assert_eq!(format!("{cancel:?}"), "Cancel { cancelled: true }");
    }
}
