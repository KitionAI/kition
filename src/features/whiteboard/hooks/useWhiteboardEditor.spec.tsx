import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useWhiteboardEditor,
  type WhiteboardEditorController,
} from './useWhiteboardEditor'
import { createBoardClipboardText } from '../lib/boardClipboard'
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

  it('exposes deterministic Board lint findings for Agent review', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [{
      id: 'flow-node',
      kind: 'rectangle',
      x: 0,
      y: 0,
      width: 120,
      height: 70,
      shapeStyle: 'flow-node',
    }])
    expect(ref.current?.lintFindings.map((finding) => finding.code)).toEqual([
      'missing-label',
      'disconnected-node',
    ])
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

  it('anchors rectangle text editing at the shape center and updates the same element', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [{
      id: 'shape-1',
      kind: 'rectangle',
      x: 40,
      y: 60,
      width: 200,
      height: 120,
      rotation: 30,
      text: 'Draft',
    }])

    await act(async () => ref.current?.beginTextEdit(ref.current.elements[0]))
    expect(ref.current?.editingText).toMatchObject({
      elementId: 'shape-1',
      elementKind: 'rectangle',
      x: 140,
      y: 120,
      value: 'Draft',
    })

    await act(async () => ref.current?.updateEditingText('Launch plan'))
    await act(async () => ref.current?.commitEditingText())
    expect(ref.current?.elements).toEqual([
      expect.objectContaining({
        id: 'shape-1',
        kind: 'rectangle',
        rotation: 30,
        text: 'Launch plan',
      }),
    ])
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

  it('exposes explicit interaction states and cancels a live gesture cleanly', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
    ])
    await act(async () => ref.current?.selectElement('rect-1'))

    await act(async () => {
      ref.current?.beginElementPointer('rect-1', { x: 20, y: 30 })
    })
    expect(ref.current?.interactionState).toBe('translating')

    await act(async () => {
      ref.current?.movePointer({
        world: { x: 120, y: 130 },
        screen: { x: 120, y: 130 },
      })
    })
    expect(ref.current?.isTransacting).toBe(true)
    expect(ref.current?.elements[0]).toMatchObject({ x: 110, y: 120 })

    await act(async () => ref.current?.cancelInteraction())
    expect(ref.current?.interactionState).toBe('idle')
    expect(ref.current?.isTransacting).toBe(false)
    expect(ref.current?.elements[0]).toMatchObject({ x: 10, y: 20 })
    expect(ref.current?.canUndo).toBe(false)
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

  it('snaps translations to nearby element edges and clears guides on commit', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'moving', kind: 'rectangle', x: 0, y: 20, width: 100, height: 60 },
      { id: 'target', kind: 'rectangle', x: 200, y: 20, width: 100, height: 60 },
    ])

    await act(async () => {
      ref.current?.beginElementPointer('moving', { x: 10, y: 30 })
      ref.current?.movePointer({
        world: { x: 108, y: 30 },
        screen: { x: 108, y: 30 },
      })
    })

    expect(ref.current?.elements.find((element) => element.id === 'moving'))
      .toMatchObject({ x: 100 })
    expect(ref.current?.snapGuides).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: 'x', position: 200 }),
    ]))

    await act(async () => ref.current?.endPointer({ x: 108, y: 30 }))
    expect(ref.current?.snapGuides).toEqual([])
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
    })
    expect(ref.current?.activeResizeHandle).toBe('south-east')
    await act(async () => {
      ref.current?.movePointer({
        world: { x: 210, y: 140 },
        screen: { x: 210, y: 140 },
      })
      ref.current?.endPointer({ x: 210, y: 140 })
    })
    expect(ref.current?.elements[0]).toMatchObject({ width: 200, height: 120 })

    await act(async () => {
      ref.current?.beginRotatePointer({ x: 110, y: -20 })
    })
    expect(ref.current?.interactionState).toBe('rotating')
    await act(async () => {
      ref.current?.movePointer({
        world: { x: 270, y: 80 },
        screen: { x: 270, y: 80 },
        shiftKey: true,
      })
      ref.current?.endPointer({ x: 270, y: 80 })
    })
    expect(ref.current?.elements[0].rotation).toBe(90)
  })

  it('snaps an active resize edge to nearby element geometry', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'resizing', kind: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
      { id: 'target', kind: 'rectangle', x: 200, y: 0, width: 100, height: 100 },
    ])
    await act(async () => ref.current?.selectElement('resizing'))
    await act(async () => {
      ref.current?.beginResizePointer('east')
      ref.current?.movePointer({
        world: { x: 198, y: 50 },
        screen: { x: 198, y: 50 },
      })
    })

    expect(ref.current?.elements.find((element) => element.id === 'resizing'))
      .toMatchObject({ x: 0, width: 200 })
    expect(ref.current?.snapGuides).toEqual([
      expect.objectContaining({ axis: 'x', position: 200 }),
    ])
    await act(async () => ref.current?.endPointer({ x: 198, y: 50 }))
    expect(ref.current?.snapGuides).toEqual([])
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

  it('creates a translucent highlight stroke without changing the drawing defaults', async () => {
    const ref = await renderHook()
    await act(async () => ref.current?.setTool('highlight'))
    await act(async () => {
      ref.current?.beginCanvasPointer({
        world: { x: 20, y: 30 },
        screen: { x: 20, y: 30 },
      })
      ref.current?.movePointer({
        world: { x: 120, y: 70 },
        screen: { x: 120, y: 70 },
      })
      ref.current?.endPointer({ x: 120, y: 70 })
    })

    expect(ref.current?.elements[0]).toMatchObject({
      kind: 'stroke',
      style: expect.objectContaining({
        dashStyle: 'solid',
        opacity: 0.45,
        strokeColor: 'yellow',
        strokeSize: 'xl',
      }),
    })

    await act(async () => ref.current?.setTool('pen'))
    await act(async () => {
      ref.current?.beginCanvasPointer({
        world: { x: 30, y: 100 },
        screen: { x: 30, y: 100 },
      })
      ref.current?.movePointer({
        world: { x: 130, y: 120 },
        screen: { x: 130, y: 120 },
      })
      ref.current?.endPointer({ x: 130, y: 120 })
    })
    expect(ref.current?.elements[1]).toMatchObject({
      kind: 'stroke',
      style: expect.objectContaining({
        opacity: 1,
        strokeColor: 'ink',
        strokeSize: 'm',
      }),
    })
  })

  it('binds connector endpoints and keeps them attached during a live move', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'left', kind: 'rectangle', x: 0, y: 0, width: 100, height: 80 },
      { id: 'right', kind: 'rectangle', x: 200, y: 0, width: 100, height: 80 },
    ])
    await act(async () => ref.current?.setTool('connector'))
    await act(async () => {
      ref.current?.beginCanvasPointer({
        world: { x: 100, y: 40 },
        screen: { x: 100, y: 40 },
        targetElementId: 'left',
      })
      ref.current?.movePointer({
        world: { x: 200, y: 40 },
        screen: { x: 200, y: 40 },
      })
      ref.current?.endPointer({ x: 200, y: 40 }, 'right')
    })

    const connector = ref.current?.elements.find((element) => element.kind === 'connector')
    expect(connector).toMatchObject({
      start: { x: 100, y: 40 },
      end: { x: 200, y: 40 },
    })
    expect(ref.current?.records.filter((record) => record.record_type === 'binding'))
      .toHaveLength(2)

    await act(async () => {
      ref.current?.beginElementPointer('right', { x: 210, y: 30 })
      ref.current?.movePointer({
        world: { x: 260, y: 30 },
        screen: { x: 260, y: 30 },
      })
      ref.current?.endPointer({ x: 260, y: 30 })
    })
    expect(ref.current?.elements.find((element) => element.id === 'right'))
      .toMatchObject({ x: 250 })
    expect(ref.current?.elements.find((element) => element.kind === 'connector'))
      .toMatchObject({ end: { x: 250, y: 40 } })

    await act(async () => ref.current?.undo())
    expect(ref.current?.elements.find((element) => element.kind === 'connector'))
      .toMatchObject({ end: { x: 200, y: 40 } })
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

  it('reorders a selection through the shared Board command layer', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
      { id: 'rect-2', kind: 'rectangle', x: 20, y: 30, width: 100, height: 60 },
      { id: 'rect-3', kind: 'rectangle', x: 30, y: 40, width: 100, height: 60 },
    ])
    await act(async () => ref.current?.selectElement('rect-1'))
    await act(async () => ref.current?.reorderSelection('front'))

    expect(ref.current?.elements.map((element) => element.id)).toEqual([
      'rect-2',
      'rect-3',
      'rect-1',
    ])
    await act(async () => ref.current?.undo())
    expect(ref.current?.elements.map((element) => element.id)).toEqual([
      'rect-1',
      'rect-2',
      'rect-3',
    ])
  })

  it('groups a selection and transforms the container with all descendants', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
      { id: 'rect-2', kind: 'rectangle', x: 160, y: 20, width: 100, height: 60 },
      { id: 'rect-3', kind: 'rectangle', x: 320, y: 20, width: 100, height: 60 },
    ])
    await act(async () => ref.current?.selectElement('rect-1'))
    await act(async () => ref.current?.selectElement('rect-2', { additive: true }))
    await act(async () => ref.current?.groupSelection('group'))

    const group = ref.current?.selectedElements[0]
    expect(group).toMatchObject({ kind: 'rectangle', shapeStyle: 'group' })
    expect(ref.current?.elements.filter((element) => element.parentId === group?.id))
      .toHaveLength(2)

    await act(async () => {
      ref.current?.beginElementPointer('rect-1', { x: 20, y: 30 })
      ref.current?.movePointer({
        world: { x: 70, y: 80 },
        screen: { x: 70, y: 80 },
        altKey: true,
      })
      ref.current?.endPointer({ x: 70, y: 80 })
    })

    expect(ref.current?.selectedElementIds).toEqual([group?.id])
    expect(ref.current?.elements.find((element) => element.id === group?.id))
      .toMatchObject({ x: 52, y: 62 })
    expect(ref.current?.elements.find((element) => element.id === 'rect-1'))
      .toMatchObject({ x: 60, y: 70 })
    expect(ref.current?.elements.find((element) => element.id === 'rect-2'))
      .toMatchObject({ x: 210, y: 70 })

    await act(async () => ref.current?.ungroupSelection())
    expect(ref.current?.elements.find((element) => element.id === group?.id)).toBeUndefined()
    expect(ref.current?.elements.filter((element) => element.parentId)).toEqual([])
  })

  it('resizes and rotates a selected container with its descendant tree', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      {
        id: 'group-1',
        kind: 'rectangle',
        x: 0,
        y: 0,
        width: 220,
        height: 120,
        shapeStyle: 'group',
      },
      {
        id: 'rect-1',
        kind: 'rectangle',
        parentId: 'group-1',
        x: 10,
        y: 10,
        width: 80,
        height: 40,
      },
      {
        id: 'rect-2',
        kind: 'rectangle',
        parentId: 'group-1',
        x: 130,
        y: 10,
        width: 80,
        height: 40,
      },
    ])
    await act(async () => ref.current?.selectElement('rect-1'))
    expect(ref.current?.selectedElementIds).toEqual(['group-1'])

    await act(async () => {
      ref.current?.beginResizePointer('south-east')
      ref.current?.movePointer({
        world: { x: 440, y: 240 },
        screen: { x: 440, y: 240 },
      })
      ref.current?.endPointer({ x: 440, y: 240 })
    })
    expect(ref.current?.elements.find((element) => element.id === 'group-1'))
      .toMatchObject({ x: 0, y: 0, width: 440, height: 240 })
    expect(ref.current?.elements.find((element) => element.id === 'rect-1'))
      .toMatchObject({ x: 20, y: 20, width: 160, height: 80, parentId: 'group-1' })
    expect(ref.current?.elements.find((element) => element.id === 'rect-2'))
      .toMatchObject({ x: 260, y: 20, width: 160, height: 80, parentId: 'group-1' })

    await act(async () => ref.current?.undo())
    await act(async () => ref.current?.selectElement('group-1'))
    await act(async () => {
      ref.current?.beginRotatePointer({ x: 110, y: -50 })
      ref.current?.movePointer({
        world: { x: 220, y: 60 },
        screen: { x: 220, y: 60 },
        shiftKey: true,
      })
      ref.current?.endPointer({ x: 220, y: 60 })
    })
    expect(ref.current?.elements.find((element) => element.id === 'group-1'))
      .toMatchObject({ x: 0, y: 0, rotation: 90 })
    const firstChild = ref.current?.elements.find((element): element is Extract<
      WhiteboardElement,
      { kind: 'rectangle' }
    > => element.id === 'rect-1' && element.kind === 'rectangle')
    const secondChild = ref.current?.elements.find((element): element is Extract<
      WhiteboardElement,
      { kind: 'rectangle' }
    > => element.id === 'rect-2' && element.kind === 'rectangle')
    expect(firstChild).toMatchObject({ rotation: 90, parentId: 'group-1' })
    expect(firstChild?.x).toBeCloseTo(100)
    expect(firstChild?.y).toBeCloseTo(-20)
    expect(secondChild).toMatchObject({ rotation: 90, parentId: 'group-1' })
    expect(secondChild?.x).toBeCloseTo(100)
    expect(secondChild?.y).toBeCloseTo(100)
  })

  it('adopts elements into frames on drop and releases them when dragged out', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      {
        id: 'frame-1',
        kind: 'rectangle',
        x: 0,
        y: 0,
        width: 300,
        height: 240,
        shapeStyle: 'frame',
        shapeType: 'frame',
      },
      { id: 'rect-1', kind: 'rectangle', x: 400, y: 40, width: 80, height: 60 },
    ])

    await act(async () => {
      ref.current?.beginElementPointer('rect-1', { x: 410, y: 50 })
      ref.current?.movePointer({
        world: { x: 110, y: 100 },
        screen: { x: 110, y: 100 },
        altKey: true,
      })
      ref.current?.endPointer({ x: 110, y: 100 })
    })
    expect(ref.current?.elements.find((element) => element.id === 'rect-1'))
      .toMatchObject({ parentId: 'frame-1' })

    await act(async () => {
      ref.current?.beginElementPointer('rect-1', { x: 110, y: 100 })
      ref.current?.movePointer({
        world: { x: 510, y: 100 },
        screen: { x: 510, y: 100 },
        altKey: true,
      })
      ref.current?.endPointer({ x: 510, y: 100 })
    })
    expect(ref.current?.elements.find((element) => element.id === 'rect-1')?.parentId)
      .toBeUndefined()
  })

  it('pastes remapped elements as one undoable Board command', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
      { id: 'rect-2', kind: 'rectangle', x: 160, y: 20, width: 100, height: 60 },
    ])
    const text = createBoardClipboardText(ref.current!.records, ['rect-1', 'rect-2'])

    await act(async () => ref.current?.pasteClipboardText(text))

    expect(ref.current?.elements).toHaveLength(4)
    expect(ref.current?.elements.slice(2)).toEqual([
      expect.objectContaining({ x: 34, y: 44 }),
      expect.objectContaining({ x: 184, y: 44 }),
    ])
    expect(ref.current?.selectedElementIds).toEqual(
      ref.current?.elements.slice(2).map((element) => element.id),
    )

    await act(async () => ref.current?.undo())
    expect(ref.current?.elements.map((element) => element.id)).toEqual(['rect-1', 'rect-2'])
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

  it('zooms to the selection, restores actual size, and recenters from navigation controls', async () => {
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
    ])
    await act(async () => ref.current?.selectElement('rect-1'))
    await act(async () => ref.current?.zoomToSelection({ x: 800, y: 600 }))

    expect(ref.current?.viewport).toEqual({ x: -40, y: -25, zoom: 4 })

    await act(async () => ref.current?.actualSize({ x: 800, y: 600 }))
    expect(ref.current?.viewport).toEqual({ x: -340, y: -250, zoom: 1 })

    await act(async () => ref.current?.centerViewportAt(
      { x: 500, y: 400 },
      { x: 800, y: 600 },
    ))
    expect(ref.current?.viewport).toEqual({ x: 100, y: 100, zoom: 1 })
    expect(ref.current?.canCameraBack).toBe(true)

    await act(async () => ref.current?.cameraBack())
    expect(ref.current?.viewport).toEqual({ x: -340, y: -250, zoom: 1 })
    await act(async () => ref.current?.cameraBack())
    expect(ref.current?.viewport).toEqual({ x: -40, y: -25, zoom: 4 })
    expect(ref.current?.canCameraForward).toBe(true)
    await act(async () => ref.current?.cameraForward())
    expect(ref.current?.viewport).toEqual({ x: -340, y: -250, zoom: 1 })
  })

  it('records completed pans in camera history and restores canceled pans', async () => {
    const ref = await renderHook()
    await act(async () => ref.current?.setTool('hand'))
    await act(async () => {
      ref.current?.beginCanvasPointer({
        world: { x: 0, y: 0 },
        screen: { x: 0, y: 0 },
      })
      ref.current?.movePointer({
        world: { x: 100, y: 60 },
        screen: { x: 100, y: 60 },
      })
    })
    expect(ref.current?.viewport).toEqual({ x: -100, y: -60, zoom: 1 })
    await act(async () => ref.current?.cancelInteraction())
    expect(ref.current?.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(ref.current?.canCameraBack).toBe(false)

    await act(async () => {
      ref.current?.beginCanvasPointer({
        world: { x: 0, y: 0 },
        screen: { x: 0, y: 0 },
      })
      ref.current?.movePointer({
        world: { x: 80, y: 40 },
        screen: { x: 80, y: 40 },
      })
      ref.current?.endPointer({ x: 80, y: 40 })
    })
    expect(ref.current?.viewport).toEqual({ x: -80, y: -40, zoom: 1 })
    expect(ref.current?.canCameraBack).toBe(true)
    await act(async () => ref.current?.cameraBack())
    expect(ref.current?.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('exports the current Board as a standalone SVG download', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:kition-board')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    })
    let downloadedFilename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      downloadedFilename = this.download
    })
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
    ])

    let exported = false
    await act(async () => {
      exported = await ref.current!.exportSvg('Launch / Review')
    })

    expect(exported).toBe(true)
    expect(downloadedFilename).toBe('Launch _ Review.svg')
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:kition-board')
  })

  it('rasterizes the current Board into a bounded PNG download', async () => {
    let objectUrlCount = 0
    const createObjectURL = vi.fn((_blob: Blob) => `blob:kition-${++objectUrlCount}`)
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    })
    class FakeImage {
      decoding = ''
      onerror: (() => void) | null = null
      onload: (() => void) | null = null

      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', FakeImage)
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['png-bytes'], { type: 'image/png' }))
    })
    let downloadedFilename = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      downloadedFilename = this.download
    })
    const ref = await renderHook()
    await replaceElements(ref, [
      { id: 'rect-1', kind: 'rectangle', x: 10, y: 20, width: 100, height: 60 },
    ])

    let exported = false
    await act(async () => {
      exported = await ref.current!.exportPng('Launch Review')
    })

    expect(exported).toBe(true)
    expect(downloadedFilename).toBe('Launch Review.png')
    expect(drawImage).toHaveBeenCalledOnce()
    expect(createObjectURL).toHaveBeenCalledTimes(2)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:kition-1')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:kition-2')
  })
})
