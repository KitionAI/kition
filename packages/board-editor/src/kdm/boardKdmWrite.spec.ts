import { describe, expect, it } from 'vitest'
import { Network, newDocId, parseSchema, person, Replica, Rng } from '@kition/kdm'
import { createBoardElementRecord, type BoardBindingRecord, type BoardElementRecord, type BoardPageRecord } from '../lib/boardRecords'
import type { BoardRecordDiff } from '../lib/boardStore'
import type { WhiteboardElement } from '../lib/whiteboardTypes'
import { boardSchema } from './boardSchema'
import { boardRootId, findBoardDuplicatePlacements, readBoardElementRecord, readBoardRecords, readBoardView } from './boardKdmRead'
import { createBoardFromRecords, createEmptyBoard } from './boardKdmFile'
import { repairBoardPlacements, writeBoardDiff } from './boardKdmWrite'

const me = person('user:test')
const rect = (id: string, index: number, extra: Record<string, unknown> = {}) =>
  createBoardElementRecord({ element: { id, kind: 'rectangle', x: 0, y: 0, width: 10, height: 10, ...extra } as never, index, pageId: 'page:main' })
const added = (...records: BoardElementRecord[]): BoardRecordDiff => ({ added: records, updated: [], removed: [] })

function apply(doc: Replica, diff: BoardRecordDiff) {
  return doc.transact(me, (tx) => writeBoardDiff(tx, 'board', diff))
}

