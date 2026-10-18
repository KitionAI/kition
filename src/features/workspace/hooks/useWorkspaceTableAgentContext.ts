import { useCallback, useEffect, useRef, useState } from 'react'

import { openDataDocumentByPath } from '@/api/dataDocuments'
import { resolveAgentDataTableTarget } from '@/features/workspace/lib/agentPaneContext'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import type { DataDocument, DataTable } from '@kition/table-editor'

export type WorkspaceTableAgentContext = {
  activeDocument: DataDocument | null
  activeTable: DataTable | null
  onTableChanged?: () => Promise<void> | void
}

export type TableAgentContextChange = {
  documentPath: string
  activeDocument: DataDocument | null
  activeTable: DataTable | null
  onTableChanged?: () => Promise<void> | void
}

type UseWorkspaceTableAgentContextOptions = {
  activeWorkspaceTab: WorkspaceTab | undefined
}

/**
 * Which data table the Agent is talking about, and its loaded schema.
 *
 * Table editors publish their document and active table per path.
 * Contexts that were never published are hydrated lazily from the runtime.
 */
export function useWorkspaceTableAgentContext({
  activeWorkspaceTab,
}: UseWorkspaceTableAgentContextOptions) {
  const [contextByPath, setContextByPath] = useState<Record<string, WorkspaceTableAgentContext>>({})

  const activeDataTableTarget = resolveAgentDataTableTarget(activeWorkspaceTab)
  const activeDataWorkspaceTabPath = activeDataTableTarget?.documentPath || ''
  const activeDataWorkspaceTableId = activeDataTableTarget?.tableId ?? null

  // Refs for event handlers that must read the latest values without re-subscribing.
  const activeDataWorkspaceTabPathRef = useRef('')
  activeDataWorkspaceTabPathRef.current = activeDataWorkspaceTabPath
  const documentPath = activeDataWorkspaceTabPath
  const context = documentPath ? contextByPath[documentPath] || null : null
  const hasTarget = Boolean(documentPath)

  const refreshByPath = useCallback(async (path: string, preferredTableId?: number | null) => {
    const normalizedPath = String(path || '').trim()
    if (!normalizedPath) return null
    const document = await openDataDocumentByPath({ path: normalizedPath })
    const preferredTable = preferredTableId
      ? document.tables?.find((table) => table.id === preferredTableId) || null
      : null
    const activeTable = preferredTable || document.tables?.[0] || null
    const nextContext: WorkspaceTableAgentContext = {
      activeDocument: document,
      activeTable,
      onTableChanged: async () => {
        await refreshByPath(normalizedPath, activeTable?.id || preferredTableId || null)
      },
    }
    setContextByPath((current) => ({ ...current, [normalizedPath]: nextContext }))
    return nextContext
  }, [])

  /** Called by table editors whenever their document or active table changes. */
  const handleContextChange = useCallback((change: TableAgentContextChange) => {
    const path = String(change.documentPath || '').trim()
    if (!path) return
    setContextByPath((current) => {
      if (!change.activeDocument || !change.activeTable) {
        const existing = current[path]
        if (!existing) return current
        return { ...current, [path]: { ...existing, onTableChanged: undefined } }
      }
      return {
        ...current,
        [path]: {
          activeDocument: change.activeDocument,
          activeTable: change.activeTable,
          onTableChanged: change.onTableChanged,
        },
      }
    })
  }, [])

  // Hydrate a context nobody published yet.
  useEffect(() => {
    if (!hasTarget || !documentPath) return
    if (context?.activeDocument && context?.activeTable) return
    void refreshByPath(documentPath, activeDataWorkspaceTableId || context?.activeTable?.id || null).catch(() => {
      // Keep the workspace usable even if lazy table-agent hydration fails.
    })
  }, [
    activeDataWorkspaceTableId,
    hasTarget,
    refreshByPath,
    context?.activeDocument,
    context?.activeTable,
    documentPath,
  ])

  return {
    context,
    documentPath,
    activeDataWorkspaceTabPath,
    activeDataWorkspaceTableId,
    activeDataWorkspaceTabPathRef,
    handleContextChange,
  }
}
