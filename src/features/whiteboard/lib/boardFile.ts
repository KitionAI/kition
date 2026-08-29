import {
  listWorkspaceDocuments,
  writeWorkspaceDocument,
  type WorkspaceDocument,
  type WorkspaceDocumentTreeItem,
} from '@/services/desktop'
import {
  BOARD_FILE_EXTENSION,
  createEmptyBoardDocument,
  serializeBoardDocument,
} from './boardSerialization'
import {
  DEFAULT_BOARD_PAGE_ID,
  createBoardElementRecord,
} from './boardRecords'
import type { WhiteboardTemplateInstance } from './whiteboardTemplates'

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

  const document = createEmptyBoardDocument(
    path.split('/').pop()?.replace(/\.kiboard$/i, '') || title,
  )
  if (options.template) {
    document.records = [
      ...document.records,
      ...options.template.elements.map((element, elementIndex) => createBoardElementRecord({
        element,
        index: elementIndex,
        pageId: DEFAULT_BOARD_PAGE_ID,
      })),
      ...options.template.bindings,
    ]
  }
  const created = await writeWorkspaceDocument(path, serializeBoardDocument(document))
  return { ...created, format: 'board' }
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
