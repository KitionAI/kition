/**
 * Every open document co-editing can follow, whatever edits it: kit documents (a kit editor that
 * serves the `replica` capability, the Table kit among them), boards, and Markdown documents. Each is offered as a
 * `CollabDocument` whose relay side (`CollabReplica`) is only made when co-editing needs it
 * (`connect`), so a window that does not co-edit never touches a replica.
 */
import { findOpenMarkdownDocument, followOpenMarkdownDocuments, type OpenMarkdownDocument } from '@/features/document/public'
import { followKitConnections, mountedKitDocument, type MountedKitDocument } from '@/features/kits/public'
import { findOpenBoard, followOpenBoards, type OpenBoard } from '@/features/whiteboard/public'
import type { RelayReplica } from '@/lib/sync'

/** The kit ids of the documents Kition edits itself (their KDM schemas' `kit`). */
export const HOST_KITS = { board: 'kit.board', document: 'kit.document' } as const

/** A document's relay side, and what sharing it needs. */
export type CollabReplica = RelayReplica & {
  /** The replica's KDM document id (its room's id); `null` when it has none. */
  docId: () => Promise<string | null>
  /** Saves the document, so that its file carries the replica as it is now. */
  save: () => Promise<void>
  /** Ends what the replica side follows; called when the relay stops. */
  dispose: () => void
  /**
   * The schema version the replica reads, and the newest one its changes were written under (Kit
   * Standard 2.0 rule M5a; `null` when none records one), for a replica that can tell them.
   */
  schema?: () => { reads: number; newestAuthor: number | null }
}

export type CollabDocument = {
  /** The workspace file. */
  path: string
  /** The kit the document belongs to: the room's `kit`, and how a shared copy is opened. */
  kit: string
  connect: () => Promise<CollabReplica>
}

type Listener = (document: CollabDocument) => (() => void) | void

function kitDocument(document: MountedKitDocument): CollabDocument | null {
  const { connection } = document
  if (!connection.capabilities.includes('replica')) return null
  return {
    path: document.path,
    kit: document.kitId,
    connect: async () => ({
      version: () => connection.replica.version(),
      exportChanges: (since) => connection.replica.exportChanges(since),
      importChanges: (changes, blobs) => connection.replica.importChanges(changes, blobs),
      onChanged: (listener) => connection.replica.onChanged(listener),
      docId: () => connection.replica.info(),
      save: async () => void (await connection.save()),
      dispose: () => undefined,
    }),
  }
}

/** A board or Markdown document: its replica lives in this page. */
function pageDocument(open: OpenBoard | OpenMarkdownDocument, kit: string): CollabDocument {
  return {
    path: open.path,
    kit,
    connect: async () => {
      const { kdmRelayReplica } = await import('./kdmRelayReplica')
      return {
        ...kdmRelayReplica(open),
        docId: async () => open.replica().docId,
        save: open.save,
        dispose: () => undefined,
        schema: () => ({ reads: open.replica().schema.schemaVersion, newestAuthor: open.replica().authorSchemaVersion() }),
      }
    },
  }
}

/**
 * Hears every co-editable document open now and every one opened later; the listener may answer
 * a cleanup for when that document closes (or when this subscription ends). Answers an unsubscribe.
 */
export function followCollabDocuments(listener: Listener) {
  const unfollows = [
    followKitConnections((document) => {
      const followed = kitDocument(document)
      return followed ? listener(followed) : undefined
    }),
    followOpenBoards((board) => listener(pageDocument(board, HOST_KITS.board))),
    followOpenMarkdownDocuments((document) => listener(pageDocument(document, HOST_KITS.document))),
  ]
  return () => {
    for (const unfollow of unfollows) unfollow()
  }
}

/** The co-editable document open at `path`, if any. */
export function findCollabDocument(path: string): CollabDocument | null {
  const kit = mountedKitDocument(path)
  if (kit) return kitDocument(kit)
  const board = findOpenBoard(path)
  if (board) return pageDocument(board, HOST_KITS.board)
  const document = findOpenMarkdownDocument(path)
  return document ? pageDocument(document, HOST_KITS.document) : null
}
