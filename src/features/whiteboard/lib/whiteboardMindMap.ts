import type { BoardBindingRecord } from './boardRecords'
import { getWhiteboardElementCenter } from './whiteboardGeometry'
import type {
  WhiteboardElement,
  WhiteboardMindMapBranchSide,
  WhiteboardMindMapDirection,
  WhiteboardRectangleElement,
} from './whiteboardTypes'

const HORIZONTAL_DEPTH_GAP = 250
const HORIZONTAL_LEAF_GAP = 96
const VERTICAL_DEPTH_GAP = 150
const VERTICAL_LEAF_GAP = 210

export type WhiteboardMindMapEdge = {
  childId: string
  connectorId: string
  parentId: string
}

export type WhiteboardMindMapGraph = {
  childrenById: ReadonlyMap<string, readonly string[]>
  direction: WhiteboardMindMapDirection
  edges: readonly WhiteboardMindMapEdge[]
  nodes: readonly WhiteboardRectangleElement[]
  parentById: ReadonlyMap<string, string>
  rootId: string
}

export type WhiteboardMindMapPresentation = {
  hiddenElementIds: ReadonlySet<string>
  managedConnectorIds: ReadonlySet<string>
}

type WhiteboardMindMapTopology = {
  childrenById: Map<string, string[]>
  edges: WhiteboardMindMapEdge[]
  nodeById: Map<string, WhiteboardRectangleElement>
  parentById: Map<string, string>
}

export function isWhiteboardMindMapNode(
  element: WhiteboardElement | undefined,
): element is WhiteboardRectangleElement {
  return element?.kind === 'rectangle' && element.shapeStyle === 'mind-node'
}

export function isWhiteboardMindMapBranch(element: WhiteboardElement | undefined) {
  return element?.kind === 'connector' && element.connectorRole === 'mind-map-branch'
}

export function getWhiteboardMindMapGraph(input: {
  bindings: readonly BoardBindingRecord[]
  elements: readonly WhiteboardElement[]
  nodeId: string
}): WhiteboardMindMapGraph | null {
  const topology = buildWhiteboardMindMapTopology(input)
  if (!topology.nodeById.has(input.nodeId)) return null

  let rootId = input.nodeId
  const parentPath = new Set<string>()
  while (topology.parentById.has(rootId) && !parentPath.has(rootId)) {
    parentPath.add(rootId)
    rootId = topology.parentById.get(rootId)!
  }

  const nodeIds = collectMindMapNodeIds(topology.childrenById, rootId)
  const nodes = [...nodeIds].flatMap((id) => {
    const node = topology.nodeById.get(id)
    return node ? [node] : []
  })
  const root = topology.nodeById.get(rootId)!
  return {
    childrenById: topology.childrenById,
    direction: root.mindMapDirection || inferMindMapDirection(root, nodes),
    edges: topology.edges.filter((edge) => (
      nodeIds.has(edge.parentId) && nodeIds.has(edge.childId)
    )),
    nodes,
    parentById: topology.parentById,
    rootId,
  }
}

export function getWhiteboardMindMapPresentation(input: {
  bindings: readonly BoardBindingRecord[]
  elements: readonly WhiteboardElement[]
}): WhiteboardMindMapPresentation {
  const topology = buildWhiteboardMindMapTopology(input)
  const hiddenElementIds = new Set<string>()
  const managedConnectorIds = new Set(topology.edges.map((edge) => edge.connectorId))
  const roots = [...topology.nodeById.keys()].filter((id) => !topology.parentById.has(id))

  for (const rootId of roots) visit(rootId, false)
  return { hiddenElementIds, managedConnectorIds }

  function visit(nodeId: string, hiddenByAncestor: boolean) {
    const node = topology.nodeById.get(nodeId)
    if (!node) return
    if (hiddenByAncestor) hiddenElementIds.add(nodeId)
    const hideChildren = hiddenByAncestor || (nodeId !== rootIdFor(nodeId) && node.mindMapCollapsed === true)
    for (const childId of topology.childrenById.get(nodeId) || []) {
      const edge = topology.edges.find((candidate) => (
        candidate.parentId === nodeId && candidate.childId === childId
      ))
      if (hideChildren && edge) hiddenElementIds.add(edge.connectorId)
      visit(childId, hideChildren)
    }
  }

  function rootIdFor(nodeId: string) {
    let current = nodeId
    const visited = new Set<string>()
    while (topology.parentById.has(current) && !visited.has(current)) {
      visited.add(current)
      current = topology.parentById.get(current)!
    }
    return current
  }
}

