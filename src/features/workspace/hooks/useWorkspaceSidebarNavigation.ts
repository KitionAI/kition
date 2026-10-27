import { useCallback } from 'react'
import { revealInKit } from '@/features/kits/public'
import { parseTableFileChildPath } from '@/features/workspace/lib/tableFileChildren'

const WORKFLOWS_LEAF_PREFIX = 'workflows://'

type UseWorkspaceSidebarNavigationOptions = {
  workflowOpen: boolean
  onCloseWorkflow?: () => void
  onCloseProfile?: () => void
  /** The workflow list: the whole workspace's, or one table file's (`tablePath`). */
  openWorkflows: (tablePath?: string) => void
  openDocument: (path: string) => Promise<void>
}

/**
 * Routes a click on a sidebar row to the right tab. Real files open by format (a table file
 * opens in the Table kit, like every kit file); the Workflows row carries a sentinel path, and a
 * table file's table or dashboard opens the file in the kit there.
 */
export function useWorkspaceSidebarNavigation({
  workflowOpen,
  onCloseWorkflow,
  onCloseProfile,
  openWorkflows,
  openDocument,
}: UseWorkspaceSidebarNavigationOptions) {
  const openSidebarPath = useCallback((path: string) => {
    onCloseProfile?.()
    // The full-screen workflow route masks the editor pane: a click into a
    // non-workflow row would only flip the active tab and show no change,
    // so close the route for anything that is not itself a workflow row.
    const opensWorkflowTab = path.startsWith(WORKFLOWS_LEAF_PREFIX)
    if (workflowOpen && !opensWorkflowTab) onCloseWorkflow?.()

    if (path.startsWith(WORKFLOWS_LEAF_PREFIX)) {
      openWorkflows(path.slice(WORKFLOWS_LEAF_PREFIX.length) || undefined)
      return
    }
    const tableFileChild = parseTableFileChildPath(path)
    if (tableFileChild) {
      revealInKit(tableFileChild.filePath, tableFileChild.view)
      void openDocument(tableFileChild.filePath)
      return
    }
    void openDocument(path)
  }, [onCloseProfile, onCloseWorkflow, openDocument, openWorkflows, workflowOpen])

  return { openSidebarPath }
}
