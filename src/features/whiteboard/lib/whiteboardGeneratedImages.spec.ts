import { describe, expect, it } from 'vitest'

import {
  buildEditableImageTextOverlay,
  getEditableImageTextOverlay,
  getGeneratedImageCenters,
  getGeneratedImagePlacementSize,
} from './whiteboardGeneratedImages'

describe('whiteboard generated images', () => {
  it('builds bounded placement sizes from aspect ratios', () => {
    expect(getGeneratedImagePlacementSize('16:9')).toEqual({ width: 560, height: 315 })
    expect(getGeneratedImagePlacementSize('9:16')).toEqual({ width: 270, height: 480 })
  })

  it('places variants around the viewport center without overlap', () => {
    expect(getGeneratedImageCenters({
      canvasSize: { x: 1200, y: 800 },
      count: 2,
      imageSize: { width: 400, height: 300 },
      viewport: { x: 0, y: 0, zoom: 1 },
    })).toEqual([
      { x: 376, y: 400 },
      { x: 824, y: 400 },
    ])
  })

  it('creates a separately editable text element linked to the image', () => {
    const overlay = buildEditableImageTextOverlay({
      elements: [],
      image: {
        id: 'image-1',
        kind: 'image',
        x: 100,
        y: 200,
        width: 500,
        height: 300,
        workspacePath: 'Agent/generated.png',
      },
      text: 'Launch clearly',
    })

    expect(overlay?.element).toMatchObject({
      kind: 'text',
      text: 'Launch clearly',
      sourceRefIds: ['image-1'],
      style: { strokeColor: 'white' },
    })
    expect(overlay?.existing).toBe(false)
  })

  it('finds the editable text layer linked to a generated image', () => {
    const textLayer = {
      id: 'text-1',
      kind: 'text' as const,
      x: 120,
      y: 240,
      text: 'Editable headline',
      sourceRefIds: ['image-1'],
    }

    expect(getEditableImageTextOverlay([
      {
        id: 'image-1',
        kind: 'image',
        x: 100,
        y: 200,
        width: 500,
        height: 300,
        workspacePath: 'Agent/generated.png',
      },
      textLayer,
    ], 'image-1')).toBe(textLayer)
  })
})
