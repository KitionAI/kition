/**
 * Validates an Agent design patch against the client's copy of the contract
 * and folds it through the command reducer, so one accepted patch becomes
 * one undo step. Unknown layers and locked layers fail the whole patch:
 * partial application would leave the artboard in a state nobody proposed.
 */
import { z } from 'zod'
import {
  AGENT_DESIGN_PATCH_OPERATION_LIMIT,
  AGENT_DESIGN_SCHEMA_VERSION,
  AGENT_DESIGN_TEXT_LIMIT,
  type AgentDesignPatch,
  type AgentDesignPatchOperation,
  type AgentDesignStyle,
} from '@/types/designAgent'
import { applyDesignCommand, type DesignCommand } from './designCommands'
import { isNodeLocked, selectionBounds, translation } from './designGeometry'
import type { DesignStore } from './designStore'
import { createDesignNode, DESIGN_MAX_NODES, type DesignDocument, type DesignNode } from './designTypes'

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const color = z.string().regex(/^(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent)$/)
const coordinate = z.number().finite().min(-100_000).max(100_000)
const bounds = z
  .object({
    x: coordinate,
    y: coordinate,
    width: z.number().finite().min(0).max(100_000),
    height: z.number().finite().min(0).max(100_000),
  })
  .strict()
const style = z
  .object({
    fill: color.optional(),
    stroke: color.optional(),
    stroke_width: z.number().finite().min(0).max(200).optional(),
    radius: z.number().finite().min(0).max(10_000).optional(),
    opacity: z.number().finite().min(0).max(1).optional(),
    font_family: z.enum(['Arial', 'Georgia', 'Courier New']).optional(),
    font_size: z.number().finite().min(1).max(2000).optional(),
    font_weight: z.number().int().min(100).max(900).multipleOf(100).optional(),
    text_align: z.enum(['left', 'center', 'right']).optional(),
    line_height: z.number().finite().min(0.5).max(4).optional(),
    letter_spacing: z.number().finite().min(-50).max(200).optional(),
  })
  .strict()
const layerIds = z
  .array(identifier)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'Layer ids must be unique')
const creatableLayer = z
  .object({
    id: identifier,
    kind: z.enum(['text', 'rectangle', 'ellipse', 'line']),
    name: z.string().max(200).optional(),
    bounds: bounds.extend({
      width: z.number().finite().min(1).max(100_000),
      height: z.number().finite().min(1).max(100_000),
    }),
    rotation: z.number().finite().min(-360).max(360).optional(),
    text: z.string().max(AGENT_DESIGN_TEXT_LIMIT).optional(),
    style: style.optional(),
    role: z.enum(['headline', 'body', 'label', 'accent', 'background', 'image', 'group']).optional(),
    parent_id: identifier.optional(),
    locked: z.boolean().optional(),
  })
  .strict()
const operation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('text.set'), layer_id: identifier, text: z.string().max(AGENT_DESIGN_TEXT_LIMIT) }).strict(),
  z
    .object({
      op: z.literal('style.set'),
      layer_ids: layerIds,
      style: style.refine((value) => Object.keys(value).length > 0, 'Style cannot be empty'),
    })
    .strict(),
  z.object({ op: z.literal('layer.create'), layer: creatableLayer }).strict(),
  z
    .object({
      op: z.literal('layer.move'),
      layer_ids: layerIds,
      delta: z.object({ x: coordinate, y: coordinate }).strict(),
    })
    .strict(),
  z.object({ op: z.literal('layer.resize'), layer_id: identifier, bounds }).strict(),
  z.object({ op: z.literal('layer.reorder'), layer_id: identifier, direction: z.enum(['forward', 'backward']) }).strict(),
  z.object({ op: z.literal('layer.delete'), layer_ids: layerIds }).strict(),
  z
    .object({
      op: z.literal('layout.align'),
      layer_ids: layerIds,
      edge: z.enum(['left', 'centerX', 'right', 'top', 'centerY', 'bottom']),
      reference: z.enum(['selection', 'artboard']).optional(),
    })
    .strict(),
  z.object({ op: z.literal('layout.distribute'), layer_ids: layerIds, axis: z.enum(['x', 'y']) }).strict(),
  z.object({ op: z.literal('artboard.background'), background: color }).strict(),
])
const patchSchema = z
  .object({
    type: z.literal('design.patch'),
    schema_version: z.literal(AGENT_DESIGN_SCHEMA_VERSION),
    summary: z.string().min(1).max(2000),
    operations: z.array(operation).min(1).max(AGENT_DESIGN_PATCH_OPERATION_LIMIT),
  })
  .strict()

export type DesignAgentPatchResult =
  | { ok: true; patch: AgentDesignPatch }
  | { ok: false; error: string }

