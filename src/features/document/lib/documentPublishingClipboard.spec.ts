import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildDocumentPublishingClipboardContent,
  buildDocumentPublishingClipboardHtml,
  inlineBrowserClipboardImages,
} from './documentPublishingClipboard'

describe('document publishing clipboard', () => {
  const desktopWindow = window as typeof window & { kitionDesktop?: unknown }

  beforeEach(() => {
    desktopWindow.kitionDesktop = { shell: 'electron' }
  })

  afterEach(() => {
    desktopWindow.kitionDesktop = undefined
    vi.unstubAllGlobals()
  })

  it('renders generated images as workspace URLs before desktop clipboard inlining', async () => {
    const content = await buildDocumentPublishingClipboardContent(
      '# Article\n\n![Generated](<Agent/images/9/ig_generated.png>)',
      'Articles/AI/Attention residue.md',
    )

    expect(content.html).toContain('<article ')
    expect(content.html).toContain(
      'src="http://127.0.0.1:18101/workspace-files/Agent/images/9/ig_generated.png"',
    )
    expect(content.html).not.toContain('loading="lazy"')
    expect(content.text).toContain('# Article')
  })

  it('renders the generated image syntax used by publishing documents', async () => {
    const content = await buildDocumentPublishingClipboardContent(
      '![Multiple AI tasks](<Agent/images/9/ig_060927396e858759016a7170c6aa64819ab827a467941ef6c7.png>)',
      'Publishing/AI/article.md',
    )

    expect(content.html).toContain('<img')
    expect(content.html).toContain('Agent/images/9/ig_060927396e858759016a7170c6aa64819ab827a467941ef6c7.png')
    expect(content.html).not.toContain('![Multiple AI tasks]')
  })

  it('renders selected Markdown as portable semantic HTML with paragraph breaks', () => {
    const html = buildDocumentPublishingClipboardHtml([
      '# Heading',
      '',
      'First line',
      'Second line with **bold text**.',
      '',
      '- First item',
      '- Second item',
      '',
      '---',
    ].join('\n'), 'Publishing/AI/article.md')

    expect(html).toContain('<article style="line-height: 1.7;">')
    expect(html).toContain('<h1 style="margin: 0 0 0.7em; font-size: 2em; line-height: 1.25; font-weight: 700;">Heading</h1>')
    expect(html).toContain('<p style="margin: 0 0 1em;">First line<br>Second line with <strong>bold text</strong>.</p>')
    expect(html).toContain('<ul style="margin: 0 0 1em; padding-left: 1.6em;">')
    expect(html).toContain('<li style="margin: 0.25em 0;">First item</li>')
    expect(html).toContain('<hr style="margin: 1.5em 0; border: 0; border-top: 1px solid #e5e3df;">')
  })

  it('converts browser clipboard images to data URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    }))

    const html = await inlineBrowserClipboardImages(
      '<article><img src="/workspace-files/Agent/images/example.png" alt="Example"></article>',
    )

    expect(html).toContain('src="data:image/png;base64,AQID"')
    expect(html).not.toContain('/workspace-files/Agent/images/example.png')
  })
})
