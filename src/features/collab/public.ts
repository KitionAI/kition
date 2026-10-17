/**
 * Co-editing documents with other people through a sync server (`kition-sync/1`, Kition Pro): kit
 * documents, boards, Markdown documents, and tables. Off without a sync server URL and a Kition
 * Pro session: then nothing here connects or sends anything. See `collabRelays.ts` (what is
 * relayed, and when), `kitRelay.ts` (how), `collabDocuments.ts` (which documents), and
 * `shareActions.ts` (sharing, and opening a shared document).
 */
export { startCollab } from './collabRelays'
export { CollabDialogs, requestOpenSharedDocument, requestShareDocument, useCollabAvailable } from './CollabDialogs'
export { CollabTabIndicators } from './CollabStatus'
export { canShareDocument } from './shareActions'
export { setSyncServerUrl, syncServerUrl, testSyncServer, type SyncServerTest } from './collabSettings'
export { useCollabConnectionState, type CollabConnectionState } from './syncConnection'
