import { useCallback, useMemo } from 'react'

import {
  createBoardConnectorBindingRecord,
  getBoardConnectorAnchor,
} from '../lib/boardBindingEngine'
import type { BoardCommandRegistry } from '../lib/boardCommands'
import type { BoardBindingRecord, BoardRecord } from '../lib/boardRecords'
import type { BoardHistoryMark, BoardStore } from '../lib/boardStore'
import { createWhiteboardElementId } from '../lib/whiteboardElementId'
import { getWhiteboardElementCenter } from '../lib/whiteboardGeometry'
import {
  getWhiteboardMindMapBranchSide,
  getWhiteboardMindMapGraph,
  getWhiteboardMindMapNodePlacement,
  isWhiteboardMindMapNode,
  layoutWhiteboardMindMap,
  type WhiteboardMindMapGraph,
} from '../lib/whiteboardMindMap'
import type {
  WhiteboardColorToken,
  WhiteboardConnectorElement,
  WhiteboardElement,
  WhiteboardMindMapBranchSide,
  WhiteboardMindMapDirection,
  WhiteboardRectangleElement,
} from '../lib/whiteboardTypes'

const MIND_MAP_BRANCH_COLORS: readonly WhiteboardColorToken[] = [
  'purple',
  'blue',
  'green',
  'orange',
  'red',
]

