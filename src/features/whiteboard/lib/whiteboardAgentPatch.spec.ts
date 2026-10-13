import { describe, expect, it } from 'vitest'

import type { AgentWhiteboardPatch } from '@/types/whiteboardAgent'

import { BoardCommandRegistry } from './boardCommands'
import { createBoardRecordsFromElements } from './boardRecords'
import { BoardStore } from './boardStore'
import {
  AGENT_RENAMED_ID_LIMIT,
  buildWhiteboardAgentPatchPreview,
  parseAgentWhiteboardPatch,
  rememberAgentRenamedIds,
  translateAgentWhiteboardPatch,
} from './whiteboardAgentPatch'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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
      expect.objectContaining({ id: expect.stringMatching(UUID_V7), shapeStyle: 'sticky', text: 'Next' }),
    ])
    const threeId = preview.added[0].id
    expect(preview.updated).toEqual([
      expect.objectContaining({ id: 'one', shapeStyle: 'mind-node', text: 'Start' }),
    ])
    expect(preview.deleted).toEqual([expect.objectContaining({ id: 'two' })])

    const commands = new BoardCommandRegistry(store)
    commands.applyAgentDiff(patch.summary, diff)
    expect(store.getCurrentPageElements().map((element) => element.id)).toEqual([threeId, 'one'])
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
    const addedId = (text: string) => {
      const record = diff.added.find((item) => item.record_type === 'element' && 'text' in item && item.text === text)
      expect(record?.id).toMatch(UUID_V7)
      return record!.id
    }
    const rootId = addedId('Root')
    const branchId = addedId('Branch')
    const connectorId = diff.added.find((record) => (
      record.record_type === 'element' && record.kind === 'connector'
    ))!.id
    expect(connectorId).toMatch(UUID_V7)
    expect(new Set([rootId, branchId, connectorId]).size).toBe(3)
    expect(diff.added).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record_type: 'element',
        id: connectorId,
        kind: 'connector',
        connectorRole: 'mind-map-branch',
        connectorType: 'curved',
        endArrowhead: 'none',
        mindMapBranchAxis: 'horizontal',
        start: expect.any(Object),
        end: expect.any(Object),
      }),
      expect.objectContaining({
        record_type: 'binding',
        id: `binding:${connectorId}:start`,
        from_id: connectorId,
        to_id: rootId,
        to_anchor: { x: 1, y: 0.5 },
      }),
      expect.objectContaining({
        record_type: 'binding',
        id: `binding:${connectorId}:end`,
        from_id: connectorId,
        to_id: branchId,
        to_anchor: { x: 0, y: 0.5 },
      }),
    ]))
    expect(JSON.stringify(diff)).not.toMatch(/"(root|branch|root-branch)"|binding:root-branch/)

    new BoardCommandRegistry(store).applyAgentDiff(patch.summary, diff)
    expect(store.getCurrentPageElements().find((element) => element.id === connectorId))
      .toMatchObject({ kind: 'connector' })
  })

  it('gives agent-created elements new ids and rewrites every reference to them', () => {
    const store = new BoardStore(createBoardRecordsFromElements([
      { id: 'existing', kind: 'rectangle', x: 0, y: 0, width: 100, height: 60, text: 'Existing' },
    ]))
    const patch = parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Connect a new note',
      operations: [
        {
          op: 'element.create',
          element: { id: 'n1', kind: 'frame', bounds: { x: 200, y: -40, width: 400, height: 300 } },
        },
        {
          op: 'element.create',
          element: { id: 'n2', kind: 'sticky', text: 'New', parent_id: 'n1', bounds: { x: 240, y: 0, width: 120, height: 90 } },
        },
        { op: 'element.reorder', element_id: 'n2', after_element_id: 'existing' },
        { op: 'connector.create', connector: { id: 'c1', from_id: 'existing', to_id: 'n2' } },
        { op: 'element.update', element_id: 'existing', changes: { parent_id: 'n1' } },
      ],
    })

    const diff = translateAgentWhiteboardPatch({ patch, store })
    const elements = diff.added.filter((record) => record.record_type === 'element')
    const frame = elements.find((record) => record.kind === 'rectangle' && record.shapeStyle === 'frame')!
    const note = elements.find((record) => record.kind === 'rectangle' && record.shapeStyle === 'sticky')!
    const connector = elements.find((record) => record.kind === 'connector')!
    for (const record of [frame, note, connector]) expect(record.id).toMatch(UUID_V7)
    expect(new Set([frame.id, note.id, connector.id]).size).toBe(3)
    expect(note.parentId).toBe(frame.id)
    expect(diff.updated).toEqual([expect.objectContaining({
      before: expect.objectContaining({ id: 'existing', parentId: undefined }),
      after: expect.objectContaining({ id: 'existing', parentId: frame.id }),
    })])
    expect(diff.added.filter((record) => record.record_type === 'binding')).toEqual([
      expect.objectContaining({ id: `binding:${connector.id}:end`, from_id: connector.id, to_id: note.id }),
      expect.objectContaining({ id: `binding:${connector.id}:start`, from_id: connector.id, to_id: 'existing' }),
    ])
    expect(JSON.stringify(diff)).not.toMatch(/"(n1|n2|c1)"|binding:c1/)

    const createdIds = new Map<string, string>()
    const first = translateAgentWhiteboardPatch({ createdIds, patch, store })
    expect(translateAgentWhiteboardPatch({ createdIds, patch, store })).toEqual(first)
    expect([...createdIds.keys()].sort()).toEqual(['c1', 'n1', 'n2'])

    new BoardCommandRegistry(store).applyAgentDiff(patch.summary, diff)
    expect(store.getCurrentPageElements().map((element) => element.id))
      .toEqual(['existing', note.id, frame.id, connector.id])
  })

  it('rejects agent-created ids that already exist, before remapping them', () => {
    const store = new BoardStore(createBoardRecordsFromElements([
      { id: 'n2', kind: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
    ]))
    const patch = parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Reuse an id',
      operations: [{
        op: 'element.create',
        element: { id: 'n2', kind: 'shape', bounds: { x: 0, y: 0, width: 80, height: 40 } },
      }],
    })
    expect(() => translateAgentWhiteboardPatch({ patch, store }))
      .toThrow('AI Board patch reuses an existing id: n2')
  })

  it('resolves names from accepted patches in later patches and rejects creating them again', () => {
    const store = new BoardStore(createBoardRecordsFromElements([
      { id: 'existing', kind: 'rectangle', x: 0, y: 0, width: 100, height: 60, text: 'Existing' },
    ]))
    const commands = new BoardCommandRegistry(store)
    const first = parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Add a frame and a note',
      operations: [
        {
          op: 'element.create',
          element: { id: 'n1', kind: 'frame', bounds: { x: 200, y: -40, width: 400, height: 300 } },
        },
        {
          op: 'element.create',
          element: { id: 'n2', kind: 'sticky', text: 'Note', bounds: { x: 240, y: 0, width: 120, height: 90 } },
        },
      ],
    })
    const createdIds = new Map<string, string>()
    const firstDiff = translateAgentWhiteboardPatch({ createdIds, patch: first, store })
    commands.applyAgentDiff(first.summary, firstDiff)
    const renamedIds = new Map<string, string>()
    rememberAgentRenamedIds({ createdIds, diff: firstDiff, renamedIds })
    const frameId = createdIds.get('n1')!
    const noteId = createdIds.get('n2')!
    expect(frameId).toMatch(UUID_V7)
    expect([...renamedIds]).toEqual([['n1', frameId], ['n2', noteId]])

    const followUp = parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Edit the note',
      operations: [
        { op: 'element.update', element_id: 'n2', changes: { text: 'Edited', parent_id: 'n1' } },
        { op: 'element.reorder', element_id: 'existing', after_element_id: 'n2' },
        { op: 'connector.create', connector: { id: 'c1', from_id: 'existing', to_id: 'n2' } },
      ],
    })
    const diff = translateAgentWhiteboardPatch({ patch: followUp, renamedIds, store })
    expect(diff.updated).toEqual(expect.arrayContaining([expect.objectContaining({
      after: expect.objectContaining({ id: noteId, parentId: frameId, text: 'Edited' }),
    })]))
    expect(diff.added.filter((record) => record.record_type === 'binding')).toEqual(
      expect.arrayContaining([expect.objectContaining({ to_id: noteId })]),
    )
    expect(JSON.stringify(diff)).not.toMatch(/"(n1|n2|c1)"/)

    const deletion = parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Remove the note',
      operations: [{ op: 'element.delete', element_id: 'n2' }],
    })
    expect(translateAgentWhiteboardPatch({ patch: deletion, renamedIds, store }).removed)
      .toEqual([expect.objectContaining({ id: noteId })])

    const reuse = parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Create n2 again',
      operations: [{
        op: 'element.create',
        element: { id: 'n2', kind: 'shape', bounds: { x: 0, y: 0, width: 80, height: 40 } },
      }],
    })
    expect(() => translateAgentWhiteboardPatch({ patch: reuse, renamedIds, store }))
      .toThrow('AI Board patch reuses an existing id: n2')
    const reusedConnector = parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Connect with an old name',
      operations: [{ op: 'connector.create', connector: { id: 'n1', from_id: 'existing', to_id: 'n2' } }],
    })
    expect(() => translateAgentWhiteboardPatch({ patch: reusedConnector, renamedIds, store }))
      .toThrow('AI Board patch reuses an existing id: n1')
  })

  it('keeps only the most recent accepted names', () => {
    const renamedIds = new Map<string, string>()
    const createdIds = new Map<string, string>()
    const diff = { added: [], removed: [], updated: [] } as Parameters<typeof rememberAgentRenamedIds>[0]['diff']
    for (let index = 0; index < AGENT_RENAMED_ID_LIMIT + 5; index += 1) {
      createdIds.set(`n${index}`, `id-${index}`)
      diff.added.push({ id: `id-${index}`, record_type: 'element' } as (typeof diff.added)[number])
    }
    createdIds.set('dropped', 'never-added')
    rememberAgentRenamedIds({ createdIds, diff, renamedIds })
    expect(renamedIds.size).toBe(AGENT_RENAMED_ID_LIMIT)
    expect(renamedIds.has('n4')).toBe(false)
    expect(renamedIds.get('n5')).toBe('id-5')
    expect(renamedIds.has('dropped')).toBe(false)
  })

  it('remaps source reference ids that name elements created in the same patch', () => {
    const store = new BoardStore(createBoardRecordsFromElements([
      { id: 'existing', kind: 'rectangle', x: 0, y: 0, width: 100, height: 60, text: 'Existing' },
    ]))
    const patch = parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Cite a new note',
      operations: [
        {
          op: 'element.create',
          element: { id: 'n1', kind: 'sticky', text: 'Source', bounds: { x: 200, y: 0, width: 120, height: 90 } },
        },
        {
          op: 'element.create',
          element: {
            id: 'n2',
            kind: 'sticky',
            text: 'Derived',
            source_ref_ids: ['n1', 'doc-1'],
            bounds: { x: 400, y: 0, width: 120, height: 90 },
          },
        },
        { op: 'element.update', element_id: 'existing', changes: { source_ref_ids: ['n2'] } },
      ],
    })
    const createdIds = new Map<string, string>()
    const diff = translateAgentWhiteboardPatch({ createdIds, patch, store })
    const derived = diff.added.find((record) => record.id === createdIds.get('n2'))
    expect(derived).toEqual(expect.objectContaining({
      sourceRefIds: [createdIds.get('n1'), 'doc-1'],
    }))
    expect(diff.updated).toEqual([expect.objectContaining({
      after: expect.objectContaining({ id: 'existing', sourceRefIds: [createdIds.get('n2')] }),
    })])
  })

  it('sanitizes and previews transform, style, layout, and grouping actions', () => {
    const store = new BoardStore(createBoardRecordsFromElements([
      { id: 'one', kind: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
      { id: 'two', kind: 'rectangle', x: 180, y: 80, width: 100, height: 60 },
      { id: 'three', kind: 'rectangle', x: 360, y: 160, width: 100, height: 60 },
    ]))
    const patch = parseAgentWhiteboardPatch({
      type: 'whiteboard.patch',
      schema_version: 1,
      summary: 'Arrange a framed row',
      operations: [
        { op: 'element.move', element_ids: ['one'], delta: { x: 20, y: 30 } },
        { op: 'element.rotate', element_ids: ['two'], degrees: 90 },
        { op: 'element.resize', element_ids: ['three'], scale_x: 1.5, scale_y: 1.25 },
        {
          op: 'element.style',
          element_ids: ['one', 'two', 'three'],
          style: { fill_color: 'purple', dash_style: 'dashed' },
        },
        {
          op: 'layout.stack',
          element_ids: ['one', 'two', 'three'],
          direction: 'horizontal',
          gap: 24,
        },
        {
          op: 'layout.align',
          element_ids: ['one', 'two', 'three'],
          alignment: 'center-vertical',
        },
        {
          op: 'element.group',
          container_id: 'frame',
          container_kind: 'frame',
          element_ids: ['one', 'two', 'three'],
        },
      ],
    })

    const diff = translateAgentWhiteboardPatch({ patch, store })
    const preview = buildWhiteboardAgentPatchPreview(diff)
    expect(preview.added).toEqual([
      expect.objectContaining({ id: expect.stringMatching(UUID_V7), shapeStyle: 'frame' }),
    ])
    const frameId = preview.added[0].id
    expect(preview.updated).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'one', parentId: frameId, style: expect.objectContaining({ fillColor: 'purple' }) }),
      expect.objectContaining({ id: 'two', parentId: frameId, rotation: 90 }),
      expect.objectContaining({ id: 'three', parentId: frameId, width: 150 }),
    ]))
  })
})
