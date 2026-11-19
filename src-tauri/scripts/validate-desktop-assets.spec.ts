import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { macAppIconProblems, validateDesktopAssets } from './validate-desktop-assets.mjs'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })))
})

async function createFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-desktop-assets-'))
  cleanupPaths.push(rootDir)
  await fs.mkdir(path.join(rootDir, 'src-tauri', 'icons'), { recursive: true })
  const files = ['src-tauri/icons/icon.icns', 'src-tauri/icons/icon.ico', 'src-tauri/icons/32x32.png', 'src-tauri/entitlements.plist']
  await Promise.all(files.map((file) => fs.writeFile(path.join(rootDir, file), file)))
  await fs.mkdir(path.join(rootDir, 'src-tauri', 'icons', 'icon.icon', 'Assets'), { recursive: true })
  await fs.writeFile(
    path.join(rootDir, 'src-tauri', 'icons', 'icon.icon', 'icon.json'),
    JSON.stringify({ groups: [{ layers: [{ 'image-name': 'mark.svg', name: 'mark' }] }] }),
  )
  await fs.writeFile(path.join(rootDir, 'src-tauri', 'icons', 'icon.icon', 'Assets', 'mark.svg'), '<svg/>')
  return {
    rootDir,
    config: {
      productName: 'Kition',
      identifier: 'com.kition.desktop',
      version: '../package.json',
      bundle: {
        icon: ['icons/32x32.png', 'icons/icon.icns', 'icons/icon.icon', 'icons/icon.ico'],
        macOS: { entitlements: 'entitlements.plist' },
      },
      plugins: { 'deep-link': { desktop: { schemes: ['kition'] } } },
    },
  }
}

describe('validateDesktopAssets', () => {
  it('accepts a complete bundle configuration', async () => {
    const fixture = await createFixture()
    await expect(validateDesktopAssets(fixture)).resolves.toHaveLength(5)
  })

  it('reports missing configured files', async () => {
    const fixture = await createFixture()
    fixture.config.bundle.macOS.entitlements = 'missing.plist'
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

  it('requires the Icon Composer icon that macOS 26 and later draw', async () => {
    const fixture = await createFixture()
    fixture.config.bundle.icon = fixture.config.bundle.icon.filter((icon) => !icon.endsWith('.icon'))
    await expect(validateDesktopAssets(fixture)).rejects.toThrow('bundle icons must include an Icon Composer .icon package')
  })

  it('reports an Icon Composer layer whose image is missing', async () => {
    const fixture = await createFixture()
    await fs.rm(path.join(fixture.rootDir, 'src-tauri', 'icons', 'icon.icon', 'Assets', 'mark.svg'))
    await expect(validateDesktopAssets(fixture)).rejects.toThrow('icons/icon.icon has no layer image Assets/mark.svg')
  })

  it('requires the kition deep-link scheme', async () => {
    const fixture = await createFixture()
    fixture.config.plugins['deep-link'].desktop.schemes = []
    await expect(validateDesktopAssets(fixture)).rejects.toThrow('kition:// deep-link scheme')
  })
})

describe('macAppIconProblems', () => {
  async function createApp({ assetsCar = true, iconName = true } = {}) {
    const app = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-mac-app-'))
    cleanupPaths.push(app)
    await fs.mkdir(path.join(app, 'Contents', 'Resources'), { recursive: true })
    if (assetsCar) await fs.writeFile(path.join(app, 'Contents', 'Resources', 'Assets.car'), 'car')
    const name = iconName ? '<key>CFBundleIconName</key>\n<string>Icon</string>' : ''
    await fs.writeFile(
      path.join(app, 'Contents', 'Info.plist'),
      `<plist version="1.0"><dict><key>CFBundleIconFile</key><string>icon.icns</string>${name}</dict></plist>`,
    )
    return app
  }

  it('accepts an app that carries the compiled Icon Composer icon', async () => {
    await expect(macAppIconProblems(await createApp())).resolves.toEqual([])
  })

  it('reports an app built without Assets.car, which macOS 26 and later draw with a second edge', async () => {
    const problems = await macAppIconProblems(await createApp({ assetsCar: false, iconName: false }))
    expect(problems).toEqual([
      'Contents/Resources/Assets.car is missing: the bundler needs Xcode 26 or later (actool) to compile icons/icon.icon',
      'Info.plist has no CFBundleIconName',
    ])
  })
})
