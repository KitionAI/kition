import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { useConfirm } from '@/components/confirm'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { getWorkspaceItemTitle, inferWorkspaceItemFormat } from '@/features/workspace/lib/workspace'
import { notify } from '@/lib/notify'
import { useShortcut } from '@/lib/useShortcut'
import type { WorkspaceDocument, WorkspaceDocumentFormat } from '@/services/desktop'
import { discardWorkspaceEditSessions, flushWorkspaceEditSessions } from '@/services/workspaceEditSessions'

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
 * design or Board editor first; a Board whose save fails may be closed without
 * its unsaved changes once the user confirms; closing the workflow workbench
 * with its last tab),
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
  const confirm = useConfirm()
  const workspaceTabsRef = useRef<WorkspaceTab[]>([])
  workspaceTabsRef.current = workspaceTabs
  /** Board tabs whose close is saving or waiting for the user's answer: closing again does nothing. */
  const closingBoardTabsRef = useRef(new Set<string>())

  /** Closes a Board tab once its pending save is written, or after the user discards what could not be saved. */
  const closeBoardTab = useCallback(async (tabId: string, path: string) => {
    const closing = closingBoardTabsRef.current
    if (closing.has(tabId)) return
    closing.add(tabId)
    try {
      try {
        await flushWorkspaceEditSessions(path)
      } catch {
        const discard = await confirm({
          message: t('whiteboard.file.closeUnsavedMessage'),
          confirmLabel: t('whiteboard.file.closeUnsavedDiscard'),
          cancelLabel: t('whiteboard.file.closeUnsavedKeep'),
          variant: 'destructive',
          testId: 'board-close-unsaved-confirm',
        })
        // Keeping the tab keeps its edits and the session's retries.
        if (!discard) return
        // Stop saving first, so closing the editor writes nothing and leaves the file as it is.
        discardWorkspaceEditSessions(path)
      }
      closeWorkspaceTab(tabId)
    } finally {
      closing.delete(tabId)
    }
  }, [closeWorkspaceTab, confirm, t])

  const handleCloseWorkspaceTabById = useCallback((tabId: string) => {
    const tabs = workspaceTabsRef.current
    const closing = tabs.find((tab) => tab.id === tabId)
    if (!closing) return
    if (closing.type === 'board') {
      void closeBoardTab(tabId, closing.path)
      return
    }
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
  }, [closeBoardTab, closeWorkspaceTab, onCloseWorkflow, t, workflowOpen])

  // Cmd/Ctrl+W closes the active tab. Disabled without one so an empty
  // workspace lets the key reach the desktop shell and the browser.
  useShortcut('Mod+W', () => handleCloseWorkspaceTabById(activeWorkspaceTabId), { enabled: Boolean(activeWorkspaceTabId) })

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
