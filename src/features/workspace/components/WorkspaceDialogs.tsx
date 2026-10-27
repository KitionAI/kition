import { lazy, Suspense } from 'react'

import type { useWorkspaceCreateFlows } from '@/features/workspace/hooks/useWorkspaceCreateFlows'
import type { useWorkspaceTemplateDialogs } from '@/features/workspace/hooks/useWorkspaceTemplateDialogs'

// Each dialog stays its own lazy chunk: none of them is needed until opened.
const DocumentTemplateLibraryDialog = lazy(() =>
  import('@/features/workspace/templates/DocumentTemplateLibraryDialog').then((module) => ({ default: module.DocumentTemplateLibraryDialog })),
)
const WorkspaceFolderCreateDialog = lazy(() =>
  import('@/features/workspace/components/WorkspaceFolderCreateDialog').then((module) => ({ default: module.WorkspaceFolderCreateDialog })),
)

export type WorkspaceDialogsProps = {
  /** A workspace write is in flight; dialogs show their busy state. */
  saving: boolean
  createFlows: ReturnType<typeof useWorkspaceCreateFlows>
  templateDialogs: ReturnType<typeof useWorkspaceTemplateDialogs>
}

/**
 * Every modal the workspace can open, rendered from the hook results that
 * own their state. WorkspaceScreen mounts this once; the dialogs themselves
 * load lazily when first opened.
 */
export function WorkspaceDialogs({
  saving,
  createFlows,
  templateDialogs,
}: WorkspaceDialogsProps) {
  return (
    <>
      {createFlows.folderDialogOpen ? (
        <Suspense fallback={null}>
          <WorkspaceFolderCreateDialog
            open
            value={createFlows.folderName}
            busy={saving}
            onOpenChange={createFlows.setFolderDialogVisible}
            onValueChange={createFlows.setFolderName}
            onSubmit={() => void createFlows.submitFolderDialog()}
          />
        </Suspense>
      ) : null}
      {templateDialogs.documentTemplateDialogState ? (
        <Suspense fallback={null}>
          <DocumentTemplateLibraryDialog
            open
            busy={saving}
            onOpenChange={(open) => {
              if (!open) templateDialogs.closeDocumentTemplateDialog()
            }}
            onCreate={templateDialogs.createDocumentFromTemplate}
          />
        </Suspense>
      ) : null}
    </>
  )
}
