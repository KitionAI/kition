import { describe, expect, it } from 'vitest'

import {
  applyAsyncImageAttributes,
  linkifyWorkspacePathsInHtml,
  markdownToHtml,
  markdownToInteractiveHtml,
} from './markdownRenderer'

describe('markdownRenderer', () => {
  it('adds async image loading hints to markdown images', () => {
    const html = markdownToHtml('![Cover](images/example.png)')

    expect(html).toContain('src="images/example.png"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
    expect(html).toContain('fetchpriority="low"')
  })

  it('removes executable HTML from untrusted markdown', () => {
    const html = markdownToHtml([
      '<img src="missing.png" onerror="window.__kition_xss = true">',
      '<script>window.__kition_xss = true</script>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    ].join('\n'))

    expect(html).toContain('src="missing.png"')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('srcdoc')
  })

  it('removes unsafe link protocols while keeping workspace links', () => {
    const html = markdownToHtml([
      '<a href="javascript:alert(1)">Unsafe</a>',
      '<img src="kition-workspace://assets/cover.png" alt="Cover">',
    ].join('\n'))

    expect(html).not.toContain('javascript:')
    expect(html).toContain('kition-workspace://assets/cover.png')
  })

  it('does not override explicit image loading attributes', () => {
    const html = applyAsyncImageAttributes('<p><img src="hero.png" loading="eager" decoding="sync" fetchpriority="high"></p>')

    expect(html).toContain('loading="eager"')
    expect(html).toContain('decoding="sync"')
    expect(html).toContain('fetchpriority="high"')
    expect(html.match(/loading=/g)).toHaveLength(1)
  })

  it('linkifies workspace code paths for interactive agent messages', () => {
    const html = markdownToInteractiveHtml('Saved file: `Docs/Plan.md`')

    expect(html).toContain('data-open-path="Docs/Plan.md"')
    expect(html).toContain('class="agent-inline-path"')
  })

  it('does not linkify remote urls as workspace paths', () => {
    const html = linkifyWorkspacePathsInHtml('<p><code>https://example.com/Plan.md</code></p>')

    expect(html).not.toContain('data-open-path=')
    expect(html).toContain('https://example.com/Plan.md')
  })

  it('emits a mermaid placeholder for ```mermaid blocks', () => {
    const html = markdownToHtml('```mermaid\ngraph TD; A-->B\n```')

    expect(html).toContain('class="kition-mermaid"')
    expect(html).toContain('data-mermaid-source="')
    expect(html).toContain('language-mermaid')
  })

  it('leaves non-mermaid code blocks untouched', () => {
    const html = markdownToHtml('```ts\nconst x = 1\n```')

    expect(html).not.toContain('kition-mermaid')
    expect(html).toContain('language-ts')
  })

  it('renders inline math via KaTeX', () => {
    const html = markdownToHtml('Inline formula $x^2$ appears in a paragraph')

    expect(html).toContain('class="katex"')
    expect(html).not.toContain('$x^2$')
  })

  it('renders block math via KaTeX with display class', () => {
    const html = markdownToHtml('$$\n\\sum_{i=1}^{n} i\n$$')

    expect(html).toContain('kition-math-block')
    expect(html).toContain('katex-display')
  })

  it('leaves escaped dollars as literal text', () => {
    const html = markdownToHtml('Price is \\$5 and \\$10 today.')

    expect(html).not.toContain('class="katex"')
    expect(html).toContain('$5')
    expect(html).toContain('$10')
  })

  it('does not treat plain currency dollars as math', () => {
                                                  
    const html = markdownToHtml('I have $5 in my wallet and need $10 more.')

    expect(html).not.toContain('class="katex"')
    expect(html).toContain('$5')
    expect(html).toContain('$10')
  })

  it('renders math inside GFM table cells', () => {
    const markdown = [
      '| Variant | Scoring function |',
      '|------|----------|',
      '| ATIRE | $\\sum_{t \\in q} \\log(N/df_t)$ |',
    ].join('\n')
    const html = markdownToHtml(markdown)

    expect(html).toContain('<table')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('$\\sum')
  })
})
