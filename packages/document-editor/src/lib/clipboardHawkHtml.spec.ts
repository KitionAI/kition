import { describe, expect, it } from 'vitest'
import fixture from './fixtures/hawkClipboard.html?raw'
import { clipboardHtmlToMarkdown, parseClipboardHtml, resolveDocumentClipboard } from './documentClipboard'

describe('Hawk clipboard HTML', () => {
  it('keeps heading text on the heading line and restores nested bullets', () => {
    const markdown = clipboardHtmlToMarkdown(fixture)
    expect(markdown).toContain('# Background')
    expect(markdown).toContain('## Goals')
    expect(markdown).toContain('### Blocks')
    expect(markdown).toContain('## Operator')
    expect(markdown).not.toMatch(/^#{1,6}\s*$/m)
    expect(markdown).toMatch(/^\s{16}-\s+12 u16$/m)
    expect(markdown).toMatch(/^\s{16}-\s+13 i16$/m)
    expect(markdown).toMatch(/^\s{24}-\s+Payload$/m)
    expect(markdown).toMatch(/^\s{4}-\s+Data area$/m)
    const document = parseClipboardHtml(fixture)
    expect(document.querySelectorAll('ul ul ul ul ul ul ul li')).toHaveLength(1)
  })

  it('joins per-line ordered containers so numbering continues', () => {
    const markdown = clipboardHtmlToMarkdown(fixture)
    expect(markdown).toMatch(/1\.\s+Small storage\n2\.\s+Fast editing\n3\.\s+Streaming load/)
  })

  it('keeps code lines, language, blank lines, indentation, and inline marks', () => {
    const markdown = clipboardHtmlToMarkdown(fixture)
    expect(markdown).toContain('```typescript\ntype Path = number[];\n# [1,0]\ntype Point = {\n  path: Path,\n  offset: number\n}\n\ninsert_text(Point, text)\n```')
    expect(markdown).toContain('**No key data** ~~Old limit~~ `payload_len`')
    expect(markdown).toContain('> Clipboard format sample')
    expect(markdown).toContain('![Diagram](https://example.com/diagram.png!thumbnail)')
  })

  it('handles list restarts, mixed list types and skipped indentation without empty items', () => {
    const html = '<ol class="hk-ordered-list-node" data-hk-list-id="a" start="12"><p>A</p></ol><ol class="hk-ordered-list-node" data-hk-list-id="a"><p>B</p></ol><ul class="hk-bullet-list-node" data-hk-indent="2"><p>Child</p></ul><ol class="hk-ordered-list-node" data-hk-list-id="b" start="1"><p>C</p></ol>'
    const markdown = clipboardHtmlToMarkdown(html)
    expect(markdown).toMatch(/12\.\s+A\n13\.\s+B/)
    expect(markdown).toMatch(/\n\s+-\s+Child/)
    expect(markdown).toMatch(/\n1\.\s+C/)
    expect(markdown).not.toMatch(/^\s*-\s*$/m)
  })

  it('does not treat a metadata content-type as an image-only selection or emit delta metadata', () => {
    const result = resolveDocumentClipboard({ getData: (type) => type === 'text/html' ? fixture : type === 'text/plain' ? 'plain fallback' : '' })
    expect(result.format).toBe('html')
    expect(result.markdown).toContain('# Background')
    expect(result.markdown).not.toContain('data-docs-delta')
  })

  it('leaves standard HTML lists unchanged and normalizes idempotently', () => {
    expect(clipboardHtmlToMarkdown('<ul><li>One<ul><li>Two</li></ul></li></ul>')).toMatch(/-\s+One\n\s+-\s+Two/)
    const normalized = parseClipboardHtml(fixture).body.innerHTML
    expect(parseClipboardHtml(normalized).body.innerHTML).toBe(normalized)
  })

  it('keeps numbering counters independent at each nesting depth', () => {
    const html = '<ol class="hk-ordered-list-node" data-hk-list-id="a"><p>Parent</p></ol><ol class="hk-ordered-list-node" data-hk-list-id="a" data-hk-indent="1"><p>Child</p></ol><ol class="hk-ordered-list-node" data-hk-list-id="a"><p>Sibling</p></ol>'
    expect(clipboardHtmlToMarkdown(html)).toMatch(/1\.\s+Parent\n\s+1\.\s+Child\n2\.\s+Sibling/)
  })
})
