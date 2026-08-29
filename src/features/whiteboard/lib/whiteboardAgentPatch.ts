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
  createBoardConnectorBindingRecord,
  getBoardConnectorAnchor,
  resolveBoardConnectorAnchor,
} from './boardBindingEngine'
import {
  alignBoardElements,
  distributeBoardElements,
  stackBoardElements,
} from './boardLayout'
import {
  boardElementFromRecord,
  cloneBoardRecord,
  compareBoardRecords,
  createBoardElementRecord,
  type BoardElementRecord,
  type BoardRecord,
} from './boardRecords'
import type { BoardRecordDiff, BoardStore } from './boardStore'
import {
  getWhiteboardElementBounds,
  getWhiteboardSelectionBounds,
  rotateWhiteboardElementsByDegrees,
  scaleWhiteboardElements,
  translateWhiteboardElement,
} from './whiteboardGeometry'
import {
  getWhiteboardElementStyle,
  normalizeWhiteboardStyle,
} from './whiteboardStyle'
import { isWhiteboardMindMapNode } from './whiteboardMindMap'
import type {
  WhiteboardElement,
  WhiteboardRectangleStyle,
  WhiteboardShapeType,
} from './whiteboardTypes'
import { WHITEBOARD_PALETTE_SHAPE_TYPES } from './boardElementDefinitions'

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
const styleObjectSchema = z.object({
  stroke_color: z.enum(['ink', 'gray', 'purple', 'green', 'orange', 'red', 'yellow', 'blue', 'white']).optional(),
  fill_color: z.enum(['ink', 'gray', 'purple', 'green', 'orange', 'red', 'yellow', 'blue', 'white']).optional(),
  opacity: z.number().finite().min(0.05).max(1).optional(),
  fill_style: z.enum(['none', 'solid', 'semi', 'pattern']).optional(),
  dash_style: z.enum(['solid', 'dashed', 'dotted']).optional(),
  stroke_size: z.enum(['s', 'm', 'l', 'xl']).optional(),
}).strict()
const elementSchema = z.object({
  id: identifierSchema,
  kind: elementKindSchema,
  bounds: boundsSchema,
  text: z.string().max(2000).optional(),
  parent_id: identifierSchema.optional(),
  source_ref_ids: sourceRefIdsSchema.optional(),
  rotation: z.number().finite().min(-3600).max(3600).optional(),
  shape_type: z.string().max(64).optional(),
  shape_style: z.string().max(64).optional(),
  style: styleObjectSchema.optional(),
}).strict()
const creatableElementSchema = elementSchema.refine(
  (element) => element.kind !== 'connector',
  'Use connector.create for connectors',
)
const elementChangesSchema = z.object({
  kind: elementKindSchema.optional(),
  bounds: boundsSchema.optional(),
  text: z.string().max(2000).optional(),
  parent_id: identifierSchema.nullable().optional(),
  source_ref_ids: sourceRefIdsSchema.optional(),
}).strict().refine((changes) => Object.keys(changes).length > 0, 'Changes cannot be empty')
const connectorSchema = z.object({
  id: identifierSchema,
  from_id: identifierSchema,
  to_id: identifierSchema,
}).strict().refine(
  (connector) => connector.from_id !== connector.to_id,
  'Connector endpoints must be different',
)
const elementIdsSchema = z.array(identifierSchema).min(1).max(100).refine(
  (ids) => new Set(ids).size === ids.length,
  'Element ids must be unique',
)
const styleChangesSchema = styleObjectSchema.refine(
  (style) => Object.keys(style).length > 0,
  'Style changes cannot be empty',
)
const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('element.create'), element: creatableElementSchema }).strict(),
  z.object({ op: z.literal('connector.create'), connector: connectorSchema }).strict(),
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
  z.object({
    op: z.literal('element.move'),
    element_ids: elementIdsSchema,
    delta: z.object({
      x: z.number().finite().min(-CLIENT_MAX_COORDINATE).max(CLIENT_MAX_COORDINATE),
      y: z.number().finite().min(-CLIENT_MAX_COORDINATE).max(CLIENT_MAX_COORDINATE),
    }).strict(),
  }).strict(),
  z.object({
    op: z.literal('element.rotate'),
    element_ids: elementIdsSchema,
    degrees: z.number().finite().min(-3600).max(3600),
  }).strict(),
  z.object({
    op: z.literal('element.resize'),
    element_ids: elementIdsSchema,
    scale_x: z.number().finite().min(0.05).max(20),
    scale_y: z.number().finite().min(0.05).max(20),
  }).strict(),
  z.object({
    op: z.literal('element.style'),
    element_ids: elementIdsSchema,
    style: styleChangesSchema,
  }).strict(),
  z.object({
    op: z.literal('layout.align'),
    element_ids: elementIdsSchema,
    alignment: z.enum(['left', 'center-horizontal', 'right', 'top', 'center-vertical', 'bottom']),
  }).strict(),
  z.object({
    op: z.literal('layout.distribute'),
    element_ids: elementIdsSchema,
    direction: z.enum(['horizontal', 'vertical']),
  }).strict(),
  z.object({
    op: z.literal('layout.stack'),
    element_ids: elementIdsSchema,
    direction: z.enum(['horizontal', 'vertical']),
    gap: z.number().finite().min(0).max(10000).optional(),
  }).strict(),
  z.object({
    op: z.literal('element.group'),
    container_id: identifierSchema,
    container_kind: z.enum(['group', 'frame']),
    element_ids: elementIdsSchema,
  }).strict(),
  z.object({
    op: z.literal('element.ungroup'),
    container_ids: elementIdsSchema,
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
  const originalBindings = input.store.getRecords().filter((record): record is Extract<
    BoardRecord,
    { record_type: 'binding' }
  > => (
    record.record_type === 'binding'
    && originalById.has(record.from_id)
  ))
  const working = new Map(originalRecords.map((record) => [record.id, cloneBoardRecord(record) as BoardElementRecord]))
  const order = originalRecords.map((record) => record.id)
  const connectorOperations: Array<Extract<AgentWhiteboardPatch['operations'][number], {
    op: 'connector.create'
  }>> = []

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
      case 'connector.create':
        connectorOperations.push(operation)
        break
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
      case 'element.move': {
        const elements = requireEditableElements(working, operation.element_ids)
        putWorkingElements(working, elements.map((element) => (
          translateWhiteboardElement(element, operation.delta)
        )), pageId)
        break
      }
      case 'element.rotate': {
        const elements = requireEditableElements(working, operation.element_ids)
        const bounds = getWhiteboardSelectionBounds(elements)
        if (!bounds) throw new Error('AI Board rotate action has no bounds')
        putWorkingElements(working, rotateWhiteboardElementsByDegrees({
          elements,
          origin: {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
          },
          degrees: operation.degrees,
        }), pageId)
        break
      }
      case 'element.resize': {
        const elements = requireEditableElements(working, operation.element_ids)
        const bounds = getWhiteboardSelectionBounds(elements)
        if (!bounds) throw new Error('AI Board resize action has no bounds')
        putWorkingElements(working, scaleWhiteboardElements({
          elements,
          bounds,
          scaleX: operation.scale_x,
          scaleY: operation.scale_y,
        }), pageId)
        break
      }
      case 'element.style': {
        const elements = requireEditableElements(working, operation.element_ids)
        const patch = {
          strokeColor: operation.style.stroke_color,
          fillColor: operation.style.fill_color,
          opacity: operation.style.opacity,
          fillStyle: operation.style.fill_style,
          dashStyle: operation.style.dash_style,
          strokeSize: operation.style.stroke_size,
        }
        putWorkingElements(working, elements.map((element) => ({
          ...element,
          style: normalizeWhiteboardStyle({
            ...getWhiteboardElementStyle(element),
            ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
          }),
        })), pageId)
        break
      }
      case 'layout.align': {
        const elements = requireEditableElements(working, operation.element_ids)
        putWorkingElements(working, alignBoardElements(elements, operation.alignment), pageId)
        break
      }
      case 'layout.distribute': {
        const elements = requireEditableElements(working, operation.element_ids)
        putWorkingElements(working, distributeBoardElements(elements, operation.direction), pageId)
        break
      }
      case 'layout.stack': {
        const elements = requireEditableElements(working, operation.element_ids)
        putWorkingElements(working, stackBoardElements(
          elements,
          operation.direction,
          operation.gap ?? 24,
        ), pageId)
        break
      }
      case 'element.group':
        groupWorkingElements({ operation, order, pageId, working })
        break
      case 'element.ungroup':
        ungroupWorkingElements({ containerIds: operation.container_ids, order, pageId, working })
        break
    }
  }

  const addedBindings = connectorOperations.flatMap((operation) => {
    const connector = operation.connector
    if (input.store.getRecord(connector.id) || working.has(connector.id)) {
      throw new Error(`AI Board patch reuses an existing id: ${connector.id}`)
    }
    const fromRecord = requireConnectorTarget(working, connector.from_id)
    const toRecord = requireConnectorTarget(working, connector.to_id)
    const fromElement = boardElementFromRecord(fromRecord)
    const toElement = boardElementFromRecord(toRecord)
    const fromBounds = getWhiteboardElementBounds(fromElement)
    const toBounds = getWhiteboardElementBounds(toElement)
    const fromAnchor = getBoardConnectorAnchor(fromElement, {
      x: toBounds.x + toBounds.width / 2,
      y: toBounds.y + toBounds.height / 2,
    })
    const toAnchor = getBoardConnectorAnchor(toElement, {
      x: fromBounds.x + fromBounds.width / 2,
      y: fromBounds.y + fromBounds.height / 2,
    })
    if (!fromAnchor || !toAnchor) {
      throw new Error(`AI Board connector has invalid endpoints: ${connector.id}`)
    }
    const mindMapBranch = isWhiteboardMindMapNode(fromElement)
      && isWhiteboardMindMapNode(toElement)
    const element: Extract<WhiteboardElement, { kind: 'connector' }> = {
      id: connector.id,
      kind: 'connector',
      locked: false,
      rotation: 0,
      start: fromAnchor.point,
      end: toAnchor.point,
      connectorRole: mindMapBranch ? 'mind-map-branch' : undefined,
      connectorType: 'straight',
      startArrowhead: 'none',
      endArrowhead: mindMapBranch ? 'none' : 'arrow',
    }
    working.set(element.id, createBoardElementRecord({
      element,
      index: order.length,
      pageId,
    }))
    order.push(element.id)
    return [
      createBoardConnectorBindingRecord({
        anchor: fromAnchor,
        connectorId: connector.id,
        terminal: 'start',
      }),
      createBoardConnectorBindingRecord({
        anchor: toAnchor,
        connectorId: connector.id,
        terminal: 'end',
      }),
    ]
  })

  for (const record of working.values()) {
    const parentId = record.parentId
    if (!parentId) continue
    if (parentId === record.id || !working.has(parentId)) {
      throw new Error(`AI Board patch references a missing parent: ${parentId}`)
    }
  }

  const validBindings = [...originalBindings, ...addedBindings].filter((binding) => {
    const connectorRecord = working.get(binding.from_id)
    const targetRecord = working.get(binding.to_id)
    if (
      connectorRecord?.kind !== 'connector'
      || !targetRecord
      || !binding.to_anchor
      || (binding.terminal !== 'start' && binding.terminal !== 'end')
    ) return false
    const connector = boardElementFromRecord(connectorRecord)
    const target = boardElementFromRecord(targetRecord)
    if (connector.kind !== 'connector') return false
    working.set(connector.id, createBoardElementRecord({
      element: {
        ...connector,
        [binding.terminal]: resolveBoardConnectorAnchor(target, binding.to_anchor),
      },
      index: connectorRecord.index,
      pageId,
    }))
    return true
  })
  const validBindingIds = new Set(validBindings.map((binding) => binding.id))

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
  diff.added.push(...addedBindings
    .filter((binding) => validBindingIds.has(binding.id))
    .map(cloneBoardRecord))
  diff.removed.push(...originalBindings
    .filter((binding) => !validBindingIds.has(binding.id))
    .map(cloneBoardRecord))
  diff.added.sort(compareBoardRecords)
  diff.removed.sort(compareBoardRecords)
  diff.updated.sort((left, right) => compareBoardRecords(left.after, right.after))
  return diff
}

