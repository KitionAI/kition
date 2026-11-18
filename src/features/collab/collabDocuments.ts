/**
 * Every open document co-editing can follow: the documents of kit editors that serve the `replica`
 * capability (the Note and Table kits among them). Each is offered as a
 * `CollabDocument` whose relay side (`CollabReplica`) is only made when co-editing needs it
 * (`connect`), so a window that does not co-edit never touches a replica.
 */
import { followKitConnections, mountedKitDocument, type MountedKitDocument } from '@/features/kits/public'
import type { RelayReplica } from '@/lib/sync'

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

/**
 * Hears every co-editable document open now and every one opened later; the listener may answer
 * a cleanup for when that document closes (or when this subscription ends). Answers an unsubscribe.
 */
export function followCollabDocuments(listener: Listener) {
  return followKitConnections((document) => {
    const followed = kitDocument(document)
    return followed ? listener(followed) : undefined
  })
}

/** The co-editable document open at `path`, if any. */
export function findCollabDocument(path: string): CollabDocument | null {
  const kit = mountedKitDocument(path)
  return kit ? kitDocument(kit) : null
}
