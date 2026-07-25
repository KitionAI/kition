import { describe, expect, it } from 'vitest'

import { parseOutlineHeadings } from './DocumentOutlinePanel'

describe('parseOutlineHeadings', () => {
  it('returns empty for empty input', () => {
    expect(parseOutlineHeadings('')).toEqual([])
  })

  it('parses ATX headings preserving order and level', () => {
    const md = ['# A', '', '## B', '', '### C'].join('\n')
    expect(parseOutlineHeadings(md)).toEqual([
      { level: 1, text: 'A', line: 1, depth: 0 },
      { level: 2, text: 'B', line: 3, depth: 1 },
      { level: 3, text: 'C', line: 5, depth: 2 },
    ])
  })

  it('normalises depth relative to shallowest heading', () => {
    const md = ['## Top', '### Sub', '## Sibling'].join('\n')
    const result = parseOutlineHeadings(md)
    expect(result.map((h) => h.depth)).toEqual([0, 1, 0])
  })

  it('ignores headings inside fenced code blocks', () => {
    const md = [
      '# Real',
      '```',
      '# Inside code',
      '```',
      '## After',
    ].join('\n')
    const result = parseOutlineHeadings(md)
    expect(result.map((h) => h.text)).toEqual(['Real', 'After'])
  })

  it('handles trailing # marks', () => {
    expect(parseOutlineHeadings('## Trim me ##')).toEqual([
      { level: 2, text: 'Trim me', line: 1, depth: 0 },
    ])
  })

  it('skips lines that look like headings but lack a space', () => {
    expect(parseOutlineHeadings('#Nope')).toEqual([])
  })
})
