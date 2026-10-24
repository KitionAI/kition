/**
 * The open documents the version history works on: kit documents (notes among them), whose replica lives in the
 * kit's engine, reached over the Kit UI protocol. Each answers its whole replica with its history (so any version it had can be shown and restored), takes
 * a restoring change like any change made elsewhere, and names its KDM document id (a sync room's).
 */
import { mountedKitDocument } from '@/features/kits/public'

export type HistoryDocument = {
  path: string
  /** The kit the document belongs to. */
  kitId: string
  /** The whole replica, history included (a change export from nothing), and its blob bundle. */
  full: () => Promise<{ changes: Uint8Array; blobs: Uint8Array }>
  /** The replica's version now (an encoded version vector). */
  version: () => Promise<Uint8Array>
  /** Imports `changes` (with the blobs they need) like a change made elsewhere. */
  importChanges: (changes: Uint8Array, blobs: Uint8Array) => Promise<void>
  /** The replica's KDM document id (its sync room's), or `null`. */
  replicaDocId: () => Promise<string | null>
}

const bytes = (buffer: ArrayBuffer) => new Uint8Array(buffer)
const buffer = (view: Uint8Array) => view.slice().buffer as ArrayBuffer

/** The open document at `path` the version history can work on, or `null`. */
export function historyDocumentFor(path: string): HistoryDocument | null {
  const kit = mountedKitDocument(path)
  if (!kit) return null
  const { connection } = kit
  if (!connection.capabilities.includes('replica')) return null
  return {
    path,
    kitId: kit.kitId,
    full: async () => {
      const exported = await connection.replica.exportChanges(new ArrayBuffer(0))
      return { changes: bytes(exported.changes), blobs: bytes(exported.blobs) }
    },
    version: async () => bytes(await connection.replica.version()),
    importChanges: async (changes, blobs) => {
      await connection.replica.importChanges(buffer(changes), buffer(blobs))
    },
    replicaDocId: () => connection.replica.info().catch(() => null),
  }
}
