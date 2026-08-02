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
  const assetPaths = ['mac.icns', 'win.png', 'linux.png', 'entitlements.plist']
  await Promise.all(assetPaths.map((file) => fs.writeFile(path.join(rootDir, file), file)))
  return {
    rootDir,
    packagePayload: {
      build: {
        electronLanguages: undefined as string[] | undefined,
        mac: {
          artifactName: '${productName}-${version}-macos-${arch}.${ext}',
          icon: 'mac.icns',
          electronLanguages: ['zh_CN', 'en'],
          entitlements: 'entitlements.plist',
          entitlementsInherit: 'entitlements.plist',
        },
        win: {
          artifactName: '${productName}-${version}-windows-${arch}-setup.${ext}',
          icon: 'win.png',
          electronLanguages: ['zh-CN', 'en-US'],
        },
        linux: {
          artifactName: '${productName}-${version}-linux-${arch}.${ext}',
          icon: 'linux.png',
          electronLanguages: ['zh-CN', 'en-US'],
        },
      },
    },
  }
}

describe('validateDesktopAssets', () => {
  it('accepts complete cross-platform build inputs', async () => {
    const fixture = await createFixture()
    await expect(validateDesktopAssets(fixture)).resolves.toHaveLength(5)
  })

  it('reports missing configured assets', async () => {
    const fixture = await createFixture()
    fixture.packagePayload.build.win.icon = 'missing.ico'
    await expect(validateDesktopAssets(fixture)).rejects.toThrow('Windows icon is missing')
  })

  it('rejects ambiguous release artifact names', async () => {
    const fixture = await createFixture()
    fixture.packagePayload.build.mac.artifactName = '${productName}-${version}-${arch}.${ext}'

    await expect(validateDesktopAssets(fixture)).rejects.toThrow(
      'mac artifact name must be ${productName}-${version}-macos-${arch}.${ext}',
    )
  })

  it('rejects Windows locale names that use macOS separators', async () => {
    const fixture = await createFixture()
    fixture.packagePayload.build.win.electronLanguages = ['zh_CN', 'en_US']

    await expect(validateDesktopAssets(fixture)).rejects.toThrow(
      'win Electron locales must be zh-CN, en-US',
    )
  })

  it('requires platform-specific Electron locale configuration', async () => {
    const fixture = await createFixture()
    fixture.packagePayload.build.electronLanguages = ['zh-CN', 'en-US']

    await expect(validateDesktopAssets(fixture)).rejects.toThrow(
      'Electron locales must be configured per platform',
    )
  })
})
