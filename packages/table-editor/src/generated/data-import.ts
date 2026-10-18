/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/data-import.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type DataImportFormat = "csv" | "tsv" | "xlsx"

export type DataImportFieldType = "text" | "long_text" | "number" | "date" | "datetime" | "single_select" | "multi_select" | "checkbox" | "url"

export type DataImportSource = {
  kind: "workspace"
  workspace_path: string
} | {
  kind: "upload"
  upload_name: string
}

export type DataImportWarning = {
  code: string
  message: string
  severity: "info" | "warning" | "error"
  row?: number
  column?: number
}

export type DataImportField = {
  index: number
  title: string
  type: DataImportFieldType
  nullable: boolean
  options?: Record<string, unknown>
  sample_values: Array<string | number | boolean | null>
}

export type DataImportSheet = {
  name: string
  index: number
  hidden: boolean
  row_count: number
  field_count: number
}

export type DataImportPreviewRequest = {
  source: DataImportSource
  sheet?: string
}

export type DataImportPreviewResponse = {
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

export type DataImportTarget = {
  kind: "new_document"
  path: string
  table_title: string
} | {
  kind: "new_table"
  document_id: number
  table_title: string
} | {
  kind: "existing_table"
  document_id: number
  table_id: number
}

export type DataImportFieldOverride = {
  index: number
  title: string
  type: DataImportFieldType
  options?: Record<string, unknown>
}

export type DataImportExecuteRequest = {
  import_token: string
  target: DataImportTarget
  write_mode: "replace" | "append" | "upsert"
  schema_mode: "auto" | "preserve" | "replace"
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
  status: "queued" | "running" | "completed" | "failed" | "canceled"
  stage: "queued" | "parsing" | "validating" | "writing_schema" | "writing_records" | "finalizing" | "completed" | "failed" | "canceled"
  processed_rows: number
  total_rows: number
  result?: DataImportResult
  error?: {
    code: string
    message: string
  }
  created_at: string
  updated_at: string
}

/**
 * Public wire contract for previewing and importing CSV, TSV, and XLSX files into Kitable resources.
 */
export type DataImportContract = DataImportPreviewRequest | DataImportPreviewResponse | DataImportExecuteRequest | DataImportJob
