import type {
  AgentWhiteboardCluster,
  AgentWhiteboardContext,
  AgentWhiteboardElement,
} from '@/types/whiteboardAgent'

import { getBoardAgentElementKind } from './boardElementDefinitions'
import { exportBoardSvg } from './boardExport'
import { lintWhiteboard } from './whiteboardLint'
import {
  DEFAULT_WHITEBOARD_STYLE,
  getWhiteboardElementStyle,
} from './whiteboardStyle'
import type { BoardStore } from './boardStore'
import {
  getWhiteboardElementBounds,
  unionWhiteboardBounds,
} from './whiteboardGeometry'
import type {
  WhiteboardBounds,
  WhiteboardElement,
  WhiteboardPoint,
  WhiteboardViewport,
  WhiteboardElementStyle,
  WhiteboardTool,
} from './whiteboardTypes'

export type WhiteboardAgentScope = 'selection' | 'viewport' | 'board'

const MAX_CONTEXT_ELEMENTS = 500
const MAX_SELECTED_ELEMENTS = 100
const MAX_CONTEXT_CLUSTERS = 64
const CLUSTER_SIZE = 100

export function buildWhiteboardAgentContext(input: {
  canvasSize: WhiteboardPoint
  activeStyle?: WhiteboardElementStyle
  path: string
  scope: WhiteboardAgentScope
  selectedElementIds: readonly string[]
  store: BoardStore
  title: string
  tool?: WhiteboardTool
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
  const visible = input.store.queryCurrentPageElements(viewport)

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
  const currentPageId = input.store.getCurrentPageId()
  const currentPage = input.store.getPages().find((page) => page.id === currentPageId)
  const lintFindings = lintWhiteboard({
    bindings: input.store.getRecords().filter((record) => record.record_type === 'binding'),
    elements,
  })
  const snapshotElements = compactElements.filter((element) => (
    input.scope !== 'selection' || selectedSet.has(element.id)
  ))
  const snapshotSvg = snapshotElements.length > 0 ? exportBoardSvg({
    elements: snapshotElements,
    title: input.title,
    padding: 16,
  }) : ''

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
    current_page: {
      id: currentPageId,
      name: currentPage?.name || input.title,
    },
    current_tool: input.tool || 'select',
    active_style: whiteboardStyleToAgentStyle(input.activeStyle || DEFAULT_WHITEBOARD_STYLE),
    viewport_snapshot: snapshotSvg
      ? {
          mime_type: 'image/svg+xml',
          data_url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(snapshotSvg)}`,
        }
      : undefined,
    lint_findings: lintFindings.map((finding) => ({
      code: finding.code,
      element_ids: finding.elementIds,
      severity: finding.severity,
    })),
  }
}

export function whiteboardElementToAgentElement(
  element: WhiteboardElement,
): AgentWhiteboardElement {
  const result: AgentWhiteboardElement = {
    id: element.id,
    kind: getBoardAgentElementKind(element),
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
  result.locked = Boolean(element.locked)
  result.rotation = element.rotation || 0
  result.style = whiteboardStyleToAgentStyle(getWhiteboardElementStyle(element))
  if (element.kind === 'rectangle') {
    result.shape_type = element.shapeType
    result.shape_style = element.shapeStyle
  }
  if (element.kind === 'connector') {
    result.connector = {
      type: element.connectorType || 'straight',
      start_arrowhead: element.startArrowhead || 'none',
      end_arrowhead: element.endArrowhead || 'arrow',
    }
  }
  return result
}

function whiteboardStyleToAgentStyle(style: WhiteboardElementStyle) {
  return {
    stroke_color: style.strokeColor,
    fill_color: style.fillColor,
    opacity: style.opacity,
    fill_style: style.fillStyle,
    dash_style: style.dashStyle,
    stroke_size: style.strokeSize,
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
