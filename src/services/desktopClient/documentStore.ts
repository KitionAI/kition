/**
 * The private store of the replicas kit editors keep for their files (`.kition/docs/` in the workspace): each
 * document's last written snapshot (opaque bytes), the version it holds and its blobs, its checkpoints on this device,
 * and the index from workspace paths to document ids. The desktop shell keeps it on disk, written by one Kition at a
 * time (the store lock); without a desktop bridge the browser preview keeps the snapshots (not the checkpoints) in
 * localStorage.
 */
import {
  type DocumentCheckpointInput,
  type DocumentIndexPayload,
  type DocumentStorePayload,
  type DocumentStoreStatus,
  type DocumentStoreWriteRequest,
  type DocumentStoreWritten,
  type KitCheckpointQuery,
  type KitReplicaMeta,
  getDesktopBridge,
} from './bridge'
import type { KitCheckpoint } from '@kition/sdk/protocol'
import { normalizeWorkspaceDocumentPath } from './workspaceDocuments'
import { uint8ArrayToBase64 } from './workspaceFiles'

export type { DocumentCheckpointInput, DocumentStoreStatus, DocumentStoreWritten, KitReplicaMeta } from './bridge'

/** The error a guarded index write fails with when another writer changed the index since it was read. */
export const DOCUMENT_INDEX_CONFLICT = 'DOCUMENT_INDEX_CONFLICT'
/** The error every store write fails with in a Kition that does not hold the store lock. */
export const DOCUMENT_STORE_READ_ONLY = 'DOCUMENT_STORE_READ_ONLY'
const WORKSPACE_CHANGED = 'DESIGN_WORKSPACE_CHANGED'
const BROWSER_WORKSPACE_ROOT = 'browser-local-workspace'
const browserIndexStorageKey = 'kition.workspace.document-store.index.v1'
const browserEntryStoragePrefix = 'kition.workspace.document-store.entry.v1:'
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/

/** A stored replica: the snapshot as the kit wrote it, the version it holds (base64), and its blob bundle. */
export type DocumentStoreEntry = {
  meta: KitReplicaMeta
  snapshot: Uint8Array
  version: string
  blobs?: Uint8Array
}

/** `expectedRoot` refuses the call when the workspace has switched to another folder meanwhile. */
export type DocumentStoreOptions = {
  expectedRoot?: string
}

/** What to record in the history with a write. */
export type DocumentStoreWriteOptions = DocumentStoreOptions & {
  checkpoint?: DocumentCheckpointInput
}

export type DocumentIndex = DocumentIndexPayload

export function isValidDocumentId(docId: string) {
  return typeof docId === 'string' && DOCUMENT_ID_PATTERN.test(docId)
}

function errorText(error: unknown) {
  return String((error as { message?: unknown } | null)?.message ?? error ?? '')
}

