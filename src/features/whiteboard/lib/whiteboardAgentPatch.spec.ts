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

  it('creates bound connectors between AI mind-map nodes', () => {
    const store = new BoardStore()
    const patch = parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Build a connected mind map',
      operations: [
        {
          op: 'element.create',
          element: {
            id: 'root',
            kind: 'mind_node',
            bounds: { x: 100, y: 100, width: 160, height: 80 },
            text: 'Root',
          },
        },
        {
          op: 'element.create',
          element: {
            id: 'branch',
            kind: 'mind_node',
            bounds: { x: 400, y: 220, width: 160, height: 80 },
            text: 'Branch',
          },
        },
        {
          op: 'connector.create',
          connector: { id: 'root-branch', from_id: 'root', to_id: 'branch' },
        },
      ],
    })

    const diff = translateAgentWhiteboardPatch({ patch, store })
    expect(diff.added).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record_type: 'element',
        id: 'root-branch',
        kind: 'connector',
        start: expect.any(Object),
        end: expect.any(Object),
      }),
      expect.objectContaining({
        record_type: 'binding',
        id: 'binding:root-branch:start',
        from_id: 'root-branch',
        to_id: 'root',
      }),
      expect.objectContaining({
        record_type: 'binding',
        id: 'binding:root-branch:end',
        from_id: 'root-branch',
        to_id: 'branch',
      }),
    ]))

    new BoardCommandRegistry(store).applyAgentDiff(patch.summary, diff)
    expect(store.getCurrentPageElements().find((element) => element.id === 'root-branch'))
      .toMatchObject({ kind: 'connector' })
  })
})
