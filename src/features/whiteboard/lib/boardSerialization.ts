/**
 * Parsing and normalising board records from untrusted JSON: the `kition-board-clipboard` payload
 * pasted from the system clipboard. The `.kiboard` file is a KDM document (`kdm/boardKdmFile.ts`).
 */
import {
  BOARD_META_RECORD_ID,
  DEFAULT_BOARD_PAGE_ID,
  cloneBoardRecord,
  compareBoardRecords,
  createBoardElementRecord,
  type BoardAssetRecord,
  type BoardBindingRecord,
  type BoardMetaRecord,
  type BoardPageRecord,
  type BoardRecord,
} from './boardRecords'
import { normalizeWhiteboardStyle } from './whiteboardStyle'
import type {
  WhiteboardElement,
  WhiteboardPoint,
  WhiteboardShapeType,
} from './whiteboardTypes'

const MAX_BOARD_RECORDS = 20000
const MAX_STROKE_POINTS = 10000

/**
 * Board records from untrusted JSON values: invalid records are dropped, ids are deduplicated, and
 * the result always has a page and a meta record (elements naming a missing page move to the
 * current one).
 */
export function parseBoardRecords(values: readonly unknown[], title = 'Board'): BoardRecord[] {
  return normalizeBoardRecords(values.slice(0, MAX_BOARD_RECORDS).flatMap(parseBoardRecord), title)
}

function parseBoardRecord(value: unknown): BoardRecord[] {
  if (!isRecord(value)) return []
  switch (value.record_type) {
    case 'meta': {
      const activePageId = parseIdentifier(value.active_page_id)
      if (value.id !== BOARD_META_RECORD_ID || !activePageId) return []
      const record: BoardMetaRecord = {
        record_type: 'meta',
        id: BOARD_META_RECORD_ID,
        active_page_id: activePageId,
      }
      return [record]
    }
    case 'page': {
      const id = parseIdentifier(value.id)
      if (!id) return []
      const record: BoardPageRecord = {
        record_type: 'page',
        id,
        name: normalizeBoardTitle(value.name, 'Board'),
        index: Math.max(0, finiteNumber(value.index) ?? 0),
      }
      return [record]
    }
    case 'element': {
      const pageId = parseIdentifier(value.page_id)
      const index = finiteNumber(value.index)
      const element = parseBoardElement(value)[0]
      if (!pageId || index == null || index < 0 || !element) return []
      return [createBoardElementRecord({ element, index, pageId })]
    }
    case 'binding': {
      const id = parseIdentifier(value.id)
      const fromId = parseIdentifier(value.from_id)
      const toId = parseIdentifier(value.to_id)
      if (
        !id
        || !fromId
        || !toId
        || value.binding_type !== 'connector'
      ) return []
      const record: BoardBindingRecord = {
        record_type: 'binding',
        id,
        binding_type: 'connector',
        from_id: fromId,
        to_id: toId,
      }
      if (value.terminal === 'start' || value.terminal === 'end') {
        record.terminal = value.terminal
      }
      const fromAnchor = parsePoint(value.from_anchor)[0]
      const toAnchor = parsePoint(value.to_anchor)[0]
      if (fromAnchor) record.from_anchor = fromAnchor
      if (toAnchor) record.to_anchor = toAnchor
      return [record]
    }
    case 'asset': {
      const id = parseIdentifier(value.id)
      const workspacePath = normalizeWorkspacePath(value.workspace_path)
      if (
        !id
        || !workspacePath
        || value.asset_type !== 'image'
        || typeof value.mime_type !== 'string'
        || !value.mime_type.startsWith('image/')
      ) return []
      const record: BoardAssetRecord = {
        record_type: 'asset',
        id,
        asset_type: 'image',
        workspace_path: workspacePath,
        mime_type: value.mime_type.slice(0, 255),
      }
      const width = finiteNumber(value.width)
      const height = finiteNumber(value.height)
      if (width != null && width > 0) record.width = width
      if (height != null && height > 0) record.height = height
      return [record]
    }
    default:
      return []
  }
}

