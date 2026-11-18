// Copied from kition-sdk packages/sync/src/backoff.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * Reconnect backoff: 1 s for the first attempt, doubling per further attempt, capped at 30 s,
 * with equal jitter (half fixed, half random) so many clients reconnecting at once do not all
 * retry on the same tick.
 */
export const BACKOFF_BASE_MS = 1000
export const BACKOFF_CAP_MS = 30_000

/** `attempt` is 0 for the first reconnect try after a disconnect. `random` returns `[0, 1)`. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempt, 0), BACKOFF_CAP_MS)
  const half = exponential / 2
  return half + random() * half
}
