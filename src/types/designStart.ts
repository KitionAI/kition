/** The table row a design was created from, so its export can return as an attachment. */
export type DesignRecordRef = {
  documentId: number
  tableId: number
  recordId: number
  /** The attachment field that receives the exported image. */
  field: string
}

/** A Board frame captured for the design start-from adapter (the board editor makes it). */
export type { BoardFrameSnapshot } from '@kition/board-editor'
