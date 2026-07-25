import { describe, expect, it } from 'vitest'

import { parseBlockIds } from './block-id-parser'

describe('parseBlockIds', () => {
  it('detects a block id at end of line', () => {
    const source = 'A paragraph. ^abc-123'
    const results = parseBlockIds(source)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      blockId: 'abc-123',
      from: 13,
      to: 21,
      line: 0,
    })
    expect(source.slice(results[0].from, results[0].to)).toBe('^abc-123')
  })

  it('detects multiple block ids on different lines', () => {
    const source = 'first ^one\nsecond ^two\nthird line'
    const results = parseBlockIds(source)
    expect(results.map((b) => b.blockId)).toEqual(['one', 'two'])
    expect(results.map((b) => b.line)).toEqual([0, 1])
  })

  it('supports alphanumerics, dashes, underscores', () => {
    const results = parseBlockIds('end ^a_b-c-123')
    expect(results).toHaveLength(1)
    expect(results[0].blockId).toBe('a_b-c-123')
  })

  it('requires whitespace or end after the id', () => {
    expect(parseBlockIds('inline^id here')).toEqual([])
  })

  it('does not match ^ followed by invalid chars', () => {
    expect(parseBlockIds('caret only ^')).toEqual([])
    expect(parseBlockIds('caret bad ^!nope')).toEqual([])
  })

  it('matches at very end of buffer (no trailing whitespace)', () => {
    const results = parseBlockIds('tail ^x1')
    expect(results).toHaveLength(1)
    expect(results[0].blockId).toBe('x1')
  })

  it('returns empty for blank source', () => {
    expect(parseBlockIds('')).toEqual([])
    expect(parseBlockIds('no block ids here')).toEqual([])
  })
})
