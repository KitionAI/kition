import { describe, expect, it } from 'vitest'

import { findMarkdownHeadingOffset } from './markdownHeadingNavigation'

const CJK_HEADING = String.fromCodePoint(0x6587, 0x6863, 0x7528, 0x9014)

describe('findMarkdownHeadingOffset', () => {
  it('matches numbered Unicode headings with or without a space after the number', () => {
    for (const separator of ['. ', '.']) {
      const source = `Introduction\n\n## 1${separator}${CJK_HEADING}\n\nBody`
      expect(findMarkdownHeadingOffset(source, `#1-${CJK_HEADING}`)).toBe(source.indexOf('##'))
    }
  })

  it('matches formatted headings by visible text and slug', () => {
    const source = 'Intro\n\n## **Getting** [started](https://kition.ai) with `code`! ###\n'
    expect(findMarkdownHeadingOffset(source, '#getting-started-with-code')).toBe(7)
    expect(findMarkdownHeadingOffset(source, '#Getting started with code!')).toBe(7)
  })

  it('skips code and disambiguates duplicate headings and explicit suffixes', () => {
    const source = '```md\n# Overview\n```\n\n# Overview\n\n# Overview\n\n# Overview-1\n'
    expect(findMarkdownHeadingOffset(source, '#overview')).toBe(source.indexOf('# Overview', 20))
    expect(findMarkdownHeadingOffset(source, '#overview-1')).toBe(source.indexOf('# Overview', 32))
    expect(findMarkdownHeadingOffset(source, '#overview-1-1')).toBe(source.lastIndexOf('# Overview'))
  })

  it('supports setext headings and returns null for missing targets', () => {
    const source = 'Intro\n\nDetails\n-------\nBody'
    expect(findMarkdownHeadingOffset(source, '#details')).toBe(7)
    expect(findMarkdownHeadingOffset(source, '#missing')).toBeNull()
  })
})
