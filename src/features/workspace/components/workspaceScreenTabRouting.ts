import { parseKitableTableVirtualPath } from '@/features/workspace/lib/workspaceTree'
import {
  buildKitableWorkspaceTabId,
  getKitableWorkspaceTabTitle,
  type WorkspaceTab,
} from '@/features/workspace/lib/workspace'
import type { KitableTableSummary } from '@/features/workspace/lib/workspaceTree'

type IndexSnapshot = {
  tablesByKitablePath: Record<string, KitableTableSummary[]>
}

type TableTab = Extract<WorkspaceTab, { type: 'table' }>

export function routeKitableOpenPath(
  path: string,
  index: IndexSnapshot,
  upsertWorkspaceTab: (tab: TableTab) => void,
): boolean {
  const parsed = parseKitableTableVirtualPath(path)
  if (!parsed) return false
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
