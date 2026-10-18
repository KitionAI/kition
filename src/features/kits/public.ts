/**
 * Kits in Kition. `kition/` shows a kit's own editor in an iframe over the Kit UI protocol
 * (`host/` is the host side of that protocol) and is the workspace host kits read and write
 * through. `sdk/` loads a kit's engine in the page, where Kition makes new files with it. See
 * docs/kit-sdk.md.
 */
export { createKitFile } from './sdk/createKitFile'
export type { KitSdkManifest } from './sdk/kitSdk'
export { KitFrame, type EmbeddedKit } from './kition/KitFrame'
export { KITION_KIT_HOST } from './kition/kitionHost'
export { activeKitDocument, followKitConnections, mountedKitDocument, type MountedKitDocument } from './kition/kitConnections'
export { writeKitFileFromReplica } from './kition/kitFileFromReplica'
export type { KitConnection } from './host/mountKit'