export function useWhiteboardMindMapActions(input: {
  beginInsertedNodeTextEdit: (
    element: WhiteboardElement,
    historyMark: BoardHistoryMark,
  ) => void
  commands: BoardCommandRegistry
  elements: readonly WhiteboardElement[]
  records: readonly BoardRecord[]
  replaceSelection: (ids: readonly string[]) => void
  selectedElements: readonly WhiteboardElement[]
  store: BoardStore
}) {
  const bindings = useMemo(() => input.records.filter((record): record is BoardBindingRecord => (
    record.record_type === 'binding'
  )), [input.records])
  const selectedMindMapNode = input.selectedElements.length === 1
    && isWhiteboardMindMapNode(input.selectedElements[0])
    ? input.selectedElements[0]
    : null
  const selectedGraph = useMemo(() => selectedMindMapNode
    ? getWhiteboardMindMapGraph({
        bindings,
        elements: input.elements,
        nodeId: selectedMindMapNode.id,
      })
    : null, [bindings, input.elements, selectedMindMapNode])
  const canEditMindMap = canEditGraph(selectedGraph)

  const setMindMapDirection = useCallback((direction: WhiteboardMindMapDirection) => {
    if (!selectedMindMapNode || !selectedGraph || !canEditMindMap) return false
    const mark = input.store.markHistory()
    const layout = layoutWhiteboardMindMap({
      bindings,
      direction,
      elements: input.elements,
      nodeId: selectedMindMapNode.id,
    })
    if (!layout.length) return false
    input.commands.execute({ type: 'element.update', elements: layout })
    updateMindMapConnectorTerminals({
      commands: input.commands,
      elements: replaceElements(input.elements, layout),
      graph: selectedGraph,
    })
    input.store.squashToMark(mark, 'Change mind map direction')
    return true
  }, [
    bindings,
    canEditMindMap,
    input.commands,
    input.elements,
    input.store,
    selectedGraph,
    selectedMindMapNode,
  ])

  const addMindMapNode = useCallback((
    parentId: string,
    label: string,
    requestedSide?: WhiteboardMindMapBranchSide,
  ) => {
    const graph = getWhiteboardMindMapGraph({
      bindings,
      elements: input.elements,
      nodeId: parentId,
    })
    if (!graph || !canEditGraph(graph)) return false
    const parent = graph.nodes.find((node) => node.id === parentId)
    if (!parent) return false

    const placement = getWhiteboardMindMapNodePlacement({
      graph,
      height: 56,
      parentId,
      side: requestedSide,
      width: 142,
    })
    if (!placement) return false
    const color = getNewNodeBranchColor(graph, parent)
    const node: WhiteboardRectangleElement = {
      id: createWhiteboardElementId('rectangle'),
      kind: 'rectangle',
      x: placement.x,
      y: placement.y,
      width: 142,
      height: 56,
      mindMapBranchSide: parent.id === graph.rootId && graph.direction === 'both'
        ? placement.side
        : undefined,
      shapeStyle: 'mind-node',
      shapeType: 'rectangle',
      text: label,
      style: {
        dashStyle: 'solid',
        fillColor: 'white',
        fillStyle: 'solid',
        strokeColor: color,
        strokeSize: 's',
      },
    }
    const connector: WhiteboardConnectorElement = {
      id: createWhiteboardElementId('connector'),
      kind: 'connector',
      start: getWhiteboardElementCenter(parent),
      end: getWhiteboardElementCenter(node),
      connectorRole: 'mind-map-branch',
      connectorType: 'straight',
      endArrowhead: 'none',
      style: { strokeColor: color, strokeSize: 's' },
    }
    const initialBindings = createMindMapBindings(parent, node, connector)
    if (!initialBindings) return false

    const mark = input.store.markHistory()
    let baseElements = [...input.elements]
    if (parent.mindMapCollapsed) {
      const expandedParent = { ...parent, mindMapCollapsed: false }
      input.commands.execute({ type: 'element.update', elements: [expandedParent] })
      baseElements = replaceElements(baseElements, [expandedParent])
    }
    input.commands.execute({
      type: 'element.paste',
      bindings: initialBindings,
      elements: [connector, node],
    })

    const combinedElements = [...baseElements, connector, node]
    const combinedBindings = [...bindings, ...initialBindings]
    const layout = layoutWhiteboardMindMap({
      bindings: combinedBindings,
      direction: graph.direction,
      elements: combinedElements,
      nodeId: node.id,
    })
    input.commands.execute({ type: 'element.update', elements: layout })
    const finalElements = replaceElements(combinedElements, layout)
    const finalGraph = getWhiteboardMindMapGraph({
      bindings: combinedBindings,
      elements: finalElements,
      nodeId: node.id,
    })
    if (finalGraph) {
      updateMindMapConnectorTerminals({
        commands: input.commands,
        elements: finalElements,
        graph: finalGraph,
      })
    }
    input.store.squashToMark(mark, 'Add mind map node')
    const finalNode = finalElements.find((element) => element.id === node.id)
    if (finalNode) input.beginInsertedNodeTextEdit(finalNode, mark)
    return node.id
  }, [
    bindings,
    input.beginInsertedNodeTextEdit,
    input.commands,
    input.elements,
    input.store,
  ])

  const addMindMapChildAt = useCallback((
    nodeId: string,
    label: string,
    side?: WhiteboardMindMapBranchSide,
  ) => addMindMapNode(nodeId, label, side), [addMindMapNode])

  const addMindMapChild = useCallback((label: string) => (
    selectedMindMapNode ? addMindMapNode(selectedMindMapNode.id, label) : false
  ), [addMindMapNode, selectedMindMapNode])

  const addMindMapSibling = useCallback((label: string) => {
    if (!selectedMindMapNode || !selectedGraph) return false
    const parentId = selectedGraph.parentById.get(selectedMindMapNode.id)
    const side = getWhiteboardMindMapBranchSide(selectedGraph, selectedMindMapNode.id)
      || undefined
    return parentId ? addMindMapNode(parentId, label, side) : false
  }, [addMindMapNode, selectedGraph, selectedMindMapNode])

  const toggleMindMapCollapsed = useCallback((nodeId: string) => {
    const graph = getWhiteboardMindMapGraph({
      bindings,
      elements: input.elements,
      nodeId,
    })
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId)
    if (
      !graph
      || !node
      || node.id === graph.rootId
      || !graph.childrenById.get(node.id)?.length
      || !canEditGraph(graph)
    ) return false

    const mark = input.store.markHistory()
    const updatedNode = {
      ...node,
      mindMapCollapsed: node.mindMapCollapsed ? undefined : true,
    }
    input.commands.execute({ type: 'element.update', elements: [updatedNode] })
    const updatedElements = replaceElements(input.elements, [updatedNode])
    const layout = layoutWhiteboardMindMap({
      bindings,
      direction: graph.direction,
      elements: updatedElements,
      nodeId,
    })
    input.commands.execute({ type: 'element.update', elements: layout })
    const finalElements = replaceElements(updatedElements, layout)
    updateMindMapConnectorTerminals({
      commands: input.commands,
      elements: finalElements,
      graph,
    })
    input.store.squashToMark(mark, updatedNode.mindMapCollapsed
      ? 'Collapse mind map branch'
      : 'Expand mind map branch')
    input.replaceSelection([nodeId])
    return true
  }, [
    bindings,
    input.commands,
    input.elements,
    input.replaceSelection,
    input.store,
  ])

  return {
    addMindMapChild,
    addMindMapChildAt,
    addMindMapSibling,
    canAddMindMapSibling: Boolean(
      canEditMindMap
        && selectedMindMapNode
        && selectedGraph?.parentById.has(selectedMindMapNode.id),
    ),
    canEditMindMap,
    mindMapDirection: selectedGraph?.direction || null,
    mindMapRootNode: selectedGraph
      ? selectedGraph.nodes.find((node) => node.id === selectedGraph.rootId) || null
      : null,
    selectedMindMapNode,
    setMindMapDirection,
    toggleMindMapCollapsed,
  }
}

