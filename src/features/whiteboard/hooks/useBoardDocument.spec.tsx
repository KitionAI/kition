import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readWorkspaceDocument, writeWorkspaceDocument } from '@/services/desktop'
import { createBoardRecordsFromElements } from '../lib/boardRecords'
import {
  buildBoardDocument,
  serializeBoardDocument,
} from '../lib/boardSerialization'
import { useWhiteboardEditor } from './useWhiteboardEditor'
import { useBoardDocument } from './useBoardDocument'

vi.mock('@/services/desktop', () => ({
  readWorkspaceDocument: vi.fn(),
  writeWorkspaceDocument: vi.fn(),
}))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(readWorkspaceDocument).mockResolvedValue({
    path: 'Planning/Product.kiboard',
    name: 'Product.kiboard',
    content: serializeBoardDocument(buildBoardDocument({
      title: 'Product',
      viewport: { x: 10, y: 20, zoom: 1.2 },
      records: createBoardRecordsFromElements([{
        id: 'rect-1',
        kind: 'rectangle',
        x: 1,
        y: 2,
        width: 30,
        height: 40,
      }], 'Product'),
    })),
    format: 'board',
  })
  vi.mocked(writeWorkspaceDocument).mockResolvedValue({} as never)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
  vi.useRealTimers()
})

describe('useBoardDocument', () => {
  it('loads a .kiboard file and autosaves later SVG edits', async () => {
    let editor: ReturnType<typeof useWhiteboardEditor> | null = null
    function Harness() {
      editor = useWhiteboardEditor()
      useBoardDocument({
        path: 'Planning/Product.kiboard',
        title: 'Product',
        records: editor.records,
        viewport: editor.viewport,
        replaceDocument: editor.replaceDocument,
      })
      return null
    }

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
      await Promise.resolve()
    })
    expect(editor?.elements).toEqual([
      expect.objectContaining({ id: 'rect-1', kind: 'rectangle' }),
    ])
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()

    await act(async () => editor?.setTool('rectangle'))
    await act(async () => {
      editor?.beginCanvasPointer({
        world: { x: 100, y: 100 },
        screen: { x: 100, y: 100 },
      })
      editor?.endPointer({ x: 180, y: 160 })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650)
    })

    expect(writeWorkspaceDocument).toHaveBeenCalledWith(
      'Planning/Product.kiboard',
      expect.stringContaining('"format": "kition-board"'),
    )
    expect(writeWorkspaceDocument).toHaveBeenCalledWith(
      'Planning/Product.kiboard',
      expect.stringContaining('"version": 1'),
    )
  })

  it('does not autosave a live drag until its record transaction commits', async () => {
    let editor: ReturnType<typeof useWhiteboardEditor> | null = null
    function Harness() {
      editor = useWhiteboardEditor()
      useBoardDocument({
        path: 'Planning/Product.kiboard',
        title: 'Product',
        isTransacting: editor.isTransacting,
        records: editor.records,
        viewport: editor.viewport,
        replaceDocument: editor.replaceDocument,
      })
      return null
    }

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(Harness))
      await Promise.resolve()
    })

    await act(async () => {
      editor?.beginElementPointer('rect-1', { x: 1, y: 2 })
      editor?.movePointer({
        world: { x: 31, y: 42 },
        screen: { x: 31, y: 42 },
      })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650)
    })
    expect(writeWorkspaceDocument).not.toHaveBeenCalled()

    await act(async () => editor?.endPointer({ x: 31, y: 42 }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650)
    })
    expect(writeWorkspaceDocument).toHaveBeenCalledTimes(1)
  })
})
