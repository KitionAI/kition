import {
  listWorkspaceDocuments,
  writeWorkspaceDocument,
  type WorkspaceDocument,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'
import { randomActor } from '@/lib/kdm'
import { createBoardFromRecords, decodeBoardFile, encodeBoardFile } from '../kdm/boardKdmFile'
import { readBoardRecords } from '../kdm/boardKdmRead'
import {
  DEFAULT_BOARD_PAGE_ID,
  createBoardElementRecord,
  type BoardRecord,
} from './boardRecords'
import type { WhiteboardTemplateInstance } from './whiteboardTemplates'

const BOARD_FILE_EXTENSION = '.kiboard'

export async function createBoardWorkspaceFile(options: {
  folder?: string
  template?: WhiteboardTemplateInstance
  title?: string
} = {}): Promise<WorkspaceDocument> {
  const title = normalizeTitle(options.title)
  const folder = normalizeFolder(options.folder)
  const response = await listWorkspaceDocuments()
  const existingPaths = new Set(flattenPaths(response.items || []))
  let index = 1
  let path = buildPath(folder, `${title}${BOARD_FILE_EXTENSION}`)

  while (existingPaths.has(path)) {
    index += 1
    path = buildPath(folder, `${title} ${index}${BOARD_FILE_EXTENSION}`)
  }

  const boardTitle = path.split('/').pop()?.replace(/\.kiboard$/i, '') || title
  // The template is part of the new document's creating commit, so it is not an undo step.
  const records: BoardRecord[] = options.template
    ? [
        ...options.template.elements.map((element, elementIndex) => createBoardElementRecord({
          element,
          index: elementIndex,
          pageId: DEFAULT_BOARD_PAGE_ID,
        })),
        ...options.template.bindings,
      ]
    : []
  const board = createBoardFromRecords(boardTitle, randomActor(), records)
  const created = await writeWorkspaceDocument(path, encodeBoardFile(board))
  return { ...created, format: 'board' }
}

/**
 * The file text of a copy of the board in `text`: a new document (its own KDM document id) titled
 * `title`, holding the same pages, elements, and bindings, written in its creating commit so there
 * is nothing to undo. `null` when `text` is not a board this build opens; copy its bytes then.
 */
export function duplicateBoardFileText(text: string, title: string): string | null {
  const decoded = decodeBoardFile(text, randomActor())
  if (decoded.kind !== 'board') return null
  return encodeBoardFile(createBoardFromRecords(title, randomActor(), readBoardRecords(decoded.replica)))
}

function flattenPaths(items: readonly WorkspaceDocumentTreeItem[]): string[] {
  return items.flatMap((item) => [
    item.path,
    ...flattenPaths(item.children || []),
  ])
}

function normalizeTitle(title?: string) {
  const value = String(title || 'Untitled board')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.kiboard$/i, '')
  return value || 'Untitled board'
}

function normalizeFolder(folder?: string) {
  return String(folder || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
}

function buildPath(folder: string, filename: string) {
  return folder ? `${folder}/${filename}` : filename
}
