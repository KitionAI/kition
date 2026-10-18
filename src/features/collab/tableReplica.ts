/**
 * A `.kitable` file's KDM replica as a co-editing `RelayReplica` (`@/lib/sync`): the runtime
 * holds the replica (the file's shared handle), so every call goes over the replica routes
 * (`src/api/dataDocumentsReplica.ts`), and `onChanged` follows the runtime's
 * `table/replica-changed` notifications for this file, sent after every local transaction.
 *
 * Tables carry no blobs (attachments stay workspace files referenced by path): exports answer an
 * empty blob section, and imports ignore theirs. An import has the origin `import`, so it is no
 * undo step, and the runtime publishes it as `table/changed`, which refreshes open editors.
 */
import { exportTableReplica, getTableReplicaVersion, importTableReplica } from '@/api/dataDocumentsReplica'
import { onTableReplicaChanged } from '@/services/runtimeBridge'
import type { RelayReplica } from '@/lib/sync'

/** Workspace-relative path in the runtime's form: `/` separators, no leading `./` or `/`. */
function normalizePath(path: string) {
  return path.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '')
}

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK))
  }
  return btoa(binary)
}

function fromBase64(text: string): ArrayBuffer {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

/** The relay replica of the `.kitable` file at the workspace-relative `path`; `dispose` ends its subscriptions. */
export function createTableRelayReplica(path: string): RelayReplica & { dispose: () => void } {
  const documentPath = normalizePath(path)
  const subscriptions = new Set<() => void>()
  let disposed = false

  return {
    version: async () => fromBase64((await getTableReplicaVersion({ path: documentPath })).version),
    exportChanges: async (since) => {
      const exported = await exportTableReplica({ path: documentPath, since: toBase64(since) })
      return { changes: fromBase64(exported.changes), blobs: new ArrayBuffer(0) }
    },
    importChanges: (changes, _blobs) => importTableReplica({ path: documentPath, changes: toBase64(changes) }),
    onChanged(listener) {
      if (disposed) return () => undefined
      const unsubscribe = onTableReplicaChanged((params) => {
        if (normalizePath(params.documentPath) === documentPath) listener(fromBase64(params.version))
      })
      subscriptions.add(unsubscribe)
      return () => {
        if (subscriptions.delete(unsubscribe)) unsubscribe()
      }
    },
    dispose() {
      disposed = true
      for (const unsubscribe of subscriptions) unsubscribe()
      subscriptions.clear()
    },
  }
}
