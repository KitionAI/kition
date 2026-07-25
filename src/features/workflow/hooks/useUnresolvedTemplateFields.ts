import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * useUnresolvedTemplateFields — drains the create-from-template handoff
 * the launcher stashed under `sessionStorage[kition:workflow:template-unresolved:<id>]`
 * when a body's `field_ref_by_name` part couldn't bind to a real
 * schema field, and exposes the list so the page can render the
 * one-shot amber banner.
 *
 * The hook owns the read-and-clear contract so the banner doesn't
 * survive a refresh (sessionStorage outlives the React tree but the
 * banner is a transient UX hint, not a persistent state). It also
 * exposes `dismiss()` so the user can hide the banner before navigating
 * — the key is already drained at that point, so dismiss is a pure
 * state reset.
 *
 * Extracted from WorkflowHomePage (WF-C1j1). Closes the implementation
 * side of the WF-U4 handoff contract: launcher → sessionStorage → page
 * → banner. Spec covers the four shapes that flow through:
 * happy-path drain, missing key, malformed JSON, non-array payload.
 */
export interface UseUnresolvedTemplateFieldsResult {
  fieldNames: string[]
  dismiss: () => void
}

export function useUnresolvedTemplateFields(selectedId: string | null): UseUnresolvedTemplateFieldsResult {
  const [fieldNames, setFieldNames] = useState<string[]>([])
  // React StrictMode (dev) double-invokes effects: the first run drains
  // sessionStorage and sets state, the second run reads the now-empty key
  // and would otherwise clobber state back to []. The ref caches what we
  // drained for each selectedId so the second invocation restores from
  // cache instead of re-reading sessionStorage. Refs survive the strict
  // mode re-run because state is preserved on the same component
  // instance; the ref is per-mount so navigating away then back will
  // re-read sessionStorage (which is intended — fresh handoffs from the
  // launcher should still surface the banner).
  const drainedRef = useRef<Map<string, string[]>>(new Map())

  useEffect(() => {
    if (!selectedId) {
      setFieldNames([])
      return
    }
    const cached = drainedRef.current.get(selectedId)
    if (cached !== undefined) {
      setFieldNames(cached)
      return
    }
    try {
      const key = `kition:workflow:template-unresolved:${selectedId}`
      const raw = window.sessionStorage.getItem(key)
      if (!raw) {
        drainedRef.current.set(selectedId, [])
        setFieldNames([])
        return
      }
      // Drain on first read — the banner is a one-shot hint. A page
      // refresh after the user has seen the banner shouldn't re-fire
      // it, so we yank the key immediately rather than waiting for
      // dismiss.
      window.sessionStorage.removeItem(key)
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const names = parsed.filter((s): s is string => typeof s === 'string')
        drainedRef.current.set(selectedId, names)
        setFieldNames(names)
      } else {
        // Defensive: ignore non-array payloads. The launcher only ever
        // writes an array, but a corrupted handoff shouldn't surface a
        // misleading banner.
        drainedRef.current.set(selectedId, [])
        setFieldNames([])
      }
    } catch {
      // sessionStorage may be disabled (privacy mode) or the JSON could
      // be malformed — either way, silently collapse to "no banner"
      // rather than blowing up the page.
      drainedRef.current.set(selectedId, [])
      setFieldNames([])
    }
  }, [selectedId])

  const dismiss = useCallback(() => setFieldNames([]), [])

  return { fieldNames, dismiss }
}
