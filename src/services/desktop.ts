/**
 * Desktop bridge and runtime services, one entry for the renderer. The
 * implementation lives in `src/services/desktopClient/` by domain; import
 * from here so call sites stay stable.
 */
export * from './desktopClient/bridge'
export * from './desktopClient/runtime'
export * from './desktopClient/browserSession'
export * from './desktopClient/workspaceDocuments'
export * from './desktopClient/workspaceFiles'
export * from './desktopClient/vaults'
export * from './desktopClient/secureStore'
