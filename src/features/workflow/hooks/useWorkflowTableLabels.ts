import { useCallback, useEffect, useState } from 'react'

import { listDataDocuments } from '@/api/dataDocuments'
import type { TableLabel } from '@/features/workflow/lib/workflowDraft'
import { isWebPreviewMode } from '@/lib/runtimeMode'

/**
 * useWorkflowTableLabels — pulls the data-document index at mount and
 * re-pulls whenever a table is created, deleted, or renamed in the
 * workspace, flattening the result into a Record<tableId, TableLabel>.
 * Drives the trigger-table picker labels, the workflow-list FlowLine
 * rows, and the lazy schema-loader's "what document does tableId X
 * belong to?" lookup.
 *
 * `rootPath` scopes the fetch to a single workspace_root — the picker and
 * the file-tree's kitable index (useKitableChildrenIndex) must agree on
 * which tables exist or "Leads" rows from sibling workspaces leak into
 * the dropdown and tableId collisions across workspaces overwrite
 * in-scope labels in the map. Passing undefined falls back to the
 * legacy cross-workspace fetch for non-workspace-scoped mounts.
 *
 * The hook listens on the same `kition:data-document:table:*` event bus that
 * the workspace tree uses, so creating a table elsewhere in the app
 * (sidebar create menu, kitable inline create) is reflected here
 * without a page refresh. Errors silently collapse to an empty map
 * because labels are non-critical — the page degrades to "Unknown
 * table" strings rather than dead-ending on a fetch failure.
 */
export interface UseWorkflowTableLabelsResult {
  /** tableId → TableLabel. Empty on the very first render and on fetch
   *  failure. */
  labels: Record<string, TableLabel>
  /** Loading / done / error so callers that want a spinner can render
   *  one. Most consumers don't need this. */
  status: 'loading' | 'done' | 'error'
}

export function useWorkflowTableLabels(rootPath?: string): UseWorkflowTableLabelsResult {
  const [labels, setLabels] = useState<Record<string, TableLabel>>({})
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading')

  const reload = useCallback(() => {
    if (isWebPreviewMode()) {
      setLabels({})
      setStatus('done')
      return () => {}
    }
    let cancelled = false
    void listDataDocuments(rootPath ? { workspace_root: rootPath } : undefined)
      .then((result) => {
        if (cancelled) return
        const next: Record<string, TableLabel> = {}
        for (const doc of result.items || []) {
          const documentTitle = String(doc.title || doc.path || '').trim() || 'Untitled doc'
          const documentId = String((doc as { id?: number | string }).id ?? '')
          const documentPath = String(doc.path || '').trim()
          for (const table of doc.tables || []) {
            const tableId = String(table.id)
            const tableName = String(table.title || table.name || '').trim() || 'Untitled table'
            next[tableId] = { tableName, documentTitle, documentId, documentPath }
          }
        }
        setLabels(next)
        setStatus('done')
      })
      .catch(() => {
        if (cancelled) return
        setStatus('error')
      })
    return () => { cancelled = true }
  }, [rootPath])

  useEffect(() => {
    const cleanup = reload()

    const handler = () => { reload() }
    const events = [
      'kition:data-document:table:create',
      'kition:data-document:table:delete',
      'kition:data-document:table:rename',
    ]
    events.forEach((name) => window.addEventListener(name, handler))

    return () => {
      cleanup()
      events.forEach((name) => window.removeEventListener(name, handler))
    }
  }, [reload])

  return { labels, status }
}
