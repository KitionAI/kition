import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readBoardRecords, readBoardTitle } from '@/features/whiteboard/kdm/boardKdmRead'
import { createBoardFromRecords, decodeBoardFile, encodeBoardFile } from '@/features/whiteboard/kdm/boardKdmFile'
import { createBoardRecordsFromElements } from '@/features/whiteboard/lib/boardRecords'
import type { WorkspaceTreeNode } from '@/features/workspace/lib/workspace'
import { readWorkspaceDocument, writeWorkspaceDocument } from '@/services/desktop'
import { useWorkspaceTreeNodeActions } from './useWorkspaceTreeNodeActions'

vi.mock('@/services/desktop', () => ({
  moveWorkspaceDocument: vi.fn(),
  moveWorkspaceFolder: vi.fn(),
  deleteWorkspaceDocument: vi.fn(),
  deleteWorkspaceFolder: vi.fn(),
  listWorkspaceDocuments: vi.fn(),
  readWorkspaceDocument: vi.fn(),
  writeWorkspaceDocument: vi.fn(),
  getApiBaseURL: () => '',
}))

vi.mock('@/services/workspaceEditSessions', () => ({
  flushWorkspaceEditSessions: vi.fn(async () => {}),
}))

vi.mock('@/api/dataDocuments', () => ({
  deleteDataDocumentByPath: vi.fn(),
  renameDataDocumentByPath: vi.fn(),
}))

vi.mock('@kition/app-ui/confirm', () => ({
  useConfirm: () => async () => true,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

const boardNode: WorkspaceTreeNode = {
  type: 'file',
  format: 'board',
  path: 'Plans/Roadmap.kiboard',
  filePath: 'Plans/Roadmap.kiboard',
  title: 'Roadmap',
  name: 'Roadmap.kiboard',
  virtual: false,
  parentPath: 'Plans',
  children: [],
}

let container: HTMLDivElement
let root: Root | null = null
let api: ReturnType<typeof useWorkspaceTreeNodeActions> | null = null
const setError = vi.fn()

function Surface() {
  api = useWorkspaceTreeNodeActions({
    activeDocumentPath: '',
    activeResourcePath: '',
    applyWorkspaceDocumentList: async () => {},
    filterWorkspaceTabs: () => {},
    hasUnsavedChanges: false,
    persistActiveDocument: async () => true,
    forgetOpenedDocuments: () => {},
    refreshWorkspaceDocuments: async () => true,
    remapWorkspaceTabPaths: () => {},
    renameWorkspaceTabPath: () => {},
    rootPath: '/workspace',
    setActiveResourcePath: () => {},
    setActiveWorkspaceTabId: () => {},
    setAgentModifiedDocumentPaths: () => {},
    setError,
    setFeedback: () => {},
    setSaving: () => {},
    treeState: {
      expandFolders: () => {},
      flatTreeNodes: [boardNode],
      updateTreeMetadata: () => {},
    },
  })
  return null
}

function serve(content: string) {
  vi.mocked(readWorkspaceDocument).mockResolvedValue({ path: boardNode.path, name: boardNode.name, content, format: 'board' })
}

async function duplicate() {
  await act(async () => {
    await api!.duplicateDocumentNode(boardNode)
  })
  expect(writeWorkspaceDocument).toHaveBeenCalledTimes(1)
  return vi.mocked(writeWorkspaceDocument).mock.calls[0]
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(writeWorkspaceDocument).mockImplementation(async (path, content) => ({ path, name: path, content, format: 'board' }))
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Surface))
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('useWorkspaceTreeNodeActions — duplicating a Board', () => {
  it('writes the copy as a new KDM document with the same records', async () => {
    const original = createBoardFromRecords('Roadmap', 1n, createBoardRecordsFromElements([
      { id: 'rect-1', kind: 'rectangle', x: 1, y: 2, width: 30, height: 40 },
      { id: 'note-1', kind: 'text', x: 50, y: 60, text: 'Ship it' },
    ], 'Roadmap'))
    serve(encodeBoardFile(original))

    const [path, content] = await duplicate()
    expect(path).toBe('Plans/Roadmap copy.kiboard')
    const copy = decodeBoardFile(content, 2n)
    if (copy.kind !== 'board') throw new Error(`expected a board, got ${copy.reason}`)
    expect(copy.replica.docId).not.toBe(original.docId)
    expect(readBoardRecords(copy.replica)).toEqual(readBoardRecords(original))
    expect(readBoardTitle(copy.replica)).toBe('Roadmap copy')
    expect(setError.mock.calls.filter(([error]) => error)).toEqual([])
  })

  it('copies the bytes of a file that is not a Board this build reads', async () => {
    const v1 = `${JSON.stringify({ format: 'kition-board', version: 1, records: [] })}\n`
    serve(v1)
    const [path, content] = await duplicate()
    expect(path).toBe('Plans/Roadmap copy.kiboard')
    expect(content).toBe(v1)
  })
})
