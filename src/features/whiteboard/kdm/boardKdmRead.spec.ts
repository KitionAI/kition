import { describe, expect, it } from 'vitest'
import { newDocId, person, Replica } from '@/lib/kdm'
import { boardSchema } from './boardSchema'
import {
  findBoardDuplicatePlacements,
  readBoardBindingRecords,
  readBoardElementRecord,
  readBoardElementRecords,
  readBoardPageRecords,
  readBoardRecords,
  readBoardTitle,
} from './boardKdmRead'

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

  it('reads an element listed on two pages once, on the first page in board order', () => {
    const doc = twoPages()
    const elements = readBoardRecords(doc).filter((r) => r.record_type === 'element')
    expect(elements.map((r) => [r.id, r.page_id, r.index])).toEqual([['a', 'page:main', 0], ['b', 'page:2', 0], ['c', 'page:2', 1]])
    expect(findBoardDuplicatePlacements(doc)).toEqual([{ id: 'a', pageId: 'page:2', index: 1 }, { id: 'b', pageId: 'page:2', index: 3 }])
  })
})

/** Pages `page:main` = [a] and `page:2` = [b, a, c, b, gone], where `gone` was deleted. */
function twoPages() {
  const doc = Replica.create(boardSchema, newDocId(), 1n)
  doc.transact(me, (tx) => {
    const root = tx.create('Board', { title: 'Plan' }, { id: 'board' })
    const main = tx.create('Page', { name: 'Page 1' }, { id: 'page:main' })
    const two = tx.create('Page', { name: 'Two' }, { id: 'page:2' })
    tx.listInsert(root, 'pages', 0, main)
    tx.listInsert(root, 'pages', 1, two)
    for (const id of ['a', 'b', 'gone']) tx.create('Element', { kind: 'rectangle', x: 1, y: 2, width: 3, height: 4 }, { id })
    const c = tx.create('Element', { kind: 'connector', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, startBinding: { target: 'a', anchor: null }, endBinding: { target: 'b', anchor: { x: 1, y: 0 } } }, { id: 'c' })
    tx.textInsert('b', 'text', 0, 'Bee')
    tx.listInsert(main, 'elements', 0, 'a')
    for (const [index, id] of ['b', 'a', c, 'b', 'gone'].entries()) tx.listInsert(two, 'elements', index, id)
  })
  doc.transact(me, (tx) => tx.delete('gone'))
  return doc
}

describe('per-object reads', () => {
  it('reads one element as readBoardRecords does', () => {
    const doc = twoPages()
    const all = readBoardRecords(doc)
    for (const id of ['a', 'b', 'c']) expect(readBoardElementRecord(doc, id)).toEqual(all.find((r) => r.id === id))
    expect(readBoardElementRecord(doc, 'gone')).toBeNull()
    expect(readBoardElementRecord(doc, 'nothing')).toBeNull()
    expect(readBoardElementRecords(doc, ['c', 'gone'])).toEqual(new Map([['c', all.find((r) => r.id === 'c')], ['gone', null]]))
  })

  it('reads the pages and a connector bindings as readBoardRecords does', () => {
    const doc = twoPages()
    const all = readBoardRecords(doc)
    expect(readBoardPageRecords(doc)).toEqual(all.filter((r) => r.record_type === 'page'))
    expect(readBoardBindingRecords(doc, ['c'])).toEqual(all.filter((r) => r.record_type === 'binding'))
    expect(readBoardBindingRecords(doc, ['a'])).toEqual([])
    expect(readBoardBindingRecords(doc, ['nothing'])).toEqual([])
  })
})
