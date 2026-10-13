import { describe, expect, it } from 'vitest'
import { Network, person, type Replica } from '@/lib/kdm'
import { createBoardElementRecord, type BoardElementRecord } from '../lib/boardRecords'
import type { BoardRecordDiff } from '../lib/boardStore'
import type { WhiteboardElement } from '../lib/whiteboardTypes'
import { boardSchema } from './boardSchema'
import { readBoardRecords } from './boardKdmRead'
import { createEmptyBoard } from './boardKdmFile'
import { writeBoardDiff } from './boardKdmWrite'

const me = person('user:test')
const rect = (id: string, index: number, extra: Record<string, unknown> = {}) =>
  createBoardElementRecord({ element: { id, kind: 'rectangle', x: 0, y: 0, width: 10, height: 10, ...extra } as never, index, pageId: 'page:main' })
const added = (...records: BoardElementRecord[]): BoardRecordDiff => ({ added: records, updated: [], removed: [] })

function apply(doc: Replica, diff: BoardRecordDiff) {
  doc.transact(me, (tx) => writeBoardDiff(tx, 'board', diff))
}

/** Replicas of one document whose first replica created the board root and page; synced. */
function seededNetwork(seed: number) {
  const net = new Network(boardSchema, 2, seed)
  net.replicas[0].transact(me, (tx) => {
    const page = tx.create('Page', { name: 'Page 1' }, { id: 'page:main' })
    const root = tx.create('Board', { title: 'Plan' }, { id: 'board' })
    tx.listInsert(root, 'pages', 0, page)
  })
  net.syncAll()
  return net
}

