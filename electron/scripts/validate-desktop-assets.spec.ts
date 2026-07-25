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
        mac: {
          artifactName: '${productName}-${version}-macos-${arch}.${ext}',
          icon: 'mac.icns',
          entitlements: 'entitlements.plist',
          entitlementsInherit: 'entitlements.plist',
        },
        win: {
          artifactName: '${productName}-${version}-windows-${arch}-setup.${ext}',
          icon: 'win.png',
        },
        linux: {
          artifactName: '${productName}-${version}-linux-${arch}.${ext}',
          icon: 'linux.png',
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
})
