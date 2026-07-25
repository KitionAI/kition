import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getCurrentLocale } from '@/i18n'
import { resolveApiURL } from '@/services/desktop'

import {
  parseScenarioBuildEvent,
  type ScenarioBuildEvent,
  type ScenarioBuildStatus,
  type UseScenarioBuildResult,
} from '@/features/scenario/types'

/** Endpoint path passed to `resolveApiURL` (which prepends `/api`). */
const BUILD_PATH = '/v1/scenarios/build'

/**
 * Read a Server-Sent-Events stream and yield typed `ScenarioBuildEvent`s as
 * they arrive.
 *
 * Implements the subset of the HTML5 SSE parsing algorithm we need:
 *   - frames are separated by a blank line (`\n\n`); CRLF tolerated
 *   - each frame is a sequence of fields `field: value` lines
 *   - within a frame, `data:` lines are concatenated with `\n`
 *   - lines starting with `:` are comments (ignored)
 *   - any other field name (e.g. `event:`, `id:`) is ignored — the orchestrator
 *     only emits `data:` frames
 *
 * Empty `data:` payloads are silently skipped (keepalive). Unknown event kinds
 * (i.e. `parseScenarioBuildEvent` returns null) emit a `console.warn` and are
 * skipped — the stream continues. This makes the parser forward-compatible with
 * new server-side event kinds without tearing down the stream.
 */
async function* readSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ScenarioBuildEvent, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const flushFrame = (frame: string): ScenarioBuildEvent | null => {
    if (!frame) return null
    const lines = frame.split('\n')
    const dataParts: string[] = []
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line === '' || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      if (field !== 'data') continue
      let value = colon === -1 ? '' : line.slice(colon + 1)
      // Per the SSE spec, a single leading space after the colon is stripped.
      if (value.startsWith(' ')) value = value.slice(1)
      dataParts.push(value)
    }
    if (dataParts.length === 0) return null
    const payload = dataParts.join('\n')
    // Empty payload = keepalive ping — silently skip.
    if (payload.trim() === '') return null
    const event = parseScenarioBuildEvent(payload)
    if (!event) {
      // Unknown kind or wrong shape — warn and skip for forward-compatibility.
      // (parseScenarioBuildEvent also returns null for invalid JSON, so malformed
      // JSON also degrades gracefully here.)
      console.warn('[useScenarioBuild] skipping unknown SSE frame', payload)
      return null
    }
    return event
  }

  // Split on either CRLF-CRLF or LF-LF (frame terminators). We treat any pair
  // of consecutive line breaks as the boundary, with mixed forms tolerated by
  // normalising `\r\n` to `\n` before splitting.
  const splitFrames = (): string[] => {
    const normalised = buffer.replace(/\r\n/g, '\n')
    const parts = normalised.split('\n\n')
    // Last element is the (possibly incomplete) tail.
    buffer = parts.pop() ?? ''
    return parts
  }

  // Track whether we reached EOF cleanly so the finally block knows whether
  // to cancel the underlying network socket.
  let reachedEOF = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        reachedEOF = true
        break
      }
      buffer += decoder.decode(value, { stream: true })
      for (const frame of splitFrames()) {
        const event = flushFrame(frame)
        if (event) yield event
      }
    }
    // Flush whatever decoder buffered, then any remaining single frame.
    buffer += decoder.decode()
    const tail = buffer.replace(/\r\n/g, '\n').replace(/\n+$/, '')
    if (tail) {
      const event = flushFrame(tail)
      if (event) yield event
    }
    buffer = ''
  } finally {
    // On non-EOF exits (consumer return, inline error, AbortError, etc.) cancel
    // the underlying network socket before releasing the lock so the stream is
    // fully cleaned up and the reader lock does not linger.
    if (!reachedEOF) {
      try {
        await reader.cancel()
      } catch {
        // Ignore cancel errors (e.g. stream already errored).
      }
    }
    reader.releaseLock()
  }
}

