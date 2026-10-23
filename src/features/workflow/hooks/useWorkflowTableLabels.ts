import { useCallback, useEffect, useState } from 'react'

import { listTableFiles, onTableFilesChanged, TABLE_FILE_EXTENSION, tableKey, type KitTablesFile } from '@/api/kitTables'
import type { TableLabel } from '@/features/workflow/lib/workflowDraft'
import { isWebPreviewMode } from '@/lib/runtimeMode'

/**
 * useWorkflowTableLabels — pulls the workspace's table files at mount and
 * re-pulls whenever a table file is created, saved, renamed, or deleted
 * (`onTableFilesChanged`), flattening the result into a
 * Record<tableKey(path, tableId), TableLabel>. Drives the trigger-table
 * picker labels, the workflow-list FlowLine rows, and the lazy schema
 * loader's lookups.
 *
 * Keys pair the file's path with the table's id because table ids are only
 * unique within one file. The runtime lists the open workspace only, so the
 * old `rootPath` scoping argument is accepted for compatibility and ignored.
 * Errors silently collapse to an empty map because labels are
 * non-critical — the page degrades to "Unknown table" strings rather than
 * dead-ending on a fetch failure.
 */
export interface UseWorkflowTableLabelsResult {
  /** tableKey(path, tableId) → TableLabel. Empty on the very first render
   *  and on fetch failure. */
  labels: Record<string, TableLabel>
  /** Loading / done / error so callers that want a spinner can render
   *  one. Most consumers don't need this. */
  status: 'loading' | 'done' | 'error'
}

/** The file name without its folders and `.ktable`. */
export function tableFileTitle(path: string): string {
  const name = path.split('/').pop() || path
  return name.toLowerCase().endsWith(TABLE_FILE_EXTENSION) ? name.slice(0, -TABLE_FILE_EXTENSION.length) : name
}

/** Flattens table files into labels keyed by `tableKey(path, tableId)`. */
function buildTableLabels(files: readonly KitTablesFile[]): Record<string, TableLabel> {
  const next: Record<string, TableLabel> = {}
  for (const file of files) {
    const documentPath = String(file.path || '').trim()
    if (!documentPath) continue
    const documentTitle = tableFileTitle(documentPath) || 'Untitled table'
    const documentId = String(file.documentId || '')
    for (const table of file.tables || []) {
      const tableId = String(table.id)
      const tableName = String(table.title || table.name || '').trim() || 'Untitled table'
      next[tableKey(documentPath, tableId)] = { tableId, tableName, documentTitle, documentId, documentPath }
    }
  }
  return next
}

export function useWorkflowTableLabels(_rootPath?: string): UseWorkflowTableLabelsResult {
  const [labels, setLabels] = useState<Record<string, TableLabel>>({})
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading')

  const reload = useCallback(() => {
    if (isWebPreviewMode()) {
      setLabels({})
      setStatus('done')
      return () => {}
    }
    let cancelled = false
    void listTableFiles()
      .then((result) => {
        if (cancelled) return
        setLabels(buildTableLabels(result.files || []))
        setStatus('done')
      })
      .catch(() => {
        if (cancelled) return
        setStatus('error')
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cleanup = reload()
    const unsubscribe = onTableFilesChanged(() => {
      cleanup()
      cleanup = reload()
    })
    return () => {
      cleanup()
      unsubscribe()
    }
  }, [reload])

  return { labels, status }
}
