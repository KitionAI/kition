import { describe, expect, it } from 'vitest'
import { person, Replica } from '@/lib/kdm'
import { BoardStore } from './boardStore'
import { createBoardElementRecord, type BoardBindingRecord, type BoardElementRecord, type BoardPageRecord } from './boardRecords'
import { findBoardDuplicatePlacements } from '../kdm/boardKdmRead'
import { boardSchema } from '../kdm/boardSchema'

const rect = (id: string, index: number) => createBoardElementRecord({ element: { id, kind: 'rectangle', x: 0, y: 0, width: 10, height: 10 }, index, pageId: '' })

describe('BoardStore on the KDM', () => {
  it('commits a transaction as one KDM change and undo reverts it', () => {
    const store = new BoardStore()
    const page = store.getCurrentPageId()
    store.transact('add', (tx) => tx.put({ ...rect('a', 0), page_id: page }))
    expect(store.getReplica().exists('a')).toBe(true)
    store.undo()
    expect(store.getRecord('a')).toBeNull()
    expect(store.getSnapshot().canRedo).toBe(true)
  })

  it('keeps live gesture updates local until commit', () => {
    const store = new BoardStore()
    const page = store.getCurrentPageId()
    store.transact('add', (tx) => tx.put({ ...rect('a', 0), page_id: page }))
    const version = store.getReplica().version()
    const live = store.beginTransaction('move', { live: true })
    live.put({ ...store.getElementRecord('a')!, x: 50 } as BoardElementRecord)
    expect(store.getReplica().version().equals(version)).toBe(true)
    live.commit()
    expect(store.getReplica().get('a', 'x')).toBe(50)
  })

  it('squashes marked commands into one undo step and bails without a redo entry', () => {
    const store = new BoardStore()
    const page = store.getCurrentPageId()
    const mark = store.markHistory()
    store.transact('one', (tx) => tx.put({ ...rect('a', 0), page_id: page }))
    store.transact('two', (tx) => tx.put({ ...rect('b', 1), page_id: page }))
    store.squashToMark(mark, 'both')
    store.undo()
    expect(store.getRecord('a')).toBeNull()
    expect(store.getRecord('b')).toBeNull()
    store.redo()
    const bail = store.markHistory()
    store.transact('three', (tx) => tx.put({ ...rect('c', 2), page_id: page }))
    store.bailToMark(bail)
    expect(store.getRecord('c')).toBeNull()
    expect(store.getSnapshot().canRedo).toBe(false)
  })

  it('switching pages is not an undo step and never reaches the replica', () => {
    const store = new BoardStore()
    const version = store.getReplica().version()
    const canUndo = store.getSnapshot().canUndo
    store.setActivePage(store.getCurrentPageId())
    expect(store.getReplica().version().equals(version)).toBe(true)
    expect(store.getSnapshot().canUndo).toBe(canUndo)
  })

  it('merges changes imported from another copy of the file', () => {
    const store = new BoardStore()
    const page = store.getCurrentPageId()
    store.transact('add', (tx) => tx.put({ ...rect('a', 0), page_id: page }))
    const other = Replica.load(boardSchema, store.snapshot(), 99n)
    other.transact({ kind: 'person', principal: 'user:other' }, (tx) => tx.set('a', 'x', 77))
    store.transact('move', (tx) => tx.put({ ...store.getElementRecord('a')!, y: 5 } as BoardElementRecord))
    store.importChanges(other.exportChanges())
    expect(store.getElementRecord('a')).toMatchObject({ x: 77, y: 5 })
  })
})