async function readErrorBody(response: Response): Promise<string> {
  let text = ''
  try {
    text = await response.text()
  } catch {
    text = ''
  }
  const trimmed = text.trim()
  if (!trimmed) return `Request failed (${response.status})`
  try {
    const payload = JSON.parse(trimmed)
    if (payload && typeof payload === 'object') {
      const message =
        (payload as Record<string, unknown>).message ??
        (payload as Record<string, unknown>).detail ??
        (payload as Record<string, unknown>).error
      if (typeof message === 'string' && message) return message
    }
  } catch {
    // Plain text body — fall through.
  }
  return trimmed
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * React hook that drives the scenario build SSE pipeline. The caller renders
 * progress in response to `events` / `status`, and triggers navigation when
 * `baseId` becomes non-null.
 *
 * State invariants:
 *   - `submit()` is single-shot: a second call while `status` is `submitting`
 *     or `streaming` rejects without touching state.
 *   - `reset()` aborts any in-flight stream and returns to `idle`.
 *   - On unmount, the in-flight request is aborted and no further setState
 *     fires.
 */
export function useScenarioBuild(): UseScenarioBuildResult {
  const { t } = useTranslation('settings')
  const [events, setEvents] = useState<ScenarioBuildEvent[]>([])
  const [status, setStatus] = useState<ScenarioBuildStatus>('idle')
  const [baseId, setBaseId] = useState<string | null>(null)
  const [baseName, setBaseName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const controllerRef = useRef<AbortController | null>(null)
  const inFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const resettingRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      controllerRef.current?.abort()
      controllerRef.current = null
    }
  }, [])

  /** setState wrappers that no-op after unmount. */
  const safeSetStatus = useCallback((next: ScenarioBuildStatus) => {
    if (!mountedRef.current) return
    setStatus(next)
  }, [])
  const safeSetError = useCallback((message: string | null) => {
    if (!mountedRef.current) return
    setError(message)
  }, [])

  const abort = useCallback(() => {
    if (!inFlightRef.current) return
    controllerRef.current?.abort()
  }, [])

  const reset = useCallback(() => {
    // Set resettingRef BEFORE abort so the submit() catch branch sees it.
    // If there is an in-flight request the finally block in submit() will clear
    // resettingRef once the catch branch has had a chance to observe it.
    const wasInFlight = inFlightRef.current
    resettingRef.current = true
    controllerRef.current?.abort()
    controllerRef.current = null
    inFlightRef.current = false
    if (!mountedRef.current) {
      if (!wasInFlight) resettingRef.current = false
      return
    }
    setEvents([])
    setStatus('idle')
    setBaseId(null)
    setBaseName(null)
    setError(null)
    // When there was no in-flight request nobody else will clear the flag.
    if (!wasInFlight) resettingRef.current = false
  }, [])

  const submit = useCallback(
    async (prompt: string, files: File[]): Promise<void> => {
      if (inFlightRef.current) {
        throw new Error('A scenario build is already in flight')
      }
      inFlightRef.current = true
      const controller = new AbortController()
      controllerRef.current = controller

      // Reset state for a fresh submission.
      if (mountedRef.current) {
        setEvents([])
        setBaseId(null)
        setBaseName(null)
        setError(null)
      }
      safeSetStatus('submitting')

      let terminalSeen = false

      const formData = new FormData()
      formData.append('prompt', prompt)
      for (const file of files) {
        formData.append('attachments', file)
      }

      try {
        const response = await fetch(resolveApiURL(BUILD_PATH), {
          method: 'POST',
          headers: {
            'X-Locale': getCurrentLocale(),
          },
          body: formData,
          signal: controller.signal,
        })

        if (!response.ok) {
          const message = await readErrorBody(response)
          terminalSeen = true
          safeSetError(message)
          safeSetStatus('error')
          return
        }
        if (!response.body) {
          terminalSeen = true
          safeSetError(t('scenario.streamingUnavailable'))
          safeSetStatus('error')
          return
        }

        let firstEventSeen = false

        for await (const event of readSSE(response.body)) {
          if (!firstEventSeen) {
            firstEventSeen = true
            safeSetStatus('streaming')
          }

          if (event.kind === 'error') {
            if (mountedRef.current) {
              setEvents((prev) => [...prev, event])
            }
            terminalSeen = true
            safeSetError(event.message)
            safeSetStatus('error')
            return
          }

          if (mountedRef.current) {
            setEvents((prev) => [...prev, event])
            if (event.kind === 'base.created') {
              setBaseId((prev) => prev ?? event.baseId)
              setBaseName((prev) => prev ?? event.baseName)
            }
          }

          if (event.kind === 'done') {
            terminalSeen = true
            safeSetStatus('done')
            return
          }
        }

        // Stream closed without an explicit `done` frame — treat as success
        // unless an error already won.
        if (!terminalSeen) {
          terminalSeen = true
          safeSetStatus('done')
        }
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) {
          terminalSeen = true
          // If reset() triggered the abort it already set status to 'idle' —
          // do not overwrite that with 'aborted'.
          if (!resettingRef.current) {
            safeSetStatus('aborted')
          }
          return
        }
        terminalSeen = true
        const message =
          err instanceof Error ? err.message : t('scenario.unexpectedBuildFailure')
        safeSetError(message)
        safeSetStatus('error')
      } finally {
        inFlightRef.current = false
        // Clear the resetting flag now that the catch branch has had a chance
        // to observe it.
        resettingRef.current = false
        if (controllerRef.current === controller) {
          controllerRef.current = null
        }
        if (!terminalSeen) {
          safeSetStatus('error')
        }
      }
    },
    [safeSetError, safeSetStatus, t],
  )

  return { events, status, baseId, baseName, error, submit, abort, reset }
}
