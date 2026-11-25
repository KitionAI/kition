/**
 * The open documents the version history works on: kit documents, whose replica lives in the kit's engine, reached
 * over the Kit UI protocol. A past version is restored by the kit (`replica/restore`): it writes that state over the
 * document as one change, one step of the person's undo. Kition never reads the replica's bytes.
 */
import { mountedKitDocument } from '@/features/kits/public'

export type HistoryDocument = {
  path: string
  /** The kit the document belongs to. */
  kitId: string
  /** Writes the state `snapshot` holds (a checkpoint's) over the document as one change of the person's. */
  restore: (snapshot: Uint8Array, blobs: Uint8Array, label: string) => Promise<void>
}

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
    restore: async (snapshot, blobs, label) => {
      await connection.replica.restore(buffer(snapshot), buffer(blobs), { kind: 'person', principal: 'user:local', label })
    },
  }
}
