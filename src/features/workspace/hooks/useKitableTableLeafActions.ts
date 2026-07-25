import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { deleteDataTable, updateDataTable } from '@/api/dataDocuments'
import { useConfirm } from '@/components/confirm'
import type { KitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import { parseKitableTableVirtualPath } from '@/features/workspace/lib/workspaceTree'

type UseKitableTableLeafActionsOptions = {
  kitableChildrenIndex: KitableChildrenIndex
  activeResourcePath: string
  setActiveResourcePath: (path: string) => void
  onTableDeleted?: (kitablePath: string, tableId: number) => void
  setError: (message: string) => void
  setFeedback: (message: string) => void
}

/**
 * Group A handlers for the virtual `table://` leaves rendered under each
 * `.kitable` row. These leaves are not real files, so we cannot reuse
 * `useWorkspaceTreeNodeActions.deleteDocumentNode` / `renameWorkspaceNode`
 * (both early-return on `node.virtual`). Instead we route through the
 * data-document API and patch the workspace tab bookkeeping locally.
 */
export function useKitableTableLeafActions({
  kitableChildrenIndex,
  activeResourcePath,
  setActiveResourcePath,
  onTableDeleted,
  setError,
  setFeedback,
}: UseKitableTableLeafActionsOptions) {
  const confirm = useConfirm()
  const { t } = useTranslation('workspace')

  const renameKitableTableLeaf = useCallback(async (node: WorkspaceTreeNode, nextTitle: string) => {
    const trimmed = String(nextTitle || '').trim()
    if (!trimmed || trimmed === node.title) {
      return
    }
    const parsed = parseKitableTableVirtualPath(node.path)
    if (!parsed) return
    const docId = kitableChildrenIndex.docIdByKitablePath[parsed.kitablePath]
    if (!docId) {
      setError(t('errors.parentKitableNotFound'))
      return
    }

    setError('')
    setFeedback('')
    try {
      const updated = await updateDataTable(Number(docId), parsed.tableId, { title: trimmed })
      window.dispatchEvent(new CustomEvent('kition:data-document:table:rename', {
        detail: { vaultPath: parsed.kitablePath, tableId: parsed.tableId, newName: updated.title },
      }))
      await kitableChildrenIndex.refresh()
      setFeedback(t('feedback.renamed'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename table')
    }
  }, [kitableChildrenIndex, setError, setFeedback, t])

  const deleteKitableTableLeaf = useCallback(async (node: WorkspaceTreeNode) => {
    const parsed = parseKitableTableVirtualPath(node.path)
    if (!parsed) return
    const docId = kitableChildrenIndex.docIdByKitablePath[parsed.kitablePath]
    if (!docId) {
      setError(t('errors.parentKitableNotFound'))
      return
    }

    const ok = await confirm({
      message: `Delete table "${node.title}"? This permanently removes the table and all of its records.`,
      variant: 'destructive',
      // Surfaced for the e2e regression in kitable-table-leaf-actions.spec.ts
      // — the dialog testid lets the test target the confirm/cancel buttons
      // without matching by visible text.
      testId: 'kitable-table-delete-confirm',
    })
    if (!ok) return

    setError('')
    setFeedback('')
    try {
      await deleteDataTable(Number(docId), parsed.tableId)
      window.dispatchEvent(new CustomEvent('kition:data-document:table:delete', {
        detail: { vaultPath: parsed.kitablePath, tableId: parsed.tableId },
      }))
      onTableDeleted?.(parsed.kitablePath, parsed.tableId)
      if (activeResourcePath === node.path) {
        setActiveResourcePath('')
      }
      await kitableChildrenIndex.refresh()
      setFeedback(t('feedback.tableDeleted'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete table')
    }
  }, [
    activeResourcePath,
    confirm,
    kitableChildrenIndex,
    onTableDeleted,
    setActiveResourcePath,
    setError,
    setFeedback,
    t,
  ])

  return { renameKitableTableLeaf, deleteKitableTableLeaf }
}
