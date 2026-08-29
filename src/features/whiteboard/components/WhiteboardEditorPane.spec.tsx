import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  importWorkspaceImageFromFile,
  readWorkspaceDocument,
  writeWorkspaceDocument,
} from '@/services/desktop'
import {
  buildBoardDocument,
  createEmptyBoardDocument,
  serializeBoardDocument,
} from '../lib/boardSerialization'
import { createBoardRecordsFromElements } from '../lib/boardRecords'
import { WhiteboardEditorPane } from './WhiteboardEditorPane'
import type { WhiteboardAgentBridge } from '../lib/whiteboardAgentBridge'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/services/desktop', () => ({
  importWorkspaceImageFromFile: vi.fn(),
  isDesktopRuntime: vi.fn(() => true),
  readWorkspaceDocument: vi.fn(),
  resolvePublicFileURL: vi.fn((path: string) => path),
  writeWorkspaceDocument: vi.fn(),
}))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.mocked(readWorkspaceDocument).mockResolvedValue({
    path: 'Planning.kiboard',
    name: 'Planning.kiboard',
    format: 'board',
    content: serializeBoardDocument(createEmptyBoardDocument('Planning')),
  })
  vi.mocked(writeWorkspaceDocument).mockResolvedValue({} as never)
  vi.mocked(importWorkspaceImageFromFile).mockResolvedValue({
    importedPath: 'Attachments/imported.png',
    relativePath: 'imported.png',
  })
})

afterEach(async () => {
  vi.useRealTimers()
  await act(async () => root?.unmount())
  root = null
  container.remove()
})