describe('writeBoardDiff', () => {
  it('adds elements in index order and reads them back', () => {
    const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
    apply(doc, added(rect('b', 1), rect('a', 0, { text: 'A', style: { fillColor: 'violet' } })))
    const elements = readBoardRecords(doc).filter((r) => r.record_type === 'element')
    expect(elements.map((r) => [r.id, (r as BoardElementRecord).index])).toEqual([['a', 0], ['b', 1]])
    expect(elements[0]).toMatchObject({ text: 'A', style: { fillColor: 'violet' } })
  })

  it('writes only changed fields, so a concurrent move and recolour both survive', () => {
    const net = seededNetwork(7)
    net.replicas[0].transact(me, (tx) => writeBoardDiff(tx, 'board', added(rect('a', 0))))
    net.syncAll()
    const before = readBoardRecords(net.replicas[0]).find((r) => r.id === 'a') as BoardElementRecord
    net.replicas[0].transact(me, (tx) => writeBoardDiff(tx, 'board', { added: [], removed: [], updated: [{ before, after: { ...before, x: 300 } as BoardElementRecord }] }))
    net.replicas[1].transact(me, (tx) => writeBoardDiff(tx, 'board', { added: [], removed: [], updated: [{ before, after: { ...before, style: { fillColor: 'red' } } as BoardElementRecord }] }))
    net.syncAll()
    net.converged()
    expect(readBoardRecords(net.replicas[1]).find((r) => r.id === 'a')).toMatchObject({ x: 300, style: { fillColor: 'red' } })
  })

  it('edits text minimally, so concurrent insertions in one label merge', () => {
    const net = seededNetwork(3)
    net.replicas[0].transact(me, (tx) => writeBoardDiff(tx, 'board', added(rect('a', 0, { text: 'Hello world' }))))
    net.syncAll()
    const before = readBoardRecords(net.replicas[0]).find((r) => r.id === 'a') as BoardElementRecord
    net.replicas[0].transact(me, (tx) => writeBoardDiff(tx, 'board', { added: [], removed: [], updated: [{ before, after: { ...before, text: 'Hello big world' } as BoardElementRecord }] }))
    net.replicas[1].transact(me, (tx) => writeBoardDiff(tx, 'board', { added: [], removed: [], updated: [{ before, after: { ...before, text: 'Hello world!' } as BoardElementRecord }] }))
    net.syncAll()
    net.converged()
    expect(net.replicas[0].text('a', 'text')).toBe('Hello big world!')
  })

  it('never splits a surrogate pair when editing text', () => {
    const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
    apply(doc, added(rect('a', 0, { text: 'a\u{1F600}b' })))
    const before = readBoardRecords(doc).find((r) => r.id === 'a') as BoardElementRecord
    apply(doc, { added: [], removed: [], updated: [{ before, after: { ...before, text: 'a\u{1F601}b' } as BoardElementRecord }] })
    expect(doc.text('a', 'text')).toBe('a\u{1F601}b')
  })

  it('reorders with list moves and keeps every element once under concurrent reorders', () => {
    const net = seededNetwork(5)
    net.replicas[0].transact(me, (tx) => writeBoardDiff(tx, 'board', added(rect('a', 0), rect('b', 1), rect('c', 2))))
    net.syncAll()
    const recs = () => readBoardRecords(net.replicas[0]).filter((r) => r.record_type === 'element') as BoardElementRecord[]
    const [a, b, c] = recs()
    net.replicas[0].transact(me, (tx) => writeBoardDiff(tx, 'board', { added: [], removed: [], updated: [
      { before: a, after: { ...a, index: 2 } }, { before: c, after: { ...c, index: 0 } },
    ] }))
    expect(net.replicas[0].list('page:main', 'elements')).toEqual(['c', 'b', 'a'])
    net.replicas[1].transact(me, (tx) => writeBoardDiff(tx, 'board', { added: [], removed: [], updated: [
      { before: b, after: { ...b, index: 0 } }, { before: a, after: { ...a, index: 1 } },
    ] }))
    expect(net.replicas[1].list('page:main', 'elements')).toEqual(['b', 'a', 'c'])
    net.syncAll()
    net.converged()
    expect(recs().map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('stores connector bindings on the connector and clears them on removal', () => {
    const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
    const connector = createBoardElementRecord({ element: { id: 'c', kind: 'connector', start: { x: 0, y: 0 }, end: { x: 5, y: 5 } }, index: 1, pageId: 'page:main' })
    const binding = { record_type: 'binding' as const, id: 'binding:c:end', binding_type: 'connector' as const, from_id: 'c', to_id: 'a', terminal: 'end' as const, to_anchor: { x: 0, y: 1 } }
    apply(doc, { added: [rect('a', 0), connector, binding], updated: [], removed: [] })
    expect(doc.get('c', 'endBinding')).toEqual({ anchor: { x: 0, y: 1 }, target: 'a' })
    apply(doc, { added: [], updated: [], removed: [binding] })
    expect(doc.get('c', 'endBinding')).toBeNull()
  })

  it('moves an element to another page', () => {
    const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
    const page2 = { record_type: 'page' as const, id: 'page:2', name: 'Two', index: 1 }
    apply(doc, { added: [rect('a', 0), page2], updated: [], removed: [] })
    const a = readBoardRecords(doc).find((r) => r.id === 'a') as BoardElementRecord
    apply(doc, { added: [], removed: [], updated: [{ before: a, after: { ...a, page_id: 'page:2', index: 0 } }] })
    expect(readBoardRecords(doc).find((r) => r.id === 'a')).toMatchObject({ page_id: 'page:2', index: 0 })
    expect(doc.list('page:main', 'elements')).toEqual([])
  })

  it('round-trips every element kind through the KDM', () => {
    const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
    const elements: WhiteboardElement[] = [
      { id: 'r', kind: 'rectangle', x: 1, y: 2, width: 3, height: 4, rotation: 45, locked: true, shapeType: 'ellipse', shapeStyle: 'sticky', text: 'Note', mindMapDirection: 'right', mindMapCollapsed: true, sourceRefIds: ['ref:1'], style: { strokeColor: 'ink', fillColor: 'yellow', opacity: 0.8, fillStyle: 'solid', dashStyle: 'dashed', strokeSize: 'l' } },
      { id: 't', kind: 'text', x: 5, y: 6, text: '', fontSize: 30, parentId: 'r' },
      { id: 's', kind: 'stroke', points: [{ x: 0, y: 0 }, { x: 4, y: 2 }] },
      { id: 'c', kind: 'connector', start: { x: 0, y: 0 }, end: { x: 8, y: 8 }, connectorType: 'elbow', startArrowhead: 'dot', endArrowhead: 'arrow', connectorRole: 'mind-map-branch', mindMapBranchAxis: 'vertical' },
      { id: 'i', kind: 'image', x: 0, y: 0, width: 64, height: 32, workspacePath: 'images/cat.png', alt: 'A cat' },
    ]
    const records = elements.map((element, index) => createBoardElementRecord({ element, index, pageId: 'page:main' }))
    apply(doc, { added: records, updated: [], removed: [] })
    expect(readBoardRecords(doc).filter((r) => r.record_type === 'element')).toEqual(records)
  })

  it('moves one element with one list operation', () => {
    const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
    apply(doc, added(rect('a', 0), rect('b', 1), rect('c', 2), rect('d', 3)))
    const [a, b, c, d] = readBoardRecords(doc).filter((r) => r.record_type === 'element') as BoardElementRecord[]
    const operations: string[] = []
    doc.transact(me, (tx) => {
      const spy = new Proxy(tx, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver) as unknown
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            if (typeof key === 'string' && key.startsWith('list') && key !== 'listItems') operations.push(key)
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        },
      })
      writeBoardDiff(spy, 'board', { added: [], removed: [], updated: [
        { before: a, after: { ...a, index: 3 } }, { before: b, after: { ...b, index: 0 } }, { before: c, after: { ...c, index: 1 } }, { before: d, after: { ...d, index: 2 } },
      ] })
    })
    expect(doc.list('page:main', 'elements')).toEqual(['b', 'c', 'd', 'a'])
    expect(operations).toEqual(['listMove'])
  })

  it('removes elements and pages, deleting a removed page with its elements', () => {
    const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
    const page2 = { record_type: 'page' as const, id: 'page:2', name: 'Two', index: 1 }
    const onTwo = createBoardElementRecord({ element: { id: 'z', kind: 'text', x: 0, y: 0, text: 'z' }, index: 0, pageId: 'page:2' })
    apply(doc, { added: [rect('a', 0), rect('b', 1), page2, onTwo], updated: [], removed: [] })
    const records = readBoardRecords(doc)
    const b = records.find((r) => r.id === 'b')!
    apply(doc, { added: [], updated: [], removed: [b, page2] })
    expect(doc.list('page:main', 'elements')).toEqual(['a'])
    expect(doc.list('board', 'pages')).toEqual(['page:main'])
    expect(doc.exists('b')).toBe(false)
    expect(doc.exists('z')).toBe(false)
    expect(doc.exists('page:2')).toBe(false)
  })
})
