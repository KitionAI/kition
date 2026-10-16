/**
 * Co-editing kit documents with other people through a sync server (`kition-sync/1`, Kition Pro).
 * Off without a sync server URL and a Kition Pro session: then nothing here connects or sends
 * anything. See `collabRelays.ts` (what is relayed, and when), `kitRelay.ts` (how), and
 * `shareActions.ts` (sharing, and opening a shared document).
 */
export { startCollab } from './collabRelays'
export { CollabDialogs, requestOpenSharedDocument, requestShareKitDocument, useCollabAvailable } from './CollabDialogs'
export { CollabTabIndicators } from './CollabStatus'
export { canShareKitDocument } from './shareActions'
