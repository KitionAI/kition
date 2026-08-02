import { afterEach, describe, expect, it } from 'vitest'

import { resolveBundledAssetURL } from './bundledAssets'

afterEach(() => {
  delete (window as typeof window & { kitionDesktop?: unknown }).kitionDesktop
})

describe('resolveBundledAssetURL', () => {
  it('uses public root paths in the browser', () => {
    expect(resolveBundledAssetURL('/onboarding/manifest.json'))
      .toBe('/onboarding/manifest.json')
    expect(resolveBundledAssetURL('kition-bundled:/templates/example.png'))
      .toBe('/templates/example.png')
  })

  it('uses the packaged asset protocol in Electron', () => {
    const desktopWindow = window as typeof window & { kitionDesktop?: unknown }
    desktopWindow.kitionDesktop = { shell: 'electron' }

    expect(resolveBundledAssetURL('/onboarding/manifest.json'))
      .toBe('kition-bundled://assets/onboarding/manifest.json')
    expect(resolveBundledAssetURL('kition-bundled:/templates/example.png'))
      .toBe('kition-bundled://assets/templates/example.png')
  })
})
