import type { ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import { WorkspaceTabStrip } from '@/features/workspace/components/WorkspaceTabStrip'

/** The workspace's tab strip, in the window's title bar. */
export function WorkspaceTopbar({
  tabsPortal,
  tabStripProps,
}: {
  tabsPortal: HTMLElement | null
  tabStripProps: ComponentProps<typeof WorkspaceTabStrip>
}) {
  return tabsPortal && (tabStripProps.tabs.length > 0 || tabStripProps.sidebarCollapsed)
    ? createPortal(<WorkspaceTabStrip {...tabStripProps} />, tabsPortal)
    : null
}
