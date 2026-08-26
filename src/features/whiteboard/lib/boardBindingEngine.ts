import { getBoardElementUnrotatedBounds } from './boardElementDefinitions'
import {
  boardElementFromRecord,
  cloneBoardRecord,
  createBoardElementRecord,
  type BoardBindingRecord,
  type BoardElementRecord,
  type BoardRecord,
} from './boardRecords'
import type { BoardStore, BoardTransaction } from './boardStore'
import type {
  WhiteboardElement,
  WhiteboardPoint,
} from './whiteboardTypes'

export type BoardConnectorTerminal = 'start' | 'end'

export type BoardConnectorAnchor = {
  point: WhiteboardPoint
  targetElementId: string
  targetAnchor: WhiteboardPoint
}

export function getBoardConnectorAnchor(
  target: WhiteboardElement | undefined,
  point: WhiteboardPoint,
): BoardConnectorAnchor | null {
  if (!target || target.kind === 'connector' || target.kind === 'stroke') return null
  const bounds = getBoardElementUnrotatedBounds(target)
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  }
  const localPoint = rotatePoint(point, center, -(target.rotation ?? 0))
  const left = bounds.x
  const right = bounds.x + bounds.width
  const top = bounds.y
  const bottom = bounds.y + bounds.height
  const clamped = {
    x: clamp(localPoint.x, left, right),
    y: clamp(localPoint.y, top, bottom),
  }
  const candidates = [
    { distance: Math.abs(localPoint.x - right), point: { x: right, y: clamped.y } },
    { distance: Math.abs(localPoint.x - left), point: { x: left, y: clamped.y } },
    { distance: Math.abs(localPoint.y - bottom), point: { x: clamped.x, y: bottom } },
    { distance: Math.abs(localPoint.y - top), point: { x: clamped.x, y: top } },
  ]
  candidates.sort((leftCandidate, rightCandidate) => (
    leftCandidate.distance - rightCandidate.distance
  ))
  const edgePoint = candidates[0].point
  const targetAnchor = {
    x: bounds.width > 0 ? (edgePoint.x - bounds.x) / bounds.width : 0.5,
    y: bounds.height > 0 ? (edgePoint.y - bounds.y) / bounds.height : 0.5,
  }
  return {
    point: rotatePoint(edgePoint, center, target.rotation ?? 0),
    targetElementId: target.id,
    targetAnchor,
  }
}

export function createBoardConnectorBindingRecord(input: {
  anchor: BoardConnectorAnchor
  connectorId: string
  terminal: BoardConnectorTerminal
}): BoardBindingRecord {
  return {
    record_type: 'binding',
    id: `binding:${input.connectorId}:${input.terminal}`,
    binding_type: 'connector',
    from_id: input.connectorId,
    to_id: input.anchor.targetElementId,
    terminal: input.terminal,
    to_anchor: { ...input.anchor.targetAnchor },
  }
}

export function syncBoardConnectorBindings(
  store: BoardStore,
  transaction: BoardTransaction,
  changedElementIds?: ReadonlySet<string>,
) {
  const bindings = store.getRecords().filter((record): record is BoardBindingRecord => (
    record.record_type === 'binding'
    && (!changedElementIds
      || changedElementIds.has(record.from_id)
      || changedElementIds.has(record.to_id))
  ))
  const connectors = new Map<string, BoardElementRecord>()

  for (const binding of bindings) {
    const terminal = getBindingTerminal(binding)
    if (!terminal || !binding.to_anchor) continue
    const connectorRecord = connectors.get(binding.from_id)
      || store.getElementRecord(binding.from_id)
    const targetRecord = store.getElementRecord(binding.to_id)
    if (
      !connectorRecord
      || connectorRecord.kind !== 'connector'
      || !targetRecord
    ) continue

    const target = elementFromRecord(targetRecord)
    const point = resolveBoardConnectorAnchor(target, binding.to_anchor)
    const connector = elementFromRecord(connectorRecord)
    if (connector.kind !== 'connector') continue
    const next = {
      ...connector,
      [terminal]: point,
    }
    const nextRecord = createBoardElementRecord({
      element: next,
      index: connectorRecord.index,
      pageId: connectorRecord.page_id,
    })
    transaction.put(nextRecord)
    connectors.set(binding.from_id, nextRecord)
  }
}