describe('BoardStore history and merges on the KDM', () => {
  const add = (store: BoardStore, ...records: BoardElementRecord[]) => store.transact('add', (tx) => {
    for (const record of records) tx.put({ ...record, page_id: store.getCurrentPageId() })
  })

  it('merges the steps of a mark squashed again into one undo step', () => {
    const store = new BoardStore()
    const mark = store.markHistory()
    add(store, rect('a', 0))
    store.squashToMark(mark, 'Add')
    add(store, rect('b', 1))
    store.squashToMark(mark, 'Add and edit')
    store.undo()
    expect(store.getRecord('a')).toBeNull()
    expect(store.getRecord('b')).toBeNull()
    expect(store.getSnapshot().canUndo).toBe(false)
    expect(store.getRecentUserOperations()).toEqual(['Add and edit'])
  })

  it('keeps imports for the end of a marked gesture', () => {
    const store = new BoardStore()
    add(store, rect('a', 0))
    const other = Replica.load(boardSchema, store.snapshot(), 99n)
    other.transact(person('user:other'), (tx) => tx.set('a', 'x', 77))
    const mark = store.markHistory()
    add(store, rect('b', 1))
    store.importChanges(other.exportChanges())
    expect(store.getElementRecord('a')).toMatchObject({ x: 0 })
    store.squashToMark(mark, 'Add')
    expect(store.getElementRecord('a')).toMatchObject({ x: 77 })
    store.undo()
    expect(store.getRecord('b')).toBeNull()
    expect(store.getElementRecord('a')).toMatchObject({ x: 77 })
  })

  it('rebuilds the view after a gesture during which an import deleted its element', () => {
    const store = new BoardStore()
    add(store, rect('a', 0))
    const other = Replica.load(boardSchema, store.snapshot(), 99n)
    other.transact(person('user:other'), (tx) => tx.delete('a'))
    const live = store.beginTransaction('move', { live: true })
    live.put({ ...store.getElementRecord('a')!, x: 9 } as BoardElementRecord)
    store.importChanges(other.exportChanges())
    expect(store.getElementRecord('a')).toMatchObject({ x: 9 })
    live.commit()
    expect(store.getRecord('a')).toBeNull()
  })

  it('repairs a dangling parent left by a merge as a system transaction', () => {
    const store = new BoardStore()
    add(store, { ...rect('frame', 0), shapeStyle: 'frame', shapeType: 'frame' } as BoardElementRecord, rect('child', 1))
    const other = Replica.load(boardSchema, store.snapshot(), 99n)
    other.transact(person('user:other'), (tx) => tx.delete('frame'))
    store.transact('nest', (tx) => tx.put({ ...store.getElementRecord('child')!, parentId: 'frame' } as BoardElementRecord))
    expect(store.getReplica().get('child', 'parent')).toBe('frame')
    store.importChanges(other.exportChanges())
    expect(store.getElementRecord('child')?.parentId).toBeUndefined()
    expect(store.getReplica().get('child', 'parent')).toBeNull()
  })

  it('treats a put equal to the stored data as no change', () => {
    const store = new BoardStore()
    const page = store.getCurrentPageId()
    const element = createBoardElementRecord({
      element: { id: 'a', kind: 'rectangle', x: 0, y: 0, width: 10, height: 10, text: '', style: {} },
      index: 0,
      pageId: page,
    })
    store.transact('add', (tx) => tx.put(element))
    store.undo()
    store.redo()
    expect(store.transact('same', (tx) => tx.put(element))).toBeNull()
  })

  it('refuses changes of another document', () => {
    const store = new BoardStore()
    const other = new BoardStore()
    expect(() => store.importChanges(other.getReplica().exportChanges())).toThrow()
    store.markHistory()
    expect(() => store.importChanges(other.getReplica().exportChanges())).toThrow()
  })
})

