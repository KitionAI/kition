import { useCallback, useState } from 'react'

import type { DocumentCreationPreset } from '@/features/workspace/templates/documentCreation'
import type { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'

export type TemplateDialogState = { folderOverride?: string } | null

type TreeActions = ReturnType<typeof useWorkspaceTreeActions>

type UseWorkspaceTemplateDialogsOptions = {
  createDocument: TreeActions['createDocument']
}

/**
 * The "new note" template picker: which folder the result lands in and the create call. A
 * new table starts from the Table kit, which offers its own templates. WorkspaceScreen only
 * renders the dialog.
 */
export function useWorkspaceTemplateDialogs({ createDocument }: UseWorkspaceTemplateDialogsOptions) {
  const [documentDialog, setDocumentDialog] = useState<TemplateDialogState>(null)

  const openDocumentTemplateDialog = useCallback((folderOverride?: string) => {
    setDocumentDialog({ folderOverride })
  }, [])
  const closeDocumentTemplateDialog = useCallback(() => setDocumentDialog(null), [])

  const createDocumentFromTemplate = useCallback(async (preset?: DocumentCreationPreset) => {
    if (!documentDialog) return false
    const created = await createDocument(documentDialog.folderOverride, preset)
    if (created) setDocumentDialog(null)
    return created
  }, [createDocument, documentDialog])

  return {
    documentTemplateDialogState: documentDialog,
    openDocumentTemplateDialog,
    closeDocumentTemplateDialog,
    createDocumentFromTemplate,
  }
}
