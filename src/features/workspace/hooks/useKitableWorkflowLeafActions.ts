import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { deleteWorkflow, patchWorkflow } from '@/features/workflow/api'
import { useConfirm } from '@/components/confirm'
import type { KitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import { parseKitableWorkflowVirtualPath } from '@/features/workspace/lib/workspaceTree'

type UseKitableWorkflowLeafActionsOptions = {
  kitableChildrenIndex: KitableChildrenIndex
  activeResourcePath: string
  setActiveResourcePath: (path: string) => void
  onWorkflowDeleted?: (kitablePath: string, workflowId: string) => void
  setError: (message: string) => void
  setFeedback: (message: string) => void
}

/**
 * Group A handlers for the virtual `workflow://` leaves rendered under each
 * `.kitable` row. Mirrors `useKitableTableLeafActions` — the leaves are not
 * real files, so the generic workspace tree delete/rename short-circuits on
 * `node.virtual`. We route through the workflow API instead, then close any
 * matching workflow tabs and clear the sidebar highlight.
 *
 * `deleteWorkflow()` / `patchWorkflow()` already dispatch
 * `WORKFLOW_CHANGED_EVENT`, which WorkspaceScreen subscribes to in order to
 * refresh the kitable children index — so the renamed/deleted leaf updates
 * in the tree without an explicit refresh() call here.
 */
export function useKitableWorkflowLeafActions({
  kitableChildrenIndex,
  activeResourcePath,
  setActiveResourcePath,
  onWorkflowDeleted,
  setError,
  setFeedback,
}: UseKitableWorkflowLeafActionsOptions) {
  const confirm = useConfirm()
  const { t } = useTranslation('workflow')

  const renameKitableWorkflowLeaf = useCallback(async (node: WorkspaceTreeNode, nextTitle: string) => {
    const trimmed = String(nextTitle || '').trim()
    if (!trimmed || trimmed === node.title) {
      return
    }
    const parsed = parseKitableWorkflowVirtualPath(node.path)
    if (!parsed) return

    setError('')
    setFeedback('')
    try {
      await patchWorkflow(parsed.workflowId, { name: trimmed })
      setFeedback(t('feedback.renamed'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.renameWorkflow'))
    }
  }, [setError, setFeedback, t])

  const deleteKitableWorkflowLeaf = useCallback(async (node: WorkspaceTreeNode) => {
    const parsed = parseKitableWorkflowVirtualPath(node.path)
    if (!parsed) return

    // Display name from the lookup if we have it; fall back to the row title.
    // Used purely for the confirm copy.
    const summary = (kitableChildrenIndex.workflowsByKitablePath[parsed.kitablePath] || [])
      .find((a) => a.id === parsed.workflowId)
    const displayName = summary?.name || node.title || t('kitableLeaf.nameFallback')

    const ok = await confirm({
      message: t('kitableLeaf.deleteConfirm', { name: displayName }),
      variant: 'destructive',
      // Surfaced for the e2e regression — lets the test target the
      // confirm/cancel buttons without matching by visible text.
      testId: 'kitable-workflow-delete-confirm',
    })
    if (!ok) return

    setError('')
    setFeedback('')
    try {
      await deleteWorkflow(parsed.workflowId)
      onWorkflowDeleted?.(parsed.kitablePath, parsed.workflowId)
      if (activeResourcePath === node.path) {
        setActiveResourcePath('')
      }
      // The kitable children index refreshes via the WORKFLOW_CHANGED_EVENT
      // emitted by deleteWorkflow(), so no explicit refresh() here.
      setFeedback(t('feedback.workflowDeleted'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.deleteWorkflow'))
    }
  }, [
    activeResourcePath,
    confirm,
    kitableChildrenIndex,
    onWorkflowDeleted,
    setActiveResourcePath,
    setError,
    setFeedback,
    t,
  ])

  return { renameKitableWorkflowLeaf, deleteKitableWorkflowLeaf }
}
