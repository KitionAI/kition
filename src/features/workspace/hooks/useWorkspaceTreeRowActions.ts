import { useCallback } from 'react'

import type { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'

type TreeActions = ReturnType<typeof useWorkspaceTreeActions>

type UseWorkspaceTreeRowActionsOptions = {
  deleteDocumentNode: TreeActions['deleteDocumentNode']
  renameWorkspaceNode: TreeActions['renameWorkspaceNode']
}

/** Rename and delete for tree rows, through the workspace tree actions. */
export function useWorkspaceTreeRowActions({
  deleteDocumentNode,
  renameWorkspaceNode,
}: UseWorkspaceTreeRowActionsOptions) {
  const handleTreeNodeDelete = useCallback((node: WorkspaceTreeNode) => {
    void deleteDocumentNode(node)
  }, [deleteDocumentNode])

  const handleTreeNodeRename = useCallback((node: WorkspaceTreeNode, nextTitle: string) => {
    void renameWorkspaceNode(node, nextTitle)
  }, [renameWorkspaceNode])

  return { handleTreeNodeDelete, handleTreeNodeRename }
}
