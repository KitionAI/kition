/**
 * Kits in Kition. `kition/` shows a kit's own editor in an iframe over the Kit UI protocol
 * (`host/` is the host side of that protocol) and is the workspace host kits read and write
 * through. `sdk/` loads a kit's engine in the page, where Kition makes new files with it. See
 * docs/kit-sdk.md.
 */
export { createKitFile } from './sdk/createKitFile'
export type { KitSdkManifest } from './sdk/kitSdk'
export { KitFrame, type EmbeddedKit } from './kition/KitFrame'
export { revealInKit } from './kition/kitViews'
export { resolveGenerateRuntimeModel } from './kition/kitGenerate'
export { KitDraftTabMark } from './kition/KitDraftTabMark'
export { HeadlessDraftBadge, HeadlessDraftReviewHost } from './kition/HeadlessDraftReview'
export { KITION_KIT_HOST } from './kition/kitionHost'
export { kitionTheme } from './kition/kitionTheme'
export { activeKitDocument, followKitConnections, mountedKitDocument, type MountedKitDocument } from './kition/kitConnections'
export { writeKitFileFromReplica } from './kition/kitFileFromReplica'
export { KitRpcError } from './host/mountKit'
export type { KitConnection, KitLinkRef, KitOpenParams, KitOpenResult } from './host/mountKit'
