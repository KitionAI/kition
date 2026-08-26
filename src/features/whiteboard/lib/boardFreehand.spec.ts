import { describe, expect, it } from 'vitest'

import { simplifyBoardFreehandPoints } from './boardFreehand'

describe('simplifyBoardFreehandPoints', () => {
  it('collapses a dense straight stroke while preserving its endpoints', () => {
    const points = Array.from({ length: 1001 }, (_, index) => ({ x: index, y: 10 }))
    expect(simplifyBoardFreehandPoints(points, 1)).toEqual([
      { x: 0, y: 10 },
      { x: 1000, y: 10 },
    ])
  })

  it('preserves material corners and does not mutate source points', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 20, y: 0.2 },
      { x: 40, y: 0 },
      { x: 40, y: 30 },
      { x: 40, y: 60 },
    ]
    const simplified = simplifyBoardFreehandPoints(points, 1)
    expect(simplified).toEqual([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 60 },
    ])
    expect(simplified[0]).not.toBe(points[0])
  })
})
