/**
 * Public entry of the whiteboard feature for other features. Import from
 * here, never from internal modules (enforced by tooling/dependency-cruiser.cjs).
 */
export type { WhiteboardAgentBridge } from './lib/whiteboardAgentBridge'
export { runtimeSupportsWhiteboard } from './lib/whiteboardCapabilities'
