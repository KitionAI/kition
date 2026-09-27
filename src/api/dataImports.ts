import request from './request'
import type { DataFieldOptions } from '@/types/dataDocument'
import type {
  DataImportExecuteRequest,
  DataImportField as GeneratedDataImportField,
  DataImportFieldOverride as GeneratedDataImportFieldOverride,
  DataImportFormat,
  DataImportJob,
  DataImportPreviewResponse,
  DataImportResult,
  DataImportSheet,
  DataImportSource,
  DataImportTarget,
  DataImportWarning,
} from '@/api/generated'

export const TABLE_FILE_IMPORT_CAPABILITY = 'table_file_import_v1'
export const TABLE_FILE_IMPORT_XLSX_CAPABILITY = 'table_file_import_xlsx_v1'
export const TABLE_FILE_IMPORT_ASYNC_CAPABILITY = 'table_file_import_async_v1'

export type {
  DataImportFormat,
  DataImportSheet,
  DataImportSource,
  DataImportTarget,
  DataImportWarning,
  DataImportResult,
  DataImportJob,
}
export type DataImportWriteMode = DataImportExecuteRequest['write_mode']
export type DataImportSchemaMode = DataImportExecuteRequest['schema_mode']
export type DataImportJobStatus = DataImportJob['status']
export type DataImportJobStage = DataImportJob['stage']
export type DataImportPreview = DataImportPreviewResponse
export type ExecuteDataImportPayload = DataImportExecuteRequest

/**
 * The contract types `options` as an open object; the client narrows it to
 * the table field option shape it already understands.
 */
export type DataImportField = Omit<GeneratedDataImportField, 'options'> & { options?: DataFieldOptions }
export type DataImportFieldOverride = Omit<GeneratedDataImportFieldOverride, 'options'> & { options?: DataFieldOptions }

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
