import { describe, expect, it } from 'vitest'

import { findAudioLinks, findIframeSpans } from './media-deco'

describe('findIframeSpans', () => {
  it('finds a single-line iframe', () => {
    const src = 'before <iframe src="https://x.io/v"></iframe> after'
    const r = findIframeSpans(src)
    expect(r).toHaveLength(1)
    expect(r[0].src).toBe('https://x.io/v')
  })

  it('finds multi-line iframe blocks', () => {
    const src = '<iframe\n  src="https://x.io/v"\n  width="100">\n</iframe>'
    const r = findIframeSpans(src)
    expect(r).toHaveLength(1)
    expect(r[0].src).toBe('https://x.io/v')
  })

  it('skips iframes inside fenced code', () => {
    const src = '```html\n<iframe src="x"></iframe>\n```\n<iframe src="ok"></iframe>'
    const r = findIframeSpans(src)
    expect(r).toHaveLength(1)
    expect(r[0].src).toBe('ok')
  })

  it('returns empty when no iframe present', () => {
    expect(findIframeSpans('hello')).toEqual([])
  })

  it('tolerates iframes without src', () => {
    const r = findIframeSpans('<iframe></iframe>')
    expect(r).toHaveLength(1)
    expect(r[0].src).toBe('')
  })
})

describe('findAudioLinks', () => {
  it('finds a basic mp3 link', () => {
    const src = 'see [intro](sound.mp3) please'
    const r = findAudioLinks(src)
    expect(r).toHaveLength(1)
    expect(r[0].label).toBe('intro')
    expect(r[0].href).toBe('sound.mp3')
    expect(r[0].ext).toBe('mp3')
  })

  it('finds .wav .ogg .m4a .flac', () => {
    const src = '[a](a.wav)\n[b](b.ogg)\n[c](c.m4a)\n[d](d.flac)'
    expect(findAudioLinks(src).map((r) => r.ext)).toEqual(['wav', 'ogg', 'm4a', 'flac'])
  })

  it('ignores non-audio extensions', () => {
    expect(findAudioLinks('[x](x.png)\n[y](y.md)')).toEqual([])
  })

  it('skips inline code', () => {
    const src = 'inline `[skip](skip.mp3)` and [real](real.mp3)'
    const r = findAudioLinks(src)
    expect(r).toHaveLength(1)
    expect(r[0].href).toBe('real.mp3')
  })

  it('skips fenced code', () => {
    const src = '```md\n[no](no.mp3)\n```\n[yes](yes.mp3)'
    const r = findAudioLinks(src)
    expect(r).toHaveLength(1)
    expect(r[0].href).toBe('yes.mp3')
  })

  it('handles query string after extension', () => {
    const src = '[q](audio.mp3?token=abc)'
    const r = findAudioLinks(src)
    expect(r).toHaveLength(1)
    expect(r[0].ext).toBe('mp3')
  })
})
