/**
 * A stopped turn releases its session a moment after the stream closes, so
 * a send right after Stop can meet a 409 "still answering". Such a send is
 * retried briefly before the error is shown. A 409 is answered before any
 * frame is streamed, so a retry never repeats visible work.
 */

const SESSION_BUSY_RETRIES = 5
const SESSION_BUSY_RETRY_DELAY_MS = 400

/** Whether `error` is the runtime refusing a turn while another one runs. */
export function isSessionBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const status = (error as Error & { status?: number }).status
  return status === 409 && /still answering/i.test(error.message)
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** Runs `send`, retrying a busy-session refusal up to `retries` times. */
export async function retryWhileSessionBusy<T>(
  send: () => Promise<T>,
  options: { signal?: AbortSignal; retries?: number; delayMs?: number } = {},
): Promise<T> {
  const retries = options.retries ?? SESSION_BUSY_RETRIES
  const delayMs = options.delayMs ?? SESSION_BUSY_RETRY_DELAY_MS
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send()
    } catch (error) {
      if (attempt >= retries || options.signal?.aborted || !isSessionBusyError(error)) throw error
      await wait(delayMs, options.signal)
      if (options.signal?.aborted) throw error
    }
  }
}
