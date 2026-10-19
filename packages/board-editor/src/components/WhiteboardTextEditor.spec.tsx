import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WhiteboardTextEditor } from './WhiteboardTextEditor'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('WhiteboardTextEditor', () => {
  it('centers and rotates a shape editor using the shape dimensions and zoom', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <WhiteboardTextEditor
          editingText={{
            elementId: 'shape-1',
            elementKind: 'rectangle',
            x: 140,
            y: 120,
            value: 'Draft',
            isNew: false,
          }}
          element={{
            id: 'shape-1',
            kind: 'rectangle',
            x: 40,
            y: 60,
            width: 200,
            height: 120,
            rotation: 30,
            text: 'Draft',
          }}
          onCancel={vi.fn()}
          onChange={vi.fn()}
          onCommit={vi.fn()}
          viewport={{ x: 20, y: 10, zoom: 1.5 }}
        />,
      )
    })

    const editor = container.querySelector(
      '[data-testid="whiteboard-text-editor"]',
    ) as HTMLInputElement
    expect(editor.dataset.anchor).toBe('shape-center')
    expect(editor.style.left).toBe('180px')
    expect(editor.style.top).toBe('165px')
    expect(editor.style.width).toBe('264px')
    expect(editor.style.fontSize).toBe('33px')
    expect(editor.style.textAlign).toBe('center')
    expect(editor.style.transform).toBe('translate(-50%, -50%) rotate(30deg)')
    expect(editor.style.transformOrigin).toBe('center')
  })

  it('keeps standalone text editing anchored to the text origin', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(
        <WhiteboardTextEditor
          editingText={{
            elementId: 'text-1',
            elementKind: 'text',
            x: 50,
            y: 70,
            value: 'Draft',
            isNew: false,
          }}
          element={{
            id: 'text-1',
            kind: 'text',
            x: 50,
            y: 70,
            rotation: -15,
            text: 'Draft',
            fontSize: 18,
          }}
          onCancel={vi.fn()}
          onChange={vi.fn()}
          onCommit={vi.fn()}
          viewport={{ x: 0, y: 0, zoom: 2 }}
        />,
      )
    })

    const editor = container.querySelector(
      '[data-testid="whiteboard-text-editor"]',
    ) as HTMLInputElement
    expect(editor.dataset.anchor).toBe('text-origin')
    expect(editor.style.left).toBe('100px')
    expect(editor.style.top).toBe('140px')
    expect(editor.style.width).toBe('360px')
    expect(editor.style.fontSize).toBe('36px')
    expect(editor.style.textAlign).toBe('left')
    expect(editor.style.transform).toBe('translateY(-80%) rotate(-15deg)')
    expect(editor.style.transformOrigin).toBe('left bottom')
  })
})
