/**
 * The open documents the version history works on, whatever edits them: a Markdown document or a board (their KDM
 * replica lives in this page) and a kit document (its replica lives in the kit's engine, reached over the Kit UI
 * protocol). Each answers its whole replica with its history (so any version it had can be shown and restored), takes
 * a restoring change like any change made elsewhere, and names its KDM document id (a sync room's).
 */
import { findOpenMarkdownDocument } from '@/features/document/public'
import { mountedKitDocument } from '@/features/kits/public'
import { findOpenBoard } from '@/features/whiteboard/public'
import { Version } from '@/lib/kdm'

type HistoryKind = 'document' | 'board' | 'kit'

export type HistoryDocument = {
  path: string
  kind: HistoryKind
  /** The kit the document belongs to (`kit.document` and `kit.board` for Kition's own). */
  kitId: string
  /** The whole replica, history included (a change export from nothing), and its blob bundle. */
  full: () => Promise<{ changes: Uint8Array; blobs: Uint8Array }>
  /** The replica's version now (an encoded version vector). */
  version: () => Promise<Uint8Array>
  /** Imports `changes` (with the blobs they need) like a change made elsewhere. */
  importChanges: (changes: Uint8Array, blobs: Uint8Array) => Promise<void>
  /** Restores a Markdown document's text as one undo step of the person's; absent for other kinds. */
  restoreText?: (text: string, label?: string) => boolean
  /** The replica's KDM document id (its sync room's), or `null`. */
  replicaDocId: () => Promise<string | null>
}

const bytes = (buffer: ArrayBuffer) => new Uint8Array(buffer)
const buffer = (view: Uint8Array) => view.slice().buffer as ArrayBuffer

/** The open document at `path` the version history can work on, or `null`. */
export function historyDocumentFor(path: string): HistoryDocument | null {
  const kit = mountedKitDocument(path)
  if (kit) {
    const { connection } = kit
    if (!connection.capabilities.includes('replica')) return null
    return {
      path,
      kind: 'kit',
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
  const markdown = findOpenMarkdownDocument(path)
  const board = markdown ? null : findOpenBoard(path)
  const open = markdown ?? board
  if (!open) return null
  return {
    path,
    kind: markdown ? 'document' : 'board',
    kitId: markdown ? 'kit.document' : 'kit.board',
    full: async () => ({ changes: open.replica().exportChanges(Version.empty()), blobs: new Uint8Array() }),
    version: async () => open.replica().version().encode(),
    importChanges: async (changes) => open.importChanges(changes),
    ...(markdown ? { restoreText: (text: string, label?: string) => markdown.restoreText(text, label) } : {}),
    replicaDocId: async () => open.replica().docId,
  }
}
