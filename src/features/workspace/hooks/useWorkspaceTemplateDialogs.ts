import { useCallback, useState } from 'react'

import type { DocumentCreationPreset } from '@/features/document/public'
import { requestEmailSyncSetup } from '@/features/emailSync/public'
import { setupTemplateFormSync } from '@/features/formSync/public'
import type { KitableTemplateDefinition } from '@/features/table/public'
import type { KitableChildrenIndex } from '@/features/workspace/hooks/useKitableChildrenIndex'
import type { useWorkspaceTreeActions } from '@/features/workspace/hooks/useWorkspaceTreeActions'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { buildKitableWorkspaceTabId, getKitableWorkspaceTabTitle } from '@/features/workspace/lib/workspace'
import type { WorkspaceTreeMetadata } from '@/features/workspace/lib/workspacePersistence'
import { buildKitableTableVirtualPath } from '@/features/workspace/lib/workspaceTree'

export type TemplateDialogState = { folderOverride?: string } | null

type TreeActions = ReturnType<typeof useWorkspaceTreeActions>

type UseWorkspaceTemplateDialogsOptions = {
  createDocument: TreeActions['createDocument']
  createTable: TreeActions['createTable']
  selectedPlatform: Parameters<TreeActions['createDocument']>[0]
  kitableChildrenIndex: Pick<KitableChildrenIndex, 'refresh'>
  upsertWorkspaceTab: (tab: WorkspaceTab) => void
  setActiveResourcePath: (path: string) => void
  updateTreeMetadata: (updater: (metadata: WorkspaceTreeMetadata) => WorkspaceTreeMetadata) => void
  setError: (message: string) => void
  setFeedback: (message: string) => void
}

/**
 * The "new document" and "new table" template pickers: which folder the
 * result lands in, the create calls, and what happens after a template is
 * chosen (open the table tab, run a template's follow-up such as email or
 * form sync setup). WorkspaceScreen only renders the dialogs.
 */
export function useWorkspaceTemplateDialogs({
  createDocument,
  createTable,
  selectedPlatform,
  kitableChildrenIndex,
  upsertWorkspaceTab,
  setActiveResourcePath,
  updateTreeMetadata,
  setError,
  setFeedback,
}: UseWorkspaceTemplateDialogsOptions) {
  const [documentDialog, setDocumentDialog] = useState<TemplateDialogState>(null)
  const [kitableDialog, setKitableDialog] = useState<TemplateDialogState>(null)
  // Bumped after a blank document is created so the editor takes focus.
  const [documentEditorFocusRequest, setDocumentEditorFocusRequest] = useState(0)

  const openDocumentTemplateDialog = useCallback((folderOverride?: string) => {
    setDocumentDialog({ folderOverride })
  }, [])
  const closeDocumentTemplateDialog = useCallback(() => setDocumentDialog(null), [])
  const openKitableTemplateDialog = useCallback((folderOverride?: string) => {
    setKitableDialog({ folderOverride })
  }, [])
  const closeKitableTemplateDialog = useCallback(() => setKitableDialog(null), [])

  const createDocumentFromTemplate = useCallback(async (preset?: DocumentCreationPreset) => {
    if (!documentDialog) return false
    const created = await createDocument(selectedPlatform, documentDialog.folderOverride, preset)
    if (created) {
      setDocumentDialog(null)
      if (!preset) setDocumentEditorFocusRequest((current) => current + 1)
    }
    return created
  }, [createDocument, documentDialog, selectedPlatform])

  const createKitableFromTemplate = useCallback(async (template?: KitableTemplateDefinition) => {
    if (!kitableDialog) return false
    const result = await createTable(kitableDialog.folderOverride, template)
    if (!result) return false
    if (result.tableId != null) {
      const kitablePath = result.kitablePath
      updateTreeMetadata((current) => (
        current.collapsed.includes(kitablePath)
          ? current
          : { ...current, collapsed: [...current.collapsed, kitablePath] }
      ))
      upsertWorkspaceTab({
        id: buildKitableWorkspaceTabId(kitablePath),
        type: 'table',
        title: getKitableWorkspaceTabTitle(kitablePath),
        kitablePath,
        tableId: result.tableId,
        format: 'data',
      })
      setActiveResourcePath(buildKitableTableVirtualPath(kitablePath, result.tableId))
    }
    setKitableDialog(null)
    void kitableChildrenIndex.refresh()
    if (template?.afterCreate?.type === 'email-sync') {
      requestEmailSyncSetup(result.kitablePath, { runAfterSave: template.afterCreate.runAfterSave })
    }
    if (template?.afterCreate?.type === 'form-sync') {
      try {
        const workflow = await setupTemplateFormSync({
          documentId: result.documentId,
          tableIdsByTitle: result.tableIdsByTitle,
          setup: template.afterCreate,
        })
        setFeedback(workflow.published
          ? `Private event form connected: ${workflow.public_url}`
          : 'Private event form draft created')
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : 'Failed to connect the private event form')
      }
    }
    return true
  }, [
    createTable,
    kitableChildrenIndex,
    kitableDialog,
    setActiveResourcePath,
    setError,
    setFeedback,
    updateTreeMetadata,
    upsertWorkspaceTab,
  ])

  return {
    documentTemplateDialogState: documentDialog,
    kitableTemplateDialogState: kitableDialog,
    documentEditorFocusRequest,
    openDocumentTemplateDialog,
    closeDocumentTemplateDialog,
    openKitableTemplateDialog,
    closeKitableTemplateDialog,
    createDocumentFromTemplate,
    createKitableFromTemplate,
  }
}
