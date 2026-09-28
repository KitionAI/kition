/**
 * Builds the bounded design context the Agent reads: artboard, layers with
 * world bounds and style, and role hints. Pure; validated against the
 * contract in its spec. Image bytes and host paths never enter the payload.
 */
import {
  AGENT_DESIGN_CONTEXT_LAYER_LIMIT,
  AGENT_DESIGN_SCHEMA_VERSION,
  AGENT_DESIGN_SELECTION_LIMIT,
  AGENT_DESIGN_TEXT_LIMIT,
  type AgentDesignContext,
  type AgentDesignLayer,
  type AgentDesignLayerRole,
  type AgentDesignStyle,
} from '@/types/designAgent'
import { selectionBounds, worldMatrix } from './designGeometry'
import type { DesignDocument, DesignNode } from './designTypes'

const MAX_RECENT_OPERATIONS = 50
const BACKGROUND_COVERAGE = 0.8

export function buildDesignAgentContext(input: {
  document: DesignDocument
  path: string
  selection: readonly string[]
  recentOperations?: readonly string[]
  brand?: AgentDesignContext['brand']
}): AgentDesignContext | null {
  const path = portableDesignPath(input.path)
  if (!path) return null
  const doc = input.document
  const page = doc.pages[0]
  const order = flattenLayers(doc)
  const selected = input.selection
    .filter((id, index, ids) => ids.indexOf(id) === index && doc.nodes[id])
    .slice(0, AGENT_DESIGN_SELECTION_LIMIT)
  const selectedSet = new Set(selected)
  // Selected layers always fit; the rest fill the remaining budget in z order.
  const included = [
    ...order.filter((entry) => selectedSet.has(entry.id)),
    ...order.filter((entry) => !selectedSet.has(entry.id)),
  ]
    .slice(0, AGENT_DESIGN_CONTEXT_LAYER_LIMIT)
    .sort((a, b) => a.index - b.index)
  const headline = largestText(doc)
  const artboardArea = page.width * page.height
  const layers = included.map(({ id, parent }) =>
    describeLayer(doc, id, parent, headline, artboardArea),
  )
  const context: AgentDesignContext = {
    type: 'design.context',
    schema_version: AGENT_DESIGN_SCHEMA_VERSION,
    design: { id: doc.id, path, title: doc.title || 'Untitled design' },
    artboard: {
      width: page.width,
      height: page.height,
      background: page.background,
    },
    selected_layer_ids: selected,
    layers,
    recent_operations: (input.recentOperations || [])
      .filter((entry) => entry.trim().length > 0)
      .slice(-MAX_RECENT_OPERATIONS)
      .map((entry) => entry.slice(0, 500)),
  }
  if (input.brand) context.brand = input.brand
  return context
}

/** Rejects absolute, drive-letter, and parent-traversal paths. */
export function portableDesignPath(path: string): string | null {
  const trimmed = path.trim().replace(/\\/g, '/')
  if (!trimmed || trimmed.length > 1024) return null
  if (trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)) return null
  if (trimmed.split('/').includes('..')) return null
  return trimmed
}

function flattenLayers(doc: DesignDocument) {
  const entries: Array<{ id: string; parent?: string; index: number }> = []
  const visit = (ids: readonly string[], parent?: string) => {
    for (const id of ids) {
      const node = doc.nodes[id]
      if (!node) continue
      entries.push({ id, parent, index: entries.length })
      if (node.children.length) visit(node.children, id)
    }
  }
  visit(doc.pages[0].children)
  return entries
}

function largestText(doc: DesignDocument): string | null {
  let best: DesignNode | null = null
  for (const node of Object.values(doc.nodes)) {
    if (node.type !== 'text' || !node.visible) continue
    if (!best || node.fontSize > best.fontSize) best = node
  }
  return best?.id ?? null
}

function describeLayer(
  doc: DesignDocument,
  id: string,
  parent: string | undefined,
  headline: string | null,
  artboardArea: number,
): AgentDesignLayer {
  const node = doc.nodes[id]
  const bounds = selectionBounds(doc, [id])
  const layer: AgentDesignLayer = {
    id,
    kind: node.type,
    name: node.name.slice(0, 200),
    bounds: {
      x: round(bounds.x),
      y: round(bounds.y),
      width: round(bounds.width),
      height: round(bounds.height),
    },
    role: layerRole(node, id === headline, bounds.width * bounds.height / artboardArea),
  }
  const rotation = rotationDegrees(worldMatrix(doc, id))
  if (rotation) layer.rotation = rotation
  if (node.type === 'text') layer.text = node.text.slice(0, AGENT_DESIGN_TEXT_LIMIT)
  if (node.type !== 'group' && node.type !== 'image') layer.style = layerStyle(node)
  if (parent) layer.parent_id = parent
  if (node.locked) layer.locked = true
  return layer
}

function layerRole(node: DesignNode, isHeadline: boolean, coverage: number): AgentDesignLayerRole {
  if (node.type === 'group') return 'group'
  if (node.type === 'image') return 'image'
  if (node.type === 'text') {
    if (isHeadline) return 'headline'
    return node.fontSize <= 24 ? 'label' : 'body'
  }
  return coverage >= BACKGROUND_COVERAGE ? 'background' : 'accent'
}

/** Style fields the contract exposes, in its snake_case names. */
function layerStyle(node: DesignNode): AgentDesignStyle {
  const style: AgentDesignStyle = { fill: node.fill, opacity: round(node.opacity) }
  if (node.type === 'text') {
    style.font_family = node.fontFamily
    style.font_size = round(node.fontSize)
    style.font_weight = node.fontWeight
    style.text_align = node.textAlign
    style.line_height = round(node.lineHeight)
    style.letter_spacing = round(node.letterSpacing)
  } else {
    style.stroke = node.stroke
    style.stroke_width = round(node.strokeWidth)
    if (node.type === 'rectangle') style.radius = round(node.radius)
  }
  return style
}

function rotationDegrees(matrix: readonly number[]): number {
  const degrees = (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI
  return round(degrees)
}

const round = (value: number) => Math.round(value * 100) / 100
