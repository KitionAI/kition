import { useCallback, useEffect, useRef } from 'react'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { getWorkspaceItemTitle } from '@/features/workspace/lib/workspace'
import { useShortcut } from '@/lib/useShortcut'
import type { WorkspaceDocumentFormat } from '@/services/desktop'

type UseWorkspaceTabControllersOptions = {
  workspaceTabs: WorkspaceTab[]
  activeWorkspaceTab: WorkspaceTab | undefined
  activeWorkspaceTabId: string
  closeWorkspaceTab: (tabId: string) => void
  upsertWorkspaceTab: (tab: WorkspaceTab) => void
  setActiveResourcePath: (path: string) => void
  workflowOpen: boolean
  onCloseWorkflow?: () => void
  openDocument: (path: string) => Promise<void>
}

/**
 * Tab-strip behavior that is not tab-list state: closing a tab (closing the
 * workflow workbench with its last tab),
 * the Cmd/Ctrl+W shortcut, keeping the tree focused on the active tab's
 * file, opening a file into the right tab type, and the search palette's
 * open-path requests.
 */
export function useWorkspaceTabControllers({
  workspaceTabs,
  activeWorkspaceTab,
  activeWorkspaceTabId,
  closeWorkspaceTab,
  upsertWorkspaceTab,
  setActiveResourcePath,
  workflowOpen,
  onCloseWorkflow,
  openDocument,
}: UseWorkspaceTabControllersOptions) {
  const workspaceTabsRef = useRef<WorkspaceTab[]>([])
  workspaceTabsRef.current = workspaceTabs
  const handleCloseWorkspaceTabById = useCallback((tabId: string) => {
    const tabs = workspaceTabsRef.current
    const closing = tabs.find((tab) => tab.id === tabId)
    if (!closing) return
    closeWorkspaceTab(tabId)
    if (workflowOpen && closing.type === 'workflow') {
      const remainingWorkflow = tabs.some((tab) => tab.id !== tabId && tab.type === 'workflow')
      if (!remainingWorkflow) onCloseWorkflow?.()
    }
  }, [closeWorkspaceTab, onCloseWorkflow, workflowOpen])

  // Cmd/Ctrl+W closes the active tab. Disabled without one so an empty
  // workspace lets the key reach the desktop shell and the browser.
  useShortcut('Mod+W', () => handleCloseWorkspaceTabById(activeWorkspaceTabId), { enabled: Boolean(activeWorkspaceTabId) })

  // A table file's workflow tab keeps the tree focused on its file.
  useEffect(() => {
    if (activeWorkspaceTab?.type === 'workflow' && activeWorkspaceTab.tablePath) {
      setActiveResourcePath(activeWorkspaceTab.tablePath)
    }
  }, [activeWorkspaceTab, setActiveResourcePath])

  const openFileViewerTab = useCallback((path: string, format: WorkspaceDocumentFormat) => {
    const filename = String(path || '').split('/').filter(Boolean).pop() || path
    upsertWorkspaceTab({
      id: `file-viewer:${path}`,
      type: 'file-viewer',
      title: getWorkspaceItemTitle(filename),
      path,
      format,
    })
  }, [upsertWorkspaceTab])

  // The search palette asks to open a path; route it by file type.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { path?: string; vaultPath?: string }
      const path = detail?.path || detail?.vaultPath
      if (path) void openDocument(path)
    }
    window.addEventListener('kition:search:open-path', handler)
    return () => window.removeEventListener('kition:search:open-path', handler)
  }, [openDocument])

  return { handleCloseWorkspaceTabById, openFileViewerTab }
}
