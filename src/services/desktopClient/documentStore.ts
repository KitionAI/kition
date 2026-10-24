/**
 * The private store of document replicas (`.kition/docs/` in the workspace): each document's meta, its KDM snapshot
 * and the changes appended since (and a kit replica's blobs), its version history on this device, and the index from
 * workspace paths to document ids. The desktop shell keeps it on disk, written by one Kition at a time (the store
 * lock); without a desktop bridge the browser preview keeps the same store in localStorage.
 */
import {
  type DocumentCheckpoint,
  type DocumentCheckpointInput,
  type DocumentIndexPayload,
  type DocumentStorePayload,
  type DocumentStoreStatus,
  type DocumentStoreWriteRequest,
  type DocumentStoreWritten,
  type KitReplicaMeta,
  getDesktopBridge,
} from './bridge'
import { normalizeWorkspaceDocumentPath } from './workspaceDocuments'
import { uint8ArrayToBase64 } from './workspaceFiles'

export type { DocumentCheckpoint, DocumentCheckpointInput, DocumentStoreStatus, DocumentStoreWritten, KitReplicaMeta } from './bridge'

/** The error a guarded index write fails with when another writer changed the index since it was read. */
export const DOCUMENT_INDEX_CONFLICT = 'DOCUMENT_INDEX_CONFLICT'
/** The error an append fails with when the store is not at the `seq` it names. */
export const DOCUMENT_STORE_CONFLICT = 'DOCUMENT_STORE_CONFLICT'
/** The error every store write fails with in a Kition that does not hold the store lock. */
export const DOCUMENT_STORE_READ_ONLY = 'DOCUMENT_STORE_READ_ONLY'
const WORKSPACE_CHANGED = 'DESIGN_WORKSPACE_CHANGED'
const BROWSER_WORKSPACE_ROOT = 'browser-local-workspace'
const browserIndexStorageKey = 'kition.workspace.document-store.index.v1'
const browserEntryStoragePrefix = 'kition.workspace.document-store.entry.v1:'
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/

/**
 * A kit replica's entry. A replica is `snapshot` with `changes` imported in order; `seq` names the stored version a later append follows (absent from a
 * store that cannot append), and `complete` is false when the store lost a change or blob it named.
 */
export type DocumentStoreEntry = {
  meta: KitReplicaMeta
  snapshot: Uint8Array
  changes?: Uint8Array[]
  blobs?: Uint8Array
  seq?: number
  version?: string | null
  complete?: boolean
}

/** How a whole-snapshot write relates to what is stored, and what to record in the history with it. */
export type DocumentStoreWriteOptions = DocumentStoreOptions & {
  /** The replica version written (hex), for appends and checkpoints. */
  version?: string
  /** The replica does not continue the stored one: its history starts over. */
  lineage?: 'new'
  checkpoint?: DocumentCheckpointInput
}

/** Changes since the stored `baseSeq`, to append. */
export type DocumentStoreAppend = {
  meta: KitReplicaMeta
  changes: Uint8Array
  baseSeq: number
  blobs?: Uint8Array
}

export type DocumentIndex = DocumentIndexPayload

/** `expectedRoot` refuses the call when the workspace has switched to another folder meanwhile. */
export type DocumentStoreOptions = {
  expectedRoot?: string
}

export function isValidDocumentId(docId: string) {
  return typeof docId === 'string' && DOCUMENT_ID_PATTERN.test(docId)
}

function errorText(error: unknown) {
  return String((error as { message?: unknown } | null)?.message ?? error ?? '')
}

export function isDocumentIndexConflict(error: unknown) {
  return errorText(error).includes(DOCUMENT_INDEX_CONFLICT)
}

/** An append named a `seq` the store is not at: write a snapshot instead. */
export function isDocumentStoreConflict(error: unknown) {
  return errorText(error).includes(DOCUMENT_STORE_CONFLICT)
}

/** Another Kition writes this workspace's store (see `documentStoreStatus`). */
export function isDocumentStoreReadOnly(error: unknown) {
  return errorText(error).includes(DOCUMENT_STORE_READ_ONLY)
}

