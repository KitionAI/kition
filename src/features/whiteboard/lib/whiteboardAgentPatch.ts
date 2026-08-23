import { z } from 'zod'

import type {
  AgentWhiteboardElement,
  AgentWhiteboardElementKind,
  AgentWhiteboardPatch,
} from '@/types/whiteboardAgent'
import {
  AGENT_WHITEBOARD_PATCH_OPERATION_LIMIT,
  AGENT_WHITEBOARD_SCHEMA_VERSION,
} from '@/types/whiteboardAgent'

import {
  boardElementFromRecord,
  cloneBoardRecord,
  compareBoardRecords,
  createBoardElementRecord,
  type BoardElementRecord,
  type BoardRecord,
} from './boardRecords'
import type { BoardRecordDiff, BoardStore } from './boardStore'
import { getWhiteboardElementBounds } from './whiteboardGeometry'
import type {
  WhiteboardElement,
  WhiteboardRectangleStyle,
} from './whiteboardTypes'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const CLIENT_MAX_COORDINATE = 1_000_000
const CLIENT_MAX_DIMENSION = 100_000
const CLIENT_MAX_TOTAL_AREA = 500_000_000

const identifierSchema = z.string().min(1).max(128).regex(IDENTIFIER)
const boundsSchema = z.object({
  x: z.number().finite().min(-CLIENT_MAX_COORDINATE).max(CLIENT_MAX_COORDINATE),
  y: z.number().finite().min(-CLIENT_MAX_COORDINATE).max(CLIENT_MAX_COORDINATE),
  width: z.number().finite().min(1).max(CLIENT_MAX_DIMENSION),
  height: z.number().finite().min(1).max(CLIENT_MAX_DIMENSION),
}).strict()
const elementKindSchema = z.enum([
  'shape',
  'text',
  'sticky',
  'image',
  'connector',
  'freehand',
  'mind_node',
  'flow_node',
  'frame',
  'group',
])
const sourceRefIdsSchema = z.array(identifierSchema).max(16).refine(
  (ids) => new Set(ids).size === ids.length,
  'Source reference ids must be unique',
)
const elementSchema = z.object({
  id: identifierSchema,
  kind: elementKindSchema,
  bounds: boundsSchema,
  text: z.string().max(2000).optional(),
  parent_id: identifierSchema.optional(),
  source_ref_ids: sourceRefIdsSchema.optional(),
}).strict()
const elementChangesSchema = z.object({
  kind: elementKindSchema.optional(),
  bounds: boundsSchema.optional(),
  text: z.string().max(2000).optional(),
  parent_id: identifierSchema.nullable().optional(),
  source_ref_ids: sourceRefIdsSchema.optional(),
}).strict().refine((changes) => Object.keys(changes).length > 0, 'Changes cannot be empty')
const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('element.create'), element: elementSchema }).strict(),
  z.object({
    op: z.literal('element.update'),
    element_id: identifierSchema,
    changes: elementChangesSchema,
  }).strict(),
  z.object({ op: z.literal('element.delete'), element_id: identifierSchema }).strict(),
  z.object({
    op: z.literal('element.reorder'),
    element_id: identifierSchema,
    after_element_id: identifierSchema.nullable(),
  }).strict(),
])
const patchSchema = z.object({
  type: z.literal('whiteboard.patch'),
  schema_version: z.literal(AGENT_WHITEBOARD_SCHEMA_VERSION),
  summary: z.string().trim().min(1).max(2000),
  operations: z.array(operationSchema).min(1).max(AGENT_WHITEBOARD_PATCH_OPERATION_LIMIT),
}).strict()

export type WhiteboardAgentPatchPreview = {
  added: WhiteboardElement[]
  deleted: WhiteboardElement[]
  updated: WhiteboardElement[]
}

export function parseAgentWhiteboardPatch(value: unknown): AgentWhiteboardPatch {
  const parsed = patchSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`Invalid AI Board patch: ${issue?.message || 'unknown payload'}`)
  }
  const patch = parsed.data as AgentWhiteboardPatch
  validatePatchArea(patch.operations)
  return patch
}

