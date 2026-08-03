import {
  cancelDataImportJob,
  executeDataImport,
  getDataImportJob,
  previewDataImportFile,
  runtimeSupportsTableFileImport,
  runtimeSupportsXlsxImport,
  type DataImportField,
  type DataImportJob,
  type DataImportPreview,
  type DataImportWriteMode,
} from '@/api/dataImports'
import { getDesktopBackendStatus } from '@/services/desktop'
import type { DataTable } from '@/types/dataDocument'
import {
  analyzeCsvImport,
  applyCsvFieldTypeOverrides,
  type CsvImportAnalysis,
} from '@/features/table/lib/csvImport'
import { importCsvIntoDataTable } from '@/features/table/lib/importCsvIntoDataTable'

const SUPPORTED_TEXT_EXTENSIONS = /\.(?:csv|tsv)$/i
const SUPPORTED_WORKBOOK_EXTENSIONS = /\.xlsx$/i
const LEGACY_WORKBOOK_EXTENSION = /\.xls$/i

export type TableFileImportTarget =
  | { kind: 'existing_table'; documentId: number; table: DataTable }
  | { kind: 'new_document'; path: string; tableTitle: string }

export type PreparedTableFileImport = {
  backend: 'runtime' | 'client'
  file: File
  preview: DataImportPreview
  csvContent?: string
  csvAnalysis?: CsvImportAnalysis
}

function csvAnalysisToPreview(file: File, analysis: CsvImportAnalysis): DataImportPreview {
  const format = file.name.toLocaleLowerCase().endsWith('.tsv') ? 'tsv' : 'csv'
  return {
    import_token: '',
    source: { kind: 'upload', upload_name: file.name },
    filename: file.name,
    format,
    encoding: 'utf-8',
    delimiter: format === 'tsv' ? '\t' : ',',
    row_count: analysis.recordCount,
    field_count: analysis.fields.length,
    fields: analysis.fields.map((field, index) => ({
      index,
      title: field.title,
      type: field.type as DataImportField['type'],
      nullable: analysis.rows.some((row) => !row[index]),
      options: field.options,
      sample_values: analysis.rows.slice(0, 10).map((row) => row[index] || null),
    })),
    sample_rows: analysis.rows.slice(0, 10),
    warnings: [],
    sheets: [],
  }
}

export async function prepareTableFileImport(file: File, options?: { requireRuntime?: boolean; sheet?: string }): Promise<PreparedTableFileImport> {
  const lowerName = file.name.toLocaleLowerCase()
  if (LEGACY_WORKBOOK_EXTENSION.test(lowerName)) {
    throw new Error('Legacy XLS files are not supported. Save the workbook as XLSX and try again.')
  }
  const status = await getDesktopBackendStatus().catch(() => null)
  const capabilities = status?.capabilities || []
  const workbook = SUPPORTED_WORKBOOK_EXTENSIONS.test(lowerName)

  if (runtimeSupportsTableFileImport(capabilities) && (!workbook || runtimeSupportsXlsxImport(capabilities))) {
    return {
      backend: 'runtime',
      file,
      preview: await previewDataImportFile(file, { sheet: options?.sheet }),
    }
  }

  if (options?.requireRuntime) {
    throw new Error('Creating a Kitable from a file requires an updated Kition runtime.')
  }

  if (!SUPPORTED_TEXT_EXTENSIONS.test(lowerName)) {
    throw new Error('This runtime does not support XLSX import yet. Update the Kition runtime and try again.')
  }

  const csvContent = await file.text()
  const csvAnalysis = analyzeCsvImport(csvContent)
  return {
    backend: 'client',
    file,
    preview: csvAnalysisToPreview(file, csvAnalysis),
    csvContent,
    csvAnalysis,
  }
}

function waitForPollingDelay(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Import canceled', 'AbortError'))
      return
    }
    const timeout = window.setTimeout(resolve, delayMs)
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timeout)
      reject(new DOMException('Import canceled', 'AbortError'))
    }, { once: true })
  })
}

export async function waitForDataImportJob(
  initialJob: DataImportJob,
  options?: {
    signal?: AbortSignal
    pollIntervalMs?: number
    onProgress?: (job: DataImportJob) => void
  },
) {
  let job = initialJob
  options?.onProgress?.(job)
  while (job.status === 'queued' || job.status === 'running') {
    await waitForPollingDelay(options?.pollIntervalMs ?? 500, options?.signal)
    job = await getDataImportJob(job.id)
    options?.onProgress?.(job)
  }
  if (job.status === 'failed') {
    throw new Error(job.error?.message || 'File import failed.')
  }
  if (job.status === 'canceled') {
    throw new DOMException('Import canceled', 'AbortError')
  }
  if (!job.result) {
    throw new Error('The import completed without a result.')
  }
  return job
}

export async function executePreparedTableFileImport({
  fieldTypes,
  onProgress,
  prepared,
  signal,
  target,
  writeMode,
}: {
  fieldTypes: DataImportField['type'][]
  onProgress?: (job: DataImportJob) => void
  prepared: PreparedTableFileImport
  signal?: AbortSignal
  target: TableFileImportTarget
  writeMode: DataImportWriteMode
}) {
  if (prepared.backend === 'runtime') {
    const runtimeTarget = target.kind === 'existing_table'
      ? { kind: 'existing_table' as const, document_id: target.documentId, table_id: target.table.id }
      : { kind: 'new_document' as const, path: target.path, table_title: target.tableTitle }
    const initialJob = await executeDataImport({
      import_token: prepared.preview.import_token,
      target: runtimeTarget,
      write_mode: target.kind === 'new_document' ? 'append' : writeMode,
      schema_mode: 'auto',
      field_overrides: prepared.preview.fields.map((field, index) => ({
        index: field.index,
        title: field.title,
        type: fieldTypes[index] || field.type,
        options: field.options,
      })),
      idempotency_key: target.kind === 'existing_table'
        ? `${prepared.preview.import_token}:${target.documentId}:${target.table.id}:${writeMode}`
        : `${prepared.preview.import_token}:${target.path}:new-document`,
    })
    const completed = await waitForDataImportJob(initialJob, { signal, onProgress })
    return {
      backend: prepared.backend,
      jobId: completed.id,
      result: completed.result!,
    }
  }

  if (target.kind === 'new_document') {
    throw new Error('Creating a Kitable from a file requires an updated Kition runtime.')
  }

  const analysis = applyCsvFieldTypeOverrides(
    prepared.csvAnalysis!,
    fieldTypes.map((type, index) => ({ index, type })),
  )
  const result = await importCsvIntoDataTable({
    analysis,
    content: prepared.csvContent!,
    documentId: target.documentId,
    table: target.table,
  })
  return {
    backend: prepared.backend,
    result: {
      document_id: target.documentId,
      table_id: target.table.id,
      rows_total: result.recordCount,
      rows_created: result.created,
      rows_updated: 0,
      rows_skipped: Math.max(0, result.recordCount - result.created),
      fields_created: result.addedFields,
      fields_updated: result.replacedDefaultFields ? Math.min(target.table.fields?.length || 0, result.fieldCount) : 0,
      warnings: [],
    },
  }
}

export async function cancelPreparedTableFileImport(jobId?: string) {
  if (!jobId) return
  await cancelDataImportJob(jobId)
}
