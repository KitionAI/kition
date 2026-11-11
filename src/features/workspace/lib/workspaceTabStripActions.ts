/**
 * Context-menu and activation handlers for the workspace tab strip. Closing
 * goes through `closeTab` one tab at a time so every tab type keeps its own
 * close rules; this module only decides which tabs a command affects.
 */
import type { ComponentProps } from 'react'

import type { WorkspaceTabStrip } from '@/features/workspace/components/WorkspaceTabStrip'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { selectItemsToClose } from '@/features/workspace/state/closeScope'

type TabStripProps = ComponentProps<typeof WorkspaceTabStrip>

export type WorkspaceTabStripActionsInput = {
  tabs: WorkspaceTab[]
  activeTabId: string
  closeTab: (tabId: string) => void
  activateTab: (tab: WorkspaceTab) => Promise<void> | void
  onCloseProfile?: () => void
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}

const READ_ONLY_TAB_TYPES = new Set<WorkspaceTab['type']>(['file-viewer', 'gallery'])

/** Text copied by "Copy reference": the file path or the title. */
export function workspaceTabReference(tab: WorkspaceTab) {
  if (tab.type === 'file-viewer') return tab.path
  return tab.title
}

export function buildWorkspaceTabStripProps(input: WorkspaceTabStripActionsInput): TabStripProps {
  const { tabs, closeTab } = input
  const closeAll = (list: WorkspaceTab[]) => list.forEach((tab) => closeTab(tab.id))

  return {
    tabs,
    activeTabId: input.activeTabId,
    onActivate: (tab) => {
      input.onCloseProfile?.()
      return input.activateTab(tab)
    },
    onClose: closeTab,
    onCloseOthers: (tabId) => closeAll(selectItemsToClose(tabs, tabId, 'others')),
    onCloseAll: () => closeAll(tabs),
    // A kit keeps its own unsaved edits and asks before its tab closes.
    onCloseUnmodified: () => closeAll(tabs),
    onCloseLeft: (tabId) => closeAll(selectItemsToClose(tabs, tabId, 'left')),
    onCloseRight: (tabId) => closeAll(selectItemsToClose(tabs, tabId, 'right')),
    onCloseReadOnly: () => closeAll(tabs.filter((tab) => READ_ONLY_TAB_TYPES.has(tab.type))),
    onCopyTabRef: (tab) => {
      const text = workspaceTabReference(tab)
      if (text && typeof navigator !== 'undefined' && navigator.clipboard) {
        void navigator.clipboard.writeText(text)
      }
    },
    sidebarCollapsed: input.sidebarCollapsed,
    onToggleSidebar: input.onToggleSidebar,
  }
}