function canEditGraph(graph: WhiteboardMindMapGraph | null): graph is WhiteboardMindMapGraph {
  return Boolean(graph && graph.nodes.every((node) => !node.locked))
}

function getNewNodeBranchColor(
  graph: WhiteboardMindMapGraph,
  parent: WhiteboardRectangleElement,
) {
  if (parent.id !== graph.rootId) {
    return parent.style?.strokeColor || 'purple'
  }
  const directChildren = graph.childrenById.get(graph.rootId) || []
  return MIND_MAP_BRANCH_COLORS[directChildren.length % MIND_MAP_BRANCH_COLORS.length]
}

function createMindMapBindings(
  parent: WhiteboardRectangleElement,
  child: WhiteboardRectangleElement,
  connector: WhiteboardConnectorElement,
) {
  const start = getBoardConnectorAnchor(parent, getWhiteboardElementCenter(child))
  const end = getBoardConnectorAnchor(child, getWhiteboardElementCenter(parent))
  if (!start || !end) return null
  connector.start = start.point
  connector.end = end.point
  return [
    createBoardConnectorBindingRecord({
      anchor: start,
      connectorId: connector.id,
      terminal: 'start',
    }),
    createBoardConnectorBindingRecord({
      anchor: end,
      connectorId: connector.id,
      terminal: 'end',
    }),
  ]
}

function updateMindMapConnectorTerminals(input: {
  commands: BoardCommandRegistry
  elements: readonly WhiteboardElement[]
  graph: WhiteboardMindMapGraph
}) {
  const byId = new Map(input.elements.map((element) => [element.id, element]))
  for (const edge of input.graph.edges) {
    const parent = byId.get(edge.parentId)
    const child = byId.get(edge.childId)
    if (!isWhiteboardMindMapNode(parent) || !isWhiteboardMindMapNode(child)) continue
    const start = getBoardConnectorAnchor(parent, getWhiteboardElementCenter(child))
    const end = getBoardConnectorAnchor(child, getWhiteboardElementCenter(parent))
    if (!start || !end) continue
    input.commands.execute({
      type: 'connector.update-terminal',
      connectorId: edge.connectorId,
      terminal: 'start',
      point: start.point,
      binding: start,
    })
    input.commands.execute({
      type: 'connector.update-terminal',
      connectorId: edge.connectorId,
      terminal: 'end',
      point: end.point,
      binding: end,
    })
  }
}

function replaceElements(
  elements: readonly WhiteboardElement[],
  replacements: readonly WhiteboardElement[],
) {
  const replacementById = new Map(replacements.map((element) => [element.id, element]))
  return elements.map((element) => replacementById.get(element.id) || element)
}
