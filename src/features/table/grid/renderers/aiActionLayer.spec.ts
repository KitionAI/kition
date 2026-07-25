import { describe, expect, it } from 'vitest'
import { isInAIActionZone, AI_ACTION_BUTTON_SIZE } from './aiActionLayer'

describe('isInAIActionZone', () => {
  const rect = { x: 0, y: 0, width: 200, height: 40 }

  it('returns true when click is in the top-right corner', () => {
    expect(isInAIActionZone(rect, 195, 5)).toBe(true)
  })

  it('returns false when click is in the middle of the cell', () => {
    expect(isInAIActionZone(rect, 100, 20)).toBe(false)
  })

  it('respects AI_ACTION_BUTTON_SIZE', () => {
    expect(AI_ACTION_BUTTON_SIZE).toBeGreaterThan(0)
  })
})