/** Structural validation only; layer references are checked when applying. */
export function parseDesignAgentPatch(value: unknown): DesignAgentPatchResult {
  const parsed = patchSchema.safeParse(value)
  if (parsed.success) return { ok: true, patch: parsed.data as AgentDesignPatch }
  const issue = parsed.error.issues[0]
  return { ok: false, error: `${issue.path.join('.') || 'patch'}: ${issue.message}` }
}

/**
 * Applies every operation in order and returns the resulting document.
 * Throws on a missing or locked layer so the caller can reject the patch.
 */
export function reduceDesignAgentPatch(source: DesignDocument, patch: AgentDesignPatch): DesignDocument {
  let doc = source
  for (const op of patch.operations) for (const command of commandsFor(doc, op)) doc = applyDesignCommand(doc, command)
  return doc
}

/** One accepted patch is one undo step on the store. */
export function applyDesignAgentPatch(store: DesignStore, patch: AgentDesignPatch): void {
  store.commit(reduceDesignAgentPatch(store.getSnapshot().document, patch))
}

function commandsFor(doc: DesignDocument, op: AgentDesignPatchOperation): DesignCommand[] {
  switch (op.op) {
    case 'text.set': {
      const node = existing(doc, op.layer_id)
      if (node.type !== 'text') throw new Error(`Layer ${op.layer_id} is not a text layer`)
      return [{ type: 'patch', ids: [op.layer_id], patch: { text: op.text } }]
    }
    case 'style.set':
      op.layer_ids.forEach((id) => existing(doc, id))
      return [{ type: 'patch', ids: op.layer_ids, patch: nodePatch(op.style) }]
    case 'layer.create': {
      if (doc.nodes[op.layer.id]) throw new Error(`Layer ${op.layer.id} already exists`)
      if (Object.keys(doc.nodes).length >= DESIGN_MAX_NODES) throw new Error('Layer limit reached')
      const { bounds: b } = op.layer
      const node = createDesignNode(op.layer.kind, {
        id: op.layer.id,
        name: op.layer.name || op.layer.kind,
        transform: translation(b.x, b.y),
        width: b.width,
        height: b.height,
        text: op.layer.kind === 'text' ? (op.layer.text ?? '') : '',
        ...(op.layer.style ? nodePatch(op.layer.style) : {}),
      })
      return [{ type: 'insert', nodes: [node] }]
    }
    case 'layer.move':
      op.layer_ids.forEach((id) => existing(doc, id))
      return [{ type: 'transform', ids: op.layer_ids, matrix: translation(op.delta.x, op.delta.y) }]
    case 'layer.resize': {
      existing(doc, op.layer_id)
      const current = selectionBounds(doc, [op.layer_id])
      return [
        { type: 'patch', ids: [op.layer_id], patch: { width: op.bounds.width, height: op.bounds.height } },
        { type: 'transform', ids: [op.layer_id], matrix: translation(op.bounds.x - current.x, op.bounds.y - current.y) },
      ]
    }
    case 'layer.reorder':
      existing(doc, op.layer_id)
      return [{ type: 'reorder', id: op.layer_id, direction: op.direction === 'forward' ? 1 : -1 }]
    case 'layer.delete':
      op.layer_ids.forEach((id) => existing(doc, id))
      return [{ type: 'remove', ids: op.layer_ids }]
    case 'layout.align':
      op.layer_ids.forEach((id) => existing(doc, id))
      return [{ type: 'align', ids: op.layer_ids, edge: op.edge, reference: op.reference }]
    case 'layout.distribute':
      op.layer_ids.forEach((id) => existing(doc, id))
      return [{ type: 'distribute', ids: op.layer_ids, axis: op.axis }]
    case 'artboard.background':
      return [{ type: 'page', patch: { background: op.background } }]
  }
}

function existing(doc: DesignDocument, id: string): DesignNode {
  const node = doc.nodes[id]
  if (!node) throw new Error(`Unknown layer ${id}`)
  if (isNodeLocked(doc, id)) throw new Error(`Layer ${id} is locked`)
  return node
}

function nodePatch(style: AgentDesignStyle): Partial<DesignNode> {
  const patch: Partial<DesignNode> = {}
  if (style.fill !== undefined) patch.fill = style.fill
  if (style.stroke !== undefined) patch.stroke = style.stroke
  if (style.stroke_width !== undefined) patch.strokeWidth = style.stroke_width
  if (style.radius !== undefined) patch.radius = style.radius
  if (style.opacity !== undefined) patch.opacity = style.opacity
  if (style.font_family !== undefined) patch.fontFamily = style.font_family
  if (style.font_size !== undefined) patch.fontSize = style.font_size
  if (style.font_weight !== undefined) patch.fontWeight = style.font_weight
  if (style.text_align !== undefined) patch.textAlign = style.text_align
  if (style.line_height !== undefined) patch.lineHeight = style.line_height
  if (style.letter_spacing !== undefined) patch.letterSpacing = style.letter_spacing
  return patch
}