export function translateAgentWhiteboardPatch(input: {
  patch: AgentWhiteboardPatch
  store: BoardStore
}): BoardRecordDiff {
  const pageId = input.store.getCurrentPageId()
  const originalRecords = input.store.getRecords()
    .filter((record): record is BoardElementRecord => (
      record.record_type === 'element' && record.page_id === pageId
    ))
  const originalById = new Map(originalRecords.map((record) => [record.id, record]))
  const working = new Map(originalRecords.map((record) => [record.id, cloneBoardRecord(record) as BoardElementRecord]))
  const order = originalRecords.map((record) => record.id)

  for (const operation of input.patch.operations) {
    switch (operation.op) {
      case 'element.create': {
        if (input.store.getRecord(operation.element.id) || working.has(operation.element.id)) {
          throw new Error(`AI Board patch reuses an existing id: ${operation.element.id}`)
        }
        const element = agentElementToWhiteboardElement(operation.element)
        working.set(element.id, createBoardElementRecord({
          element,
          index: order.length,
          pageId,
        }))
        order.push(element.id)
        break
      }
      case 'element.update': {
        const current = requireEditableElement(working, operation.element_id)
        const semantic = boardRecordToAgentElement(current)
        const nextSemantic: AgentWhiteboardElement = {
          ...semantic,
          ...operation.changes,
          id: semantic.id,
          parent_id: operation.changes.parent_id === null
            ? undefined
            : operation.changes.parent_id ?? semantic.parent_id,
        }
        const next = agentElementToWhiteboardElement(
          nextSemantic,
          boardElementFromRecord(current),
        )
        working.set(next.id, createBoardElementRecord({
          element: next,
          index: current.index,
          pageId,
        }))
        break
      }
      case 'element.delete': {
        requireEditableElement(working, operation.element_id)
        working.delete(operation.element_id)
        order.splice(order.indexOf(operation.element_id), 1)
        break
      }
      case 'element.reorder': {
        requireEditableElement(working, operation.element_id)
        if (operation.after_element_id === operation.element_id) {
          throw new Error('AI Board patch cannot reorder an element after itself')
        }
        if (operation.after_element_id !== null && !working.has(operation.after_element_id)) {
          throw new Error(`AI Board patch references a missing reorder target: ${operation.after_element_id}`)
        }
        order.splice(order.indexOf(operation.element_id), 1)
        const targetIndex = operation.after_element_id === null
          ? 0
          : order.indexOf(operation.after_element_id) + 1
        order.splice(targetIndex, 0, operation.element_id)
        break
      }
    }
  }

  for (const record of working.values()) {
    const parentId = record.parentId
    if (!parentId) continue
    if (parentId === record.id || !working.has(parentId)) {
      throw new Error(`AI Board patch references a missing parent: ${parentId}`)
    }
  }

  order.forEach((id, index) => {
    const record = working.get(id)
    if (record && record.index !== index) working.set(id, { ...record, index })
  })

  const diff: BoardRecordDiff = { added: [], updated: [], removed: [] }
  for (const original of originalRecords) {
    const after = working.get(original.id)
    if (!after) diff.removed.push(cloneBoardRecord(original))
    else if (!recordsMatch(original, after)) {
      diff.updated.push({
        before: cloneBoardRecord(original),
        after: cloneBoardRecord(after),
      })
    }
  }
  for (const record of working.values()) {
    if (!originalById.has(record.id)) diff.added.push(cloneBoardRecord(record))
  }
  diff.added.sort(compareBoardRecords)
  diff.removed.sort(compareBoardRecords)
  diff.updated.sort((left, right) => compareBoardRecords(left.after, right.after))
  return diff
}

