/**
 * Context-menu and activation handlers for the workspace tab strip. Closing
 * goes through `closeTab` one tab at a time so every tab type keeps its own
 * close rules (design flush, workflow workbench); this module only decides
 * which tabs a command affects and when the full-screen workflow route has
 * to be dismissed.
 */
import type { ComponentProps } from 'react'

import type { WorkspaceTabStrip } from '@/features/workspace/components/WorkspaceTabStrip'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { selectItemsToClose } from '@/features/workspace/state/closeScope'

type TabStripProps = ComponentProps<typeof WorkspaceTabStrip>

export type WorkspaceTabStripActionsInput = {
  tabs: WorkspaceTab[]
  activeTabId: string
  /** The full-screen workflow route is showing. */
  workflowOpen: boolean
  closeTab: (tabId: string) => void
  activateTab: (tab: WorkspaceTab) => Promise<void> | void
  onCloseWorkflow?: () => void
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
  const { tabs, closeTab, workflowOpen, onCloseWorkflow } = input
  const closeAll = (list: WorkspaceTab[]) => list.forEach((tab) => closeTab(tab.id))

  return {
    tabs,
    activeTabId: input.activeTabId,
    onActivate: (tab) => {
      input.onCloseProfile?.()
      // The full-screen workflow route is gated on the URL, so switching to a
      // non-workflow tab without leaving it would keep covering the tab.
      if (workflowOpen && tab.type !== 'workflow') onCloseWorkflow?.()
      return input.activateTab(tab)
    },
    onClose: closeTab,
    onCloseOthers: (tabId) => {
      closeAll(selectItemsToClose(tabs, tabId, 'others'))
      const keeper = tabs.find((tab) => tab.id === tabId)
      if (workflowOpen && keeper && keeper.type !== 'workflow') onCloseWorkflow?.()
    },
    onCloseAll: () => {
      closeAll(tabs)
      if (workflowOpen) onCloseWorkflow?.()
    },
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