export function removeBoardConnectorBindings(
  store: BoardStore,
  transaction: BoardTransaction,
  elementIds: ReadonlySet<string>,
) {
  for (const record of store.getRecords()) {
    if (
      record.record_type === 'binding'
      && (elementIds.has(record.from_id) || elementIds.has(record.to_id))
    ) {
      transaction.remove(record.id)
    }
  }
}

export function resolveBoardConnectorAnchor(
  target: WhiteboardElement,
  anchor: WhiteboardPoint,
) {
  const bounds = getBoardElementUnrotatedBounds(target)
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  }
  const localPoint = {
    x: bounds.x + bounds.width * clamp(anchor.x, 0, 1),
    y: bounds.y + bounds.height * clamp(anchor.y, 0, 1),
  }
  return rotatePoint(localPoint, center, target.rotation ?? 0)
}

export function repairBoardBindingRecords(
  records: readonly BoardRecord[],
) {
  const elements = new Map(records.flatMap((record): Array<[string, BoardElementRecord]> => (
    record.record_type === 'element' ? [[record.id, record]] : []
  )))
  const repairedElements = new Map<string, BoardElementRecord>()
  const repairedBindings: BoardBindingRecord[] = []
  const occupiedTerminals = new Set<string>()

  for (const record of records) {
    if (record.record_type !== 'binding') continue
    const terminal = getBindingTerminal(record)
    const connectorRecord = elements.get(record.from_id)
    const targetRecord = elements.get(record.to_id)
    const terminalKey = terminal ? `${record.from_id}:${terminal}` : ''
    if (
      !terminal
      || !record.to_anchor
      || connectorRecord?.kind !== 'connector'
      || !targetRecord
      || connectorRecord.page_id !== targetRecord.page_id
      || occupiedTerminals.has(terminalKey)
    ) continue

    occupiedTerminals.add(terminalKey)
    const normalizedBinding: BoardBindingRecord = {
      ...cloneBoardRecord(record) as BoardBindingRecord,
      terminal,
      to_anchor: {
        x: clamp(record.to_anchor.x, 0, 1),
        y: clamp(record.to_anchor.y, 0, 1),
      },
    }
    repairedBindings.push(normalizedBinding)
    const connector = boardElementFromRecord(
      repairedElements.get(connectorRecord.id) || connectorRecord,
    )
    const target = boardElementFromRecord(targetRecord)
    if (connector.kind !== 'connector') continue
    repairedElements.set(connector.id, createBoardElementRecord({
      element: {
        ...connector,
        [terminal]: resolveBoardConnectorAnchor(target, normalizedBinding.to_anchor!),
      },
      index: connectorRecord.index,
      pageId: connectorRecord.page_id,
    }))
  }

  return [
    ...records
      .filter((record) => record.record_type !== 'binding')
      .map((record) => repairedElements.get(record.id) || cloneBoardRecord(record)),
    ...repairedBindings,
  ]
}

function getBindingTerminal(binding: BoardBindingRecord) {
  if (binding.terminal) return binding.terminal
  if (binding.id.endsWith(':start')) return 'start'
  if (binding.id.endsWith(':end')) return 'end'
  return null
}

function elementFromRecord(record: BoardElementRecord): WhiteboardElement {
  const {
    index: _index,
    page_id: _pageId,
    record_type: _recordType,
    ...element
  } = record
  return element as WhiteboardElement
}

function rotatePoint(
  point: WhiteboardPoint,
  origin: WhiteboardPoint,
  degrees: number,
) {
  if (!degrees) return { ...point }
  const radians = (degrees * Math.PI) / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const x = point.x - origin.x
  const y = point.y - origin.y
  return {
    x: origin.x + x * cosine - y * sine,
    y: origin.y + x * sine + y * cosine,
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}
