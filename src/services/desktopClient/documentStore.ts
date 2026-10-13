/**
 * The private store of Markdown document replicas (`.kition/docs/` in the workspace): each document's meta and KDM
 * snapshot, and the index from workspace paths to document ids. The desktop shell keeps it on disk; without a desktop
 * bridge the browser preview keeps the same store in localStorage.
 */
import { type DocumentIndexPayload, type DocumentStoreMeta, type DocumentStorePayload, getDesktopBridge } from './bridge'
import { normalizeWorkspaceDocumentPath } from './workspaceDocuments'
import { uint8ArrayToBase64 } from './workspaceFiles'

export type { DocumentStoreMeta } from './bridge'

/** The error a guarded index write fails with when another writer changed the index since it was read. */
export const DOCUMENT_INDEX_CONFLICT = 'DOCUMENT_INDEX_CONFLICT'
const WORKSPACE_CHANGED = 'DESIGN_WORKSPACE_CHANGED'
const BROWSER_WORKSPACE_ROOT = 'browser-local-workspace'
const browserIndexStorageKey = 'kition.workspace.document-store.index.v1'
const browserEntryStoragePrefix = 'kition.workspace.document-store.entry.v1:'
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/

export type DocumentStoreEntry = {
  meta: DocumentStoreMeta
  snapshot: Uint8Array
}

export type DocumentIndex = DocumentIndexPayload

/** `expectedRoot` refuses the call when the workspace has switched to another folder meanwhile. */
export type DocumentStoreOptions = {
  expectedRoot?: string
}

export function isValidDocumentId(docId: string) {
  return typeof docId === 'string' && DOCUMENT_ID_PATTERN.test(docId)
}

export function isDocumentIndexConflict(error: unknown) {
  return String((error as { message?: unknown } | null)?.message ?? error ?? '').includes(DOCUMENT_INDEX_CONFLICT)
}

function checkDocumentId(docId: string) {
  if (!isValidDocumentId(docId)) throw new Error('invalid document id')
}

function checkMeta(docId: string, meta: DocumentStoreMeta) {
  if (!meta || typeof meta !== 'object' || meta.docId !== docId) throw new Error('document store meta names another document')
}

function isIndexPath(path: string) {
  return typeof path === 'string'
    && path !== ''
    && normalizeWorkspaceDocumentPath(path) === path
    && !path.split('/').some((part) => part === '.' || part === '..')
}

function checkIndexEntries(entries: Record<string, string>) {
  for (const [path, docId] of Object.entries(entries)) {
    if (!isIndexPath(path)) throw new Error('invalid document path in the document index')
    checkDocumentId(docId)
  }
}

function rootRequest(options?: DocumentStoreOptions) {
  return options?.expectedRoot ? { expected_root: options.expectedRoot } : {}
}

/** Decodes strict base64; throws when `text` is not base64. */
function base64ToBytes(text: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error('document store snapshot is not base64')
  }
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function toEntry(payload: DocumentStorePayload | null | undefined): DocumentStoreEntry | null {
  if (!payload) return null
  return { meta: payload.meta, snapshot: base64ToBytes(payload.snapshot_base64) }
}

// --- Browser fallback ---------------------------------------------------

function browserStorage() {
  if (typeof window === 'undefined') throw new Error('the document store needs a desktop bridge or browser storage')
  return window.localStorage
}

function checkBrowserRoot(options?: DocumentStoreOptions) {
  if (options?.expectedRoot && options.expectedRoot !== BROWSER_WORKSPACE_ROOT) throw new Error(WORKSPACE_CHANGED)
}

