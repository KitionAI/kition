import { useCallback, useEffect, useRef, useState } from 'react'

import { resolveApiURL } from '@/services/desktop'

export interface WorkflowRunRecord {
  id: string
  workflowId: string
  triggerEvent: string
  recordId: string
  startedAt: string
  finishedAt: string
  status: 'ok' | 'error' | 'skipped'
  to: string
  subject: string
  body: string
  error?: string
  /** Server-side hint: when a run errors, which canvas node caused it.
   *  Surfaced by the Run history row's "View node" link so the user can
   *  jump straight to the offending step. */
  failingNodeId?: string
  /** When status="skipped", a short reason ("Filter X evaluated to false")
   *  the UI can render in the row. */
  skipReason?: string
  /** Per-node outcomes from the multi-action executor. Surfaced in the
   *  expanded detail panel as a small step list. Empty for legacy single-
   *  action runs. */
  nodeOutcomes?: Array<{
    nodeId: string
    kind: string
    status: string
    error?: string
    detail?: string
    startedAt?: string
    finishedAt?: string
  }>
}

export interface UseWorkflowRunsResult {
  status: 'idle' | 'loading' | 'done' | 'error'
  runs: WorkflowRunRecord[]
  error: string | null
  refresh: () => Promise<void>
}

export function useWorkflowRuns(workflowId: string | null, active: boolean): UseWorkflowRunsResult {
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!workflowId) return
    setStatus('loading')
    setError(null)
    try {
      const res = await fetch(resolveApiURL(`/v1/workflows/${workflowId}/runs?limit=50`))
      const body = await res.json() as { runs?: WorkflowRunRecord[]; error?: string }
      if (!mountedRef.current) return
      if (!res.ok) {
        setStatus('error')
        setError(body.error ?? `status ${res.status}`)
        return
      }
      setRuns(Array.isArray(body.runs) ? body.runs : [])
      setStatus('done')
    } catch (e) {
      if (!mountedRef.current) return
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [workflowId])

  useEffect(() => {
    if (!active || !workflowId) return
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => window.clearInterval(timer)
  }, [active, workflowId, refresh])

  return { status, runs, error, refresh }
}
