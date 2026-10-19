import { describe, expect, it } from 'vitest'

import { getWhiteboardMindMapControlLanes } from './whiteboardMindMapControls'
import type { WhiteboardMindMapGraph } from './whiteboardMindMap'
import type { WhiteboardRectangleElement } from './whiteboardTypes'

const root = node('root', 100, 100, { mindMapDirection: 'right' })
const child = node('child', 400, 100)
const grandchild = node('grandchild', 700, 100)
const graph: WhiteboardMindMapGraph = {
  rootId: 'root',
  direction: 'right',
  nodes: [root, child, grandchild],
  childrenById: new Map([
    ['root', ['child']],
    ['child', ['grandchild']],
  ]),
  parentById: new Map([
    ['child', 'root'],
    ['grandchild', 'child'],
  ]),
  edges: [
    { connectorId: 'root-child', parentId: 'root', childId: 'child' },
    { connectorId: 'child-grandchild', parentId: 'child', childId: 'grandchild' },
  ],
}

describe('whiteboard mind map quick controls', () => {
  it('shows one add control on the root growth side', () => {
    const [lane] = getWhiteboardMindMapControlLanes({ graph, node: root, zoom: 1 })

    expect(lane.direction).toBe('right')
    expect(lane.controls.map((control) => control.kind)).toEqual(['add'])
    expect(lane.controls[0].center.x).toBeGreaterThan(root.x + root.width)
  })

  it('shows collapse then add for an expanded branch', () => {
    const [lane] = getWhiteboardMindMapControlLanes({ graph, node: child, zoom: 1 })

    expect(lane.controls.map((control) => control.kind)).toEqual(['collapse', 'add'])
    expect(lane.controls[1].center.x).toBeGreaterThan(lane.controls[0].center.x)
  })

  it('replaces branch controls with a descendant-count badge when collapsed', () => {
    const collapsed = { ...child, mindMapCollapsed: true }
    const collapsedGraph = {
      ...graph,
      nodes: [root, collapsed, grandchild],
    }
    const [lane] = getWhiteboardMindMapControlLanes({
      graph: collapsedGraph,
      node: collapsed,
      zoom: 1,
    })

    expect(lane.controls).toEqual([
      expect.objectContaining({ kind: 'expand', descendantCount: 1 }),
    ])
  })

  it('offers one root add control on each side for a bidirectional map', () => {
    const lanes = getWhiteboardMindMapControlLanes({
      graph: { ...graph, direction: 'both' },
      node: { ...root, mindMapDirection: 'both' },
      zoom: 1,
    })

    expect(lanes.map((lane) => lane.direction)).toEqual(['left', 'right'])
    expect(lanes.every((lane) => lane.controls[0].kind === 'add')).toBe(true)
  })

  it('keeps the visual control offset stable across zoom levels', () => {
    const normal = getWhiteboardMindMapControlLanes({ graph, node: root, zoom: 1 })[0]
    const zoomed = getWhiteboardMindMapControlLanes({ graph, node: root, zoom: 2 })[0]
    const normalOffset = normal.controls[0].center.x - (root.x + root.width)
    const zoomedOffset = zoomed.controls[0].center.x - (root.x + root.width)

    expect(normalOffset).toBeCloseTo(zoomedOffset * 2)
  })
})

function node(
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
    width: 160,
    height: 64,
    shapeStyle: 'mind-node',
    ...extra,
  }
}