export function getWhiteboardMindMapDescendantCount(
  graph: WhiteboardMindMapGraph,
  nodeId: string,
) {
  let count = 0
  const queue = [...(graph.childrenById.get(nodeId) || [])]
  const visited = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    count += 1
    queue.push(...(graph.childrenById.get(id) || []))
  }
  return count
}

export function getWhiteboardMindMapBranchSide(
  graph: WhiteboardMindMapGraph,
  nodeId: string,
): WhiteboardMindMapBranchSide | null {
  if (nodeId === graph.rootId) return null
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  let firstLevelId = nodeId
  const visited = new Set<string>()
  while (
    graph.parentById.has(firstLevelId)
    && graph.parentById.get(firstLevelId) !== graph.rootId
    && !visited.has(firstLevelId)
  ) {
    visited.add(firstLevelId)
    firstLevelId = graph.parentById.get(firstLevelId)!
  }
  const firstLevelNode = nodeById.get(firstLevelId)
  if (firstLevelNode?.mindMapBranchSide) return firstLevelNode.mindMapBranchSide
  const root = nodeById.get(graph.rootId)
  if (!firstLevelNode || !root) return null
  return getWhiteboardElementCenter(firstLevelNode).x < getWhiteboardElementCenter(root).x
    ? 'left'
    : 'right'
}

export function layoutWhiteboardMindMap(input: {
  bindings: readonly BoardBindingRecord[]
  direction: WhiteboardMindMapDirection
  elements: readonly WhiteboardElement[]
  nodeId: string
}): WhiteboardRectangleElement[] {
  const graph = getWhiteboardMindMapGraph(input)
  if (!graph) return []
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const root = nodeById.get(graph.rootId)!
  const rootCenter = getWhiteboardElementCenter(root)
  const branchSides = new Map<string, WhiteboardMindMapBranchSide>()
  const centers = input.direction === 'both'
    ? layoutBidirectional(graph, nodeById, rootCenter, branchSides)
    : input.direction === 'down'
      ? layoutVertical(graph, nodeById, rootCenter)
      : layoutHorizontal(
          graph,
          nodeById,
          rootCenter,
          input.direction === 'right' ? 1 : -1,
        )

  return graph.nodes.map((node) => {
    const center = centers.get(node.id) || getWhiteboardElementCenter(node)
    const firstLevel = graph.parentById.get(node.id) === graph.rootId
    return {
      ...node,
      x: center.x - node.width / 2,
      y: center.y - node.height / 2,
      mindMapBranchSide: input.direction === 'both' && firstLevel
        ? branchSides.get(node.id) || node.mindMapBranchSide
        : node.mindMapBranchSide,
      mindMapCollapsed: node.id === graph.rootId ? undefined : node.mindMapCollapsed,
      mindMapDirection: node.id === graph.rootId ? input.direction : undefined,
    }
  })
}

export function getWhiteboardMindMapNodePlacement(input: {
  graph: WhiteboardMindMapGraph
  height: number
  parentId: string
  side?: WhiteboardMindMapBranchSide
  width: number
}) {
  const nodeById = new Map(input.graph.nodes.map((node) => [node.id, node]))
  const parent = nodeById.get(input.parentId)
  const root = nodeById.get(input.graph.rootId)
  if (!parent || !root) return null
  const parentCenter = getWhiteboardElementCenter(parent)
  const childCount = input.graph.childrenById.get(parent.id)?.length || 0
  let side = input.side || getWhiteboardMindMapBranchSide(input.graph, parent.id) || 'right'
  let x = parentCenter.x + HORIZONTAL_DEPTH_GAP - input.width / 2
  let y = parentCenter.y + childCount * 72 - input.height / 2

  if (input.graph.direction === 'left') {
    side = 'left'
    x = parentCenter.x - HORIZONTAL_DEPTH_GAP - input.width / 2
  } else if (input.graph.direction === 'right') {
    side = 'right'
  } else if (input.graph.direction === 'down') {
    x = parentCenter.x + childCount * 140 - input.width / 2
    y = parentCenter.y + VERTICAL_DEPTH_GAP - input.height / 2
  } else if (input.graph.direction === 'both') {
    if (parent.id === root.id && !input.side) {
      side = getBalancedRootSide(input.graph, nodeById)
    }
    x = parentCenter.x + (side === 'left' ? -1 : 1) * HORIZONTAL_DEPTH_GAP - input.width / 2
  }
  return { side, x, y }
}

