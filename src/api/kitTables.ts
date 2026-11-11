/**
 * The workspace's table files as Kition's own features see them: the workspace tree's table
 * leaves, templates, and the design handoff. The runtime answers through the Table kit (`contracts/runtime/kit-tables`);
 * a table is named by its file's path and its id in the file.
 */
import request from './request'
import type {
  KitTablesDeletedResult,
  KitTablesFile,
  KitTablesFileList,
  KitTablesRenamedResult,
} from './generated/kit-tables'

export type { KitTablesFile }

/** The table file extension, with its dot. */
const TABLE_FILE_EXTENSION = '.ktable'

/** Whether `path` names a table file. */
export function isTableFilePath(path: string | null | undefined) {
  return Boolean(path && path.toLowerCase().endsWith(TABLE_FILE_EXTENSION))
}

/** Every table file in the workspace (or only `path`), with its tables and dashboards; each read through the Table kit. */
export function listTableFiles(options?: { path?: string; signal?: AbortSignal }) {
  return request.get<KitTablesFileList>('/v1/kit-tables', {
    ...(options?.path ? { params: { path: options.path } } : {}),
    signal: options?.signal,
    suppressErrorMessage: true,
  })
}

/** Tells the runtime's table client that a table file (or a folder of them) moved: it reads it again at the new path. */
export function reportTableFileRenamed(from: string, to: string) {
  return request.post<KitTablesRenamedResult>('/v1/kit-tables/renamed', { from, to }, { suppressErrorMessage: true })
}

/** Tells the runtime's table client that a table file (or the table files of a deleted folder) went: it forgets them. */
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
