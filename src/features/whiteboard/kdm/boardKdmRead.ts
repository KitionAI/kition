/**
 * The record view of a board replica: the `BoardRecord`s the store and the editor work with,
 * rebuilt from the KDM document. Element order comes from the page's `elements` list and page
 * order from the board's `pages` list; indexes are positions, never stored.
 */
import type { Replica } from '@/lib/kdm'
import {
  createBoardElementRecord,
  type BoardBindingRecord,
  type BoardRecord,
} from '../lib/boardRecords'
import type {
  WhiteboardElement,
  WhiteboardElementStyle,
  WhiteboardPoint,
} from '../lib/whiteboardTypes'
import { BOARD_STYLE_FIELDS } from './boardSchema'

type Fields = Record<string, unknown>
type BoardState = { objects: Record<string, Fields> }

const ELEMENT_KINDS: ReadonlySet<string> = new Set(['rectangle', 'text', 'stroke', 'connector', 'image'])
const TERMINALS = ['start', 'end'] as const

/** All records of the board: its pages, their elements in order, and connector bindings. */
export function readBoardRecords(replica: Replica): BoardRecord[] {
  const { objects } = replica.stateJson() as BoardState
  const root = findRoot(objects)
  if (!root) return []
  const records: BoardRecord[] = []
  const bindings: BoardBindingRecord[] = []
  let pageIndex = 0
  for (const pageId of uniqueIds(objects[root].pages)) {
    const page = objects[pageId]
    if (page?.$type !== 'Page') continue
    records.push({ record_type: 'page', id: pageId, name: stringOr(page.name, ''), index: pageIndex })
    pageIndex += 1
    let index = 0
    for (const id of uniqueIds(page.elements)) {
      const fields = objects[id]
      if (fields?.$type !== 'Element') continue
      const element = elementFromFields(id, fields)
      if (!element) continue
      records.push(createBoardElementRecord({ element, index, pageId }))
      index += 1
      if (element.kind === 'connector') bindings.push(...bindingsOf(id, fields))
    }
  }
  return [...records, ...bindings]
}

export function readBoardTitle(replica: Replica): string {
  const { objects } = replica.stateJson() as BoardState
  const root = findRoot(objects)
  return root ? stringOr(objects[root].title, '') : ''
}

/** The id of the board's root object. */
export function boardRootId(replica: Replica): string {
  const [root] = replica.objectsOfType('Board')
  if (root === undefined) throw new Error('The board document has no Board object.')
  return root
}

/** Rebuilds a whiteboard element from its KDM fields; `null` for an unknown kind. `null` fields are absent. */
function elementFromFields(id: string, fields: Fields): WhiteboardElement | null {
  const kind = fields.kind
  if (typeof kind !== 'string' || !ELEMENT_KINDS.has(kind)) return null
  const base: Record<string, unknown> = {
    id,
    kind,
    rotation: numberOr(fields.rotation, 0),
    locked: fields.locked === true,
  }
  const parent = present(fields.parent)
  if (typeof parent === 'string') base.parentId = parent
  const style = styleOf(fields)
  if (style) base.style = style
  const sourceRefIds = present(fields.sourceRefIds)
  if (Array.isArray(sourceRefIds)) base.sourceRefIds = sourceRefIds.filter((ref) => typeof ref === 'string')
  const text = typeof fields.text === 'string' ? fields.text : ''

  switch (kind) {
    case 'rectangle':
      Object.assign(base, geometry(fields, true))
      copyPresent(base, fields, ['shapeType', 'shapeStyle', 'mindMapBranchSide', 'mindMapDirection', 'mindMapCollapsed'])
      if (text) base.text = text
      break
    case 'text':
      Object.assign(base, geometry(fields, false))
      base.text = text
      copyPresent(base, fields, ['fontSize'])
      break
    case 'stroke':
      base.points = Array.isArray(fields.points) ? fields.points.filter(isPoint) : []
      break
    case 'connector':
      base.start = pointOr(fields.start)
      base.end = pointOr(fields.end)
      copyPresent(base, fields, ['connectorType', 'startArrowhead', 'endArrowhead', 'connectorRole', 'mindMapBranchAxis'])
      break
    case 'image': {
      Object.assign(base, geometry(fields, true))
      const image = isRecord(fields.image) ? fields.image : {}
      base.workspacePath = stringOr(image.workspacePath, '')
      if (typeof image.alt === 'string') base.alt = image.alt
      break
    }
  }
  return base as WhiteboardElement
}

function bindingsOf(connector: string, fields: Fields): BoardBindingRecord[] {
  const out: BoardBindingRecord[] = []
  for (const terminal of TERMINALS) {
    const binding = fields[`${terminal}Binding`]
    if (!isRecord(binding) || typeof binding.target !== 'string') continue
    const record: BoardBindingRecord = {
      record_type: 'binding',
      id: `binding:${connector}:${terminal}`,
      binding_type: 'connector',
      from_id: connector,
      to_id: binding.target,
      terminal,
    }
    if (isPoint(binding.anchor)) record.to_anchor = { x: binding.anchor.x, y: binding.anchor.y }
    out.push(record)
  }
  return out
}

/** The `Board` object; the smallest id if concurrent creation left several. */
function findRoot(objects: Record<string, Fields>): string | null {
  let root: string | null = null
  for (const [id, fields] of Object.entries(objects)) {
    if (fields.$type === 'Board' && (root === null || id < root)) root = id
  }
  return root
}

function styleOf(fields: Fields): Partial<WhiteboardElementStyle> | undefined {
  const style: Record<string, unknown> = {}
  for (const key of BOARD_STYLE_FIELDS) {
    const value = present(fields[key])
    if (value !== undefined) style[key] = value
  }
  return Object.keys(style).length > 0 ? (style as Partial<WhiteboardElementStyle>) : undefined
}

function geometry(fields: Fields, sized: boolean) {
  const out: Record<string, number> = { x: numberOr(fields.x, 0), y: numberOr(fields.y, 0) }
  if (sized) {
    out.width = numberOr(fields.width, 0)
    out.height = numberOr(fields.height, 0)
  }
  return out
}

function copyPresent(target: Record<string, unknown>, fields: Fields, keys: readonly string[]) {
  for (const key of keys) {
    const value = present(fields[key])
    if (value !== undefined) target[key] = value
  }
}

function uniqueIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : []
}

const present = (value: unknown): unknown => (value === null ? undefined : value)
const numberOr = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback)
const stringOr = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)
const isRecord = (value: unknown): value is Fields => value !== null && typeof value === 'object' && !Array.isArray(value)
const isPoint = (value: unknown): value is WhiteboardPoint => isRecord(value) && typeof value.x === 'number' && typeof value.y === 'number'
const pointOr = (value: unknown): WhiteboardPoint => (isPoint(value) ? { x: value.x, y: value.y } : { x: 0, y: 0 })