function parseBoardElement(value: unknown): WhiteboardElement[] {
  if (!isRecord(value)) return []
  const id = parseIdentifier(value.id)
  if (!id) return []
  switch (value.kind) {
    case 'rectangle': {
      const x = finiteNumber(value.x)
      const y = finiteNumber(value.y)
      const width = finiteNumber(value.width)
      const height = finiteNumber(value.height)
      if (
        x == null
        || y == null
        || width == null
        || height == null
        || width < 0
        || height < 0
      ) return []
      return [{
        id,
        kind: 'rectangle',
        x,
        y,
        width,
        height,
        shapeType: parseShapeType(value.shapeType),
        shapeStyle: parseRectangleStyle(value.shapeStyle),
        mindMapBranchSide: parseMindMapBranchSide(value.mindMapBranchSide),
        mindMapCollapsed: value.mindMapCollapsed === true ? true : undefined,
        mindMapDirection: parseMindMapDirection(value.mindMapDirection),
        text: typeof value.text === 'string' ? value.text.slice(0, 10000) : undefined,
        ...parseElementMetadata(value),
      }]
    }
    case 'text': {
      const x = finiteNumber(value.x)
      const y = finiteNumber(value.y)
      if (x == null || y == null || typeof value.text !== 'string') return []
      return [{
        id,
        kind: 'text',
        x,
        y,
        text: value.text.slice(0, 10000),
        fontSize: Math.max(8, finiteNumber(value.fontSize) ?? 22),
        ...parseElementMetadata(value),
      }]
    }
    case 'stroke': {
      if (!Array.isArray(value.points)) return []
      const points = value.points
        .slice(0, MAX_STROKE_POINTS)
        .flatMap(parsePoint)
      if (points.length < 2) return []
      return [{ id, kind: 'stroke', points, ...parseElementMetadata(value) }]
    }
    case 'connector': {
      const start = parsePoint(value.start)[0]
      const end = parsePoint(value.end)[0]
      if (!start || !end) return []
      return [{
        id,
        kind: 'connector',
        start,
        end,
        mindMapBranchAxis: value.mindMapBranchAxis === 'vertical'
          ? 'vertical'
          : value.mindMapBranchAxis === 'horizontal' ? 'horizontal' : undefined,
        connectorRole: value.connectorRole === 'mind-map-branch'
          ? value.connectorRole
          : undefined,
        connectorType: value.connectorType === 'elbow' || value.connectorType === 'curved'
          ? value.connectorType
          : 'straight',
        startArrowhead: value.startArrowhead === 'arrow' || value.startArrowhead === 'dot'
          ? value.startArrowhead
          : 'none',
        endArrowhead: value.endArrowhead === 'none' || value.endArrowhead === 'dot'
          ? value.endArrowhead
          : 'arrow',
        ...parseElementMetadata(value),
      }]
    }
    case 'image': {
      const x = finiteNumber(value.x)
      const y = finiteNumber(value.y)
      const width = finiteNumber(value.width)
      const height = finiteNumber(value.height)
      const workspacePath = normalizeWorkspacePath(value.workspacePath)
      if (
        x == null
        || y == null
        || width == null
        || height == null
        || width <= 0
        || height <= 0
        || !workspacePath
      ) return []
      return [{
        id,
        kind: 'image',
        x,
        y,
        width,
        height,
        workspacePath,
        alt: typeof value.alt === 'string' ? value.alt.slice(0, 500) : undefined,
        ...parseElementMetadata(value),
      }]
    }
    default:
      return []
  }
}

function parseElementMetadata(value: Record<string, unknown>) {
  const parentId = parseIdentifier(value.parentId)
  const sourceRefIds = parseIdentifierArray(value.sourceRefIds, 16)
  return {
    locked: value.locked === true,
    parentId: parentId || undefined,
    rotation: normalizeRotation(finiteNumber(value.rotation) ?? 0),
    sourceRefIds: sourceRefIds.length ? sourceRefIds : undefined,
    style: isRecord(value.style) ? normalizeWhiteboardStyle(value.style) : undefined,
  }
}

