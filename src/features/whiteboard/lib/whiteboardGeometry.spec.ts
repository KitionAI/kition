import { describe, expect, it } from 'vitest'

import {
  clampWhiteboardZoom,
  getWhiteboardConnectorPath,
  getWhiteboardElementBounds,
  resizeWhiteboardElements,
  rotateWhiteboardElements,
  normalizeWhiteboardBounds,
  screenToWhiteboardPoint,
  translateWhiteboardElement,
  whiteboardPointsToPath,
} from './whiteboardGeometry'

describe('whiteboardGeometry', () => {
  it('normalizes reverse drag bounds', () => {
    expect(normalizeWhiteboardBounds(
      { x: 100, y: 80 },
      { x: 20, y: 30 },
    )).toEqual({ x: 20, y: 30, width: 80, height: 50 })
  })

  it('maps screen coordinates through pan and zoom', () => {
    expect(screenToWhiteboardPoint(
      { x: 200, y: 100 },
      { x: 40, y: -10, zoom: 2 },
    )).toEqual({ x: 140, y: 40 })
  })

  it('translates every point of a freehand stroke', () => {
    expect(translateWhiteboardElement({
      id: 'board-stroke-one',
      kind: 'stroke',
      points: [{ x: 0, y: 1 }, { x: 2, y: 3 }],
    }, { x: 10, y: -1 })).toEqual({
      id: 'board-stroke-one',
      kind: 'stroke',
      points: [{ x: 10, y: 0 }, { x: 12, y: 2 }],
    })
  })

  it('estimates text bounds for SVG selection geometry', () => {
    expect(getWhiteboardElementBounds({
      id: 'text-1',
      kind: 'text',
      x: 10,
      y: 50,
      text: 'Hello',
    })).toEqual({ x: 10, y: 28, width: 72, height: 30 })
  })

  it('builds an SVG-only smoothed path and clamps zoom', () => {
    expect(whiteboardPointsToPath([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
    ])).toBe('M 0 0 Q 10 10 15 5 L 20 0')
    expect(clampWhiteboardZoom(10)).toBe(4)
    expect(clampWhiteboardZoom(0.1)).toBe(0.25)
  })

  it('rounds elbow connector corners and shrinks the radius on short segments', () => {
    expect(getWhiteboardConnectorPath({
      id: 'elbow',
      kind: 'connector',
      connectorType: 'elbow',
      start: { x: 0, y: 0 },
      end: { x: 100, y: 80 },
    })).toBe('M 0 0 L 38 0 Q 50 0 50 12 L 50 68 Q 50 80 62 80 L 100 80')

    expect(getWhiteboardConnectorPath({
      id: 'short-elbow',
      kind: 'connector',
      connectorType: 'elbow',
      start: { x: 0, y: 0 },
      end: { x: 20, y: 8 },
    })).toBe('M 0 0 L 6 0 Q 10 0 10 4 L 10 4 Q 10 8 14 8 L 20 8')

    expect(getWhiteboardConnectorPath({
      id: 'flat-elbow',
      kind: 'connector',
      connectorType: 'elbow',
      start: { x: 0, y: 20 },
      end: { x: 100, y: 20 },
    })).toBe('M 0 20 L 100 20')
  })

  it('resizes mixed elements relative to one selection bounds', () => {
    expect(resizeWhiteboardElements({
      elements: [{
        id: 'rect-1',
        kind: 'rectangle',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      }],
      handle: 'south-east',
      point: { x: 200, y: 100 },
      selectionBounds: { x: 0, y: 0, width: 100, height: 50 },
    })).toEqual([
      expect.objectContaining({ x: 0, y: 0, width: 200, height: 100 }),
    ])
  })

  it('rotates a rectangle around the selection origin with angle snapping', () => {
    expect(rotateWhiteboardElements({
      elements: [{
        id: 'rect-1',
        kind: 'rectangle',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      }],
      origin: { x: 50, y: 25 },
      start: { x: 50, y: -25 },
      point: { x: 100, y: 25 },
      snap: true,
    })).toEqual([
      expect.objectContaining({ x: 0, y: 0, rotation: 90 }),
    ])
  })

  it('transforms workspace images with the same SVG geometry contract as shapes', () => {
    const image = {
      id: 'image-1',
      kind: 'image' as const,
      x: 10,
      y: 20,
      width: 120,
      height: 80,
      workspacePath: 'Attachments/photo.png',
    }
    expect(translateWhiteboardElement(image, { x: 30, y: -10 })).toMatchObject({
      x: 40,
      y: 10,
      workspacePath: 'Attachments/photo.png',
    })
    expect(resizeWhiteboardElements({
      elements: [image],
      handle: 'south-east',
      point: { x: 250, y: 180 },
      selectionBounds: { x: 10, y: 20, width: 120, height: 80 },
    })[0]).toMatchObject({ width: 240, height: 160 })
    expect(rotateWhiteboardElements({
      elements: [image],
      origin: { x: 70, y: 60 },
      start: { x: 70, y: 0 },
      point: { x: 130, y: 60 },
      snap: true,
    })[0]).toMatchObject({ rotation: 90 })
  })
})
