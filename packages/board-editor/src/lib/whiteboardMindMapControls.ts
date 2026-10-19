import {
  getWhiteboardMindMapBranchSide,
  getWhiteboardMindMapDescendantCount,
  type WhiteboardMindMapGraph,
} from './whiteboardMindMap'
import type {
  WhiteboardBounds,
  WhiteboardMindMapBranchSide,
  WhiteboardPoint,
  WhiteboardRectangleElement,
} from './whiteboardTypes'

const CONTROL_DIAMETER = 22
const CONTROL_GAP = 9
const CONTROL_LEAD = 10
const AWARENESS_PADDING = 7

export type WhiteboardMindMapControlKind = 'add' | 'collapse' | 'expand'
export type WhiteboardMindMapGrowthDirection = WhiteboardMindMapBranchSide | 'down'

export type WhiteboardMindMapQuickControl = {
  center: WhiteboardPoint
  descendantCount?: number
  direction: WhiteboardMindMapGrowthDirection
  kind: WhiteboardMindMapControlKind
}

export type WhiteboardMindMapControlLane = {
  awarenessBounds: WhiteboardBounds
  controls: readonly WhiteboardMindMapQuickControl[]
  direction: WhiteboardMindMapGrowthDirection
  edgePoint: WhiteboardPoint
}

export function getWhiteboardMindMapControlLanes(input: {
  graph: WhiteboardMindMapGraph
  node: WhiteboardRectangleElement
  zoom: number
}): WhiteboardMindMapControlLane[] {
  const zoom = Math.max(0.1, input.zoom)
  const directions = getGrowthDirections(input.graph, input.node)
  return directions.map((direction) => createControlLane({
    direction,
    graph: input.graph,
    node: input.node,
    zoom,
  }))
}

function getGrowthDirections(
  graph: WhiteboardMindMapGraph,
  node: WhiteboardRectangleElement,
): WhiteboardMindMapGrowthDirection[] {
  if (node.id === graph.rootId && graph.direction === 'both') return ['left', 'right']
  if (graph.direction === 'down') return ['down']
  if (graph.direction === 'left' || graph.direction === 'right') return [graph.direction]
  return [getWhiteboardMindMapBranchSide(graph, node.id) || 'right']
}

function createControlLane(input: {
  direction: WhiteboardMindMapGrowthDirection
  graph: WhiteboardMindMapGraph
  node: WhiteboardRectangleElement
  zoom: number
}): WhiteboardMindMapControlLane {
  const screenToWorld = (value: number) => value / input.zoom
  const diameter = screenToWorld(CONTROL_DIAMETER)
  const radius = diameter / 2
  const gap = screenToWorld(CONTROL_GAP)
  const lead = screenToWorld(CONTROL_LEAD)
  const vector = getDirectionVector(input.direction)
  const edge = getOutgoingEdgePoint(input.node, input.direction)
  const firstCenter = move(edge, vector, lead + radius)
  const childCount = input.graph.childrenById.get(input.node.id)?.length || 0
  const isRoot = input.node.id === input.graph.rootId
  const controls: WhiteboardMindMapQuickControl[] = []

  if (!isRoot && childCount > 0 && input.node.mindMapCollapsed) {
    controls.push({
      center: firstCenter,
      descendantCount: getWhiteboardMindMapDescendantCount(input.graph, input.node.id),
      direction: input.direction,
      kind: 'expand',
    })
  } else if (!isRoot && childCount > 0) {
    controls.push({
      center: firstCenter,
      direction: input.direction,
      kind: 'collapse',
    })
    controls.push({
      center: move(firstCenter, vector, diameter + gap),
      direction: input.direction,
      kind: 'add',
    })
  } else {
    controls.push({
      center: firstCenter,
      direction: input.direction,
      kind: 'add',
    })
  }

  const finalCenter = controls[controls.length - 1].center
  const awarenessPadding = screenToWorld(AWARENESS_PADDING)
  const minX = Math.min(edge.x, finalCenter.x) - radius - awarenessPadding
  const maxX = Math.max(edge.x, finalCenter.x) + radius + awarenessPadding
  const minY = Math.min(edge.y, finalCenter.y) - radius - awarenessPadding
  const maxY = Math.max(edge.y, finalCenter.y) + radius + awarenessPadding
  return {
    awarenessBounds: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    },
    controls,
    direction: input.direction,
    edgePoint: edge,
  }
}

function getOutgoingEdgePoint(
  node: WhiteboardRectangleElement,
  direction: WhiteboardMindMapGrowthDirection,
) {
  switch (direction) {
    case 'left': return { x: node.x, y: node.y + node.height / 2 }
    case 'right': return { x: node.x + node.width, y: node.y + node.height / 2 }
    case 'down': return { x: node.x + node.width / 2, y: node.y + node.height }
  }
}

function getDirectionVector(direction: WhiteboardMindMapGrowthDirection) {
  switch (direction) {
    case 'left': return { x: -1, y: 0 }
    case 'right': return { x: 1, y: 0 }
    case 'down': return { x: 0, y: 1 }
  }
}

function move(
  point: WhiteboardPoint,
  vector: WhiteboardPoint,
  distance: number,
) {
  return {
    x: point.x + vector.x * distance,
    y: point.y + vector.y * distance,
  }
}
