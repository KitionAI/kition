import { useCallback, useState } from 'react'

import type { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'

type TreeActions = ReturnType<typeof useWorkspaceTreeActions>

type UseWorkspaceCreateFlowsOptions = {
  /** Folder the create menu was opened for; new items land there. */
  createMenuFolder: string
  createFolder: TreeActions['createFolder']
}

/**
 * The create entry points that are not template pickers: the new-folder dialog and the create
 * menu opened on a table file (a workflow for its tables).
 */
export function useWorkspaceCreateFlows({
  createMenuFolder,
  createFolder,
}: UseWorkspaceCreateFlowsOptions) {
  // New folder dialog.
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const openFolderDialog = useCallback(() => {
    setFolderName('')
    setFolderDialogOpen(true)
  }, [])
  const setFolderDialogVisible = useCallback((open: boolean) => {
    setFolderDialogOpen(open)
    if (!open) setFolderName('')
  }, [])
  const submitFolderDialog = useCallback(async () => {
    const created = await createFolder(createMenuFolder, folderName)
    if (!created) return
    setFolderDialogOpen(false)
    setFolderName('')
  }, [createFolder, createMenuFolder, folderName])

  // The create menu opened on a table file.
  const [tableFileCreateContext, setTableFileCreateContext] = useState<string | null>(null)
  const createMenuVariant: 'workspace' | 'tableFile' = tableFileCreateContext ? 'tableFile' : 'workspace'

  return {
    folderDialogOpen,
    folderName,
    setFolderName,
    openFolderDialog,
    setFolderDialogVisible,
    submitFolderDialog,
    tableFileCreateContext,
    setTableFileCreateContext,
    createMenuVariant,
  }
}
