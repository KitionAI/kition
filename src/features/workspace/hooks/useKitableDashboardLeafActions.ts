import { useCallback } from 'react'

import {
  deleteDataDashboardByPath,
  renameDataDashboardByPath,
} from '@/api/dashboards'
import { useConfirm } from '@/components/confirm'
import type { KitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import { parseKitableDashboardVirtualPath } from '@/features/workspace/lib/workspaceTree'

export function useKitableDashboardLeafActions({
  activeResourcePath,
  kitableChildrenIndex,
  onDashboardDeleted,
  setActiveResourcePath,
  setError,
  setFeedback,
}: {
  activeResourcePath: string
  kitableChildrenIndex: KitableChildrenIndex
  onDashboardDeleted?: (kitablePath: string, dashboardId: string) => void
  setActiveResourcePath: (path: string) => void
  setError: (message: string) => void
  setFeedback: (message: string) => void
}) {
  const confirm = useConfirm()

  const renameKitableDashboardLeaf = useCallback(async (
    node: WorkspaceTreeNode,
    nextTitle: string,
  ) => {
    const title = nextTitle.trim()
    if (!title || title === node.title) return
    const parsed = parseKitableDashboardVirtualPath(node.path)
    if (!parsed) return
    setError('')
    setFeedback('')
    try {
      await renameDataDashboardByPath(parsed.kitablePath, parsed.dashboardId, title)
      await kitableChildrenIndex.refresh()
      setFeedback('Dashboard renamed')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to rename dashboard')
    }
  }, [kitableChildrenIndex, setError, setFeedback])

  const deleteKitableDashboardLeaf = useCallback(async (node: WorkspaceTreeNode) => {
    const parsed = parseKitableDashboardVirtualPath(node.path)
    if (!parsed) return
    const ok = await confirm({
      message: `Delete dashboard "${node.title}"? The source table and its records will not be changed.`,
      variant: 'destructive',
      testId: 'kitable-dashboard-delete-confirm',
    })
    if (!ok) return
    setError('')
    setFeedback('')
    try {
      await deleteDataDashboardByPath(parsed.kitablePath, parsed.dashboardId)
      onDashboardDeleted?.(parsed.kitablePath, parsed.dashboardId)
      if (activeResourcePath === node.path) setActiveResourcePath('')
      await kitableChildrenIndex.refresh()
      setFeedback('Dashboard deleted')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to delete dashboard')
    }
  }, [
    activeResourcePath,
    confirm,
    kitableChildrenIndex,
    onDashboardDeleted,
    setActiveResourcePath,
    setError,
    setFeedback,
  ])

  return { deleteKitableDashboardLeaf, renameKitableDashboardLeaf }
}
