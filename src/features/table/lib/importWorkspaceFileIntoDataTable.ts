import {
  executeDataImport,
  previewWorkspaceDataImport,
  runtimeSupportsTableFileImport,
  runtimeSupportsXlsxImport,
} from '@/api/dataImports'
import { getDataDocument } from '@/api/dataDocuments'
import { waitForDataImportJob } from '@/features/table/lib/tableFileImport'
import { importCsvIntoDataTable } from '@/features/table/lib/importCsvIntoDataTable'
import { getDesktopBackendStatus, readWorkspaceDocument } from '@/services/desktop'

export async function importWorkspaceFileIntoDataTable({
  documentId,
  path,
  tableId,
}: {
  documentId: number
  path: string
  tableId: number
}) {
  const status = await getDesktopBackendStatus().catch(() => null)
  const capabilities = status?.capabilities || []
  if (/\.xls$/i.test(path)) {
    throw new Error('Legacy XLS files are not supported. Save the workbook as XLSX and try again.')
  }
  const workbook = /\.xlsx$/i.test(path)

  if (runtimeSupportsTableFileImport(capabilities) && (!workbook || runtimeSupportsXlsxImport(capabilities))) {
    const preview = await previewWorkspaceDataImport({ workspace_path: path })
    const initialJob = await executeDataImport({
      import_token: preview.import_token,
      target: { kind: 'existing_table', document_id: documentId, table_id: tableId },
      write_mode: 'append',
      schema_mode: 'auto',
      idempotency_key: `${preview.import_token}:${documentId}:${tableId}:agent`,
    })
    const completed = await waitForDataImportJob(initialJob)
    return {
      created: completed.result!.rows_created,
      fieldCount: preview.field_count,
      inferredFields: preview.fields.map((field) => ({
        title: field.title,
        type: field.type,
        options: field.options,
      })),
    }
  }

  if (workbook) {
    throw new Error('This runtime does not support XLSX import yet. Update the Kition runtime and try again.')
  }

  const [document, source] = await Promise.all([
    getDataDocument(documentId),
    readWorkspaceDocument(path),
  ])
  const table = document.tables?.find((item) => Number(item.id) === Number(tableId))
  if (!table) {
    throw new Error('The active table is unavailable for file import.')
  }
  return importCsvIntoDataTable({
    content: source.content,
    documentId,
    table,
  })
}