function checkDocumentId(docId: string) {
  if (!isValidDocumentId(docId)) throw new Error('invalid document id')
}

function checkMeta(docId: string, meta: KitReplicaMeta) {
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
function base64ToBytes(text: string, what = 'snapshot'): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error(`document store ${what} is not base64`)
  }
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function toEntry(payload: DocumentStorePayload | null | undefined): DocumentStoreEntry | null {
  if (!payload) return null
  const entry: DocumentStoreEntry = { meta: payload.meta, snapshot: base64ToBytes(payload.snapshot_base64) }
  if (Array.isArray(payload.changes_base64)) entry.changes = payload.changes_base64.map((change) => base64ToBytes(change, 'changes'))
  if (typeof payload.blobs_base64 === 'string') entry.blobs = base64ToBytes(payload.blobs_base64, 'blobs')
  if (typeof payload.seq === 'number') entry.seq = payload.seq
  if (payload.version !== undefined) entry.version = payload.version
  if (typeof payload.complete === 'boolean') entry.complete = payload.complete
  return entry
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
  return {
    meta: stored.meta,
    snapshot_base64: stored.snapshot_base64,
    changes_base64: Array.isArray(stored.changes_base64) ? stored.changes_base64.filter((change): change is string => typeof change === 'string') : [],
    seq: typeof stored.seq === 'number' ? stored.seq : 0,
    version: typeof stored.version === 'string' ? stored.version : null,
    complete: true,
    ...(typeof stored.blobs_base64 === 'string' ? { blobs_base64: stored.blobs_base64 } : {}),
  }
}

const browserHistoryStoragePrefix = 'kition.workspace.document-store.history.v1:'
const MAX_BROWSER_CHECKPOINTS = 200
/** Changes after which a write asks for a compaction, as the desktop store does. */
const COMPACT_AFTER_CHANGES = 64

type BrowserCheckpoint = DocumentCheckpoint & { blobs_base64?: string }

function readBrowserHistory(docId: string): BrowserCheckpoint[] {
  const stored = readJson(`${browserHistoryStoragePrefix}${docId}`)
  return Array.isArray(stored) ? (stored as BrowserCheckpoint[]).filter((checkpoint) => checkpoint && typeof checkpoint.id === 'string') : []
}

