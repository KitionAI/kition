import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { getWorkspaceItemTitle, inferWorkspaceItemFormat } from '@/features/workspace/lib/workspace'
import { notify } from '@/lib/notify'
import type { WorkspaceDocument, WorkspaceDocumentFormat } from '@/services/desktop'
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
  openKitableContainer: (kitablePath: string) => void
  openBoard: (path: string) => void
  openDocument: (path: string) => Promise<void>
}

function documentUid() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `doc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Tab-strip behavior that is not tab-list state: closing a tab (flushing a
 * design editor first, closing the workflow workbench with its last tab),
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
  openKitableContainer,
  openBoard,
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

  // Cmd/Ctrl+W closes the active tab. preventDefault stops Electron and the
  // browser from closing the window when the shortcut bubbles up unhandled;
  // no-op without an active tab so empty workspaces do not swallow the key.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'w') return
      if (!activeWorkspaceTabId) return
      event.preventDefault()
      handleCloseWorkspaceTabById(activeWorkspaceTabId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeWorkspaceTabId, handleCloseWorkspaceTabById])

  // A scoped table/workflow tab belongs to its .kitable container: keep the
  // primary tree focused on that container while the inner sidebar owns
  // table and workflow selection.
  useEffect(() => {
    if (!activeWorkspaceTab) return
    switch (activeWorkspaceTab.type) {
      case 'table':
      case 'dashboard':
        setActiveResourcePath(activeWorkspaceTab.kitablePath)
        return
      case 'board':
      case 'design':
        setActiveResourcePath(activeWorkspaceTab.path)
        return
      case 'workflow':
        if (activeWorkspaceTab.kitablePath) setActiveResourcePath(activeWorkspaceTab.kitablePath)
        return
      default:
        return
    }
  }, [activeWorkspaceTab, setActiveResourcePath])

  const openDocumentTab = useCallback((document: WorkspaceDocument) => {
    const format = inferWorkspaceItemFormat(document.path, document.content)
    if (format === 'design') {
      openDesign(document.path)
      return
    }
    if (format === 'data' && document.path.toLowerCase().endsWith('.kitable')) {
      openKitableContainer(document.path)
      return
    }
    upsertWorkspaceTab({
      id: `document:${document.path}`,
      type: 'document',
      title: getWorkspaceItemTitle(document.name),
      path: document.path,
      format,
      uid: documentUid(),
    })
  }, [openDesign, openKitableContainer, upsertWorkspaceTab])

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
      } else if (lower.endsWith('.kiboard')) {
        openBoard(path)
      } else {
        void openDocument(path)
      }
    }
    window.addEventListener('kition:search:open-path', handler)
    return () => window.removeEventListener('kition:search:open-path', handler)
  }, [openBoard, openDesign, openDocument])

  return { handleCloseWorkspaceTabById, openDocumentTab, openFileViewerTab }
}
