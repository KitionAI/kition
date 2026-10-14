/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/data-documents-transact.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type DataDocumentsTransactRowKey = string

/**
 * Field name to new value.
 */
export type DataDocumentsTransactCellValues = Record<string, unknown>

/**
 * Field name to initial value for a created record.
 */
export type DataDocumentsTransactRecordFields = Record<string, unknown>

/**
 * Where records.create inserts the new rows; null appends them at the end.
 */
export type DataDocumentsTransactCreateAt = {
  before: DataDocumentsTransactRowKey
} | {
  after: DataDocumentsTransactRowKey
} | null

export type DataDocumentsTransactOpCellsSet = {
  op: "cells.set"
  tableId: number
  records: Array<{
    rowKey: DataDocumentsTransactRowKey
    values: DataDocumentsTransactCellValues
  }>
}

export type DataDocumentsTransactOpRecordsCreate = {
  op: "records.create"
  tableId: number
  at: DataDocumentsTransactCreateAt
  records: DataDocumentsTransactRecordFields[]
}

export type DataDocumentsTransactOpRecordsDelete = {
  op: "records.delete"
  tableId: number
  rowKeys: DataDocumentsTransactRowKey[]
}

export type DataDocumentsTransactOpRecordsMove = {
  op: "records.move"
  tableId: number
  rowKeys: DataDocumentsTransactRowKey[]
  before: DataDocumentsTransactRowKey | null
}

export type DataDocumentsTransactOpFieldsMove = {
  op: "fields.move"
  tableId: number
  fieldIds: number[]
  toIndex: number
}

/**
 * One step of a transaction, tagged by op.
 */
export type DataDocumentsTransactOp = DataDocumentsTransactOpCellsSet | DataDocumentsTransactOpRecordsCreate | DataDocumentsTransactOpRecordsDelete | DataDocumentsTransactOpRecordsMove | DataDocumentsTransactOpFieldsMove

/**
 * POST /v1/data-documents/{id}/transact: applies every op as one transaction and one undo step.
 */
export type DataDocumentsTransactTransactRequest = {
  ops: DataDocumentsTransactOp[]
}

/**
 * [tableId, rowKey] tuple.
 */
export type DataDocumentsTransactTableRowRef = [number, DataDocumentsTransactRowKey]

/**
 * What a transaction, undo, redo, or dashboard write touched, for a window to apply to its own state without refetching. Also the params of the table/changed bridge event (table-changed.schema.json), plus documentPath there.
 */
export type DataDocumentsTransactTableChange = {
  documentId: string
  /**
   * Who made the change: person:session:<uuid> for a window, agent:<turnId> for the agent, or template for seeding.
   */
  origin: string
  /**
   * Table ids whose definition (not rows) changed.
   */
  tables: number[]
  /**
   * Table ids whose fields changed.
   */
  schema: number[]
  /**
   * View ids that changed.
   */
  views: number[]
  recordsUpserted: DataDocumentsTransactTableRowRef[]
  recordsDeleted: DataDocumentsTransactTableRowRef[]
  /**
   * Table ids whose row order changed.
   */
  recordsReordered: number[]
  dashboards: boolean
}

export type DataDocumentsTransactTransactResponse = {
  change: DataDocumentsTransactTableChange
  /**
   * Row keys created by records.create ops, in request order.
   */
  created: DataDocumentsTransactRowKey[]
}

/**
 * POST /v1/data-documents/{id}/undo and /redo: empty body.
 */
export type DataDocumentsTransactUndoRedoRequest = Record<string, never>

export type DataDocumentsTransactUndoRedoResponse = {
  /**
   * False when there was nothing to undo or redo; change is then a no-op.
   */
  done: boolean
  change: DataDocumentsTransactTableChange
}

/**
 * GET /v1/data-documents/{id}/history-state
 */
export type DataDocumentsTransactHistoryStateResponse = {
  canUndo: boolean
  canRedo: boolean
}

/**
 * POST /v1/data-documents/{id}/transact, POST /v1/data-documents/{id}/undo, POST /v1/data-documents/{id}/redo, and GET /v1/data-documents/{id}/history-state. Every request to these routes, and to the rest of /v1/data-documents, carries a Kition-Session header (one UUID per window); the runtime records person:session:<uuid> as the resulting change's origin. table/changed on the kit bridge stream (table-changed.schema.json) carries the same TableChange shape.
 */
export type DataDocumentsTransactContract = DataDocumentsTransactTransactResponse
