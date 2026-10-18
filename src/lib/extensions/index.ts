// Copied from kition-sdk packages/extensions/src/index.ts by scripts/sync-kit-host.mjs; change it there, not here.
/**
 * `@kition/extensions`: the extension host (`KitExtensions 1.0`). A host loads extensions
 * (`extension.json` + one ES module), runs each in a sandboxed worker on an opaque origin with only
 * its declared network origins, and serves it the object model (`@kition/sdk`) of the documents it
 * is active on, checked against its permissions. Extension authors: see `@kition/extensions/runtime`
 * for `activate(ctx)`'s types.
 */
export { checkBatch, permissionDenied, requirePermission } from './gate'
export { ExtensionHost, SCRIPT_PERMISSIONS, type ContributedCommand, type ContributedPanel, type PanelContent, type PanelSession, type ExtensionHostOptions, type ExtensionNotice, type ExtensionPackage, type HostDocument, type SandboxConnection, type SandboxFactory } from './host'
export {
  appliesTo,
  connectSources,
  hasPermission,
  KIT_EXTENSIONS_CAPABILITY,
  MANIFEST_VERSION,
  ManifestError,
  networkSources,
  panelAppliesTo,
  parseManifest,
  type ExtensionActivation,
  type ExtensionCommand,
  type ExtensionManifest,
  type ExtensionPanel,
  type Permission,
} from './manifest'
export { PANEL_TAG, SANDBOX_TAG, type DocumentInfo, type HostToWorker, type Notice, type PanelChannel, type PanelInfo, type PanelStart, type SandboxStart, type WorkerToHost } from './protocol'
export { CHANNEL_TAG, ExtensionError, RpcPeer, type PortLike } from './rpc'
export { iframeSandbox, openPanelFrame, type IframeSandboxOptions, type PanelFrame, type PanelFrameOptions } from './sandbox'
