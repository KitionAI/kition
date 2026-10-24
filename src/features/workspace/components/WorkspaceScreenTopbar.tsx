import type { ComponentProps } from 'react'

import { WorkspaceTopbar } from '@/features/workspace/components/WorkspaceTopbar'
import type { useWorkspaceChrome } from '@/features/workspace/hooks/useWorkspaceChrome'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { buildWorkspaceTabStripProps } from '@/features/workspace/lib/workspaceTabStripActions'

type TopbarProps = ComponentProps<typeof WorkspaceTopbar>

/** What the topbar needs, as the bundles the workspace hooks already return. */
export type WorkspaceScreenTopbarInput = {
  tabsPortal: HTMLElement | null
  chrome: Pick<ReturnType<typeof useWorkspaceChrome>, 'sidebarCollapsed' | 'toggleSidebarCollapsed'>
  tabs: {
    workspaceTabs: WorkspaceTab[]
    activeWorkspaceTab: WorkspaceTab | undefined
    activeWorkspaceTabId: string
    activateWorkspaceTab: (tab: WorkspaceTab) => Promise<void> | void
    closeTab: (tabId: string) => void
  }
  workflowOpen: boolean
  onCloseWorkflow?: () => void
  onCloseProfile?: () => void
}

function buildWorkspaceTopbarProps(input: WorkspaceScreenTopbarInput): TopbarProps {
  const { chrome, tabs } = input
  return {
    tabsPortal: input.tabsPortal,
    tabStripProps: buildWorkspaceTabStripProps({
      tabs: tabs.workspaceTabs,
      activeTabId: tabs.activeWorkspaceTabId,
      workflowOpen: input.workflowOpen,
      closeTab: tabs.closeTab,
      activateTab: tabs.activateWorkspaceTab,
      onCloseWorkflow: input.onCloseWorkflow,
      onCloseProfile: input.onCloseProfile,
      sidebarCollapsed: chrome.sidebarCollapsed,
      onToggleSidebar: chrome.toggleSidebarCollapsed,
    }),
  }
}

/** The topbar: the tab strip. */
export function WorkspaceScreenTopbar(input: WorkspaceScreenTopbarInput) {
  return <WorkspaceTopbar {...buildWorkspaceTopbarProps(input)} />
}