function requireEditableElements(
  records: Map<string, BoardElementRecord>,
  ids: readonly string[],
) {
  return ids.map((id) => boardElementFromRecord(requireEditableElement(records, id)))
}

function putWorkingElements(
  records: Map<string, BoardElementRecord>,
  elements: readonly WhiteboardElement[],
  pageId: string,
) {
  for (const element of elements) {
    const current = records.get(element.id)
    if (!current) throw new Error(`AI Board action references a missing element: ${element.id}`)
    records.set(element.id, createBoardElementRecord({
      element,
      index: current.index,
      pageId,
    }))
  }
}

function groupWorkingElements(input: {
  operation: Extract<AgentWhiteboardPatch['operations'][number], { op: 'element.group' }>
  order: string[]
  pageId: string
  working: Map<string, BoardElementRecord>
}) {
  if (input.working.has(input.operation.container_id)) {
    throw new Error(`AI Board group reuses an existing id: ${input.operation.container_id}`)
  }
  const elements = requireEditableElements(input.working, input.operation.element_ids)
  const minimumCount = input.operation.container_kind === 'group' ? 2 : 1
  const bounds = getWhiteboardSelectionBounds(elements)
  if (!bounds || elements.length < minimumCount) {
    throw new Error('AI Board group action does not have enough elements')
  }
  const commonParentId = elements.every((element) => element.parentId === elements[0].parentId)
    ? elements[0].parentId
    : undefined
  const horizontalPadding = input.operation.container_kind === 'frame' ? 32 : 8
  const topPadding = input.operation.container_kind === 'frame' ? 52 : 8
  const bottomPadding = input.operation.container_kind === 'frame' ? 32 : 8
  const container: WhiteboardElement = {
    id: input.operation.container_id,
    kind: 'rectangle',
    locked: false,
    parentId: commonParentId,
    rotation: 0,
    shapeStyle: input.operation.container_kind,
    shapeType: input.operation.container_kind === 'frame' ? 'frame' : 'rectangle',
    x: bounds.x - horizontalPadding,
    y: bounds.y - topPadding,
    width: bounds.width + horizontalPadding * 2,
    height: bounds.height + topPadding + bottomPadding,
  }
  const insertionIndex = Math.min(...elements.map((element) => input.order.indexOf(element.id)))
  input.order.splice(Math.max(0, insertionIndex), 0, container.id)
  input.working.set(container.id, createBoardElementRecord({
    element: container,
    index: Math.max(0, insertionIndex),
    pageId: input.pageId,
  }))
  putWorkingElements(input.working, elements.map((element) => ({
    ...element,
    parentId: container.id,
  })), input.pageId)
}

