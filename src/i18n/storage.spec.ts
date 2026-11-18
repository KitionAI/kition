import { afterEach, describe, expect, it, vi } from 'vitest'

import { detectBrowserLocale } from './storage'
import { SUPPORTED_LOCALES } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('locale support', () => {
  it('includes Simplified Chinese in the supported locale list', () => {
    expect(SUPPORTED_LOCALES).toContain('zh-CN')
  })

  it('detects Simplified Chinese browser locales', () => {
    vi.stubGlobal('navigator', {
      language: 'zh-CN',
      languages: ['zh-CN', 'en-US'],
    })

    expect(detectBrowserLocale()).toBe('zh-CN')
  })
})
