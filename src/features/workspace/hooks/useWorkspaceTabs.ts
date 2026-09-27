import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceMediaKind, WorkspaceTab } from '@/features/workspace/lib/workspace'
import { readWorkspaceTabs, writeWorkspaceTabs } from '@/features/workspace/lib/workspacePersistence'
import {
  bindInitialWorkspaceTabs,
  closeTab,
  filterTabs,
  remapTabPaths,
  renameTabPath,
  switchWorkspaceTabs,
  updateTab,
  upsertTab,
  type TabsState,
  type UpsertTabOptions,
} from '@/features/workspace/state/tabs'

type UseWorkspaceTabsOptions = {
  rootPath: string
  activeDocumentPath: string
  onOpenDocument: (path: string) => Promise<void>
  onActivateGallery: (kind: WorkspaceMediaKind) => void
  onCloseDocumentTab?: (tab: Extract<WorkspaceTab, { type: 'document' }>) => void
}

/**
 * Owns the open tab list for the active workspace: persistence per root,
 * the atomic switch between workspaces, and the side effects that follow a
 * tab change. The transitions themselves live in `state/tabs.ts`.
 */
export function useWorkspaceTabs({
  rootPath,
  activeDocumentPath,
  onOpenDocument,
  onActivateGallery,
  onCloseDocumentTab,
}: UseWorkspaceTabsOptions) {
  const [state, setState] = useState<TabsState>(() => {
    const stored = readWorkspaceTabs(rootPath)
    return { tabs: stored, activeTabId: stored[0]?.id || '' }
  })
  const [tabsRoot, setTabsRoot] = useState(rootPath)

  // Snapshot of the state at the last COMMITTED render. The atomic switch
  // below uses it to tell apart tabs that came from the old workspace (drop)
  // versus tabs upserted in the same React batch as the rootPath change
  // (keep). Updated in an effect so it never reflects an in-flight render.
  const lastCommittedRef = useRef<TabsState>({ tabs: [], activeTabId: '' })

  // Atomic workspace switch: when rootPath changes between two real workspaces
  // we swap the tab list during render. React discards the in-progress render
  // and re-renders with the new values, so the persistence effect never sees
  // a stale-tabs/new-root combination. The empty→real transition (first mount,
  // before the vault registry resolved) is a binding, not a switch: tabs that
  // were already opened survive.
  if (tabsRoot && tabsRoot !== rootPath) {
    setTabsRoot(rootPath)
    setState((current) => switchWorkspaceTabs(current, readWorkspaceTabs(rootPath), lastCommittedRef.current))
  } else if (!tabsRoot && rootPath) {
    setTabsRoot(rootPath)
    setState((current) => bindInitialWorkspaceTabs(current, readWorkspaceTabs(rootPath)))
  }

  useEffect(() => {
    lastCommittedRef.current = state
  })

  const { tabs: workspaceTabs, activeTabId: activeWorkspaceTabId } = state

  const activeWorkspaceTab = useMemo(
    () => workspaceTabs.find((item) => item.id === activeWorkspaceTabId) || workspaceTabs[0],
    [activeWorkspaceTabId, workspaceTabs],
  )

  const setActiveWorkspaceTabId = useCallback((update: string | ((current: string) => string)) => {
    setState((current) => {
      const activeTabId = typeof update === 'function' ? update(current.activeTabId) : update
      return activeTabId === current.activeTabId ? current : { ...current, activeTabId }
    })
  }, [])

  const upsertWorkspaceTab = useCallback((tab: WorkspaceTab, options: UpsertTabOptions = {}) => {
    setState((current) => upsertTab(current, tab, options))
  }, [])

  const updateWorkspaceTab = useCallback((tabId: string, updater: (tab: WorkspaceTab) => WorkspaceTab) => {
    setState((current) => updateTab(current, tabId, updater))
  }, [])

  // Side effects for a closed document tab run after the update is applied,
  // never inside the updater (StrictMode invokes updaters twice).
  const closeWorkspaceTab = useCallback((tabId: string) => {
    const closing = lastCommittedRef.current.tabs.find((item) => item.id === tabId)
    setState((current) => closeTab(current, tabId).state)
    if (closing?.type === 'document') {
      onCloseDocumentTab?.(closing)
    }
  }, [onCloseDocumentTab])

  const filterWorkspaceTabs = useCallback((predicate: (tab: WorkspaceTab) => boolean) => {
    setState((current) => filterTabs(current, predicate))
  }, [])

  // After a move/rename, the on-disk path changes: remap open tabs so clicking
  // them does not read the old path and fail with ENOENT.
  const remapWorkspaceTabPaths = useCallback((sourcePath: string, targetPath: string) => {
    setState((current) => remapTabPaths(current, sourcePath, targetPath))
  }, [])

  // Remap the single file-level kitable tab when its file is renamed.
  const renameWorkspaceTabPath = useCallback((fromPath: string, toPath: string) => {
    setState((current) => renameTabPath(current, fromPath, toPath))
  }, [])

  const activateWorkspaceTab = useCallback(async (tab: WorkspaceTab) => {
    setActiveWorkspaceTabId(tab.id)

    if (tab.type === 'document' && activeDocumentPath !== tab.path) {
      await onOpenDocument(tab.path)
      return
    }

    if (tab.type === 'gallery') {
      onActivateGallery(tab.kind)
    }
  }, [activeDocumentPath, onActivateGallery, onOpenDocument, setActiveWorkspaceTabId])

  useEffect(() => {
    if (!rootPath || tabsRoot !== rootPath) {
      // Either no workspace yet, or mid-switch with the previous workspace's
      // tabs still in state. Skip writing to avoid clobbering the new slot.
      return
    }
    writeWorkspaceTabs(rootPath, workspaceTabs)
  }, [workspaceTabs, rootPath, tabsRoot])

  return {
    activeWorkspaceTab,
    activeWorkspaceTabId,
    activateWorkspaceTab,
    closeWorkspaceTab,
    filterWorkspaceTabs,
    remapWorkspaceTabPaths,
    renameWorkspaceTabPath,
    setActiveWorkspaceTabId,
    updateWorkspaceTab,
    upsertWorkspaceTab,
    workspaceTabs,
  }
}
