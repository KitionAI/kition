/**
 * `@kition/board-editor/model`: the board on the Kit Data Model: its schema, the `.kiboard` file,
 * the record view (`BoardStore`) and its commands, previews, and templates.
 */
export { BoardCommandRegistry, type BoardCommand } from './lib/boardCommands'
export { BoardStore, type BoardRecordDiff } from './lib/boardStore'
export {
  createBoardFromRecords,
  createEmptyBoard,
  decodeBoardFile,
  encodeBoardFile,
  mergeBoardFile,
  readBoardFileCopy,
  replicaIncludes,
  versionIncludes,
  type BoardFileCopy,
  type BoardFileProblem,
} from './kdm/boardKdmFile'
export { boardRootId, readBoardRecords, readBoardTitle } from './kdm/boardKdmRead'
export { writeBoardDiff } from './kdm/boardKdmWrite'
export { boardPreviewSvg } from './kdm/boardPreview'
export { BOARD_KIT, boardSchema } from './kdm/boardSchema'
export { createBoardElementRecord, createBoardRecordsFromElements, DEFAULT_BOARD_PAGE_ID } from './lib/boardRecords'
export {
  instantiateWhiteboardTemplate,
  WHITEBOARD_TEMPLATES,
  type WhiteboardTemplateCategory,
  type WhiteboardTemplateDefinition,
} from './lib/whiteboardTemplates'
