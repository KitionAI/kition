/**
 * The workspace's table files as Kition's own features see them: the workflow editor's table and
 * field pickers, form and email sync targets, the workspace tree's table leaves, templates, and
 * the design handoff. The runtime answers through the Table kit (`contracts/runtime/kit-tables`);
 * a table is named by its file's path and its id in the file.
 */
import request from './request'
import type {
  KitTablesAttachment,
  KitTablesCreateFileResult,
  KitTablesDeletedResult,
  KitTablesFieldSeed,
  KitTablesFieldsResult,
  KitTablesFile,
  KitTablesFileList,
  KitTablesRecord,
  KitTablesRecordsPage,
  KitTablesRenamedResult,
  KitTablesTable,
  KitTablesWriteRecordResult,
} from './generated/kit-tables'

export type { KitTablesFieldSeed, KitTablesFile, KitTablesRecord, KitTablesTable }

/** The table file extension, with its dot. */
export const TABLE_FILE_EXTENSION = '.ktable'

/** Whether `path` names a table file. */
export function isTableFilePath(path: string | null | undefined) {
  return Boolean(path && path.toLowerCase().endsWith(TABLE_FILE_EXTENSION))
}

/** A table named the way host features store it. */
export type TableRef = { path: string; tableId: string }

/** Every table file in the workspace, with its tables and dashboards. */
export function listTableFiles(options?: { signal?: AbortSignal }) {
  return request.get<KitTablesFileList>('/v1/kit-tables', { signal: options?.signal, suppressErrorMessage: true })
}

/** Makes a new table file at `path` with the kit's starter table (titled `title` when given). */
export function createTableFile(path: string, title?: string) {
  return request.post<KitTablesCreateFileResult>('/v1/kit-tables/files', title ? { path, title } : { path })
}

/** Adds a table to a file. */
export function createTable(path: string, title: string, fields: KitTablesFieldSeed[] = [], feature?: string) {
  return request.post<KitTablesTable>('/v1/kit-tables/tables', { path, title, ...(fields.length ? { fields } : {}), ...(feature ? { feature } : {}) })
}

/** Renames a table, or replaces its metadata (where host features keep their table-bound drafts). */
export function updateTable(ref: TableRef, change: { title?: string; meta?: Record<string, unknown> }, feature?: string) {
  return request.post<KitTablesTable>('/v1/kit-tables/tables/update', { ...ref, ...change, ...(feature ? { feature } : {}) })
}

/** A table's fields as the kit answers them, and the table. */
export function getTableFields({ path, tableId }: TableRef, options?: { signal?: AbortSignal }) {
  return request.get<KitTablesFieldsResult>('/v1/kit-tables/fields', { params: { path, tableId }, signal: options?.signal, suppressErrorMessage: true })
}

/** A table's records (values keyed by field name), at most `limit` from `offset` (all without). */
export function listTableRecords({ path, tableId }: TableRef, options?: { limit?: number; offset?: number; signal?: AbortSignal }) {
  return request.get<KitTablesRecordsPage>('/v1/kit-tables/records', {
    params: { path, tableId, limit: options?.limit, offset: options?.offset },
    signal: options?.signal,
    suppressErrorMessage: true,
  })
}

/** Creates a record, or updates `recordId`, from values keyed by field id, name, or title, as `system:<feature>`. */
export function writeTableRecord(ref: TableRef & { recordId?: string }, values: Record<string, unknown>, feature?: string) {
  return request.post<KitTablesWriteRecordResult>('/v1/kit-tables/records', { ...ref, values, ...(feature ? { feature } : {}) })
}

/** Stores a file in the table file; answers the attachment value a file field holds. */
export async function putTableAttachment(ref: TableRef, file: Blob & { name?: string }, feature?: string) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return request.post<KitTablesAttachment>('/v1/kit-tables/attachments', {
    ...ref,
    name: file.name || 'attachment',
    mime: file.type || 'application/octet-stream',
    data: btoa(binary),
    ...(feature ? { feature } : {}),
  })
}

/** Tells the host features that name a table file (or a folder of them) that it moved. */
export function reportTableFileRenamed(from: string, to: string) {
  return request.post<KitTablesRenamedResult>('/v1/kit-tables/renamed', { from, to }, { suppressErrorMessage: true })
}

/** Tells the host features bound to a deleted table file (or to the table files of a deleted folder) that it went: they are removed. */
export function reportTableFileDeleted(path: string) {
  return request.post<KitTablesDeletedResult>('/v1/kit-tables/deleted', { path }, { suppressErrorMessage: true })
}

/** Fired on `window` when a table file was created, saved, renamed, or deleted in this window. */
const TABLE_FILES_CHANGED_EVENT = 'kition:table-files:changed'

export function notifyTableFilesChanged(path?: string) {
  window.dispatchEvent(new CustomEvent(TABLE_FILES_CHANGED_EVENT, { detail: { path } }))
}

/** Listens for `TABLE_FILES_CHANGED_EVENT`; answers the unsubscribe. */
export function onTableFilesChanged(listener: (path?: string) => void) {
  const handle = (event: Event) => listener((event as CustomEvent<{ path?: string }>).detail?.path)
  window.addEventListener(TABLE_FILES_CHANGED_EVENT, handle)
  return () => window.removeEventListener(TABLE_FILES_CHANGED_EVENT, handle)
}

/** A table's key in maps that hold tables of many files: its file's path and its id there. */
export function tableKey(path: string, tableId: string | number) {
  return `${path}#${tableId}`
}
