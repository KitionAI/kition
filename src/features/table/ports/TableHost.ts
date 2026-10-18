import { createContext, useContext } from 'react'
import type {
  DataImportField,
  DataImportJob,
  DataImportPreview,
  DataImportResult,
  DataImportWriteMode,
} from '@/api/dataImports'
import type { ModelCapability, RuntimeWritingModel } from '@/types'
import type { AnyAIConfig } from '@/types/aiConfig'
import type {
  DataAttachment,
  DataField,
  DataRecord,
  DataTable,
  RunDataAIFieldBatchResponse,
  RunDataAIFieldCellResponse,
} from '@/types/dataDocument'
import type { CsvImportAnalysis } from '@/features/table/lib/csvImport'

type NotifyOptions = { id?: string | number; description?: string }

/** Toasts. */
export type TableNotifier = {
  success(message: string, options?: NotifyOptions): unknown
  error(message: string, options?: NotifyOptions): unknown
  dismiss(id?: string | number): void
}

/** Where an imported file goes: rows into an open table, or a new `.kitable` at `path`. */
export type TableFileImportTarget =
  | { kind: 'existing_table'; documentId: number; table: DataTable }
  | { kind: 'new_document'; path: string; tableTitle: string }

/** A file read and previewed, ready to import. */
export type PreparedTableFileImport = {
  backend: 'runtime' | 'client'
  file: File
  preview: DataImportPreview
  csvContent?: string
  csvAnalysis?: CsvImportAnalysis
}

/** CSV, TSV, and XLSX import into a table. */
type TableFileImporter = {
  prepare(file: File, options?: { requireRuntime?: boolean; sheet?: string }): Promise<PreparedTableFileImport>
  execute(options: {
    fieldTypes: DataImportField['type'][]
    onProgress?: (job: DataImportJob) => void
    prepared: PreparedTableFileImport
    signal?: AbortSignal
    target: TableFileImportTarget
    writeMode: DataImportWriteMode
  }): Promise<{ backend: PreparedTableFileImport['backend']; jobId?: string; result: DataImportResult }>
  cancel(jobId?: string): Promise<void>
}

type AIRunParams = {
  action: string
  config: AnyAIConfig
  force?: boolean
  runtime_model?: RuntimeWritingModel
}

/** AI fields: the model to run with, and the runs (`.../ai/run` on the runtime). */
type TableAIHost = {
  /** The model an AI field's config runs on (its override, or the app's default). */
  resolveRuntimeModel(config: AnyAIConfig): Promise<RuntimeWritingModel | undefined>
  /** The record ready for an AI field run (bundled template attachments stored in the document); `record` when nothing changed. */
  prepareRecord(params: {
    documentId: number
    tableId: number
    record: DataRecord
    config: AnyAIConfig
    fields: DataField[]
    signal?: AbortSignal
  }): Promise<DataRecord>
  runCell(
    params: { documentId: number; tableId: number; recordId: number; fieldId: number } & AIRunParams,
    options?: { signal?: AbortSignal },
  ): Promise<RunDataAIFieldCellResponse>
  runBatch(
    params: { documentId: number; tableId: number; fieldId: number; record_ids: number[]; scope?: string; limit?: number } & AIRunParams,
    options?: { signal?: AbortSignal },
  ): Promise<RunDataAIFieldBatchResponse>
  /** Models a field may override its runtime model with. */
  loadModelOptions(capability: ModelCapability): Promise<Array<{ value: string; label: string }>>
}

/** What the record context menu's "create design" hands the app. */
type TableDesignRequest = {
  title: string
  fields: Record<string, unknown>
  record?: { documentId: number; tableId: number; recordId: number; field: string }
}

/**
 * App services the table editor uses besides its data (`TableDataSource`). Every member is
 * optional: without one, the editor hides what needs it (attachment upload, image copy, CSV
 * export, file import, AI fields, design from a record) or does without (toasts).
 */
export interface TableHost {
  /**
   * A URL the page can load for an attachment's stored `url` (a workspace path, a bundled
   * asset, or a URL). Without it, only `http(s):`, `data:`, and `blob:` URLs are shown.
   */
  resolveFileURL?(url: string): string
  /** Stores a file as an attachment of `tableId`. */
  uploadAttachment?(params: { documentId: number; tableId: number; file: File }): Promise<DataAttachment>
  copyImageToClipboard?(url: string): Promise<unknown>
  /** Saves text through a save dialog (CSV export). */
  saveTextFile?(options: { dialogTitle: string; defaultFilename: string; content: string }): Promise<unknown>
  notify?: TableNotifier
  fileImport?: TableFileImporter
  ai?: TableAIHost
  requestDesignFromRecord?(request: TableDesignRequest): void
}

const TableHostContext = createContext<TableHost>({})

export const TableHostProvider = TableHostContext.Provider

/** The host the editor's root provides (`TableHostProvider`); an empty one without a provider. */
export function useTableHost(): TableHost {
  return useContext(TableHostContext)
}

const SELF_CONTAINED_URL = /^(https?:|data:|blob:)/i

/** `host.resolveFileURL`, or the URL itself when it needs no host to load. */
export function resolveTableFileURL(host: TableHost, url: string) {
  if (host.resolveFileURL) return host.resolveFileURL(url)
  return SELF_CONTAINED_URL.test(url) ? url : ''
}

const silentNotifier: TableNotifier = {
  success: () => undefined,
  error: () => undefined,
  dismiss: () => undefined,
}

/** `host.notify`, or a notifier that shows nothing. */
export function useTableNotify(): TableNotifier {
  return useTableHost().notify ?? silentNotifier
}
