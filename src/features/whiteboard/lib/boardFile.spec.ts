import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  listWorkspaceDocuments,
  writeWorkspaceDocument,
} from '@/services/desktop'
import { createBoardWorkspaceFile } from './boardFile'

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
})
