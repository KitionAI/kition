import { describe, expect, it } from 'vitest'
import { person, type Replica } from '@/lib/kdm'
import { createBoardElementRecord, type BoardBindingRecord, type BoardElementRecord, type BoardRecord } from '../lib/boardRecords'
import type { WhiteboardElement } from '../lib/whiteboardTypes'
import { boardRootId, readBoardRecords, readBoardTitle } from './boardKdmRead'
import { writeBoardDiff } from './boardKdmWrite'
import { createBoardFromRecords, createEmptyBoard, decodeBoardFile, encodeBoardFile, mergeBoardFile } from './boardKdmFile'

const me = person('user:test')

const rect = (id: string, index: number, pageId = 'page:a', extra: Partial<WhiteboardElement> = {}) =>
  createBoardElementRecord({ element: { id, kind: 'rectangle', x: index * 10, y: 0, width: 10, height: 10, ...extra } as WhiteboardElement, index, pageId })

const sampleRecords = (): BoardRecord[] => [
  { record_type: 'page', id: 'page:a', name: 'First', index: 0 },
  { record_type: 'page', id: 'page:b', name: 'Second', index: 1 },
  rect('r1', 0, 'page:a', { text: 'Hello' } as Partial<WhiteboardElement>),
  rect('r2', 1, 'page:a', { style: { fillColor: 'purple' } }),
  createBoardElementRecord({ element: { id: 'c1', kind: 'connector', start: { x: 0, y: 0 }, end: { x: 5, y: 5 } } as WhiteboardElement, index: 2, pageId: 'page:a' }),
  { record_type: 'binding', id: 'binding:c1:start', binding_type: 'connector', from_id: 'c1', to_id: 'r1', terminal: 'start' } satisfies BoardBindingRecord,
  rect('r3', 0, 'page:b'),
]

function decodeBoard(text: string, actor: bigint): Replica {
  const decoded = decodeBoardFile(text, actor)
  if (decoded.kind !== 'board') throw new Error(`expected a board, got ${decoded.reason}`)
  return decoded.replica
}

function addElement(replica: Replica, record: BoardElementRecord) {
  replica.transact(me, (tx) => writeBoardDiff(tx, boardRootId(replica), { added: [record], updated: [], removed: [] }))
}

const elementIds = (replica: Replica) => readBoardRecords(replica).filter((r) => r.record_type === 'element').map((r) => r.id).sort()