function buildWhiteboardMindMapTopology(input: {
  bindings: readonly BoardBindingRecord[]
  elements: readonly WhiteboardElement[]
}): WhiteboardMindMapTopology {
  const nodeById = new Map(input.elements.flatMap((element): Array<[
    string,
    WhiteboardRectangleElement,
  ]> => isWhiteboardMindMapNode(element) ? [[element.id, element]] : []))
  const connectorIds = new Set(input.elements.flatMap((element) => (
    element.kind === 'connector' ? [element.id] : []
  )))
  const terminals = new Map<string, Partial<Record<'start' | 'end', string>>>()
  for (const binding of input.bindings) {
    if (!connectorIds.has(binding.from_id) || !binding.terminal) continue
    const current = terminals.get(binding.from_id) || {}
    if (!current[binding.terminal]) current[binding.terminal] = binding.to_id
    terminals.set(binding.from_id, current)
  }

  const edges: WhiteboardMindMapEdge[] = []
  const parentById = new Map<string, string>()
  const childrenById = new Map<string, string[]>()
  for (const [connectorId, terminal] of terminals) {
    const parentId = terminal.start
    const childId = terminal.end
    if (
      !parentId
      || !childId
      || parentId === childId
      || !nodeById.has(parentId)
      || !nodeById.has(childId)
      || parentById.has(childId)
    ) continue
    parentById.set(childId, parentId)
    childrenById.set(parentId, [...(childrenById.get(parentId) || []), childId])
    edges.push({ childId, connectorId, parentId })
  }
  return { childrenById, edges, nodeById, parentById }
}

function collectMindMapNodeIds(
  childrenById: ReadonlyMap<string, readonly string[]>,
  rootId: string,
) {
  const nodeIds = new Set<string>()
  const queue = [rootId]
  while (queue.length) {
    const id = queue.shift()!
    if (nodeIds.has(id)) continue
    nodeIds.add(id)
    queue.push(...(childrenById.get(id) || []))
  }
  return nodeIds
}

function getVisibleChildren(
  graph: WhiteboardMindMapGraph,
  nodeById: ReadonlyMap<string, WhiteboardRectangleElement>,
  nodeId: string,
) {
  if (nodeId !== graph.rootId && nodeById.get(nodeId)?.mindMapCollapsed) return []
  return graph.childrenById.get(nodeId) || []
}

function layoutHorizontal(
  graph: WhiteboardMindMapGraph,
  nodeById: ReadonlyMap<string, WhiteboardRectangleElement>,
  rootCenter: { x: number; y: number },
  direction: 1 | -1,
) {
  const centers = new Map<string, { x: number; y: number }>()
  let leafIndex = 0
  const visit = (id: string, depth: number): number => {
    const children = getVisibleChildren(graph, nodeById, id)
    const y = children.length
      ? average(children.map((childId) => visit(childId, depth + 1)))
      : leafIndex++ * HORIZONTAL_LEAF_GAP
    centers.set(id, {
      x: rootCenter.x + direction * depth * HORIZONTAL_DEPTH_GAP,
      y,
    })
    return y
  }
  const computedRootY = visit(graph.rootId, 0)
  translateCenters(centers, { x: 0, y: rootCenter.y - computedRootY })
  return centers
}

function layoutVertical(
  graph: WhiteboardMindMapGraph,
  nodeById: ReadonlyMap<string, WhiteboardRectangleElement>,
  rootCenter: { x: number; y: number },
) {
  const centers = new Map<string, { x: number; y: number }>()
  let leafIndex = 0
  const visit = (id: string, depth: number): number => {
    const children = getVisibleChildren(graph, nodeById, id)
    const x = children.length
      ? average(children.map((childId) => visit(childId, depth + 1)))
      : leafIndex++ * VERTICAL_LEAF_GAP
    centers.set(id, {
      x,
      y: rootCenter.y + depth * VERTICAL_DEPTH_GAP,
    })
    return x
  }
  const computedRootX = visit(graph.rootId, 0)
  translateCenters(centers, { x: rootCenter.x - computedRootX, y: 0 })
  return centers
}

