/** The table row a design was created from, so its export can return as an attachment. */
export type DesignRecordRef = {
  /** The table file's workspace path. */
  path: string
  /** The table's and the record's ids in the file. */
  tableId: string
  recordId: string
  /** The attachment field that receives the exported image. */
  field: string
}
