/**
 * Helpers for detecting and reporting the structured `credits_exhausted`
 * error that the KitionAI Console hosted LLM proxy returns when the active
 * portal account has no remaining credit balance.
 *
 * The console returns the following shape with HTTP 402:
 *
 *   {
 *     "error": {
 *       "code": "credits_exhausted",
 *       "type": "billing",
 *       "message": "Console credits are exhausted",
 *       "topup_url": "https://kition.ai/app/billing"
 *     }
 *   }
 *
 * This module normalises that shape regardless of whether the payload arrives
 * through axios (`request.ts`) or NDJSON streaming (`stream.ts`), and lets
 * any UI surface subscribe to a single global "credits exhausted" event so we
 * can render a non-blocking top-up card without coupling the AI call sites
 * to the presentation layer.
 */

export const CONSOLE_CREDITS_EXHAUSTED_CODE = 'credits_exhausted'
export const CONSOLE_CREDITS_EXHAUSTED_EVENT = 'console-credits-exhausted'
/**
 * Fallback billing URL used by pre-warning surfaces (e.g. the credit badge in
 * the workspace sidebar) when no live 402 detail is available. The 402
 * response still carries its own `topup_url` for the exhausted banner — this
 * constant only powers proactive CTAs shown before exhaustion.
 */
export const DEFAULT_CONSOLE_TOPUP_URL = 'https://kition.ai/app/billing'

export type ConsoleCreditsExhaustedDetail = {
  message: string
  topupUrl: string
  code: string
  source?: 'chat' | 'agent' | 'image' | 'unknown'
}

function trimString(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value.trim()
}

function normalizeBillingURL(value: unknown) {
  const raw = trimString(value)
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : ''
  } catch {
    return ''
  }
}

function readErrorRecord(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const record = payload as Record<string, unknown>
  // Direct shape: { code, message, topup_url }
  if (typeof record.code === 'string' || typeof record.topup_url === 'string') {
    return record
  }
  // Wrapped shape: { error: { code, message, topup_url } } — what the console
  // returns. axios passes the parsed body as `response.data`, which already
  // matches this shape.
  const inner = record.error
  if (inner && typeof inner === 'object') {
    return inner as Record<string, unknown>
  }
  // Sometimes the body is stringified into a `detail` field by FastAPI-style
  // wrappers; defend against that case too.
  if (typeof record.detail === 'string') {
    try {
      return readErrorRecord(JSON.parse(record.detail))
    } catch {
      return null
    }
  }
  return null
}

/**
 * Try to decode a console credits-exhausted error from a parsed response
 * payload or thrown error. Returns null if the payload does not match.
 */
export function parseConsoleCreditsExhausted(
  payload: unknown,
): ConsoleCreditsExhaustedDetail | null {
  // Strings: try to JSON-parse, otherwise treat as message only.
  if (typeof payload === 'string') {
    const trimmed = payload.trim()
    if (!trimmed) {
      return null
    }
    try {
      return parseConsoleCreditsExhausted(JSON.parse(trimmed))
    } catch {
      return null
    }
  }

  if (payload instanceof Error) {
    // The interceptor pins the structured detail onto the error so downstream
    // handlers can react without re-parsing the payload.
    const detail = (payload as Error & { consoleCreditsExhausted?: ConsoleCreditsExhaustedDetail })
      .consoleCreditsExhausted
    if (detail && detail.code === CONSOLE_CREDITS_EXHAUSTED_CODE) {
      return detail
    }
    // Fall back to parsing the message text in case the structured detail
    // wasn't attached (e.g. SSE error frames carry only `message`).
    return parseConsoleCreditsExhausted(payload.message)
  }

  const record = readErrorRecord(payload)
  if (!record) {
    return null
  }

  const code = trimString(record.code) || trimString((record as Record<string, unknown>).type)
  if (code !== CONSOLE_CREDITS_EXHAUSTED_CODE) {
    return null
  }
  const topupUrl = normalizeBillingURL(record.topup_url) || normalizeBillingURL((record as Record<string, unknown>).topupUrl)
  const message = trimString(record.message) || 'Your Kition credits are exhausted.'
  return {
    code: CONSOLE_CREDITS_EXHAUSTED_CODE,
    message,
    topupUrl,
  }
}

/**
 * Attach a structured credits-exhausted detail to an Error so downstream
 * handlers can use `parseConsoleCreditsExhausted(error)` later.
 */
export function pinConsoleCreditsExhausted(
  error: Error,
  detail: ConsoleCreditsExhaustedDetail,
) {
  (error as Error & { consoleCreditsExhausted?: ConsoleCreditsExhaustedDetail })
    .consoleCreditsExhausted = detail
}

/**
 * Broadcast a credits-exhausted notice to any listening UI surface. The
 * notice is purely advisory — call sites still throw / reject normally so
 * the user sees the error inline as well as the top-up card.
 */
export function emitConsoleCreditsExhausted(detail: ConsoleCreditsExhaustedDetail) {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(
    new CustomEvent<ConsoleCreditsExhaustedDetail>(CONSOLE_CREDITS_EXHAUSTED_EVENT, {
      detail,
    }),
  )
}

/**
 * Subscribe to credits-exhausted events. Returns an unsubscribe function.
 */
export function subscribeConsoleCreditsExhausted(
  handler: (detail: ConsoleCreditsExhaustedDetail) => void,
) {
  if (typeof window === 'undefined') {
    return () => {}
  }
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ConsoleCreditsExhaustedDetail>).detail
    if (detail) {
      handler(detail)
    }
  }
  window.addEventListener(CONSOLE_CREDITS_EXHAUSTED_EVENT, listener)
  return () => window.removeEventListener(CONSOLE_CREDITS_EXHAUSTED_EVENT, listener)
}

/**
 * Convenience helper: try to parse a payload, and if it matches, emit the
 * event and return the parsed detail (so the caller can also attach it to
 * an Error). Returns null if the payload is not a credits-exhausted error.
 */
export function tryReportConsoleCreditsExhausted(
  payload: unknown,
  source: ConsoleCreditsExhaustedDetail['source'] = 'unknown',
): ConsoleCreditsExhaustedDetail | null {
  const detail = parseConsoleCreditsExhausted(payload)
  if (!detail) {
    return null
  }
  const enriched: ConsoleCreditsExhaustedDetail = { ...detail, source }
  emitConsoleCreditsExhausted(enriched)
  return enriched
}
