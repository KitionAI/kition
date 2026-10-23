/* eslint-disable */
/**
 * GENERATED FILE. Do not edit.
 * Source: contracts/runtime/kit-tables.schema.json
 * Regenerate with: pnpm run contracts:generate
 */

export type KitTablesTablePath = string

export type KitTablesField = {
  id: string
  /**
   * The engine's key for the field's values.
   */
  name: string
  /**
   * What people call it: its title, or its name without one.
   */
  title: string
  type: string
  primary: boolean
}

export type KitTablesTable = {
  id: string
  name: string
  title: string
  /**
   * The table's own metadata; Kition keeps a table's unpublished form drafts in it (form_sync_workflows).
   */
  meta: Record<string, unknown>
  fields: KitTablesField[]
}

export type KitTablesDashboard = {
  id: string
  name: string
}

export type KitTablesFile = {
  path: KitTablesTablePath
  documentId: string | null
  tables: KitTablesTable[]
  dashboards: KitTablesDashboard[]
}

export type KitTablesUnreadableFile = {
  path: string
  error: string
}

export type KitTablesFileList = {
  files: KitTablesFile[]
  unreadable: KitTablesUnreadableFile[]
}

export type KitTablesCreateFileRequest = {
  path: KitTablesTablePath
  /**
   * The starter table's title.
   */
  title?: string
}

export type KitTablesCreateFileResult = {
  path: KitTablesTablePath
  tables: KitTablesTable[]
}

export type KitTablesFieldSeed = {
  name?: string
  title: string
  type: string
  primary?: boolean
  required?: boolean
  readonly?: boolean
  options?: Record<string, unknown>
}

/**
 * The host feature writing, recorded as the origin system:<feature>; host when absent.
 */
export type KitTablesFeature = string

export type KitTablesCreateTableRequest = {
  path: KitTablesTablePath
  title: string
  fields?: KitTablesFieldSeed[]
  feature?: KitTablesFeature
}

export type KitTablesUpdateTableRequest = {
  path: KitTablesTablePath
  tableId: string
  title?: string
  /**
   * Replaces the table's metadata.
   */
  meta?: Record<string, unknown>
  feature?: KitTablesFeature
}

export type KitTablesFieldsResult = {
  /**
   * The fields as the Table kit answers them (id, name, title, type, options, is_primary, ...).
   */
  items: Array<Record<string, unknown>>
  table: KitTablesTable
}

export type KitTablesRecord = {
  id: number | string
  /**
   * Values keyed by field name.
   */
  values: Record<string, unknown>
  created_at?: number
  updated_at?: number
}

export type KitTablesRecordsPage = {
  items: KitTablesRecord[]
  total?: number
  offset?: number
  limit?: number
}

export type KitTablesWriteRecordRequest = {
  path: KitTablesTablePath
  tableId: string
  /**
   * Absent: a new record.
   */
  recordId?: string
  /**
   * Values keyed by field id, name, or title.
   */
  values: Record<string, unknown>
  feature?: KitTablesFeature
}

export type KitTablesWriteRecordResult = {
  id: string
  values: Record<string, unknown>
}

export type KitTablesAttachmentRequest = {
  path: KitTablesTablePath
  tableId: string
  name: string
  mime: string
  /**
   * The file's bytes, base64.
   */
  data: string
  feature?: KitTablesFeature
}

/**
 * The attachment value a file field holds for the stored blob (url kition-blob:<sha256>, name, mimeType, size).
 */
export type KitTablesAttachment = Record<string, unknown>

export type KitTablesRenamedRequest = {
  from: string
  to: string
}

export type KitTablesRenamedResult = {
  /**
   * Workflows, form sync targets, and email sync targets that now name the new path.
   */
  updated: number
}

export type KitTablesDeletedRequest = {
  /**
   * The deleted table file, or a deleted folder: every table file under it.
   */
  path: string
}

export type KitTablesDeletedResult = {
  /**
   * Workflows, form syncs, and email syncs bound to the deleted files, which were removed.
   */
  removed: number
}

export type KitTablesReason = "unavailable" | "not-found" | "failed"

/**
 * /api/v1/kit-tables: the workspace's .ktable files as Kition's own features see them (the workflow editor's table and field pickers, form and email sync targets, the workspace tree's table leaves, templates, and the design handoff). The runtime answers through the Table kit (crates/kition-tableclient): the live editor over the Kit AI bridge when a window has the file open, the headless kit otherwise. Host features name a table by its file's workspace path, the file's documentId (its KDM root object id, which a rename keeps), and the table's id in the file. Writes carry the origin system:<feature> and never join the person's undo. Refusals carry data.reason: unavailable (no Table kit in this build), not-found, or failed.
 */
export type KitTablesContract = KitTablesFileList