export function isDocumentIndexConflict(error: unknown) {
  return errorText(error).includes(DOCUMENT_INDEX_CONFLICT)
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
  const entry: DocumentStoreEntry = { meta: payload.meta, snapshot: base64ToBytes(payload.snapshot_base64), version: typeof payload.version === 'string' ? payload.version : '' }
  if (typeof payload.blobs_base64 === 'string') entry.blobs = base64ToBytes(payload.blobs_base64, 'blobs')
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
  if (!stored || typeof stored.snapshot_base64 !== 'string' || typeof stored.version !== 'string' || stored.meta?.docId !== docId) return null
  return {
    meta: stored.meta,
    snapshot_base64: stored.snapshot_base64,
    version: stored.version,
    ...(typeof stored.blobs_base64 === 'string' ? { blobs_base64: stored.blobs_base64 } : {}),
  }
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

/** The stored replica of `docId`, or `null` when there is none (or it is damaged, or of an older layout). */
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

/**
 * Replaces the replica of `docId` whole: meta, snapshot, version, and blobs land together or not at all; with
 * `checkpoint`, records a checkpoint keeping this snapshot in the same step. Answers the stored version and the
 * checkpoint as a kit sees it (the browser preview keeps no checkpoints).
 */
export async function writeDocumentStore(docId: string, entry: DocumentStoreEntry, options?: DocumentStoreWriteOptions): Promise<DocumentStoreWritten> {
  checkDocumentId(docId)
  checkMeta(docId, entry.meta)
  const request: DocumentStoreWriteRequest = { doc_id: docId, meta: entry.meta, snapshot_base64: uint8ArrayToBase64(entry.snapshot), version: entry.version }
  if (entry.blobs) request.blobs_base64 = uint8ArrayToBase64(entry.blobs)
  if (options?.checkpoint) request.checkpoint = { ...options.checkpoint }
  const bridge = getDesktopBridge()
  if (bridge?.WriteDocumentStore) return bridge.WriteDocumentStore({ ...request, ...rootRequest(options) })
  checkBrowserRoot(options)
  const stored: DocumentStorePayload = { meta: request.meta, snapshot_base64: request.snapshot_base64, version: request.version, ...(typeof request.blobs_base64 === 'string' ? { blobs_base64: request.blobs_base64 } : {}) }
  browserStorage().setItem(`${browserEntryStoragePrefix}${docId}`, JSON.stringify(stored))
  return { version: request.version }
}

/** The document's checkpoints on this device, newest first, as a kit sees them (none in the browser preview). */
export async function readDocumentHistory(docId: string, options?: DocumentStoreOptions): Promise<KitCheckpoint[]> {
  checkDocumentId(docId)
  const bridge = getDesktopBridge()
  if (bridge?.ReadDocumentHistory) return (await bridge.ReadDocumentHistory({ doc_id: docId, ...rootRequest(options) }))?.checkpoints ?? []
  return []
}

// --- Checkpoints and view state for kits (Kit UI protocol sections 7m, 7n) ----
// The desktop shell serves them; without it (the browser preview) a kit is not offered them.

/** Whether the desktop shell serves kits' checkpoints. */
export function servesKitCheckpoints(): boolean {
  const bridge = getDesktopBridge()
  return Boolean(bridge?.ListKitCheckpoints && bridge.FindKitCheckpoint && bridge.UpdateKitCheckpoint && bridge.DeleteKitCheckpoint && bridge.ReadKitCheckpoint)
}

/** Whether the desktop shell keeps kits' view state. */
export function servesViewState(): boolean {
  const bridge = getDesktopBridge()
  return Boolean(bridge?.ReadViewState && bridge.WriteViewState)
}

function kitBridge() {
  const bridge = getDesktopBridge()
  if (!bridge || !servesKitCheckpoints() || !servesViewState()) throw new Error('kit checkpoints and view state need the desktop shell')
  return bridge as Required<Pick<NonNullable<typeof bridge>, 'ListKitCheckpoints' | 'FindKitCheckpoint' | 'UpdateKitCheckpoint' | 'DeleteKitCheckpoint' | 'ReadKitCheckpoint' | 'ReadViewState' | 'WriteViewState'>>
}

/** One page of `docId`'s checkpoints as a kit sees them, newest first; an unknown `before` fails with `DOCUMENT_CHECKPOINT_NOT_FOUND`. */
export async function listKitCheckpoints(docId: string, query: KitCheckpointQuery, options?: DocumentStoreOptions): Promise<{ checkpoints: KitCheckpoint[]; more: boolean }> {
  checkDocumentId(docId)
  const answer = await kitBridge().ListKitCheckpoints({ doc_id: docId, ...query, ...rootRequest(options) })
  return { checkpoints: answer?.checkpoints ?? [], more: answer?.more === true }
}

/** The checkpoint `id` of `docId`, or `null`. */
export async function findKitCheckpoint(docId: string, id: string, options?: DocumentStoreOptions): Promise<KitCheckpoint | null> {
  checkDocumentId(docId)
  return (await kitBridge().FindKitCheckpoint({ doc_id: docId, id, ...rootRequest(options) })) ?? null
}

/** Renames the kit's checkpoint `id` (an absent field is kept, an empty one removed). */
export async function updateKitCheckpoint(docId: string, id: string, edit: { label?: string; description?: string }, options?: DocumentStoreOptions): Promise<KitCheckpoint> {
  checkDocumentId(docId)
  return (await kitBridge().UpdateKitCheckpoint({ doc_id: docId, id, ...edit, ...rootRequest(options) })).checkpoint
}

/** Deletes the kit's checkpoint `id`. */
export async function deleteKitCheckpoint(docId: string, id: string, options?: DocumentStoreOptions): Promise<void> {
  checkDocumentId(docId)
  await kitBridge().DeleteKitCheckpoint({ doc_id: docId, id, ...rootRequest(options) })
}

/** The checkpoint `id`, the snapshot it keeps, and the blobs the replica named then. */
export async function readKitCheckpoint(docId: string, id: string, options?: DocumentStoreOptions): Promise<{ checkpoint: KitCheckpoint; snapshot: Uint8Array; blobs: Uint8Array }> {
  checkDocumentId(docId)
  const answer = await kitBridge().ReadKitCheckpoint({ doc_id: docId, id, ...rootRequest(options) })
  return { checkpoint: answer.checkpoint, snapshot: base64ToBytes(answer.snapshot_base64 ?? ''), blobs: base64ToBytes(answer.blobs_base64 ?? '', 'blobs') }
}

/** `docId`'s view state on this device (`state: null` for none or a damaged one). */
export async function readViewState(docId: string, options?: DocumentStoreOptions): Promise<{ state: Record<string, unknown> | null; bytes?: Uint8Array }> {
  checkDocumentId(docId)
  const answer = await kitBridge().ReadViewState({ doc_id: docId, ...rootRequest(options) })
  const state = answer?.state && typeof answer.state === 'object' && !Array.isArray(answer.state) ? answer.state : null
  if (!state) return { state: null }
  return typeof answer.bytes_base64 === 'string' ? { state, bytes: base64ToBytes(answer.bytes_base64, 'view state bytes') } : { state }
}

/** Replaces `docId`'s view state whole; `state: null` deletes it. A larger one than the limits fails with `VIEW_STATE_TOO_LARGE`. */
export async function writeViewState(docId: string, state: Record<string, unknown> | null, bytes?: Uint8Array, options?: DocumentStoreOptions): Promise<void> {
  checkDocumentId(docId)
  await kitBridge().WriteViewState({ doc_id: docId, state, ...(state && bytes ? { bytes_base64: uint8ArrayToBase64(bytes) } : {}), ...rootRequest(options) })
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
