import { useCallback, useEffect, useRef, useState } from 'react'

import { resolveApiURL } from '@/services/desktop'
import { trackProductEventOnce } from '@/features/analytics/lib/productAnalytics'

export interface SendTestResult {
  ok: boolean
  input: { to: string; subject: string; body: string }
  error?: string
}

export type SendTestStatus = 'idle' | 'running' | 'done' | 'error'

export interface SendTestOptions {
  /** Override the workflow's configured recipient. Empty falls back to the
   *  stored value. */
  to?: string
  /** Sample-row override. When provided, the backend skips its AI sample
   *  generator and renders the body with these fields verbatim. Drives the
   *  WF-U3 "use existing row" picker — the values come straight out of
   *  /data-documents/.../records so the test mirrors what the workflow
   *  would have sent for that actual record. */
  triggerFields?: Record<string, unknown>
}

export interface UseWorkflowSendTestResult {
  status: SendTestStatus
  result: SendTestResult | null
  error: string | null
  /** Send a real test email. The optional `options` lets the caller supply
   *  a recipient override or a sample row (or both). Pre-existing single-
   *  argument call sites (`send(id)` / `send(id, 'to@x')`) still work
   *  thanks to the union type. */
  send: (workflowId: string, options?: string | SendTestOptions) => Promise<void>
  reset: () => void
}

/**
 * Hook that POSTs to /v1/workflows/:id/send-test which renders a sample row
 * and ACTUALLY DELIVERS the email through the configured SMTP sender. Mirrors
 * useWorkflowDryRun's shape so the surrounding UI is symmetric, but the
 * semantic difference is important: this one really sends.
 */
export function useWorkflowSendTest(): UseWorkflowSendTestResult {
  const [status, setStatus] = useState<SendTestStatus>('idle')
  const [result, setResult] = useState<SendTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const send = useCallback(async (workflowId: string, options?: string | SendTestOptions) => {
    if (mountedRef.current) {
      setStatus('running')
      setResult(null)
      setError(null)
    }
    // Back-compat: pre-existing callers pass `to` as a plain string. New
    // callers (WF-U3 picker) pass an object so the sample row can ride
    // along. Normalise both into the wire payload here.
    const opts: SendTestOptions = typeof options === 'string'
      ? { to: options }
      : (options ?? {})
    const payload: Record<string, unknown> = { to: opts.to ?? '' }
    if (opts.triggerFields && Object.keys(opts.triggerFields).length > 0) {
      payload.triggerFields = opts.triggerFields
    }
    try {
      const res = await fetch(resolveApiURL(`/v1/workflows/${workflowId}/send-test`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = (await res.json().catch(() => ({}))) as SendTestResult
      if (!mountedRef.current) return
      if (!res.ok || !body.ok) {
        setStatus('error')
        setError(body.error ?? `status ${res.status}`)
        return
      }
      setResult(body)
      setStatus('done')
      trackProductEventOnce('workflow_first_run_completed', { result: 'success' })
    } catch (e) {
      if (!mountedRef.current) return
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const reset = useCallback(() => {
    if (!mountedRef.current) return
    setStatus('idle')
    setResult(null)
    setError(null)
  }, [])

  return { status, result, error, send, reset }
}
