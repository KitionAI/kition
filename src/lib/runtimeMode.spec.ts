import { afterEach, describe, expect, it } from 'vitest'

import { isWebPreviewMode } from './runtimeMode'

afterEach(() => {
  delete (globalThis as typeof globalThis & { __APP_WEB_PREVIEW__?: boolean }).__APP_WEB_PREVIEW__
})

describe('isWebPreviewMode', () => {
  it('defaults to false outside a Vite preview build', () => {
    expect(isWebPreviewMode()).toBe(false)
  })

  it('reads the Vite preview build flag when provided', () => {
    (globalThis as typeof globalThis & { __APP_WEB_PREVIEW__?: boolean }).__APP_WEB_PREVIEW__ = true
    expect(isWebPreviewMode()).toBe(true)
  })
})
