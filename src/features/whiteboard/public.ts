/**
 * Public entry of the whiteboard feature for other features. Import from
 * here, never from internal modules (enforced by tooling/dependency-cruiser.cjs).
 */
export type { WhiteboardAgentBridge } from './lib/whiteboardAgentBridge'
export { runtimeSupportsWhiteboard } from './lib/whiteboardCapabilities'
/** Loads board file creation on first use; it carries the board serializer and geometry. */
export const loadBoardFile = () => import('./lib/boardFile')
export { findOpenBoard, followOpenBoards, type OpenBoard } from './lib/openBoards'
/** Loads the writer of `.kiboard` files from shared boards; it carries the KDM. */
export const loadBoardSharedFile = () => import('./kdm/boardSharedFile')
