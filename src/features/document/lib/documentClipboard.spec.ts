import { describe, expect, it } from 'vitest'
import { clipboardHtmlToMarkdown, inspectDocumentClipboard, resolveDocumentClipboard } from './documentClipboard'

function clipboard(payloads: Record<string, string>) {
  return { getData: (type: string) => payloads[type] || '' }
}

describe('document clipboard conversion', () => {
  it.each(['pre', 'div'])('preserves Markdown source carried in a styled %s wrapper', (tag) => {
    const source = '# Service design\n\n## Overview\n\n```mermaid\nflowchart TB\n    a[Client] --> b[Server]\n    b --> c[Disk]\n```\n\n| Layer | State |\n| --- | --- |\n| Store | Durable |\n'
    const wrapper = document.createElement(tag)
    wrapper.textContent = source
    expect(resolveDocumentClipboard(clipboard({ 'text/plain': source, 'text/html': wrapper.outerHTML })))
      .toEqual({ format: 'markdown', markdown: source })
  })

  it('preserves source newlines even when styled HTML uses breaks and nested spans', () => {
    const source = '# Overview\n\n```mermaid\nflowchart TB\n    a --> b\n```'
    const html = '<div><span># Overview</span><br><br><span>```mermaid</span><br>flowchart TB<br>    a --&gt; b<br>```</div>'
    expect(resolveDocumentClipboard(clipboard({ 'text/plain': source, 'text/html': html })).markdown).toBe(source)
  })

  it('does not let Markdown-looking fallback text override different rich HTML', () => {
    const result = resolveDocumentClipboard(clipboard({ 'text/plain': '# Title\n\n```code```', 'text/html': '<h1>Title</h1><p>Text</p>' }))
    expect(result).toEqual({ format: 'html', markdown: '# Title\n\nText' })
  })

  it('keeps a source-code block whose comments resemble Markdown headings', () => {
    const result = resolveDocumentClipboard(clipboard({
      'text/plain': '# A comment\nprint(1)',
      'text/html': '<pre><code class="language-python"># A comment\nprint(1)</code></pre>',
    }))
    expect(result.format).toBe('html')
    expect(result.markdown).toContain('```python\n# A comment\nprint(1)\n```')
  })
  it('preserves explicit accessibility headings, lists and tables from div-based editors', () => {
    const markdown = clipboardHtmlToMarkdown('<div role="heading" aria-level="2">Header</div><div role="list"><div role="listitem">First</div><div role="listitem">Second</div></div><div role="table"><div role="row"><div role="columnheader">Type</div></div><div role="row"><div role="cell">u16</div></div></div>')
    expect(markdown).toContain('## Header')
    expect(markdown).toMatch(/-\s+First/)
    expect(markdown).toMatch(/-\s+Second/)
    expect(markdown).toContain('| Type |\n| --- |\n| u16 |')
  })

  it('does not guess list semantics from numeric prose', () => {
    expect(clipboardHtmlToMarkdown('<p>12 u16</p><p>13 i16</p>')).toBe('12 u16\n\n13 i16')
  })

  it('preserves explicit Markdown instead of reinterpreting its HTML representation', () => {
    expect(resolveDocumentClipboard(clipboard({
      'text/markdown': '[[Notes]]\n\n- [x] Done',
      'text/html': '<p>Notes</p><p>Done</p>',
    }))).toEqual({ format: 'markdown', markdown: '[[Notes]]\n\n- [x] Done' })
  })

  it('converts headings, nested lists, links and emphasis from HTML', () => {
    const result = resolveDocumentClipboard(clipboard({
      'text/plain': 'Title\nBold\nItem\nChild',
      'text/html': '<h2>Title</h2><p><strong>Bold</strong> <a href="https://example.com">Link</a></p><ul><li>Item<ul><li>Child</li></ul></li></ul>',
    }))
    expect(result.format).toBe('html')
    expect(result.markdown).toContain('## Title')
    expect(result.markdown).toContain('**Bold** [Link](https://example.com)')
    expect(result.markdown).toMatch(/-\s+Item\n\s+-\s+Child/)
  })

  it('retains every spreadsheet row when the HTML table has no header', () => {
    expect(clipboardHtmlToMarkdown('<table><tr><td>A|B</td><td>10</td></tr><tr><td>C<br>D</td><td>20</td></tr></table>'))
      .toBe('|  |  |\n| --- | --- |\n| A\\|B | 10 |\n| C  <br>D | 20 |')
  })

  it('keeps merged cells as sanitized HTML instead of discarding their structure', () => {
    const result = clipboardHtmlToMarkdown('<table><tr><td colspan="2" onclick="alert(1)">Merged</td></tr></table>')
    expect(result).toContain('colspan="2"')
    expect(result).toContain('Merged')
    expect(result).not.toContain('onclick')
  })

  it('uses only the selected fragment and preserves code whitespace', () => {
    expect(clipboardHtmlToMarkdown('<p>Before</p><!--StartFragment--><pre><code>  a\n    b</code></pre><!--EndFragment--><p>After</p>'))
      .toBe('```\n  a\n    b\n```')
  })

  it('falls back to exact plain text for empty or unsafe HTML', () => {
    expect(resolveDocumentClipboard(clipboard({ 'text/html': '<script>alert(1)</script>', 'text/plain': '  *literal*\n\n' })))
      .toEqual({ format: 'text', markdown: '  *literal*\n\n' })
    expect(clipboardHtmlToMarkdown('<a href="javascript:alert(1)">Text</a>')).toBe('Text')
  })

  it('handles empty tables and preserves mixed text and images', () => {
    expect(clipboardHtmlToMarkdown('<table></table>')).toBe('')
    const result = clipboardHtmlToMarkdown('<p>Caption</p><img src="https://example.com/a.png" alt="Cover">')
    expect(result).toContain('Caption')
    expect(result).toContain('![Cover](https://example.com/a.png)')
  })

  it('captures custom MIME payloads verbatim and records file metadata without reading file bytes', () => {
    const payloads = { 'text/html': '<b>Hi</b>', 'application/x-example': '{"id":1}' }
    const result = inspectDocumentClipboard({
      ...clipboard(payloads), types: Object.keys(payloads), items: [{ kind: 'file', type: 'image/png' }],
      files: [new File(['abc'], 'sample.png', { type: 'image/png' })],
    } as unknown as DataTransfer)
    expect(result.payloads).toEqual(payloads)
    expect(result.files).toEqual([{ name: 'sample.png', type: 'image/png', size: 3 }])
    expect(result.documentConversion.markdown).toBe('**Hi**')
  })
})
