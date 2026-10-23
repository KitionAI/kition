import { useCallback, useState } from 'react'

import type { FormSyncWorkflow } from '@/api/formSync'
import type { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'

type TreeActions = ReturnType<typeof useWorkspaceTreeActions>

export type FormSyncCreateState = {
  /** The table file the form writes to. */
  documentPath: string
}

type UseWorkspaceCreateFlowsOptions = {
  /** Folder the create menu was opened for; new items land there. */
  createMenuFolder: string
  createFolder: TreeActions['createFolder']
  /** Opens the workflows of a table file, showing the one just made. */
  openTableFileWorkflow: (tablePath: string, workflowId?: string) => void
}

/**
 * The create entry points that are not template pickers: the new-folder dialog, the create menu
 * opened on a table file (a form or a workflow for its tables), and the form dialog.
 */
export function useWorkspaceCreateFlows({
  createMenuFolder,
  createFolder,
  openTableFileWorkflow,
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

  const [formSyncCreateState, setFormSyncCreateState] = useState<FormSyncCreateState | null>(null)
  const openFormSyncCreate = useCallback((documentPath: string) => {
    setTableFileCreateContext(null)
    setFormSyncCreateState({ documentPath })
  }, [])
  const closeFormSyncCreate = useCallback(() => setFormSyncCreateState(null), [])
  const handleFormSyncCreated = useCallback((workflow: FormSyncWorkflow) => {
    const state = formSyncCreateState
    if (!state) return
    openTableFileWorkflow(state.documentPath, workflow.id)
    setFormSyncCreateState(null)
  }, [formSyncCreateState, openTableFileWorkflow])

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
    formSyncCreateState,
    openFormSyncCreate,
    closeFormSyncCreate,
    handleFormSyncCreated,
  }
}
