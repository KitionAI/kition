import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const modulePath = fileURLToPath(import.meta.url)
const appDir = path.resolve(path.dirname(modulePath), '..', '..')
const expectedArtifactNames = {
  mac: '${productName}-${version}-macos-${arch}.${ext}',
  win: '${productName}-${version}-windows-${arch}-setup.${ext}',
  linux: '${productName}-${version}-linux-${arch}.${ext}',
}
const expectedElectronLanguages = {
  mac: ['zh_CN', 'en'],
  win: ['zh-CN', 'en-US'],
  linux: ['zh-CN', 'en-US'],
}

function collectConfiguredAssetPaths(packagePayload) {
  const build = packagePayload?.build || {}
  return [
    ['mac icon', build.mac?.icon],
    ['Windows icon', build.win?.icon],
    ['Linux icon', build.linux?.icon],
    ['mac entitlements', build.mac?.entitlements],
    ['mac inherited entitlements', build.mac?.entitlementsInherit],
  ]
}

export async function validateDesktopAssets({ rootDir = appDir, packagePayload } = {}) {
  const payload = packagePayload
    || JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'))
  const assets = collectConfiguredAssetPaths(payload)
  const missing = []
  if (payload?.build?.electronLanguages != null) {
    missing.push('Electron locales must be configured per platform')
  }
  for (const [platform, expectedName] of Object.entries(expectedArtifactNames)) {
    const configuredName = payload?.build?.[platform]?.artifactName
    if (configuredName !== expectedName) {
      missing.push(`${platform} artifact name must be ${expectedName}`)
    }
  }
  for (const [platform, expectedLanguages] of Object.entries(expectedElectronLanguages)) {
    const configuredLanguages = payload?.build?.[platform]?.electronLanguages
    if (JSON.stringify(configuredLanguages) !== JSON.stringify(expectedLanguages)) {
      missing.push(`${platform} Electron locales must be ${expectedLanguages.join(', ')}`)
    }
  }
  for (const [label, configuredPath] of assets) {
    if (!configuredPath) {
      missing.push(`${label} is not configured`)
      continue
    }
    try {
      const stat = await fs.stat(path.resolve(rootDir, configuredPath))
      if (!stat.isFile()) missing.push(`${label} is not a file: ${configuredPath}`)
    } catch {
      missing.push(`${label} is missing: ${configuredPath}`)
    }
  }
  if (missing.length) throw new Error(missing.join('; '))
  return assets.map(([label, configuredPath]) => ({ label, path: configuredPath }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const assets = await validateDesktopAssets()
    console.log(`[desktop-assets] verified ${assets.length} configured files`)
  } catch (error) {
    console.error(`[desktop-assets] ${error.message}`)
    process.exitCode = 1
  }
}
