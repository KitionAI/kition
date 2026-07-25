import { describe, expect, it } from 'vitest'

import { extractOutlineHeadings } from './DocumentHeadingOutlineDialog'

describe('extractOutlineHeadings', () => {
  it('returns empty for plain text', () => {
    expect(extractOutlineHeadings('hello\nworld')).toEqual([])
  })

  it('extracts ATX headings with levels and line numbers', () => {
    const src = '# Top\n\n## A\n### A1\n## B'
    const r = extractOutlineHeadings(src)
    expect(r).toEqual([
      { level: 1, text: 'Top', line: 1 },
      { level: 2, text: 'A', line: 3 },
      { level: 3, text: 'A1', line: 4 },
      { level: 2, text: 'B', line: 5 },
    ])
  })

  it('trims trailing # marks', () => {
    expect(extractOutlineHeadings('## title ##')).toEqual([{ level: 2, text: 'title', line: 1 }])
  })

  it('skips fake headings inside fenced code', () => {
    const src = '```\n# fake\n```\n# real'
    const r = extractOutlineHeadings(src)
    expect(r).toEqual([{ level: 1, text: 'real', line: 4 }])
  })

  it('does not match setext-style headings', () => {
    expect(extractOutlineHeadings('Title\n=====')).toEqual([])
  })
})