describe('WhiteboardEditorPane', () => {
  it('culls distant committed elements from the SVG scene while retaining Board records', async () => {
    vi.mocked(readWorkspaceDocument).mockResolvedValueOnce({
      path: 'Planning.kiboard',
      name: 'Planning.kiboard',
      format: 'board',
      content: serializeBoardDocument(buildBoardDocument({
        title: 'Planning',
        viewport: { x: 0, y: 0, zoom: 1 },
        records: createBoardRecordsFromElements([
          { id: 'visible', kind: 'rectangle', x: 40, y: 40, width: 100, height: 80 },
          { id: 'distant', kind: 'rectangle', x: 5000, y: 5000, width: 100, height: 80 },
        ], 'Planning'),
      })),
    })

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WhiteboardEditorPane, {
        path: 'Planning.kiboard',
        title: 'Planning',
      }))
      await Promise.resolve()
    })

    const scene = container.querySelector('[data-testid="whiteboard-svg-scene"]')
    expect(scene?.getAttribute('data-rendered-element-count')).toBe('1')
    expect(scene?.querySelector('[data-element-id="visible"]')).not.toBeNull()
    expect(scene?.querySelector('[data-element-id="distant"]')).toBeNull()
  })

  it('uses an accessible SVG scene without a Canvas renderer', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WhiteboardEditorPane, {
        path: 'Planning.kiboard',
        title: 'Planning',
      }))
      await Promise.resolve()
    })

    const scene = container.querySelector('[data-testid="whiteboard-svg-scene"]')
    expect(scene?.tagName.toLowerCase()).toBe('svg')
    expect(scene?.querySelector('title')?.textContent).toContain('Planning')
    expect(scene?.querySelector('desc')?.textContent?.length).toBeGreaterThan(0)
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-toolbar"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-toolbar"]')?.classList).toContain('bottom-4')
    expect(container.querySelector('[data-testid="whiteboard-toolbar"]')?.classList).toContain('left-1/2')
    expect(container.querySelector('[data-testid="whiteboard-top-actions"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-tool-rectangle"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-tool-highlight"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-undo"]')).not.toBeNull()

    const rectangleTool = container.querySelector(
      '[data-testid="whiteboard-tool-rectangle"]',
    ) as HTMLButtonElement
    const svg = scene as SVGSVGElement & {
      setPointerCapture: (pointerId: number) => void
      hasPointerCapture: (pointerId: number) => boolean
      releasePointerCapture: (pointerId: number) => void
    }
    const setPointerCapture = vi.fn()
    svg.setPointerCapture = setPointerCapture
    svg.hasPointerCapture = () => false
    svg.releasePointerCapture = () => {}
    Object.defineProperty(svg, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        top: 0,
        right: 800,
        bottom: 600,
        left: 0,
        toJSON: () => ({}),
      }),
    })

    const highlightTool = container.querySelector(
      '[data-testid="whiteboard-tool-highlight"]',
    ) as HTMLButtonElement
    await act(async () => highlightTool.click())
    expect(container.querySelector('[data-testid="whiteboard-style-panel"]')).not.toBeNull()

    await act(async () => rectangleTool.click())
    expect(rectangleTool.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      svg.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 120,
      }))
      svg.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true,
        button: 0,
        clientX: 260,
        clientY: 220,
      }))
      svg.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: 260,
        clientY: 220,
      }))
    })

    expect(container.querySelector('[data-element-id]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-selection"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-minimap"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-resize-south-east"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-rotate-handle"]')).not.toBeNull()
    for (const direction of ['north', 'east', 'south', 'west']) {
      expect(container.querySelector(
        `[data-testid="whiteboard-connection-handle-${direction}"]`,
      )).not.toBeNull()
    }
    expect(container.querySelector('[data-testid="whiteboard-rotation-guide"]')?.getAttribute(
      'stroke-dasharray',
    )).toBe('4 4')
    expect(container.querySelector('[data-testid="whiteboard-toggle-lock"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-style-panel"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-undo"]')?.hasAttribute('disabled')).toBe(false)

    const moreActions = container.querySelector(
      '[data-testid="whiteboard-more-actions"]',
    ) as HTMLButtonElement
    await act(async () => {
      moreActions.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
      }))
    })
    expect(document.querySelector('[data-testid="whiteboard-export-svg"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="whiteboard-export-png"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="whiteboard-camera-back"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="whiteboard-camera-forward"]')).not.toBeNull()

    const purpleFill = container.querySelector(
      '[data-testid="whiteboard-fill-color-purple"]',
    ) as HTMLButtonElement
    await act(async () => purpleFill.click())
    expect(container.querySelector('[data-element-id] rect')?.getAttribute('fill'))
      .toBe('hsl(var(--tint-lavender))')

    const moveArea = container.querySelector(
      '[data-testid="whiteboard-selection-move-area"]',
    ) as SVGRectElement
    expect(moveArea.style.cursor).toBe('default')

    setPointerCapture.mockClear()
    await act(async () => {
      moveArea.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 180,
        clientY: 170,
      }))
    })
    expect(setPointerCapture).toHaveBeenCalledOnce()
    expect(svg.classList.contains('cursor-move')).toBe(false)
    await act(async () => {
      svg.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true,
        button: 0,
        clientX: 230,
        clientY: 210,
      }))
    })
    expect(svg.classList.contains('cursor-move')).toBe(true)

    await act(async () => {
      svg.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: 230,
        clientY: 210,
      }))
    })

    const movedRectangle = container.querySelector('[data-element-id] rect')
    expect(movedRectangle?.getAttribute('x')).toBe('150')
    expect(movedRectangle?.getAttribute('y')).toBe('160')
    expect(svg.classList.contains('cursor-move')).toBe(false)
  })

  it('dismisses top action menus when another menu or an outside surface is used', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WhiteboardEditorPane, {
        path: 'Planning.kiboard',
        title: 'Planning',
      }))
      await Promise.resolve()
    })

    const moreTrigger = container.querySelector(
      '[data-testid="whiteboard-more-actions"]',
    ) as HTMLButtonElement

    const reopenedPageTrigger = container.querySelector(
      '[data-testid="whiteboard-page-trigger"]',
    ) as HTMLButtonElement
    await act(async () => {
      reopenedPageTrigger.click()
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="whiteboard-page-menu"]')).not.toBeNull()

    await act(async () => {
      moreTrigger.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
      }))
    })
    expect(document.querySelector('[data-testid="whiteboard-page-menu"]')).toBeNull()
    expect(document.querySelector('[data-testid="whiteboard-more-menu"]')).not.toBeNull()

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="whiteboard-more-menu"]')).toBeNull()
  })

  it('dismisses the page menu with Escape', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WhiteboardEditorPane, {
        path: 'Planning.kiboard',
        title: 'Planning',
      }))
      await Promise.resolve()
    })

    const escapePageTrigger = container.querySelector(
      '[data-testid="whiteboard-page-trigger"]',
    ) as HTMLButtonElement
    await act(async () => {
      escapePageTrigger.click()
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="whiteboard-page-menu"]')).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[data-testid="whiteboard-page-menu"]')).toBeNull()
  })

  it('opens Agent with the current selection as Whiteboard context', async () => {
    const onOpenAgent = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WhiteboardEditorPane, {
        agentAvailable: true,
        onOpenAgent,
        path: 'Planning.kiboard',
        title: 'Planning',
      }))
      await Promise.resolve()
    })

    const svg = container.querySelector(
      '[data-testid="whiteboard-svg-scene"]',
    ) as SVGSVGElement & {
      setPointerCapture: (pointerId: number) => void
      hasPointerCapture: (pointerId: number) => boolean
      releasePointerCapture: (pointerId: number) => void
    }
    svg.setPointerCapture = () => {}
    svg.hasPointerCapture = () => false
    svg.releasePointerCapture = () => {}
    Object.defineProperty(svg, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        top: 0,
        right: 800,
        bottom: 600,
        left: 0,
        toJSON: () => ({}),
      }),
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-testid="whiteboard-tool-rectangle"]',
      )?.click()
    })
    await act(async () => {
      svg.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 120,
      }))
      svg.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true,
        button: 0,
        clientX: 260,
        clientY: 220,
      }))
      svg.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: 260,
        clientY: 220,
      }))
    })

    const askAI = container.querySelector(
      '[data-testid="whiteboard-ask-ai"]',
    ) as HTMLButtonElement
    expect(askAI.disabled).toBe(false)
    expect(container.querySelector<HTMLSelectElement>(
      '#whiteboard-agent-scope-select',
    )?.value).toBe('viewport')

    await act(async () => askAI.click())

    expect(onOpenAgent).toHaveBeenCalledOnce()
    expect(container.querySelector<HTMLSelectElement>(
      '#whiteboard-agent-scope-select',
    )?.value).toBe('selection')
  })

  it('highlights a freehand line on hover, selects it on click, and clears selection outside', async () => {
    vi.mocked(readWorkspaceDocument).mockResolvedValueOnce({
      path: 'Planning.kiboard',
      name: 'Planning.kiboard',
      format: 'board',
      content: serializeBoardDocument(buildBoardDocument({
        title: 'Planning',
        viewport: { x: 0, y: 0, zoom: 1 },
        records: createBoardRecordsFromElements([{
          id: 'board-stroke-one',
          kind: 'stroke',
          points: [{ x: 80, y: 80 }, { x: 140, y: 180 }, { x: 220, y: 240 }],
        }], 'Planning'),
      })),
    })

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WhiteboardEditorPane, {
        path: 'Planning.kiboard',
        title: 'Planning',
      }))
      await Promise.resolve()
    })

    const svg = container.querySelector(
      '[data-testid="whiteboard-svg-scene"]',
    ) as SVGSVGElement & {
      setPointerCapture: (pointerId: number) => void
      hasPointerCapture: (pointerId: number) => boolean
      releasePointerCapture: (pointerId: number) => void
    }
    svg.setPointerCapture = () => {}
    svg.hasPointerCapture = () => false
    svg.releasePointerCapture = () => {}
    Object.defineProperty(svg, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        top: 0,
        right: 800,
        bottom: 600,
        left: 0,
        toJSON: () => ({}),
      }),
    })

    const stroke = container.querySelector('[data-element-id="board-stroke-one"]') as SVGGElement
    await act(async () => {
      stroke.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })
    expect(stroke.dataset.hovered).toBe('true')
    expect(stroke.style.cursor).toBe('move')
    expect(stroke.querySelectorAll('path')[1]?.getAttribute('stroke')).toBe('hsl(var(--brand))')

    await act(async () => {
      stroke.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 140,
        clientY: 180,
      }))
      svg.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: 140,
        clientY: 180,
      }))
    })
    expect(container.querySelector('[data-testid="whiteboard-selection"]')).not.toBeNull()

    await act(async () => {
      svg.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 500,
        clientY: 500,
      }))
      svg.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: 500,
        clientY: 500,
      }))
    })
    expect(container.querySelector('[data-testid="whiteboard-selection"]')).toBeNull()
  })

  it('keeps streamed AI changes provisional until accept and commits them as one undo step', async () => {
    let bridge: WhiteboardAgentBridge | null = null
    const onCancelAgent = vi.fn()
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WhiteboardEditorPane, {
        agentAvailable: true,
        agentBusy: true,
        onCancelAgent,
        onAgentBridgeChange: (_path: string, next: WhiteboardAgentBridge | null) => {
          bridge = next
        },
        path: 'Planning.kiboard',
        title: 'Planning',
      }))
      await Promise.resolve()
    })
    expect(bridge?.buildContext()?.scope).toBe('viewport')

    const patch = {
      type: 'whiteboard.patch' as const,
      schema_version: 1 as const,
      summary: 'Create a launch mind map',
      operations: [{
        op: 'element.create' as const,
        element: {
          id: 'launch-node',
          kind: 'mind_node' as const,
          bounds: { x: 120, y: 140, width: 180, height: 80 },
          text: 'Launch',
        },
      }],
    }

    await act(async () => bridge?.receivePatch(patch, true))
    expect(container.querySelector('[data-agent-element-id="launch-node"]')).not.toBeNull()
    expect(container.querySelector('[data-element-id="launch-node"]')).toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-agent-cancel"]')).not.toBeNull()

    await act(async () => bridge?.receivePatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Refine the launch node',
      operations: [{
        op: 'element.update',
        element_id: 'launch-node',
        changes: { text: 'Launch plan' },
      }],
    }, false))
    const accept = container.querySelector(
      '[data-testid="whiteboard-agent-accept"]',
    ) as HTMLButtonElement
    expect(accept).not.toBeNull()
    await act(async () => accept.click())

    expect(container.querySelector('[data-agent-element-id="launch-node"]')).toBeNull()
    expect(container.querySelector('[data-element-id="launch-node"]')?.textContent).toContain('Launch plan')

    const undo = container.querySelector('[data-testid="whiteboard-undo"]') as HTMLButtonElement
    await act(async () => undo.click())
    expect(container.querySelector('[data-element-id="launch-node"]')).toBeNull()

    await act(async () => bridge?.receivePatch(patch, false))
    const reject = container.querySelector(
      '[data-testid="whiteboard-agent-reject"]',
    ) as HTMLButtonElement
    await act(async () => reject.click())
    expect(container.querySelector('[data-agent-element-id="launch-node"]')).toBeNull()
    expect(container.querySelector('[data-element-id="launch-node"]')).toBeNull()

    await act(async () => bridge?.receivePatch(patch, true))
    const cancel = container.querySelector(
      '[data-testid="whiteboard-agent-cancel"]',
    ) as HTMLButtonElement
    await act(async () => cancel.click())
    expect(onCancelAgent).toHaveBeenCalledOnce()
    expect(container.querySelector('[data-agent-element-id="launch-node"]')).toBeNull()
  })

  it('previews AI mind-map connectors between bound nodes', async () => {
    let bridge: WhiteboardAgentBridge | null = null
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WhiteboardEditorPane, {
        agentAvailable: true,
        onAgentBridgeChange: (_path: string, next: WhiteboardAgentBridge | null) => {
          bridge = next
        },
        path: 'Planning.kiboard',
        title: 'Planning',
      }))
      await Promise.resolve()
    })

    await act(async () => bridge?.receivePatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Create a connected mind map',
      operations: [
        {
          op: 'element.create',
          element: {
            id: 'root-node',
            kind: 'mind_node',
            bounds: { x: 120, y: 140, width: 180, height: 80 },
            text: 'Root',
          },
        },
        {
          op: 'element.create',
          element: {
            id: 'branch-node',
            kind: 'mind_node',
            bounds: { x: 420, y: 260, width: 180, height: 80 },
            text: 'Branch',
          },
        },
        {
          op: 'connector.create',
          connector: {
            id: 'root-branch-connector',
            from_id: 'root-node',
            to_id: 'branch-node',
          },
        },
      ],
    }, false))

    expect(container.querySelector('[data-agent-element-id="root-branch-connector"]'))
      .not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-agent-accept"]'))
      .not.toBeNull()
  })

  it('selects a shape from the palette and renders its SVG geometry', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WhiteboardEditorPane, {
        path: 'Planning.kiboard',
        title: 'Planning',
      }))
      await Promise.resolve()
    })

    const shapeTool = container.querySelector(
      '[data-testid="whiteboard-tool-rectangle"]',
    ) as HTMLButtonElement
    await act(async () => shapeTool.click())
    expect(shapeTool.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-testid="whiteboard-shape-palette"]')).toBeNull()

    const shapeMenuTrigger = container.querySelector(
      '[data-testid="whiteboard-shape-menu-trigger"]',
    ) as HTMLButtonElement
    await act(async () => shapeMenuTrigger.click())
    expect(shapeMenuTrigger.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-testid="whiteboard-shape-palette"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-shape-x-box"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-shape-check-box"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="whiteboard-shape-check"]')).toBeNull()
    const diamond = container.querySelector('[data-testid="whiteboard-shape-diamond"]') as HTMLButtonElement
    await act(async () => diamond.click())
    expect(shapeMenuTrigger.getAttribute('aria-expanded')).toBe('false')
    expect(shapeTool.getAttribute('aria-label')).toContain('Diamond')

    const svg = container.querySelector('[data-testid="whiteboard-svg-scene"]') as SVGSVGElement & {
      setPointerCapture: (pointerId: number) => void
      hasPointerCapture: (pointerId: number) => boolean
      releasePointerCapture: (pointerId: number) => void
    }
    svg.setPointerCapture = () => {}
    svg.hasPointerCapture = () => false
    svg.releasePointerCapture = () => {}
    Object.defineProperty(svg, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0, y: 0, width: 800, height: 600,
        top: 0, right: 800, bottom: 600, left: 0,
        toJSON: () => ({}),
      }),
    })
    await act(async () => {
      svg.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 100,
      }))
      svg.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: 260,
        clientY: 220,
      }))
    })
    expect(container.querySelector('[data-element-id] polygon')).not.toBeNull()
  })

  it('edits a geometric shape label at its exact center on double click', async () => {
    vi.mocked(readWorkspaceDocument).mockResolvedValueOnce({
      path: 'Planning.kiboard',
      name: 'Planning.kiboard',
      format: 'board',
      content: serializeBoardDocument(buildBoardDocument({
        title: 'Planning',
        viewport: { x: 0, y: 0, zoom: 1 },
        records: createBoardRecordsFromElements([{
          id: 'shape-center',
          kind: 'rectangle',
          x: 40,
          y: 60,
          width: 200,
          height: 120,
          rotation: 30,
          shapeType: 'diamond',
          text: 'Draft',
        }], 'Planning'),
      })),
    })

    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WhiteboardEditorPane, {
        path: 'Planning.kiboard',
        title: 'Planning',
      }))
      await Promise.resolve()
    })

    const shape = container.querySelector(
      '[data-element-id="shape-center"] polygon',
    ) as SVGPolygonElement
    await act(async () => {
      shape.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    const editor = container.querySelector(
      '[data-testid="whiteboard-text-editor"]',
    ) as HTMLTextAreaElement
    expect(editor.dataset.anchor).toBe('shape-center')
    expect(editor.style.left).toBe('140px')
    expect(editor.style.top).toBe('120px')
    expect(editor.style.width).toBe('176px')
    expect(editor.style.textAlign).toBe('center')
    expect(editor.style.transform).toBe('translate(-50%, -50%) rotate(30deg)')

    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    await act(async () => {
      setValue?.call(editor, 'Launch plan')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }))
    })

    expect(container.querySelector('[data-testid="whiteboard-text-editor"]')).toBeNull()
    expect(container.querySelector('[data-element-id="shape-center"]')?.textContent)
      .toContain('Launch plan')
  })

  it('imports an image into Attachments and renders it as a portable SVG image element', async () => {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(WhiteboardEditorPane, {
        path: 'Planning.kiboard',
        title: 'Planning',
      }))
      await Promise.resolve()
    })

    const input = container.querySelector('[data-testid="whiteboard-image-input"]') as HTMLInputElement
    const file = new File(['image'], 'roadmap.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(importWorkspaceImageFromFile).toHaveBeenCalledWith({
      file,
      folder: 'Attachments',
      index: 1,
    })
    const imageElement = container.querySelector('[data-element-kind="image"]')
    expect(imageElement).not.toBeNull()
    expect(imageElement?.querySelector('image')?.getAttribute('href')).toContain('Attachments/imported.png')
  })
})
