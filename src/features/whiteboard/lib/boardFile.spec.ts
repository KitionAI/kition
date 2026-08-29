import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  listWorkspaceDocuments,
  writeWorkspaceDocument,
} from '@/services/desktop'
import { createBoardWorkspaceFile } from './boardFile'
import { instantiateWhiteboardTemplate } from './whiteboardTemplates'

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
      expect.stringContaining('"format": "kition-board"'),
    )
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
    const content = vi.mocked(writeWorkspaceDocument).mock.calls.at(-1)?.[1]
    const document = JSON.parse(String(content))
    expect(document.title).toBe('Flowchart')
    expect(document.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ record_type: 'element', kind: 'rectangle' }),
      expect.objectContaining({ record_type: 'element', kind: 'connector' }),
      expect.objectContaining({ record_type: 'binding', binding_type: 'connector' }),
    ]))
    expect(document.records.filter((record: { record_type: string }) => (
      record.record_type === 'element'
    ))).toHaveLength(template.elements.length)
  })
})
