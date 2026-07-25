import { describe, it, expect } from 'vitest'
import { segment, __fallbackSegmentForTests } from './tokenize'

const codePointText = (...values: number[]) => String.fromCodePoint(...values)
const sales = codePointText(0x9500, 0x552e)
const salesAmount = codePointText(0x9500, 0x552e, 0x989d)

describe('segment', () => {
  it('splits simple ASCII words and lowercases', () => {
    expect(segment('Hello world FOO')).toEqual(['hello', 'world', 'foo'])
  })

  it('drops single-character ASCII tokens (noise)', () => {
    expect(segment('a quick b test')).toEqual(['quick', 'test'])
  })

  it('NFKC-normalizes full-width digits', () => {
    expect(segment('１２３')).toEqual(['123'])
  })
})

describe('segment — CJK and mixed', () => {
  it('segments Chinese into word-like units via Intl.Segmenter', () => {
    const toks = segment(codePointText(0x9500, 0x552e, 0x989d, 0x5f02, 0x5e38, 0x7684, 0x62a5, 0x544a))
    expect(toks.length).toBeGreaterThan(1)
    expect(toks.some(t => t.includes(sales))).toBe(true)
  })

  it('handles mixed CN+EN', () => {
    const toks = segment(`Q3 ${salesAmount} 200${codePointText(0x4e07)}`)
    expect(toks).toContain('q3')
    expect(toks).toContain('200')
    expect(toks.some(t => t.includes(sales))).toBe(true)
  })
})

describe('fallbackSegment (Intl.Segmenter unavailable)', () => {
  it('bigram-splits Chinese', () => {
    expect(__fallbackSegmentForTests(salesAmount.normalize('NFKC').toLowerCase()))
      .toEqual([sales, codePointText(0x552e, 0x989d)])
  })

  it('preserves single CJK char', () => {
    const singleHan = codePointText(0x9500)
    expect(__fallbackSegmentForTests(singleHan)).toEqual([singleHan])
  })

  it('splits ASCII on non-word boundaries', () => {
    expect(__fallbackSegmentForTests('hello, world!'.toLowerCase()))
      .toEqual(['hello', 'world'])
  })
})
