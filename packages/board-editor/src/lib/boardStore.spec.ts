import { describe, expect, it, vi } from 'vitest'

import { BoardCommandRegistry } from './boardCommands'
import {
  createBoardElementRecord,
  createBoardRecordsFromElements,
} from './boardRecords'
import {
  BoardStore,
  reverseBoardRecordDiff,
  squashBoardRecordDiffs,
} from './boardStore'

describe('BoardStore', () => {
  it('stores normalized records and records one reversible command diff', () => {
    const store = new BoardStore()
    const commands = new BoardCommandRegistry(store)
    const listener = vi.fn()
    store.subscribe(listener)

    const diff = commands.execute({
      type: 'element.create',
      elements: [{
        id: 'rectangle-1',
        kind: 'rectangle',
        x: 10,
        y: 20,
        width: 120,
        height: 80,
      }],
    })

    expect(diff).toMatchObject({
      added: [expect.objectContaining({
        id: 'rectangle-1',
        record_type: 'element',
      })],
    })
    expect(store.getCurrentPageElements()).toEqual([
      expect.objectContaining({ id: 'rectangle-1', kind: 'rectangle' }),
    ])
    expect(store.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false })
    expect(listener).toHaveBeenCalledTimes(1)

    store.undo()
    expect(store.getCurrentPageElements()).toEqual([])
    expect(store.getSnapshot()).toMatchObject({ canUndo: false, canRedo: true })

    store.redo()
    expect(store.getCurrentPageElements()).toHaveLength(1)
  })

  it('streams an element update and commits the whole gesture as one history entry', () => {
    const store = new BoardStore(createBoardRecordsFromElements([{
      id: 'rectangle-1',
      kind: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
    }]))
    const commands = new BoardCommandRegistry(store)
    const session = commands.beginElementUpdate('Move element')

    session.update([{
      id: 'rectangle-1',
      kind: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 80,
    }])
    session.update([{
      id: 'rectangle-1',
      kind: 'rectangle',
      x: 30,
      y: 40,
      width: 100,
      height: 80,
    }])
    const diff = session.commit()

    expect(diff?.updated).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ x: 0, y: 0 }),
        after: expect.objectContaining({ x: 30, y: 40 }),
      }),
    ])
    store.undo()
    expect(store.getCurrentPageElements()).toEqual([
      expect.objectContaining({ x: 0, y: 0 }),
    ])
  })

  it('cancels an interactive transaction without creating history', () => {
    const store = new BoardStore(createBoardRecordsFromElements([{
      id: 'text-1',
      kind: 'text',
      x: 10,
      y: 20,
      text: 'Draft',
    }]))
    const commands = new BoardCommandRegistry(store)
    const session = commands.beginElementUpdate('Move element')
    session.update([{
      id: 'text-1',
      kind: 'text',
      x: 90,
      y: 120,
      text: 'Draft',
    }])
    session.cancel()

    expect(store.getCurrentPageElements()).toEqual([
      expect.objectContaining({ x: 10, y: 20 }),
    ])
    expect(store.getSnapshot().canUndo).toBe(false)
  })

  it('reverses and squashes typed record diffs for future Agent previews', () => {
    const original = createBoardElementRecord({
      element: {
        id: 'text-1',
        kind: 'text',
        x: 0,
        y: 0,
        text: 'One',
      },
      index: 0,
      pageId: 'page:main',
    })
    const middle = { ...original, text: 'Two' }
    const final = { ...original, text: 'Three' }
    const first = {
      added: [],
      updated: [{ before: original, after: middle }],
      removed: [],
    }
    const second = {
      added: [],
      updated: [{ before: middle, after: final }],
      removed: [],
    }

    expect(squashBoardRecordDiffs([first, second])).toEqual({
      added: [],
      updated: [{ before: original, after: final }],
      removed: [],
    })
    expect(reverseBoardRecordDiff(first)).toEqual({
      added: [],
      updated: [{ before: middle, after: original }],
      removed: [],
    })
  })

  it('squashes or bails multiple commands back to a stable history mark', () => {
    const store = new BoardStore(createBoardRecordsFromElements([{
      id: 'text-1',
      kind: 'text',
      x: 0,
      y: 0,
      text: 'One',
    }]))
    const commands = new BoardCommandRegistry(store)
    const mark = store.markHistory()

    commands.execute({
      type: 'element.update',
      elements: [{ id: 'text-1', kind: 'text', x: 10, y: 0, text: 'Two' }],
    })
    commands.execute({
      type: 'element.update',
      elements: [{ id: 'text-1', kind: 'text', x: 20, y: 0, text: 'Three' }],
    })
    store.squashToMark(mark, 'Agent turn')
    store.undo()
    expect(store.getCurrentPageElements()).toEqual([
      expect.objectContaining({ x: 0, text: 'One' }),
    ])

    store.redo()
    const bailMark = store.markHistory()
    commands.execute({
      type: 'element.update',
      elements: [{ id: 'text-1', kind: 'text', x: 50, y: 0, text: 'Draft' }],
    })
    store.bailToMark(bailMark)
    expect(store.getCurrentPageElements()).toEqual([
      expect.objectContaining({ x: 20, text: 'Three' }),
    ])
  })
})
