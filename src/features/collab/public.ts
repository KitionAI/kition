/**
 * Co-editing documents with other people through a sync server (`kition-sync/1`, Kition Pro): kit
 * documents (notes and tables among them). Off without a sync server URL and a Kition
 * Pro session: then nothing here connects or sends anything. See `collabRelays.ts` (what is
 * relayed, and when), `startRelay` in `@/lib/sync` (how), `collabDocuments.ts` (which documents), and
 * `shareActions.ts` (sharing, and opening a shared document).
 */
import { startAutoSync } from './autoSync'
import { startCollab as startRelays } from './collabRelays'

/** Starts co-editing in this window (relays, and "Sync all my documents"); answers its stop. */
export function startCollab() {
  const stopRelays = startRelays()
  const stopAutoSync = startAutoSync()
  return () => {
    stopAutoSync()
    stopRelays()
  }
}
export { CollabDialogs, requestOpenSharedDocument, requestShareDocument, requestSyncDocument, requestSyncedDocuments, useCollabAvailable } from './CollabDialogs'
export { isDocumentCollab } from './collabStore'
export { useSyncAllDocuments } from './accountSettings'
export { refreshAccountSettings, setSyncAllDocuments } from './syncedDocuments'
export { CollabTabIndicators } from './CollabStatus'
export { canShareDocument } from './shareActions'
export { setSyncServerUrl, syncServerUrl, testSyncServer, type SyncServerTest } from './collabSettings'
export { useCollabConnectionState } from './syncConnection'
/** The room record of a shared document (by its KDM document id), and the window's sync client: for the version history. */
export { readRoom } from './rooms'
export { syncClient } from './syncConnection'
