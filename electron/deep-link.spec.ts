import { describe, expect, it } from 'vitest'

import { findKitionDeepLink, normalizeKitionDeepLink } from './deep-link.mjs'

describe('normalizeKitionDeepLink', () => {
  it('accepts Kition app links', () => {
    expect(normalizeKitionDeepLink('kition://auth/complete')).toBe('kition://auth/complete')
    expect(normalizeKitionDeepLink('kition://doc/123?tab=notes')).toBe('kition://doc/123?tab=notes')
  })

  it('rejects browser, file, and malformed links', () => {
    for (const value of ['https://kition.ai', 'file:///tmp/private', 'javascript:alert(1)', 'not a url']) {
      expect(normalizeKitionDeepLink(value)).toBe('')
    }
  })
})

describe('findKitionDeepLink', () => {
  it('finds a protocol URL in a desktop process argument list', () => {
    expect(findKitionDeepLink(['/Applications/Kition.app/Contents/MacOS/Kition', '--flag', 'kition://auth/complete']))
      .toBe('kition://auth/complete')
  })
})
