import { describe, expect, it } from 'vitest'

import { getBoardResizeSnap, getBoardTranslationSnap } from './boardSnapManager'
import type { WhiteboardElement } from './whiteboardTypes'

describe('getBoardTranslationSnap', () => {
  it('snaps centers and edges within the zoom-adjusted threshold', () => {
    const result = getBoardTranslationSnap({
      movingElements: [{
        id: 'moving',
        kind: 'rectangle',
        x: 148,
        y: 117,
        width: 100,
        height: 80,
      }],
      stationaryElements: [{
        id: 'target',
        kind: 'rectangle',
        x: 50,
        y: 20,
        width: 100,
        height: 100,
      }],
      threshold: 4,
    })

    expect(result.adjustment).toEqual({ x: 2, y: 3 })
    expect(result.guides).toEqual([
      expect.objectContaining({ axis: 'x', position: 150 }),
      expect.objectContaining({ axis: 'y', position: 120 }),
    ])
  })

  it('does not snap when every candidate is outside the threshold', () => {
    expect(getBoardTranslationSnap({
      movingElements: [{
        id: 'moving',
        kind: 'rectangle',
        x: 300,
        y: 300,
        width: 100,
        height: 80,
      }],
      stationaryElements: [{
        id: 'target',
        kind: 'rectangle',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
      }],
      threshold: 6,
    })).toEqual({ adjustment: { x: 0, y: 0 }, guides: [] })
  })

  it('centers a moving element between two neighbors with equal gaps', () => {
    const result = getBoardTranslationSnap({
      movingElements: [rectangle('moving', 78, 0, 50, 50)],
      stationaryElements: [
        rectangle('left', 0, 0, 50, 50),
        rectangle('right', 150, 0, 50, 50),
      ],
      threshold: 5,
    })

    expect(result.adjustment.x).toBe(-3)
    expect(result.guides).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: 'x', position: 100 }),
    ]))
  })
})

describe('getBoardResizeSnap', () => {
  it('snaps an active resize edge to nearby element geometry', () => {
    const result = getBoardResizeSnap({
      handle: 'east',
      point: { x: 198, y: 50 },
      selectionBounds: { x: 0, y: 0, width: 100, height: 100 },
      stationaryElements: [rectangle('target', 200, 0, 100, 100)],
      threshold: 5,
    })

    expect(result.point).toEqual({ x: 200, y: 50 })
    expect(result.guides).toEqual([
      expect.objectContaining({ axis: 'x', position: 200 }),
    ])
  })
})

function rectangle(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): WhiteboardElement {
  return { id, kind: 'rectangle', x, y, width, height }
}
