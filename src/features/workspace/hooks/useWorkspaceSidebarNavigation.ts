import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { routeKitableOpenPath } from '@/features/workspace/components/workspaceScreenTabRouting'
import type { KitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { buildKitableWorkspaceTabId, getKitableWorkspaceTabTitle } from '@/features/workspace/lib/workspace'
import {
  parseKitableDashboardVirtualPath,
  parseKitableTableVirtualPath,
  parseKitableWorkflowVirtualPath,
} from '@/features/workspace/lib/workspaceTree'

const WORKFLOWS_LEAF_PREFIX = 'workflows://'
const WORKFLOW_LEAF_PREFIX = 'workflow://'

type UseWorkspaceSidebarNavigationOptions = {
  kitableChildrenIndex: KitableChildrenIndex
  upsertWorkspaceTab: (tab: WorkspaceTab) => void
  setActiveResourcePath: (path: string) => void
  workflowOpen: boolean
  onCloseWorkflow?: () => void
  onCloseProfile?: () => void
  openDesign: (path: string) => void
  openBoard: (path: string) => void
  openKitableContainer: (kitablePath: string) => void
  openDocument: (path: string) => Promise<void>
}

/**
 * Routes a click on a sidebar row to the right tab. Real files open by
 * format; the virtual rows the tree synthesizes under a .kitable (tables,
 * dashboards, the Workflows folder, single workflows) carry sentinel paths
 * that map to tabs without touching the file system.
 */
export function useWorkspaceSidebarNavigation({
  kitableChildrenIndex,
  upsertWorkspaceTab,
  setActiveResourcePath,
  workflowOpen,
  onCloseWorkflow,
  onCloseProfile,
  openDesign,
  openBoard,
  openKitableContainer,
  openDocument,
}: UseWorkspaceSidebarNavigationOptions) {
  const { t } = useTranslation('workspace')

  const openSidebarPath = useCallback((path: string) => {
    onCloseProfile?.()
    // The full-screen workflow route masks the editor pane: a click into a
    // non-workflow row would only flip the active tab and show no change,
    // so close the route for anything that is not itself a workflow row.
    const opensWorkflowTab = path.startsWith(WORKFLOWS_LEAF_PREFIX) || path.startsWith(WORKFLOW_LEAF_PREFIX)
    if (workflowOpen && !opensWorkflowTab) onCloseWorkflow?.()

    const lower = path.toLowerCase()
    if (lower.endsWith('.kidesign')) {
      openDesign(path)
      return
    }
    if (lower.endsWith('.kiboard')) {
      openBoard(path)
      return
    }
    if (lower.endsWith('.kitable')) {
      openKitableContainer(path)
      return
    }
    if (routeKitableOpenPath(path, kitableChildrenIndex, upsertWorkspaceTab)) {
      // The sidebar highlight keys off the resource path; the tab opener only
      // sees kitablePath + tableId, so push the container path here too.
      const tableResource = parseKitableTableVirtualPath(path)
      const dashboardResource = parseKitableDashboardVirtualPath(path)
      setActiveResourcePath(tableResource?.kitablePath || dashboardResource?.kitablePath || path)
      return
    }
    if (path.startsWith(WORKFLOWS_LEAF_PREFIX)) {
      const kitablePath = path.slice(WORKFLOWS_LEAF_PREFIX.length)
      upsertWorkspaceTab({
        id: kitablePath ? buildKitableWorkspaceTabId(kitablePath) : 'workflow:home',
        type: 'workflow',
        title: kitablePath ? getKitableWorkspaceTabTitle(kitablePath) : t('tabs.workflowsTitle'),
        kitablePath: kitablePath || undefined,
      })
      return
    }
    if (path.startsWith(WORKFLOW_LEAF_PREFIX)) {
      const parsed = parseKitableWorkflowVirtualPath(path)
      if (parsed) {
        upsertWorkspaceTab({
          id: buildKitableWorkspaceTabId(parsed.kitablePath),
          type: 'workflow',
          title: getKitableWorkspaceTabTitle(parsed.kitablePath),
          kitablePath: parsed.kitablePath,
          workflowId: parsed.workflowId,
        })
      }
      return
    }
    void openDocument(path)
  }, [
    kitableChildrenIndex,
    onCloseProfile,
    onCloseWorkflow,
    openBoard,
    openDesign,
    openDocument,
    openKitableContainer,
    setActiveResourcePath,
    t,
    upsertWorkspaceTab,
    workflowOpen,
  ])

  return { openSidebarPath }
}
