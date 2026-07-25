import { describe, expect, it } from 'vitest'

import { lintMarkdown } from './DocumentMarkdownLintDialog'

describe('lintMarkdown', () => {
  it('flags MD001 when multiple H1 exist', () => {
    const issues = lintMarkdown('# A\n\nbody\n\n# B\n')
    expect(issues.some((i) => i.rule === 'MD001')).toBe(true)
  })

  it('does NOT flag MD001 with a single H1', () => {
    const issues = lintMarkdown('# Only\n\nbody\n')
    expect(issues.some((i) => i.rule === 'MD001')).toBe(false)
  })

  it('flags MD009 on trailing whitespace', () => {
    const issues = lintMarkdown('hello   \nworld')
    expect(issues.some((i) => i.rule === 'MD009' && i.lineNo === 1)).toBe(true)
  })

  it('flags MD012 on 3+ blank lines', () => {
    const issues = lintMarkdown('a\n\n\n\nb')
    expect(issues.some((i) => i.rule === 'MD012')).toBe(true)
  })

  it('flags MD018 when # has no space', () => {
    const issues = lintMarkdown('#title')
    expect(issues.some((i) => i.rule === 'MD018')).toBe(true)
  })

  it('flags MD019 when # has multiple spaces', () => {
    const issues = lintMarkdown('#   title')
    expect(issues.some((i) => i.rule === 'MD019')).toBe(true)
  })

  it('flags MD022 when heading is not preceded by blank line', () => {
    const issues = lintMarkdown('intro line\n## H2')
    expect(issues.some((i) => i.rule === 'MD022' && i.lineNo === 2)).toBe(true)
  })

  it('flags MD026 when heading ends in punctuation', () => {
    const issues = lintMarkdown(`## ${String.fromCodePoint(0x6807, 0x9898, 0x3002)}\n`)
    expect(issues.some((i) => i.rule === 'MD026')).toBe(true)
  })

  it('flags MD029 when ordered list has gap', () => {
    const issues = lintMarkdown('1. a\n5. b\n6. c')
    expect(issues.some((i) => i.rule === 'MD029')).toBe(true)
  })

  it('flags MD034 when bare URL appears in text', () => {
    const issues = lintMarkdown('see https://example.com today')
    expect(issues.some((i) => i.rule === 'MD034')).toBe(true)
  })

  it('does NOT flag MD034 when URL is inside a markdown link', () => {
    const issues = lintMarkdown('see [docs](https://example.com) today')
    expect(issues.some((i) => i.rule === 'MD034')).toBe(false)
  })

  it('flags MD036 when an entire line is bold', () => {
    const issues = lintMarkdown('**Pseudo Heading**')
    expect(issues.some((i) => i.rule === 'MD036')).toBe(true)
  })

  it('flags MD040 when code fence has no language', () => {
    const issues = lintMarkdown('```\nsome code\n```\n')
    expect(issues.some((i) => i.rule === 'MD040')).toBe(true)
  })

  it('does NOT flag MD040 when code fence has language', () => {
    const issues = lintMarkdown('```ts\nlet x = 1\n```\n')
    expect(issues.some((i) => i.rule === 'MD040')).toBe(false)
  })

  it('flags MD042 on empty wikilink', () => {
    const issues = lintMarkdown('see [[]] here')
    expect(issues.some((i) => i.rule === 'MD042')).toBe(true)
  })

  it('flags MD042 on empty markdown link', () => {
    const issues = lintMarkdown('see [text]() here')
    expect(issues.some((i) => i.rule === 'MD042')).toBe(true)
  })

  it('flags MD051 when anchor target is missing', () => {
    const issues = lintMarkdown('# Real\n\n[jump](#ghost)')
    expect(issues.some((i) => i.rule === 'MD051')).toBe(true)
  })

  it('does NOT flag MD051 when anchor target exists', () => {
    const issues = lintMarkdown('# Real Heading\n\n[jump](#real-heading)')
    expect(issues.some((i) => i.rule === 'MD051')).toBe(false)
  })

  it('skips fenced code content for headings/URL/bold rules', () => {
    const src = '# title\n\n```\n# fake heading\nhttps://bare.example.com\n**all bold**\n```\n'
    const issues = lintMarkdown(src)
    expect(issues.some((i) => i.rule === 'MD001')).toBe(false)
    expect(issues.some((i) => i.rule === 'MD034')).toBe(false)
    expect(issues.some((i) => i.rule === 'MD036')).toBe(false)
  })

  it('returns warn issues before info issues', () => {
    const issues = lintMarkdown('# A\n# B\n\nintro   ')
    const indices = issues.map((i) => i.severity)
    // first occurrence of 'info' should not precede last 'warn'
    const lastWarn = indices.lastIndexOf('warn')
    const firstInfo = indices.indexOf('info')
    if (firstInfo !== -1 && lastWarn !== -1) {
      expect(firstInfo).toBeGreaterThan(lastWarn)
    }
  })
})
