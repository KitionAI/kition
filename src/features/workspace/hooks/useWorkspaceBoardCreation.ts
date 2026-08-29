import { useCallback, useState } from 'react'

import { createBoardWorkspaceFile } from '@/features/whiteboard/lib/boardFile'
import type { WhiteboardTemplateCreationSelection } from '@/features/whiteboard/lib/whiteboardTemplates'
import { notify } from '@/lib/notify'

type BoardTemplateDialogState = {
  folder?: string
}

export function useWorkspaceBoardCreation({
  closeCreateMenu,
  createFailedMessage,
  expandFolder,
  openBoard,
  refreshWorkspaceDocuments,
  setError,
  setFeedback,
  setSaving,
  successMessage,
}: {
  closeCreateMenu: () => void
  createFailedMessage: string
  expandFolder: (paths: string[]) => void
  openBoard: (path: string) => void
  refreshWorkspaceDocuments: (
    preferredPath?: string,
    options?: { silent?: boolean; treeOnly?: boolean },
  ) => Promise<boolean>
  setError: (message: string) => void
  setFeedback: (message: string) => void
  setSaving: (saving: boolean) => void
  successMessage: string
}) {
  const [dialogState, setDialogState] = useState<BoardTemplateDialogState | null>(null)

  const openTemplateDialog = useCallback((folder?: string) => {
    closeCreateMenu()
    setDialogState({ folder: folder || undefined })
  }, [closeCreateMenu])

  const closeTemplateDialog = useCallback(() => setDialogState(null), [])

  const createBoard = useCallback(async (
    selection?: WhiteboardTemplateCreationSelection,
  ) => {
    if (!dialogState) return false
    setSaving(true)
    setError('')
    setFeedback('')

    try {
      const created = await createBoardWorkspaceFile({
        folder: dialogState.folder,
        template: selection?.template,
        title: selection?.title,
      })
      if (dialogState.folder) expandFolder([dialogState.folder])
      await refreshWorkspaceDocuments(undefined, { silent: true, treeOnly: true })
      openBoard(created.path)
      setDialogState(null)
      notify.success(successMessage)
      return true
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : createFailedMessage)
      return false
    } finally {
      setSaving(false)
    }
  }, [
    createFailedMessage,
    dialogState,
    expandFolder,
    openBoard,
    refreshWorkspaceDocuments,
    setError,
    setFeedback,
    setSaving,
    successMessage,
  ])

  return {
    closeTemplateDialog,
    createBoard,
    dialogState,
    openTemplateDialog,
  }
}
