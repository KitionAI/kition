import { describe, expect, it } from 'vitest'

import { BoardCommandRegistry } from './boardCommands'
import { createBoardRecordsFromElements, type BoardElementRecord } from './boardRecords'
import { BoardStore } from './boardStore'
import type { WhiteboardElement } from './whiteboardTypes'

const ELEMENTS: WhiteboardElement[] = [
  { id: 'one', kind: 'rectangle', x: 0, y: 0, width: 100, height: 80 },
  { id: 'two', kind: 'rectangle', x: 20, y: 20, width: 100, height: 80 },
  { id: 'three', kind: 'rectangle', x: 40, y: 40, width: 100, height: 80 },
  { id: 'four', kind: 'rectangle', x: 60, y: 60, width: 100, height: 80 },
]

describe('BoardCommandRegistry element.reorder', () => {
  it('moves a multi-selection as a stable block and undoes in one step', () => {
    const store = new BoardStore(createBoardRecordsFromElements(ELEMENTS))
    const commands = new BoardCommandRegistry(store)

    commands.execute({
      type: 'element.reorder',
      elementIds: ['two', 'three'],
      placement: 'front',
    })

    expect(store.getCurrentPageElements().map((element) => element.id)).toEqual([
      'one',
      'four',
      'two',
      'three',
    ])
    store.undo()
    expect(store.getCurrentPageElements().map((element) => element.id)).toEqual([
      'one',
      'two',
      'three',
      'four',
    ])
  })

  it('moves selected layers one step forward or backward', () => {
    const store = new BoardStore(createBoardRecordsFromElements(ELEMENTS))
    const commands = new BoardCommandRegistry(store)

    commands.execute({
      type: 'element.reorder',
      elementIds: ['two', 'three'],
      placement: 'forward',
    })
    expect(store.getCurrentPageElements().map((element) => element.id)).toEqual([
      'one',
      'four',
      'two',
      'three',
    ])

    commands.execute({
      type: 'element.reorder',
      elementIds: ['two', 'three'],
      placement: 'backward',
    })
    expect(store.getCurrentPageElements().map((element) => element.id)).toEqual([
      'one',
      'two',
      'three',
      'four',
    ])
  })
})

describe('BoardCommandRegistry hierarchy commands', () => {
  it('groups elements behind their children and undoes atomically', () => {
    const store = new BoardStore(createBoardRecordsFromElements(ELEMENTS.slice(0, 3)))
    const commands = new BoardCommandRegistry(store)

    commands.execute({
      type: 'element.group',
      containerId: 'group-1',
      containerKind: 'group',
      elementIds: ['one', 'two'],
    })

    expect(store.getCurrentPageElements()).toEqual([
      expect.objectContaining({ id: 'group-1', shapeStyle: 'group' }),
      expect.objectContaining({ id: 'one', parentId: 'group-1' }),
      expect.objectContaining({ id: 'two', parentId: 'group-1' }),
      expect.objectContaining({ id: 'three', parentId: undefined }),
    ])
    store.undo()
    expect(store.getCurrentPageElements()).toEqual(ELEMENTS.slice(0, 3).map((element) => (
      expect.objectContaining({ id: element.id, parentId: undefined })
    )))
  })

  it('creates a padded frame and restores direct children when ungrouped', () => {
    const store = new BoardStore(createBoardRecordsFromElements(ELEMENTS.slice(0, 2)))
    const commands = new BoardCommandRegistry(store)
    commands.execute({
      type: 'element.group',
      containerId: 'frame-1',
      containerKind: 'frame',
      elementIds: ['one', 'two'],
    })

    expect(store.getCurrentPageElements()[0]).toMatchObject({
      id: 'frame-1',
      shapeStyle: 'frame',
      shapeType: 'frame',
      x: -32,
      y: -52,
      width: 184,
      height: 184,
    })

    commands.execute({ type: 'element.ungroup', containerIds: ['frame-1'] })
    expect(store.getCurrentPageElements()).toEqual([
      expect.objectContaining({ id: 'one', parentId: undefined }),
      expect.objectContaining({ id: 'two', parentId: undefined }),
    ])
  })

  it('deletes descendants and their bindings with the selected container', () => {
    const store = new BoardStore(createBoardRecordsFromElements(ELEMENTS.slice(0, 2)))
    const commands = new BoardCommandRegistry(store)
    commands.execute({
      type: 'element.group',
      containerId: 'group-1',
      containerKind: 'group',
      elementIds: ['one', 'two'],
    })

    commands.execute({ type: 'element.delete', elementIds: ['group-1'] })
    expect(store.getCurrentPageElements()).toEqual([])

    store.undo()
    expect(store.getCurrentPageElements().map((element) => element.id)).toEqual([
      'group-1',
      'one',
      'two',
    ])
  })
})

