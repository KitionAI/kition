import { describe, expect, it } from 'vitest'

import { findMathSpans } from './math-preview'

describe('findMathSpans', () => {
  it('returns empty for plain text', () => {
    expect(findMathSpans('hello world')).toEqual([])
  })

  it('detects inline math', () => {
    const src = 'before $a+b$ after'
    const r = findMathSpans(src)
    expect(r).toHaveLength(1)
    expect(r[0].tex).toBe('a+b')
    expect(r[0].display).toBe(false)
    expect(src.slice(r[0].from, r[0].to)).toBe('$a+b$')
  })

  it('detects multiple inline math on one line', () => {
    const r = findMathSpans('$x$ + $y$ = $z$')
    expect(r.map((s) => s.tex)).toEqual(['x', 'y', 'z'])
    expect(r.every((s) => s.display === false)).toBe(true)
  })

  it('ignores currency-style $5.00', () => {
    expect(findMathSpans('It costs $5.00 today')).toEqual([])
  })

  it('ignores escaped dollars', () => {
    expect(findMathSpans('\\$a+b\\$')).toEqual([])
  })

  it('detects block math on a single line', () => {
    const r = findMathSpans('$$x^2$$')
    expect(r).toHaveLength(1)
    expect(r[0].tex).toBe('x^2')
    expect(r[0].display).toBe(true)
  })

  it('detects multi-line block math', () => {
    const src = 'before\n$$\na = b\nc = d\n$$\nafter'
    const r = findMathSpans(src)
    expect(r).toHaveLength(1)
    expect(r[0].display).toBe(true)
    expect(r[0].tex.replace(/\s+/g, ' ').trim()).toBe('a = b c = d')
  })

  it('skips math inside fenced code blocks', () => {
    const src = '```\n$x^2$\n$$y$$\n```\n$z$'
    const r = findMathSpans(src)
    expect(r).toHaveLength(1)
    expect(r[0].tex).toBe('z')
  })

  it('rejects empty inline math like $$', () => {
    expect(findMathSpans('$$')).toEqual([])
  })

  it('rejects whitespace-only inline math like $ $', () => {
    expect(findMathSpans('a $ $ b')).toEqual([])
  })

  it('does not treat lone $ as math', () => {
    expect(findMathSpans('one $ and that is it')).toEqual([])
  })

  it('reports correct positions for inline span', () => {
    const src = 'pre $a$ post'
    const r = findMathSpans(src)
    expect(r[0].from).toBe(4)
    expect(r[0].to).toBe(7)
  })

  it('handles unmatched $$ open by ignoring', () => {
    expect(findMathSpans('$$\nstart with no close')).toEqual([])
  })
})
