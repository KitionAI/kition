/**
 * The Kit SDK. `sdk/` is the portable core, which imports nothing else from
 * Kition: the SDK contract and loader, the engine worker and client, the
 * document hook (file IO through a `KitHost`), the canvas, tools, and
 * shortcuts. `kition/` is Kition's own editor chrome and workspace host.
 * See docs/kit-sdk.md. Re-export more of `sdk/` here when a kit needs it.
 */
export { KitCanvas, type KitCanvasHandle } from './sdk/KitCanvas'
export { KitEngine, type KitEngineInfo } from './sdk/kitEngine'
export { kitSdkAvailable, type KitSdkManifest } from './sdk/kitSdk'
export { HAND_TOOL, ZOOM_TOOL, dragRect, type KitPointer, type KitTool } from './sdk/kitTools'
export type { RasterDecoration, RasterRect, RasterView, RasterViewportStats } from './sdk/rasterViewport'
export { useKitDocument, type KitChange } from './sdk/useKitDocument'
export { KitEditorFrame } from './kition/KitEditorFrame'
export { KitMenuBar } from './kition/KitMenuBar'
export { KITION_KIT_HOST } from './kition/kitionHost'
export { useKitEditor } from './kition/useKitEditor'
