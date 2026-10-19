/**
 * `@kition/board-editor`: the board's agent wire types, its host seam, and its record and element
 * types. It loads neither the Kit Data Model nor the editor: the model is
 * `@kition/board-editor/model`, the editor `@kition/board-editor/editor`.
 */
export * from './lib/agentWhiteboard'
export { BoardHostProvider, type BoardHost } from './host'
export type { BoardFrameSnapshot } from './lib/boardFrameExport'
export type { BoardRecord } from './lib/boardRecords'
export type { WhiteboardTemplateCreationSelection, WhiteboardTemplateInstance } from './lib/whiteboardTemplates'
export type { WhiteboardElement, WhiteboardElementStyle, WhiteboardPoint, WhiteboardTool, WhiteboardViewport } from './lib/whiteboardTypes'
