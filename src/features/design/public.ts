/**
 * Public entry of the design feature for other features. Import from
 * here, never from internal modules (enforced by tooling/dependency-cruiser.cjs).
 */
export type { DesignAgentBridge } from './lib/designAgentBridge'
export { runtimeSupportsDesignAgent } from './lib/designCapabilities'
export { buildDesignImageAgentInstruction } from './lib/designImageGeneration'
export {
  BRAND_COLOR_ROLES,
  EMPTY_BRAND_KIT,
  serializeBrandKit,
  type BrandKitFile,
} from './lib/designBrand'
export { useWorkspaceBrandKit } from './hooks/useWorkspaceBrandKit'
export { DESIGN_FONT_FAMILIES } from './lib/designTypes'
/** Loads the design document library on first use; it carries the zod-based serializer. */
export const loadDesignLib = () => import('./lib/designLib')
