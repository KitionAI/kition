import type {
  AgentWhiteboardCluster,
  AgentWhiteboardContext,
  AgentWhiteboardElement,
} from '@/types/whiteboardAgent'

import type { BoardStore } from './boardStore'
import {
  getWhiteboardElementBounds,
  unionWhiteboardBounds,
  whiteboardBoundsIntersect,
} from './whiteboardGeometry'
import type {
  WhiteboardBounds,
  WhiteboardElement,
  WhiteboardPoint,
  WhiteboardViewport,
} from './whiteboardTypes'

export type WhiteboardAgentScope = 'selection' | 'viewport' | 'board'

const MAX_CONTEXT_ELEMENTS = 500
const MAX_SELECTED_ELEMENTS = 100
const MAX_CONTEXT_CLUSTERS = 64
const CLUSTER_SIZE = 100

export function buildWhiteboardAgentContext(input: {
  canvasSize: WhiteboardPoint
  path: string
  scope: WhiteboardAgentScope
  selectedElementIds: readonly string[]
  store: BoardStore
  title: string
  viewport: WhiteboardViewport
}): AgentWhiteboardContext | null {
  const path = normalizePortableBoardPath(input.path)
  if (!path) return null

  const viewport = buildViewportBounds(input.viewport, input.canvasSize)
  const elements = input.store.getCurrentPageElements()
  const selectedIds = input.selectedElementIds
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .filter((id) => elements.some((element) => element.id === id))
    .slice(0, MAX_SELECTED_ELEMENTS)
  const selectedSet = new Set(selectedIds)
  const visible = elements.filter((element) => (
    whiteboardBoundsIntersect(viewport, getWhiteboardElementBounds(element))
  ))

  let included: readonly WhiteboardElement[]
  if (input.scope === 'selection') {
    included = elements.filter((element) => selectedSet.has(element.id))
  } else if (input.scope === 'viewport') {
    included = visible
  } else {
    const priorityIds = new Set([
      ...selectedIds,
      ...visible.map((element) => element.id),
    ])
    included = [
      ...elements.filter((element) => priorityIds.has(element.id)),
      ...elements.filter((element) => !priorityIds.has(element.id)),
    ]
  }

  const compactElements = included.slice(0, MAX_CONTEXT_ELEMENTS)
  const includedIds = new Set(compactElements.map((element) => element.id))
  const omitted = elements.filter((element) => !includedIds.has(element.id))

  return {
    type: 'whiteboard.context',
    schema_version: 1,
    board: {
      id: createBoardReferenceId(path),
      path,
      title: String(input.title || 'Board').trim().slice(0, 500) || 'Board',
    },
    scope: input.scope,
    viewport,
    selected_element_ids: selectedIds,
    elements: compactElements.map(whiteboardElementToAgentElement),
    clusters: buildOmittedClusters(omitted),
    recent_operations: input.store.getRecentUserOperations(50),
    source_refs: [],
  }
}

export function whiteboardElementToAgentElement(
  element: WhiteboardElement,
): AgentWhiteboardElement {
  const result: AgentWhiteboardElement = {
    id: element.id,
    kind: resolveAgentElementKind(element),
    bounds: getWhiteboardElementBounds(element),
  }
  const text = element.kind === 'text' || element.kind === 'rectangle'
    ? element.text?.trim()
    : ''
  if (text) result.text = text.slice(0, 2000)
  if (element.parentId) result.parent_id = element.parentId
  if (element.sourceRefIds?.length) {
    result.source_ref_ids = [...new Set(element.sourceRefIds)].slice(0, 16)
  }
  return result
}

function resolveAgentElementKind(
  element: WhiteboardElement,
): AgentWhiteboardElement['kind'] {
  if (element.kind === 'text') return 'text'
  if (element.kind === 'connector') return 'connector'
  if (element.kind === 'stroke') return 'freehand'
  if (element.kind === 'image') return 'image'
  switch (element.shapeStyle) {
    case 'sticky': return 'sticky'
    case 'mind-node': return 'mind_node'
    case 'flow-node': return 'flow_node'
    case 'frame': return 'frame'
    case 'group': return 'group'
    case 'image-placeholder': return 'image'
    default: return 'shape'
  }
}

function buildViewportBounds(
  viewport: WhiteboardViewport,
  canvasSize: WhiteboardPoint,
) {
  return {
    x: viewport.x,
    y: viewport.y,
    width: Math.max(0, canvasSize.x / viewport.zoom),
    height: Math.max(0, canvasSize.y / viewport.zoom),
    zoom: viewport.zoom,
  }
}

function buildOmittedClusters(
  elements: readonly WhiteboardElement[],
): AgentWhiteboardCluster[] {
  const clusters: AgentWhiteboardCluster[] = []
  for (
    let offset = 0;
    offset < elements.length && clusters.length < MAX_CONTEXT_CLUSTERS;
    offset += CLUSTER_SIZE
  ) {
    const chunk = elements.slice(offset, offset + CLUSTER_SIZE)
    const bounds = unionWhiteboardBounds(chunk.map(getWhiteboardElementBounds))
    if (!bounds) continue
    const kindCounts = new Map<string, number>()
    for (const element of chunk) {
      const kind = whiteboardElementToAgentElement(element).kind
      kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1)
    }
    const summary = [...kindCounts]
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ')
      .slice(0, 1000)
    clusters.push({
      id: `cluster:${clusters.length + 1}`,
      bounds,
      element_count: chunk.length,
      summary,
    })
  }
  return clusters
}

function normalizePortableBoardPath(value: string) {
  const path = String(value || '').trim().replace(/\\/g, '/').slice(0, 1024)
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return ''
  if (path.split('/').some((part) => part === '..')) return ''
  return path.replace(/^\.\//, '')
}

function createBoardReferenceId(path: string) {
  let hash = 2166136261
  for (const character of path) {
    hash ^= character.codePointAt(0) || 0
    hash = Math.imul(hash, 16777619)
  }
  return `board:${(hash >>> 0).toString(36)}`
}

export function getAgentElementBounds(
  element: AgentWhiteboardElement,
): WhiteboardBounds {
  return { ...element.bounds }
}
