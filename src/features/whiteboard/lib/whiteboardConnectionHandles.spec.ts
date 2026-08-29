import { describe, expect, it } from 'vitest'

import {
  getWhiteboardConnectionHandles,
  isWhiteboardQuickConnectElement,
} from './whiteboardConnectionHandles'
import type { WhiteboardElement } from './whiteboardTypes'

describe('whiteboardConnectionHandles', () => {
  it('places four handles outside the edge centers of a shape', () => {
    const element: WhiteboardElement = {
      id: 'shape',
      kind: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 80,
    }

    expect(getWhiteboardConnectionHandles({ element, gap: 24 })).toEqual([
      expect.objectContaining({
        direction: 'north',
        anchor: expect.objectContaining({
          point: { x: 60, y: 20 },
          targetAnchor: { x: 0.5, y: 0 },
        }),
        handlePoint: { x: 60, y: -4 },
      }),
      expect.objectContaining({
        direction: 'east',
        anchor: expect.objectContaining({ point: { x: 110, y: 60 } }),
        handlePoint: { x: 134, y: 60 },
      }),
      expect.objectContaining({
        direction: 'south',
        anchor: expect.objectContaining({ point: { x: 60, y: 100 } }),
        handlePoint: { x: 60, y: 124 },
      }),
      expect.objectContaining({
        direction: 'west',
        anchor: expect.objectContaining({ point: { x: 10, y: 60 } }),
        handlePoint: { x: -14, y: 60 },
      }),
    ])
  })

  it('rotates both the edge anchor and outward handle direction', () => {
    const handles = getWhiteboardConnectionHandles({
      element: {
        id: 'shape',
        kind: 'rectangle',
        x: 0,
        y: 0,
        width: 100,
        height: 60,
        rotation: 90,
      },
      gap: 24,
    })

    const north = handles.find((handle) => handle.direction === 'north')!
    expect(north.anchor.point.x).toBeCloseTo(80)
    expect(north.anchor.point.y).toBeCloseTo(30)
    expect(north.handlePoint.x).toBeCloseTo(104)
    expect(north.handlePoint.y).toBeCloseTo(30)

    const east = handles.find((handle) => handle.direction === 'east')!
    expect(east.anchor.point.x).toBeCloseTo(50)
    expect(east.anchor.point.y).toBeCloseTo(80)
    expect(east.handlePoint.x).toBeCloseTo(50)
    expect(east.handlePoint.y).toBeCloseTo(104)
  })

  it('limits quick connectors to ordinary diagram shapes', () => {
    expect(isWhiteboardQuickConnectElement({
      id: 'flow',
      kind: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      shapeStyle: 'flow-node',
    })).toBe(true)
    expect(isWhiteboardQuickConnectElement({
      id: 'mind',
      kind: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      shapeStyle: 'mind-node',
    })).toBe(false)
    expect(isWhiteboardQuickConnectElement({
      id: 'frame',
      kind: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      shapeType: 'frame',
    })).toBe(false)
  })
})
