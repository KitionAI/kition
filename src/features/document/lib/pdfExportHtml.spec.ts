import { describe, expect, it } from 'vitest'
import { buildPdfExportHtml } from './pdfExportHtml'

describe('buildPdfExportHtml', () => {
  const baseOpts = {
    title: 'My Doc',
    bodyHtml: '<p>Hello</p>',
    includeName: false,
    pageFormat: 'a4' as const,
    landscape: false,
  }

  it('wraps body in print container with markdown-preview-view class', () => {
    const html = buildPdfExportHtml(baseOpts)
    expect(html).toContain('<body class="print">')
    expect(html).toContain('class="markdown-preview-view markdown-rendered kition-export"')
    expect(html).toContain('<p>Hello</p>')
  })

  it('emits @page rule with size and orientation', () => {
    expect(buildPdfExportHtml({ ...baseOpts, pageFormat: 'letter' })).toContain('size: Letter')
    expect(buildPdfExportHtml({ ...baseOpts, landscape: true })).toContain('size: A4 landscape')
  })

  it('emits zero CSS margin (electron drives margins)', () => {
    expect(buildPdfExportHtml(baseOpts)).toContain('margin: 0')
  })

  it('prepends title heading when includeName=true', () => {
    const html = buildPdfExportHtml({ ...baseOpts, includeName: true, title: 'A <b>title' })
    expect(html).toMatch(/<h1[^>]*>A &lt;b&gt;title<\/h1>\s*<p>Hello<\/p>/)
  })

  it('escapes title in <title> tag', () => {
    const html = buildPdfExportHtml({ ...baseOpts, title: 'A & B' })
    expect(html).toContain('<title>A &amp; B</title>')
  })

  it('does NOT apply CSS zoom (scaling is done by printToPDF)', () => {
    const html = buildPdfExportHtml({ ...baseOpts })
    expect(html).not.toMatch(/zoom\s*:/)
    expect(html).not.toMatch(/transform\s*:\s*scale/)
  })
})
