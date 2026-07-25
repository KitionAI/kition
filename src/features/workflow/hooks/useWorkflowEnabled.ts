import { useCallback, useEffect, useRef, useState } from 'react'

import {
  WORKFLOW_CHANGED_EVENT,
  WORKFLOW_ENABLED_CHANGED_EVENT,
} from '@/features/workflow/lib/workflowEvents'
import { resolveApiURL } from '@/services/desktop'

export { WORKFLOW_ENABLED_CHANGED_EVENT } from '@/features/workflow/lib/workflowEvents'

export interface UseWorkflowEnabledResult {
  enabled: boolean
  status: 'idle' | 'saving' | 'error'
  error: string | null
  setEnabled: (next: boolean) => Promise<void>
}

/**
 * Tracks the enabled flag of an workflow with optimistic updates.
 *
 * `initialEnabled` seeds local state; the hook re-syncs whenever it changes
 * (e.g. parent re-renders with a different selected workflow). Previously the
 * hook ignored later updates to `initialEnabled`, so the Build page toggle
 * always rendered OFF regardless of the server-side state.
 */
export function useWorkflowEnabled(workflowId: string | null, initialEnabled = false): UseWorkflowEnabledResult {
  const [enabled, setLocalEnabled] = useState(initialEnabled)
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const pendingSeedRef = useRef<{ workflowId: string | null; initialEnabled: boolean } | null>(null)

  // Re-seed local state when the source of truth changes. We avoid resetting
  // mid-save (status === 'saving') so an in-flight optimistic update doesn't
  // get clobbered by a stale prop.
  useEffect(() => {
    if (status === 'saving') {
      pendingSeedRef.current = { workflowId, initialEnabled }
      return
    }
    setLocalEnabled(initialEnabled)
    pendingSeedRef.current = null
  }, [initialEnabled, workflowId])

  useEffect(() => {
    if (status !== 'idle' || !pendingSeedRef.current) return
    const pending = pendingSeedRef.current
    pendingSeedRef.current = null
    setLocalEnabled(pending.initialEnabled)
  }, [status])

  const setEnabled = useCallback(async (next: boolean) => {
    if (!workflowId) return
    const prev = enabled
    setLocalEnabled(next)
    setStatus('saving')
    setError(null)
    try {
      const res = await fetch(resolveApiURL(`/v1/workflows/${workflowId}/enabled`), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const body = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) {
        throw new Error(body.error ?? `status ${res.status}`)
      }
      setStatus('idle')
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(WORKFLOW_CHANGED_EVENT, {
          detail: { op: 'patch', workflowId },
        }))
        window.dispatchEvent(new CustomEvent(WORKFLOW_ENABLED_CHANGED_EVENT, {
          detail: { workflowId, enabled: next },
        }))
      }
    } catch (e) {
      setLocalEnabled(prev)
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [workflowId, enabled])

  return { enabled, status, error, setEnabled }
}
