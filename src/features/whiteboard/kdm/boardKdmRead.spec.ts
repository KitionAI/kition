import { describe, expect, it } from 'vitest'
import { newDocId, person, Replica } from '@/lib/kdm'
import { boardSchema } from './boardSchema'
import { readBoardRecords, readBoardTitle } from './boardKdmRead'

const me = person('user:test')

function board() {
  const doc = Replica.create(boardSchema, newDocId(), 1n)
  doc.transact(me, (tx) => {
    const page = tx.create('Page', { name: 'Page 1' }, { id: 'page:main' })
    const root = tx.create('Board', { title: 'Plan' }, { id: 'board' })
    tx.listInsert(root, 'pages', 0, page)
    const a = tx.create('Element', { kind: 'rectangle', x: 1, y: 2, width: 30, height: 40, fillColor: 'violet', opacity: 0.5 }, { id: 'a' })
    tx.textInsert(a, 'text', 0, 'Idea')
    const c = tx.create('Element', { kind: 'connector', start: { x: 0, y: 0 }, end: { x: 9, y: 9 }, endBinding: { target: 'a', anchor: { x: 0.5, y: 0 } } }, { id: 'c' })
    tx.listInsert(page, 'elements', 0, a)
    tx.listInsert(page, 'elements', 1, c)
  })
  return doc
}

describe('readBoardRecords', () => {
  it('turns pages, elements, order, style, text, and bindings into records', () => {
    const records = readBoardRecords(board())
    expect(records.find((r) => r.record_type === 'page')).toEqual({ record_type: 'page', id: 'page:main', name: 'Page 1', index: 0 })
    const a = records.find((r) => r.id === 'a')
    expect(a).toMatchObject({ record_type: 'element', kind: 'rectangle', page_id: 'page:main', index: 0, x: 1, y: 2, width: 30, height: 40, text: 'Idea', style: { fillColor: 'violet', opacity: 0.5 } })
    expect(records.find((r) => r.id === 'c')).toMatchObject({ kind: 'connector', index: 1, start: { x: 0, y: 0 }, end: { x: 9, y: 9 } })
    expect(records.find((r) => r.record_type === 'binding')).toEqual({
      record_type: 'binding', id: 'binding:c:end', binding_type: 'connector', from_id: 'c', to_id: 'a', terminal: 'end', to_anchor: { x: 0.5, y: 0 },
    })
    expect(records.some((r) => r.record_type === 'meta')).toBe(false)
  })

  it('reads the board title', () => {
    expect(readBoardTitle(board())).toBe('Plan')
  })
})
