import { describe, expect, it } from 'vitest'

import { toEpochMs, toIsoTimestamp } from './timestamps'

describe('timestamps', () => {
  it('reads milliseconds and ISO strings', () => {
    expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(toEpochMs('1700000000000')).toBe(1_700_000_000_000)
    expect(toEpochMs('2023-11-14T22:13:20.000Z')).toBe(1_700_000_000_000)
    expect(toEpochMs('')).toBeNaN()
    expect(toEpochMs(null)).toBeNaN()
    expect(toIsoTimestamp(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z')
    expect(toIsoTimestamp('nope')).toBe('')
  })
})