export function buildWhiteboardAgentPatchPreview(
  diff: BoardRecordDiff,
): WhiteboardAgentPatchPreview {
  return {
    added: diff.added.flatMap(recordToElement),
    deleted: diff.removed.flatMap(recordToElement),
    updated: diff.updated.flatMap((update) => recordToElement(update.after)),
  }
}

function requireEditableElement(
  records: Map<string, BoardElementRecord>,
  id: string,
) {
  const record = records.get(id)
  if (!record) throw new Error(`AI Board patch references a missing element: ${id}`)
  if (record.locked) throw new Error(`AI Board patch cannot change a locked element: ${id}`)
  return record
}

function boardRecordToAgentElement(record: BoardElementRecord): AgentWhiteboardElement {
  const element = boardElementFromRecord(record)
  return {
    id: element.id,
    kind: internalKindToAgentKind(element),
    bounds: getWhiteboardElementBounds(element),
    text: element.kind === 'text' || element.kind === 'rectangle'
      ? element.text
      : undefined,
    parent_id: element.parentId,
    source_ref_ids: element.sourceRefIds,
  }
}

function agentElementToWhiteboardElement(
  element: AgentWhiteboardElement,
  existing?: WhiteboardElement,
): WhiteboardElement {
  const metadata = {
    id: element.id,
    locked: false,
    parentId: element.parent_id,
    rotation: existing?.rotation || 0,
    sourceRefIds: element.source_ref_ids ? [...element.source_ref_ids] : undefined,
    style: existing?.style ? { ...existing.style } : undefined,
  }
  const bounds = { ...element.bounds }
  switch (element.kind) {
    case 'text':
      return {
        ...metadata,
        kind: 'text',
        x: bounds.x,
        y: bounds.y + bounds.height,
        text: element.text || '',
        fontSize: Math.max(8, Math.min(72, bounds.height * 0.72)),
      }
    case 'connector':
      return {
        ...metadata,
        kind: 'connector',
        start: { x: bounds.x, y: bounds.y + bounds.height / 2 },
        end: { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 },
      }
    case 'freehand':
      return {
        ...metadata,
        kind: 'stroke',
        points: [
          { x: bounds.x, y: bounds.y + bounds.height },
          { x: bounds.x + bounds.width / 2, y: bounds.y },
          { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
        ],
      }
    case 'image':
      if (existing?.kind === 'image') {
        return {
          ...existing,
          ...metadata,
          ...bounds,
          kind: 'image',
        }
      }
      return {
        ...metadata,
        ...bounds,
        kind: 'rectangle',
        shapeStyle: 'image-placeholder',
        text: element.text,
      }
    default:
      return {
        ...metadata,
        ...bounds,
        kind: 'rectangle',
        shapeStyle: agentKindToRectangleStyle(element.kind),
        text: element.text,
      }
  }
}

function internalKindToAgentKind(element: WhiteboardElement): AgentWhiteboardElementKind {
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

function agentKindToRectangleStyle(
  kind: AgentWhiteboardElementKind,
): WhiteboardRectangleStyle {
  switch (kind) {
    case 'sticky': return 'sticky'
    case 'mind_node': return 'mind-node'
    case 'flow_node': return 'flow-node'
    case 'frame': return 'frame'
    case 'group': return 'group'
    case 'image': return 'image-placeholder'
    default: return 'default'
  }
}

function recordToElement(record: BoardRecord): WhiteboardElement[] {
  return record.record_type === 'element' ? [boardElementFromRecord(record)] : []
}

function recordsMatch(left: BoardRecord, right: BoardRecord) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validatePatchArea(
  operations: AgentWhiteboardPatch['operations'],
) {
  let totalArea = 0
  for (const operation of operations) {
    const bounds = operation.op === 'element.create'
      ? operation.element.bounds
      : operation.op === 'element.update'
        ? operation.changes.bounds
        : undefined
    if (bounds) totalArea += bounds.width * bounds.height
    if (totalArea > CLIENT_MAX_TOTAL_AREA) {
      throw new Error('Invalid AI Board patch: generated area is too large')
    }
  }
}
