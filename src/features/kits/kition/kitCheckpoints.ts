/**
 * Checkpoints and view state for kits (Kit UI protocol sections 7m and 7n, capabilities `checkpoints` and
 * `view-state`), over Kition's document store: the handlers `mountKit` takes as `checkpoints` and `viewState`, keyed by
 * the document's path. The store names a document by its id in the document index, so both follow the file's renames
 * and moves. Checkpoints live in the workspace's `.kition/docs/<docId>/history.json`; view state in the app's own data,
 * per person and device, never in the workspace. The store's refusals reach the kit as the protocol's reasons.
 */
import { KitRpcError } from '@kition/sdk/protocol'
import { bindDocumentId } from '@/lib/docstore/documentIndex'
import {
  deleteKitCheckpoint,
  findKitCheckpoint,
  listKitCheckpoints,
  readDocumentIndex,
  readDocumentStore,
  readKitCheckpoint,
  readViewState,
  updateKitCheckpoint,
  writeViewState,
  type DocumentCheckpointInput,
  type KitStoreCheckpoint,
} from '@/services/desktop'

/** The store's errors and the protocol reasons they are (`error.data.reason` of a `-32000` refusal). */
const REASONS: ReadonlyArray<readonly [string, string]> = [
  ['DOCUMENT_CHECKPOINT_NOT_FOUND', 'not-found'],
  ['DOCUMENT_CHECKPOINT_HISTORY_MISSING', 'history-missing'],
  ['DOCUMENT_CHECKPOINT_TOO_LONG', 'too-long'],
  ['DOCUMENT_CHECKPOINT_READ_ONLY', 'read-only'],
  // Another Kition writes this workspace's store.
  ['DOCUMENT_STORE_READ_ONLY', 'read-only'],
  ['VIEW_STATE_TOO_LARGE', 'too-large'],
]

function refusal(reason: string, message: string) {
  return new KitRpcError(-32000, message, { reason })
}

/** A store error as the kit should see it: a protocol refusal when the store named one, the error itself otherwise. */
export function kitStoreError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error)
  const known = REASONS.find(([code]) => message.includes(code))
  return known ? refusal(known[1], message) : error
}

async function refused<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw kitStoreError(error)
  }
}

/** The document id of the file at `path`, or `null` when the store holds nothing of it. */
async function docIdOf(path: string): Promise<string | null> {
  return (await readDocumentIndex()).entries[path] ?? null
}

async function knownDocId(path: string, id: string): Promise<string> {
  const docId = await docIdOf(path)
  if (!docId) throw refusal('not-found', `no checkpoint ${id}`)
  return docId
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

function base64Bytes(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const loadReplicaBytes = () => import('@/lib/replicaHistory/replicaBytes')

/**
 * What a replica write records: the kit's own checkpoint (origin `kit`, with its label and description) when it asked
 * for one, the host's save otherwise.
 */
export function replicaWriteCheckpoint(asked: { label?: string; description?: string; author?: string } | undefined, by: 'agent' | 'person'): DocumentCheckpointInput {
  if (asked) {
    return {
      origin: 'kit',
      author: asked.author ?? (by === 'agent' ? 'agent:kition' : 'user:local'),
      ...(asked.label !== undefined ? { label: asked.label } : {}),
      ...(asked.description !== undefined ? { description: asked.description } : {}),
    }
  }
  return { origin: by === 'agent' ? 'agent' : 'save', author: by === 'agent' ? 'agent:kition' : 'user:local' }
}

/** `checkpoints` of `mountKit`'s handlers. */
export const KITION_CHECKPOINTS = {
  find: ({ path, id }: { path: string; id: string }): Promise<KitStoreCheckpoint | null> =>
    refused(async () => {
      const docId = await docIdOf(path)
      return docId ? findKitCheckpoint(docId, id) : null
    }),
  list: ({ path, labelled, before, limit }: { path: string; labelled?: boolean; before?: string; limit?: number }) =>
    refused(async () => {
      const docId = await docIdOf(path)
      if (!docId) {
        if (before) throw refusal('not-found', `no checkpoint ${before}`)
        return { checkpoints: [] as KitStoreCheckpoint[], more: false }
      }
      return listKitCheckpoints(docId, { ...(labelled ? { labelled } : {}), ...(before ? { before } : {}), ...(limit ? { limit } : {}) })
    }),
  update: ({ path, id, label, description }: { path: string; id: string; label?: string; description?: string }) =>
    refused(async () => {
      const docId = await knownDocId(path, id)
      const edit = { ...(label !== undefined ? { label } : {}), ...(description !== undefined ? { description } : {}) }
      return { checkpoint: await updateKitCheckpoint(docId, id, edit) }
    }),
  delete: ({ path, id }: { path: string; id: string }) =>
    refused(async () => {
      await deleteKitCheckpoint(await knownDocId(path, id), id)
    }),
  /**
   * The blobs the version needs; with `state`, also the replica's snapshot at that version, from the stored replica
   * (`history-missing` when it does not reach it).
   */
  read: ({ path, id, state }: { path: string; id: string; state?: boolean }) =>
    refused(async () => {
      const docId = await knownDocId(path, id)
      const { checkpoint, blobs } = await readKitCheckpoint(docId, id)
      if (!state) return { checkpoint, blobs: buffer(blobs) }
      const entry = await readDocumentStore(docId)
      const bytes = await loadReplicaBytes()
      const full = entry ? [entry.snapshot, ...(entry.changes ?? [])] : []
      const version = base64Bytes(checkpoint.version)
      if (!entry || entry.complete === false || !bytes.holdsVersion(full, version)) {
        throw refusal('history-missing', `the stored replica no longer reaches checkpoint ${id}'s version`)
      }
      return { checkpoint, blobs: buffer(blobs), snapshot: buffer(bytes.stateAt(full, version)) }
    }),
}

/** `viewState` of `mountKit`'s handlers. */
export const KITION_VIEW_STATE = {
  read: ({ path }: { path: string }): Promise<{ state: Record<string, unknown> | null; bytes?: ArrayBuffer }> =>
    refused(async () => {
      const docId = await docIdOf(path)
      if (!docId) return { state: null }
      const kept = await readViewState(docId)
      return kept.state && kept.bytes ? { state: kept.state, bytes: buffer(kept.bytes) } : { state: kept.state }
    }),
  /** Replaces it whole; `state: null` deletes it. A document the store does not know yet gets its id here. */
  write: ({ path, state, bytes }: { path: string; state: Record<string, unknown> | null; bytes?: ArrayBuffer }) =>
    refused(async () => {
      const docId = state === null ? await docIdOf(path) : await bindDocumentId(path, () => crypto.randomUUID())
      if (!docId) return
      await writeViewState(docId, state, bytes ? new Uint8Array(bytes) : undefined)
    }),
}