function parseShapeType(value: unknown): WhiteboardShapeType | undefined {
  switch (value) {
    case 'rectangle':
    case 'ellipse':
    case 'triangle':
    case 'diamond':
    case 'hexagon':
    case 'pill':
    case 'parallelogram':
    case 'star':
    case 'cloud':
    case 'heart':
    case 'x-box':
    case 'check-box':
    case 'check':
    case 'arrow-left':
    case 'arrow-right':
    case 'arrow-up':
    case 'arrow-down':
    case 'line':
    case 'frame':
      return value
    default:
      return undefined
  }
}

function parseRectangleStyle(value: unknown) {
  switch (value) {
    case 'default':
    case 'sticky':
    case 'mind-node':
    case 'flow-node':
    case 'frame':
    case 'group':
    case 'image-placeholder':
      return value
    default:
      return undefined
  }
}

function parseMindMapDirection(value: unknown) {
  switch (value) {
    case 'both':
    case 'right':
    case 'left':
    case 'down':
      return value
    default:
      return undefined
  }
}

function parseMindMapBranchSide(value: unknown) {
  switch (value) {
    case 'left':
    case 'right':
      return value
    default:
      return undefined
  }
}

function parseIdentifierArray(value: unknown, limit: number) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.slice(0, limit).map(parseIdentifier).filter(Boolean))]
}

function normalizeBoardRecords(
  records: Iterable<BoardRecord>,
  title = 'Board',
) {
  const normalized = new Map<string, BoardRecord>()
  for (const record of records) {
    if (normalized.size >= MAX_BOARD_RECORDS) break
    if (!normalized.has(record.id)) normalized.set(record.id, cloneBoardRecord(record))
  }

  const pages = [...normalized.values()]
    .filter((record): record is BoardPageRecord => record.record_type === 'page')
  if (pages.length === 0) {
    const page: BoardPageRecord = {
      record_type: 'page',
      id: DEFAULT_BOARD_PAGE_ID,
      name: title,
      index: 0,
    }
    normalized.set(page.id, page)
    pages.push(page)
  }

  const meta = normalized.get(BOARD_META_RECORD_ID)
  const activePageId = meta?.record_type === 'meta'
    && pages.some((page) => page.id === meta.active_page_id)
    ? meta.active_page_id
    : pages[0].id
  normalized.set(BOARD_META_RECORD_ID, {
    record_type: 'meta',
    id: BOARD_META_RECORD_ID,
    active_page_id: activePageId,
  })

  pages
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
    .forEach((page, index) => normalized.set(page.id, { ...page, index }))

  for (const record of normalized.values()) {
    if (
      record.record_type === 'element'
      && !pages.some((page) => page.id === record.page_id)
    ) {
      normalized.set(record.id, { ...record, page_id: activePageId })
    }
  }

  return [...normalized.values()]
    .map(cloneBoardRecord)
    .sort(compareBoardRecords)
}

function parsePoint(value: unknown): WhiteboardPoint[] {
  if (!isRecord(value)) return []
  const x = finiteNumber(value.x)
  const y = finiteNumber(value.y)
  return x == null || y == null ? [] : [{ x, y }]
}

function normalizeBoardTitle(value: unknown, fallback = 'Untitled board') {
  const title = typeof value === 'string' ? value.trim() : ''
  return (title || fallback).slice(0, 500)
}

function parseIdentifier(value: unknown) {
  if (typeof value !== 'string') return ''
  const id = value.trim().slice(0, 128)
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) ? id : ''
}

function normalizeWorkspacePath(value: unknown) {
  if (typeof value !== 'string') return ''
  const path = value.trim().replace(/\\/g, '/').slice(0, 1024)
  if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path)) return ''
  if (path.split('/').some((part) => part === '..')) return ''
  return path
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeRotation(rotation: number) {
  const normalized = rotation % 360
  return normalized < 0 ? normalized + 360 : normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
