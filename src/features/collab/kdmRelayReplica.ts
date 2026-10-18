/**
 * The relay side (`RelayReplica`, `@/lib/sync`) of a document whose KDM replica lives in this
 * page: an open board (`OpenBoard`) or Markdown document (`OpenMarkdownDocument`). Exports come
 * straight from the replica; imports go through the editor's own path for changes made elsewhere
 * (the one merges of the file take), so the editor shows them, they are no undo step for the
 * person, and the editor's session saves them. No blobs: images stay workspace files referenced
 * by path. Loaded only for a document that is relayed, as it carries the KDM.
 */
import { Version, type Replica } from '@/lib/kdm'
import type { RelayReplica } from '@/lib/sync'

/** An editor holding a KDM replica in this page. */
export type KdmReplicaHost = {
  replica: () => Replica
  importChanges: (changes: Uint8Array) => void
  /** Calls `listener` after the document may have changed. */
  subscribe: (listener: () => void) => () => void
}

function buffer(view: Uint8Array): ArrayBuffer {
  return view.slice().buffer as ArrayBuffer
}

export function kdmRelayReplica(host: KdmReplicaHost): RelayReplica {
  return {
    version: async () => buffer(host.replica().version().encode()),
    exportChanges: async (since) => {
      const from = since.byteLength ? Version.decode(new Uint8Array(since)) : Version.empty()
      return { changes: buffer(host.replica().exportChanges(from)), blobs: new ArrayBuffer(0) }
    },
    importChanges: async (changes) => {
      host.importChanges(new Uint8Array(changes))
    },
    onChanged: (listener) => {
      // The editor notifies on every change it shows (selection, live gestures too): only a new
      // replica version is a change to relay.
      let last = host.replica().version()
      return host.subscribe(() => {
        const version = host.replica().version()
        if (version.equals(last)) return
        last = version
        listener(buffer(version.encode()))
      })
    },
  }
}
