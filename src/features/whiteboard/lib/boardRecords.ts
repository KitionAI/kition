import type {
  WhiteboardElement,
  WhiteboardPoint,
  WhiteboardViewport,
} from './whiteboardTypes'

export const BOARD_META_RECORD_ID = 'meta:board' as const
export const DEFAULT_BOARD_PAGE_ID = 'page:main' as const

export type BoardMetaRecord = {
  record_type: 'meta'
  id: typeof BOARD_META_RECORD_ID
  active_page_id: string
}

export type BoardPageRecord = {
  record_type: 'page'
  id: string
  name: string
  index: number
}

type WithBoardElementMetadata<Element> = Element extends WhiteboardElement
  ? Element & {
      record_type: 'element'
      page_id: string
      index: number
    }
  : never

export type BoardElementRecord = WithBoardElementMetadata<WhiteboardElement>

export type BoardBindingRecord = {
  record_type: 'binding'
  id: string
  binding_type: 'connector'
  from_id: string
  to_id: string
  terminal?: 'start' | 'end'
  from_anchor?: WhiteboardPoint
  to_anchor?: WhiteboardPoint
}

export type BoardAssetRecord = {
  record_type: 'asset'
  id: string
  asset_type: 'image'
  workspace_path: string
  mime_type: string
  width?: number
  height?: number
}

export type BoardRecord =
  | BoardMetaRecord
  | BoardPageRecord
  | BoardElementRecord
  | BoardBindingRecord
  | BoardAssetRecord

export type BoardDocument = {
  format: 'kition-board'
  version: 1
  title: string
  viewport: WhiteboardViewport
  records: BoardRecord[]
  updated_at: string
}

export function createBoardBaseRecords(title = 'Board'): BoardRecord[] {
  return [
    {
      record_type: 'meta',
      id: BOARD_META_RECORD_ID,
      active_page_id: DEFAULT_BOARD_PAGE_ID,
    },
    {
      record_type: 'page',
      id: DEFAULT_BOARD_PAGE_ID,
      name: title,
      index: 0,
    },
  ]
}

export function createBoardRecordsFromElements(
  elements: readonly WhiteboardElement[],
  title = 'Board',
): BoardRecord[] {
  return [
    ...createBoardBaseRecords(title),
    ...elements.map((element, index) => createBoardElementRecord({
      element,
      index,
      pageId: DEFAULT_BOARD_PAGE_ID,
    })),
  ]
}

export function createBoardElementRecord(input: {
  element: WhiteboardElement
  index: number
  pageId: string
}): BoardElementRecord {
  return {
    ...cloneBoardElement(input.element),
    record_type: 'element',
    page_id: input.pageId,
    index: input.index,
  } as BoardElementRecord
}

export function boardElementFromRecord(record: BoardElementRecord): WhiteboardElement {
  const {
    record_type: _recordType,
    page_id: _pageId,
    index: _index,
    ...element
  } = record
  return cloneBoardElement(element as WhiteboardElement)
}

export function cloneBoardRecord(record: BoardRecord): BoardRecord {
  switch (record.record_type) {
    case 'element':
      return createBoardElementRecord({
        element: boardElementFromRecord(record),
        index: record.index,
        pageId: record.page_id,
      })
    case 'binding':
      return {
        ...record,
        from_anchor: record.from_anchor ? { ...record.from_anchor } : undefined,
        to_anchor: record.to_anchor ? { ...record.to_anchor } : undefined,
      }
    default:
      return { ...record }
  }
}

export function cloneBoardElement(element: WhiteboardElement): WhiteboardElement {
  const locked = Boolean(element.locked)
  const parentId = element.parentId
  const rotation = normalizeRotation(element.rotation)
  const sourceRefIds = element.sourceRefIds ? [...element.sourceRefIds] : undefined
  const style = element.style ? { ...element.style } : undefined
  switch (element.kind) {
    case 'stroke':
      return {
        ...element,
        locked,
        parentId,
        rotation,
        sourceRefIds,
        style,
        points: element.points.map((point) => ({ ...point })),
      }
    case 'connector':
      return {
        ...element,
        locked,
        parentId,
        rotation,
        sourceRefIds,
        style,
        start: { ...element.start },
        end: { ...element.end },
      }
    case 'text':
      return {
        ...element,
        fontSize: Math.max(8, element.fontSize ?? 22),
        locked,
        parentId,
        rotation,
        sourceRefIds,
        style,
      }
    default:
      return { ...element, locked, parentId, rotation, sourceRefIds, style }
  }
}

export function compareBoardRecords(left: BoardRecord, right: BoardRecord) {
  const rank = boardRecordRank(left.record_type) - boardRecordRank(right.record_type)
  if (rank !== 0) return rank
  if (left.record_type === 'page' && right.record_type === 'page') {
    const index = left.index - right.index
    if (index !== 0) return index
  }
  if (left.record_type === 'element' && right.record_type === 'element') {
    const page = left.page_id.localeCompare(right.page_id)
    if (page !== 0) return page
    const index = left.index - right.index
    if (index !== 0) return index
  }
  return left.id.localeCompare(right.id)
}

function boardRecordRank(type: BoardRecord['record_type']) {
  switch (type) {
    case 'meta': return 0
    case 'page': return 1
    case 'element': return 2
    case 'binding': return 3
    case 'asset': return 4
  }
}

function normalizeRotation(rotation: number | undefined) {
  if (!Number.isFinite(rotation)) return 0
  const normalized = (rotation || 0) % 360
  return normalized < 0 ? normalized + 360 : normalized
}
