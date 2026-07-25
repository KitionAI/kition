import { describe, expect, it } from 'vitest'
import { isPristine } from './dirty'

describe('isPristine', () => {
  it('returns true for identical objects', () => {
    expect(isPristine({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true)
  })

  it('returns false when a primitive changes', () => {
    expect(isPristine({ a: 1 }, { a: 2 })).toBe(false)
  })

  it('handles nested objects', () => {
    expect(isPristine({ p: { k: 'v' } }, { p: { k: 'v' } })).toBe(true)
    expect(isPristine({ p: { k: 'v' } }, { p: { k: 'w' } })).toBe(false)
  })

  it('handles arrays', () => {
    expect(isPristine([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(isPristine([1, 2, 3], [1, 2])).toBe(false)
    expect(isPristine([1, 2, 3], [1, 2, 4])).toBe(false)
  })

  it('treats undefined and missing keys the same', () => {
    expect(isPristine({ a: 1 } as Record<string, unknown>,
                      { a: 1, b: undefined })).toBe(true)
  })
})
