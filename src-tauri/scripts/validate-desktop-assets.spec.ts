import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { validateDesktopAssets } from './validate-desktop-assets.mjs'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })))
})

async function createFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-desktop-assets-'))
  cleanupPaths.push(rootDir)
  await fs.mkdir(path.join(rootDir, 'src-tauri', 'icons'), { recursive: true })
  await fs.mkdir(path.join(rootDir, 'build'), { recursive: true })
  const files = ['src-tauri/icons/icon.icns', 'src-tauri/icons/icon.ico', 'src-tauri/icons/32x32.png', 'build/entitlements.plist']
  await Promise.all(files.map((file) => fs.writeFile(path.join(rootDir, file), file)))
  return {
    rootDir,
    config: {
      productName: 'Kition',
      identifier: 'com.kition.desktop',
      version: '../package.json',
      bundle: {
        icon: ['icons/32x32.png', 'icons/icon.icns', 'icons/icon.ico'],
        macOS: { entitlements: '../build/entitlements.plist' },
      },
      plugins: { 'deep-link': { desktop: { schemes: ['kition'] } } },
    },
  }
}

describe('validateDesktopAssets', () => {
  it('accepts a complete bundle configuration', async () => {
    const fixture = await createFixture()
    await expect(validateDesktopAssets(fixture)).resolves.toHaveLength(4)
  })

  it('reports missing configured files', async () => {
    const fixture = await createFixture()
    fixture.config.bundle.macOS.entitlements = '../build/missing.plist'
    await expect(validateDesktopAssets(fixture)).rejects.toThrow('macOS entitlements is missing')
  })

  it('requires the product identity', async () => {
    const fixture = await createFixture()
    fixture.config.identifier = 'com.example.app'
    await expect(validateDesktopAssets(fixture)).rejects.toThrow('identifier must be com.kition.desktop')
  })

  it('requires an icon for every platform', async () => {
    const fixture = await createFixture()
    fixture.config.bundle.icon = ['icons/32x32.png']
    await expect(validateDesktopAssets(fixture)).rejects.toThrow('bundle icons must include a .icns file')
  })

  it('requires the kition deep-link scheme', async () => {
    const fixture = await createFixture()
    fixture.config.plugins['deep-link'].desktop.schemes = []
    await expect(validateDesktopAssets(fixture)).rejects.toThrow('kition:// deep-link scheme')
  })
})