function layoutBidirectional(
  graph: WhiteboardMindMapGraph,
  nodeById: ReadonlyMap<string, WhiteboardRectangleElement>,
  rootCenter: { x: number; y: number },
  branchSides: Map<string, WhiteboardMindMapBranchSide>,
) {
  const centers = new Map<string, { x: number; y: number }>([[graph.rootId, rootCenter]])
  const left: string[] = []
  const right: string[] = []
  for (const childId of getVisibleChildren(graph, nodeById, graph.rootId)) {
    const child = nodeById.get(childId)
    const existingSide = child?.mindMapBranchSide
      || (graph.direction === 'both' && child
        ? getWhiteboardElementCenter(child).x < rootCenter.x ? 'left' : 'right'
        : null)
    const side = existingSide || (left.length <= right.length ? 'left' : 'right')
    branchSides.set(childId, side)
    if (side === 'left') left.push(childId)
    else right.push(childId)
  }
  layoutSide(left, -1)
  layoutSide(right, 1)
  return centers

  function layoutSide(rootChildren: readonly string[], direction: 1 | -1) {
    if (!rootChildren.length) return
    const sideIds = new Set<string>()
    let leafIndex = 0
    const visit = (id: string, depth: number): number => {
      sideIds.add(id)
      const children = getVisibleChildren(graph, nodeById, id)
      const y = children.length
        ? average(children.map((childId) => visit(childId, depth + 1)))
        : leafIndex++ * HORIZONTAL_LEAF_GAP
      centers.set(id, {
        x: rootCenter.x + direction * depth * HORIZONTAL_DEPTH_GAP,
        y,
      })
      return y
    }
    rootChildren.forEach((childId) => visit(childId, 1))
    const ys = [...sideIds].map((id) => centers.get(id)!.y)
    const sideCenter = (Math.min(...ys) + Math.max(...ys)) / 2
    for (const id of sideIds) {
      const center = centers.get(id)!
      centers.set(id, { ...center, y: center.y + rootCenter.y - sideCenter })
    }
  }
}

function getBalancedRootSide(
  graph: WhiteboardMindMapGraph,
  nodeById: ReadonlyMap<string, WhiteboardRectangleElement>,
): WhiteboardMindMapBranchSide {
  const root = nodeById.get(graph.rootId)
  if (!root) return 'right'
  const rootCenter = getWhiteboardElementCenter(root)
  let leftCount = 0
  let rightCount = 0
  for (const childId of graph.childrenById.get(graph.rootId) || []) {
    const child = nodeById.get(childId)
    const side = child?.mindMapBranchSide
      || (child && getWhiteboardElementCenter(child).x < rootCenter.x ? 'left' : 'right')
    if (side === 'left') leftCount += 1
    else rightCount += 1
  }
  return leftCount <= rightCount ? 'left' : 'right'
}

function inferMindMapDirection(
  root: WhiteboardRectangleElement,
  nodes: readonly WhiteboardRectangleElement[],
): WhiteboardMindMapDirection {
  const rootCenter = getWhiteboardElementCenter(root)
  const others = nodes.filter((node) => node.id !== root.id).map(getWhiteboardElementCenter)
  if (!others.length) return 'right'
  const left = others.filter((center) => center.x < rootCenter.x - 20).length
  const right = others.filter((center) => center.x > rootCenter.x + 20).length
  const below = others.filter((center) => center.y > rootCenter.y + 20).length
  if (left > 0 && right > 0) return 'both'
  if (below > Math.max(left, right)) return 'down'
  return left > right ? 'left' : 'right'
}

function average(values: readonly number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

function translateCenters(
  centers: Map<string, { x: number; y: number }>,
  delta: { x: number; y: number },
) {
  for (const [id, center] of centers) {
    centers.set(id, { x: center.x + delta.x, y: center.y + delta.y })
  }
}
