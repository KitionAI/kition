import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { openDataDocumentByPath } from '@/api/dataDocuments'
import { resolveAgentDataTableTarget } from '@/features/workspace/lib/agentPaneContext'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import type { DataDocument, DataTable } from '@/types/dataDocument'

export type WorkspaceTableAgentContext = {
  activeDocument: DataDocument | null
  activeTable: DataTable | null
  onTableChanged?: () => Promise<void> | void
}

/** The table the Agent last worked against, remembered across browser and table tabs. */
export type WorkspaceTableAgentTarget = {
  documentPath: string
  tableId: number | null
  originLabel: string
}

export type TableAgentContextChange = {
  documentPath: string
  activeDocument: DataDocument | null
  activeTable: DataTable | null
  onTableChanged?: () => Promise<void> | void
}

const EMPTY_TARGET: WorkspaceTableAgentTarget = { documentPath: '', tableId: null, originLabel: '' }

type WorkspaceBrowserTab = Extract<WorkspaceTab, { type: 'browser' }>

type UseWorkspaceTableAgentContextOptions = {
  activeWorkspaceTab: WorkspaceTab | undefined
  activeBrowserTab: WorkspaceBrowserTab | null
}

function sameTarget(a: WorkspaceTableAgentTarget, b: WorkspaceTableAgentTarget) {
  return a.documentPath === b.documentPath && a.tableId === b.tableId && a.originLabel === b.originLabel
}

/**
 * Which data table the Agent is talking about, and its loaded schema.
 *
 * Table editors publish their document and active table per path; browser
 * tabs point back at the table they were opened from; when neither is
 * active the last target is kept so a follow-up turn still has a table.
 * Contexts that were never published (a browser tab opened from the tree)
 * are hydrated lazily from the runtime.
 */
export function useWorkspaceTableAgentContext({
  activeWorkspaceTab,
  activeBrowserTab,
}: UseWorkspaceTableAgentContextOptions) {
  const [contextByPath, setContextByPath] = useState<Record<string, WorkspaceTableAgentContext>>({})
  const [lastTarget, setLastTarget] = useState<WorkspaceTableAgentTarget>(EMPTY_TARGET)

  const browserOriginDocumentPath = String(activeBrowserTab?.originDocumentPath || '').trim()
  const browserOriginTableId = typeof activeBrowserTab?.originTableId === 'number' ? activeBrowserTab.originTableId : null
  const browserResolvedDocumentPath = browserOriginDocumentPath || lastTarget.documentPath
  const browserResolvedTableId = browserOriginTableId ?? lastTarget.tableId

  const activeDataTableTarget = resolveAgentDataTableTarget(activeWorkspaceTab)
  const activeDataWorkspaceTabPath = activeDataTableTarget?.documentPath || ''
  const activeDataWorkspaceTableId = activeDataTableTarget?.tableId ?? null

  // Refs for event handlers that must read the latest values without re-subscribing.
  const activeDataWorkspaceTabPathRef = useRef('')
  activeDataWorkspaceTabPathRef.current = activeDataWorkspaceTabPath
  const lastTargetRef = useRef(lastTarget)
  lastTargetRef.current = lastTarget

  const isBrowserTab = activeWorkspaceTab?.type === 'browser'
  const documentPath = useMemo(() => {
    if (activeDataWorkspaceTabPath) return activeDataWorkspaceTabPath
    if (isBrowserTab) return browserResolvedDocumentPath
    return ''
  }, [activeDataWorkspaceTabPath, isBrowserTab, browserResolvedDocumentPath])
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

  // Remember the table tab the user is looking at.
  useEffect(() => {
    if (!activeDataWorkspaceTabPath) return
    const published = contextByPath[activeDataWorkspaceTabPath]
    const next: WorkspaceTableAgentTarget = {
      documentPath: activeDataWorkspaceTabPath,
      tableId: published?.activeTable?.id ?? activeDataWorkspaceTableId,
      originLabel: String(published?.activeTable?.title || published?.activeDocument?.title || '').trim(),
    }
    setLastTarget((current) => (sameTarget(current, next) ? current : next))
  }, [activeDataWorkspaceTabPath, activeDataWorkspaceTableId, contextByPath])

  // Remember the table a browser tab was opened from.
  useEffect(() => {
    if (!browserResolvedDocumentPath) return
    const published = contextByPath[browserResolvedDocumentPath]
    const next: WorkspaceTableAgentTarget = {
      documentPath: browserResolvedDocumentPath,
      tableId: browserResolvedTableId,
      originLabel: String(
        activeBrowserTab?.originLabel
          || published?.activeTable?.title
          || published?.activeDocument?.title
          || lastTarget.originLabel
          || '',
      ).trim(),
    }
    setLastTarget((current) => (sameTarget(current, next) ? current : next))
  }, [activeBrowserTab?.originLabel, browserResolvedDocumentPath, browserResolvedTableId, lastTarget.originLabel, contextByPath])

  // Hydrate a context nobody published yet, or whose table no longer matches the browser origin.
  useEffect(() => {
    if (!hasTarget || !documentPath) return
    const needsHydration =
      !context?.activeDocument
      || !context?.activeTable
      || (isBrowserTab && Boolean(browserResolvedTableId) && context.activeTable.id !== browserResolvedTableId)
    if (!needsHydration) return
    void refreshByPath(
      documentPath,
      isBrowserTab ? browserResolvedTableId : activeDataWorkspaceTableId || context?.activeTable?.id || null,
    ).catch(() => {
      // Keep the workspace usable even if lazy table-agent hydration fails.
    })
  }, [
    isBrowserTab,
    activeDataWorkspaceTableId,
    browserResolvedTableId,
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
    browserOriginDocumentPath,
    browserResolvedTableId,
    lastTargetRef,
    handleContextChange,
  }
}
