import { expect, it } from 'vitest'
import { snapDesignMove } from './designSnapping'

it('snaps a moving center without changing the other axis or the original bounds', () => {
  const bounds = { x: 10, y: 20, width: 40, height: 60 }
  expect(snapDesignMove(bounds, 17, 11, { x: [50], y: [200] }, 6)).toEqual({
    dx: 20,
    dy: 11,
    guides: { x: 50 },
  })
  expect(bounds).toEqual({ x: 10, y: 20, width: 40, height: 60 })
  expect(snapDesignMove(bounds, 17, 11, { x: [50], y: [200] }, 2)).toEqual({
    dx: 17,
    dy: 11,
    guides: {},
  })
})