function ungroupWorkingElements(input: {
  containerIds: readonly string[]
  order: string[]
  pageId: string
  working: Map<string, BoardElementRecord>
}) {
  for (const containerId of input.containerIds) {
    const record = requireEditableElement(input.working, containerId)
    const container = boardElementFromRecord(record)
    if (
      container.kind !== 'rectangle'
      || (container.shapeStyle !== 'group' && container.shapeStyle !== 'frame')
    ) throw new Error(`AI Board cannot ungroup a non-container element: ${containerId}`)
    const children = [...input.working.values()]
      .map(boardElementFromRecord)
      .filter((element) => element.parentId === containerId)
    putWorkingElements(input.working, children.map((element) => ({
      ...element,
      parentId: container.parentId,
    })), input.pageId)
    input.working.delete(containerId)
    const index = input.order.indexOf(containerId)
    if (index >= 0) input.order.splice(index, 1)
  }
}

function requireConnectorTarget(
  records: Map<string, BoardElementRecord>,
  id: string,
) {
  const record = records.get(id)
  if (!record) throw new Error(`AI Board connector references a missing element: ${id}`)
  if (record.kind === 'connector' || record.kind === 'stroke') {
    throw new Error(`AI Board connector references an unsupported target: ${id}`)
  }
  return record
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
    rotation: element.rotation ?? existing?.rotation ?? 0,
    sourceRefIds: element.source_ref_ids ? [...element.source_ref_ids] : undefined,
    style: agentStyleToWhiteboardStyle(element.style, existing),
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
        shapeStyle: normalizeAgentRectangleStyle(element.shape_style)
          || agentKindToRectangleStyle(element.kind),
        shapeType: normalizeAgentShapeType(element.shape_type),
        text: element.text,
      }
  }
}

