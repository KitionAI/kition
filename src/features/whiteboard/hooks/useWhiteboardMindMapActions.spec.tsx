import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  useWhiteboardEditor,
  type WhiteboardEditorController,
} from './useWhiteboardEditor'
import { createBoardRecordsFromElements } from '../lib/boardRecords'
import { instantiateWhiteboardTemplate } from '../lib/whiteboardTemplates'
import type { WhiteboardRectangleElement } from '../lib/whiteboardTypes'

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

describe('useWhiteboardEditor mind map actions', () => {
  it('adds a bound child as one undoable operation and starts text editing', async () => {
    const ref = await renderMindMapEditor()
    const initialNodeCount = mindNodes(ref.current!).length
    const initialConnectorCount = connectors(ref.current!).length
    const initialBindingCount = bindings(ref.current!).length
    const rootNode = findNode(ref.current!, 'mindMap.topic')
    await act(async () => ref.current?.selectElement(rootNode.id))

    let childId: string | false = false
    await act(async () => {
      childId = ref.current?.addMindMapChild('New child') || false
    })

    expect(childId).not.toBe(false)
    expect(mindNodes(ref.current!)).toHaveLength(initialNodeCount + 1)
    expect(connectors(ref.current!)).toHaveLength(initialConnectorCount + 1)
    expect(bindings(ref.current!)).toHaveLength(initialBindingCount + 2)
    expect(connectors(ref.current!).every((connector) => (
      connector.connectorType === 'curved'
        && connector.mindMapBranchAxis === 'horizontal'
        && connector.endArrowhead === 'none'
    ))).toBe(true)
    expect(ref.current?.editingText).toMatchObject({
      elementId: childId,
      value: 'New child',
    })
    expect(ref.current?.selectedElementIds).toEqual([childId])

    await act(async () => ref.current?.undo())
    expect(mindNodes(ref.current!)).toHaveLength(initialNodeCount)
    expect(connectors(ref.current!)).toHaveLength(initialConnectorCount)
    expect(bindings(ref.current!)).toHaveLength(initialBindingCount)
  })

  it('adds a sibling and relays out the connected tree with one-step undo', async () => {
    const ref = await renderMindMapEditor()
    const branch = findNode(ref.current!, 'mindMap.research')
    await act(async () => ref.current?.selectElement(branch.id))
    expect(ref.current?.canAddMindMapSibling).toBe(true)

    const beforeSiblingCount = mindNodes(ref.current!).length
    await act(async () => ref.current?.addMindMapSibling('Peer'))
    expect(mindNodes(ref.current!)).toHaveLength(beforeSiblingCount + 1)
    await act(async () => ref.current?.undo())
    expect(mindNodes(ref.current!)).toHaveLength(beforeSiblingCount)

    const rootNode = findNode(ref.current!, 'mindMap.topic')
    const beforePositions = nodePositions(ref.current!)
    await act(async () => ref.current?.selectElement(rootNode.id))
    await act(async () => ref.current?.setMindMapDirection('left'))

    const nextRoot = findNode(ref.current!, 'mindMap.topic')
    const rootCenterX = nextRoot.x + nextRoot.width / 2
    expect(nextRoot).toMatchObject({
      x: rootNode.x,
      y: rootNode.y,
      mindMapDirection: 'left',
    })
    expect(mindNodes(ref.current!).filter((node) => node.id !== nextRoot.id).every((node) => (
      node.x + node.width / 2 < rootCenterX
    ))).toBe(true)
    expect(connectors(ref.current!).every((connector) => (
      connector.connectorType === 'curved'
        && connector.mindMapBranchAxis === 'horizontal'
    ))).toBe(true)
    expect(bindings(ref.current!).filter((binding) => binding.terminal === 'start').every((binding) => (
      binding.to_anchor?.x === 0 && binding.to_anchor.y === 0.5
    ))).toBe(true)
    expect(bindings(ref.current!).filter((binding) => binding.terminal === 'end').every((binding) => (
      binding.to_anchor?.x === 1 && binding.to_anchor.y === 0.5
    ))).toBe(true)

    await act(async () => ref.current?.undo())
    expect(findNode(ref.current!, 'mindMap.topic').mindMapDirection).toBe('right')
    expect(nodePositions(ref.current!)).toEqual(beforePositions)
  })

  it('uses vertical curves and centered edge anchors for a down layout', async () => {
    const ref = await renderMindMapEditor()
    const rootNode = findNode(ref.current!, 'mindMap.topic')
    await act(async () => ref.current?.selectElement(rootNode.id))
    await act(async () => ref.current?.setMindMapDirection('down'))

    expect(connectors(ref.current!).every((connector) => (
      connector.connectorType === 'curved'
        && connector.mindMapBranchAxis === 'vertical'
        && connector.endArrowhead === 'none'
    ))).toBe(true)
    expect(bindings(ref.current!).filter((binding) => binding.terminal === 'start').every((binding) => (
      binding.to_anchor?.x === 0.5 && binding.to_anchor.y === 1
    ))).toBe(true)
    expect(bindings(ref.current!).filter((binding) => binding.terminal === 'end').every((binding) => (
      binding.to_anchor?.x === 0.5 && binding.to_anchor.y === 0
    ))).toBe(true)
  })

  it('uses Tab for a child and Enter for a sibling', async () => {
    const ref = await renderMindMapEditor()
    const rootNode = findNode(ref.current!, 'mindMap.topic')
    await act(async () => ref.current?.selectElement(rootNode.id))

    const beforeChildCount = mindNodes(ref.current!).length
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    await act(async () => window.dispatchEvent(tab))
    expect(tab.defaultPrevented).toBe(true)
    expect(mindNodes(ref.current!)).toHaveLength(beforeChildCount + 1)
    expect(ref.current?.editingText?.value).toBe('')

    await act(async () => ref.current?.cancelEditingText())
    expect(mindNodes(ref.current!)).toHaveLength(beforeChildCount)
    const branch = findNode(ref.current!, 'mindMap.research')
    await act(async () => ref.current?.selectElement(branch.id))
    const beforeSiblingCount = mindNodes(ref.current!).length
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    await act(async () => window.dispatchEvent(enter))
    expect(enter.defaultPrevented).toBe(true)
    expect(mindNodes(ref.current!)).toHaveLength(beforeSiblingCount + 1)
    expect(ref.current?.editingText?.value).toBe('')
  })

  it('collapses and expands a branch without deleting its descendants', async () => {
    const ref = await renderMindMapEditor()
    const branch = findNode(ref.current!, 'mindMap.research')
    const descendant = findNode(ref.current!, 'mindMap.questions')
    const descendantBinding = bindings(ref.current!).find((binding) => (
      binding.to_id === descendant.id && binding.terminal === 'end'
    ))
    expect(descendantBinding).toBeDefined()

    await act(async () => ref.current?.toggleMindMapCollapsed(branch.id))
    expect(findNode(ref.current!, 'mindMap.research').mindMapCollapsed).toBe(true)
    expect(ref.current?.mindMapHiddenElementIds.has(descendant.id)).toBe(true)
    expect(ref.current?.mindMapHiddenElementIds.has(descendantBinding!.from_id)).toBe(true)
    expect(mindNodes(ref.current!)).toHaveLength(4)

    await act(async () => ref.current?.toggleMindMapCollapsed(branch.id))
    expect(findNode(ref.current!, 'mindMap.research').mindMapCollapsed).toBeFalsy()
    expect(ref.current?.mindMapHiddenElementIds.has(descendant.id)).toBe(false)

    await act(async () => ref.current?.undo())
    expect(findNode(ref.current!, 'mindMap.research').mindMapCollapsed).toBe(true)
  })
})