describe('boardKdmFile', () => {
  it('writes the v2 envelope on one line', () => {
    const text = encodeBoardFile(createEmptyBoard('Plan', 1n))
    expect(text.endsWith('\n')).toBe(true)
    expect(text.trimEnd()).not.toContain('\n')
    expect(JSON.parse(text)).toMatchObject({ format: 'kition-board', version: 2, kdm: expect.any(String) })
  })

  it('keeps records and title through encode and decode', () => {
    const board = createBoardFromRecords('Plan', 1n, sampleRecords())
    const copy = decodeBoard(encodeBoardFile(board), 2n)
    expect(readBoardRecords(copy)).toEqual(readBoardRecords(board))
    expect(readBoardTitle(copy)).toBe('Plan')
    expect(copy.docId).toBe(board.docId)
    expect(readBoardRecords(copy)).toContainEqual(expect.objectContaining({ id: 'r1', text: 'Hello', page_id: 'page:a', index: 0 }))
    expect(readBoardRecords(copy)).toContainEqual(expect.objectContaining({ id: 'binding:c1:start', to_id: 'r1' }))
  })

  it('refuses a version-1 file as version-1', () => {
    const v1 = JSON.stringify({ format: 'kition-board', version: 1, title: 'Old', viewport: { x: 0, y: 0, zoom: 1 }, records: [], updated_at: '2026-01-01T00:00:00.000Z' }, null, 2)
    expect(decodeBoardFile(v1, 1n)).toEqual({ kind: 'unsupported', reason: 'version-1' })
  })

  it.each([
    ['garbage', 'not json at all'],
    ['an empty file', ''],
    ['a JSON array', '[]'],
    ['another format', JSON.stringify({ format: 'kition-sheet', version: 2, kdm: '' })],
    ['an unknown version', JSON.stringify({ format: 'kition-board', version: 3, kdm: '' })],
    ['bad base64', JSON.stringify({ format: 'kition-board', version: 2, kdm: '@@not base64@@' })],
    ['base64 that is not a KDM snapshot', JSON.stringify({ format: 'kition-board', version: 2, kdm: btoa('hello world!') })],
  ])('refuses %s as not-a-board', (_name, text) => {
    expect(decodeBoardFile(text, 1n)).toEqual({ kind: 'unsupported', reason: 'not-a-board' })
  })

  it('merges a copy edited elsewhere, keeping both edits', () => {
    const mine = createBoardFromRecords('Plan', 1n, sampleRecords())
    const theirs = decodeBoard(encodeBoardFile(mine), 2n)
    addElement(mine, rect('mine', 3))
    addElement(theirs, rect('theirs', 3))
    expect(mergeBoardFile(mine, encodeBoardFile(theirs))).toBe('merged')
    expect(elementIds(mine)).toEqual(expect.arrayContaining(['mine', 'theirs', 'r1', 'r2', 'r3', 'c1']))
  })

  it('reports unchanged when the same text is merged twice', () => {
    const mine = createEmptyBoard('Plan', 1n)
    const theirs = decodeBoard(encodeBoardFile(mine), 2n)
    addElement(theirs, rect('theirs', 0, readBoardRecords(theirs)[0].id))
    const text = encodeBoardFile(theirs)
    expect(mergeBoardFile(mine, text)).toBe('merged')
    expect(mergeBoardFile(mine, text)).toBe('unchanged')
    expect(mergeBoardFile(mine, encodeBoardFile(mine))).toBe('unchanged')
  })

  it('refuses to merge another document or a file that is not a v2 board', () => {
    const mine = createEmptyBoard('Plan', 1n)
    expect(mergeBoardFile(mine, encodeBoardFile(createEmptyBoard('Other', 2n)))).toBe('unsupported')
    expect(mergeBoardFile(mine, JSON.stringify({ format: 'kition-board', version: 1, records: [] }))).toBe('unsupported')
    expect(mergeBoardFile(mine, 'garbage')).toBe('unsupported')
  })

  it('builds a board from records with nothing to undo', () => {
    const board = createBoardFromRecords('Plan', 1n, sampleRecords())
    expect(board.canUndo()).toBe(false)
    expect(board.undo()).toBe(false)
    expect(elementIds(board)).toEqual(['c1', 'r1', 'r2', 'r3'])
  })

  it('gives records without pages one default page', () => {
    const board = createBoardFromRecords('Plan', 1n, [rect('a', 0, 'page:missing'), rect('b', 1, 'page:missing')])
    const records = readBoardRecords(board)
    const pages = records.filter((r) => r.record_type === 'page')
    expect(pages).toHaveLength(1)
    expect(records.filter((r) => r.record_type === 'element')).toEqual([
      expect.objectContaining({ id: 'a', page_id: pages[0].id, index: 0 }),
      expect.objectContaining({ id: 'b', page_id: pages[0].id, index: 1 }),
    ])
    expect(readBoardTitle(board)).toBe('Plan')
  })

  it('encodes and decodes a board of 5,000 elements', () => {
    const records: BoardRecord[] = [{ record_type: 'page', id: 'page:a', name: 'Big', index: 0 }]
    for (let index = 0; index < 5000; index += 1) records.push(rect(`e${index}`, index, 'page:a', { text: `Element ${index}` } as Partial<WhiteboardElement>))
    const board = createBoardFromRecords('Big', 1n, records)
    const copy = decodeBoard(encodeBoardFile(board), 2n)
    const elements = readBoardRecords(copy).filter((r) => r.record_type === 'element')
    expect(elements).toHaveLength(5000)
    expect(elements.at(-1)).toMatchObject({ id: 'e4999', index: 4999 })
  }, 60_000)
})
