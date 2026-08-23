import { describe, expect, it } from 'vitest'

import { BoardCommandRegistry } from './boardCommands'
import { createBoardRecordsFromElements } from './boardRecords'
import { BoardStore } from './boardStore'
import { buildWhiteboardAgentContext } from './whiteboardAgentContext'

describe('buildWhiteboardAgentContext', () => {
  it('builds explicit selection, viewport, and whole-board scopes', () => {
    const store = new BoardStore(createBoardRecordsFromElements([
      { id: 'visible-1', kind: 'rectangle', x: 20, y: 20, width: 80, height: 60, text: 'Visible' },
      { id: 'offscreen-1', kind: 'rectangle', x: 2000, y: 2000, width: 80, height: 60, text: 'Far away' },
    ]))
    const common = {
      canvasSize: { x: 800, y: 600 },
      path: 'Boards/Planning.kiboard',
      selectedElementIds: ['offscreen-1'],
      store,
      title: 'Planning',
      viewport: { x: 0, y: 0, zoom: 1 },
    }

    expect(buildWhiteboardAgentContext({ ...common, scope: 'selection' })?.elements)
      .toEqual([expect.objectContaining({ id: 'offscreen-1' })])
    expect(buildWhiteboardAgentContext({ ...common, scope: 'viewport' })?.elements)
      .toEqual([expect.objectContaining({ id: 'visible-1' })])
    expect(buildWhiteboardAgentContext({ ...common, scope: 'board' })?.elements)
      .toHaveLength(2)
  })

  it('keeps large boards compact and summarizes omitted elements as clusters', () => {
    const store = new BoardStore(createBoardRecordsFromElements(
      Array.from({ length: 560 }, (_, index) => ({
        id: `node-${index + 1}`,
        kind: 'rectangle' as const,
        x: index * 20,
        y: 0,
        width: 12,
        height: 12,
      })),
    ))
    const context = buildWhiteboardAgentContext({
      canvasSize: { x: 800, y: 600 },
      path: 'Boards/Large.kiboard',
      scope: 'board',
      selectedElementIds: [],
      store,
      title: 'Large',
      viewport: { x: 0, y: 0, zoom: 1 },
    })

    expect(context?.elements).toHaveLength(500)
    expect(context?.clusters).toEqual([
      expect.objectContaining({ element_count: 60 }),
    ])
  })

  it('rejects absolute paths and reports only recent user operations', () => {
    const store = new BoardStore()
    const commands = new BoardCommandRegistry(store)
    commands.execute({
      type: 'element.create',
      elements: [{ id: 'user-node', kind: 'rectangle', x: 0, y: 0, width: 80, height: 50 }],
    })
    const record = store.getElementRecord('user-node')!
    if (record.kind !== 'rectangle') throw new Error('Expected rectangle record')
    commands.applyAgentDiff('AI organize', {
      added: [],
      updated: [{ before: record, after: { ...record, x: 100 } }],
      removed: [],
    })

    expect(buildWhiteboardAgentContext({
      canvasSize: { x: 800, y: 600 },
      path: 'Boards/History.kiboard',
      scope: 'board',
      selectedElementIds: [],
      store,
      title: 'History',
      viewport: { x: 0, y: 0, zoom: 1 },
    })?.recent_operations).toEqual(['Create element'])

    expect(buildWhiteboardAgentContext({
      canvasSize: { x: 800, y: 600 },
      path: '/private/workspace/History.kiboard',
      scope: 'board',
      selectedElementIds: [],
      store,
      title: 'History',
      viewport: { x: 0, y: 0, zoom: 1 },
    })).toBeNull()
  })
})
