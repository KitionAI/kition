import { lazy, Suspense } from 'react'

import type { useDocumentExport } from '@/features/document/public'
import type { useWorkspaceBoardCreation } from '@/features/workspace/hooks/useWorkspaceBoardCreation'
import type { useWorkspaceCreateFlows } from '@/features/workspace/hooks/useWorkspaceCreateFlows'
import type { useWorkspaceTemplateDialogs } from '@/features/workspace/hooks/useWorkspaceTemplateDialogs'

// Each dialog stays its own lazy chunk: none of them is needed until opened.
const DocumentExportDialog = lazy(() =>
  import('@/features/document/components/DocumentExportDialog').then((module) => ({ default: module.DocumentExportDialog })),
)
const DocumentTemplateLibraryDialog = lazy(() =>
  import('@/features/document/components/DocumentTemplateLibraryDialog').then((module) => ({ default: module.DocumentTemplateLibraryDialog })),
)
const WhiteboardTemplateLibraryDialog = lazy(() =>
  import('@/features/whiteboard/components/WhiteboardTemplateLibraryDialog').then((module) => ({ default: module.WhiteboardTemplateLibraryDialog })),
)
const WorkspaceFolderCreateDialog = lazy(() =>
  import('@/features/workspace/components/WorkspaceFolderCreateDialog').then((module) => ({ default: module.WorkspaceFolderCreateDialog })),
)
const FormSyncCreateDialog = lazy(() =>
  import('@/features/formSync/FormSyncCreateDialog').then((module) => ({ default: module.FormSyncCreateDialog })),
)

export type WorkspaceDialogsProps = {
  /** A workspace write is in flight; dialogs show their busy state. */
  saving: boolean
  documentExport: ReturnType<typeof useDocumentExport>
  createFlows: ReturnType<typeof useWorkspaceCreateFlows>
  templateDialogs: ReturnType<typeof useWorkspaceTemplateDialogs>
  boardCreation: ReturnType<typeof useWorkspaceBoardCreation>
}

/**
 * Every modal the workspace can open, rendered from the hook results that
 * own their state. WorkspaceScreen mounts this once; the dialogs themselves
 * load lazily when first opened.
 */
export function WorkspaceDialogs({
  saving,
  documentExport,
  createFlows,
  templateDialogs,
  boardCreation,
}: WorkspaceDialogsProps) {
  return (
    <>
      {documentExport.exportDialogOpen ? (
        <Suspense fallback={null}>
          <DocumentExportDialog
            open
            exporting={documentExport.exporting}
            exportFormat={documentExport.exportFormat}
            exportIncludeMedia={documentExport.exportIncludeMedia}
            exportPageFormat={documentExport.exportPageFormat}
            exportScale={documentExport.exportScale}
            pdfIncludeName={documentExport.pdfIncludeName}
            pdfLandscape={documentExport.pdfLandscape}
            pdfMarginsType={documentExport.pdfMarginsType}
            onClose={() => documentExport.setExportDialogOpen(false)}
            onExportFormatChange={documentExport.setExportFormat}
            onIncludeMediaChange={documentExport.setExportIncludeMedia}
            onPageFormatChange={documentExport.setExportPageFormat}
            onScaleChange={documentExport.setExportScale}
            onPdfIncludeNameChange={documentExport.setPdfIncludeName}
            onPdfLandscapeChange={documentExport.setPdfLandscape}
            onPdfMarginsTypeChange={documentExport.setPdfMarginsType}
            onExport={() => void documentExport.exportCurrentDocument()}
          />
        </Suspense>
      ) : null}
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
      {boardCreation.dialogState ? (
        <Suspense fallback={null}>
          <WhiteboardTemplateLibraryDialog
            open
            busy={saving}
            onOpenChange={(open) => {
              if (!open) boardCreation.closeTemplateDialog()
            }}
            onSelect={boardCreation.createBoard}
          />
        </Suspense>
      ) : null}
      {createFlows.formSyncCreateState ? (
        <Suspense fallback={null}>
          <FormSyncCreateDialog
            open
            documentPath={createFlows.formSyncCreateState.documentPath}
            onOpenChange={(open) => {
              if (!open) createFlows.closeFormSyncCreate()
            }}
            onCreated={createFlows.handleFormSyncCreated}
          />
        </Suspense>
      ) : null}
    </>
  )
}
