/**
 * The Kit SDK template: everything an in-page kit editor shares. A kit adds
 * its SDK manifest, a `describe` for its inspect JSON, its tools and panels,
 * and a canvas on `RasterViewport`. See docs/kit-sdk.md.
 */
export { KitEditorFrame } from './components/KitEditorFrame'
export { KitMenuBar } from './components/KitMenuBar'
export { KitEngine, type KitEngineInfo } from './sdk/kitEngine'
export { kitSdkAvailable, type KitSdkManifest } from './sdk/kitSdk'
export { RasterViewport, type RasterRect, type RasterView, type RasterViewportStats } from './sdk/rasterViewport'
export { useKitDocument, type KitChange } from './sdk/useKitDocument'
export { useKitEditor } from './sdk/useKitEditor'