async function renderMindMapEditor() {
  const ref: { current: WhiteboardEditorController | null } = { current: null }
  function Harness() {
    ref.current = useWhiteboardEditor()
    return null
  }
  await act(async () => {
    root = createRoot(container)
    root.render(createElement(Harness))
  })
  const instance = instantiateWhiteboardTemplate(
    'mind-map',
    { x: 800, y: 600 },
    (key) => key,
  )
  await act(async () => ref.current?.replaceDocument({
    records: [
      ...createBoardRecordsFromElements(instance.elements, 'Mind map'),
      ...instance.bindings,
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  }))
  return ref
}

function mindNodes(controller: WhiteboardEditorController) {
  return controller.elements.filter((element): element is WhiteboardRectangleElement => (
    element.kind === 'rectangle' && element.shapeStyle === 'mind-node'
  ))
}

function findNode(controller: WhiteboardEditorController, text: string) {
  return mindNodes(controller).find((node) => node.text === text)!
}

function connectors(controller: WhiteboardEditorController) {
  return controller.elements.filter((element) => element.kind === 'connector')
}

function bindings(controller: WhiteboardEditorController) {
  return controller.records.filter((record) => record.record_type === 'binding')
}

function nodePositions(controller: WhiteboardEditorController) {
  return Object.fromEntries(mindNodes(controller).map((node) => [node.id, {
    x: node.x,
    y: node.y,
  }]))
}
