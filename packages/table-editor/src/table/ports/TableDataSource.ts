import { createContext, useContext } from 'react'
import type {
  DataDocumentsTransactHistoryStateResponse,
  DataDocumentsTransactOp,
  DataDocumentsTransactTableChange,
  DataDocumentsTransactTransactResponse,
  DataDocumentsTransactUndoRedoResponse,
} from '../../generated/data-documents-transact'
import type { TableChangedParams } from '../../generated/table-changed'
import type {
  BulkCopyRecordsPayload,
  BulkCopyRecordsResult,
  BulkDeleteRecordsPayload,
  BulkDeleteRecordsResult,
  CreateDataFieldPayload,
  CreateDataTablePayload,
  CreateDataViewPayload,
  DataDashboard,
  DataDocument,
  DataField,
  DataListResponse,
  DataRecord,
  DataRecordValue,
  DataTable,
  DataView,
  LinkRef,
  RecordHistoryResponse,
  ViewFieldLayout,
  ViewFieldPatchPayload,
  ViewFieldsResponse,
} from '../../types/dataDocument'

/** One step of a table transaction (contracts/runtime/data-documents-transact.schema.json). */
export type TableOp = DataDocumentsTransactOp
/** What a transaction, undo, redo, or dashboard write touched. */
export type TableChange = DataDocumentsTransactTableChange
/** Whether the document has an undo or a redo step. */
type TableHistoryState = DataDocumentsTransactHistoryStateResponse
/** A change another writer made to a document (`table/changed`): the `TableChange` plus the document's path. */
export type TableLiveChange = TableChangedParams

/**
 * What the data source tells a `onChange` listener: a change someone else made (another
 * window, the agent, a workflow, a co-editor), or `resync` when changes may have been missed
 * and the editor should refetch instead of trusting its state.
 */
type TableChangeEvent =
  | { type: 'changed'; change: TableLiveChange }
  | { type: 'resync' }

type DocumentParams = { documentId: number }
type TableParams = DocumentParams & { tableId: number }
type FieldParams = TableParams & { fieldId: number }
type ViewParams = TableParams & { viewId: number }
type RecordParams = TableParams & { recordId: number }
type ListWindow = { limit?: number; offset?: number }

/**
 * Everything the table editor (table and dashboard) reads from and writes to a table document.
 *
 * Member names are the `kition-table-api` method names (`crates/kition-table-api`, `METHODS`),
 * and params are that method's params: the route's path ids (`tableId`, `fieldId`, `viewId`,
 * `recordId`, `dashboardId`), its query values, and its body's fields. An implementation over
 * the kit engine maps `records.list(params)` to `call('records.list', params)` one to one;
 * `documentId` names the document for implementations that hold several. Answers are what the
 * runtime routes answer (the `data` of their envelope); `csv.export` answers the CSV text.
 *
 * `documents.*` and `onChange` are outside `METHODS`: an engine-backed source holds one
 * document, answers `documents.*` with it, and reports through `onChange` only changes it did
 * not make through this source (replica imports), since the editor applies its own writes.
 */
export interface TableDataSource {
  documents: {
    get(params: DocumentParams): Promise<DataDocument>
    open(params: { path: string; workspace_root?: string }): Promise<DataDocument>
    list(params: { query?: string; workspace_root?: string }): Promise<DataListResponse<DataDocument>>
  }
  tables: {
    create(params: DocumentParams & CreateDataTablePayload): Promise<DataTable>
    update(params: TableParams & Partial<CreateDataTablePayload>): Promise<DataTable>
    delete(params: TableParams): Promise<unknown>
  }
  fields: {
    create(params: TableParams & CreateDataFieldPayload): Promise<DataField>
    update(params: FieldParams & Partial<CreateDataFieldPayload>): Promise<DataField>
    delete(params: FieldParams): Promise<unknown>
    duplicate(params: FieldParams): Promise<DataField>
    linkCandidates(params: FieldParams & { q: string; limit?: number }): Promise<LinkRef[]>
  }
  views: {
    create(params: TableParams & CreateDataViewPayload): Promise<DataView>
    update(params: ViewParams & Partial<CreateDataViewPayload>): Promise<DataView>
    delete(params: ViewParams): Promise<unknown>
    listFields(params: ViewParams): Promise<ViewFieldsResponse>
    patchField(params: ViewParams & { fieldId: number } & ViewFieldPatchPayload): Promise<ViewFieldLayout>
  }
  records: {
    list(params: TableParams & ListWindow): Promise<DataListResponse<DataRecord>>
    create(params: TableParams & { values: Record<string, DataRecordValue> }): Promise<DataRecord>
    update(params: RecordParams & { values: Record<string, DataRecordValue> }): Promise<DataRecord>
    delete(params: RecordParams): Promise<unknown>
    history(params: RecordParams & ListWindow): Promise<RecordHistoryResponse>
    bulkDelete(params: TableParams & BulkDeleteRecordsPayload): Promise<BulkDeleteRecordsResult>
    bulkCopy(params: TableParams & BulkCopyRecordsPayload): Promise<BulkCopyRecordsResult>
  }
  links: {
    replace(params: RecordParams & { field_id: number; target_row_keys: string[] }): Promise<LinkRef[]>
  }
  csv: {
    export(params: TableParams): Promise<string>
  }
  /** Applies every op as one transaction and one undo step. */
  transact(params: DocumentParams & { ops: TableOp[] }): Promise<DataDocumentsTransactTransactResponse>
  undo(params: DocumentParams): Promise<DataDocumentsTransactUndoRedoResponse>
  redo(params: DocumentParams): Promise<DataDocumentsTransactUndoRedoResponse>
  historyState(params: DocumentParams): Promise<TableHistoryState>
  dashboards: {
    list(params: DocumentParams): Promise<DataListResponse<DataDashboard>>
    upsert(params: DocumentParams & { dashboardId: string } & DataDashboard): Promise<DataDashboard>
  }
  /** Calls `listener` for each change to `documentId` made elsewhere; returns the unsubscribe. */
  onChange(documentId: number, listener: (event: TableChangeEvent) => void): () => void
}

const TableDataSourceContext = createContext<TableDataSource | null>(null)

export const TableDataSourceProvider = TableDataSourceContext.Provider

/** The data source the editor's root provides (`TableDataSourceProvider`). */
export function useTableDataSource(): TableDataSource {
  const dataSource = useContext(TableDataSourceContext)
  if (!dataSource) {
    throw new Error('The table editor needs a TableDataSourceProvider.')
  }
  return dataSource
}
