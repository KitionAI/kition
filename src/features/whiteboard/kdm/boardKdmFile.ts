/**
 * The `.kiboard` file: a one-line JSON envelope holding the board's KDM snapshot in base64.
 *
 * ```json
 * {"format":"kition-board","version":2,"kdm":"<base64 of Replica.snapshot()>"}
 * ```
 *
 * The file is the KDM document itself: no record JSON, no viewport. Version-1 files (record JSON)
 * are recognised so the editor can refuse them with a clear message; they are not migrated.
 */
import { newDocId, newObjectId, Replica, system } from '@/lib/kdm'
import type { BoardElementRecord, BoardPageRecord, BoardRecord } from '../lib/boardRecords'
import { boardSchema } from './boardSchema'
import { writeBoardDiff } from './boardKdmWrite'

export const BOARD_FILE_FORMAT = 'kition-board' as const
export const BOARD_FILE_VERSION = 2 as const

export type DecodedBoardFile =
  | { kind: 'board'; replica: Replica }
  | { kind: 'unsupported'; reason: 'version-1' | 'not-a-board' }

/**
 * A new board document: the `Board` root titled `title` and one page. The ids default to new KDM
 * ids; tests and fixtures may choose them.
 */
export function createEmptyBoard(
  title: string,
  actor: bigint,
  ids: { rootId?: string; pageId?: string } = {},
): Replica {
  return Replica.createWith(boardSchema, newDocId(), actor, system('create'), (tx) => {
    const page = tx.create('Page', { name: defaultPageName(title) }, ids.pageId === undefined ? undefined : { id: ids.pageId })
    const root = tx.create('Board', { title }, ids.rootId === undefined ? undefined : { id: ids.rootId })
    tx.listInsert(root, 'pages', 0, page)
  }).replica
}

/**
 * A new board titled `title` holding `records` (pages, elements, bindings; other record types are
 * ignored), written in the creating commit so there is nothing to undo. Without page records the
 * board gets one page holding every element; an element naming a page that is not among the
 * records goes to the first page.
 */
export function createBoardFromRecords(title: string, actor: bigint, records: readonly BoardRecord[]): Replica {
  const unique = uniqueRecords(records)
  let pages = unique.filter((record): record is BoardPageRecord => record.record_type === 'page')
  if (pages.length === 0) pages = [{ record_type: 'page', id: newObjectId(), name: defaultPageName(title), index: 0 }]
  const pageIds = new Set(pages.map((page) => page.id))
  const firstPage = [...pages].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))[0].id
  const added: BoardRecord[] = [...pages]
  for (const record of unique) {
    if (record.record_type === 'element') {
      added.push(pageIds.has(record.page_id) ? record : ({ ...record, page_id: firstPage } as BoardElementRecord))
    } else if (record.record_type === 'binding') {
      added.push(record)
    }
  }
  return Replica.createWith(boardSchema, newDocId(), actor, system('create'), (tx) => {
    const root = tx.create('Board', { title })
    writeBoardDiff(tx, root, { added, updated: [], removed: [] })
  }).replica
}

/** The file text for `replica`: the v2 envelope and a final newline. */
export function encodeBoardFile(replica: Replica): string {
  return `${JSON.stringify({ format: BOARD_FILE_FORMAT, version: BOARD_FILE_VERSION, kdm: bytesToBase64(replica.snapshot()) })}\n`
}

/** Opens file text as a writable replica of `actor`. Never throws. */
export function decodeBoardFile(text: string, actor: bigint): DecodedBoardFile {
  const bytes = boardFileBytes(text)
  if (bytes === 'version-1') return { kind: 'unsupported', reason: 'version-1' }
  if (bytes === null) return { kind: 'unsupported', reason: 'not-a-board' }
  try {
    const replica = Replica.load(boardSchema, bytes, actor)
    if (replica.objectsOfType('Board').length === 0) return { kind: 'unsupported', reason: 'not-a-board' }
    return { kind: 'board', replica }
  } catch {
    return { kind: 'unsupported', reason: 'not-a-board' }
  }
}

/**
 * Imports the changes another copy of the board (file text) has into `replica`. `'unchanged'` when
 * it had nothing new; `'unsupported'` for text that is not a v2 board or holds another document.
 * Never throws.
 */
export function mergeBoardFile(replica: Replica, text: string): 'merged' | 'unchanged' | 'unsupported' {
  const bytes = boardFileBytes(text)
  if (bytes === 'version-1' || bytes === null) return 'unsupported'
  const before = replica.version()
  try {
    replica.importChanges(bytes)
  } catch {
    return 'unsupported'
  }
  return replica.version().equals(before) ? 'unchanged' : 'merged'
}

/** The snapshot bytes of a v2 file, `'version-1'` for a version-1 file, or `null`. */
function boardFileBytes(text: string): Uint8Array | 'version-1' | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const envelope = parsed as Record<string, unknown>
  if (envelope.format !== BOARD_FILE_FORMAT) return null
  if (envelope.version === 1) return 'version-1'
  if (envelope.version !== BOARD_FILE_VERSION || typeof envelope.kdm !== 'string') return null
  return base64ToBytes(envelope.kdm)
}

/** Base64 without `Buffer`, in chunks so multi-megabyte snapshots do not overflow the stack. */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  const parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK)))
  }
  return btoa(parts.join(''))
}

/** Decodes strict base64 (no whitespace); `null` when `text` is not base64. */
function base64ToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null
  let binary: string
  try {
    binary = atob(text)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Records without repeated ids of one record type; the first one wins. */
function uniqueRecords(records: readonly BoardRecord[]): BoardRecord[] {
  const seen = new Set<string>()
  return records.filter((record) => {
    const key = `${record.record_type}\u0000${record.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function defaultPageName(title: string): string {
  return title || 'Page 1'
}
