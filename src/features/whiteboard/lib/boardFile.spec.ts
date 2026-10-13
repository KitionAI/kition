import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  listWorkspaceDocuments,
  writeWorkspaceDocument,
} from '@/services/desktop'
import { decodeBoardFile } from '../kdm/boardKdmFile'
import { readBoardRecords, readBoardTitle } from '../kdm/boardKdmRead'
import { createBoardWorkspaceFile } from './boardFile'
import { instantiateWhiteboardTemplate } from './whiteboardTemplates'

function decodeWritten() {
  const content = String(vi.mocked(writeWorkspaceDocument).mock.calls.at(-1)?.[1])
  const decoded = decodeBoardFile(content, 7n)
  if (decoded.kind !== 'board') throw new Error(`expected a board, got ${decoded.reason}`)
  return decoded.replica
}

vi.mock('@/services/desktop', () => ({
  listWorkspaceDocuments: vi.fn(),
  writeWorkspaceDocument: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(listWorkspaceDocuments).mockResolvedValue({
    root_path: '/workspace',
    items: [],
  })
  vi.mocked(writeWorkspaceDocument).mockImplementation(async (path, content) => ({
    path,
    name: path.split('/').pop() || path,
    content,
    format: 'binary',
  }))
})

describe('createBoardWorkspaceFile', () => {
  it('creates a real .kiboard file in the selected workspace folder', async () => {
    const document = await createBoardWorkspaceFile({ folder: 'Planning' })

    expect(document.path).toBe('Planning/Untitled board.kiboard')
    expect(document.format).toBe('board')
    expect(writeWorkspaceDocument).toHaveBeenCalledWith(
      'Planning/Untitled board.kiboard',
      expect.stringMatching(/^\{"format":"kition-board","version":2,"kdm":"[A-Za-z0-9+/=]+"\}\n$/),
    )
    const board = decodeWritten()
    expect(readBoardTitle(board)).toBe('Untitled board')
    expect(readBoardRecords(board).filter((record) => record.record_type === 'page')).toHaveLength(1)
    expect(board.canUndo()).toBe(false)
  })

  it('chooses a unique filename without overwriting an existing Board', async () => {
    vi.mocked(listWorkspaceDocuments).mockResolvedValue({
      root_path: '/workspace',
      items: [{
        type: 'file',
        path: 'Untitled board.kiboard',
        name: 'Untitled board.kiboard',
      }],
    })

    expect((await createBoardWorkspaceFile()).path).toBe('Untitled board 2.kiboard')
  })

  it('writes the selected template into the Board before opening it', async () => {
    const template = instantiateWhiteboardTemplate(
      'flowchart',
      { x: 600, y: 380 },
      (key) => key,
    )

    const created = await createBoardWorkspaceFile({
      folder: 'Planning',
      template,
      title: 'Flowchart',
    })

    expect(created.path).toBe('Planning/Flowchart.kiboard')
    const board = decodeWritten()
    const records = readBoardRecords(board)
    expect(readBoardTitle(board)).toBe('Flowchart')
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ record_type: 'element', kind: 'rectangle' }),
      expect.objectContaining({ record_type: 'element', kind: 'connector' }),
      expect.objectContaining({ record_type: 'binding', binding_type: 'connector' }),
    ]))
    expect(records.filter((record) => record.record_type === 'element')).toHaveLength(template.elements.length)
    // The template is written when the file is created, not as an undo step.
    expect(board.canUndo()).toBe(false)
  })
})
