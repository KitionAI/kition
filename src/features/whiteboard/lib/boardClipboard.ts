import {
  boardElementFromRecord,
  cloneBoardElement,
  cloneBoardRecord,
  createBoardBaseRecords,
  type BoardBindingRecord,
  type BoardElementRecord,
  type BoardRecord,
} from './boardRecords'
import {
  BOARD_DOCUMENT_FORMAT,
  BOARD_DOCUMENT_VERSION,
  parseBoardDocument,
} from './boardSerialization'
import { createWhiteboardElementId } from './whiteboardElementId'
import { translateWhiteboardElement } from './whiteboardGeometry'
import type { WhiteboardElement, WhiteboardPoint } from './whiteboardTypes'

export const BOARD_CLIPBOARD_MIME = 'application/x-kition-board+json'
export const BOARD_CLIPBOARD_PREFIX = 'Kition Board selection\n'

type BoardClipboardPayload = {
  format: 'kition-board-clipboard'
  version: 1
  records: BoardRecord[]
}

export function createBoardClipboardText(
  records: readonly BoardRecord[],
  selectedElementIds: readonly string[],
) {
  const includedIds = collectIncludedElementIds(records, selectedElementIds)
  const clipboardRecords = records
    .filter((record) => {
      if (record.record_type === 'element') {
        return includedIds.has(record.id) && isPortableElement(record)
      }
      if (record.record_type === 'binding') {
        return includedIds.has(record.from_id) && includedIds.has(record.to_id)
      }
      return false
    })
    .map(cloneBoardRecord)
  if (!clipboardRecords.some((record) => record.record_type === 'element')) return ''

  const payload: BoardClipboardPayload = {
    format: 'kition-board-clipboard',
    version: 1,
    records: clipboardRecords,
  }
  return `${BOARD_CLIPBOARD_PREFIX}${JSON.stringify(payload)}`
}

export function parseBoardClipboardText(text: string) {
  const source = text.startsWith(BOARD_CLIPBOARD_PREFIX)
    ? text.slice(BOARD_CLIPBOARD_PREFIX.length)
    : text
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch {
    return null
  }
  if (!isClipboardPayload(payload)) return null

  try {
    const document = parseBoardDocument(JSON.stringify({
      format: BOARD_DOCUMENT_FORMAT,
      version: BOARD_DOCUMENT_VERSION,
      title: 'Clipboard',
      viewport: { x: 0, y: 0, zoom: 1 },
      records: [
        ...createBoardBaseRecords('Clipboard'),
        ...payload.records.filter((record) => (
          isRecord(record)
          && (record.record_type === 'element' || record.record_type === 'binding')
        )),
      ],
      updated_at: new Date(0).toISOString(),
    }))
    return document.records.filter((record) => (
      record.record_type === 'element' || record.record_type === 'binding'
    ))
  } catch {
    return null
  }
}

export function instantiateBoardClipboardRecords(
  records: readonly BoardRecord[],
  offset: WhiteboardPoint = { x: 24, y: 24 },
) {
  const elementRecords = records.filter((record): record is BoardElementRecord => (
    record.record_type === 'element'
  ))
  const idMap = new Map(elementRecords.map((record) => [
    record.id,
    createWhiteboardElementId(record.kind),
  ]))
  const elements = elementRecords.map((record) => {
    const element = boardElementFromRecord(record)
    const parentId = element.parentId ? idMap.get(element.parentId) : undefined
    return translateWhiteboardElement({
      ...cloneBoardElement(element),
      id: idMap.get(element.id)!,
      locked: false,
      parentId,
    }, offset)
  })
  const elementIds = new Set(elements.map((element) => element.id))
  const bindings = records
    .filter((record): record is BoardBindingRecord => record.record_type === 'binding')
    .flatMap((record): BoardBindingRecord[] => {
      const fromId = idMap.get(record.from_id)
      const toId = idMap.get(record.to_id)
      if (!fromId || !toId || !elementIds.has(fromId) || !elementIds.has(toId)) return []
      const terminal = record.terminal || inferBindingTerminal(record.id)
      if (!terminal) return []
      return [{
        ...cloneBoardRecord(record) as BoardBindingRecord,
        id: `binding:${fromId}:${terminal}`,
        from_id: fromId,
        to_id: toId,
        terminal,
      }]
    })

  return { bindings, elements }
}

function collectIncludedElementIds(
  records: readonly BoardRecord[],
  selectedElementIds: readonly string[],
) {
  const includedIds = new Set(selectedElementIds)
  let changed = true
  while (changed) {
    changed = false
    for (const record of records) {
      if (
        record.record_type === 'element'
        && record.parentId
        && includedIds.has(record.parentId)
        && !includedIds.has(record.id)
      ) {
        includedIds.add(record.id)
        changed = true
      }
    }
  }
  return includedIds
}

function isPortableElement(element: WhiteboardElement) {
  if (element.kind !== 'image') return true
  const path = element.workspacePath.trim().replace(/\\/g, '/')
  return Boolean(path)
    && !path.startsWith('/')
    && !/^[A-Za-z]:\//.test(path)
    && !path.split('/').some((part) => part === '..')
}

function inferBindingTerminal(id: string) {
  if (id.endsWith(':start')) return 'start' as const
  if (id.endsWith(':end')) return 'end' as const
  return null
}

function isClipboardPayload(value: unknown): value is BoardClipboardPayload {
  return isRecord(value)
    && value.format === 'kition-board-clipboard'
    && value.version === 1
    && Array.isArray(value.records)
    && value.records.length <= 20000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
