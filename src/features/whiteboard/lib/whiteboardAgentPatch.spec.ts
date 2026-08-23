import { describe, expect, it } from 'vitest'

import type { AgentWhiteboardPatch } from '@/types/whiteboardAgent'

import { BoardCommandRegistry } from './boardCommands'
import { createBoardRecordsFromElements } from './boardRecords'
import { BoardStore } from './boardStore'
import {
  buildWhiteboardAgentPatchPreview,
  parseAgentWhiteboardPatch,
  translateAgentWhiteboardPatch,
} from './whiteboardAgentPatch'

describe('AI Board patches', () => {
  it('translates create, update, delete, and reorder operations into one reversible diff', () => {
    const store = new BoardStore(createBoardRecordsFromElements([
      { id: 'one', kind: 'rectangle', x: 0, y: 0, width: 100, height: 60, text: 'One' },
      { id: 'two', kind: 'rectangle', x: 160, y: 0, width: 100, height: 60, text: 'Two' },
    ]))
    const patch = parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Build a small mind map',
      operations: [
        {
          op: 'element.update',
          element_id: 'one',
          changes: { kind: 'mind_node', text: 'Start', bounds: { x: 20, y: 30, width: 140, height: 70 } },
        },
        { op: 'element.delete', element_id: 'two' },
        {
          op: 'element.create',
          element: { id: 'three', kind: 'sticky', text: 'Next', bounds: { x: 240, y: 30, width: 120, height: 90 } },
        },
        { op: 'element.reorder', element_id: 'three', after_element_id: null },
      ],
    })
    const diff = translateAgentWhiteboardPatch({ patch, store })
    const preview = buildWhiteboardAgentPatchPreview(diff)

    expect(preview.added).toEqual([
      expect.objectContaining({ id: 'three', shapeStyle: 'sticky', text: 'Next' }),
    ])
    expect(preview.updated).toEqual([
      expect.objectContaining({ id: 'one', shapeStyle: 'mind-node', text: 'Start' }),
    ])
    expect(preview.deleted).toEqual([expect.objectContaining({ id: 'two' })])

    const commands = new BoardCommandRegistry(store)
    commands.applyAgentDiff(patch.summary, diff)
    expect(store.getCurrentPageElements().map((element) => element.id)).toEqual(['three', 'one'])
    expect(store.getSnapshot().canUndo).toBe(true)

    store.undo()
    expect(store.getCurrentPageElements().map((element) => element.id)).toEqual(['one', 'two'])
  })

  it('rejects invalid ids, locked targets, stale previews, and oversized patches', () => {
    const store = new BoardStore(createBoardRecordsFromElements([
      { id: 'locked', kind: 'rectangle', x: 0, y: 0, width: 100, height: 60, locked: true },
    ]))
    expect(() => parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Invalid',
      operations: [{
        op: 'element.create',
        element: { id: '../bad', kind: 'shape', bounds: { x: 0, y: 0, width: 80, height: 40 } },
      }],
    })).toThrow('Invalid AI Board patch')

    const lockedPatch: AgentWhiteboardPatch = {
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Move locked',
      operations: [{
        op: 'element.update',
        element_id: 'locked',
        changes: { bounds: { x: 10, y: 10, width: 100, height: 60 } },
      }],
    }
    expect(() => translateAgentWhiteboardPatch({ patch: lockedPatch, store }))
      .toThrow('locked element')

    expect(() => parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Too large',
      operations: [{
        op: 'element.create',
        element: { id: 'huge', kind: 'shape', bounds: { x: 0, y: 0, width: 50_000, height: 50_000 } },
      }],
    })).toThrow('generated area is too large')
  })
})
