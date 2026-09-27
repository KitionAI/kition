import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import type { KitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import {
  buildKitableWorkspaceTabId,
  getKitableWorkspaceTabTitle,
  getWorkspaceItemTitle,
} from '@/features/workspace/lib/workspace'

type UseWorkspaceKitableOpenersOptions = {
  activeWorkspaceTab: WorkspaceTab | undefined
  kitableChildrenIndex: Pick<KitableChildrenIndex, 'tablesByKitablePath' | 'status' | 'refresh'>
  upsertWorkspaceTab: (tab: WorkspaceTab) => void
  setActiveResourcePath: (path: string) => void
  /** The workflow workbench is open over the editor; opening a tab closes it first. */
  workflowOpen: boolean
  onCloseWorkflow?: () => void
}

/**
 * Opens the tab for a .kitable view (table, dashboard, workflow), the global
 * workflow list, or a board. Opening a kitable container picks the current
 * or first table and falls back to the workflow view; when the children index
 * has not listed the file yet, the open is deferred until it has.
 */
export function useWorkspaceKitableOpeners({
  activeWorkspaceTab,
  kitableChildrenIndex,
  upsertWorkspaceTab,
  setActiveResourcePath,
  workflowOpen,
  onCloseWorkflow,
}: UseWorkspaceKitableOpenersOptions) {
  const { t } = useTranslation('workspace')

  const closeWorkflowWorkbench = useCallback(() => {
    if (workflowOpen) onCloseWorkflow?.()
  }, [onCloseWorkflow, workflowOpen])

  const openKitableTable = useCallback((kitablePath: string, tableId: number) => {
    closeWorkflowWorkbench()
    upsertWorkspaceTab({
      id: buildKitableWorkspaceTabId(kitablePath),
      type: 'table',
      title: getKitableWorkspaceTabTitle(kitablePath),
      kitablePath,
      tableId,
      format: 'data',
    })
    setActiveResourcePath(kitablePath)
  }, [closeWorkflowWorkbench, setActiveResourcePath, upsertWorkspaceTab])

  const openKitableDashboard = useCallback((kitablePath: string, dashboardId: string) => {
    closeWorkflowWorkbench()
    upsertWorkspaceTab({
      id: buildKitableWorkspaceTabId(kitablePath),
      type: 'dashboard',
      title: getKitableWorkspaceTabTitle(kitablePath),
      kitablePath,
      dashboardId,
      format: 'data',
    })
    setActiveResourcePath(kitablePath)
  }, [closeWorkflowWorkbench, setActiveResourcePath, upsertWorkspaceTab])

  const openKitableWorkflow = useCallback((kitablePath: string, workflowId?: string) => {
    upsertWorkspaceTab({
      id: buildKitableWorkspaceTabId(kitablePath),
      type: 'workflow',
      title: getKitableWorkspaceTabTitle(kitablePath),
      kitablePath,
      workflowId,
    })
    setActiveResourcePath(kitablePath)
  }, [setActiveResourcePath, upsertWorkspaceTab])

  const openWorkspaceWorkflow = useCallback((workflowId?: string) => {
    closeWorkflowWorkbench()
    upsertWorkspaceTab({
      id: 'workflow:home',
      type: 'workflow',
      title: t('tabs.workflowsTitle'),
      workflowId,
    })
  }, [closeWorkflowWorkbench, t, upsertWorkspaceTab])

  const openBoard = useCallback((path: string) => {
    const normalizedPath = String(path || '').trim()
    if (!normalizedPath) return
    closeWorkflowWorkbench()
    const filename = normalizedPath.split('/').pop() || normalizedPath
    upsertWorkspaceTab({
      id: `board:${normalizedPath}`,
      type: 'board',
      title: getWorkspaceItemTitle(filename),
      path: normalizedPath,
    })
    setActiveResourcePath(normalizedPath)
  }, [closeWorkflowWorkbench, setActiveResourcePath, upsertWorkspaceTab])

  // Onboarding guides ask to open a workflow under a kitable they just created.
  useEffect(() => {
    function openLocalWorkflow(event: Event) {
      const kitablePath = String((event as CustomEvent<{ kitablePath?: string }>).detail?.kitablePath || '').trim()
      if (kitablePath) openKitableWorkflow(kitablePath)
    }
    window.addEventListener('kition:onboarding:open-local-workflow', openLocalWorkflow)
    return () => window.removeEventListener('kition:onboarding:open-local-workflow', openLocalWorkflow)
  }, [openKitableWorkflow])

  // A container open that arrives before the index lists the file waits for
  // the next completed refresh; one refresh is requested per path.
  const pendingKitableOpenPathRef = useRef('')
  const refreshedKitableOpenPathRef = useRef('')
  const { tablesByKitablePath, status, refresh } = kitableChildrenIndex
  const openKitableContainer = useCallback((kitablePath: string) => {
    const tables = [...(tablesByKitablePath[kitablePath] || [])].sort((left, right) => left.order - right.order)
    if (tables.length === 0) {
      const waitingForCurrentRefresh = status === 'idle' || status === 'loading'
      const needsFreshLookup = status === 'done' && refreshedKitableOpenPathRef.current !== kitablePath
      if (waitingForCurrentRefresh || needsFreshLookup) {
        pendingKitableOpenPathRef.current = kitablePath
        setActiveResourcePath(kitablePath)
        if (needsFreshLookup) {
          refreshedKitableOpenPathRef.current = kitablePath
          void refresh()
        }
        return
      }
    }
    pendingKitableOpenPathRef.current = ''
    refreshedKitableOpenPathRef.current = ''
    const currentTableId = activeWorkspaceTab?.type === 'table' && activeWorkspaceTab.kitablePath === kitablePath
      ? activeWorkspaceTab.tableId
      : undefined
    const targetTableId = currentTableId ?? tables[0]?.id
    if (targetTableId != null) {
      openKitableTable(kitablePath, targetTableId)
      return
    }
    openKitableWorkflow(kitablePath)
  }, [activeWorkspaceTab, refresh, status, tablesByKitablePath, openKitableTable, openKitableWorkflow, setActiveResourcePath])

  useEffect(() => {
    if (status !== 'done') return
    const pendingPath = pendingKitableOpenPathRef.current
    if (!pendingPath) return
    openKitableContainer(pendingPath)
  }, [status, openKitableContainer])

  return {
    openKitableTable,
    openKitableDashboard,
    openKitableWorkflow,
    openWorkspaceWorkflow,
    openBoard,
    openKitableContainer,
  }
}
