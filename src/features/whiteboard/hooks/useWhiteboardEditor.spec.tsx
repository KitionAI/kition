import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  useWhiteboardEditor,
  type WhiteboardEditorController,
} from './useWhiteboardEditor'
import { createBoardRecordsFromElements } from '../lib/boardRecords'
import type { WhiteboardElement } from '../lib/whiteboardTypes'

let container: HTMLDivElement
let root: Root | null = null

async function renderHook() {
  const ref: { current: WhiteboardEditorController | null } = { current: null }
  function Harness() {
    ref.current = useWhiteboardEditor()
    return null
  }
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })
  return ref
}

async function replaceElements(
  ref: { current: WhiteboardEditorController | null },
  elements: WhiteboardElement[],
) {
  await act(async () => ref.current?.replaceDocument({
    records: createBoardRecordsFromElements(elements),
    viewport: { x: 0, y: 0, zoom: 1 },
  }))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('useWhiteboardEditor', () => {
  it('creates an SVG rectangle and treats it as one undoable operation', async () => {
    const ref = await renderHook()
    await act(async () => ref.current?.setTool('rectangle'))
    await act(async () => {
      ref.current?.beginCanvasPointer({
        world: { x: 10, y: 20 },
        screen: { x: 10, y: 20 },
      })
      ref.current?.movePointer({
        world: { x: 110, y: 80 },
        screen: { x: 110, y: 80 },
      })
      ref.current?.endPointer({ x: 110, y: 80 })
    })

    expect(ref.current?.elements).toEqual([
      expect.objectContaining({
        kind: 'rectangle',
        x: 10,
        y: 20,
        width: 100,
        height: 60,
      }),
    ])
    expect(ref.current?.canUndo).toBe(true)

    await act(async () => ref.current?.undo())
    expect(ref.current?.elements).toEqual([])
    expect(ref.current?.canRedo).toBe(true)

    await act(async () => ref.current?.redo())
    expect(ref.current?.elements).toHaveLength(1)
  })

  it('commits active DOM text editing back into an SVG text element', async () => {
    const ref = await renderHook()
    await act(async () => ref.current?.setTool('text'))
    await act(async () => {
      ref.current?.beginCanvasPointer({
        world: { x: 50, y: 70 },
        screen: { x: 50, y: 70 },
      })
    })
    await act(async () => ref.current?.updateEditingText('Launch plan'))
    await act(async () => ref.current?.commitEditingText())

    expect(ref.current?.elements).toEqual([
      expect.objectContaining({
        kind: 'text',
        x: 50,
        y: 70,
        text: 'Launch plan',
      }),
    ])
    expect(ref.current?.editingText).toBeNull()
  })

  it('commits a live drag as one typed diff instead of an element-array snapshot', async () => {
    const ref = await renderHook()
    await act(async () => ref.current?.setTool('rectangle'))
    await act(async () => {
      ref.current?.beginCanvasPointer({
        world: { x: 10, y: 20 },
        screen: { x: 10, y: 20 },
      })
      ref.current?.endPointer({ x: 110, y: 80 })
    })
    const element = ref.current?.elements[0]
    expect(element).toBeDefined()

    await act(async () => {
      ref.current?.beginElementPointer(element!.id, { x: 10, y: 20 })
      ref.current?.movePointer({
        world: { x: 30, y: 50 },
        screen: { x: 30, y: 50 },
      })
      ref.current?.movePointer({
        world: { x: 50, y: 70 },
        screen: { x: 50, y: 70 },
      })
    })
    expect(ref.current?.isTransacting).toBe(true)
    expect(ref.current?.elements[0]).toMatchObject({ x: 50, y: 70 })

    await act(async () => ref.current?.endPointer({ x: 50, y: 70 }))
    expect(ref.current?.isTransacting).toBe(false)
    await act(async () => ref.current?.undo())
    expect(ref.current?.elements[0]).toMatchObject({ x: 10, y: 20 })
  })

  it('supports additive multi-selection and moves the selection as one command', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 80, height: 60 },
      { id: 'rect-2', kind: 'rectangle', x: 150, y: 40, width: 70, height: 50 },
    ])

    await act(async () => {
      ref.current?.beginElementPointer('rect-1', { x: 20, y: 30 })
      ref.current?.endPointer({ x: 20, y: 30 })
    })
    await act(async () => {
      ref.current?.beginElementPointer('rect-2', { x: 160, y: 50 }, { additive: true })
      ref.current?.movePointer({
        world: { x: 180, y: 80 },
        screen: { x: 180, y: 80 },
      })
      ref.current?.endPointer({ x: 180, y: 80 })
    })

    expect(ref.current?.selectedElementIds).toEqual(['rect-1', 'rect-2'])
    expect(ref.current?.elements).toEqual([
      expect.objectContaining({ id: 'rect-1', x: 30, y: 50 }),
      expect.objectContaining({ id: 'rect-2', x: 170, y: 70 }),
    ])
    await act(async () => ref.current?.undo())
    expect(ref.current?.elements).toEqual([
      expect.objectContaining({ id: 'rect-1', x: 10, y: 20 }),
      expect.objectContaining({ id: 'rect-2', x: 150, y: 40 }),
    ])
  })

  it('brush-selects all elements intersecting the SVG selection rectangle', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 20, y: 20, width: 60, height: 50 },
      { id: 'rect-2', kind: 'rectangle', x: 300, y: 300, width: 60, height: 50 },
    ])

    await act(async () => {
      ref.current?.beginCanvasPointer({
        world: { x: 0, y: 0 },
        screen: { x: 0, y: 0 },
      })
      ref.current?.movePointer({
        world: { x: 140, y: 120 },
        screen: { x: 140, y: 120 },
      })
      ref.current?.endPointer({ x: 140, y: 120 })
    })

    expect(ref.current?.selectedElementIds).toEqual(['rect-1'])
  })

  it('resizes and rotates selected elements through live transform sessions', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
    ])
    await act(async () => {
      ref.current?.beginElementPointer('rect-1', { x: 20, y: 30 })
      ref.current?.endPointer({ x: 20, y: 30 })
    })
    await act(async () => {
      ref.current?.beginResizePointer('south-east')
      ref.current?.movePointer({
        world: { x: 210, y: 140 },
        screen: { x: 210, y: 140 },
      })
      ref.current?.endPointer({ x: 210, y: 140 })
    })
    expect(ref.current?.elements[0]).toMatchObject({ width: 200, height: 120 })

    await act(async () => {
      ref.current?.beginRotatePointer({ x: 110, y: -20 })
      ref.current?.movePointer({
        world: { x: 270, y: 80 },
        screen: { x: 270, y: 80 },
        shiftKey: true,
      })
      ref.current?.endPointer({ x: 270, y: 80 })
    })
    expect(ref.current?.elements[0].rotation).toBe(90)
  })

  it('locks selections, blocks transforms, and nudges unlocked elements', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
    ])
    await act(async () => {
      ref.current?.beginElementPointer('rect-1', { x: 20, y: 30 })
      ref.current?.endPointer({ x: 20, y: 30 })
    })
    await act(async () => {
      ref.current?.toggleSelectionLock()
    })
    expect(ref.current?.allSelectedLocked).toBe(true)
    expect(ref.current?.beginElementPointer('rect-1', { x: 20, y: 30 })).toBe(false)

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    })
    expect(ref.current?.elements[0]).toMatchObject({ x: 10, locked: true })

    await act(async () => {
      ref.current?.toggleSelectionLock()
    })
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    })
    expect(ref.current?.elements[0]).toMatchObject({ x: 11, locked: false })
  })

  it('duplicates a selection with Alt-drag and squashes it into one undo step', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
    ])

    await act(async () => {
      ref.current?.beginElementPointer(
        'rect-1',
        { x: 20, y: 30 },
        { duplicate: true },
      )
      ref.current?.movePointer({
        world: { x: 70, y: 90 },
        screen: { x: 70, y: 90 },
      })
      ref.current?.endPointer({ x: 70, y: 90 })
    })

    expect(ref.current?.elements).toHaveLength(2)
    expect(ref.current?.elements[1]).toMatchObject({ x: 60, y: 80 })
    await act(async () => ref.current?.undo())
    expect(ref.current?.elements).toEqual([
      expect.objectContaining({ id: 'rect-1', x: 10, y: 20 }),
    ])
  })

  it('creates the selected shape type with the current default style', async () => {
    const ref = await renderHook()
    await act(async () => ref.current?.applyStyle({
        strokeColor: 'purple',
        fillColor: 'green',
        dashStyle: 'dashed',
        strokeSize: 'l',
      }))
    await act(async () => ref.current?.selectShapeType('diamond'))
    await act(async () => {
      ref.current?.beginCanvasPointer({
        world: { x: 20, y: 30 },
        screen: { x: 20, y: 30 },
      })
      ref.current?.endPointer({ x: 180, y: 130 })
    })

    expect(ref.current?.elements[0]).toMatchObject({
      kind: 'rectangle',
      shapeType: 'diamond',
      style: expect.objectContaining({
        dashStyle: 'dashed',
        fillColor: 'green',
        strokeColor: 'purple',
        strokeSize: 'l',
      }),
    })
  })

  it('applies a style change to the selection as one undoable command', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
    ])
    await act(async () => ref.current?.selectElement('rect-1'))
    await act(async () => ref.current?.applyStyle({ fillColor: 'purple', opacity: 0.55 }))
    expect(ref.current?.elements[0].style).toMatchObject({
      fillColor: 'purple',
      opacity: 0.55,
    })
    await act(async () => ref.current?.undo())
    expect(ref.current?.elements[0].style).toBeUndefined()
  })

  it('erases unlocked elements, skips locked elements, and groups a stroke into one undo', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
      { id: 'rect-2', kind: 'rectangle', x: 180, y: 20, width: 100, height: 60 },
      { id: 'locked-1', kind: 'rectangle', x: 340, y: 20, width: 100, height: 60, locked: true },
    ])
    await act(async () => ref.current?.setTool('eraser'))
    await act(async () => {
      ref.current?.beginErase('rect-1')
    })
    await act(async () => {
      ref.current?.continueErase('rect-2')
    })
    await act(async () => {
      ref.current?.continueErase('locked-1')
      ref.current?.endErase()
    })
    expect(ref.current?.elements.map((element) => element.id)).toEqual(['locked-1'])
    await act(async () => ref.current?.undo())
    expect(ref.current?.elements.map((element) => element.id)).toEqual([
      'rect-1',
      'rect-2',
      'locked-1',
    ])
  })

  it('duplicates from the action bar command and removes the copy with one undo', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
    ])
    await act(async () => ref.current?.selectElement('rect-1'))
    await act(async () => ref.current?.duplicateSelection())
    expect(ref.current?.elements).toHaveLength(2)
    expect(ref.current?.elements[1]).toMatchObject({ x: 34, y: 44 })
    await act(async () => ref.current?.undo())
    expect(ref.current?.elements).toEqual([
      expect.objectContaining({ id: 'rect-1', x: 10, y: 20 }),
    ])
  })

  it('inserts a portable workspace image at the viewport center', async () => {
    const ref = await renderHook()
    await act(async () => {
      ref.current?.insertImage({
        alt: 'Roadmap',
        canvasSize: { x: 800, y: 600 },
        width: 320,
        height: 180,
        workspacePath: 'Attachments/roadmap.png',
      })
    })
    expect(ref.current?.elements[0]).toMatchObject({
      kind: 'image',
      x: 240,
      y: 210,
      width: 320,
      height: 180,
      workspacePath: 'Attachments/roadmap.png',
      alt: 'Roadmap',
    })
  })
})
