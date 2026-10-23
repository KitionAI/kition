import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { getWorkspaceItemTitle } from '@/features/workspace/lib/workspace'

type UseWorkspaceOpenersOptions = {
  upsertWorkspaceTab: (tab: WorkspaceTab) => void
  setActiveResourcePath: (path: string) => void
  /** The workflow workbench is open over the editor; opening a tab closes it first. */
  workflowOpen: boolean
  onCloseWorkflow?: () => void
}

/**
 * Opens the workflow list (for the whole workspace, or for one table file's tables) and boards.
 * A table file itself opens in the Table kit like any kit file.
 */
export function useWorkspaceOpeners({
  upsertWorkspaceTab,
  setActiveResourcePath,
  workflowOpen,
  onCloseWorkflow,
}: UseWorkspaceOpenersOptions) {
  const { t } = useTranslation('workspace')

  const closeWorkflowWorkbench = useCallback(() => {
    if (workflowOpen) onCloseWorkflow?.()
  }, [onCloseWorkflow, workflowOpen])

  /** The workflows of one table file (`tablePath`), as a tab of their own. */
  const openTableFileWorkflow = useCallback((tablePath: string, workflowId?: string) => {
    closeWorkflowWorkbench()
    upsertWorkspaceTab({
      id: `workflow:${tablePath}`,
      type: 'workflow',
      title: t('tabs.workflowsTitle'),
      tablePath: tablePath,
      workflowId,
    })
  }, [closeWorkflowWorkbench, t, upsertWorkspaceTab])

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

  // Onboarding guides and email sync setup ask to open the workflows of a table file.
  useEffect(() => {
    function openLocalWorkflow(event: Event) {
      const tablePath = String((event as CustomEvent<{ tablePath?: string }>).detail?.tablePath || '').trim()
      if (tablePath) openTableFileWorkflow(tablePath)
    }
    window.addEventListener('kition:onboarding:open-local-workflow', openLocalWorkflow)
    return () => window.removeEventListener('kition:onboarding:open-local-workflow', openLocalWorkflow)
  }, [openTableFileWorkflow])

  return { openTableFileWorkflow, openWorkspaceWorkflow, openBoard }
}
