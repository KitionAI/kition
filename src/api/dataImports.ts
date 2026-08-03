import request from './request'
import type { DataFieldOptions, DataFieldType } from '@/types/dataDocument'

export const TABLE_FILE_IMPORT_CAPABILITY = 'table_file_import_v1'
export const TABLE_FILE_IMPORT_XLSX_CAPABILITY = 'table_file_import_xlsx_v1'
export const TABLE_FILE_IMPORT_ASYNC_CAPABILITY = 'table_file_import_async_v1'

export type DataImportFormat = 'csv' | 'tsv' | 'xlsx'
export type DataImportWriteMode = 'replace' | 'append' | 'upsert'
export type DataImportSchemaMode = 'auto' | 'preserve' | 'replace'
export type DataImportJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
export type DataImportJobStage =
  | 'queued'
  | 'parsing'
  | 'validating'
  | 'writing_schema'
  | 'writing_records'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'canceled'

export type DataImportSource =
  | { kind: 'workspace'; workspace_path: string }
  | { kind: 'upload'; upload_name: string }

export type DataImportWarning = {
  code: string
  message: string
  severity: 'info' | 'warning' | 'error'
  row?: number
  column?: number
}

export type DataImportField = {
  index: number
  title: string
  type: Extract<DataFieldType, 'text' | 'long_text' | 'number' | 'date' | 'datetime' | 'single_select' | 'multi_select' | 'checkbox' | 'url'>
  nullable: boolean
  options?: DataFieldOptions
  sample_values: Array<string | number | boolean | null>
}

export type DataImportSheet = {
  name: string
  index: number
  hidden: boolean
  row_count: number
  field_count: number
}

export type DataImportPreview = {
  import_token: string
  expires_at?: string
  source: DataImportSource
  filename?: string
  format: DataImportFormat
  encoding?: string
  delimiter?: string
  selected_sheet?: string
  row_count: number
  field_count: number
  fields: DataImportField[]
  sample_rows: Array<Array<string | number | boolean | null>>
  warnings: DataImportWarning[]
  sheets: DataImportSheet[]
}

export type DataImportTarget =
  | { kind: 'new_document'; path: string; table_title: string }
  | { kind: 'new_table'; document_id: number; table_title: string }
  | { kind: 'existing_table'; document_id: number; table_id: number }

export type DataImportFieldOverride = {
  index: number
  title: string
  type: DataImportField['type']
  options?: DataFieldOptions
}

export type ExecuteDataImportPayload = {
  import_token: string
  target: DataImportTarget
  write_mode: DataImportWriteMode
  schema_mode: DataImportSchemaMode
  unique_by?: string[]
  field_overrides?: DataImportFieldOverride[]
  idempotency_key?: string
}

export type DataImportResult = {
  document_id?: number
  table_id?: number
  path?: string
  rows_total: number
  rows_created: number
  rows_updated: number
  rows_skipped: number
  fields_created: number
  fields_updated: number
  warnings: DataImportWarning[]
}

export type DataImportJob = {
  id: string
  status: DataImportJobStatus
  stage: DataImportJobStage
  processed_rows: number
  total_rows: number
  result?: DataImportResult
  error?: { code: string; message: string }
  created_at: string
  updated_at: string
}

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