function readJson(key: string): unknown {
  const raw = browserStorage().getItem(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function readBrowserEntry(docId: string): DocumentStorePayload | null {
  const stored = readJson(`${browserEntryStoragePrefix}${docId}`) as Partial<DocumentStorePayload> | null
  if (!stored || typeof stored.snapshot_base64 !== 'string' || stored.meta?.docId !== docId) return null
  return { meta: stored.meta, snapshot_base64: stored.snapshot_base64 }
}

function readBrowserIndex(): DocumentIndex {
  const stored = readJson(browserIndexStorageKey) as { entries?: unknown; version?: unknown } | null
  if (!stored || typeof stored.version !== 'string') {
    return { entries: {}, version: browserStorage().getItem(browserIndexStorageKey) === null ? null : 'damaged' }
  }
  const entries: Record<string, string> = {}
  if (stored.entries && typeof stored.entries === 'object') {
    for (const [path, docId] of Object.entries(stored.entries as Record<string, unknown>)) {
      if (isIndexPath(path) && typeof docId === 'string' && isValidDocumentId(docId)) entries[path] = docId
    }
  }
  return { entries, version: stored.version }
}

let browserIndexWrites = 0

function nextBrowserIndexVersion() {
  browserIndexWrites += 1
  return `${Date.now().toString(36)}-${browserIndexWrites.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// --- API ----------------------------------------------------------------

/** The stored replica of `docId`, or `null` when there is none (or it is damaged). */
export async function readDocumentStore(docId: string, options?: DocumentStoreOptions): Promise<DocumentStoreEntry | null> {
  checkDocumentId(docId)
  const bridge = getDesktopBridge()
  if (bridge?.ReadDocumentStore) {
    return toEntry(await bridge.ReadDocumentStore({ doc_id: docId, ...rootRequest(options) }))
  }
  checkBrowserRoot(options)
  const stored = readBrowserEntry(docId)
  try {
    return toEntry(stored)
  } catch {
    return null
  }
}

/** Replaces the replica of `docId`; meta and snapshot land together or not at all. */
export async function writeDocumentStore(docId: string, entry: DocumentStoreEntry, options?: DocumentStoreOptions): Promise<void> {
  checkDocumentId(docId)
  checkMeta(docId, entry.meta)
  const payload: DocumentStorePayload = { meta: entry.meta, snapshot_base64: uint8ArrayToBase64(entry.snapshot) }
  const bridge = getDesktopBridge()
  if (bridge?.WriteDocumentStore) {
    await bridge.WriteDocumentStore({ doc_id: docId, ...payload, ...rootRequest(options) })
    return
  }
  checkBrowserRoot(options)
  browserStorage().setItem(`${browserEntryStoragePrefix}${docId}`, JSON.stringify(payload))
}

export async function deleteDocumentStore(docId: string, options?: DocumentStoreOptions): Promise<void> {
  checkDocumentId(docId)
  const bridge = getDesktopBridge()
  if (bridge?.DeleteDocumentStore) {
    await bridge.DeleteDocumentStore({ doc_id: docId, ...rootRequest(options) })
    return
  }
  checkBrowserRoot(options)
  browserStorage().removeItem(`${browserEntryStoragePrefix}${docId}`)
}

/** The path-to-document index with the version a later `writeDocumentIndex` must name. */
export async function readDocumentIndex(options?: DocumentStoreOptions): Promise<DocumentIndex> {
  const bridge = getDesktopBridge()
  if (bridge?.ReadDocumentIndex) {
    const index = await bridge.ReadDocumentIndex(rootRequest(options))
    return { entries: { ...(index?.entries || {}) }, version: index?.version ?? null }
  }
  checkBrowserRoot(options)
  return readBrowserIndex()
}

/**
 * Replaces the index when it is still at `expectedVersion` (`null`: no index yet); otherwise fails with
 * `DOCUMENT_INDEX_CONFLICT` (see `isDocumentIndexConflict`), and the caller re-reads and retries.
 */
export async function writeDocumentIndex(
  entries: Record<string, string>,
  expectedVersion: string | null,
  options?: DocumentStoreOptions,
): Promise<{ version: string }> {
  checkIndexEntries(entries)
  const bridge = getDesktopBridge()
  if (bridge?.WriteDocumentIndex) {
    return bridge.WriteDocumentIndex({ entries, expected_version: expectedVersion, ...rootRequest(options) })
  }
  checkBrowserRoot(options)
  if (readBrowserIndex().version !== expectedVersion) throw new Error(DOCUMENT_INDEX_CONFLICT)
  const version = nextBrowserIndexVersion()
  browserStorage().setItem(browserIndexStorageKey, JSON.stringify({ entries: { ...entries }, version }))
  return { version }
}
