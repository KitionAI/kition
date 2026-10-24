import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { getWorkspaceItemTitle } from '@/features/workspace/lib/workspace'
import { notify } from '@/lib/notify'
import { useShortcut } from '@/lib/useShortcut'
import type { WorkspaceDocumentFormat } from '@/services/desktop'
import { flushWorkspaceEditSessions } from '@/services/workspaceEditSessions'

type UseWorkspaceTabControllersOptions = {
  workspaceTabs: WorkspaceTab[]
  activeWorkspaceTab: WorkspaceTab | undefined
  activeWorkspaceTabId: string
  closeWorkspaceTab: (tabId: string) => void
  upsertWorkspaceTab: (tab: WorkspaceTab) => void
  setActiveResourcePath: (path: string) => void
  workflowOpen: boolean
  onCloseWorkflow?: () => void
  openDesign: (path: string) => void
  openDocument: (path: string) => Promise<void>
}

/**
 * Tab-strip behavior that is not tab-list state: closing a tab (flushing a
 * design editor first; closing the workflow workbench with its last tab),
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
  openDesign,
  openDocument,
}: UseWorkspaceTabControllersOptions) {
  const { t } = useTranslation('workspace')
  const workspaceTabsRef = useRef<WorkspaceTab[]>([])
  workspaceTabsRef.current = workspaceTabs
  const handleCloseWorkspaceTabById = useCallback((tabId: string) => {
    const tabs = workspaceTabsRef.current
    const closing = tabs.find((tab) => tab.id === tabId)
    if (!closing) return
    if (closing.type === 'design') {
      // Write the editor's pending save first; a failed save keeps the tab and its edits open.
      void flushWorkspaceEditSessions(closing.path)
        .then(() => closeWorkspaceTab(tabId))
        .catch(() => notify.error(t('design:errors.save')))
      return
    }
    closeWorkspaceTab(tabId)
    if (workflowOpen && closing.type === 'workflow') {
      const remainingWorkflow = tabs.some((tab) => tab.id !== tabId && tab.type === 'workflow')
      if (!remainingWorkflow) onCloseWorkflow?.()
    }
  }, [closeWorkspaceTab, onCloseWorkflow, t, workflowOpen])

  // Cmd/Ctrl+W closes the active tab. Disabled without one so an empty
  // workspace lets the key reach the desktop shell and the browser.
  useShortcut('Mod+W', () => handleCloseWorkspaceTabById(activeWorkspaceTabId), { enabled: Boolean(activeWorkspaceTabId) })

  // A design or a table file's workflow tab keeps the tree focused on its file.
  useEffect(() => {
    if (!activeWorkspaceTab) return
    switch (activeWorkspaceTab.type) {
      case 'design':
        setActiveResourcePath(activeWorkspaceTab.path)
        return
      case 'workflow':
        if (activeWorkspaceTab.tablePath) setActiveResourcePath(activeWorkspaceTab.tablePath)
        return
      default:
        return
    }
  }, [activeWorkspaceTab, setActiveResourcePath])

  const openFileViewerTab = useCallback((path: string, format: WorkspaceDocumentFormat) => {
    if (path.toLowerCase().endsWith('.kidesign')) {
      openDesign(path)
      return
    }
    const filename = String(path || '').split('/').filter(Boolean).pop() || path
    upsertWorkspaceTab({
      id: `file-viewer:${path}`,
      type: 'file-viewer',
      title: getWorkspaceItemTitle(filename),
      path,
      format,
    })
  }, [openDesign, upsertWorkspaceTab])

  // The search palette asks to open a path; route it by file type.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { path?: string; vaultPath?: string }
      const path = detail?.path || detail?.vaultPath
      if (!path) return
      const lower = path.toLowerCase()
      if (lower.endsWith('.kidesign')) {
        openDesign(path)
      } else {
        void openDocument(path)
      }
    }
    window.addEventListener('kition:search:open-path', handler)
    return () => window.removeEventListener('kition:search:open-path', handler)
  }, [openDesign, openDocument])

  return { handleCloseWorkspaceTabById, openFileViewerTab }
}
