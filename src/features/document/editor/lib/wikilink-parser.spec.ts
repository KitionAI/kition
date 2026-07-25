import { describe, expect, it } from 'vitest'

import { parseWikilinkInner, parseWikilinks } from './wikilink-parser'

describe('parseWikilinkInner', () => {
  it('extracts target only', () => {
    expect(parseWikilinkInner('Page')).toEqual({
      target: 'Page',
      heading: undefined,
      blockId: undefined,
      display: undefined,
    })
  })

  it('supports display alias via |', () => {
    expect(parseWikilinkInner('Page|Shown')).toEqual({
      target: 'Page',
      heading: undefined,
      blockId: undefined,
      display: 'Shown',
    })
  })

  it('extracts heading after #', () => {
    expect(parseWikilinkInner('Page#Section')).toEqual({
      target: 'Page',
      heading: 'Section',
      blockId: undefined,
      display: undefined,
    })
  })

  it('extracts block id after #^', () => {
    expect(parseWikilinkInner('Page#^abc-123')).toEqual({
      target: 'Page',
      heading: undefined,
      blockId: 'abc-123',
      display: undefined,
    })
  })

  it('combines heading + display', () => {
    expect(parseWikilinkInner('Page#Section|Custom Label')).toEqual({
      target: 'Page',
      heading: 'Section',
      blockId: undefined,
      display: 'Custom Label',
    })
  })

  it('trims whitespace around segments', () => {
    expect(parseWikilinkInner('  Page  #  Section  |  Label  ')).toEqual({
      target: 'Page',
      heading: 'Section',
      blockId: undefined,
      display: 'Label',
    })
  })

  it('handles nested folder targets', () => {
    expect(parseWikilinkInner('folder/sub/Page')).toEqual({
      target: 'folder/sub/Page',
      heading: undefined,
      blockId: undefined,
      display: undefined,
    })
  })
})

describe('parseWikilinks', () => {
  it('finds a basic wikilink', () => {
    const results = parseWikilinks('see [[Page]] now')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      raw: '[[Page]]',
      embed: false,
      target: 'Page',
      from: 4,
      to: 12,
    })
  })

  it('detects embed prefix !', () => {
    const results = parseWikilinks('![[Image.png]]')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      embed: true,
      target: 'Image.png',
      from: 0,
      to: 14,
    })
  })

  it('finds multiple links on one line', () => {
    const results = parseWikilinks('[[A]] and [[B|alias]] and ![[c.png]]')
    expect(results).toHaveLength(3)
    expect(results.map((r) => r.target)).toEqual(['A', 'B', 'c.png'])
    expect(results.map((r) => r.embed)).toEqual([false, false, true])
    expect(results[1].display).toBe('alias')
  })

  it('records absolute offsets across newlines', () => {
    const source = 'line one\nline two [[Target]]'
    const results = parseWikilinks(source)
    expect(results).toHaveLength(1)
    const link = results[0]
    expect(source.slice(link.from, link.to)).toBe('[[Target]]')
  })

  it('does not cross newlines inside a link', () => {
    expect(parseWikilinks('[[unclosed\nNext]]')).toEqual([])
  })

  it('captures heading and blockId in full parse', () => {
    const results = parseWikilinks('[[Page#Section]] [[Page#^bid]]')
    expect(results[0].heading).toBe('Section')
    expect(results[0].blockId).toBeUndefined()
    expect(results[1].blockId).toBe('bid')
    expect(results[1].heading).toBeUndefined()
  })

  it('ignores empty input', () => {
    expect(parseWikilinks('')).toEqual([])
    expect(parseWikilinks('no links here')).toEqual([])
  })
})
