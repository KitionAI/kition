import {
  parseKitableDashboardVirtualPath,
  parseKitableTableVirtualPath,
} from '@/features/workspace/lib/workspaceTree'
import {
  buildKitableWorkspaceTabId,
  getKitableWorkspaceTabTitle,
  type WorkspaceTab,
} from '@/features/workspace/lib/workspace'
import type { KitableTableSummary } from '@/features/workspace/lib/workspaceTree'

type IndexSnapshot = {
  tablesByKitablePath: Record<string, KitableTableSummary[]>
}

type KitableResourceTab = Extract<WorkspaceTab, { type: 'dashboard' | 'table' }>

export function routeKitableOpenPath(
  path: string,
  index: IndexSnapshot,
  upsertWorkspaceTab: (tab: KitableResourceTab) => void,
): boolean {
  const parsed = parseKitableTableVirtualPath(path)
  if (parsed) {
    upsertWorkspaceTab({
      id: buildKitableWorkspaceTabId(parsed.kitablePath),
      type: 'table',
      title: getKitableWorkspaceTabTitle(parsed.kitablePath),
      kitablePath: parsed.kitablePath,
      tableId: parsed.tableId,
      format: 'data',
    })
    return true
  }

  const dashboard = parseKitableDashboardVirtualPath(path)
  if (!dashboard) return false
  upsertWorkspaceTab({
    id: buildKitableWorkspaceTabId(dashboard.kitablePath),
    type: 'dashboard',
    title: getKitableWorkspaceTabTitle(dashboard.kitablePath),
    kitablePath: dashboard.kitablePath,
    dashboardId: dashboard.dashboardId,
    format: 'data',
  })
  return true
}