function recordBrowserCheckpoint(docId: string, input: DocumentCheckpointInput, at: { seq?: number; version?: string | null; blobs_base64?: string }): DocumentCheckpoint {
  const history = readBrowserHistory(docId)
  const version = input.version ?? at.version ?? undefined
  const last = history[history.length - 1]
  if (last && version && last.version === version) return publicCheckpoint(last)
  const checkpoint: BrowserCheckpoint = {
    id: crypto.randomUUID(),
    time: input.time ?? Date.now(),
    origin: input.origin,
    ...(input.author ? { author: input.author } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(version ? { version } : {}),
    ...(at.seq !== undefined ? { seq: at.seq } : {}),
    hasBlobs: typeof at.blobs_base64 === 'string',
    ...(typeof at.blobs_base64 === 'string' ? { blobs_base64: at.blobs_base64 } : {}),
  }
  history.push(checkpoint)
  while (history.length > MAX_BROWSER_CHECKPOINTS) {
    const index = history.slice(0, -1).findIndex((item) => item.origin === 'edit')
    history.splice(Math.max(index, 0), 1)
  }
  browserStorage().setItem(`${browserHistoryStoragePrefix}${docId}`, JSON.stringify(history))
  return publicCheckpoint(checkpoint)
}

function publicCheckpoint(checkpoint: BrowserCheckpoint): DocumentCheckpoint {
  const { blobs_base64: _blobs, ...rest } = checkpoint
  return rest
}

function writeBrowserEntry(docId: string, request: DocumentStoreWriteRequest): DocumentStoreWritten {
  const current = readBrowserEntry(docId)
  let next: DocumentStorePayload
  if (typeof request.changes_base64 === 'string') {
    if (!current || current.seq !== request.base_seq) throw new Error(DOCUMENT_STORE_CONFLICT)
    next = { ...current, meta: request.meta, changes_base64: [...(current.changes_base64 ?? []), request.changes_base64], seq: (current.seq ?? 0) + 1, version: request.version ?? null }
  } else {
    next = { meta: request.meta, snapshot_base64: request.snapshot_base64 ?? '', changes_base64: [], seq: (current?.seq ?? 0) + 1, version: request.version ?? null }
  }
  if (typeof request.blobs_base64 === 'string') next.blobs_base64 = request.blobs_base64
  else if (typeof request.snapshot_base64 === 'string') delete next.blobs_base64
  browserStorage().setItem(`${browserEntryStoragePrefix}${docId}`, JSON.stringify(next))
  if (request.lineage === 'new') browserStorage().removeItem(`${browserHistoryStoragePrefix}${docId}`)
  const written: DocumentStoreWritten = { seq: next.seq ?? 0, version: next.version ?? null, compact: (next.changes_base64?.length ?? 0) >= COMPACT_AFTER_CHANGES }
  if (request.checkpoint) written.checkpoint = recordBrowserCheckpoint(docId, request.checkpoint, next)
  return written
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

function checkpointRequest(input: DocumentCheckpointInput | undefined) {
  return input ? { checkpoint: { ...input } } : {}
}

async function sendWrite(docId: string, request: DocumentStoreWriteRequest, options?: DocumentStoreOptions): Promise<DocumentStoreWritten | null> {
  const bridge = getDesktopBridge()
  if (bridge?.WriteDocumentStore) {
    const written = await bridge.WriteDocumentStore({ ...request, ...rootRequest(options) })
    // A store before append support answers nothing.
    return written && typeof written === 'object' && typeof written.seq === 'number' ? written : null
  }
  checkBrowserRoot(options)
  return writeBrowserEntry(docId, request)
}

/**
 * Replaces the replica of `docId` with a whole snapshot (a first write, a compaction, or a replica of a new lineage);
 * meta, snapshot, and blobs land together or not at all. Answers the stored version, or `null` from a store that
 * cannot append.
 */
export async function writeDocumentStore(docId: string, entry: DocumentStoreEntry, options?: DocumentStoreWriteOptions): Promise<DocumentStoreWritten | null> {
  checkDocumentId(docId)
  checkMeta(docId, entry.meta)
  const request: DocumentStoreWriteRequest = { doc_id: docId, meta: entry.meta, snapshot_base64: uint8ArrayToBase64(entry.snapshot) }
  if (entry.blobs) request.blobs_base64 = uint8ArrayToBase64(entry.blobs)
  if (options?.version) request.version = options.version
  if (options?.lineage) request.lineage = options.lineage
  Object.assign(request, checkpointRequest(options?.checkpoint))
  return sendWrite(docId, request, options)
}

/**
 * Appends the changes since the stored `baseSeq` (KDM changes, with the meta that goes with them); fails with
 * `DOCUMENT_STORE_CONFLICT` (see `isDocumentStoreConflict`) when the store is elsewhere, and the caller then writes a
 * snapshot. `compact` in the answer asks for a snapshot next.
 */
export async function appendDocumentStore(
  docId: string,
  append: DocumentStoreAppend,
  options?: DocumentStoreWriteOptions,
): Promise<DocumentStoreWritten> {
  checkDocumentId(docId)
  checkMeta(docId, append.meta)
  const request: DocumentStoreWriteRequest = { doc_id: docId, meta: append.meta, changes_base64: uint8ArrayToBase64(append.changes), base_seq: append.baseSeq }
  if (append.blobs) request.blobs_base64 = uint8ArrayToBase64(append.blobs)
  if (options?.version) request.version = options.version
  Object.assign(request, checkpointRequest(options?.checkpoint))
  const written = await sendWrite(docId, request, options)
  if (!written) throw new Error(DOCUMENT_STORE_CONFLICT)
  return written
}

/** The stored meta and version of `docId` without its bytes, or `null`. */
export async function readDocumentStoreHead(docId: string, options?: DocumentStoreOptions): Promise<{ meta: KitReplicaMeta; seq: number | null; version: string | null } | null> {
  checkDocumentId(docId)
  const bridge = getDesktopBridge()
  if (bridge?.ReadDocumentStore) {
    const head = await bridge.ReadDocumentStore({ doc_id: docId, head_only: true, ...rootRequest(options) })
    if (!head) return null
    return { meta: head.meta, seq: typeof head.seq === 'number' ? head.seq : null, version: typeof head.version === 'string' ? head.version : null }
  }
  checkBrowserRoot(options)
  const stored = readBrowserEntry(docId)
  return stored ? { meta: stored.meta, seq: stored.seq ?? 0, version: stored.version ?? null } : null
}

/** The document's version history on this device, newest first. */
export async function readDocumentHistory(docId: string, options?: DocumentStoreOptions): Promise<DocumentCheckpoint[]> {
  checkDocumentId(docId)
  const bridge = getDesktopBridge()
  if (bridge?.ReadDocumentHistory) return (await bridge.ReadDocumentHistory({ doc_id: docId, ...rootRequest(options) }))?.checkpoints ?? []
  if (bridge?.ReadDocumentStore) return []
  checkBrowserRoot(options)
  return readBrowserHistory(docId).map(publicCheckpoint).reverse()
}

/** Records a checkpoint of `docId` (at its stored version, or `input.version`). */
export async function recordDocumentCheckpoint(docId: string, input: DocumentCheckpointInput, options?: DocumentStoreOptions): Promise<DocumentCheckpoint | null> {
  checkDocumentId(docId)
  const bridge = getDesktopBridge()
  if (bridge?.RecordDocumentCheckpoint) return (await bridge.RecordDocumentCheckpoint({ doc_id: docId, checkpoint: { ...input }, ...rootRequest(options) }))?.checkpoint ?? null
  if (bridge?.ReadDocumentStore) return null
  checkBrowserRoot(options)
  const stored = readBrowserEntry(docId)
  return recordBrowserCheckpoint(docId, input, stored ?? {})
}

/** The checkpoint `id` of `docId` with the blob bundle its replica named then, or `null`. */
export async function readDocumentCheckpoint(docId: string, id: string, options?: DocumentStoreOptions): Promise<{ checkpoint: DocumentCheckpoint; blobs?: Uint8Array } | null> {
  checkDocumentId(docId)
  const bridge = getDesktopBridge()
  let found: { checkpoint: DocumentCheckpoint; blobs_base64?: string } | null = null
  if (bridge?.ReadDocumentCheckpoint) {
    found = await bridge.ReadDocumentCheckpoint({ doc_id: docId, id, ...rootRequest(options) })
  } else if (!bridge?.ReadDocumentStore) {
    checkBrowserRoot(options)
    const checkpoint = readBrowserHistory(docId).find((item) => item.id === id)
    found = checkpoint ? { checkpoint: publicCheckpoint(checkpoint), ...(checkpoint.blobs_base64 ? { blobs_base64: checkpoint.blobs_base64 } : {}) } : null
  }
  if (!found) return null
  return { checkpoint: found.checkpoint, ...(typeof found.blobs_base64 === 'string' ? { blobs: base64ToBytes(found.blobs_base64, 'blobs') } : {}) }
}

/** Whether this window writes the workspace's store, or which Kition does. Without a desktop shell: writable. */
export async function documentStoreStatus(): Promise<DocumentStoreStatus> {
  const bridge = getDesktopBridge()
  if (bridge?.DocumentStoreStatus) return bridge.DocumentStoreStatus()
  return { writable: true, holder: null }
}

/** Calls `listener` when this window takes the store lock over or loses it; answers an unsubscribe. */
export function onDocumentStoreAccess(listener: (status: DocumentStoreStatus) => void): () => void {
  const bridge = getDesktopBridge()
  if (!bridge?.documentStoreAccessEvent || !bridge.EventsOn) return () => undefined
  const stop = bridge.EventsOn(bridge.documentStoreAccessEvent, (payload: DocumentStoreStatus) => listener(payload))
  return typeof stop === 'function' ? stop : () => undefined
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
  browserStorage().removeItem(`${browserHistoryStoragePrefix}${docId}`)
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
