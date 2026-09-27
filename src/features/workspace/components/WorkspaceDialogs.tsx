import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'

import type { useDocumentExport } from '@/features/document/public'
import { requestEmailSyncSetup } from '@/features/emailSync/public'
import type { useWorkspaceBoardCreation } from '@/features/workspace/hooks/useWorkspaceBoardCreation'
import type { useWorkspaceCreateFlows } from '@/features/workspace/hooks/useWorkspaceCreateFlows'
import type { useWorkspaceTemplateDialogs } from '@/features/workspace/hooks/useWorkspaceTemplateDialogs'
import type { useWorkspaceWorkflowCreateMode } from '@/features/workspace/hooks/useWorkspaceWorkflowCreateMode'
import { notify } from '@/lib/notify'

// Each dialog stays its own lazy chunk: none of them is needed until opened.
const DocumentExportDialog = lazy(() =>
  import('@/features/document/components/DocumentExportDialog').then((module) => ({ default: module.DocumentExportDialog })),
)
const DocumentTemplateLibraryDialog = lazy(() =>
  import('@/features/document/components/DocumentTemplateLibraryDialog').then((module) => ({ default: module.DocumentTemplateLibraryDialog })),
)
const KitableTemplateLibraryDialog = lazy(() =>
  import('@/features/table/components/KitableTemplateLibraryDialog').then((module) => ({ default: module.KitableTemplateLibraryDialog })),
)
const WhiteboardTemplateLibraryDialog = lazy(() =>
  import('@/features/whiteboard/components/WhiteboardTemplateLibraryDialog').then((module) => ({ default: module.WhiteboardTemplateLibraryDialog })),
)
const TableFileImportDialog = lazy(() =>
  import('@/features/table/components/TableFileImportDialog').then((module) => ({ default: module.TableFileImportDialog })),
)
const WorkspaceFolderCreateDialog = lazy(() =>
  import('@/features/workspace/components/WorkspaceFolderCreateDialog').then((module) => ({ default: module.WorkspaceFolderCreateDialog })),
)
const WorkspaceWorkflowCreateModeDialog = lazy(() =>
  import('@/features/workspace/components/WorkspaceWorkflowCreateModeDialog').then((module) => ({ default: module.WorkspaceWorkflowCreateModeDialog })),
)
const FormSyncCreateDialog = lazy(() =>
  import('@/features/formSync/FormSyncCreateDialog').then((module) => ({ default: module.FormSyncCreateDialog })),
)

const TABLE_FILE_ACCEPT = '.csv,.tsv,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export type WorkspaceDialogsProps = {
  /** A workspace write is in flight; dialogs show their busy state. */
  saving: boolean
  documentExport: ReturnType<typeof useDocumentExport>
  createFlows: ReturnType<typeof useWorkspaceCreateFlows>
  templateDialogs: ReturnType<typeof useWorkspaceTemplateDialogs>
  boardCreation: ReturnType<typeof useWorkspaceBoardCreation>
  workflowCreateMode: ReturnType<typeof useWorkspaceWorkflowCreateMode>
  /** Called with the imported document path after a table file import completes. */
  onTableFileImported: (path: string | undefined) => Promise<void>
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
  workflowCreateMode,
  onTableFileImported,
}: WorkspaceDialogsProps) {
  const { t } = useTranslation('workspace')
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
      {templateDialogs.kitableTemplateDialogState ? (
        <Suspense fallback={null}>
          <KitableTemplateLibraryDialog
            open
            busy={saving}
            onOpenChange={(open) => {
              if (!open) templateDialogs.closeKitableTemplateDialog()
            }}
            onSelect={templateDialogs.createKitableFromTemplate}
          />
        </Suspense>
      ) : null}
      {createFlows.formSyncCreateState ? (
        <Suspense fallback={null}>
          <FormSyncCreateDialog
            open
            documentId={createFlows.formSyncCreateState.documentId}
            initialTableId={createFlows.formSyncCreateState.initialTableId}
            onOpenChange={(open) => {
              if (!open) createFlows.closeFormSyncCreate()
            }}
            onCreated={createFlows.handleFormSyncCreated}
          />
        </Suspense>
      ) : null}
      {workflowCreateMode.state ? (
        <Suspense fallback={null}>
          <WorkspaceWorkflowCreateModeDialog
            open
            context={workflowCreateMode.state.context}
            tableOptions={workflowCreateMode.state.tableOptions}
            onOpenChange={(open) => {
              if (!open) workflowCreateMode.close()
            }}
            onSelect={workflowCreateMode.select}
            busyKind={workflowCreateMode.busyKind}
            busyTemplateId={workflowCreateMode.busyTemplateId}
            errorMessage={workflowCreateMode.error}
            emailSyncTablePath={workflowCreateMode.state.kitablePath || undefined}
            onSelectEmailSync={(tablePath, runAfterSave) => {
              workflowCreateMode.close()
              requestEmailSyncSetup(tablePath, { runAfterSave })
            }}
          />
        </Suspense>
      ) : null}
      <input
        ref={createFlows.tableFileImportInputRef}
        type="file"
        accept={TABLE_FILE_ACCEPT}
        className="hidden"
        onChange={createFlows.handleTableFileInputChange}
      />
      {createFlows.tableFileImportState ? (
        <Suspense fallback={null}>
          <TableFileImportDialog
            open
            file={createFlows.tableFileImportState.file}
            target={{ kind: 'new_document', folder: createFlows.tableFileImportState.folder }}
            onOpenChange={(open) => {
              if (!open) createFlows.closeTableFileImport()
            }}
            onCompleted={async (result) => {
              await onTableFileImported(result.path)
              notify.success(t('feedback.spreadsheetImported'))
            }}
          />
        </Suspense>
      ) : null}
    </>
  )
}
