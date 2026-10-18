import type { DataFieldOptions } from './dataDocument'
import type {
  DataImportExecuteRequest,
  DataImportField as GeneratedDataImportField,
  DataImportJob,
  DataImportPreviewResponse,
  DataImportResult,
} from '../generated/data-import'

/** File import into a table (contracts/runtime/data-import.schema.json). */
export type { DataImportJob, DataImportResult }
export type DataImportWriteMode = DataImportExecuteRequest['write_mode']
export type DataImportPreview = DataImportPreviewResponse
export type ExecuteDataImportPayload = DataImportExecuteRequest

/**
 * The contract types `options` as an open object; the client narrows it to
 * the table field option shape it already understands.
 */
export type DataImportField = Omit<GeneratedDataImportField, 'options'> & { options?: DataFieldOptions }
