import { describe, expect, it } from 'vitest'

import {
  createBoardElementRecord,
  type BoardBindingRecord,
  type BoardRecord,
} from './boardRecords'
import { createPresentationFromBoard } from './whiteboardPresentation'

function baseRecords(): BoardRecord[] {
  return [
    { record_type: 'meta', id: 'meta:board', active_page_id: 'page:main' },
    { record_type: 'page', id: 'page:main', name: 'Roadmap', index: 0 },
  ]
}

describe('whiteboard presentation conversion', () => {
  it('uses frame elements as slides and keeps common objects editable', () => {
    const records: BoardRecord[] = [
      ...baseRecords(),
      createBoardElementRecord({
        pageId: 'page:main',
        index: 0,
        element: {
          id: 'frame:one',
          kind: 'rectangle',
          x: 100,
          y: 100,
          width: 1_280,
          height: 720,
          shapeType: 'frame',
          shapeStyle: 'frame',
          text: 'Overview',
        },
      }),
      createBoardElementRecord({
        pageId: 'page:main',
        index: 1,
        element: {
          id: 'shape:title',
          kind: 'rectangle',
          parentId: 'frame:one',
          x: 180,
          y: 160,
          width: 420,
          height: 120,
          shapeType: 'pill',
          text: 'Kition Roadmap',
          style: { fillColor: 'purple', strokeColor: 'purple' },
        },
      }),
      createBoardElementRecord({
        pageId: 'page:main',
        index: 2,
        element: {
          id: 'image:hero',
          kind: 'image',
          parentId: 'frame:one',
          x: 680,
          y: 170,
          width: 480,
          height: 300,
          workspacePath: 'Attachments/roadmap.png',
        },
      }),
      createBoardElementRecord({
        pageId: 'page:main',
        index: 3,
        element: {
          id: 'connector:one',
          kind: 'connector',
          parentId: 'frame:one',
          start: { x: 600, y: 220 },
          end: { x: 680, y: 260 },
        },
      }),
      {
        record_type: 'binding',
        id: 'binding:connector:end',
        binding_type: 'connector',
        from_id: 'connector:one',
        to_id: 'image:hero',
        terminal: 'end',
      } satisfies BoardBindingRecord,
    ]

    const result = createPresentationFromBoard({ title: 'Roadmap', records })

    expect(result.document.slides).toHaveLength(1)
    expect(result.document.slides[0]).toMatchObject({
      id: 'slide:frame:one',
      name: 'Overview',
      index: 0,
    })
    expect(result.document.slides[0].elements.map((element) => element.kind))
      .toEqual(['shape', 'image', 'connector'])
    expect(result.document.slides[0].elements.find((element) => element.kind === 'connector'))
      .toMatchObject({
        end_binding: { element_id: 'image:hero' },
      })
    expect(result.document.assets).toEqual([
      expect.objectContaining({
        id: 'asset:image:hero',
        mime_type: 'image/png',
        source: { kind: 'workspace', workspace_path: 'Attachments/roadmap.png' },
      }),
    ])
  })

  it('creates a content-bounds slide when the page has no frame', () => {
    const records: BoardRecord[] = [
      ...baseRecords(),
      createBoardElementRecord({
        pageId: 'page:main',
        index: 0,
        element: {
          id: 'text:one',
          kind: 'text',
          x: 200,
          y: 180,
          text: 'Editable slide text',
          fontSize: 32,
        },
      }),
      createBoardElementRecord({
        pageId: 'page:main',
        index: 1,
        element: {
          id: 'stroke:one',
          kind: 'stroke',
          points: [{ x: 200, y: 260 }, { x: 320, y: 300 }, { x: 420, y: 270 }],
        },
      }),
    ]

    const result = createPresentationFromBoard({ title: 'Roadmap', records })

    expect(result.document.slides).toHaveLength(1)
    expect(result.document.slides[0].id).toBe('slide:page:main')
    expect(result.document.slides[0].elements).toEqual([
      expect.objectContaining({ kind: 'text', id: 'text:one' }),
      expect.objectContaining({ kind: 'freeform', id: 'stroke:one' }),
    ])
    expect(result.document.slides[0].elements.every((element) => (
      element.bounds.width > 0 && element.bounds.height > 0
    ))).toBe(true)
  })

  it('preserves unframed content on an additional slide by default', () => {
    const records: BoardRecord[] = [
      ...baseRecords(),
      createBoardElementRecord({
        pageId: 'page:main',
        index: 0,
        element: {
          id: 'frame:one',
          kind: 'rectangle',
          x: 0,
          y: 0,
          width: 1_280,
          height: 720,
          shapeType: 'frame',
        },
      }),
      createBoardElementRecord({
        pageId: 'page:main',
        index: 1,
        element: {
          id: 'text:outside',
          kind: 'text',
          x: 1_600,
          y: 100,
          text: 'Outside frame',
        },
      }),
    ]

    const result = createPresentationFromBoard({ title: 'Roadmap', records })

    expect(result.document.slides).toHaveLength(2)
    expect(result.document.slides[1].name).toContain('Unframed')
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'unframed_content_appended',
      severity: 'info',
    }))
  })
})
