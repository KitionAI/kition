import { describe, expect, it } from 'vitest'
import { person, Replica } from '@/lib/kdm'
import { BoardStore } from './boardStore'
import { createBoardElementRecord, type BoardElementRecord } from './boardRecords'
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
