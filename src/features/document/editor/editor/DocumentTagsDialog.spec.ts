import { describe, expect, it } from 'vitest'

import { extractDocumentTags } from './DocumentTagsDialog'

describe('extractDocumentTags', () => {
  it('returns empty for plain text', () => {
    expect(extractDocumentTags('no tags here')).toEqual([])
  })

  it('extracts a single tag', () => {
    const r = extractDocumentTags('hello #foo world')
    expect(r).toHaveLength(1)
    expect(r[0].tag).toBe('#foo')
    expect(r[0].count).toBe(1)
    expect(r[0].firstLine).toBe(1)
  })

  it('counts duplicate tags', () => {
    const r = extractDocumentTags('#foo and #foo again #bar')
    const foo = r.find((e) => e.tag === '#foo')
    expect(foo?.count).toBe(2)
    expect(r.find((e) => e.tag === '#bar')?.count).toBe(1)
  })

  it('supports hierarchical tags #a/b/c', () => {
    const r = extractDocumentTags('topic #project/alpha here')
    expect(r[0].tag).toBe('#project/alpha')
  })

  it('reports first occurrence position', () => {
    const r = extractDocumentTags('one two\nthree #foo here')
    const foo = r.find((e) => e.tag === '#foo')
    expect(foo?.firstLine).toBe(2)
    expect(foo?.firstCol).toBe(7)
  })

  it('skips tags inside fenced code', () => {
    const src = '```\n#hidden\n```\n#shown'
    const r = extractDocumentTags(src)
    expect(r).toHaveLength(1)
    expect(r[0].tag).toBe('#shown')
  })

  it('skips tags inside inline code', () => {
    const r = extractDocumentTags('use `#raw` literal but #live works')
    expect(r.find((e) => e.tag === '#raw')).toBeUndefined()
    expect(r.find((e) => e.tag === '#live')?.count).toBe(1)
  })

  it('rejects bare # without identifier', () => {
    expect(extractDocumentTags('a # b')).toEqual([])
  })

  it('rejects pure-number tags like #123', () => {
    expect(extractDocumentTags('issue #123 fixed')).toEqual([])
  })

  it('sorts by count descending', () => {
    const r = extractDocumentTags('#a #b #b #c #c #c')
    expect(r.map((e) => e.tag)).toEqual(['#c', '#b', '#a'])
  })

  it('supports CJK tag bodies', () => {
    const tag = String.fromCodePoint(0x77e5, 0x8bc6)
    const r = extractDocumentTags(`${String.fromCodePoint(0x7b14, 0x8bb0)} #${tag} ${String.fromCodePoint(0x6536, 0x96c6)}`)
    expect(r[0].tag).toBe(`#${tag}`)
  })

  it('does not pick up url fragments like example.com#frag', () => {
    expect(extractDocumentTags('see https://example.com#frag here')).toEqual([])
  })
})
