import { describe, expect, it } from 'vitest'

import { parseBoardRecords } from './boardSerialization'
import { createBoardRecordsFromElements, type BoardRecord } from './boardRecords'

/** Records as they arrive from untrusted JSON (the clipboard payload). */
const throughJson = (records: readonly BoardRecord[]) => (
  parseBoardRecords(JSON.parse(JSON.stringify(records)) as unknown[])
)

describe('Board record parsing', () => {
  it('always yields a page and a meta record', () => {
    expect(parseBoardRecords([])).toEqual(expect.arrayContaining([
      expect.objectContaining({ record_type: 'meta' }),
      expect.objectContaining({ record_type: 'page' }),
    ]))
    expect(parseBoardRecords([null, 'x', { record_type: 'unknown' }]).every((record) => (
      record.record_type === 'meta' || record.record_type === 'page'
    ))).toBe(true)
  })

  it('keeps semantic AI node labels and portable source references', () => {
    const records = throughJson(createBoardRecordsFromElements([{
        id: 'mind-1',
        kind: 'rectangle',
        x: 20,
        y: 30,
        width: 160,
        height: 80,
        mindMapBranchSide: 'right',
        mindMapCollapsed: true,
        mindMapDirection: 'down',
        shapeStyle: 'mind-node',
        text: 'Launch plan',
        sourceRefIds: ['document:brief'],
      }], 'Mind map'))

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'mind-1',
        mindMapBranchSide: 'right',
        mindMapCollapsed: true,
        mindMapDirection: 'down',
        shapeStyle: 'mind-node',
        sourceRefIds: ['document:brief'],
        text: 'Launch plan',
      }),
    ]))
  })

  it('keeps commercial shape styles and portable workspace images', () => {
    const records = throughJson(createBoardRecordsFromElements([
        {
          id: 'shape-1',
          kind: 'rectangle',
          x: 20,
          y: 30,
          width: 180,
          height: 100,
          shapeType: 'diamond',
          style: {
            strokeColor: 'purple',
            fillColor: 'green',
            opacity: 0.65,
            fillStyle: 'pattern',
            dashStyle: 'dashed',
            strokeSize: 'l',
          },
        },
        {
          id: 'image-1',
          kind: 'image',
          x: 260,
          y: 40,
          width: 320,
          height: 180,
          workspacePath: 'Attachments/launch.png',
          alt: 'Launch image',
          style: { opacity: 0.8 },
        },
    ], 'Launch board'))

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'shape-1',
        shapeType: 'diamond',
        style: expect.objectContaining({
          dashStyle: 'dashed',
          fillColor: 'green',
          fillStyle: 'pattern',
          opacity: 0.65,
          strokeColor: 'purple',
          strokeSize: 'l',
        }),
      }),
      expect.objectContaining({
        id: 'image-1',
        kind: 'image',
        workspacePath: 'Attachments/launch.png',
        alt: 'Launch image',
      }),
    ]))
  })

  it('keeps optional connector binding terminals', () => {
    const records = throughJson([
        ...createBoardRecordsFromElements([
          { id: 'target', kind: 'rectangle', x: 0, y: 0, width: 100, height: 80 },
          {
            id: 'connector',
            kind: 'connector',
            start: { x: 100, y: 40 },
            end: { x: 220, y: 40 },
            connectorRole: 'mind-map-branch',
            mindMapBranchAxis: 'horizontal',
          },
        ], 'Connected board'),
        {
          record_type: 'binding',
          id: 'binding:connector:start',
          binding_type: 'connector',
          from_id: 'connector',
          to_id: 'target',
          terminal: 'start',
          to_anchor: { x: 1, y: 0.5 },
        },
      ])

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'connector',
        connectorRole: 'mind-map-branch',
        mindMapBranchAxis: 'horizontal',
      }),
      expect.objectContaining({
        id: 'binding:connector:start',
        terminal: 'start',
        to_anchor: { x: 1, y: 0.5 },
      }),
    ]))
  })

  it('keeps checkbox shapes while keeping legacy check marks readable', () => {
    const records = throughJson(createBoardRecordsFromElements([
        { id: 'x-box', kind: 'rectangle', x: 0, y: 0, width: 80, height: 80, shapeType: 'x-box' },
        { id: 'check-box', kind: 'rectangle', x: 100, y: 0, width: 80, height: 80, shapeType: 'check-box' },
        { id: 'legacy-check', kind: 'rectangle', x: 200, y: 0, width: 80, height: 80, shapeType: 'check' },
      ], 'Checklist'))

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'x-box', shapeType: 'x-box' }),
      expect.objectContaining({ id: 'check-box', shapeType: 'check-box' }),
      expect.objectContaining({ id: 'legacy-check', shapeType: 'check' }),
    ]))
  })

  it('drops image elements that contain host or traversal paths', () => {
    const records = throughJson(createBoardRecordsFromElements([{
        id: 'image-1',
        kind: 'image',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        workspacePath: '../private.png',
    }]))
    expect(records.some((record) => record.id === 'image-1')).toBe(false)
  })
})
