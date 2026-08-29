import { describe, expect, it } from 'vitest'

import type { BoardBindingRecord } from './boardRecords'
import {
  getWhiteboardMindMapGraph,
  getWhiteboardMindMapNodePlacement,
  getWhiteboardMindMapPresentation,
  layoutWhiteboardMindMap,
} from './whiteboardMindMap'
import type {
  WhiteboardConnectorElement,
  WhiteboardElement,
  WhiteboardRectangleElement,
} from './whiteboardTypes'

const root = mindNode('root', 400, 300, { mindMapDirection: 'both' })
const left = mindNode('left', 100, 180)
const right = mindNode('right', 700, 180)
const grandchild = mindNode('grandchild', 980, 260)
const connectors: WhiteboardConnectorElement[] = [
  connector('root-left'),
  connector('root-right'),
  connector('right-grandchild'),
]
const elements: WhiteboardElement[] = [
  ...connectors,
  root,
  left,
  right,
  grandchild,
]
const bindings: BoardBindingRecord[] = [
  ...edgeBindings('root-left', 'root', 'left'),
  ...edgeBindings('root-right', 'root', 'right'),
  ...edgeBindings('right-grandchild', 'right', 'grandchild'),
]

describe('whiteboard mind map layout', () => {
  it('reconstructs the connected hierarchy from connector bindings', () => {
    const graph = getWhiteboardMindMapGraph({ bindings, elements, nodeId: 'grandchild' })

    expect(graph).not.toBeNull()
    expect(graph?.rootId).toBe('root')
    expect(graph?.direction).toBe('both')
    expect(graph?.childrenById.get('root')).toEqual(['left', 'right'])
    expect(graph?.childrenById.get('right')).toEqual(['grandchild'])
    expect(graph?.parentById.get('grandchild')).toBe('right')
    expect(graph?.edges).toHaveLength(3)
  })

  it.each([
    ['right', 1, 0],
    ['left', -1, 0],
    ['down', 0, 1],
  ] as const)('lays out the full tree toward %s while keeping the root fixed', (
    direction,
    horizontalSign,
    verticalSign,
  ) => {
    const layout = layoutWhiteboardMindMap({ bindings, direction, elements, nodeId: 'right' })
    const byId = new Map(layout.map((node) => [node.id, node]))
    const nextRoot = byId.get('root')!
    const nextRight = byId.get('right')!
    const nextGrandchild = byId.get('grandchild')!

    expect(center(nextRoot)).toEqual(center(root))
    expect(nextRoot.mindMapDirection).toBe(direction)
    if (horizontalSign) {
      expect(Math.sign(center(nextRight).x - center(nextRoot).x)).toBe(horizontalSign)
      expect(Math.sign(center(nextGrandchild).x - center(nextRight).x)).toBe(horizontalSign)
    }
    if (verticalSign) {
      expect(Math.sign(center(nextRight).y - center(nextRoot).y)).toBe(verticalSign)
      expect(Math.sign(center(nextGrandchild).y - center(nextRight).y)).toBe(verticalSign)
    }
  })

  it('preserves existing left and right branches in a bidirectional layout', () => {
    const layout = layoutWhiteboardMindMap({
      bindings,
      direction: 'both',
      elements,
      nodeId: 'root',
    })
    const byId = new Map(layout.map((node) => [node.id, node]))
    const rootCenter = center(byId.get('root')!)

    expect(center(byId.get('left')!).x).toBeLessThan(rootCenter.x)
    expect(center(byId.get('right')!).x).toBeGreaterThan(rootCenter.x)
    expect(center(byId.get('grandchild')!).x).toBeGreaterThan(center(byId.get('right')!).x)
  })

  it('places new children on the active growth axis', () => {
    const graph = getWhiteboardMindMapGraph({ bindings, elements, nodeId: 'right' })!
    const horizontal = getWhiteboardMindMapNodePlacement({
      graph,
      parentId: 'right',
      width: 190,
      height: 68,
    })!
    expect(horizontal.x).toBeGreaterThan(right.x + right.width)

    const downGraph = { ...graph, direction: 'down' as const }
    const vertical = getWhiteboardMindMapNodePlacement({
      graph: downGraph,
      parentId: 'right',
      width: 190,
      height: 68,
    })!
    expect(vertical.y).toBeGreaterThan(right.y + right.height)
  })

  it('hides a collapsed branch without deleting its stored descendants', () => {
    const collapsedElements = elements.map((element) => (
      element.id === 'right' && element.kind === 'rectangle'
        ? { ...element, mindMapCollapsed: true }
        : element
    ))
    const presentation = getWhiteboardMindMapPresentation({
      bindings,
      elements: collapsedElements,
    })

    expect(presentation.hiddenElementIds.has('right')).toBe(false)
    expect(presentation.hiddenElementIds.has('grandchild')).toBe(true)
    expect(presentation.hiddenElementIds.has('right-grandchild')).toBe(true)
    expect(presentation.hiddenElementIds.has('root-right')).toBe(false)
    expect(presentation.managedConnectorIds).toEqual(new Set([
      'root-left',
      'root-right',
      'right-grandchild',
    ]))
  })

  it('keeps first-level branch sides stable in a bidirectional layout', () => {
    const layout = layoutWhiteboardMindMap({
      bindings,
      direction: 'both',
      elements,
      nodeId: 'root',
    })
    const byId = new Map(layout.map((node) => [node.id, node]))

    expect(byId.get('left')?.mindMapBranchSide).toBe('left')
    expect(byId.get('right')?.mindMapBranchSide).toBe('right')
  })
})

function mindNode(
  id: string,
  x: number,
  y: number,
  extra: Partial<WhiteboardRectangleElement> = {},
): WhiteboardRectangleElement {
  return {
    id,
    kind: 'rectangle',
    x,
    y,
    width: 200,
    height: 80,
    shapeStyle: 'mind-node',
    ...extra,
  }
}

function connector(id: string): WhiteboardConnectorElement {
  return {
    id,
    kind: 'connector',
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  }
}

function edgeBindings(
  connectorId: string,
  parentId: string,
  childId: string,
): BoardBindingRecord[] {
  return [
    binding(connectorId, 'start', parentId),
    binding(connectorId, 'end', childId),
  ]
}

function binding(
  connectorId: string,
  terminal: 'start' | 'end',
  targetId: string,
): BoardBindingRecord {
  return {
    record_type: 'binding',
    id: `binding:${connectorId}:${terminal}`,
    binding_type: 'connector',
    from_id: connectorId,
    to_id: targetId,
    terminal,
    to_anchor: { x: 0.5, y: 0.5 },
  }
}

function center(node: WhiteboardRectangleElement) {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  }
}