describe('BoardCommandRegistry page commands', () => {
  it('creates, renames, reorders, duplicates, deletes, and undoes pages', () => {
    const store = new BoardStore(createBoardRecordsFromElements(ELEMENTS.slice(0, 2), 'Main'))
    const commands = new BoardCommandRegistry(store)

    commands.execute({ type: 'page.create', pageId: 'page:two', name: 'Second' })
    expect(store.getCurrentPageId()).toBe('page:two')
    expect(store.getPages()).toEqual([
      expect.objectContaining({ id: 'page:main', index: 0 }),
      expect.objectContaining({ id: 'page:two', index: 1 }),
    ])

    commands.execute({ type: 'page.rename', pageId: 'page:two', name: 'Ideas' })
    commands.execute({ type: 'page.reorder', pageId: 'page:two', placement: 'previous' })
    expect(store.getPages()[0]).toMatchObject({ id: 'page:two', name: 'Ideas' })

    commands.execute({
      type: 'page.duplicate',
      sourcePageId: 'page:main',
      pageId: 'page:copy',
      name: 'Main copy',
    })
    expect(store.getCurrentPageElements()).toHaveLength(2)
    expect(store.getCurrentPageElements().map((element) => element.id))
      .not.toEqual(['one', 'two'])

    commands.execute({ type: 'page.delete', pageId: 'page:copy' })
    expect(store.getPages()).toHaveLength(2)
    store.undo()
    expect(store.getPages()).toHaveLength(3)
  })
})

describe('BoardCommandRegistry page activation', () => {
  it('switches pages as view state, not as an undo step', () => {
    const store = new BoardStore(createBoardRecordsFromElements(ELEMENTS.slice(0, 1), 'Main'))
    const commands = new BoardCommandRegistry(store)
    commands.execute({ type: 'page.create', pageId: 'page:two', name: 'Second', activate: false })
    const version = store.getReplica().version()

    expect(commands.execute({ type: 'page.activate', pageId: 'page:two' })).not.toBeNull()
    expect(store.getCurrentPageId()).toBe('page:two')
    expect(store.getReplica().version().equals(version)).toBe(true)
    expect(commands.execute({ type: 'page.activate', pageId: 'page:two' })).toBeNull()

    store.undo()
    expect(store.getRecord('page:two')).toBeNull()
    expect(store.getCurrentPageId()).toBe('page:main')
  })
})

describe('BoardCommandRegistry page deletion', () => {
  it('shows the first page after deleting the active page', () => {
    const store = new BoardStore(createBoardRecordsFromElements(ELEMENTS.slice(0, 1), 'Main'))
    const commands = new BoardCommandRegistry(store)
    commands.execute({ type: 'page.create', pageId: 'page:two', name: 'Second', activate: false })
    commands.execute({ type: 'page.create', pageId: 'page:three', name: 'Third', activate: false })
    commands.execute({ type: 'page.activate', pageId: 'page:two' })

    commands.execute({ type: 'page.delete', pageId: 'page:two' })

    expect(store.getCurrentPageId()).toBe('page:main')
  })
})

describe('BoardCommandRegistry applyAgentDiff', () => {
  it('applies an agent update when only other fields changed since the preview', () => {
    const store = new BoardStore(createBoardRecordsFromElements(ELEMENTS.slice(0, 1)))
    const commands = new BoardCommandRegistry(store)
    const before = store.getElementRecord('one')!
    commands.execute({
      type: 'element.update',
      elements: [{ ...ELEMENTS[0], style: { fillColor: 'red' } }],
    })

    commands.applyAgentDiff('Agent move', {
      added: [],
      updated: [{ before, after: { ...before, x: 500 } as BoardElementRecord }],
      removed: [],
    })
    expect(store.getElementRecord('one')).toMatchObject({ x: 500, style: { fillColor: 'red' } })
  })

  it('refuses an agent update when a field it changed has changed since the preview', () => {
    const store = new BoardStore(createBoardRecordsFromElements(ELEMENTS.slice(0, 1)))
    const commands = new BoardCommandRegistry(store)
    const before = store.getElementRecord('one')!
    commands.execute({ type: 'element.update', elements: [{ ...ELEMENTS[0], x: 42 } as WhiteboardElement] })

    expect(() => commands.applyAgentDiff('Agent move', {
      added: [],
      updated: [{ before, after: { ...before, x: 500 } as BoardElementRecord }],
      removed: [],
    })).toThrow(/AI preview/)
    expect(store.getElementRecord('one')).toMatchObject({ x: 42 })
  })

  it('checks style keys one by one', () => {
    const store = new BoardStore(createBoardRecordsFromElements([
      { ...ELEMENTS[0], style: { fillColor: 'blue' } },
    ]))
    const commands = new BoardCommandRegistry(store)
    const before = store.getElementRecord('one')!
    commands.execute({
      type: 'element.update',
      elements: [{ ...ELEMENTS[0], style: { fillColor: 'blue', strokeColor: 'green' } }],
    })

    commands.applyAgentDiff('Agent recolour', {
      added: [],
      updated: [{ before, after: { ...before, style: { fillColor: 'yellow' } } }],
      removed: [],
    })
    expect(store.getElementRecord('one')?.style).toEqual({ fillColor: 'yellow', strokeColor: 'green' })
  })
})
