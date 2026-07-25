import { useEffect, useState } from 'react'

import type { NodeIssue, WorkflowPatch } from '@/features/workflow/api'
import { validateWorkflow } from '@/features/workflow/api'

/**
 * useWorkflowValidation polls the server-side validator for the
 * workflow under edit. Debounced so a rapid keystroke storm produces at
 * most one request per debounceMs (default 300ms). Two derived buckets
 * are surfaced — `errors` blocks Save, `warnings` is advisory only — so
 * the StatusBanner can colour the canvas appropriately without each
 * caller re-deriving the split.
 *
 * Issues are keyed by nodeId so the NodeCard inline-error renderer can
 * find them in O(1). Pass an empty workflowId to disable the hook.
 *
 * Pass `draftPatch` so the server validates the user's in-progress edits
 * rather than the last-saved snapshot. Without it the canvas keeps
 * showing stale "Recipient is required" errors after the user types a
 * recipient — local validation clears, server keeps complaining against
 * the empty-on-disk To field, and the node card stays red.
 */
export interface UseWorkflowValidationResult {
  issues: NodeIssue[]
  errors: NodeIssue[]
  warnings: NodeIssue[]
  byNode: Record<string, NodeIssue[]>
  loading: boolean
}

export function useWorkflowValidation(
  workflowId: string | null,
  draftPatch: WorkflowPatch | null,
  debounceMs = 300,
): UseWorkflowValidationResult {
  const [issues, setIssues] = useState<NodeIssue[]>([])
  const [loading, setLoading] = useState(false)
  // Serialise the patch so the effect's dep array is a primitive — a fresh
  // object literal would otherwise re-fire validation on every render even
  // when the underlying draft is unchanged.
  const patchKey = draftPatch ? JSON.stringify(draftPatch) : ''

  useEffect(() => {
    if (!workflowId) {
      setIssues([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      setLoading(true)
      void validateWorkflow(workflowId, draftPatch ?? undefined)
        .then((next) => {
          if (cancelled) return
          setIssues(next)
        })
        .catch(() => {
          // Validation is best-effort; falling back to client-side checks
          // is fine, so we just clear the server-side issues here.
          if (cancelled) return
          setIssues([])
        })
        .finally(() => {
          if (cancelled) return
          setLoading(false)
        })
    }, debounceMs)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, patchKey, debounceMs])

  const errors = issues.filter((i) => (i.level ?? 'error') === 'error')
  const warnings = issues.filter((i) => i.level === 'warning')
  const byNode: Record<string, NodeIssue[]> = {}
  for (const issue of issues) {
    if (!byNode[issue.nodeId]) byNode[issue.nodeId] = []
    byNode[issue.nodeId].push(issue)
  }
  return { issues, errors, warnings, byNode, loading }
}
