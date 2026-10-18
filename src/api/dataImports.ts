import request from './request'
import type {
  DataImportJob,
  DataImportPreview,
  ExecuteDataImportPayload,
} from '@kition/table-editor'

export const TABLE_FILE_IMPORT_CAPABILITY = 'table_file_import_v1'
export const TABLE_FILE_IMPORT_XLSX_CAPABILITY = 'table_file_import_xlsx_v1'
export const TABLE_FILE_IMPORT_ASYNC_CAPABILITY = 'table_file_import_async_v1'

// The import types live with the table editor, which shows the import dialog.
export type {
  DataImportField,
  DataImportJob,
  DataImportPreview,
  DataImportWriteMode,
  ExecuteDataImportPayload,
} from '@kition/table-editor'

export function previewDataImportFile(file: File, options?: { sheet?: string }) {
  const formData = new FormData()
  formData.append('file', file)
  if (options?.sheet) formData.append('sheet', options.sheet)
  return request.post<DataImportPreview>('/v1/data-imports/preview', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}

export function previewWorkspaceDataImport(payload: {
  workspace_path: string
  sheet?: string
}) {
  return request.post<DataImportPreview>('/v1/data-imports/preview', {
    source: { kind: 'workspace', workspace_path: payload.workspace_path },
    sheet: payload.sheet,
  })
}

export function executeDataImport(payload: ExecuteDataImportPayload) {
  return request.post<DataImportJob>('/v1/data-imports', payload)
}

export function getDataImportJob(jobId: string) {
  return request.get<DataImportJob>(`/v1/data-imports/${encodeURIComponent(jobId)}`)
}

export function cancelDataImportJob(jobId: string) {
  return request.delete<DataImportJob>(`/v1/data-imports/${encodeURIComponent(jobId)}`)
}

export function runtimeSupportsTableFileImport(capabilities?: readonly string[]) {
  return Boolean(capabilities?.includes(TABLE_FILE_IMPORT_CAPABILITY))
}

export function runtimeSupportsXlsxImport(capabilities?: readonly string[]) {
  return runtimeSupportsTableFileImport(capabilities)
    && Boolean(capabilities?.includes(TABLE_FILE_IMPORT_XLSX_CAPABILITY))
}
