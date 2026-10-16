/**
 * Co-editing kit documents with other people through a sync server (`kition-sync/1`, Kition Pro).
 * Off without a sync server URL and a Kition Pro session: then nothing here connects or sends
 * anything. See `collabRelays.ts` (what is relayed, and when) and `kitRelay.ts` (how).
 */
export { startCollab } from './collabRelays'
