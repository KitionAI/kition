import { describe, expect, it } from 'vitest'
import { createBoardElementRecord, type BoardRecord } from './boardRecords'
import { boardRecordsEqual } from './boardRecordEquality'

const rect = (extra: Record<string, unknown> = {}) =>
  ({ id: 'a', kind: 'rectangle', x: 0, y: 0, width: 10, height: 10, rotation: 0, locked: false, record_type: 'element', page_id: 'p', index: 0, ...extra }) as BoardRecord

describe('boardRecordsEqual', () => {
  it('ignores key order, including inside nested values', () => {
    const left = rect({ style: { fillColor: 'red', opacity: 0.5 }, sourceRefIds: ['x'] })
    const right = Object.fromEntries(Object.entries(rect({ sourceRefIds: ['x'], style: { opacity: 0.5, fillColor: 'red' } })).reverse()) as BoardRecord
    expect(boardRecordsEqual(left, right)).toBe(true)
  })

  it('treats undefined members, empty rectangle text, and empty styles as absent', () => {
    expect(boardRecordsEqual(rect({ parentId: undefined }), rect())).toBe(true)
    expect(boardRecordsEqual(rect({ text: '' }), rect())).toBe(true)
    expect(boardRecordsEqual(rect({ style: {} }), rect())).toBe(true)
    expect(boardRecordsEqual(rect({ style: { fillColor: undefined } }), rect({ style: {} }))).toBe(true)
    expect(boardRecordsEqual(rect({ style: { fillColor: 'red', opacity: undefined } }), rect({ style: { fillColor: 'red' } }))).toBe(true)
    const binding: BoardRecord = { record_type: 'binding', id: 'binding:c:end', binding_type: 'connector', from_id: 'c', to_id: 'a', terminal: 'end' }
    expect(boardRecordsEqual({ ...binding, from_anchor: undefined, to_anchor: undefined }, binding)).toBe(true)
  })

  it('tells different records apart', () => {
    expect(boardRecordsEqual(rect({ x: 1 }), rect())).toBe(false)
    expect(boardRecordsEqual(rect({ text: 'A' }), rect())).toBe(false)
    expect(boardRecordsEqual(rect({ style: { fillColor: 'red' } }), rect())).toBe(false)
    expect(boardRecordsEqual(rect({ sourceRefIds: ['x'] }), rect({ sourceRefIds: ['x', 'y'] }))).toBe(false)
    expect(boardRecordsEqual(rect({ sourceRefIds: [] }), rect({ sourceRefIds: {} }))).toBe(false)
    expect(boardRecordsEqual(rect({ index: 1 }), rect())).toBe(false)
    expect(boardRecordsEqual(rect({ parentId: null }), rect())).toBe(false)
  })

  it('keeps empty text of a text element meaningful', () => {
    const text = (extra: Record<string, unknown>) => createBoardElementRecord({ element: { id: 't', kind: 'text', x: 0, y: 0, text: 'x', ...extra } as never, index: 0, pageId: 'p' })
    expect(boardRecordsEqual(text({ text: '' }), text({ text: '' }))).toBe(true)
    const { text: _text, ...withoutText } = text({ text: '' }) as Record<string, unknown>
    expect(boardRecordsEqual(text({ text: '' }), withoutText as BoardRecord)).toBe(false)
  })
})
