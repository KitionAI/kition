import { describe, expect, it } from 'vitest'

import { parseFrontmatter } from './frontmatter-parser'
import { applyFrontmatter } from './frontmatter-serialize'

describe('parseFrontmatter', () => {
  it('preserves source offsets for CRLF frontmatter', () => {
    const source = '---\r\ntitle: Hello\r\n\r\n---\r\nbody'
    const result = parseFrontmatter(source)

    expect(result?.to).toBe(source.lastIndexOf('---') + 3)
  })

  it('returns null when no frontmatter', () => {
    expect(parseFrontmatter('# hello\n\nbody')).toBeNull()
  })

  it('returns null when fence is not closed', () => {
    expect(parseFrontmatter('---\nkey: v\n\nbody')).toBeNull()
  })

  it('parses simple scalar fields', () => {
    const result = parseFrontmatter('---\ntitle: Hello\ncount: 3\n---\nbody')
    expect(result).not.toBeNull()
    expect(result!.fields).toEqual([
      { key: 'title', value: 'Hello', startLine: 2, endLine: 2 },
      { key: 'count', value: '3', startLine: 3, endLine: 3 },
    ])
  })

  it('strips quotes from quoted strings', () => {
    const result = parseFrontmatter('---\ntitle: "Hello world"\nslug: \'abc\'\n---\nbody')
    expect(result!.fields[0].value).toBe('Hello world')
    expect(result!.fields[1].value).toBe('abc')
  })

  it('parses inline array', () => {
    const result = parseFrontmatter('---\ntags: [a, b, c]\n---\nbody')
    expect(result!.fields[0]).toMatchObject({ key: 'tags', value: ['a', 'b', 'c'] })
  })

  it('parses block list', () => {
    const result = parseFrontmatter('---\ntags:\n  - a\n  - b\n---\nbody')
    expect(result!.fields[0]).toMatchObject({ key: 'tags', value: ['a', 'b'] })
  })

  it('ignores comment lines inside frontmatter', () => {
    const result = parseFrontmatter('---\n# comment\nk: v\n---\nbody')
    expect(result!.fields).toEqual([{ key: 'k', value: 'v', startLine: 3, endLine: 3 }])
  })

  it('returns range covering the full block including fences', () => {
    const source = '---\nkey: v\n---\nbody'
    const result = parseFrontmatter(source)
    expect(result!.from).toBe(0)
    expect(source.slice(0, result!.to)).toBe('---\nkey: v\n---')
  })

  it('parses keys that start with a digit', () => {
    const result = parseFrontmatter('---\n2024: foo\n---\nbody')
    expect(result!.fields).toEqual([
      { key: '2024', value: 'foo', startLine: 2, endLine: 2 },
    ])
  })

  it('parses pure-numeric keys', () => {
    const result = parseFrontmatter('---\n123: ""\n---\nbody')
    expect(result!.fields).toEqual([
      { key: '123', value: '', startLine: 2, endLine: 2 },
    ])
  })

  it('parses CJK keys', () => {
    const localizedKey = String.fromCodePoint(0x6807, 0x7b7e)
    const result = parseFrontmatter(`---\n${localizedKey}: foo\n---\nbody`)
    expect(result!.fields).toEqual([
      { key: localizedKey, value: 'foo', startLine: 2, endLine: 2 },
    ])
  })

  it('parses keys with dots and other special chars', () => {
    const result = parseFrontmatter('---\nname.first: Ada\ntag@1: x\n---\nbody')
    expect(result!.fields).toEqual([
      { key: 'name.first', value: 'Ada', startLine: 2, endLine: 2 },
      { key: 'tag@1', value: 'x', startLine: 3, endLine: 3 },
    ])
  })

  it('round-trips a newly-created numeric key through applyFrontmatter (create-key flow)', () => {
                                                         
                                                                        
    const src = '---\ntitle: Hello\n---\nbody'
    const parsed = parseFrontmatter(src)!
    const next = applyFrontmatter(
      src,
      [
        { key: 'title', value: 'Hello' },
        { key: '2024', value: '' },
      ],
      parsed,
    )
    const reparsed = parseFrontmatter(next)
    expect(reparsed!.fields.map((f) => f.key)).toEqual(['title', '2024'])
  })
})
