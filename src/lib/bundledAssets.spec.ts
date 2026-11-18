import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  readBundledAssetBytes,
  readBundledAssetText,
  resolveBundledAssetURL,
} from './bundledAssets'

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as typeof window & { kitionDesktop?: unknown }).kitionDesktop
})

describe('resolveBundledAssetURL', () => {
  it('uses public root paths in the browser and the desktop app', () => {
    expect(resolveBundledAssetURL('/onboarding/manifest.json'))
      .toBe('/onboarding/manifest.json')
    expect(resolveBundledAssetURL('kition-bundled:/templates/example.png'))
      .toBe('/templates/example.png')

    const desktopWindow = window as typeof window & { kitionDesktop?: unknown }
    desktopWindow.kitionDesktop = { shell: 'tauri' }
    expect(resolveBundledAssetURL('kition-bundled://assets/templates/example.png'))
      .toBe('/templates/example.png')
    expect(resolveBundledAssetURL('')).toBe('')
  })

  it('reads bundled bytes from the renderer origin', async () => {
    const fetchMock = vi.fn(async () => new Response('Kition'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(readBundledAssetText('kition-bundled:/onboarding/welcome.md')).resolves.toBe('Kition')
    await expect(readBundledAssetBytes('onboarding/welcome.md'))
      .resolves.toEqual(new Uint8Array([75, 105, 116, 105, 111, 110]))
    expect(fetchMock).toHaveBeenCalledWith('/onboarding/welcome.md', { signal: undefined })
  })

  it('reports missing assets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))

    await expect(readBundledAssetBytes('missing.json')).rejects.toThrow('fetch /missing.json failed (404)')
  })
})
