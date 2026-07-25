import { describe, expect, it } from 'vitest'

import { computeWordFrequency } from './DocumentWordFrequencyDialog'

describe('computeWordFrequency', () => {
  it('counts repeated english words case-insensitively', () => {
    const r = computeWordFrequency('hello Hello HELLO world')
    const hello = r.find((e) => e.token === 'hello')
    expect(hello).toBeDefined()
    expect(hello!.count).toBe(3)
  })

  it('counts each CJK character as its own token', () => {
    const youToken = String.fromCodePoint(0x4f60)
    const worldToken = String.fromCodePoint(0x4e16)
    const r = computeWordFrequency(String.fromCodePoint(0x4f60, 0x597d, 0x4f60, 0x597d, 0x4e16, 0x754c))
    const you = r.find((e) => e.token === youToken)
    expect(you?.count).toBe(2)
    expect(r.find((e) => e.token === worldToken)?.count).toBe(1)
  })

  it('treats #tags as a single token preserving casing', () => {
    const r = computeWordFrequency('#TypeScript code #typescript more')
    const upper = r.find((e) => e.token === '#TypeScript')
    const lower = r.find((e) => e.token === '#typescript')
    expect(upper?.count).toBe(1)
    expect(lower?.count).toBe(1)
  })

  it('skips english stopwords like the/and', () => {
    const r = computeWordFrequency('the cat and the dog')
    expect(r.find((e) => e.token === 'the')).toBeUndefined()
    expect(r.find((e) => e.token === 'and')).toBeUndefined()
    expect(r.find((e) => e.token === 'cat')?.count).toBe(1)
  })

  it('skips fenced code blocks', () => {
    const src = 'hello world\n```\nhello hidden code\n```\nhello again'
    const r = computeWordFrequency(src)
    expect(r.find((e) => e.token === 'hello')?.count).toBe(2)
  })

  it('skips short english words below min length', () => {
    const r = computeWordFrequency('a b c d test')
    expect(r.find((e) => e.token === 'a')).toBeUndefined()
    expect(r.find((e) => e.token === 'test')?.count).toBe(1)
  })

  it('skips pure-number tokens', () => {
    const r = computeWordFrequency('5 42 100 hello')
    expect(r.find((e) => e.token === '42')).toBeUndefined()
    expect(r.find((e) => e.token === 'hello')?.count).toBe(1)
  })

  it('reports the first occurrence line / col', () => {
    const r = computeWordFrequency('one two\nthree two')
    const two = r.find((e) => e.token === 'two')
    expect(two?.firstLine).toBe(1)
    expect(two?.firstCol).toBe(5)
  })

  it('sorts results by count desc', () => {
    const r = computeWordFrequency('apple apple apple banana banana cherry')
    const tokens = r.map((e) => e.token)
    expect(tokens[0]).toBe('apple')
    expect(tokens[1]).toBe('banana')
    expect(tokens[2]).toBe('cherry')
  })
})
