/**
 * The `.kiboard` file: a one-line JSON envelope holding the board's KDM snapshot in base64.
 *
 * ```json
 * {"format":"kition-board","version":2,"kdm":"<base64 of Replica.snapshot()>"}
 * ```
 *
 * The file is the KDM document itself: no record JSON, no viewport. Version-1 files (record JSON)
 * and boards of a newer Kition (a newer envelope, KDM, or schema version) are recognised so the
 * editor can refuse them with a clear message and never replace them; version-1 files are not
 * migrated. A leading byte order mark is ignored.
 */
import { LoroDoc, VersionVector } from 'loro-crdt'
import { KdmError, newDocId, newObjectId, openEnvelope, Replica, system, type Version } from '@kition/kdm'
import type { BoardElementRecord, BoardPageRecord, BoardRecord } from '../lib/boardRecords'
import { BOARD_KIT, boardSchema } from './boardSchema'
import { writeBoardDiff } from './boardKdmWrite'

const BOARD_FILE_FORMAT = 'kition-board'
const BOARD_FILE_VERSION = 2
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff)

/** Why a file cannot be opened: an old record-JSON board, a board of a newer Kition, or not a board. */
export type BoardFileProblem = 'version-1' | 'newer-version' | 'not-a-board'

export type DecodedBoardFile =
  | { kind: 'board'; replica: Replica }
  | { kind: 'unsupported'; reason: BoardFileProblem }

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
 * records goes to the first page. Throws a `KdmError` (`invalid-value`) when a page or element id
 * does not match the KDM object id pattern (`[A-Za-z0-9][A-Za-z0-9:_-]{0,127}`) or when a page and
 * an element share an id; records come from templates and fixtures, so that is a programming error.
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

/**
 * Opens file text as a writable replica of `actor`. Never throws for bad text; an invalid `actor`
 * is a programming error and throws.
 */
export function decodeBoardFile(text: string, actor: bigint): DecodedBoardFile {
  checkBoardActor(actor)
  const bytes = boardFileBytes(text)
  if (bytes === 'version-1' || bytes === 'newer-version') return { kind: 'unsupported', reason: bytes }
  if (bytes === null) return { kind: 'unsupported', reason: 'not-a-board' }
  let replica: Replica
  try {
    replica = Replica.load(boardSchema, bytes, actor)
  } catch (error) {
    if (!isRefusal(error)) throw error
    const newer = error.reason === 'newer-schema' || error.reason === 'schema'
    const reason = newer && snapshotKit(bytes) === BOARD_KIT ? 'newer-version' : 'not-a-board'
    return { kind: 'unsupported', reason }
  }
  if (replica.objectsOfType('Board').length === 0) return { kind: 'unsupported', reason: 'not-a-board' }
  return { kind: 'board', replica }
}

/** Another copy of the board, read from file text: its changes and the version they reach. */
export type BoardFileCopy = { changes: Uint8Array; version: Version }

/**
 * Reads file text as another copy of `replica`'s document, or `null` when it is not a v2 board, is
 * another document, or was written under a newer schema than this build reads (importing it would
 * mix changes this build does not understand into the document). Nothing is imported.
 */
export function readBoardFileCopy(replica: Replica, text: string): BoardFileCopy | null {
  const bytes = boardFileBytes(text)
  if (typeof bytes === 'string' || bytes === null) return null
  let copy: Replica
  try {
    copy = Replica.load(boardSchema, bytes, replica.actor)
  } catch (error) {
    if (isRefusal(error)) return null
    throw error
  }
  if (copy.docId !== replica.docId) return null
  return { changes: bytes, version: copy.version() }
}

/**
 * Imports the changes another copy of the board (file text) has into `replica`. `'unchanged'` when
 * it had nothing new; `'unsupported'` for text that is not a v2 board, holds another document, or
 * comes from a newer schema. Errors that are not about the text (a call during one of `replica`'s
 * transactions) are thrown.
 */
export function mergeBoardFile(replica: Replica, text: string): 'merged' | 'unchanged' | 'unsupported' {
  const copy = readBoardFileCopy(replica, text)
  if (copy === null) return 'unsupported'
  const before = replica.version()
  try {
    replica.importChanges(copy.changes)
  } catch (error) {
    if (isRefusal(error)) return 'unsupported'
    throw error
  }
  return replica.version().equals(before) ? 'unchanged' : 'merged'
}

/** Whether `replica` holds every change of `version` (for instance, of a file it merged). */
export function replicaIncludes(replica: Replica, version: Version): boolean {
  return versionIncludes(replica.version(), version)
}

/** Whether `version` holds every change of `other`. */
export function versionIncludes(version: Version, other: Version): boolean {
  const order = VersionVector.decode(version.encode()).compare(VersionVector.decode(other.encode()))
  return order === 0 || order === 1
}

/** KDM refusals of the bytes themselves; anything else (a reentrant call, an engine fault) is not. */
function isRefusal(error: unknown): error is KdmError {
  return error instanceof KdmError && (error.reason === 'encoding' || error.reason === 'schema' || error.reason === 'newer-schema' || error.reason === 'wrong-document')
}

/**
 * The kit a KDM snapshot names in its `meta`, read without loading it as a document, or `null`.
 * A board the schema refused (a newer KDM or schema version) still names `kit.board`: it belongs
 * to a newer Kition and must never be treated as replaceable.
 */
function snapshotKit(bytes: Uint8Array): unknown {
  try {
    const doc = new LoroDoc()
    doc.import(openEnvelope(bytes).engine)
    return doc.getMap('meta').get('kit') ?? null
  } catch {
    return null
  }
}

/**
 * The snapshot bytes of a v2 file, `'version-1'` for a version-1 file, `'newer-version'` for an
 * envelope of a newer version (whatever it holds), or `null`.
 */
function boardFileBytes(text: string): Uint8Array | 'version-1' | 'newer-version' | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const envelope = parsed as Record<string, unknown>
  if (envelope.format !== BOARD_FILE_FORMAT) return null
  if (envelope.version === 1) return 'version-1'
  if (typeof envelope.version === 'number' && Number.isInteger(envelope.version) && envelope.version > BOARD_FILE_VERSION) return 'newer-version'
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

/** The KDM's actor rule: an unsigned 64-bit integer other than 2^64 - 1, which the engine reserves. */
function checkBoardActor(actor: bigint) {
  if (typeof actor !== 'bigint' || actor < 0n || actor >= 0xffff_ffff_ffff_ffffn) {
    throw new KdmError('encoding', `encoding: actor id ${String(actor)} is not an unsigned 64-bit integer below 2^64 - 1`)
  }
}
