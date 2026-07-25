import { useCallback, useEffect, useRef, useState } from 'react'

import { resolveApiURL } from '@/services/desktop'
import { ensurePortalAccountSessionRestored } from '@/services/portalAccount'

import {
  parseWorkflowBuildEvent,
  type WorkflowBuildEvent,
  type WorkflowBuildStatus,
} from '@/features/workflow/types'
import type { RuntimeWritingModel } from '@/types'

const BUILD_PATH = '/v1/workflows/build'

/**
 * Read a Server-Sent-Events stream and yield typed `WorkflowBuildEvent`s as
 * they arrive. Mirrors the SSE algorithm from `useScenarioBuild`.
 *
 * - frames separated by blank lines (`\n\n`); CRLF tolerated
 * - `data:` lines concatenated with `\n` within a frame
 * - lines starting with `:` are comments (ignored)
 * - unknown kinds (parseWorkflowBuildEvent returns null) are skipped for
 *   forward-compatibility
 */
async function* readSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<WorkflowBuildEvent, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const flushFrame = (frame: string): WorkflowBuildEvent | null => {
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
      if (value.startsWith(' ')) value = value.slice(1)
      dataParts.push(value)
    }
    if (dataParts.length === 0) return null
    const payload = dataParts.join('\n')
    if (payload.trim() === '') return null
    const event = parseWorkflowBuildEvent(payload)
    if (!event) {
      console.warn('[useWorkflowBuild] skipping unknown SSE frame', payload)
      return null
    }
    return event
  }

  const splitFrames = (): string[] => {
    const normalised = buffer.replace(/\r\n/g, '\n')
    const parts = normalised.split('\n\n')
    buffer = parts.pop() ?? ''
    return parts
  }

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
    // Flush decoder buffer, then any remaining single frame.
    buffer += decoder.decode()
    const tail = buffer.replace(/\r\n/g, '\n').replace(/\n+$/, '')
    if (tail) {
      const event = flushFrame(tail)
      if (event) yield event
    }
    buffer = ''
  } finally {
    // On non-EOF exits (abort, error, consumer return) cancel the underlying
    // socket so the reader lock is not left dangling.
    if (!reachedEOF) {
      try {
        await reader.cancel()
      } catch {
        // Ignore cancel errors.
      }
    }
    reader.releaseLock()
  }
}

export interface WorkflowBuildInput {
  prompt: string
  baseId: string
  documentId: string
  tableId: string
  model: RuntimeWritingModel
}

export interface UseWorkflowBuildResult {
  status: WorkflowBuildStatus
  events: WorkflowBuildEvent[]
  workflowId: string | null
  error: string | null
  submit: (input: WorkflowBuildInput) => Promise<void>
  reset: () => void
}

/**
 * React hook that drives the workflow build SSE pipeline.
 *
 * State invariants:
 *   - `submit()` aborts any prior in-flight stream and starts a fresh one.
 *   - `reset()` aborts any in-flight stream and returns to `idle`.
 *   - On unmount the in-flight request is aborted and no further setState fires.
 */
export function useWorkflowBuild(): UseWorkflowBuildResult {
  const [status, setStatus] = useState<WorkflowBuildStatus>('idle')
  const [events, setEvents] = useState<WorkflowBuildEvent[]>([])
  const [workflowId, setWorkflowId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  const submit = useCallback(async (input: WorkflowBuildInput) => {
    // Abort any previous in-flight request.
    abortRef.current?.abort()
    const ctl = new AbortController()
    abortRef.current = ctl

    if (mountedRef.current) {
      setStatus('submitting')
      setEvents([])
      setError(null)
      setWorkflowId(null)
    }

    try {
      if (input.model.provider_type === 'kition_console') {
        await ensurePortalAccountSessionRestored()
        if (!mountedRef.current || ctl.signal.aborted) return
      }

      const res = await fetch(resolveApiURL(BUILD_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: ctl.signal,
      })

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        if (!mountedRef.current || ctl.signal.aborted) return
        setError(`build failed (${res.status}): ${text}`)
        setStatus('error')
        return
      }

      if (mountedRef.current) setStatus('streaming')

      let sawError = false
      for await (const ev of readSSE(res.body)) {
        if (!mountedRef.current || ctl.signal.aborted) return
        setEvents((prev) => [...prev, ev])
        if (ev.kind === 'workflow.created') {
          setWorkflowId(ev.workflowId)
        }
        if (ev.kind === 'error') {
          sawError = true
          setError(ev.message)
        }
      }

      if (!mountedRef.current || ctl.signal.aborted) return
      setStatus(sawError ? 'error' : 'done')
    } catch (e) {
      if (ctl.signal.aborted || !mountedRef.current) return
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    if (!mountedRef.current) return
    setStatus('idle')
    setEvents([])
    setWorkflowId(null)
    setError(null)
  }, [])

  return { status, events, workflowId, error, submit, reset }
}
