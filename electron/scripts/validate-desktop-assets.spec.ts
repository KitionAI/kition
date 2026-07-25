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
        mac: { icon: 'mac.icns', entitlements: 'entitlements.plist', entitlementsInherit: 'entitlements.plist' },
        win: { icon: 'win.png' },
        linux: { icon: 'linux.png' },
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
})
