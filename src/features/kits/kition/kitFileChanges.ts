import { subscribeWorkspaceDocumentExternalChanges, type WorkspaceDocumentExternalChange } from '@/services/desktop'
import type { KitConnection } from '../host/mountKit'

/**
 * Tells the kit editor of `path` when its file changes on disk (the desktop watcher's `add` and
 * `change` events): `document/fileChanged` with the file's new stamp (Kit UI protocol section 3,
 * standard H6). The kit follows it at once instead of at its next check: a document without
 * unsaved edits takes the change, one with unsaved edits asks the person. The kit's own saves are
 * heard too and change nothing, since their stamp is the one it holds. `stamp` reads the file's
 * stamp; answers an unsubscribe.
 */
export function followKitFileChanges(path: string, connection: Pick<KitConnection, 'fileChanged'>, stamp: (path: string) => Promise<string | null>, subscribe = subscribeWorkspaceDocumentExternalChanges) {
  let current = true
  const stop = subscribe((change: WorkspaceDocumentExternalChange) => {
    if (change.path !== path || change.eventType === 'unlink') return
    void stamp(path).then(
      (version) => {
        if (current && version) connection.fileChanged(version)
      },
      () => undefined,
    )
  })
  return () => {
    current = false
    stop()
  }
}
