/**
 * A document's version history: the checkpoints this device recorded in the document store, and, for a document
 * co-edited in a Kition Pro room, the server's history when it is reachable. A checkpoint names a replica version; the
 * document as of it is read from the open replica's own history (`stateAt`) and restored as one new change
 * (`revertTo`), never by replacing the document, so concurrent edits of others are kept.
 */
import { readRoom, syncClient } from '@/features/collab/public'
import type { Checkpoint as ServerCheckpoint } from '@/lib/sync'
import { readDocumentCheckpoint, readDocumentHistory, readDocumentIndex, recordDocumentCheckpoint, type DocumentCheckpoint } from '@/services/desktop'
import type { HistoryDocument } from './historyDocuments'

const loadBytes = () => import('@/lib/replicaHistory/replicaBytes')

export type DeviceEntry = DocumentCheckpoint & {
  source: 'device'
  /** The open replica holds this version (a checkpoint of a replica made anew since does not). */
  available: boolean
}

export type ServerEntry = ServerCheckpoint & { source: 'server'; id: string }

export type HistoryEntry = DeviceEntry | ServerEntry

/** The document as of a checkpoint: the bytes its kit opens. */
export type HistoryPreview = { snapshot: Uint8Array; blobs: Uint8Array }

/** The document's id in the store (its history's), or `null` when the store has none for its path. */
async function storeIdFor(path: string): Promise<string | null> {
  return (await readDocumentIndex()).entries[path] ?? null
}

/** This device's checkpoints of `document`, newest first. */
export async function loadDeviceHistory(document: HistoryDocument): Promise<DeviceEntry[]> {
  const storeId = await storeIdFor(document.path)
  if (!storeId) return []
  const [checkpoints, full, bytes] = await Promise.all([readDocumentHistory(storeId), document.full(), loadBytes()])
  return checkpoints.map((checkpoint) => ({
    ...checkpoint,
    source: 'device' as const,
    available: Boolean(checkpoint.version) && bytes.holdsVersion([full.changes], bytes.fromHex(checkpoint.version ?? '')),
  }))
}

/** The server's history of `document`, newest first, when it is co-edited and the server is reachable; else `null`. */
export async function loadServerHistory(document: HistoryDocument): Promise<ServerEntry[] | null> {
  const docId = await document.replicaDocId()
  if (!docId || !readRoom(docId)) return null
  const client = await syncClient()
  if (!client || client.state !== 'online') return null
  const { checkpoints } = await client.history(docId, { limit: 50 })
  return checkpoints.map((checkpoint) => ({ ...checkpoint, source: 'server' as const, id: `server-${checkpoint.seq}` }))
}

/** The blobs a kit needs to show the device checkpoint `entry`: those the store kept with it, else today's. */
async function blobsAt(document: HistoryDocument, entry: DeviceEntry, current: Uint8Array): Promise<Uint8Array> {
  if (!entry.hasBlobs) return current
  const storeId = await storeIdFor(document.path)
  const kept = storeId ? await readDocumentCheckpoint(storeId, entry.id) : null
  return kept?.blobs ?? current
}

/** The document as of `entry`. */
export async function previewOf(document: HistoryDocument, entry: HistoryEntry): Promise<HistoryPreview> {
  const full = await document.full()
  if (entry.source === 'server') {
    const docId = await document.replicaDocId()
    const client = await syncClient()
    if (!docId || !client) throw new Error('the sync server cannot be reached')
    const { snapshot } = await client.historyAt(docId, entry.seq)
    return { snapshot, blobs: full.blobs }
  }
  const bytes = await loadBytes()
  const snapshot = bytes.stateAt([full.changes], bytes.fromHex(entry.version ?? ''))
  return { snapshot, blobs: await blobsAt(document, entry, full.blobs) }
}

/** Brings `document` back to the version `target` holds as one new change; answers whether it changed. */
async function revertDocument(document: HistoryDocument, target: Uint8Array, blobs?: Uint8Array): Promise<boolean> {
  const [full, bytes] = await Promise.all([document.full(), loadBytes()])
  const change = bytes.revertTo([full.changes], target)
  if (!change) return false
  await document.importChanges(change, blobs ?? full.blobs)
  return true
}

/**
 * Restores `entry` as one new change. A server checkpoint is restored by the server (every member, this one too,
 * receives the change). A device checkpoint answers `undo`, which brings the document back to how it was before. Records where the document was before, and the
 * restore, in its history.
 */
export async function restoreEntry(document: HistoryDocument, entry: HistoryEntry, label: string): Promise<{ changed: boolean; undo?: () => Promise<void> }> {
  if (entry.source === 'server') {
    const docId = await document.replicaDocId()
    const client = await syncClient()
    if (!docId || !client) throw new Error('the sync server cannot be reached')
    const restored = await client.restore(docId, entry.seq)
    return { changed: restored.seq !== null }
  }
  const bytes = await loadBytes()
  const storeId = await storeIdFor(document.path)
  const before = await document.version()
  const record = (origin: string, version: Uint8Array, text?: string) =>
    storeId ? recordDocumentCheckpoint(storeId, { origin, author: 'user:local', version: bytes.toHex(version), ...(text ? { label: text } : {}) }).catch(() => null) : Promise.resolve(null)
  await record('before-restore', before)
  const full = await document.full()
  const changed = await revertDocument(document, bytes.fromHex(entry.version ?? ''), await blobsAt(document, entry, full.blobs))
  if (!changed) return { changed }
  await record('restore', await document.version(), label)
  return { changed, undo: async () => void (await revertDocument(document, before)) }
}
