import { useCallback, useEffect, useRef, useState } from 'react'

import { resolveApiURL } from '@/services/desktop'
import { trackProductEventOnce } from '@/features/analytics/lib/productAnalytics'

export interface DryRunResult {
  ok: boolean
  input: { to: string; subject: string; body: string }
  error?: string
}

export type DryRunStatus = 'idle' | 'running' | 'done' | 'error'

export interface UseWorkflowDryRunResult {
  status: DryRunStatus
  result: DryRunResult | null
  error: string | null
  run: (workflowId: string) => Promise<void>
  reset: () => void
}

/**
 * React hook that fires a dry-run POST for a given workflowId and surfaces
 * the rendered action input (e.g. email to/subject/body) for preview.
 */
export function useWorkflowDryRun(): UseWorkflowDryRunResult {
  const [status, setStatus] = useState<DryRunStatus>('idle')
  const [result, setResult] = useState<DryRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const run = useCallback(async (workflowId: string) => {
    if (mountedRef.current) {
      setStatus('running')
      setResult(null)
      setError(null)
    }
    try {
      const res = await fetch(resolveApiURL(`/v1/workflows/${workflowId}/dry-run`), { method: 'POST' })
      const body = (await res.json()) as DryRunResult
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

  return { status, result, error, run, reset }
}