function agentStyleToWhiteboardStyle(
  style: AgentWhiteboardElement['style'],
  existing?: WhiteboardElement,
) {
  const current = existing ? getWhiteboardElementStyle(existing) : undefined
  if (!style && !current) return undefined
  return normalizeWhiteboardStyle({
    ...current,
    strokeColor: style?.stroke_color ?? current?.strokeColor,
    fillColor: style?.fill_color ?? current?.fillColor,
    opacity: style?.opacity ?? current?.opacity,
    fillStyle: style?.fill_style ?? current?.fillStyle,
    dashStyle: style?.dash_style ?? current?.dashStyle,
    strokeSize: style?.stroke_size ?? current?.strokeSize,
  })
}

function normalizeAgentShapeType(value: string | undefined): WhiteboardShapeType | undefined {
  return WHITEBOARD_PALETTE_SHAPE_TYPES.includes(value as WhiteboardShapeType)
    ? value as WhiteboardShapeType
    : undefined
}

function normalizeAgentRectangleStyle(value: string | undefined): WhiteboardRectangleStyle | undefined {
  if (
    value === 'default'
    || value === 'sticky'
    || value === 'mind-node'
    || value === 'flow-node'
    || value === 'frame'
    || value === 'group'
    || value === 'image-placeholder'
  ) return value
  return undefined
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
