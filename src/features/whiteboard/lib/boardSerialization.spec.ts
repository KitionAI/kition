import { describe, expect, it } from 'vitest'

import {
  buildBoardDocument,
  createEmptyBoardDocument,
  parseBoardDocument,
  serializeBoardDocument,
} from './boardSerialization'
import { createBoardRecordsFromElements } from './boardRecords'

describe('Board .kiboard serialization', () => {
  it('creates a readable Git-friendly versioned JSON document', () => {
    const content = serializeBoardDocument(buildBoardDocument({
      title: 'Product map',
      viewport: { x: 12, y: 24, zoom: 1.5 },
      records: createBoardRecordsFromElements([{
        id: 'rect-1',
        kind: 'rectangle',
        x: 10,
        y: 20,
        width: 120,
        height: 80,
      }], 'Product map'),
    }))

    expect(content.endsWith('\n')).toBe(true)
    expect(content).toContain('"format": "kition-board"')
    expect(parseBoardDocument(content)).toMatchObject({
      format: 'kition-board',
      version: 1,
      title: 'Product map',
      records: expect.arrayContaining([
        expect.objectContaining({
          id: 'rect-1',
          record_type: 'element',
        }),
      ]),
    })
  })

  it('rejects invalid or unsupported Board files', () => {
    expect(() => parseBoardDocument('{')).toThrow('invalid JSON')
    expect(() => parseBoardDocument(JSON.stringify({
      format: 'other-board',
      version: 1,
    }))).toThrow('unsupported')
    expect(() => parseBoardDocument(JSON.stringify({
      format: 'kition-board',
      version: 2,
      records: [],
    }))).toThrow('unsupported')
    expect(() => parseBoardDocument(JSON.stringify({
      format: 'kition-board',
      version: 1,
      elements: [],
    }))).toThrow('normalized records')
  })

  it('creates an empty Board with the portable format marker', () => {
    expect(createEmptyBoardDocument('Untitled board')).toMatchObject({
      format: 'kition-board',
      version: 1,
      title: 'Untitled board',
      records: expect.arrayContaining([
        expect.objectContaining({ record_type: 'meta' }),
        expect.objectContaining({ record_type: 'page' }),
      ]),
    })
  })

  it('round-trips semantic AI node labels and portable source references', () => {
    const document = parseBoardDocument(serializeBoardDocument(buildBoardDocument({
      title: 'Mind map',
      viewport: { x: 0, y: 0, zoom: 1 },
      records: createBoardRecordsFromElements([{
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
      }], 'Mind map'),
    })))

    expect(document.records).toEqual(expect.arrayContaining([
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

  it('round-trips commercial shape styles and portable workspace images', () => {
    const document = parseBoardDocument(serializeBoardDocument(buildBoardDocument({
      title: 'Launch board',
      viewport: { x: 0, y: 0, zoom: 1 },
      records: createBoardRecordsFromElements([
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
      ], 'Launch board'),
    })))

    expect(document.records).toEqual(expect.arrayContaining([
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

  it('round-trips optional connector binding terminals without changing the Board version', () => {
    const document = parseBoardDocument(serializeBoardDocument(buildBoardDocument({
      title: 'Connected board',
      viewport: { x: 0, y: 0, zoom: 1 },
      records: [
        ...createBoardRecordsFromElements([
          { id: 'target', kind: 'rectangle', x: 0, y: 0, width: 100, height: 80 },
          {
            id: 'connector',
            kind: 'connector',
            start: { x: 100, y: 40 },
            end: { x: 220, y: 40 },
            connectorRole: 'mind-map-branch',
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
      ],
    })))

    expect(document.version).toBe(1)
    expect(document.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'connector',
        connectorRole: 'mind-map-branch',
      }),
      expect.objectContaining({
        id: 'binding:connector:start',
        terminal: 'start',
        to_anchor: { x: 1, y: 0.5 },
      }),
    ]))
  })

  it('round-trips checkbox shapes while keeping legacy check marks readable', () => {
    const document = parseBoardDocument(serializeBoardDocument(buildBoardDocument({
      title: 'Checklist',
      viewport: { x: 0, y: 0, zoom: 1 },
      records: createBoardRecordsFromElements([
        { id: 'x-box', kind: 'rectangle', x: 0, y: 0, width: 80, height: 80, shapeType: 'x-box' },
        { id: 'check-box', kind: 'rectangle', x: 100, y: 0, width: 80, height: 80, shapeType: 'check-box' },
        { id: 'legacy-check', kind: 'rectangle', x: 200, y: 0, width: 80, height: 80, shapeType: 'check' },
      ], 'Checklist'),
    })))

    expect(document.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'x-box', shapeType: 'x-box' }),
      expect.objectContaining({ id: 'check-box', shapeType: 'check-box' }),
      expect.objectContaining({ id: 'legacy-check', shapeType: 'check' }),
    ]))
  })

  it('drops image elements that contain host or traversal paths', () => {
    const unsafe = buildBoardDocument({
      title: 'Unsafe',
      viewport: { x: 0, y: 0, zoom: 1 },
      records: createBoardRecordsFromElements([{
        id: 'image-1',
        kind: 'image',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        workspacePath: '../private.png',
      }]),
    })
    const parsed = parseBoardDocument(JSON.stringify(unsafe))
    expect(parsed.records.some((record) => record.id === 'image-1')).toBe(false)
  })
})
