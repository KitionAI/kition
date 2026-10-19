import { describe, expect, it } from 'vitest'

import { parseTags } from './tag-parser'

describe('parseTags', () => {
  it('extracts a simple tag at line start', () => {
    const results = parseTags('#project notes')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      name: 'project',
      segments: ['project'],
      from: 0,
      to: 8,
      line: 0,
    })
  })

  it('extracts tags after whitespace', () => {
    const results = parseTags('hello #foo world #bar')
    expect(results.map((t) => t.name)).toEqual(['foo', 'bar'])
  })

  it('supports nested tags with /', () => {
    const results = parseTags('#project/active/ui')
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('project/active/ui')
    expect(results[0].segments).toEqual(['project', 'active', 'ui'])
  })

  it('supports unicode (CJK) in tag names', () => {
    const localizedTag = String.fromCodePoint(0x77e5, 0x8bc6, 0x7ba1, 0x7406)
    const results = parseTags(`${String.fromCodePoint(0x7b14, 0x8bb0)} #${localizedTag} ${String.fromCodePoint(0x5907, 0x5fd8)}`)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe(localizedTag)
  })

  it('rejects pure numeric tags', () => {
    expect(parseTags('#123')).toEqual([])
  })

  it('rejects URL fragments (no whitespace before #)', () => {
    expect(parseTags('https://example.com/page#section')).toEqual([])
  })

  it('rejects tags that start or end with /', () => {
    expect(parseTags('#/orphan')).toEqual([])
    expect(parseTags('#dangling/')).toEqual([])
  })

  it('computes correct line numbers across multilines', () => {
    const source = 'first line\nsecond line with #tag\nthird'
    const results = parseTags(source)
    expect(results).toHaveLength(1)
    expect(results[0].line).toBe(1)
    expect(source.slice(results[0].from, results[0].to)).toBe('#tag')
  })

  it('returns absolute offsets that round-trip', () => {
    const source = 'note #alpha\nfoo #beta/sub bar'
    const results = parseTags(source)
    for (const tag of results) {
      expect(source.slice(tag.from, tag.to)).toBe('#' + tag.name)
    }
  })

  it('handles dashes and underscores in tag names', () => {
    const results = parseTags('#kebab-case #snake_case')
    expect(results.map((t) => t.name)).toEqual(['kebab-case', 'snake_case'])
  })
})
