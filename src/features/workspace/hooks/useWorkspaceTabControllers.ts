import { useCallback, useEffect, useRef } from 'react'

import { openWithUnsavedEdits, saveOpenEditor } from '@/features/kits/public'
import type { UnsavedCloseChoice, UnsavedCloseScope } from '@/features/workspace/components/UnsavedCloseDialog'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { getWorkspaceItemTitle } from '@/features/workspace/lib/workspace'
import { useShortcut } from '@/lib/useShortcut'
import type { WorkspaceDocumentFormat } from '@/services/desktop'

type UseWorkspaceTabControllersOptions = {
  workspaceTabs: WorkspaceTab[]
  activeWorkspaceTabId: string
  closeWorkspaceTab: (tabId: string) => void
  upsertWorkspaceTab: (tab: WorkspaceTab) => void
  openDocument: (path: string) => Promise<void>
  /** Asks the person what to do with a tab's unsaved edits before it closes (`useUnsavedCloseQuestion`). */
  askUnsavedClose: (scope: UnsavedCloseScope) => Promise<UnsavedCloseChoice>
}

/**
 * Tab-strip behavior that is not tab-list state: closing a tab (asking first
 * when its kit editor has unsaved edits), the Cmd/Ctrl+W shortcut, opening a
 * file into the right tab type, and kit links' open-path requests.
 */
export function useWorkspaceTabControllers({
  workspaceTabs,
  activeWorkspaceTabId,
  closeWorkspaceTab,
  upsertWorkspaceTab,
  openDocument,
  askUnsavedClose,
}: UseWorkspaceTabControllersOptions) {
  const workspaceTabsRef = useRef<WorkspaceTab[]>([])
  workspaceTabsRef.current = workspaceTabs
  const handleCloseWorkspaceTabById = useCallback(async (tabId: string) => {
    const closing = workspaceTabsRef.current.find((tab) => tab.id === tabId)
    if (!closing) return
    // A kit document's unsaved edits live only in its editor: closing the tab would lose them.
    if (closing.type === 'file-viewer' && openWithUnsavedEdits(closing.path)) {
      const choice = await askUnsavedClose({ kind: 'tab', names: [closing.title] })
      if (choice === 'cancel') return
      // A save that fails (the file changed on disk, a refused write) keeps the tab; the kit says why.
      if (choice === 'save' && (await saveOpenEditor(closing.path).catch(() => false)) !== true) return
    }
    const tabs = workspaceTabsRef.current
    if (!tabs.some((tab) => tab.id === tabId)) return
    closeWorkspaceTab(tabId)
  }, [askUnsavedClose, closeWorkspaceTab])

  // Cmd/Ctrl+W closes the active tab. Disabled without one so an empty
  // workspace lets the key reach the desktop shell and the browser.
  useShortcut('Mod+W', () => void handleCloseWorkspaceTabById(activeWorkspaceTabId), { enabled: Boolean(activeWorkspaceTabId) })

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

  // A kit link asks to open a path; route it by file type.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { path?: string; vaultPath?: string }
      const path = detail?.path || detail?.vaultPath
      if (path) void openDocument(path)
    }
    window.addEventListener('kition:workspace:open-path', handler)
    return () => window.removeEventListener('kition:workspace:open-path', handler)
  }, [openDocument])

  return { handleCloseWorkspaceTabById, openFileViewerTab }
}
