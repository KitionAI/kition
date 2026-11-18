import { useCallback, useState } from 'react'

import type { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'

type TreeActions = ReturnType<typeof useWorkspaceTreeActions>

type UseWorkspaceCreateFlowsOptions = {
  /** Folder the create menu was opened for; new items land there. */
  createMenuFolder: string
  createFolder: TreeActions['createFolder']
}

/** The create entry point that is not a template picker: the new-folder dialog. */
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

  return {
    folderDialogOpen,
    folderName,
    setFolderName,
    openFolderDialog,
    setFolderDialogVisible,
    submitFolderDialog,
  }
}
