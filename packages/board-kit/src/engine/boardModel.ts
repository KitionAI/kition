/**
 * The Board kit's engine (`kit.board`, engine contract 2 in TypeScript): Kition's board model,
 * `BoardStore` over a KDM replica of `boardSchema`, behind `@kition/kit-engine`'s `KitModel`.
 * Commands are the board's own (`BoardCommandRegistry`), each one transaction; imports, undo, and
 * redo patch the store's view from the objects they changed. The `.kiboard` file is the replica
 * itself (`encodeBoardFile`), so a file opens as the same document everywhere.
 */
import type { KitEngineCommand, KitModel } from '@kition/kit-engine'
import type { Replica } from '@kition/kdm'
import {
  BoardCommandRegistry,
  BoardStore,
  boardSchema,
  createEmptyBoard,
  decodeBoardFile,
  encodeBoardFile,
  readBoardTitle,
  type BoardCommand,
  type BoardRecordDiff,
} from '@kition/board-editor/model'

export type BoardView = { store: BoardStore; commands: BoardCommandRegistry }

type BoardCommandType = BoardCommand['type']

/** The board's commands as the engine lists them; `params` is what an agent reads. */
const COMMANDS: ReadonlyArray<{ id: BoardCommandType; title: string; params: string; mutates?: false }> = [
  { id: 'element.create', title: 'Create elements', params: '{ elements: WhiteboardElement[] } (rectangle, text, stroke, connector, or image, each with an id)' },
  { id: 'element.update', title: 'Update elements', params: '{ elements: WhiteboardElement[] } (the whole element, by id)' },
  { id: 'element.delete', title: 'Delete elements', params: '{ elementIds: string[] }' },
  { id: 'element.reorder', title: 'Reorder elements', params: "{ elementIds: string[], placement: 'front' | 'forward' | 'backward' | 'back' }" },
  { id: 'connector.create', title: 'Create a connector', params: '{ element: connector element, bindings: [{ anchor, terminal }] }' },
  { id: 'connector.update-terminal', title: 'Move a connector end', params: "{ connectorId, terminal: 'start' | 'end', point: { x, y }, binding? }" },
  { id: 'element.paste', title: 'Paste elements', params: '{ elements: WhiteboardElement[], bindings: BoardBindingRecord[] }' },
  { id: 'element.group', title: 'Group elements', params: "{ containerId, containerKind: 'group' | 'frame', elementIds: string[] }" },
  { id: 'element.ungroup', title: 'Ungroup', params: '{ containerIds: string[] }' },
  { id: 'page.create', title: 'New page', params: '{ pageId, name, activate? }' },
  { id: 'page.rename', title: 'Rename page', params: '{ pageId, name }' },
  { id: 'page.activate', title: 'Show page', params: '{ pageId }', mutates: false },
  { id: 'page.duplicate', title: 'Duplicate page', params: '{ sourcePageId, pageId, name }' },
  { id: 'page.delete', title: 'Delete page', params: '{ pageId }' },
  { id: 'page.reorder', title: 'Move page', params: "{ pageId, placement: 'previous' | 'next' }" },
]

const KNOWN = new Set<string>(COMMANDS.map((command) => command.id))

/** Why a file is not a board this engine opens, as an error message. */
const FILE_PROBLEMS = {
  'version-1': 'the board was saved by an earlier Kition (version 1) and is opened by Kition only',
  'newer-version': 'the board was saved by a newer Kition',
  'not-a-board': 'the file is not a board',
} as const

/** A file name without its folder and extension: the new board's title. */
function titleOf(name: string) {
  const base = name.split('/').pop() ?? name
  return base.replace(/\.kiboard$/i, '') || 'Board'
}

/** What a command changed, by record id. */
function summary(diff: BoardRecordDiff | null) {
  if (!diff) return { added: [], updated: [], removed: [] }
  return {
    added: diff.added.map((record) => record.id),
    updated: diff.updated.map((update) => update.after.id),
    removed: diff.removed.map((record) => record.id),
  }
}

function view(replica: Replica): BoardView {
  const store = new BoardStore(replica)
  return { store, commands: new BoardCommandRegistry(store) }
}

export const boardModel: KitModel<BoardView> = {
  schema: boardSchema,
  load: view,
  apply({ store }, _replica, changed) {
    store.followReplica(changed)
    return { kind: 'full' }
  },
  command({ commands }, _replica, id, params) {
    if (!KNOWN.has(id)) throw new Error(`the board has no command ${id}`)
    return summary(commands.execute({ ...params, type: id } as BoardCommand))
  },
  commands(): KitEngineCommand[] {
    return COMMANDS.map((command) => ({
      id: command.id,
      title: command.title,
      menu: null,
      shortcut: null,
      mutates: command.mutates ?? true,
      enabled: true,
      params: command.params,
    }))
  },
  import(_name, bytes, actor) {
    const decoded = decodeBoardFile(new TextDecoder().decode(bytes), actor)
    if (decoded.kind !== 'board') throw new Error(FILE_PROBLEMS[decoded.reason])
    return decoded.replica
  },
  export: (_view, replica) => new TextEncoder().encode(encodeBoardFile(replica)),
  create: (name, _size, actor) => createEmptyBoard(titleOf(name), actor),
  inspect({ store }, replica) {
    const elements = store.getRecords().filter((record) => record.record_type === 'element')
    return {
      title: readBoardTitle(replica),
      currentPage: store.getCurrentPageId(),
      pages: store.getPages().map((page) => ({
        id: page.id,
        name: page.name,
        elements: elements.filter((element) => element.record_type === 'element' && element.page_id === page.id).length,
      })),
      elements: elements.length,
    }
  },
}