describe('BoardStore repairs and read-back on the KDM', () => {
  const other = person('user:other')
  const add = (store: BoardStore, ...records: BoardElementRecord[]) => store.transact('add', (tx) => {
    for (const record of records) tx.put({ ...record, page_id: store.getCurrentPageId() })
  })
  const frame = { ...rect('frame', 0), shapeStyle: 'frame', shapeType: 'frame' } as BoardElementRecord
  const page2: BoardPageRecord = { record_type: 'page', id: 'page:2', name: 'Two', index: 1 }

  it('repairs a loaded document in a system transaction that is not an undo step', () => {
    const source = new BoardStore()
    add(source, frame, { ...rect('child', 1), parentId: 'frame' } as BoardElementRecord)
    source.transact('page', (tx) => tx.put(page2))
    const damaged = Replica.load(boardSchema, source.snapshot(), 7n)
    damaged.transact(other, (tx) => {
      tx.delete('frame')
      tx.listInsert('page:2', 'elements', 0, 'child')
    })
    expect(findBoardDuplicatePlacements(damaged)).toHaveLength(1)

    const store = new BoardStore(Replica.load(boardSchema, damaged.snapshot(), 8n))
    const replica = store.getReplica()
    expect(replica.get('child', 'parent')).toBeNull()
    expect(findBoardDuplicatePlacements(replica)).toEqual([])
    expect(replica.canUndo()).toBe(false)
    expect(store.getSnapshot().canUndo).toBe(false)

    const reloaded = new BoardStore()
    reloaded.load(Replica.load(boardSchema, damaged.snapshot(), 9n))
    expect(reloaded.getReplica().get('child', 'parent')).toBeNull()
    expect(findBoardDuplicatePlacements(reloaded.getReplica())).toEqual([])
    expect(reloaded.getSnapshot().canUndo).toBe(false)

    store.transact('move', (tx) => tx.put({ ...store.getElementRecord('child')!, x: 5 } as BoardElementRecord))
    expect(store.getSnapshot().canUndo).toBe(true)
    store.undo()
    expect(store.getElementRecord('child')).toMatchObject({ x: 0, page_id: source.getCurrentPageId() })
    expect(replica.list('page:2', 'elements')).toEqual([])
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('undo after an import that needed a repair reverts the user step, not the repair', () => {
    const store = new BoardStore()
    add(store, frame, rect('child', 1))
    const copy = Replica.load(boardSchema, store.snapshot(), 99n)
    copy.transact(other, (tx) => tx.delete('frame'))
    store.transact('nest', (tx) => tx.put({ ...store.getElementRecord('child')!, parentId: 'frame', x: 3 } as BoardElementRecord))
    store.importChanges(copy.exportChanges())
    expect(store.getReplica().get('child', 'parent')).toBeNull()
    store.undo()
    expect(store.getElementRecord('child')).toMatchObject({ x: 0 })
    expect(store.getReplica().get('child', 'parent')).toBeNull()
    store.undo()
    expect(store.getRecord('child')).toBeNull()
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('re-reads an element the replica no longer has instead of keeping a ghost', () => {
    const store = new BoardStore()
    add(store, rect('a', 0))
    store.getReplica().transact(other, (tx) => tx.delete('a'))
    store.transact('move', (tx) => tx.put({ ...store.getElementRecord('a')!, x: 9 } as BoardElementRecord))
    expect(store.getRecord('a')).toBeNull()
  })

  it('shows an element placed on a page the replica lacks where the replica put it', () => {
    const store = new BoardStore()
    const first = store.getCurrentPageId()
    add(store, rect('a', 0))
    store.transact('page', (tx) => tx.put(page2))
    store.getReplica().transact(other, (tx) => tx.delete('page:2'))
    store.transact('add', (tx) => tx.put({ ...rect('b', 0), page_id: 'page:2' }))
    expect(store.getElementRecord('b')).toMatchObject({ page_id: first, index: 1 })
    expect(store.getRecord('page:2')).toBeNull()
    expect(store.getPages().map((page) => page.id)).toEqual([first])
  })

  it('drops a binding whose connector the replica no longer has', () => {
    const store = new BoardStore()
    const connector = createBoardElementRecord({
      element: { id: 'c', kind: 'connector', start: { x: 0, y: 0 }, end: { x: 9, y: 9 } },
      index: 1,
      pageId: '',
    })
    add(store, rect('a', 0), connector)
    store.getReplica().transact(other, (tx) => tx.delete('c'))
    const binding: BoardBindingRecord = { record_type: 'binding', id: 'binding:c:end', binding_type: 'connector', from_id: 'c', to_id: 'a', terminal: 'end' }
    store.transact('bind', (tx) => tx.put(binding))
    expect(store.getRecord('binding:c:end')).toBeNull()
    expect(store.getRecord('c')).toBeNull()
  })
})