const page = (id: string, index: number, name = id): BoardPageRecord => ({ record_type: 'page', id, name, index })
const onPage = (record: BoardElementRecord, pageId: string, index: number) => ({ ...record, page_id: pageId, index }) as BoardElementRecord
const elementsOf = (doc: Replica) => readBoardRecords(doc).filter((r): r is BoardElementRecord => r.record_type === 'element')
const recordOf = (doc: Replica, id: string) => elementsOf(doc).find((r) => r.id === id)!
const update = (before: BoardElementRecord, after: BoardElementRecord): BoardRecordDiff => ({ added: [], removed: [], updated: [{ before, after }] })

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

  describe('an element on a page that does not exist', () => {
    it('places an added element on the first page, after its elements', () => {
      const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
      apply(doc, { added: [page('page:0', 0), rect('a', 0), onPage(rect('b', 0), 'page:0', 0)], updated: [], removed: [] })
      expect(doc.list('board', 'pages')).toEqual(['page:0', 'page:main'])
      const result = apply(doc, added(onPage(rect('x', 0), 'page:gone', 0)))
      expect(recordOf(doc, 'x')).toMatchObject({ page_id: 'page:0', index: 1 })
      expect(doc.list('page:0', 'elements')).toEqual(['b', 'x'])
      expect(result.relocated).toEqual(['x'])
    })

    it('moves an element to the first page instead of dropping it', () => {
      const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
      apply(doc, { added: [page('page:2', 1), rect('a', 0), onPage(rect('z', 0), 'page:2', 0)], updated: [], removed: [] })
      const z = recordOf(doc, 'z')
      const result = apply(doc, update(z, onPage(z, 'page:gone', 0)))
      expect(doc.list('page:2', 'elements')).toEqual([])
      expect(doc.list('page:main', 'elements')).toEqual(['a', 'z'])
      expect(recordOf(doc, 'z')).toMatchObject({ page_id: 'page:main', index: 1 })
      expect(result.relocated).toEqual(['z'])
    })

    it('treats a page added in the same diff as existing', () => {
      const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
      const result = apply(doc, { added: [page('page:2', 1), onPage(rect('z', 0), 'page:2', 0)], updated: [], removed: [] })
      expect(recordOf(doc, 'z')).toMatchObject({ page_id: 'page:2', index: 0 })
      expect(result).toEqual({ skipped: [], relocated: [] })
    })
  })

  describe('elements placed on two pages by a merge', () => {
    /** Two replicas that concurrently move `a` from page:main to page:2 and page:3. */
    function crossPageMoves() {
      const net = seededNetwork(11)
      net.replicas[0].transact(me, (tx) => writeBoardDiff(tx, 'board', { added: [page('page:2', 1), page('page:3', 2), rect('a', 0), rect('b', 1)], updated: [], removed: [] }))
      net.syncAll()
      const a = recordOf(net.replicas[0], 'a')
      net.replicas[0].transact(me, (tx) => writeBoardDiff(tx, 'board', update(a, onPage(a, 'page:3', 0))))
      net.replicas[1].transact(me, (tx) => writeBoardDiff(tx, 'board', update(a, onPage(a, 'page:2', 0))))
      net.syncAll()
      net.converged()
      return net
    }

    it('keeps the element on both page lists after the merge, read once on the first page', () => {
      const doc = crossPageMoves().replicas[0]
      expect(doc.list('page:2', 'elements')).toEqual(['a'])
      expect(doc.list('page:3', 'elements')).toEqual(['a'])
      expect(elementsOf(doc).map((r) => [r.id, r.page_id, r.index])).toEqual([['b', 'page:main', 0], ['a', 'page:2', 0]])
    })

    it('reports the extra placements and repairs them so replicas converge on one placement', () => {
      const net = crossPageMoves()
      expect(findBoardDuplicatePlacements(net.replicas[1])).toEqual([{ id: 'a', pageId: 'page:3', index: 0 }])
      net.replicas[1].transact(me, (tx) => repairBoardPlacements(tx, 'board'))
      net.syncAll()
      net.converged()
      expect(findBoardDuplicatePlacements(net.replicas[0])).toEqual([])
      expect(net.replicas[0].list('page:3', 'elements')).toEqual([])
      expect(recordOf(net.replicas[0], 'a')).toMatchObject({ page_id: 'page:2', index: 0 })
    })

    it('moves a doubly placed element to a third page without leaving a copy behind', () => {
      const doc = crossPageMoves().replicas[0]
      const a = recordOf(doc, 'a')
      apply(doc, update(a, onPage(a, 'page:main', 1)))
      expect(doc.list('page:main', 'elements')).toEqual(['b', 'a'])
      expect(doc.list('page:2', 'elements')).toEqual([])
      expect(doc.list('page:3', 'elements')).toEqual([])
    })
  })

  describe('text edits next to concurrent edits', () => {
    function remoteLabel(remote: string) {
      const net = seededNetwork(13)
      const [local, other] = net.replicas
      local.transact(me, (tx) => writeBoardDiff(tx, 'board', added(rect('a', 0, { text: 'Hello world' }))))
      net.syncAll()
      const before = recordOf(local, 'a')
      other.transact(me, (tx) => writeBoardDiff(tx, 'board', update(before, { ...before, text: remote } as BoardElementRecord)))
      net.syncAll()
      return { local, before }
    }

    it('applies the edit at its place when the label changed after it', () => {
      const { local, before } = remoteLabel('Hello world!')
      apply(local, update(before, { ...before, text: 'Hello big world' } as BoardElementRecord))
      expect(local.text('a', 'text')).toBe('Hello big world!')
    })

    it('applies the edit at its place when the label changed before it', () => {
      const { local, before } = remoteLabel('Oh, Hello world')
      apply(local, update(before, { ...before, text: 'Hello big world' } as BoardElementRecord))
      expect(local.text('a', 'text')).toBe('Oh, Hello big world')
    })

    it('falls back to the store text when the label changed on both sides', () => {
      const { local, before } = remoteLabel('Oh, Hello world!')
      apply(local, update(before, { ...before, text: 'Hello big world' } as BoardElementRecord))
      expect(local.text('a', 'text')).toBe('Hello big world')
    })

    it('matches a label holding a lone surrogate against the stored replacement character', () => {
      const net = seededNetwork(17)
      const [local, other] = net.replicas
      local.transact(me, (tx) => writeBoardDiff(tx, 'board', added(rect('a', 0, { text: 'x\uD800y z' }))))
      net.syncAll()
      expect(local.text('a', 'text')).toBe('x�y z')
      const view = rect('a', 0, { text: 'x\uD800y z' })
      const synced = recordOf(local, 'a')
      other.transact(me, (tx) => writeBoardDiff(tx, 'board', update(synced, { ...synced, text: 'x�y z!' } as BoardElementRecord)))
      net.syncAll()
      apply(local, update(view, { ...view, text: 'x\uD800y Q z' } as BoardElementRecord))
      expect(local.text('a', 'text')).toBe('x�y Q z!')
    })
  })

  describe('writes it cannot apply', () => {
    it('reports updates of missing elements and bindings of missing connectors', () => {
      const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
      const ghost = rect('ghost', 0)
      const binding: BoardBindingRecord = { record_type: 'binding', id: 'binding:c:end', binding_type: 'connector', from_id: 'c', to_id: 'a', terminal: 'end' }
      const result = apply(doc, { added: [binding], removed: [], updated: [
        { before: ghost, after: { ...ghost, x: 5 } as BoardElementRecord },
        { before: page('page:gone', 3), after: page('page:gone', 3, 'Renamed') },
      ] })
      expect(result).toEqual({ skipped: ['page:gone', 'ghost', 'binding:c:end'], relocated: [] })
      expect(doc.exists('ghost')).toBe(false)
    })

    it('refuses non-finite numbers before writing anything, naming the element and field', () => {
      const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
      const before = doc.stateText()
      expect(() => apply(doc, added(rect('a', 0), rect('b', 1, { x: Number.NaN })))).toThrow(/"b".*\bx\b/)
      expect(() => apply(doc, added(rect('c', 0, { style: { opacity: Infinity } })))).toThrow(/"c".*opacity/)
      expect(() => apply(doc, added(createBoardElementRecord({ element: { id: 's', kind: 'stroke', points: [{ x: 0, y: Number.NaN }] }, index: 0, pageId: 'page:main' })))).toThrow(/"s".*points/)
      expect(doc.stateText()).toBe(before)
      apply(doc, added(rect('a', 0)))
      const a = recordOf(doc, 'a')
      expect(() => apply(doc, update(a, { ...a, width: -Infinity } as BoardElementRecord))).toThrow(/"a".*width/)
    })

    it('stores lone surrogates in string fields as replacement characters', () => {
      const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
      apply(doc, { added: [page('page:2', 1, 'P\uDC00'), createBoardElementRecord({ element: { id: 'i', kind: 'image', x: 0, y: 0, width: 1, height: 1, workspacePath: 'a\uD800.png', alt: 'x' }, index: 0, pageId: 'page:main' })], updated: [], removed: [] })
      expect(readBoardRecords(doc).find((r) => r.id === 'page:2')).toMatchObject({ name: 'P�' })
      expect(recordOf(doc, 'i')).toMatchObject({ workspacePath: 'a�.png' })
    })
  })

  describe('positions of items the reader skips', () => {
    it('does not count an element placed on an earlier page', () => {
      const doc = createEmptyBoard('Plan', 1n, { rootId: 'board', pageId: 'page:main' })
      apply(doc, { added: [page('page:2', 1), rect('a', 0), onPage(rect('b', 0), 'page:2', 0), onPage(rect('c', 1), 'page:2', 1)], updated: [], removed: [] })
      doc.transact(me, (tx) => tx.listInsert('page:2', 'elements', 1, 'a'))
      expect(doc.list('page:2', 'elements')).toEqual(['b', 'a', 'c'])
      apply(doc, added(onPage(rect('aa', 2), 'page:2', 2)))
      expect(elementsOf(doc).filter((r) => r.page_id === 'page:2').map((r) => [r.id, r.index])).toEqual([['b', 0], ['c', 1], ['aa', 2]])
      expect(doc.list('page:main', 'elements')).toEqual(['a'])
    })

    it('keeps elements of kinds it does not know where they are', () => {
      const source = JSON.parse(JSON.stringify(boardSchema)) as { types: { Element: { fields: { kind: { values: string[] } } } } }
      source.types.Element.fields.kind.values.push('sticker')
      const future = parseSchema(source)
      const original = Replica.create(future, newDocId(), 1n)
      original.transact(me, (tx) => {
        const root = tx.create('Board', { title: 'Plan' }, { id: 'board' })
        const main = tx.create('Page', { name: 'Page 1' }, { id: 'page:main' })
        tx.listInsert(root, 'pages', 0, main)
        for (const [index, [id, kind]] of [['a', 'rectangle'], ['s', 'sticker'], ['b', 'rectangle']].entries()) {
          tx.create('Element', { kind, x: 0, y: 0, width: 1, height: 1 }, { id })
          tx.listInsert(main, 'elements', index, id)
        }
      })
      const doc = Replica.load(boardSchema, original.snapshot(), 2n)
      expect(elementsOf(doc).map((r) => [r.id, r.index])).toEqual([['a', 0], ['b', 1]])
      apply(doc, added(rect('aa', 2)))
      expect(doc.list('page:main', 'elements')).toEqual(['a', 's', 'b', 'aa'])
      const [a, b] = elementsOf(doc)
      apply(doc, { added: [], removed: [], updated: [{ before: a, after: { ...a, index: 1 } }, { before: b, after: { ...b, index: 0 } }] })
      expect(elementsOf(doc).map((r) => [r.id, r.index])).toEqual([['b', 0], ['a', 1], ['aa', 2]])
      expect(doc.list('page:main', 'elements')).toContain('s')
    })
  })

  it('reorders 5,000 elements quickly (timing printed)', () => {
    const count = 5_000
    const records = Array.from({ length: count }, (_, index) => rect(`e${index}`, index))
    let started = performance.now()
    const doc = createBoardFromRecords('Plan', 1n, [page('page:main', 0), ...records])
    const create = performance.now() - started
    const root = boardRootId(doc)
    started = performance.now()
    const current = elementsOf(doc)
    const read = performance.now() - started
    started = performance.now()
    const result = doc.transact(me, (tx) => writeBoardDiff(tx, root, { added: [], removed: [], updated: current.map((before) => ({ before, after: { ...before, index: count - 1 - before.index } })) }))
    const reverse = performance.now() - started
    expect(result.skipped).toEqual([])
    expect(doc.list('page:main', 'elements')[0]).toBe(`e${count - 1}`)
    started = performance.now()
    doc.transact(me, (tx) => writeBoardDiff(tx, root, added(rect('new', count))))
    const addOne = performance.now() - started
    started = performance.now()
    readBoardElementRecord(doc, 'e10', root)
    const readFirst = performance.now() - started
    started = performance.now()
    readBoardElementRecord(doc, `e${count - 10}`, root)
    const readLast = performance.now() - started
    started = performance.now()
    findBoardDuplicatePlacements(doc, root)
    const duplicates = performance.now() - started
    console.info(`[timing] ${count} elements: create ${create.toFixed(1)} ms, readBoardRecords ${read.toFixed(1)} ms, reverse ${reverse.toFixed(1)} ms, add one ${addOne.toFixed(1)} ms, readBoardElementRecord first ${readFirst.toFixed(1)} ms, last ${readLast.toFixed(1)} ms, findBoardDuplicatePlacements ${duplicates.toFixed(1)} ms`)
  })

  it('places added, moved, and removed elements as the records ask, with or without a read hint', () => {
    const future = (() => {
      const source = JSON.parse(JSON.stringify(boardSchema)) as { types: { Element: { fields: { kind: { values: string[] } } } } }
      source.types.Element.fields.kind.values.push('sticker')
      return parseSchema(source)
    })()
    for (const seed of [21, 22, 23, 24, 25, 26]) {
      const rng = new Rng(seed)
      const pages = ['page:main', 'page:2', 'page:3']
      const original = Replica.create(future, newDocId(), 1n)
      original.transact(me, (tx) => {
        tx.create('Board', { title: 'Plan' }, { id: 'board' })
        pages.forEach((id, index) => {
          tx.create('Page', { name: id }, { id })
          tx.listInsert('board', 'pages', index, id)
        })
        for (let index = 0; index < 30; index += 1) {
          const id = `e${index}`
          tx.create('Element', { kind: rng.below(6) === 0 ? 'sticker' : 'rectangle', x: 0, y: 0, width: 1, height: 1 }, { id })
          const pageId = pages[rng.below(pages.length)]
          tx.listInsert(pageId, 'elements', rng.below(tx.listItems(pageId, 'elements').length + 1), id)
        }
        // Merge leftovers: an element listed twice, and a dangling id.
        tx.listInsert('page:3', 'elements', 0, tx.listItems('page:main', 'elements')[0] ?? 'e0')
        tx.listInsert('page:2', 'elements', 0, 'gone')
      })
      for (let round = 0; round < 6; round += 1) {
        const [plain, hinted] = [Replica.load(boardSchema, original.snapshot(), 2n), Replica.load(boardSchema, original.snapshot(), 3n)]
        const before = elementsOf(plain)
        const diff: BoardRecordDiff = { added: [], updated: [], removed: [] }
        const touched = new Set<string>()
        for (let change = 0; change < 1 + rng.below(3); change += 1) {
          const pageId = pages[rng.below(pages.length)]
          const kind = rng.below(3)
          const candidates = before.filter((record) => !touched.has(record.id))
          if (kind === 0 || candidates.length === 0) {
            const id = `n${round}-${change}`
            diff.added.push(onPage(rect(id, 0), pageId, rng.below(12)))
          } else {
            const record = candidates[rng.below(candidates.length)]
            touched.add(record.id)
            if (kind === 1) diff.removed.push(record)
            else diff.updated.push({ before: record, after: onPage(record, pageId, rng.below(12)) })
          }
        }
        apply(plain, diff)
        hinted.transact(me, (tx) => writeBoardDiff(tx, 'board', diff, { read: readBoardView(hinted), changed: new Set() }))

        // The order keys the writer promises: kept elements keep their index, added and moved ones
        // take theirs, ties broken by id.
        const keys = new Map<string, Map<string, number>>()
        const keyOn = (pageId: string) => keys.get(pageId) ?? keys.set(pageId, new Map()).get(pageId)!
        const moved = new Set([...diff.removed, ...diff.updated.map((update) => update.after)].map((record) => record.id))
        for (const record of before) if (!moved.has(record.id)) keyOn(record.page_id).set(record.id, record.index)
        for (const record of [...diff.added, ...diff.updated.map((update) => update.after)] as BoardElementRecord[]) keyOn(record.page_id).set(record.id, record.index)
        for (const pageId of pages) {
          const expected = [...keyOn(pageId)].sort(([left, a], [right, b]) => a - b || left.localeCompare(right)).map(([id]) => id)
          const shown = elementsOf(plain).filter((record) => record.page_id === pageId).map((record) => record.id)
          expect(shown, `seed ${seed}, round ${round}, ${pageId}`).toEqual(expected)
          expect(hinted.list(pageId, 'elements'), `seed ${seed}, round ${round}, ${pageId}`).toEqual(plain.list(pageId, 'elements'))
        }
      }
    }
  })
})
