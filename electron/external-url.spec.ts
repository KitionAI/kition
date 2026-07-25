import { describe, expect, it } from 'vitest'

import { isTrustedWindowNavigation, normalizeExternalURL } from './external-url.mjs'

describe('normalizeExternalURL', () => {
  it('allows browser and email links', () => {
    expect(normalizeExternalURL('https://kition.ai/docs')).toBe('https://kition.ai/docs')
    expect(normalizeExternalURL('mailto:support@kition.ai')).toBe('mailto:support@kition.ai')
  })

  it('rejects local files, scripts, and custom protocols', () => {
    for (const value of ['file:///tmp/secret', 'javascript:alert(1)', 'kition://settings']) {
      expect(() => normalizeExternalURL(value)).toThrow('url protocol is not allowed')
    }
  })
})

describe('isTrustedWindowNavigation', () => {
  it('keeps development navigation on the renderer origin', () => {
    expect(isTrustedWindowNavigation(
      'http://127.0.0.1:3000/document?id=1',
      'http://127.0.0.1:3000/',
    )).toBe(true)
    expect(isTrustedWindowNavigation('https://example.com', 'http://127.0.0.1:3000/')).toBe(false)
  })

  it('only allows the packaged renderer file itself', () => {
    const initial = 'file:///Applications/Kition.app/Contents/Resources/app.asar/dist/index.html'
    expect(isTrustedWindowNavigation(`${initial}#/document`, initial)).toBe(true)
    expect(isTrustedWindowNavigation('file:///tmp/index.html', initial)).toBe(false)
  })
})
