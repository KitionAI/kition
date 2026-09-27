import { useCallback } from 'react'

import type { KitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import { useKitableDashboardLeafActions } from '@/features/workspace/hooks/useKitableDashboardLeafActions'
import { useKitableTableLeafActions } from '@/features/workspace/hooks/useKitableTableLeafActions'
import { useKitableWorkflowLeafActions } from '@/features/workspace/hooks/useKitableWorkflowLeafActions'
import type { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'
import type { UpsertTabOptions } from '@/features/workspace/state/tabs'
import type { WorkspaceTab, WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import { buildKitableWorkspaceTabId, getKitableWorkspaceTabTitle } from '@/features/workspace/lib/workspace'
import {
  parseKitableDashboardVirtualPath,
  parseKitableTableVirtualPath,
  parseKitableWorkflowVirtualPath,
} from '@/features/workspace/lib/workspaceTree'

type TreeActions = ReturnType<typeof useWorkspaceTreeActions>

type UseWorkspaceTreeRowActionsOptions = {
  workspaceTabs: WorkspaceTab[]
  activeWorkspaceTabId: string
  upsertWorkspaceTab: (tab: WorkspaceTab, options?: UpsertTabOptions) => void
  kitableChildrenIndex: KitableChildrenIndex
  activeResourcePath: string
  setActiveResourcePath: (path: string) => void
  setError: (message: string) => void
  setFeedback: (message: string) => void
  deleteDocumentNode: TreeActions['deleteDocumentNode']
  renameWorkspaceNode: TreeActions['renameWorkspaceNode']
}

/**
 * Rename and delete for tree rows. Virtual leaves under a .kitable (table,
 * dashboard, workflow) go through their domain APIs; real files go through
 * the workspace tree actions. When the view shown in a kitable's file-level
 * tab is deleted, the tab falls back to another table in the same file, or
 * to the workflow view when none is left.
 */
export function useWorkspaceTreeRowActions({
  workspaceTabs,
  activeWorkspaceTabId,
  upsertWorkspaceTab,
  kitableChildrenIndex,
  activeResourcePath,
  setActiveResourcePath,
  setError,
  setFeedback,
  deleteDocumentNode,
  renameWorkspaceNode,
}: UseWorkspaceTreeRowActionsOptions) {
  const { tablesByKitablePath } = kitableChildrenIndex

  const fallBackKitableTab = useCallback((kitablePath: string, excludeTableId?: number) => {
    const tabId = buildKitableWorkspaceTabId(kitablePath)
    const fallbackTable = (tablesByKitablePath[kitablePath] || [])
      .filter((table) => table.id !== excludeTableId)
      .sort((left, right) => left.order - right.order)[0]
    const options = { activate: activeWorkspaceTabId === tabId }
    const title = getKitableWorkspaceTabTitle(kitablePath)
    if (fallbackTable) {
      upsertWorkspaceTab({ id: tabId, type: 'table', title, kitablePath, tableId: fallbackTable.id, format: 'data' }, options)
      return
    }
    upsertWorkspaceTab({ id: tabId, type: 'workflow', title, kitablePath }, options)
  }, [activeWorkspaceTabId, tablesByKitablePath, upsertWorkspaceTab])

  const findKitableTab = useCallback((kitablePath: string) => (
    workspaceTabs.find((item) => item.id === buildKitableWorkspaceTabId(kitablePath))
  ), [workspaceTabs])

  const handleTableDeleted = useCallback((kitablePath: string, tableId: number) => {
    const tab = findKitableTab(kitablePath)
    if (tab?.type !== 'table' || tab.tableId !== tableId) return
    fallBackKitableTab(kitablePath, tableId)
  }, [fallBackKitableTab, findKitableTab])

  const handleDashboardDeleted = useCallback((kitablePath: string, dashboardId: string) => {
    const tab = findKitableTab(kitablePath)
    if (tab?.type !== 'dashboard' || tab.dashboardId !== dashboardId) return
    fallBackKitableTab(kitablePath)
  }, [fallBackKitableTab, findKitableTab])

  const handleWorkflowDeleted = useCallback((kitablePath: string, workflowId: string) => {
    const tab = findKitableTab(kitablePath)
    if (tab?.type !== 'workflow' || tab.workflowId !== workflowId) return
    fallBackKitableTab(kitablePath)
  }, [fallBackKitableTab, findKitableTab])

  const shared = { kitableChildrenIndex, activeResourcePath, setActiveResourcePath, setError, setFeedback }
  const { renameKitableTableLeaf, deleteKitableTableLeaf } = useKitableTableLeafActions({
    ...shared,
    onTableDeleted: handleTableDeleted,
  })
  const { renameKitableDashboardLeaf, deleteKitableDashboardLeaf } = useKitableDashboardLeafActions({
    ...shared,
    onDashboardDeleted: handleDashboardDeleted,
  })
  const { renameKitableWorkflowLeaf, deleteKitableWorkflowLeaf } = useKitableWorkflowLeafActions({
    ...shared,
    onWorkflowDeleted: handleWorkflowDeleted,
  })

  const handleTreeNodeDelete = useCallback((node: WorkspaceTreeNode) => {
    if (parseKitableTableVirtualPath(node.path)) {
      void deleteKitableTableLeaf(node)
    } else if (parseKitableDashboardVirtualPath(node.path)) {
      void deleteKitableDashboardLeaf(node)
    } else if (parseKitableWorkflowVirtualPath(node.path)) {
      void deleteKitableWorkflowLeaf(node)
    } else {
      void deleteDocumentNode(node)
    }
  }, [deleteDocumentNode, deleteKitableDashboardLeaf, deleteKitableTableLeaf, deleteKitableWorkflowLeaf])

  const handleTreeNodeRename = useCallback((node: WorkspaceTreeNode, nextTitle: string) => {
    if (parseKitableTableVirtualPath(node.path)) {
      void renameKitableTableLeaf(node, nextTitle)
    } else if (parseKitableDashboardVirtualPath(node.path)) {
      void renameKitableDashboardLeaf(node, nextTitle)
    } else if (parseKitableWorkflowVirtualPath(node.path)) {
      void renameKitableWorkflowLeaf(node, nextTitle)
    } else {
      void renameWorkspaceNode(node, nextTitle)
    }
  }, [renameKitableDashboardLeaf, renameKitableTableLeaf, renameKitableWorkflowLeaf, renameWorkspaceNode])

  return { handleTreeNodeDelete, handleTreeNodeRename, renameKitableTableLeaf }
}
