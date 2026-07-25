import { useCallback, useEffect, useRef, useState } from 'react'

import { testWorkflowNode } from '@/features/workflow/api'

export interface NodeTestResult {
  ok: boolean
  skipped?: string
  input?: { to: string; subject: string; body: string }
  output?: {
    recordId?: string
    tableId?: string
    documentId?: string
    values?: Record<string, unknown>
    matched?: boolean
    changed?: boolean
    matchedRecordId?: string
  }
  error?: string
}

export type NodeTestStatus = 'idle' | 'running' | 'done' | 'error'

export interface UseWorkflowNodeTestResult {
  status: NodeTestStatus
  result: NodeTestResult | null
  error: string | null
  run: (
    workflowId: string,
    nodeId: string,
    options?: { to?: string; triggerFields?: Record<string, unknown>; recordId?: string },
  ) => Promise<void>
  reset: () => void
}

/**
 * Hook for the per-node test (drawer "Run with sample" button). It POSTs to
 * /v1/workflows/:id/nodes/:nodeId/test which:
 *   - for action nodes: delegates to send-test (renders sample + delivers a
 *     real "[TEST]" email through the configured connection),
 *   - for trigger nodes: returns a no-op success.
 *
 * Mirrors useWorkflowSendTest's shape so the drawer's UI symmetry is
 * preserved; we keep this hook scoped to the node-level endpoint so the
 * top-of-page "Run test" CTA can stay on send-test (whole-workflow) for
 * one release while we observe traffic. Once both paths are confirmed
 * equivalent, send-test can be retired in favor of this.
 */
export function useWorkflowNodeTest(): UseWorkflowNodeTestResult {
  const [status, setStatus] = useState<NodeTestStatus>('idle')
  const [result, setResult] = useState<NodeTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const run = useCallback(async (
    workflowId: string,
    nodeId: string,
    options?: { to?: string; triggerFields?: Record<string, unknown>; recordId?: string },
  ) => {
    if (mountedRef.current) {
      setStatus('running')
      setResult(null)
      setError(null)
    }
    try {
      const body = await testWorkflowNode(workflowId, nodeId, options)
      if (!mountedRef.current) return
      if (body.ok === false || body.error) {
        setStatus('error')
        setError(body.error ?? 'node test failed')
        return
      }
      setResult({ ok: Boolean(body.ok ?? true), skipped: body.skipped, input: body.input, output: body.output })
      setStatus('done')
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
