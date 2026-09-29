/**
 * Public entry of the design feature for other features. Import from
 * here, never from internal modules (enforced by tooling/dependency-cruiser.cjs).
 */
export type { DesignAgentBridge } from './lib/designAgentBridge'
export { runtimeSupportsDesignAgent } from './lib/designCapabilities'
/** Loads the design document library on first use; it carries the zod-based serializer. */
export const loadDesignLib = () => import('./lib/designLib')
