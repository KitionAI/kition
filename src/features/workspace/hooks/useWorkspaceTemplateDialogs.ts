import { useCallback, useState } from 'react'

import type { DocumentCreationPreset } from '@/features/document/public'
import type { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'

export type TemplateDialogState = { folderOverride?: string } | null

type TreeActions = ReturnType<typeof useWorkspaceTreeActions>

type UseWorkspaceTemplateDialogsOptions = {
  createDocument: TreeActions['createDocument']
  selectedPlatform: Parameters<TreeActions['createDocument']>[0]
}

/**
 * The "new document" template picker: which folder the result lands in and the create call. A
 * new table starts from the Table kit, which offers its own templates. WorkspaceScreen only
 * renders the dialog.
 */
export function useWorkspaceTemplateDialogs({
  createDocument,
  selectedPlatform,
}: UseWorkspaceTemplateDialogsOptions) {
  const [documentDialog, setDocumentDialog] = useState<TemplateDialogState>(null)
  // Bumped after a blank document is created so the editor takes focus.
  const [documentEditorFocusRequest, setDocumentEditorFocusRequest] = useState(0)

  const openDocumentTemplateDialog = useCallback((folderOverride?: string) => {
    setDocumentDialog({ folderOverride })
  }, [])
  const closeDocumentTemplateDialog = useCallback(() => setDocumentDialog(null), [])

  const createDocumentFromTemplate = useCallback(async (preset?: DocumentCreationPreset) => {
    if (!documentDialog) return false
    const created = await createDocument(selectedPlatform, documentDialog.folderOverride, preset)
    if (created) {
      setDocumentDialog(null)
      if (!preset) setDocumentEditorFocusRequest((current) => current + 1)
    }
    return created
  }, [createDocument, documentDialog, selectedPlatform])

  return {
    documentTemplateDialogState: documentDialog,
    documentEditorFocusRequest,
    openDocumentTemplateDialog,
    closeDocumentTemplateDialog,
    createDocumentFromTemplate,
  }
}
