//! Retrying model calls that failed before producing any output.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::error::AiResult;
use super::types::{ChatResult, StreamHandler};

pub const DEFAULT_MAX_RETRIES: u32 = 5;
pub(crate) const INITIAL_DELAY: Duration = Duration::from_secs(1);
pub(crate) const MAX_DELAY: Duration = Duration::from_secs(8);

/// Reported before each retry so the client can show progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryEvent {
    pub attempt: u32,
    pub max_retries: u32,
    pub delay: Duration,
    pub reason: String,
}

pub type RetryHandler = Arc<dyn Fn(RetryEvent) + Send + Sync>;

#[derive(Clone)]
pub(crate) struct RetryConfig {
    pub max_retries: u32,
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub on_retry: Option<RetryHandler>,
}

/// Exponential backoff: `initial * 2^(attempt-1)`, capped at `maximum`.
pub(crate) fn backoff(initial: Duration, maximum: Duration, attempt: u32) -> Duration {
    if initial.is_zero() || attempt == 0 {
        return Duration::ZERO;
    }
    let mut delay = initial;
    for _ in 1..attempt {
        if !maximum.is_zero() && delay >= maximum {
            return maximum;
        }
        delay *= 2;
    }
    if !maximum.is_zero() && delay > maximum {
        maximum
    } else {
        delay
    }
}

/// Calls `call` until it succeeds, fails for good, or has streamed output;
/// once output reached the client a retry would duplicate it.
pub(crate) async fn with_retry<F, Fut>(
    stream: Option<StreamHandler>,
    config: RetryConfig,
    mut call: F,
) -> AiResult<ChatResult>
where
    F: FnMut(Option<StreamHandler>) -> Fut,
    Fut: Future<Output = AiResult<ChatResult>>,
{
    let max_delay = config.max_delay.max(config.initial_delay);
    let mut attempt = 0;
    loop {
        let started = Arc::new(AtomicBool::new(false));
        let attempt_stream = stream.clone().map(|stream| {
            let started = started.clone();
            Arc::new(move |event| {
                started.store(true, Ordering::SeqCst);
                stream(event);
            }) as StreamHandler
        });
        let error = match call(attempt_stream).await {
            Ok(result) => return Ok(result),
            Err(error) => error,
        };
        let (retryable, reason, retry_after) = error.retry_info();
        if !retryable || started.load(Ordering::SeqCst) || attempt >= config.max_retries {
            return Err(error);
        }
        let retry_number = attempt + 1;
        let mut delay = backoff(config.initial_delay, max_delay, retry_number);
        if retry_after > delay {
            delay = if !max_delay.is_zero() && retry_after > max_delay {
                max_delay
            } else {
                retry_after
            };
        }
        if let Some(on_retry) = &config.on_retry {
            on_retry(RetryEvent {
                attempt: retry_number,
                max_retries: config.max_retries,
                delay,
                reason: reason.to_owned(),
            });
        }
        tokio::time::sleep(delay).await;
        attempt = retry_number;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::super::error::AiError;
    use super::super::types::StreamEvent;
    use super::*;

    fn retryable() -> AiError {
        AiError::Provider {
            message: "busy".into(),
            retryable: true,
            reason: "server_unavailable".into(),
            retry_after: Duration::ZERO,
        }
    }

    fn config(events: Arc<Mutex<Vec<RetryEvent>>>) -> RetryConfig {
        RetryConfig {
            max_retries: 2,
            initial_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(4),
            on_retry: Some(Arc::new(move |event| {
                events.lock().map(|mut list| list.push(event)).ok();
            })),
        }
    }

    #[test]
    fn backs_off_exponentially() {
        let second = Duration::from_secs(1);
        assert_eq!(backoff(second, 8 * second, 1), second);
        assert_eq!(backoff(second, 8 * second, 3), 4 * second);
        assert_eq!(backoff(second, 8 * second, 9), 8 * second);
        assert_eq!(backoff(Duration::ZERO, second, 2), Duration::ZERO);
    }

    #[tokio::test]
    async fn retries_until_success_or_limit() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let calls = Arc::new(Mutex::new(0));
        let counter = calls.clone();
        let result = with_retry(None, config(events.clone()), move |_| {
            let counter = counter.clone();
            async move {
                let mut count = counter.lock().map_err(|_| AiError::msg("lock"))?;
                *count += 1;
                if *count < 3 {
                    Err(retryable())
                } else {
                    Ok(ChatResult::default())
                }
            }
        })
        .await;
        assert!(result.is_ok());
        assert_eq!(events.lock().map(|e| e.len()).unwrap_or_default(), 2);

        let failed = with_retry(None, config(Arc::default()), |_| async { Err(retryable()) }).await;
        assert!(failed.is_err());
    }

    #[tokio::test]
    async fn never_retries_after_streaming_started() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let stream: StreamHandler = Arc::new(|_| {});
        let result = with_retry(Some(stream), config(events.clone()), |attempt| async move {
            if let Some(stream) = attempt {
                stream(StreamEvent::default());
            }
            Err(retryable())
        })
        .await;
        assert!(result.is_err());
        assert!(events.lock().map(|e| e.is_empty()).unwrap_or(false));
    }
}
